/*! WhaleLife「耳朵」插件：麦克风 -> SenseVoice 边车 -> 投进会话。
 *
 * 麦克风采集与识别放在 Python 边车里（本机没有 Node 侧的等价库）。
 * 这边只管三件事：拉起、读 stdout、把每句话当一条用户消息送进会话。
 *
 * 默认闭嘴：auto_start 是 false，要用 ear_start 才开。
 */
import type { Context } from "../../core/context.ts";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 念话那套插件在哪一个上：新的是 voice-gsv（嗓子），老的 mouth 已经并进去了。
 *  返回插件 id，没有可用插件时返回 null。 */
function speechPlugin(): string | null {
  try {
    const raw = readFileSync(join(HERE, "..", "..", "config", "plugins.json"), "utf8");
    const disabled = JSON.parse(raw)?.disabled;
    for (const id of ["voice-gsv", "mouth"]) {
      if (!existsSync(join(HERE, "..", id, "plugin.yaml"))) continue;
      if (Array.isArray(disabled) && disabled.includes(id)) continue;
      return id;
    }
    return null;
  } catch {
    return "voice-gsv";
  }
}

const DEFAULTS = {
  python: "",
  script: join(HERE, "ear_sidecar.py"),
  device: 1,
  engine: "sensevoice",
  model: "base",
  sensevoice_dir: "",
  language: "zh",
  initial_prompt: "勘，誊，astrbot，whalelife，Minecraft，ComfyUI，Lora，表情包，插件，麦克风",
  silence: 0.8,
  max_len: 30,
  /** 空 = 用当前会话。 */
  target_session: "",
  /** 回复完交给「嘴巴」插件念出来，默认不念。 */
  speak_reply: false,
  /** WhaleLife 启动时自动开始监听。 */
  auto_start: false,
  /** F9 扩展用哪个解释器；留空 = 用 python 同目录下的 pythonw.exe（不起黑窗口）。 */
  f9_python: "",
  /** WhaleLife 启动时把 F9 扩展一起拉起来。 */
  auto_start_f9: false,
  /** F9 扩展占用的全局热键：F9、F10、Ctrl+F9 这种写法。 */
  f9_hotkey: "F9",
  /**
   * 会话正在回复时，按 F9 说的这句话怎么办。
   * front = 插队，排到其它待办前面（priority 90）；back = 排队，排在后面（priority 10）。
   * 两种都等当前这一轮说完再进去——宿主明确不支持打断正在跑的那一轮。
   */
  queue_mode: "front",
  /** WhaleLife 退出时把 F9 扩展一起关掉。 */
  stop_f9_on_exit: true,
};

