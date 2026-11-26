/*! 耳朵插件的配置页：出表单、收表单、把提交上来的值洗一遍。
 *
 * 洗的逻辑必须在这边——页面是明文的，谁都改得了。
 */

/** 可编辑字段。没列在这里的一律拒收。 */
const FIELDS = {
  python: {
    kind: "text",
    label: "Python 解释器",
    hint: "要带 SenseVoice 的那套环境的 python.exe。Windows 上 PATH 里的 python 常是应用商店的占位符，最好填完整路径。",
  },
  device: {
    kind: "number", min: 0, max: 32, step: 1,
    label: "麦克风设备号",
    hint: "0 是系统默认麦克风。听错了设备就依次往上试 1、2、3。",
  },
  engine: {
    kind: "select",
    label: "识别引擎",
    options: [{ value: "sensevoice", label: "SenseVoice（本地）" }],
    hint: "目前只有 SenseVoice。全部在本地跑，音频不出机器。",
  },
  model: {
    kind: "text",
    label: "模型档位",
    hint: "只在 whisper 引擎下有作用，挑型号（tiny/base/small/medium/large-v3）。SenseVoice 用自带快照，这一项填什么都读不到，留空即可。",
  },
  sensevoice_dir: {
    kind: "text",
    label: "SenseVoice 模型目录",
    hint: "模型文件所在的目录。换模型或者挪了位置时才需要改。",
  },
  language: {
    kind: "text",
    label: "语言",
    hint: "识别用的语言代码，例如 zh、en。说中文填 zh 更准。",
  },
  initial_prompt: {
    kind: "text",
    label: "初始提示词",
    hint: "把常说的专有名词写进来（逗号分隔），识别会准一些。例如「勘、誊、WhaleLife」。",
  },
  silence: {
    kind: "number", min: 0.1, max: 5, step: 0.1,
    label: "静音多久算一句（秒）",
    hint: "说完一句话后停这么久就切句。环境吵就调大，说话慢也调大。",
  },
  max_len: {
    kind: "number", min: 5, max: 300, step: 1,
    label: "一句最长（秒）",
    hint: "超过这个长度强制切句，免得一直说下去不出结果。",
  },
  target_session: {
    kind: "text",
    dynamic: "sessions",
    label: "投进哪个会话",
    hint: "默认投到识别完成时 WhaleLife 的当前会话，所有窗口共用这个选择。也可以固定投到指定会话。",
  },
  queue_mode: {
    kind: "select",
    label: "会话正忙时按 F9 说的话",
    hint: "插队：排到其它待办前面先处理。排队：排在后面等。两种都不会打断正在说的那一轮——宿主没有这个口子，区别只是先后。",
    options: [
      { value: "front", label: "插队先处理" },
      { value: "back", label: "排队等" },
    ],
  },
  speak_reply: {
    kind: "boolean",
    label: "F9 说完后自动念回复",
    hint: "开着的话，每按一次 F9 说完，我回复完就把话交给嗓子念出来。这里只管什么时候念；用什么声线、语速、本地还是云端，去嗓子那一页设。网页里打字不会念。",
  },
  f9_hotkey: {
    kind: "select",
    label: "全局热键",
    hint: "按住它说话，松手发送。这个键会被占用，游戏里原来用它的功能就用不了，不对话就换一个。",
    options: ["F8", "F9", "F10", "F11", "F12", "Ctrl+F9", "Ctrl+F10", "Alt+F9", "Alt+F10", "Shift+F9"],
  },
  f9_python: {
    kind: "text",
    label: "F9 扩件的解释器",
    hint: "跑全局热键那个小工具用的解释器。留空就用上面 python 同目录下的 pythonw.exe，不起黑窗口。",
  },
  auto_start_f9: {
    kind: "boolean",
    label: "启动 WhaleLife 时一并拉起 F9 扩展",
    hint: "打开后，WhaleLife 一起来 F9 就能用。要手动控制就关掉，用下面那页的按钮开。",
  },
  stop_f9_on_exit: {
    kind: "boolean",
    label: "WhaleLife 关闭时一起关掉 F9 扩展",
    hint: "关掉这一项，WhaleLife 退出后 F9 扩展还会留在后台。一般不用关掉它。",
  },
  auto_start: {
    kind: "boolean",
    label: "启动时自动开始听",
    hint: "打开后 WhaleLife 一起来就开始听麦克风。要它先安静着，就关掉这项，用 ear_start 手动开。",
  },
} as const;

