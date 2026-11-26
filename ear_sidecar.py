"""耳朵边车：麦克风 -> 静音切句 -> SenseVoice/whisper -> 一行一个 JSON 到 stdout。

只做一件事，不做对话，不碰网络。WhaleLife 那边拉起来读 stdout。
规矩照旧：默认闭嘴，要 --start 才开；父进程一走，自己收声退出。

用法：
    python ear_sidecar.py --list            列输入设备
    python ear_sidecar.py --selftest        加载引擎、量一次底噪，然后退出
    python ear_sidecar.py --start           正式监听，每句输出一行 JSON
    python ear_sidecar.py --recognize a.wav 只识别这一个文件，出结果就退出

stdout 只有 JSON 行（或 --list/--selftest 的文本），日志全走 stderr。
"""
from __future__ import annotations

import argparse
import gc
import json
import queue
import re
import os
import sys
import threading
import time
import traceback

SR = 16000
DEV_SR = 44100          # 采集用设备原生采样率；16000 下去 MME 常给一片零
BLOCK = 0.1

SENSE_DIR = os.environ.get("WHALELIFE_SENSE_DIR", "")

# whisper 对噪声有瘾，静音时爱吐这些
HALLUCINATIONS = (
    "请不吝点赞", "订阅", "转发", "打赏", "明镜与点点", "感谢观看", "谢谢观看",
    "字幕由", "字幕志愿者", "字幕組", "字幕组", "关注我", "小铃铛", "amara.org",
    "点赞", "下一集", "未完待续", "（空）",
    "請不吝點贊", "點贊", "訂閱", "轉發", "打賞", "明鏡與點點", "感謝觀看",
    "謝謝觀看", "關注我", "小鈴鐺",
)


def log(msg: str, *a) -> None:
    print(("[ear] " + msg) % a if a else "[ear] " + msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def is_hallucination(text: str) -> bool:
    t = (text or "").strip()
    if len(t) <= 1:
        return True
    if any(h in t for h in HALLUCINATIONS):
        return True
    if re.search(r"(.)\1{3,}", t):
        return True
    if len(t) >= 6 and len(set(t)) / len(t) < 0.3:
        return True
    return False


def read_wav(path: str):
    """读一个 wav 成 16k 单声道 float32。只支持 16bit PCM，别的直接报错。"""
    import wave
    import numpy as np
    with wave.open(path, "rb") as w:
        sw = w.getsampwidth()
        ch = w.getnchannels()
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError("只支持 16bit PCM 的 wav，这个文件是 %d bit" % (sw * 8))
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch)[:, 0]
    if sr != SR:
        n = max(1, int(len(x) * SR / sr))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


def list_devices() -> None:
    import sounddevice as sd
    for i, d in enumerate(sd.query_devices()):
        if d.get("max_input_channels", 0) > 0:
            emit({"device": i, "name": d.get("name"), "api": d.get("hostapi"),
                  "channels": d.get("max_input_channels"), "sr": d.get("default_samplerate")})


