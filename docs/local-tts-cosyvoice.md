# 本地中文 TTS（Fun-CosyVoice3-0.5B）部署与对接

> 目标：在 `http://127.0.0.1:8882` 起一个 OpenAI 兼容的本地合成服务，作为 `voice.tts.provider=local`
> 之外的第二档本地引擎，专供**中文 + 情绪**播报（免费、离线、数据不出本机）。
> 英文播报仍走 Kokoro（`docs/local-tts.md`，端口 8880），豆包云 TTS 继续并存。

## 1. 为什么选 Fun-CosyVoice3-0.5B

- 阿里 FunAudioLLM 出品，Apache-2.0（代码与权重全放开，可自由分发/商用）。
- 0.5B 参数，本机 CPU 可跑；RL 版权重（`llm.rl.pt`）在 WER/CER/说话人相似度上
  是同尺寸里最好的（官方评测表，见 CosyVoice README）。
- `inference_instruct2` 支持**自然语言指令控制情绪**（"请用开心的语气说"），
  这正是本项目"情绪化、有质感"的选型目标；对比 IndexTTS-2（情感最强但非 OSI 许可、
  模型大），CosyVoice3 是许可最干净、部署最轻的情绪 TTS。
- 中文原生（另支持粤语/英/日/韩，日文需转片假名）。

## 2. 一键部署（Windows）

```powershell
pwsh scripts/setup-local-tts-cosyvoice.ps1
```

脚本做四件事（全部落在 `local/`，已在 .gitignore，不入库）：

| 产物 | 说明 |
|---|---|
| `local/venv-cosyvoice/` | Python 3.10-3.12 venv，torch 2.3.1 CPU 版 + CosyVoice requirements（~2.6GB） |
| `local/cosyvoice-src/` | QwenAudio/CosyVoice 源码 + `third_party/Matcha-TTS` 子模块（tarball 不含子模块，脚本用 git clone --recurse-submodules） |
| `local/cosyvoice-model/` | 模型 ~4.4GB（llm.pt=RL 版改名 / flow.pt / hift.pt / speech_tokenizer_v3.onnx / campplus.onnx / CosyVoice-BlankEN），ModelScope 国内源 |
| `scripts/local-tts-server-cosyvoice.py` | 合成服务（仓库内已提交） |

已知坑（脚本已处理，记录备查）：
- **tuna 镜像查不到 torch 2.3.1**（索引不完整）→ 用阿里云镜像。
- **openai-whisper 是旧 sdist**，uv/pip 构建隔离下缺 pkg_resources → `--no-build-isolation`；
  推理不需要它，但 `cosyvoice/cli/frontend.py` 顶层 import 了它，必须装。
- **MPLCONFIGDIR**：受限文件沙箱下 `~/.matplotlib` 不可写（matplotlib 缓存锁
  PermissionError）→ 服务脚本启动时把缓存指到 `local/tmp/matplotlib`。
- **`<|endofprompt|>` 断言**：CosyVoice3 的 LLM 强制要求输入含该标记（token 151646，
  需 `allowed_special='all'` 才会被编码成特化 token）。注册音色的 prompt 文本必须带
  `"You are a helpful assistant.<|endofprompt|>"` 前缀；服务启动时会对缺标记的旧注册
  自动重注册（本仓库早期版本曾用不带前缀的文本注册过）。

## 3. 启动与自检

```powershell
local\venv-cosyvoice\Scripts\python.exe scripts\local-tts-server-cosyvoice.py
# 默认 127.0.0.1:8882；--port 可改
# 自检：http://127.0.0.1:8882/health → {"ok":true,"model":"fun-cosyvoice3","speakers":["dsh_default"]}
```

- 模型加载约 10-60s（CPU，llm 2GB + flow 1.3GB）；加载完成前 `/health` 不响应（连接拒绝），
  调用方轮询即可。
- 启动时自动把仓库 `asset/zero_shot_prompt.wav` 注册为固定音色 `dsh_default`（写入
  `cosyvoice-model/spk2info.pt`）。

## 4. 对接协议（插件 ↔ 本服务）

与 Kokoro 服务（`docs/local-tts.md` §4）同一 OpenAI 兼容子集，多一个 `instruct` 扩展字段：

```json
POST /v1/audio/speech
{
  "model": "fun-cosyvoice3",
  "input": "今天天气不错，我们去公园散步吧。",
  "voice": "dsh_default",
  "speed": 1.0,
  "response_format": "wav",        // wav（整段）| pcm16（裸 PCM 流式）
  "instruct": "请用开心的语气说"    // 可选：情绪/风格自然语言指令
}
```

| 字段 | 行为 |
|---|---|
| `instruct`（扩展） | 非空 → `inference_instruct2`（情绪可控）；空 → `inference_zero_shot`（默认腔）。前缀自动拼 `"You are a helpful assistant. "`，后缀 `"<|endofprompt|>"` |
| `voice` | 只认注册过的音色名，默认 `dsh_default`；未知音色返回 400 |
| `speed` | 0.5-2.0，透传给模型原生语速参数 |
| `response_format=pcm16` | 裸 PCM（16bit 小端 mono）+ 流式分块返回（模型边生成边推），`X-Sample-Rate=24000` |
| `response_format=wav` | 完整 WAV 容器（24kHz mono 16bit），整段算完返回 |