type FieldKey = keyof typeof FIELDS;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** 读 POST 请求体，限 64KB。 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("提交的内容太大了");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("提交的内容不是合法 JSON");
  }
}

/** 只留白名单里的字段，数字钳制，布尔转真布尔，列表拆成数组。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const value = (input as any)[key];
    const s: any = spec;
    if (s.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      const step = Number(s.step ?? 1);
      const clamped = Math.max(s.min, Math.min(s.max, n));
      out[key] = step >= 1 ? Math.round(clamped) : Number((Math.round(clamped / step) * step).toFixed(3));
    } else if (s.kind === "boolean") {
      out[key] = value === true || value === "true" || value === "on" || value === 1;
    } else if (s.kind === "select") {
      const text = String(value ?? "").trim();
      const ok = (s.options as readonly any[]).some((o) => (typeof o === "string" ? o : o.value) === text);
      if (ok) out[key] = text;
    } else if (s.kind === "list") {
      const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,，\s]+/);
      out[key] = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].slice(0, 16);
    } else {
      out[key] = String(value ?? "").trim().slice(0, 500);
    }
  }
  return out;
}

function field(key: FieldKey, cfg: any, disabled = false, dynSessions?: { id: string; name: string }[]): string {
  const spec: any = FIELDS[key];
  const value = cfg?.[key];
  const name = esc(key);
  const label = esc(spec.label);
  const hint = spec.hint ? `<p class="pg-hint">${esc(spec.hint)}</p>` : "";
  let control: string;
  if (spec.kind === "boolean") {
    control = `<label class="pg-row pg-check"><input type="checkbox" name="${name}"${value ? " checked" : ""}><span class="pg-label">${label}</span></label>`;
  } else if (spec.dynamic === "sessions" && dynSessions) {
    // 会话 id 当值，界面上显示会话名；第一项是「当前会话」（空串）。
    const list = [{ id: "", name: "（当前会话）" }, ...dynSessions];
    const cur = String(value ?? "");
    const known = list.some((x) => x.id === cur);
    const opts = list
      .map((x) => `<option value="${esc(x.id)}"${x.id === cur ? " selected" : ""}>${esc(x.name || x.id)}</option>`)
      .join("") + (known ? "" : `<option value="${esc(cur)}" selected>${esc(cur)}（不在列表里）</option>`);
    // 固定按钮：按一下把这个会话钉住，再按一下解除，回到跟随活跃窗口。勘 2026-11-27
    const pinned = cur !== "";
    control = `<label class="pg-row"><span class="pg-label">${label}</span><select name="${name}" id="ear-target">${opts}</select></label>`
      + `<div class="pg-pin"><button type="button" id="ear-pin" data-fixed="${pinned ? "1" : "0"}">${pinned ? "解除固定" : "固定"}</button><span id="ear-pinmsg">${pinned ? "已固定，按一下解除" : "跟随活跃窗口"}</span></div>`;
  } else if (spec.kind === "select") {
    const opts = spec.options
      .map((o: any) => {
        const v = typeof o === "string" ? o : o.value;
        const t = typeof o === "string" ? o : o.label;
        return `<option value="${esc(v)}"${String(value) === v ? " selected" : ""}>${esc(t)}</option>`;
      })
      .join("");
    control = `<label class="pg-row"><span class="pg-label">${label}</span><select name="${name}">${opts}</select></label>`;
  } else if (spec.kind === "number") {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="number" name="${name}" value="${esc(value)}" min="${spec.min}" max="${spec.max}" step="${spec.step ?? 1}"></label>`;
  } else {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="text" name="${name}" value="${esc(value)}"></label>`;
  }
  if (disabled) control = control.replace(/<(input|select)(\s)/, "<$1 disabled$2");
  return `<div class="pg-item">${control}${hint}</div>`;
}
/** 渲染配置页：结构和配色都走 /ui/styles.css，跟管理页同一套。 */
/** 耳朵那一页的字段，按顺序排。 */
const EAR_KEYS: FieldKey[] = ["python", "device", "engine", "model", "sensevoice_dir", "language", "initial_prompt", "silence", "max_len", "target_session", "queue_mode", "auto_start", "f9_hotkey", "f9_python", "auto_start_f9", "stop_f9_on_exit"];
/** 嗓子（念话）那一页的字段。 */
const MOUTH_KEYS: FieldKey[] = ["speak_reply"];

