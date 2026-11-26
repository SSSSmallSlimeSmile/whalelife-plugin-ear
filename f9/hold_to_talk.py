# -*- coding: utf-8 -*-
"""按住热键说话：全局热键 + 录音 + 投给 WhaleLife 的耳朵插件。

为什么要在插件外面：网页里的「按住说话」只在浏览器有焦点时收得到按键，
玩游戏时焦点在游戏窗口，浏览器一个键也收不到。要真正全局，就得有一个
常驻小进程，用 Windows 的 RegisterHotKey 独占那个键。

它自己不做识别，只负责录一段干净的话，POST 给 /plugins/ear/utter，
那边用同一套 SenseVoice/paraformer 引擎识别并投进会话。

用法：
    pythonw hold_to_talk.py            常驻
    python  hold_to_talk.py --probe    自检（不占热键，录 2 秒看能不能出声）

配置在同目录 f9.json，第一次运行自动生成。
"""
from __future__ import annotations

import ctypes
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "f9.json")
# plugins/ear/f9/ -> 仓库根 -> config/config.json
ROOT_CONFIG = os.path.normpath(os.path.join(HERE, "..", "..", "..", "config", "config.json"))

DEFAULTS = {
    "hotkey": "F9",
    "url": "http://127.0.0.1:9270",
    "min_seconds": 0.35,
    "max_seconds": 60,
    "sample_rate": 16000,
    "device": None,
    "beep": True,
    "log": os.path.join(HERE, "f9.log"),
}

VK = {
    **{f"F{i}": 0x6F + i for i in range(1, 13)},
    "SCROLL": 0x91,
    "PAUSE": 0x13,
    "INSERT": 0x2D,
    "HOME": 0x24,
    "END": 0x23,
    "PAGEUP": 0x21,
    "PAGEDOWN": 0x22,
    "CAPSLOCK": 0x14,
}

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]

WM_HOTKEY = 0x0312
MOD_NOREPEAT = 0x4000
HOTKEY_ID = 0xB0B

MODS = {"CTRL": 0x0002, "ALT": 0x0001, "SHIFT": 0x0004, "WIN": 0x0008}


def parse_hotkey(spec):
    parts = [p.strip().upper() for p in str(spec or "F9").replace(" ", "").split("+") if p.strip()]
    mods = 0
    key = ""
    for p in parts:
        if p in MODS:
            mods |= MODS[p]
        else:
            key = p
    return VK.get(key), mods


def hotkey_arg():
    argv = sys.argv
    for i, a in enumerate(argv):
        if a == "--hotkey" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--hotkey="):
            return a.split("=", 1)[1]
    return ""


def log(line: str, cfg: dict | None = None) -> None:
    path = (cfg or {}).get("log") or DEFAULTS["log"]
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {line}\n")
    except OSError:
        pass