`GET /health` → `{"ok":true,"model":"fun-cosyvoice3","speakers":[...]}`。

**断连即停**：推理是 async 生成器，每产出一块前后检查 `request.is_disconnected()`。客户端超时/点停止
只断 HTTP 时，推理会在下一个检查点退出并释放推理锁——不会留下"客户端早就放弃、CPU 却继续烧十几分钟"
的孤儿任务（那种孤儿会把后续所有请求堵在推理锁上，症状是"点了没声音、CPU 一直满载"）。

## 5. 性能实测与优化（本机 CPU，无独显可用）

**先看清时间花在哪**：这个模型虽然叫"0.5B"，但 0.5B 只是自回归 LLM 那一段；装机权重 4.2GB、
至少四个网络（AR-LLM 0.5B / flow 流匹配 DiT dim1024×22 层 / 语音 tokenizer 25 帧每秒 / HiFiGAN 声码器），
且生成是**两段串联迭代**：AR-LLM 每秒音频解 25 步 → flow 每个 chunk 走 10 步 ODE（每步含 CFG 两次前向）
→ 声码器。对比 Kokoro 是"82M 一次前向出整段波形"，所以参数量小 ≠ 快。

分段实测（同一句 46 字，torch 8 线程，stream=True，音频 8.4-8.8s）：

| 配置 | 墙钟 | RTF | 首声 | AR-LLM | flow | 声码器 |
|---|---|---|---|---|---|---|
| 源码默认（flow 10 步） | 40.1s | 4.56 | 21.4s | 18.7s | 30.2s | 1.8s |
| flow 4 步 | 32.0s | 3.63 | 13.9s | 16.0s | 19.6s | 3.3s |
| flow 3 步 | 25.1s | 2.86 | 11.5s | 13.6s | 13.5s | 3.1s |
| flow 2 步 | 20.2s | 2.39 | 4.7s | 12.3s | 9.1s | 3.0s |
| flow DiT 走 int8 动态量化 | 24.9s | 2.95 | 6.0s | 14.7s | 15.8s | 3.1s |
| LLM 走 int8 动态量化 | 39.2s | 3.09 | 4.6s | 42.2s | 52.2s | 9.3s |

结论：**flow 是关键路径**（LLM 跑在并行线程里被它盖住）；AR-LLM 与 flow 抢同一批核时互相拖累。
LLM int8 动态量化**被否决**——虽然每步更快，但输出时长从 8.8s 变成 12.7s（韵律/内容被改变），
整体反而更慢。

三条真正有效的优化（已固化进服务默认值）：

1. **flow 步数 10 → 4**（`--flow-steps`，请求体 `flow_steps` 可覆盖）：flow 时间约减半。
2. **flow 估计器换官方 fp32 ONNX + onnxruntime(CPU)**（`local/onnx/flow.decoder.estimator.fp32.onnx`，
   服务启动时自动探测，`--no-ort` 可关）：单次前向 **502ms → 280ms（1.8x）**。
   等价性实测：同一输入下与 PyTorch 输出的相关系数 **1.000000**（max|Δ|=0.012，fp32 核序差异）。
   注意 ONNX 里没有 cache 输入（cache 由 `CausalConditionalCFM` 在外层处理），流式/整段两条路径通用；
   接进 `flow.decoder.estimator` 时必须让包装对象**继承 `nn.Module`**——否则
   `CausalConditionalCFM.forward_estimator` 的 `isinstance(..., nn.Module)` 分流会把它当成 TensorRT 包装器。
3. **线程预算分离**：torch 只留给 AR-LLM/声码器（默认 10 线程），flow 交给 onnxruntime 自己的线程池
   （默认 6 线程）。两者不再抢核：同线程预算下 ORT 让首声 12.3s → 5.0s。

合并效果（服务端实测，同一句 46 字，`--flow-steps 4`）：

| | RTF | 首声（合成侧） |
|---|---|---|
| 优化前（源码默认 + PyTorch） | 4.56-6.6 | 21.4s |
| 优化后（4 步 + ONNX + 分核） | **2.2-3.0** | **5-12s** |

**"流式多久能听到声音"**：合成侧首块 **5-12 秒**（2 步最快、4 步约 10 秒；同一配置跨轮波动受其他进程抢核影响）。
插件端到端还要加**口语化转写**（DeepSeek 一次调用，经验区间 10-20 秒，随原文长度变化），
所以端到端首声约 **20-30 秒**；此后 Host 按 ~0.5s 音频边收边入队，播放会持续跟上（合成比播放慢，
长稿仍会出现"播完一段等下一段"，见 §6 的长度建议）。

调参命令示例：

```powershell
# 默认档（4 步 + ONNX + torch10/ort6）
local\venv-cosyvoice\Scripts\python.exe scripts\local-tts-server-cosyvoice.py
# 极速档（音质有损）
... --flow-steps 2 --torch-threads 10 --ort-threads 6
# 纯 PyTorch 对照（排查 ONNX 问题）
... --no-ort
```