/** 每两个字段并成一行；只剩一个的自己占满整行。 */
function pairs(keys: FieldKey[], cfg: any, disabled = false, dynSessions?: { id: string; name: string }[]): string {
  return keys
    .map((k) => field(k, cfg, disabled, dynSessions))
    .reduce<string[]>((acc, cur, i) => {
      if (i % 2 === 0) acc.push(`<div class="pg-pair">${cur}`);
      else acc[acc.length - 1] += `${cur}</div>`;
      return acc;
    }, [])
    .join("\n");
}

export function renderPage(
  cfg: any,
  opts: { mouth?: string | null; sessions?: { id: string; name: string }[]; currentId?: string } = {},
): string {
  const mouthOk = opts.mouth !== null && opts.mouth !== undefined;
  const mouthName = opts.mouth ?? "";
  const sessions = opts.sessions ?? [];
  const earFields = pairs(EAR_KEYS, cfg, false, sessions);
  const mouthFields = pairs(MOUTH_KEYS, mouthOk ? cfg : {}, !mouthOk);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>耳朵 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=number],.panel-body .pg-row select{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px;padding-top:2px}
.panel-body .pg-pin{display:flex;align-items:center;gap:12px;margin:10px 0 26px}
.panel-body .pg-pin button{padding:8px 16px;border-radius:8px;border:1px solid rgba(124,92,255,.45);background:rgba(124,92,255,.12);color:inherit;font-family:inherit;font-size:13px;cursor:pointer}
.panel-body .pg-pin button:hover{background:rgba(124,92,255,.22)}
.panel-body .pg-pin span{font-size:12.5px;opacity:.72}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair:last-child{margin-bottom:0}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.panel-body .pg-ro{display:grid;grid-template-columns:150px 1fr;gap:16px;margin:14px 0;font-size:13px;align-items:baseline}
.panel-body .pg-ro b{font-weight:600;color:#797e8c}
.panel-body .pg-ro code{background:rgba(127,127,127,.12);padding:2px 6px;border-radius:5px;word-break:break-all;font-size:12px}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
#msg{font-size:13px;color:#059669;white-space:pre-line}
#tmsg{font-size:13px;color:#059669;margin-left:12px}
#tmsg.err{color:#dc2626}
#talk{user-select:none;-webkit-user-select:none;touch-action:none}
#msg.err{color:#dc2626}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
#msg{display:inline;font-size:13px;font-weight:500}
.pg-tabs{display:flex;align-items:center;gap:4px;margin:0 0 18px;border-bottom:1px solid rgba(127,127,127,.25)}
.pg-tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:11px 16px;font-size:15px;font-weight:600;color:#797e8c;cursor:pointer;font-family:inherit}
.pg-tab:hover{color:#6d4aff}
.pg-tab.active{color:#6d4aff;border-bottom-color:#6d4aff}
.pg-tabs-right{margin-left:auto;display:flex;align-items:center;gap:12px;padding-bottom:6px}
.pg-page[hidden]{display:none}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
</style></head><body>
<div class="pg-tabs">
<button type="button" class="pg-tab active" data-page="ear">耳朵</button>
<button type="button" class="pg-tab" data-page="mouth">嗓子</button>
<div class="pg-tabs-right"><button class="btn primary" type="submit" form="f" id="ok">保存</button><span id="msg"></span></div>
</div>
<form id="f">
<div class="pg-page" id="page-ear">
<section class="panel"><div class="panel-header"><h2>按住说话</h2></div><div class="panel-body">
<p class="pg-hint" style="margin:0 0 16px">这一页开着的时候，按住键盘上设的那个键（或按住下面这个按钮）说话，松开就去识别，识别出来的文字直接投进会话。第一次用浏览器会问麦克风权限。要注意：只有这一页在最前面、窗口有焦点时才收得到。</p>
<button class="btn" type="button" id="talk">按住说话</button><span id="tmsg"></span>
</div></section>
<section class="panel"><div class="panel-header"><h2>全局热键</h2><div class="pg-actions"><span id="f9state" style="font-size:13px;color:#797e8c">查询中…</span><button class="btn" type="button" id="f9start">启动</button><button class="btn" type="button" id="f9stop">停止</button></div></div><div class="panel-body">
<p class="pg-hint" style="margin:0 0 14px">上面那个按键只在<b>这一页</b>开着时有效。要让它在游戏里也能用，就启动这里的扩展：它常驻在系统里，独占那个键，按住说话、松开识别，识别结果照样投进会话。<br>代价是这个键会被它占住，游戏里原本用它的功能就不响应了。关掉 WhaleLife 时它会一起收掉（除非把「关闭时一起关掉」那项关掉）。</p>
<div id="f9result" class="pg-result" hidden></div>
</div></section>
<section class="panel"><div class="panel-header"><h2>耳朵设置</h2><div class="pg-actions"><button class="btn" type="button" id="test">测试配置</button></div></div><div class="panel-body">
${earFields}
<div id="result" class="pg-result" hidden></div>
</div></section>
</div>
<div class="pg-page" id="page-mouth" hidden>
<section class="panel"><div class="panel-header"><h2>回话 · 交给「嗓子」念</h2></div><div class="panel-body">
          ${mouthOk ? `<p class=\"pg-hint\" style=\"margin:0 0 16px\">这一页只有一个开关。开着，你按 F9 说完、我回复完，话就交给「嗓子」念出来；声线、语速、本地还是云端，都在「嗓子」那一页设。网页里打字不念。</p>` : `<p class=\"pg-hint\" style=\"margin:0 0 16px;color:#b91c1c\">没找到「嗓子」插件（voice-gsv），或者它被停用了。这个开关现在按不了；装上并启用之后才能勾。</p>`}
${mouthFields}
</div></section>
</div>
</form>
<script type="module">
// —— 分页：耳朵 / 嘴巴 ——
const tabs = [...document.querySelectorAll(".pg-tab")];
const pages = [...document.querySelectorAll(".pg-page")];
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) t.classList.toggle("active", t === tab);
    for (const pg of pages) pg.hidden = pg.id !== "page-" + tab.dataset.page;
  });
}
const form = document.getElementById("f");
const msg = document.getElementById("msg");
const ok = document.getElementById("ok");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (ok.disabled) return;
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  ok.disabled = pin.disabled = pinSelect.disabled = true;
  msg.className = ""; msg.textContent = "保存中…";
  try {
    const res = await fetch("/plugins/ear/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    syncPin(data.target_session);
    msg.textContent = "已保存，下次开边车时生效";
  } catch (error) {
    msg.className = "err";
    msg.textContent = "没存上：" + (error?.message || error);
  } finally { ok.disabled = pin.disabled = pinSelect.disabled = false; }
});
// 固定 / 解除固定：改的就是 target_session 一个字段，投递前会重读配置，立刻生效。
const pin = document.getElementById("ear-pin");
const pinMsg = document.getElementById("ear-pinmsg");
const pinSelect = document.getElementById("ear-target");
const syncPin = (value) => {
  pinSelect.value = value;
  pin.dataset.fixed = value ? "1" : "0";
  pin.textContent = value ? "解除固定" : "固定";
  const name = pinSelect.options[pinSelect.selectedIndex]?.text || value;
  pinMsg.textContent = value ? ("已固定到 " + name + "，再按一下解除") : "跟随活跃窗口";
};
pin.addEventListener("click", async () => {
  const fixed = pin.dataset.fixed === "1";
  const value = fixed ? "" : String(pinSelect?.value ?? "");
  if (!fixed && !value) { pinMsg.textContent = "先在上面选一个会话，再按固定"; return; }
  ok.disabled = pin.disabled = pinSelect.disabled = true;
  try {
    const res = await fetch("/plugins/ear/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_session: value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    syncPin(value);
  } catch (error) {
    pinMsg.textContent = "没存上：" + (error?.message || error);
  } finally { ok.disabled = pin.disabled = pinSelect.disabled = false; }
});
const result = document.getElementById("result");
const show = (kind, text) => {
  result.hidden = false;
  result.className = "pg-result " + kind;
  result.textContent = text;
};
document.getElementById("test").addEventListener("click", async () => {
  const btn = document.getElementById("test");
  btn.disabled = true;
  show("wait", "测试中…请稍等");
  try {
    const res = await fetch("/plugins/ear/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || ("HTTP " + res.status));
    show("ok", Array.isArray(body.lines) ? body.lines.join(String.fromCharCode(10)) : (body.detail || body.text || "正常"));
  } catch (error) {
    show("err", "测试失败：" + (error?.message || error));
  } finally { btn.disabled = false; }
});
// —— 按住 F9 说话：录音 → 16k 单声道 wav → 投给 /plugins/ear/utter ——
const talk = document.getElementById("talk");
const tmsg = document.getElementById("tmsg");
let rec = null, chunks = [], stream = null, decoding = false;

const toWav = async (blob) => {
  const buf = await blob.arrayBuffer();
  const ac = new AudioContext();
  const audio = await ac.decodeAudioData(buf);
  const rate = 16000;
  const src = audio.getChannelData(0);
  const ratio = audio.sampleRate / rate;
  const len = Math.floor(src.length / ratio);
  const view = new DataView(new ArrayBuffer(44 + len * 2));
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)] || 0));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  await ac.close();
  return new Blob([view.buffer], { type: "audio/wav" });
};

