# ear · 耳朵

麦克风听写。说一句话，识别成文字，当成一条用户消息投进会话。

**回话不归它管。** 想让回复被念出来，装 [嗓子](../voice)，两个插件是一对（0.3.0 起「嘴巴」已并进嗓子）。

## 装之前，三样东西缺一不可

### 一、Python 环境

需要一个装了这几样东西的 Python：

```
funasr        识别框架
sounddevice   录麦克风
soundfile     读写 wav
torch         模型推理
```

用哪个 Python 都行，系统 Python 或虚拟环境都可以。**建议用虚拟环境**，别污染系统那个。

缺 `sounddevice` 时页面上会直接报 `No module named 'sounddevice'`；缺别的类似，按报错补装即可。

```bash
<你的python> -m pip install funasr sounddevice soundfile torch
```

### 二、SenseVoice 模型

本插件用的是 **SenseVoiceSmall**（通义那个小模型，234M 参数）。模型文件不是 pip 装的，要单独下。

从 ModelScope 下载 `iic/SenseVoiceSmall`，拿到快照目录，把**放模型的那个目录**填进 `sensevoice_dir`。

判断填对了没有：那个目录里应该有 `model.pt`（或 `model.safetensors`）和 `configuration.json` 一类文件。**填到上一级不行，要填到直接含模型文件的那层。**

### 三、麦克风

Windows 上设备是按编号选的，不是按名字。`device` 填 `-1` 让系统自己挑，挑错了就手动指定。

查编号的方法：页面上有个「录音测试」，点一下能不能录到、波形有没有、识别结果对不对。不出声先看系统设置里这个程序有没有麦克风权限。

## 配置

```json
{
  "enabled": true,
  "auto_start": false,
  "python": "",
  "sensevoice_dir": "",
  "device": -1,
  "engine": "sensevoice",
  "language": "zh",
  "initial_prompt": "",
  "silence": 0.7,
  "max_len": 30,
  "target_session": "",
  "speak_reply": false,
  "auto_start_f9": false,
  "stop_f9_on_exit": true,
  "f9_hotkey": "F9",
  "f9_python": ""
}
```

| 字段 | 说明 |
|---|---|
| `python` | 跑边车的解释器。**填绝对路径**，别指望 PATH 里那个（Windows 上常常是商店占位符，跑起来只弹商店） |
| `sensevoice_dir` | 模型目录，见上面第二条 |
| `device` | 麦克风编号，`-1` 自动挑 |
| `engine` | 目前只有 `sensevoice` |
| `language` | 识别语言，`zh` / `en` / `ja` / `ko` / `yue`，也能填 `auto` |
| `initial_prompt` | 热词，逗号分隔。人名、项目名、专有名词填这儿，识别率会明显好一点 |
| `silence` | 静音多少秒算一句结束。太短会把一句话切碎，太长会等很久才出字 |
| `max_len` | 单句最长多少秒，超了强制截断。**SenseVoice 单次只吃约 30 秒，别设太大** |
| `target_session` | 识别出来的话投到哪个会话，空 = 当前会话 |
| `speak_reply` | 识别完拿到回复后，要不要调 `mouth_say` 念出来。**需要装嗓子** |
| `auto_start` | WhaleLife 起来时要不要自动拉起边车（加载模型要几十秒，所以默认关） |
| `auto_start_f9` / `stop_f9_on_exit` | F9 那个外部进程是否随 WhaleLife 起、随它关闭 |
| `f9_hotkey` | 全局热键，默认 F9 |
| `f9_python` | F9 进程用哪个解释器，空则找 `pythonw` |

> **三个已经删掉的字段**：`gsv_url`、`gsv_prompt_text`、`gsv_ref_audio` 是合并进嗓子之前留下的，**现在没有任何代码读**。默认值里已经去掉，磁盘那份也清过了。要是从旧版本升上来还看到它们，删掉就行，不影响运行。`model` 不算死字段——它传给边车 `--model`，只有 `whisper` 引擎会用，`sensevoice` 下不起作用。

## 两种用法

### 一、页面上开听

点「开始听」，边车拉起，模型加载几十秒，之后每说一句就投一条消息。点「停止听」收掉，连模型一起退出。

适合一次性的、要边看屏幕边说的场景。

### 二、F9 全局热键（推荐）

**按住 F9 说话，松开识别。** 这个能在别的程序前面用——游戏里、浏览器里都行，不要求 WhaleLife 页面在前台。

它是个独立的小进程（`f9/hold_to_talk.py`），不是插件的一部分，因为网页抓不到系统级按键。页面上有「启动/停止」按钮。

三点注意：

- **F9 是被独占的。** 启动期间游戏里也按不了 F9，别的程序也用不了。不想用了记得停掉
- 按下和松开各有一声轻提示，可以关
- F9 进程挂了不影响页面听写，两条路是分开的

## 页面

`/plugins/ear/`，两页：

- **耳朵** —— 上面那些字段、开始/停止听、录音测试、F9 启停、状态
- **嗓子** —— 装没装嗓子（工具名还是 `mouth_say`）、`speak_reply` 那个开关。没装时这几格是灰的

## 工具

| 工具 | 说明 |
|---|---|
| `ear_start` | 拉起边车开始听 |
| `ear_stop` | 停掉，连模型一起收 |
| `ear_status` | 边车在不在、引擎就绪没有、已经转了几句 |

## 已知短板

- **模型是 CPU 跑的**（边车固定 `device="cpu"`）。不占显存，17 倍实时够用，但显卡空着没用上
- 一次只吃约 30 秒音频，超了静默截断，不报错。实时听写靠 VAD 自然分段碰不到；要转长音频得自己先切
- 识别错字有两类：听错（同音字）和听懂错（术语）。热词能救前一半，后一半只能靠上下文
- 要求 Windows + 有麦克风，只在本人机器上验过
- F9 在全屏游戏里没实测过

## 许可

MIT，见仓库根目录 LICENSE。