type Config = typeof DEFAULTS;

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = (await ctx.config.read("config.json")) as Partial<Config> | null;
  } catch {
    saved = null;
  }
  let cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };

  /** 每次开麦前重读一遍；正在听的边车不受影响，要停了重开才用新参数。 */
  const reload = async () => {
    try {
      const again = (await ctx.config.read("config.json")) as Partial<Config> | null;
      cfg = { ...DEFAULTS, ...(again ?? {}) };
    } catch {
      // 读不到就沿用旧值
    }
  };

  let child: ChildProcessWithoutNullStreams | null = null;
  let listening = false;
  let ready = false;
  let turns = 0;
  let pending = 0;
  let last = "";
  let lastError = "";
  let lastF9Error = "";
  let buf = "";

  /** 把一句话当用户消息投进会话。 */
  const deliver = async (text: string) => {
    const turn = ++turns;
    last = text;
    pending += 1;
    try {
      await reload();
      const { target_session, queue_mode, speak_reply } = cfg;
      const sessionId = target_session || (await ctx.sessions.current());
      const origin = { platform: "ear", action: "hold_to_talk" } as const;
      const input = { sessionId, text, origin };
      const reply = typeof ctx.sessions.enqueue === "function"
        ? await ctx.sessions.enqueue({ ...input, priority: queue_mode === "front" ? 90 : 10 })
        : await ctx.sessions.run(input);
      const replyText = String(reply ?? "").trim();
      ctx.logger.info(`耳朵回复 ${replyText.length} 字`);
      // 回话交给「嘴巴」插件念。没装、被停用、或者开关关着，都只是不出声，不影响打字。
      if (speak_reply && replyText) {
        try {
          const said: any = await ctx.tools.call(
            "mouth_say",
            { text: replyText },
            { permission: "full", origin: { platform: "ear", action: "hold_to_talk" } } as any,
          );
          const note =
            said && typeof said === "object"
              ? said.ok === false
                ? `失败：${said.error ?? ""}`
                : String(said.result ?? "ok")
              : String(said);
          ctx.logger.info(`耳朵叫嘴巴念：${note}`);
        } catch (error: any) {
          ctx.logger.warn(`耳朵叫嘴巴念失败（嘴巴装了没？）：${error?.message ?? error}`);
        }
      }

      return { ok: true as const };
    } catch (error: any) {
      const message = error?.message ?? String(error);
      lastError = `#${turn} ${message}`;
      ctx.logger.warn(`耳朵投递失败：${lastError}`);
      return { ok: false as const, error: message };
    } finally {
      pending -= 1;
    }
  };

  const handleLine = async (line: string) => {
    const s = line.trim();
    if (!s) return;
    let msg: any;
    try {
      msg = JSON.parse(s);
    } catch {
      // 边车偶尔会往 stdout 漏非 JSON 的行，跳过就行
      return;
    }
    if (msg.event === "ready") {
      ready = true;
      ctx.logger.info(`耳朵就绪：引擎 ${msg.engine}，阈值 ${msg.threshold}`);
      return;
    }
    if (msg.event === "selftest") {
      ctx.logger.info(`耳朵自检：${msg.ok ? "通过" : "失败 " + (msg.error ?? "")}`);
      return;
    }
    if (msg.event === "error") {
      lastError = String(msg.error ?? "边车初始化失败");
      ctx.logger.warn(`耳朵边车出错：${lastError}`);
      return;
    }
    if (msg.event === "closed") {
      listening = false;
      ready = false;
      return;
    }
    if (msg.event === "utterance" && typeof msg.text === "string") {
      await deliver(msg.text);
    }
  };

  const start = async () => {
    if (child) return { ok: false as const, reason: "已经在听了" };
    await reload();
    if (child) return { ok: false as const, reason: "已经在听了" };
    if (ctx.signal.aborted) return { ok: false as const, reason: "插件正在停止" };
    if (!cfg.python) return { ok: false as const, reason: "没填 Python 解释器" };
    const args = [
      cfg.script,
      "--start",
      "--device", String(cfg.device),
      "--engine", String(cfg.engine),
      "--model", String(cfg.model),
      "--sensevoice_dir", String(cfg.sensevoice_dir),
      "--language", String(cfg.language),
      "--initial_prompt", String(cfg.initial_prompt),
      "--silence", String(cfg.silence),
      "--max_len", String(cfg.max_len),
    ];
    const c = spawn(cfg.python, args, {
      cwd: HERE,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    }) as ChildProcessWithoutNullStreams;
    child = c;
    listening = true;
    ready = false;
    buf = "";

    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        void handleLine(line);
      }
    });
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) ctx.logger.info(`[ear] ${text.slice(0, 400)}`);
    });
    const reset = () => {
      if (child !== c) return;
      child = null;
      listening = false;
      ready = false;
    };
    c.stdin.on("error", (error) => {
      ctx.logger.warn(`耳朵边车 stdin 出错：${error.message}`);
    });
    c.on("exit", (code) => {
      ctx.logger.info(`耳朵边车退出，code=${code}`);
      reset();
    });
    return new Promise<{ ok: true; pid: number | null } | { ok: false; reason: string }>((resolve) => {
      c.on("error", (error) => {
        lastError = error.message;
        ctx.logger.warn(`耳朵边车出错：${lastError}`);
        if (c.pid === undefined) reset();
        resolve({ ok: false, reason: lastError });
      });
      c.once("spawn", () => {
        const pid = c.pid ?? null;
        ctx.logger.info(`耳朵拉起，pid=${pid}`);
        resolve({ ok: true, pid });
      });
    });
  };

  const stop = async () => {
    const c = child;
    if (!c) return { ok: false, reason: "没在听" };
    try {
      c.stdin.write("quit\n");
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    if (child === c) {
      try {
        c.kill();
      } catch {}
    }
    return { ok: true };
  };

  ctx.tools.register({
    name: "ear_start",
    description: "开始听麦克风：拉起识别边车，把每句话当成一条用户消息投进会话。加载模型要几十秒。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: async () => {
      const r = await start();
      if (!r.ok) return `没做：${r.reason}`;
      return `耳朵开了（边车 pid=${r.pid ?? "?"}）。模型加载几十秒，就绪后每说一句话都会被投进会话。`;
    },
  });

  ctx.tools.register({
    name: "ear_stop",
    description: "停止听麦克风，边车连模型一起收掉。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: async () => {
      const r = await stop();
      if (!r.ok) return `没做：${r.reason}`;
      return "耳朵收了，麦克风关了。";
    },
  });

  ctx.tools.register({
    name: "ear_status",
    description: "看耳朵状态：边车在不在、引擎就绪没有、已经转了几句。",
    schema: { type: "object", properties: {} },
    danger: "safe",
    run: async () => {
      const parts = [
        listening ? (ready ? "在听（引擎已就绪）" : "在听（模型还在加载）") : "闭嘴",
        `已转 ${turns} 句`,
      ];
      if (pending) parts.push(`处理中（含排队）${pending} 句`);
      if (last) parts.push(`最后一句：${last}`);
      if (lastError) parts.push(`上次出错：${lastError}`);
      if (child?.pid) parts.push(`pid=${child.pid}`);
      return parts.join("｜");
    },
  });

  // —— F9 全局热键扩展：由插件拉起/收掉，跟 WhaleLife 同生共死 ——
  const f9Script = join(HERE, "f9", "hold_to_talk.py");
  let f9Child: ReturnType<typeof spawn> | null = null;
  let f9StartedAt = 0;

  /** python.exe → 同目录 pythonw.exe；找不到就退回原样。 */
  const f9Interpreter = () => {
    if (cfg.f9_python) return cfg.f9_python;
    const p = String(cfg.python || "");
    if (!p) return "pythonw";
    const w = p.replace(/python\.exe$/i, "pythonw.exe");
    return w !== p && existsSync(w) ? w : p;
  };

  const f9Start = async (): Promise<{ ok: boolean; reason?: string; pid?: number | null; python?: string }> => {
    if (f9Child) return { ok: false, reason: "已经在跑了" };
    await reload();
    if (f9Child) return { ok: false, reason: "已经在跑了" };
    if (ctx.signal.aborted) return { ok: false, reason: "插件正在停止" };
    if (!existsSync(f9Script)) return { ok: false, reason: "脚本不在：" + f9Script };
    const exe = f9Interpreter();
    try {
      const c = spawn(exe, [f9Script, "--hotkey", cfg.f9_hotkey || "F9"], {
        cwd: join(HERE, "f9"),
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      f9Child = c;
      f9StartedAt = Date.now();
      lastF9Error = "";
      c.stderr?.setEncoding("utf8");
      c.stderr?.on("data", (chunk: string) => {
        if (f9Child !== c || !chunk.trim()) return;
        lastF9Error = chunk.trim().slice(-1000);
        ctx.logger.warn(`F9 扩展：${lastF9Error}`);
      });
      c.on("close", (code, signal) => {
        if (f9Child !== c) return;
        if (code !== 0 && !signal && !lastF9Error) lastF9Error = `F9 扩展异常退出，code=${code}`;
        f9Child = null;
      });
      return await new Promise<{ ok: boolean; reason?: string; pid?: number | null; python?: string }>((resolve) => {
        c.on("error", (e: Error) => {
          if (f9Child === c) lastF9Error = e.message;
          resolve({ ok: false, reason: e.message });
        });
        c.once("spawn", () => {
          ctx.logger.info("F9 扩展拉起，pid=" + (c.pid ?? "?") + "，解释器 " + exe);
          resolve({ ok: true, pid: c.pid ?? null, python: exe });
        });
      });
    } catch (error: any) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  };

  const f9Stop = async () => {
    const c = f9Child;
    if (!c) return { ok: false, reason: "没在跑" };
    try {
      c.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
    if (f9Child === c && c.exitCode === null && c.signalCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {}
      return { ok: false, reason: "F9 扩展仍在退出，请查看状态" };
    }
    ctx.logger.info("F9 扩展已收");
    return { ok: true };
  };

  const f9State = () => ({
    running: !!f9Child,
    pid: f9Child?.pid ?? null,
    uptime: f9Child ? Math.round((Date.now() - f9StartedAt) / 1000) : 0,
    python: f9Interpreter(),
    script: f9Script,
    error: lastF9Error,
  });

  /** 边车公共参数。 */
  const sidecarArgs = (extra: string[]) => [
    cfg.script,
    ...extra,
    "--device", String(cfg.device),
    "--engine", String(cfg.engine),
    "--model", String(cfg.model),
    "--sensevoice_dir", String(cfg.sensevoice_dir),
    "--language", String(cfg.language),
    "--initial_prompt", String(cfg.initial_prompt),
  ];

  /** 异步跑边车。不能用 spawnSync：它会卡住整个插件进程，心跳断掉就被看门狗切。 */
  const runSidecar = (extra: string[], timeout = 240_000) =>
    new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
      const child = spawn(cfg.python, sidecarArgs(extra), {
        cwd: HERE,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 收不掉就算了，after below 会返回 */
        }
      }, timeout);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + "\n" + e.message, status: null });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, status: code });
      });
    });

  const sidecarOut = (out: any) => {
    const text = String(out?.stdout ?? "").trim();
    const line = text.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
    return line ?? "";
  };

  /** 跑一次 --selftest：加载引擎、量底噪。慢，一分钟上下。 */
  const selftest = async (): Promise<{ ok: boolean; lines: string[] }> => {
    await reload();
    const lines: string[] = [];
    if (!cfg.python) {
      lines.push("[×] 没填 python 解释器。填上之后再测。");
      return { ok: false, lines };
    }
    if (!existsSync(cfg.python)) {
      lines.push(`[×] python 不在：${cfg.python}`);
      return { ok: false, lines };
    }
    if (!existsSync(cfg.script)) {
      lines.push(`[×] 边车脚本不在：${cfg.script}`);
      return { ok: false, lines };
    }
    lines.push(`[·] python：${cfg.python}`);
    lines.push(`[·] 引擎：${cfg.engine}，设备号 ${cfg.device}`);
    const t0 = Date.now();
    const out = await runSidecar(["--selftest"]);
    const ms = Date.now() - t0;
    const line = sidecarOut(out);
    if (!line) {
      const tail = String(out?.stderr ?? "").trim().split(/\r?\n/).slice(-4).join(" / ");
      lines.push(`[×] 自检没吐出结果（${(ms / 1000).toFixed(1)} 秒）${tail ? "：" + tail : ""}`);
      return { ok: false, lines };
    }
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      lines.push(`[×] 自检输出解不开：${line.slice(0, 200)}`);
      return { ok: false, lines };
    }
    if (data.ok) {
      lines.push(`[✓] 引擎 ${data.engine} 加载成功，底噪阈值 ${data.threshold}`);
      lines.push(`[✓] 全流程用时 ${(ms / 1000).toFixed(1)} 秒`);
      return { ok: true, lines };
    }
    lines.push(`[×] 自检失败：${data.error ?? "没给原因"}`);
    return { ok: false, lines };
  };

  /** 识别一个 wav 文件（16bit PCM）。 */
  const recognize = async (wavPath: string): Promise<{ ok: boolean; text?: string; error?: string; note?: string }> => {
    await reload();
    const out = await runSidecar(["--recognize", wavPath]);
    const line = sidecarOut(out);
    if (!line) {
      const tail = String(out?.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / ");
      return { ok: false, error: `边车没给结果${tail ? "：" + tail : ""}` };
    }
    try {
      const data = JSON.parse(line);
      if (!data.ok) return { ok: false, error: data.error ?? "识别失败" };
      return { ok: true, text: String(data.text ?? ""), note: data.note };
    } catch {
      return { ok: false, error: `输出解不开：${line.slice(0, 160)}` };
    }
  };

  /** 读客户端上传的原始字节，限 8MB。 */
  const readAudio = async (req: any): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error("音频太大（超过 8MB）");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  const replyJson = (res: any, code: number, body: any) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  ctx.web.api("/plugins/ear/f9/start", async (_req: any, res: any) => {
    try {
      const r = await f9Start();
      return replyJson(res, r.ok ? 200 : 400, { ...r, state: f9State() });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, reason: error?.message ?? String(error), state: f9State() });
    }
  });

  ctx.web.api("/plugins/ear/f9/stop", async (_req: any, res: any) => {
    try {
      const r = await f9Stop();
      return replyJson(res, r.ok ? 200 : 400, { ...r, state: f9State() });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, reason: error?.message ?? String(error), state: f9State() });
    }
  });

  ctx.web.api("/plugins/ear/f9/status", async (_req: any, res: any) => {
    return replyJson(res, 200, { ok: true, state: f9State() });
  });

  ctx.web.api("/plugins/ear/test", async (_req: any, res: any) => {
    try {
      const r = await selftest();
      return replyJson(res, 200, r);
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, lines: [`测试本身出错：${error?.message ?? error}`] });
    }
  });

  ctx.web.api("/plugins/ear/utter", async (req: any, res: any) => {
    let dir = "";
    try {
      const buf = await readAudio(req);
      if (!buf.length) return replyJson(res, 400, { ok: false, error: "没收到音频" });
      dir = mkdtempSync(join(tmpdir(), "whalelife-ear-"));
      const file = join(dir, "hold.wav");
      writeFileSync(file, buf);
      const r = await recognize(file);
      if (!r.ok) return replyJson(res, 500, { ok: false, error: r.error });
      const text = String(r.text ?? "").trim();
      if (!text) return replyJson(res, 200, { ok: true, text: "", detail: r.note ?? "没听清说什么" });
      // 投递是异步的一整轮，不能等它跑完再回；但会话被删、会话忙这类会当场抛，
      // 给一小段时间让这类错误浮出来，免得页面显示"已投递"而其实根本没进去。
      const sending = deliver(text);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const early = await Promise.race([
        sending,
        new Promise<null>((r) => { timer = setTimeout(() => r(null), 1500); }),
      ]).finally(() => clearTimeout(timer));
      if (early && !early.ok) return replyJson(res, 500, { ok: false, text, error: `投递失败：${early.error}` });
      return replyJson(res, 200, { ok: true, text, delivery: early ? "done" : "accepted" });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          ctx.logger.warn(`耳朵清理识别临时目录失败：${String(error)}`);
        }
      }
    }
  });

  ctx.web.page(
    "/plugins/ear/",
    async (_req: any, res: any) => {
      await reload();
      const sessions = await ctx.sessions.list().catch(() => [] as any[]);
      const currentId = await ctx.sessions.current().catch(() => "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg, { mouth: speechPlugin(), sessions, currentId }));
    },
    { title: "耳朵", navigation: true },
  );

  let saving: Promise<void> = Promise.resolve();
  ctx.web.api("/plugins/ear/save", async (req: any, res: any) => {
    try {
      const patchIn = sanitize(await readBody(req));
      const keys = Object.keys(patchIn);
      if (!keys.length) throw new Error("没有可保存的字段");
      const write = saving.then(async () => {
        ctx.signal.throwIfAborted();
        const merged = { ...(await ctx.config.read<any>("config.json")), ...patchIn };
        await ctx.config.save("config.json", merged);
      });
      saving = write.catch(() => {});
      await write;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, saved: keys }));
    } catch (error: any) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
    }
  });

  ctx.on("whalelife/ready", async () => {
    await reload();
    if (cfg.auto_start) {
      const r = await start();
      ctx.logger.info(r.ok ? "耳朵已随主程序开始监听" : `耳朵未开：${r.reason}`);
    }
    if (cfg.auto_start_f9) {
      const r = await f9Start();
      ctx.logger.info(r.ok ? `F9 扩展已随主程序启动，pid=${r.pid}` : `F9 扩展未开：${r.reason}`);
    }
  });

  ctx.effect(() => () => {
    if (cfg.stop_f9_on_exit && f9Child) {
      try {
        f9Child.kill();
      } catch {}
      f9Child = null;
    }
    if (child) {
      try {
        child.stdin.write("quit\n");
      } catch {}
      try {
        child.kill();
      } catch {}
      child = null;
    }
    ctx.logger.info("ear 已清理");
  });
}