const startRec = async () => {
  if (rec || decoding) return;
  tmsg.textContent = "录音中…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      decoding = true;
      tmsg.textContent = "识别中…";
      try {
        if (!chunks.length) throw new Error("没录到声音");
        const wav = await toWav(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
        const res = await fetch("/plugins/ear/utter", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) throw new Error(body.error || ("HTTP " + res.status));
        tmsg.textContent = body.text ? "已投递：" + body.text : (body.detail || "没听清");
      } catch (error) {
        tmsg.textContent = "没成功：" + (error?.message || error);
      } finally {
        decoding = false;
        stream?.getTracks().forEach((t) => t.stop());
        stream = null; rec = null;
      }
    };
    rec.start();
  } catch (error) {
    tmsg.textContent = "开不了麦克风：" + (error?.message || error);
    stream = null; rec = null;
  }
};

const stopRec = () => { if (rec && rec.state !== "inactive") rec.stop(); };

window.addEventListener("keydown", (e) => { if (e.key === "F9" && !e.repeat) { e.preventDefault(); startRec(); } });
window.addEventListener("keyup", (e) => { if (e.key === "F9") { e.preventDefault(); stopRec(); } });
talk.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
talk.addEventListener("pointerup", stopRec);
talk.addEventListener("pointerleave", () => { if (rec) stopRec(); });

