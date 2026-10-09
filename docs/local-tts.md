# 本地英文 TTS（Kokoro-82M v1.0）部署与对接

> 目标：在 `http://127.0.0.1:8880` 起一个 OpenAI 兼容的本地合成服务，插件 `voice.tts.provider=local`
> 时把英文转写稿交给它合成（免费、离线、数据不出本机）。中文播报仍可用豆包云 TTS，两者并存。

## 1. 为什么选 Kokoro-82M v1.0

- 小模型里英文质量第一（TTS Arena 榜首档），26 个英文音色，语速自然。
- ONNX 推理 CPU 实时（约等于或快于语音时长），无需 GPU。
- 协议 Apache-2.0，模型可自由分发使用。
- 对比：MeloTTS 英文偏机器感；Piper 质量明显低一档；CosyVoice 3 / IndexTTS2 / Qwen3-TTS
  质量高但需 GPU + 数 GB 模型，不符合"占用性能不多"的要求。

## 2. 一键部署（Windows，推荐）

```powershell
# 在仓库根目录执行：建 venv → 装依赖 → 下载模型（约 350MB）
pwsh scripts/setup-local-tts.ps1
# 可选轻量版（169MB，fp16，音质几乎无差）：pwsh scripts/setup-local-tts.ps1 -Variant fp16
```

然后 dsh 设置页 → 语音播报 → 播报引擎选"本地 Kokoro（英文）"即可。
自动播报无需任何成本开关（local 免费，不受豆包的 `autoSpeakCloudTts` 成本门控）。

### 2.1 服务的启动与生命周期（默认交给 dsh）

**无需手动启动服务。** `voice.tts.local.autoStart`（默认 `true`）开启时，Host 在每次本地合成前先探
`GET <baseUrl 的 origin>/health`：

- 已在跑 → 直接复用，不再拉起第二个实例；
- 没在跑 → 经 `ctx.subprocess` 拉起 `scripts/local-tts-server.py`，轮询 `/health` 直到就绪（模型加载约 3–5s）；
- **dsh 退出时该子进程被一并回收**（受管子进程范围，正常卸载与宿主退出两个阶段都会终止），不留孤儿；
- 失败分类可见：服务不可达 → `ttsErrorKind=unavailable`，合成超时 → `timeout`，服务返回错误 → `http`；
  客户端 toast 按分类给文案，`unavailable` 附带部署文档指引。

设置页 local 区块提供「自动启动本地服务」开关与「🔌 本地服务自检」按钮（只读探测，不拉起服务）。

**何时需要手动启动**：关掉 `autoStart`、要用非本仓库脚本的服务、或想在不启动 dsh 时先跑起来测试。

### 2.2 手动启动（可选/排查用）

```powershell
# 启动服务（保持窗口开着；首次加载模型需数秒）
local\venv\Scripts\python.exe scripts\local-tts-server.py
# 自检：浏览器打开 http://127.0.0.1:8880/health 返回 {"ok":true} 即就绪
```

也可直接双击 `scripts/start-local-tts.bat`（等价，省去记命令；服务退出时窗口不会立刻消失，便于看报错）。

手动启动的服务是**独立常驻进程**：dsh 重启不影响它，关掉窗口/关机才停。此时 `autoStart` 的探针会命中，
不会重复拉起。**不要**在 dsh 会话内用 `Start-Process`、`Start-Job`、后台任务拉起——那些实例会随会话结束被回收，
要用就开一个独立终端窗口；需要常驻可交给登录自启/计划任务，或改用同协议的现成服务（如
[remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) 的 Docker 容器，支持 auto-restart）。

## 3. 模型文件（货物不入库）

| 文件 | 大小 | 来源（Apache-2.0 / MIT） |
|---|---|---|
| `local/models/kokoro-v1.0.onnx` | 325MB | [kokoro-onnx release model-files-v1.0](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) |
| `local/models/voices-v1.0.bin` | 27MB | 同上（26 个音色风格向量） |
| `local/venv/` | — | Python 虚拟环境（kokoro-onnx 0.4.x + fastapi + uvicorn） |

- `local/` 已在 `.gitignore` 排除——git 仓库只存"清单和方法"（AGENTS.md 依赖管理约定）。
- espeak-ng 音素数据由 `espeakng-loader` 包内置，无需单独下载。
- fp16/int8 量化版同地址可选（169MB/88MB），CPU 无 GPU 时 int8 提速明显、音质略降。

## 4. 对接协议（插件 ↔ 本地服务）

`POST /v1/audio/speech`，JSON 请求：

```json
{ "model": "kokoro", "input": "spoken transcript text", "voice": "af_heart", "speed": 1.0, "response_format": "pcm16" }
```

