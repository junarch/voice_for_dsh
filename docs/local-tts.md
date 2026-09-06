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
# 在仓库根目录执行：建 venv → 装依赖 → 下载模型（约 350MB）→ 打印启动命令
pwsh scripts/setup-local-tts.ps1
# 可选轻量版（169MB，fp16，音质几乎无差）：pwsh scripts/setup-local-tts.ps1 -Variant fp16

# 启动服务（保持窗口开着；首次加载模型需数秒）
local\venv\Scripts\python.exe scripts\local-tts-server.py
# 自检：浏览器打开 http://127.0.0.1:8880/health 返回 {"ok":true} 即就绪
```

然后在 dsh 设置页 → 语音播报 → 播报引擎选"本地 Kokoro（英文）"即可。
自动播报无需任何成本开关（local 免费，不受豆包的 `autoSpeakCloudTts` 成本门控）。

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
{ "model": "kokoro", "input": "spoken transcript text", "voice": "af_heart", "speed": 1.0, "response_format": "wav" }
```

响应：完整 WAV 音频（`audio/wav`，PCM 16bit @24kHz mono）。插件侧配置
（`voice.tts.local`）：`baseUrl` / `voice` / `speed` / `timeoutMs`，见 `docs/pipeline.md` §6。

该协议与 OpenAI TTS API 兼容（子集），**现成服务可直接替换**本仓库 server 脚本，例如
[remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)（Docker，默认端口同为 8880，
`response_format: wav`）。只要端点接受 `input/voice/speed` 并返回 WAV 字节即可。

## 5. 系统要求与故障排查

- Python 3.10–3.12（`python --version`）；Windows 需已装 [Python 官方包](https://www.python.org/downloads/)并勾选"Add to PATH"。
- 内存：加载模型后约 600MB；CPU 空闲时占用接近 0（合成期间才吃满一核）。
- 常见问题：
  - **设置页提示"local tts 服务不可达"** → 服务窗口没开，或端口被占用（`baseUrl` 改成实际端口）。
  - **首次合成很慢** → 模型加载 + 首次推理预热，属正常；之后每段为实时速。
  - **长文等待久** → 整段合成限制（`docs/pipeline.md` §4.3 已知限制），可先在转写设置换"陪伴/俏皮"风格缩短文稿。