// —— F9 全局热键扩展：启动 / 停止 / 状态 ——
const f9state = document.getElementById("f9state");
const f9result = document.getElementById("f9result");
const f9show = (kind, text) => {
  f9result.hidden = false;
  f9result.className = "pg-result " + kind;
  f9result.textContent = text;
};
const f9render = (st) => {
  if (!st) return;
  f9state.textContent = st.running ? ("运行中 · pid " + st.pid + " · 已跑 " + st.uptime + " 秒") : "未运行";
  f9state.style.color = st.running ? "#059669" : "#797e8c";
};
const f9call = async (path, label, btn) => {
  if (btn) btn.disabled = true;
  f9show("wait", label + "中…");
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    f9render(body.state);
    if (!res.ok || body.ok === false) throw new Error(body.reason || ("HTTP " + res.status));
    f9show("ok", label + "成功" + (body.pid ? "，pid " + body.pid : "") + (body.python ? "；解释器：" + body.python : ""));
  } catch (error) {
    f9show("err", label + "失败：" + (error && error.message ? error.message : error));
  } finally {
    if (btn) btn.disabled = false;
  }
};
document.getElementById("f9start").addEventListener("click", (e) => f9call("/plugins/ear/f9/start", "启动", e.currentTarget));
document.getElementById("f9stop").addEventListener("click", (e) => f9call("/plugins/ear/f9/stop", "停止", e.currentTarget));
const f9poll = async () => {
  try {
    const res = await fetch("/plugins/ear/f9/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (body && body.state) f9render(body.state);
  } catch {}
};
f9poll();
setInterval(f9poll, 5000);

</script></body></html>`;
}