设置页「语音播报 → 本地 CosyVoice → 合成质量/速度」对应 `voice.tts.localCosyvoice.flowSteps`（默认 4）。

仍未利用的提速路径：社区 [llama.cpp/GGUF 后端 PR #1872](https://github.com/QwenAudio/CosyVoice/pull/1872)
（未合并，报告 2.6x 是 T4 GPU 数字）可把 AR-LLM 换成量化 GGUF；flow 步数再降会明显伤音质；
再往上就是换 NVIDIA 卡（RTF 0.2-0.5）。

## 6. 接进 dsh 插件（已实现）

插件侧已完成集成（provider = `local-cosyvoice`），设置页「语音播报」→ 播报引擎选
**"本地 CosyVoice（中文·免费）"** 即启用：

| 配置项 | 说明 |
|---|---|
| 服务地址 baseUrl | 默认 `http://127.0.0.1:8882/v1/audio/speech` |
| 音色 voice | 默认 `dsh_default`（服务启动时自动注册）；下拉 + 自定义 |
| 语速 speed | 0.5-2.0 滑块 |
| 内容驱动情绪 | 开=播报前用 LLM 分析内容情绪，生成情绪指令（如"语气轻快活泼一点，情绪明显一些"）；结果随转写稿缓存，重播零额外 LLM |
| 固定情绪指令 | 内容驱动关闭/生成失败时的兜底指令（如"用温柔的语气说"）；优先级：稿内 `[#指令]` > LLM 生成 > 固定指令 > 风格预设 |
| 自动启动本地服务 | 默认开：播报前 dsh 自动拉起服务（`ctx.subprocess` 托管，dsh 退出即回收），首次加载模型约 10-60s（就绪时限 180s）；关掉需手动 `start-local-tts-cosyvoice.bat` |
| 分句流式播报 | 默认开：按句切段（默认 120 字符/段，首段目标 40 字）逐段请求裸 PCM；**边收边按 ~0.5s 音频切块入队**，首声只需等"服务端第一个分块"（约 20-25s），不必等整段算完；段超时 120s（按无数据间隔计）。关=整段合成 |
| 🔌 本地服务自检 | 只读探测（`/voice/api/cosyvoiceStatus`），显示服务与部署状态 |

与 Kokoro（`local`）的差异（插件内已按引擎分派）：

- **转写不强制英文**：中文回复转写为中文口播稿（`resolvePrompt` 对 local-cosyvoice 不加英文不变式）；
  转写关闭时中文原文直读也能合成（Kokoro 此时会回退系统 TTS 并提示）。
- **情绪指令**：复用豆包那条内容驱动管线（LLM 三行输出），经 `instruct` 扩展字段下发；
  Kokoro 无此通道（零额外 LLM）。**`instruct` 会让同一段慢约 45%**，长稿建议关闭。
- **托管参数**：`local-supervisor.js` 按 engine 分派脚本（`local-tts-server-cosyvoice.py`）、
  venv（`venv-cosyvoice`）、端口（8882）、就绪时限（180s）；`voice.tts.localCosyvoice.pythonPath`
  可覆盖解释器路径。
- **免费门控**：与 Kokoro 一致，`autoSpeakCloudTts` 不拦（本地引擎免费）。

性能提醒：CPU 上 RTF≈4-8（1 秒语音需 4-8 秒合成）——**合成比播放慢数倍，所以长稿必然是
"出声 → 停顿 → 再出声"**（播放器把已合成的一段播完就得等下一段）。首声约 20-25s（首个分块），
但整篇 1200 字要 20-30 分钟 CPU 才合成完。想提速换 NVIDIA 卡（RTF 可到 0.2-0.5）
或等社区 [llama.cpp/GGUF 后端 PR #1872](https://github.com/QwenAudio/CosyVoice/pull/1872) 合并。

## 7. 排障："点了没声音、CPU 一直满载"

按顺序查三件事（前两条是历史故障根因）：

1. **服务端是否留下了占锁的孤儿任务**：客户端超时/点停止/重复点击后，服务端必须立刻停止合成。
   在服务日志里应看到 `客户端已断开，中止本次合成`；若看到 `推理锁被占用，本次请求排队等待`
   紧跟着长时间无输出，就是有请求在排队（正常应只持续一个分块的时间）。
   定位手段：`node scripts/local-tts-cancel-probe.mjs`（中止 + 取消后立刻再请求，量首块延迟与总耗时）。
2. **Host 是否真的边收边入队**：`scripts/test-host.mjs` 的断言
   "边收边入队：音频分块数 > 段请求数（0.5s 粒度切块）"就是防这条退化。
3. **浏览器是否真的排上了播放**：`curl` → `POST /voice/api/clientDiagDump` 读回客户端上报的
   播放链路事件（`stream-start` 带 AudioContext 状态 / `seg-decoded` / `stream-end` 的 `played` 段数）。
   `ctx: "suspended"` 或 `played: 0` 说明是浏览器侧没出声，与合成快慢无关。