def load_cfg() -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(CFG_PATH):
        try:
            with open(CFG_PATH, "r", encoding="utf-8-sig") as fh:
                saved = json.load(fh)
            if not isinstance(saved, dict):
                raise ValueError("配置必须是 JSON 对象")
            cfg.update(saved)
        except (OSError, ValueError) as exc:
            log(f"读取 f9.json 失败，使用默认值：{exc}", cfg)
    else:
        try:
            with open(CFG_PATH, "w", encoding="utf-8") as fh:
                json.dump(DEFAULTS, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass
    return cfg


def web_password() -> str:
    """从宿主配置里取网页密码。同机同权限，脚本读得到，不另存在别处。"""
    try:
        with open(ROOT_CONFIG, "r", encoding="utf-8-sig") as fh:
            return str((json.load(fh) or {}).get("web", {}).get("password") or "")
    except (OSError, ValueError):
        return ""


def login(base: str) -> str:
    """换一个 whale= 的 cookie。失败返回空串，那就只能本地录，投不进会话。"""
    pwd = web_password()
    data = json.dumps({"password": pwd}).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/api/login",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as res:
            raw = res.headers.get("Set-Cookie") or ""
    except (urllib.error.URLError, OSError) as exc:
        log(f"login failed: {exc}")
        return ""
    for part in raw.split(";"):
        part = part.strip()
        if part.startswith("whale="):
            return part
    return ""


def post_wav(base: str, cookie: str, wav_bytes: bytes) -> str:
    req = urllib.request.Request(
        base.rstrip("/") + "/plugins/ear/utter",
        data=wav_bytes,
        headers={"Content-Type": "audio/wav", "Cookie": cookie},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            payload = json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        return f"HTTP {exc.code}: {body[:200]}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return f"投递失败：{exc}"
    if not payload.get("ok"):
        return f"识别失败：{payload.get('error') or payload}"
    text = (payload.get("text") or "").strip()
    return text or (payload.get("detail") or "没听清说什么")


def to_wav(frames, rate: int) -> bytes:
    import numpy as np

    audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 1), dtype="int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(audio.astype("int16").tobytes())
    return buf.getvalue()


def recorder(rate: int, device):
    import numpy as np
    import sounddevice as sd

    frames: list = []
    state = {"recording": False}

    def callback(indata, _frames, _time, status):  # noqa: ANN001
        if state["recording"]:
            frames.append(indata.copy())

    stream = sd.InputStream(
        samplerate=rate, channels=1, dtype="int16", callback=callback, device=device
    )
    stream.start()
    return state, frames, stream, np


def _tone(freq: int, ms: int, rate: int = 22050, volume: float = 0.22):
    """短短的"嘀"一声，带淡入淡出，免得爆音。"""
    import numpy as np

    n = max(1, int(rate * ms / 1000))
    t = np.linspace(0.0, ms / 1000.0, n, endpoint=False)
    wave_data = np.sin(2 * np.pi * freq * t)
    fade = max(1, int(n * 0.25))
    wave_data[:fade] *= np.linspace(0.0, 1.0, fade)
    wave_data[-fade:] *= np.linspace(1.0, 0.0, fade)
    return (wave_data * volume * 32767).astype("int16")


def chime(kind: str) -> None:
    """按下高一点、松手低一点。放不出来就算了，不影响录音。"""
    try:
        import sounddevice as sd

        freq, ms = (1318, 70) if kind == "down" else (880, 95)
        sd.play(_tone(freq, ms), 22050, blocking=False)
    except Exception:  # noqa: BLE001
        pass


def probe(cfg: dict) -> int:
    """自检：不占热键，录两秒，看看麦克风通不通。"""
    import numpy as np
    import sounddevice as sd

    rate = int(cfg["sample_rate"])
    try:
        dev = cfg.get("device")
        dev = int(dev) if dev not in (None, "", "None") else None
        data = sd.rec(int(rate * 2), samplerate=rate, channels=1, dtype="int16", device=dev)
        sd.wait()
    except Exception as exc:  # noqa: BLE001
        print(f"[x] 录不了音：{exc}")
        return 1
    peak = int(np.abs(data).max()) if data.size else 0
    print(f"[+] 录了 2 秒，采样率 {rate}，峰值 {peak}")
    print("    峰值接近 0 说明麦克风没开权限或被静音。")
    return 0


def main() -> int:
    cfg = load_cfg()
    if "--probe" in sys.argv:
        return probe(cfg)

    name = hotkey_arg() or str(cfg.get("hotkey") or "F9")
    vk, mods = parse_hotkey(name)
    if vk is None:
        print(f"不认识的热键：{name}")
        return 2

    base = str(cfg.get("url") or DEFAULTS["url"])
    rate = int(cfg["sample_rate"])
    min_s = float(cfg["min_seconds"])
    max_s = float(cfg["max_seconds"])
    beep = bool(cfg.get("beep", True))

    if not user32.RegisterHotKey(None, HOTKEY_ID, MOD_NOREPEAT | mods, vk):
        log(f"hotkey {name} 已被占用，注册失败")
        print(f"{name} 已被别的程序占用，换一个键（改 f9.json 的 hotkey）。")
        return 3
    log(f"hotkey {name} 已注册，端口 {base}")

    state, frames, stream, np = recorder(rate, cfg.get("device"))
    msg = wintypes.MSG()
    cookie = ""
    cookie_at = 0.0

    def ensure_cookie() -> str:
        nonlocal cookie, cookie_at
        if cookie and time.time() - cookie_at < 1800:
            return cookie
        cookie = login(base)
        cookie_at = time.time()
        return cookie

    try:
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message != WM_HOTKEY or msg.wParam != HOTKEY_ID:
                continue
            if state["recording"]:
                continue  # 按住会重复发 WM_HOTKEY，忽略
            frames.clear()
            if beep:
                chime("down")
            state["recording"] = True
            began = time.time()
            # WM_HOTKEY 只有按下，没有松开：轮询这个键的真实状态
            while user32.GetAsyncKeyState(vk) & 0x8000:
                if time.time() - began > max_s:
                    break
                time.sleep(0.02)
            state["recording"] = False
            if beep:
                chime("up")
            held = time.time() - began
            if held < min_s:
                log(f"skip too_short={held:.2f}s")
                continue
            wav_bytes = to_wav(frames, rate)
            if len(wav_bytes) < 2000:
                log("skip empty")
                continue
            use = ensure_cookie()
            if not use:
                log("no cookie, 投不进去")
                continue
            result = post_wav(base, use, wav_bytes)
            log(f"held={held:.2f}s -> {result}")
    finally:
        try:
            stream.stop()
            stream.close()
        except Exception:  # noqa: BLE001
            pass
        user32.UnregisterHotKey(None, HOTKEY_ID)
    return 0


if __name__ == "__main__":
    sys.exit(main())