响应按 `response_format` 分两种（都带 `X-Sample-Rate` 响应头，采样率唯一事实源）：

| response_format | 响应体 | 用途 |
|---|---|---|
| `pcm16` | **裸 PCM**（16bit 小端 mono，无容器头，`audio/pcm`） | 分句流式（默认）：客户端 Int16→Float32 直接建 AudioBuffer，零解码延迟 |
| `wav`（缺省） | 完整 WAV 容器（`audio/wav`） | 整段合成（`streaming:false`）与首段失败后的兜底 |

### 4.1 分句流式（为什么一句一请求）

本地 Kokoro 是"整段算完才出声"：3606 字符的稿子整段合成要 40s（且会撞整段超时）。插件的做法是
**按句切成 ~220 字符的段、逐段请求**，首段算完即可播放。实测（本机 CPU，`af_sarah`）：

| 稿长 3606 字符 | 段数 | 首段 | 首声延迟 | 全部合成 | 音频总长 |
|---|---|---|---|---|---|
| 整段合成（旧） | 1 | 3606 字符 | 40.1s（>30s 超时 → 失败） | 40.1s | 35s |
| 分句流式（现） | 12 | ~240 字符 | **2.5s** | ~43s | ~220s |

"总合成时间更长"不影响听感：合成速度（约 5 倍实时）始终快于播放，播放不会断粮。
复现手段：`node scripts/local-autostart-probe.mjs --stream`（真实拉起 + 真实切分 + 真实合成计时）。

插件侧配置（`voice.tts.local`）：`baseUrl` / `voice` / `speed` / `timeoutMs` / `autoStart` / `pythonPath` /
`streaming` / `segmentChars` / `segmentTimeoutMs`，见 `docs/pipeline.md` §6。
健康端点 `GET /health` 由 Host 用于"复用或拉起"的判定。

该协议与 OpenAI TTS API 兼容（子集，`wav` 形态），**现成服务可直接替换**本仓库 server 脚本，例如
[remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)（Docker，默认端口同为 8880，
`response_format: wav`）。只要端点接受 `input/voice/speed` 并返回 WAV 字节即可；
**若对方不认 `pcm16`（返回 4xx/5xx），插件首段失败后会自动降级整段 WAV**，功能不丢、只是等待变长。

## 5. 系统要求与故障排查

- Python 3.10–3.12（`python --version`）；Windows 需已装 [Python 官方包](https://www.python.org/downloads/)并勾选"Add to PATH"。
- 内存：加载模型后约 600MB；CPU 空闲时占用接近 0（合成期间才吃满一核）。
- 常见问题：
  - **toast 提示"本地 TTS 服务不可达"** → 自动启动没成功：没部署（按提示跑 `setup-local-tts.ps1`）、
    `autoStart` 被关、端口被别的程序占用，或 dsh 的 `ctx.subprocess` 不可用（罕见，`/voice/api/localStatus` 可见
    `subprocessAvailable`）。设置页「🔌 本地服务自检」会显示具体原因与运行环境路径。
  - **toast 提示"合成失败（服务返回错误）"** → 服务在跑但合成报错（如 `synth` 500），看服务窗口输出或
    `/voice/api/localStatus`；常见根因见下一条。
  - **报错含 `local tts http 500 ... Permission denied: ...\Temp\dsh-*\tmp*\espeak-ng.dll`**
    → 服务是从受限文件沙箱环境（如 dsh 会话里的 shell）启动的：espeak 后端每建一个实例都要在系统临时目录
    下新建子目录并复制 `espeak-ng.dll`，沙箱不允许写该子目录，合成因此 500。
    **正常路径（Host 自动启动）不受影响**，因为它不经过 shell 沙箱；若手动启动，请在普通 PowerShell 窗口跑，
    `local-tts-server.py` 也内置了兜底——系统临时目录不可写时自动改用仓库内 `local/tmp/`，
    并用普通 `mkdir` 替代 `tempfile.mkdtemp`。
  - **toast 提示"TTS 合成超时"** → 单个音频段在 `segmentTimeoutMs`（默认 30s）内没返回：
    服务卡死或机器极慢；把 `segmentTimeoutMs` 调大，或把 `segmentChars` 调小（段更短更快出）。
    注意流式路径不会因为"稿子长"而超时——超时只按段算。
  - **首次合成很慢** → 模型加载 + 首次推理预热，属正常（自动启动也含这一步，约 3–5s）；之后每段为实时速。
  - **长文等待久** → 已由分句流式解决（首声 ~2.5s）；若仍偏慢，把 `segmentChars` 调小（如 150）。