class Ear:
    def __init__(self, args) -> None:
        self.args = args
        self.stop = threading.Event()
        self.model = None
        self.engine = ""
        self.turns = 0
        self.threshold = 0.012

    # ---------- 采集 ----------
    def _device(self):
        d = int(self.args.device or 0)
        return d if d > 0 else None

    def grab(self, seconds: float):
        import numpy as np
        import sounddevice as sd
        frames = max(1, int(DEV_SR * seconds))
        data = sd.rec(frames, samplerate=DEV_SR, channels=1, dtype="float32", device=self._device())
        sd.wait()
        x = data.ravel()
        if DEV_SR != SR:
            n = max(1, int(len(x) * SR / DEV_SR))
            x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
        return x

    # ---------- 引擎 ----------
    def load_engine(self):
        eng = (self.args.engine or "sensevoice").lower()
        if eng == "whisper":
            from faster_whisper import WhisperModel
            self.engine = "whisper"
            return WhisperModel(self.args.model or "base", device="cpu", compute_type="int8")
        from funasr import AutoModel
        self.engine = "sensevoice"
        return AutoModel(model=self.args.sensevoice_dir or SENSE_DIR,
                         trust_remote_code=True, disable_update=True, device="cpu")

    def transcribe(self, audio):
        if self.engine == "whisper":
            segments, _ = self.model.transcribe(
                audio, language=self.args.language, beam_size=1,
                initial_prompt=self.args.initial_prompt or None)
            return "".join(s.text for s in segments).strip()
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        res = self.model.generate(input=audio, language=self.args.language, use_itn=True)
        return rich_transcription_postprocess(res[0]["text"]).strip()

    def measure_noise(self) -> None:
        import numpy as np
        samples = []
        for _ in range(6):
            samples.append(float(np.sqrt(np.mean(self.grab(0.1) ** 2))))
        median = float(np.median(samples))
        self.threshold = min(0.05, max(0.008, median * 3.0))
        log("底噪中位 %.5f，阈值 %.5f", median, self.threshold)

    # ---------- 主循环 ----------
    def loop(self) -> None:
        self.measure_noise()
        self.model = self.load_engine()
        log("引擎 %s 就绪，听着呢", self.engine)
        emit({"event": "ready", "engine": self.engine, "threshold": self.threshold})

        import numpy as np
        silence = float(self.args.silence)
        max_len = float(self.args.max_len)

        while not self.stop.is_set():
            try:
                chunks = []
                quiet = 0.0
                started = False
                while not self.stop.is_set():
                    block = self.grab(BLOCK)
                    rms = float(np.sqrt(np.mean(block ** 2)))
                    if not started:
                        if rms > self.threshold:
                            started = True
                            chunks.append(block)
                    else:
                        chunks.append(block)
                        quiet = quiet + BLOCK if rms <= self.threshold else 0.0
                        if quiet >= silence or len(chunks) * BLOCK >= max_len:
                            break
                if self.stop.is_set() or not chunks:
                    continue
                audio = np.concatenate(chunks)
                if len(audio) / SR < 0.35:
                    continue
                t0 = time.time()
                text = self.transcribe(audio)
                cost = time.time() - t0
                if is_hallucination(text):
                    log("丢掉：%s", text or "（空）")
                    continue
                self.turns += 1
                emit({"event": "utterance", "text": text, "seconds": round(len(audio) / SR, 2),
                      "cost": round(cost, 2), "n": self.turns})
            except Exception as exc:  # 一轮出错不该弄死整只耳朵
                log("一轮出错，继续：%s", exc)
                traceback.print_exc(file=sys.stderr)
                time.sleep(0.5)

    def close(self) -> None:
        self.stop.set()
        if self.model is not None:
            self.model = None
            gc.collect()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--start", action="store_true")
    ap.add_argument("--recognize", default="")
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--engine", default="sensevoice")
    ap.add_argument("--model", default="base")
    ap.add_argument("--sensevoice_dir", default=SENSE_DIR)
    ap.add_argument("--language", default="zh")
    ap.add_argument("--initial_prompt", default="")
    ap.add_argument("--silence", type=float, default=0.8)
    ap.add_argument("--max_len", type=float, default=30.0)
    args = ap.parse_args()

    if args.list:
        list_devices()
        return 0

    ear = Ear(args)
    if args.recognize:
        try:
            audio = read_wav(args.recognize)
            if len(audio) / SR < 0.2:
                emit({"event": "recognized", "ok": False, "error": "录音太短"})
                return 1
            ear.model = ear.load_engine()
            t0 = time.time()
            text = ear.transcribe(audio)
            cost = time.time() - t0
            if is_hallucination(text):
                emit({"event": "recognized", "ok": True, "text": "",
                      "note": "识别结果像幻觉，丢掉", "seconds": round(len(audio) / SR, 2)})
                return 0
            emit({"event": "recognized", "ok": True, "text": text,
                  "seconds": round(len(audio) / SR, 2), "cost": round(cost, 2)})
            return 0
        except Exception as exc:
            emit({"event": "recognized", "ok": False, "error": str(exc)})
            return 1
        finally:
            ear.close()

    if args.selftest:
        try:
            ear.measure_noise()
            ear.model = ear.load_engine()
            log("selftest 通过，引擎 %s", ear.engine)
            emit({"event": "selftest", "ok": True, "engine": ear.engine,
                  "threshold": ear.threshold})
            return 0
        except Exception as exc:
            emit({"event": "selftest", "ok": False, "error": str(exc)})
            return 1
        finally:
            ear.close()

    if not args.start:
        log("什么都没做：要监听请加 --start")
        return 2

    worker = threading.Thread(target=ear.loop, name="ear-loop", daemon=True)
    worker.start()
    # 父进程（WhaleLife）关掉 stdin 或退出时，这里读到 EOF 就收声。
    try:
        while worker.is_alive():
            line = sys.stdin.readline()
            if line == "":
                log("父进程走了，收声")
                break
            if line.strip() == "quit":
                break
    except Exception:
        pass
    ear.close()
    emit({"event": "closed"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
