# 语音转写与 TTS 播报管线（voice pipeline）

> 本文描述**当前实现**的语音播报管线：一轮 DeepSeek 输出结束后，先口语化转写，再交给 TTS 播报。
> 源码：`packages/dsh-plugin-voice/lib/index.js`（Host 半，主实现）、
> `lib/volcengine-ws.js`（豆包双向流 WS 客户端）、`lib/speech-clean.js`（净化）、
> `lib/voice-compat.js`（音色↔语种归一）、`lib/local-supervisor.js`（本地服务托管）、
> `lib/client.js`（Client 半）。

## 核心原则

**播报文稿 ≠ 输出原文。** 原文里的代码、表格、Markdown、URL、JSON、diff 不适合朗读，
由 LLM 转写为自然口语文稿后再交给 TTS；转写关闭时输出什么读什么（仅去 Markdown、跳过表格代码）。

## 1. 管线总览

```
[assistant/message 文本块]                          (每轮最终消息的 text 块拼接)
   → Host 转写：ctx.llm.prepareCall + stream（独立辅助调用，不入会话历史）
        └ 输出：口语文稿（纯文本）
   → 语音演绎指令 + 情感 + 强度（内容驱动，LLM 三行输出；豆包走 context_texts、CosyVoice 走 instruct）
   → TTS：browser(客户端 speechSynthesis) | volcengine(双向流 WS 默认 / HTTP 单向兜底)
        | local(本地 Kokoro，OpenAI 兼容 /v1/audio/speech，英文播报)
        | local-cosyvoice(本地 Fun-CosyVoice3，同协议，中文播报 + 情绪指令)
        └ local 合成：ensure 服务（探 /health → 已在跑则复用，否则经 ctx.subprocess 拉起）
                      → 分句切段（splitForStream）→ 逐段 pcm16 合成 → 边收边按 ~0.5s 音频切块入队
   → 音频：/voice/audio/<id> 一次性路由 → 客户端 <audio>/Web Audio 播报
```

转写、指令、TTS 都走缓存（按 messageId）：

- 同一消息重复"朗读" → 转写 + 指令都用缓存，零新增 LLM；
- 1h 内重播 → 豆包服务端缓存命中，免重合成、不重复计费（仅参数指纹未变）。

## 2. 转写（Transcription）

### 2.1 触发与输入

- **手动**：每条消息的"朗读"按钮（`conversation.chat.assistant-actions` 槽），对当条消息转写。
- **自动**：`voice.autoSpeak=true` 时在 `turn/end`（`reason.kind ∈ completed|max-tokens`）触发；
  豆包（付费）自动播报还需 `autoSpeakCloudTts=true`（成本门控）；本地引擎（Kokoro/CosyVoice）免费，不受门控。
- **输入**：`assistant/message` 的 `text` 块拼接（`message.content` 中 `type:'text'`）。
- **取文路径**：Host `extractText` 从 `ctx.sessions.get(sessionId).snapshotEvents()` 按 messageId 定位。

### 2.2 系统提示词（风格预设）

三档 + custom（`voice.transcribe.stylePreset`）：

- `standard` 标准：基线 `TRANSCRIBE_SYSTEM`，听感优先——结论为主、细节概括。
- `companion` 陪伴：基线 + "温柔陪伴者"人设——捕捉用户情绪、允许摘要简写、保留关键信息。
- `playful` 俏皮：基线 + "幽默开发搭子"人设——摘要 + 俏皮话。
- `custom`：用 `voice.transcribe.prompt`。

取舍总原则（`TRANSCRIBE_SYSTEM` 开头，优先级最高）：**听众只用耳朵、只听一遍、无法回看**。
判断一条内容读不读，不看"原文写了什么"，而看"听完这句，听众能否听懂全局并知道下一步"。
凡是要靠眼睛对照才有意义的内容（精确数值、哈希/序列号/ID、版本号、逐项参数对比、表格里的成对数字）
一律不逐个读出，用一句定性概括代替；数字只有在它本身就是结论或需要据此行动时才读，
只保留必要的量级或比较。其余规则要点：代码块/表格 → 一两句概括作用与结论（单元格数值不读）；
列表 → 挑要点用"第一/第二"；URL → 只说"给了一个链接"；剥 Markdown/代码/JSON 花括号；
保留结论/建议/下一步/承载结论的关键数字；输出纯文本无任何标记；不准编造。

附加：`voice.language` 固定语种/方言时，`resolvePrompt` 追加"必须用 X 输出"（仅豆包 TTS 生效）。

**local provider 英文不变式**：`tts.provider=local` 时转写稿**固定用英文口语输出**
（无论原文语言，`resolvePrompt` 追加"必须用 English 输出"）——local 定位为"英文播报"引擎
（中文内容转写为地道英文口语后由 Kokoro-82M 朗读，帮助理解、缓解长文阅读疲劳）；
`voice.language` 的音色↔语种联动仍只作用于豆包（见 §4.2），对 local 无效。

### 2.3 请求参数

- `provider/model`：`voice.provider`/`voice.model`（空 = 启动发现可用路由；配置路由失败自动回退发现并自愈写回 settings）。
- `maxTokens`：`voice.transcribe.maxTokens`（默认 8192，设置页无 UI）。推理模型（如 deepseek-v4-flash）先烧 reasoning token；撞顶且空稿自动按 4 倍额度重试一次。
- `temperature`：`voice.transcribe.temperature`（默认 0.3）。
- `reasoningEffort`：`voice.transcribe.reasoningEffort`（默认 off）。抽象档位跨 provider 词汇不同，模型不支持时按 `EFFORT_FALLBACK` 降级到语义最近档；非推理模型忽略；降级对用户可见（`effortMapped`/`effortNote`）。
- 超时：`voice.transcribe.timeoutMs`（默认 60s）。

### 2.4 引用上文

`voice.transcribe.contextTurns`（默认 2）：转写时携带最近 N 轮的用户输入 + 已播报文稿，
标注"仅供参考，不要转写这部分"（`buildContext`），帮模型把握语境/情绪/术语一致；0 = 关闭。
**只在 LLM 输入侧产生 token 开销，不影响 TTS 字符数。**

### 2.5 缓存（转写稿）

- 键：messageId。命中条件：provider/model/prompt/effort 四者与当前配置完全一致（`cachedTranscriptFor`）。
- 落盘：`$DSH_HOME\voice-transcript-cache.json`，重启不丢，上限 200 条（先进先出截断）。
- 缓存形状：`{ transcript(净化稿), provider, model, prompt, effort, sourceChars, at, instruction, emotion, intensity, ttsFp, segments }`。HTTP 与双向流共用同一形状，可互读。
- 文件损坏按空缓存起步。

### 2.6 降级直读

转写抛错 / 超时 / 撞顶重试后仍空稿 → `toPlainSpoken`（`sanitizeForSpeech`，`lib/speech-clean.js`：
代码块/表格整块跳过、URL→「链接+域名」、剥 Markdown/装饰/表情，保留中文标点与数字%）。
降级稿**不写缓存**（下次仍重试转写），响应带 `degraded:true`，Client 提示后照常播报。

## 3. 语音演绎指令与情感（context_texts 通道）

> 2.0 的情感通道是 `additions.context_texts`（自然语言语音指令）：所有豆包语音合成模型 2.0 音色生效、
> **不计费、仅第一个值有效**。1.0 的 `emotion`/`emotion_scale` 数值参数已淘汰，本插件不发送。

### 3.1 优先级（`buildVoiceInstruction`）

用户自定义 prompt 里显式写的 `[#指令]`（`extractedCmd`，明确意图）> 内容驱动生成的指令（主通道）> 预设机械指令（`STYLE_PRESETS.*.instruct`，兜底）。

### 3.2 生成（内容驱动，LLM 三行输出）

转写后（仅云 TTS + 转写开启 + 非降级），用 `INSTRUCTION_EMOTION_SYSTEM` 调 LLM，
输入 = 口播文稿，输出严格三行：① 播报指令（8~25 字）② 情感标签（固定集合）③ 情绪强度 1~5。
maxTokens=256、温度 0.3、超时 15s（段落粒度 8s）。失败/超时/异常 → 返回空，调用方回退预设。

### 3.3 织入与动态粒度

- `composeContextText(instruction, emotionZh, intensity)` 把 ①+②+③ 织成一条自然语言指令
  （如"语气轻快活泼一点，语气开心一点，情绪明显一些"）→ context_texts。
- `emotionGranularity`：
  - `paragraph`（默认）：按段开新 session，每段用"段 N-1 的文本"并行生成（重叠零延迟）；
    段 0 用预设机械指令（零等待，增量直喂尽早出声）。
  - `message`：整条单 session 一次指令。
  - `off`：仅预设机械指令。
- 跳过场景（白花钱无收益）：browser TTS（speechSynthesis 不吃 context_texts）、转写关闭、降级直读稿。

## 4. TTS Provider 适配层

> 自研薄适配层（每 provider 一个文件），零第三方 TTS 适配器依赖
> （调研结论：无现成 JS 库支持火山 v3 接口，协议依官方《接入语音模型》文档实现）。

### 4.1 browser（零配置兜底，默认）

- 客户端 `speechSynthesis`：`speechSynthesis.speak(new SpeechSynthesisUtterance(text))`。
- `voice.tts.browser.{rate,pitch,voice}`；免费、离线；播放端在 Client 半。

### 4.2 volcengine（豆包语音合成模型 2.0）

主接口：**双向流 WebSocket**（默认）；HTTP 单向为内部兜底。

- 模型：`doubao-seed-tts-2.0`（`voice.tts.volcengine.resourceId`），头 `X-Api-Resource-Id: seed-tts-2.0`、`X-Api-Key`。
- **网关**（`voice.tts.volcengine.gateway`，默认 `plan`；协议与鉴权头一致，仅 URL 路径不同）：
  - `plan`（智能体套餐，默认）：双向流 `wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection`，
    HTTP 兜底 `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`（当前 Key 可用）。
  - `standard`（标准付费）：`wss://openspeech.bytedance.com/api/v3/tts/bidirection` +
    `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`——**需新版控制台 API Key**
    （[官方 V3 双向流文档](https://www.volcengine.com/docs/6561/1329505) 新版控制台鉴权同为 `X-Api-Key`；
    旧版控制台 `X-Api-App-Id`/`X-Api-Access-Key` 鉴权当前未实现）。
  - `custom`（自定义端点）：走 `voice.tts.volcengine.httpUrl`/`wsUrl` 指定端点（原样转发火山协议的端点，鉴权仍 `X-Api-Key`；须为 `https://`/`wss://`）。
- 端点解析统一在 `volcEndpoints(v)`（`lib/index.js`）；HTTP 兜底为 chunked JSON 行（`{code:0,data:base64}` 累加 + `code 20000000` 结束）。
- **协议（双向流）**：二进制帧——4 字节头 + event(int32 BE) + session_id + payload
  （事件 1 StartConnection / 100 StartSession / 200 TaskRequest / 102 FinishSession / 352 TTSResponse…）。
  一条连接多个**串行** session（不支持并行）；音频经 AudioOnlyServer 帧返回。实现 `lib/volcengine-ws.js`。
- **音频格式**：双向流 `pcm`（裸采样、任意字节切无缝、官方推荐流式用 pcm）；HTTP 单向 `mp3`
  （`bit_rate` 仅 mp3 生效）。pcm@24kHz/16bit。

#### 参数（`buildVolcReqParams`，session 级固定；改参数 = 开新 session）

- `audio_params`：`format`（pcm/mp3）、`sample_rate`、`speech_rate`（五档 `RATE_VALUES`）、`loudness_rate`。
- `additions`：
  - `context_texts`：情感/语气指令（织自 §3）。
  - `explicit_dialect`：方言（8 种，仅 vv 音色生效）。
  - `explicit_language`：仅固定英文下发（中文/方言不下发，避免与 explicit_dialect 冲突）。
  - `cache_config`：服务端缓存（见 §4.5）。
  - `section_id`：跨次合成语气连续（`voice.tts.volcengine.useSectionId`）。
  - `post_process.pitch`：音调（连续半音 -12~12，经 `pitchOf` 归一；旧五档 `pitchLevel` 兼容映射）。
- `req_params.model`：`voice.tts.volcengine.expressive=true` 时 `seed-tts-2.0-expressive`（表现力增强）。

#### 音色↔语种归一（`lib/voice-compat.js`）

不变式：方言 ⟺ vv；English ⟺ 英文音色；中文/auto 配中文音色。`getConfig`/`setConfig`/`speak`/`preview`
统一经 `normalizeVoiceConfig` 归一 → UI 显示 = 实际发声；设置页交互为"后改字段胜出"双向纠错。
（1.0 方言/多情感专属音色一律不接，本插件只适配 2.0。）

### 4.3 local / local-cosyvoice（本地 TTS：Kokoro 英文 / Fun-CosyVoice3 中文）

> 两个本地引擎共用同一套 OpenAI 兼容协议、同一个 supervisor 托管框架（按 engine 分派
> 脚本/venv/端口/就绪时限），共用"分句流式 + 段队列 + 失败分档 + 免费不受成本门控"。

#### 4.3.1 local（本地 Kokoro-82M v1.0，英文播报）

> 定位：免费、离线、数据不出本机的**英文**播报引擎。中文回复的转写稿先转写为英文口语
> （§2.2 英文不变式），再交本地服务合成。模型与协议选型依据（TTS Arena 小模型英文第一、
> CPU 实时、Apache-2.0）见 `docs/local-tts.md`。

- **接口**：OpenAI 兼容 `POST /v1/audio/speech`（JSON：`model`/`input`/`voice`/`speed`/
  `response_format`），端点默认 `http://127.0.0.1:8880/v1/audio/speech`（`voice.tts.local.baseUrl` 可改；
  允许 http——仅本机回环、无密钥，不适用豆包 custom 网关的 https 强制）。两种响应形态：
  - `response_format:'pcm16'` → **裸 PCM**（16bit 小端 mono，无容器头，`audio/pcm`）——分句流式的默认路径；
  - `response_format:'wav'`（缺省）→ 完整 WAV 容器（`audio/wav`）——整段合成路径。
  两者都带 `X-Sample-Rate` 响应头（采样率唯一事实源；缺头回落 24000）。
- **服务实现**：仓库自带 `scripts/local-tts-server.py`（Python + kokoro-onnx + FastAPI，
  ~120 行，零第三方 TTS 适配器依赖）；同样协议的现成服务（如 remsky/Kokoro-FastAPI，
  同端口 8880）可直接替换。**第三方服务若不认 `pcm16`，首段失败即自动降级整段 WAV**，不报死。
  部署见 `docs/local-tts.md`。
- **服务生命周期（Host 托管）**：`lib/local-supervisor.js` 在每次 local 合成前 ensure 服务——
  探 `GET <baseUrl origin>/health`（1.2s 超时）：通 → 复用；不通且 `voice.tts.local.autoStart`
  （默认开）→ 经 `ctx.subprocess` 拉起 `scripts/local-tts-server.py` 并轮询 `/health` 直到就绪
  （30s 上限），**该子进程归 dsh 托管，插件卸载与 dsh 退出时被回收**（不留孤儿、不撞端口）。
  解释器与脚本路径按插件真实位置（`realpathSync`，穿透 profile 的 junction）推导，
  `voice.tts.local.pythonPath` 可覆盖；`ctx.subprocess` 缺失时报"子进程服务不可用"而不抛错。
- **分句流式（默认开，`streaming`）**：这是 local 的主播报路径，解决"整段合成要等几十秒"的固有延迟。
  - 切分：`splitForStream(transcript, segmentChars)`（默认 220 字符）——从 target 处**向前**找第一个
    句末标点成段（句长不足则自然更长，不硬凑到 2×target）；窗口内无标点退化为找空白，再不行硬切；
    各段拼接与原文一致（只丢段间空白）。
  - 合成：逐段 `POST response_format:'pcm16'` → `storeAudio(buf,'audio/pcm')` → 入 `run.queue`
    （复用豆包那套段队列 + 客户端预取 3 段 + Web Audio lookahead 无缝播，客户端零新增代码）。
  - 超时语义：**单段停顿时限** `segmentTimeoutMs`（默认 30s，无数据即中止该段），不再是整段死线。
  - 实测（本机 CPU，`af_sarah`，3606 字符稿 → 12 段）：首段约 240 字符、~2.5s 就绪；
    全篇合成 ~43s 而音频总长 ~220s（合成快于播放，播放不断粮）。
  - 失败分档：首段失败 → 降级整段 WAV 兜底（用户仍能听到，warn 说明）；中途第 N 段失败 →
    保留已播段 + `warn` 记录"第 N/M 段起未播报" + 保留 `ttsErrorKind`；`streaming:false` → 直接整段合成。
- **失败分类（`ttsErrorKind`）**：`unavailable`（服务不可达/没部署/autoStart 关/子进程服务缺失）、
  `timeout`（段级或整段 abort 超时）、`http`（服务返回非 2xx 或空音频）；客户端按此选 toast 文案
  （`toast.ttsUnavailable` / `toast.ttsTimeout` / `toast.ttsHttp`，无 kind 时退回 `toast.fallback`）。
  豆包路径的非 2xx 与帧错误同样标 `http`，故该字段对所有 provider 都可用。
- **音频回传**：段或整段 Buffer 挂 `/voice/audio/<id>` 一次性路由（§4.4），客户端 PCM 直接建 AudioBuffer。
- **不走的通道**（与豆包的差异，全部省 LLM/复杂度）：
  - 无情感指令（context_texts 是豆包专属，§3 的 LLM 指令生成对 Kokoro 跳过）；
  - 无服务端缓存（§4.5 是豆包语义，本地合成零边际成本，重播直接重合成）；
  - 无 WS 双向流（豆包专属；本地引擎是"HTTP 分句流式"，见上）；
  - 不参与成本门控：`autoSpeakCloudTts` 只拦豆包（付费），本地免费，自动播报不拦。
- **已知限制**：分句流式的段长受句长影响（超长单句仍会拉长首段；把 `segmentChars` 调小可缓解）；
  单段 PCM 整段驻留内存（受 audioStore TTL/容量上限约束）；
  音色/语速等参数语义与豆包独立（`KOKORO_VOICES` 精选清单，不经 voice-compat 归一）。
- **不变式**：发给 local 的 text 同样不得含 `[#`（§7.1 的净化在 provider 之前，天然满足）。
- **转写关闭时的行为**：直读稿是原文（可能是中文），不送 local（英文模型硬读中文是乱音），
  回退客户端系统 TTS 朗读中文，响应带 `notice`（客户端 toast 提示"需开启转写"）；
  设置页选 local 且转写开关关闭时同步显示警告。

#### 4.3.2 local-cosyvoice（本地 Fun-CosyVoice3-0.5B，中文播报 + 情绪指令）

> 定位：免费、离线、数据不出本机的**中文**播报引擎，带内容驱动的情绪指令
> （阿里 FunAudioLLM，Apache-2.0，RL 版权重；选型与部署见 `docs/local-tts-cosyvoice.md`）。

- **接口**：与 Kokoro 同协议（OpenAI 兼容子集），多一个扩展字段 `instruct`（情绪/风格自然语言指令，
  非空走 `inference_instruct2`，空走 `inference_zero_shot`）；`model` 固定 `fun-cosyvoice3`；
  端点默认 `http://127.0.0.1:8882/v1/audio/speech`（`voice.tts.localCosyvoice.baseUrl`）。
- **服务实现**：仓库自带 `scripts/local-tts-server-cosyvoice.py`（Python + cosyvoice + FastAPI，
  CPU 推理）；服务启动时把仓库 `asset/zero_shot_prompt.wav` 注册为固定音色 `dsh_default`
  （注册文本必须带 `<|endofprompt|>`，服务启动时对缺标记的旧注册自动重注册）。
  部署：`pwsh scripts/setup-local-tts-cosyvoice.ps1`（venv-cosyvoice + 模型 ~4.4GB，见
  `docs/local-tts-cosyvoice.md`）。
- **服务生命周期**：同一 supervisor 框架，engine='local-cosyvoice' 分派
  `scripts/local-tts-server-cosyvoice.py` + `local/venv-cosyvoice` + 端口 8882；
  **就绪时限 180s**（CPU 冷启动加载 2GB+ 权重约 10-60s，远超 Kokoro 的 30s）。
- **转写语言**：**不套英文不变式**——转写稿跟随原文语言（中文回复 → 中文口播稿），
  `resolvePrompt` 对 local-cosyvoice 不追加英文要求；转写关闭时中文原文直读也能合成
  （区别于 Kokoro 的回退系统 TTS，这里恒走 Host 合成）。
- **情绪指令（instruct 通道）**：与豆包 §3 同一条内容驱动管线（LLM 三行输出），
  `voice.tts.localCosyvoice.emotionEnabled`（默认开）控制；优先级：
  稿内 `[#指令]` > LLM 生成（`composeContextText` 织入情感+强度）> 固定 `instruct` > 风格预设机械指令；
  结果随转写稿缓存（重播零 LLM）。流式路径为**消息级**生成一次指令、逐段透传（HTTP 逐段请求）。
- **分句流式**：与 Kokoro 同一套切分/入队/失败分档，但入队粒度是**边收边切**——服务端每推一块
  PCM 就按 ~0.5s 音频（`采样率×2×0.5` 字节）落一段入队，播放器不必等整段合成完（§7 不变式 14）。
  CPU 上 RTF≈4-8（1 秒语音需 4-8 秒合成），默认 `segmentChars: 120`、首段目标 40 字
  （`splitForStream` 的 firstChars）、`segmentTimeoutMs: 120000`（见 §6 schema）。
  首段失败降级整段、中途失败保留已播段——与 §7 不变式 13 一致。
- **客户端断开即停（不变式 15）**：服务端 `infer` 是 async 生成器，每产出一块前后检查
  `request.is_disconnected()`；客户端超时/点停止/重新点击后，推理在下一个检查点退出并释放推理锁。
  同步生成器 + `list(...)` 的写法做不到这点：abort 只断 HTTP，服务端会把整段（乃至整篇）算完
  并一直占着锁，后续请求全部排队超时——表现为"CPU 满载、一点声音都没有"。
- **试听/自检**：设置页 CosyVoice 区块有「🔌 本地服务自检」（`/voice/api/cosyvoiceStatus`，只读探测）；
  试听样例固定中文。

### 4.4 音频回传与播放

- Host 合成得音频 Buffer → `ctx.webServer` 临时路由 `/voice/audio/<id>`（一次性，取一次即删；audioStore）。
- 双向流：客户端轮询 `streamNext` 取段；pcm 段直接 Int16→Float32 建 AudioBuffer（同步无解码延迟），
  mp3 兜底段走 `decodeAudioData`；Web Audio lookahead 无缝调度 + 预取 ≤3 段；首段 16KB 尽早出声、后续 48KB。
  无 AudioContext / 被挂起 → 回退顺序 `<audio>`；首次交互预热 AudioContext。
- 缓存防膨胀：音频段只存内存、取一次即删；run 结束后 8s `disposeRun` 兜底清理未消费段。

### 4.5 服务端缓存 `cache_config`

- 背景：豆包 TTS 带 1h 服务端缓存（同文本）。重播 1h 内应免重合成、不重复计费。
- ⚠️ **只按文本、不认方言/音色/情感**（实测同文本换方言返回相同音频）→ 防串音唯一办法是"参数指纹未变才用"。
- 下发规则：**初次合成**（写入，供重播命中）✓；**重播**（命中，仅 `ttsFp` 指纹未变）✓；
  **试听 / 重新生成（regen）绝不下发**（防串音）。
- `ttsFp` = 音色/方言/语种/语速/音调/音量/表现力/采样率/比特率 指纹（`ttsFpOf`）。
- `serverCacheLedger`（文本→指纹+时间）防止"同文本换参数后 1h 内命中旧音频"——服务端缓存只按文本，
  换方言/音色会返回旧参数音频（串音）。
- 重播要命中须**逐段复现**初次会话（缓存键 = 会话整段文本）：初次合成把各段完整文本记入本地缓存
  `segments`，重播逐段喂同样文本 → 键一致 → 命中。

## 5. 播报状态机与并发

```
idle → transcribing(转写中) → speaking(播报中) → idle
         ↓ 失败/超时             ↓ 停止(用户/新turn)
     fallback(直读)或 error     → idle
```

- 全局单播：新播报打断当前播报；`voice.stopOnNewTurn`（turn/start 自增 `turnGeneration`，Client 发现 gen 变化停旧播报）。
- 双向流：`speak` 立即返回 `{mode:'stream', runId}`，管线后台跑；Client 经 `streamNext` 取段播放；
  失败/零音频自动降级 HTTP 整段（warn 提示）。
- 重播（缓存命中）：转写 + 指令全用缓存（零 LLM），段落照常切分但复用缓存指令；音频重合成但 1h 内走服务端缓存免费。
- 重新生成（↻）：转写 + 指令全部重新生成（force 跳过缓存），结果覆盖该 messageId 条目。
- 成本门控：设置页"播报引擎"选豆包时写入 `autoSpeakCloudTts=true`（= 用户显式选择付费 API），
  引擎为免费引擎（browser/local）时该开关为 false 且豆包不参与自动播报（全免费，含手动按钮）；
  settings.yaml 直改的旧配置若 `autoSpeakCloudTts=false`，豆包自动播报仍被拦截（防手工配置烧钱），
  手动按钮与 local（免费）不受限。

## 6. `voice:` 配置 schema 定稿

> 字段见 `$DSH_HOME\settings.yaml` 的 `voice:` 块；
> schema 定义在 `index.js` `VoiceSettingsSchema`。所有字段带默认值 → 全新安装不带 voice 块也能跑
> （默认 browser TTS）。设置页（`settings.section id=voice`"语音播报"）只暴露常用项，
> 以下标注"（无 UI）"的字段**已从设置页隐藏**：schema 保留（向后兼容，老 settings 里的值仍生效）、
> 走固定默认值，仅需高级/内部逻辑时在 settings.yaml 直改。

```yaml
voice:
  autoSpeak: false            # 每轮结束自动播报
  autoSpeakCloudTts: false    # 成本门控：设置页切到豆包（volcengine）时同步写入 true；免费引擎（browser/local）为 false
  language: auto              # auto|zh|en|yue|shanghai|henan|beijing|tianjin|sichuan|shaanxi|dongbei
                              #   固定语种/方言时无论原文语言都按所选转写；8 方言统一走 vv + explicit_dialect
  provider: ""                # 转写 LLM provider（空=启动发现；配置错自动回退并自愈写回可用路由）
  model: deepseek-v4-flash
  transcribe:
    enabled: true             # 主开关：关=不调模型，直接读原文（去 Markdown/跳过表格代码）
    maxTokens: 8192           # 转写长度上限（设置页无 UI）；撞顶空稿自动按 4 倍额度重试一次
    temperature: 0.3
    prompt: ""                # stylePreset=custom 时生效
    reasoningEffort: off      # 固定 off（转写不开启思考，省 token）；旧值仍走降级链；设置页无 UI
    stylePreset: standard     # standard(标准) | companion(陪伴) | playful(俏皮) | custom
                              #   旧值 ambiguous/default/energetic 自动回退 standard
    contextTurns: 2           # 引用上文：固定 2 轮（最多往前读两轮）；设置页无 UI
    timeoutMs: 60000          # 单次转写超时；超时/失败降级为直读
  tts:
    provider: browser         # browser | volcengine | local | local-cosyvoice（存量旧值 openai-compatible 归一为 browser）
    browser: { rate: 1.0, pitch: 1.0, voice: "" }
    volcengine:
      apiKey: ""              # 火山方舟专属 API Key（settings.yaml 为明文，注意保管，别提交）
      resourceId: seed-tts-2.0
      speaker: zh_female_vv_uranus_bigtts  # Vivi 2.0；下拉另含 中文4男4女 + 英文3 + 自定义
      sampleRate: 24000       # 采样率（设置页无 UI：固定默认 24000，客户端/管线自适应；老值仍生效）
      rateLevel: 2            # 语速五档 0很慢–4很快
      pitch: 0                # 音调连续半音 [-12,12]，0=正常（步进 0.1 细粒度）
      pitchLevel: 2           # 音调五档（旧字段，仅供兼容；经 pitchOf 映射为 pitch；无 UI）
      interface: bidirection  # bidirection=WS 双向流（默认）| http=仅内部降级兜底（无 UI）
      streaming: true         # 双向流下启用"边转写边合成边播"（无 UI）
      gateway: plan           # plan=智能体套餐(默认) | standard=标准付费(新版控制台 Key, 同 X-Api-Key 格式) | custom=自定义端点
      httpUrl: ""             # 空=按 gateway 默认；gateway=custom 必填（火山协议端点，https://）
      wsUrl: ""               # 空=按 gateway 默认端点（无 UI，高级）
      emotionGranularity: paragraph  # paragraph(每段动态) | message(整条) | off(仅预设指令)（无 UI）
      bitRate: 64000          # MP3 比特率（仅 HTTP 单向生效；双向流 pcm 无此参数）（无 UI）
      loudness: 0             # 音量 [-50,100]
      useSectionId: true      # section_id（跨次合成语气连续）（无 UI）
      expressive: false       # req_params.model=seed-tts-2.0-expressive（表现力增强）（无 UI）
    local:
      baseUrl: http://127.0.0.1:8880/v1/audio/speech  # OpenAI 兼容端点（部署见 docs/local-tts.md；允许 http=仅本机回环无密钥）
      voice: af_heart          # Kokoro v1.0 音色（KOKORO_VOICES 精选清单）
      speed: 1.0               # 语速 [0.5, 2]
      timeoutMs: 30000         # 单次合成超时（整段合成路径/兜底）；失败 → ttsError(+ttsErrorKind)
      autoStart: true          # 合成前自动确保本地服务在跑（未跑则由 dsh 拉起，dsh 退出即回收）
      pythonPath: ""           # 解释器路径；空=按仓库 local/venv 自动推导（无 UI，高级）
      streaming: true          # 分句流式：按句切段逐段合成，首声约 2.5s（关=整段合成）
      segmentChars: 220        # 分句流式的每段目标字符数（无 UI，高级）
      segmentTimeoutMs: 30000  # 单个音频段的停顿时限（流式路径；替代整段死线）
    localCosyvoice:
      baseUrl: http://127.0.0.1:8882/v1/audio/speech  # OpenAI 兼容端点（部署见 docs/local-tts-cosyvoice.md；允许 http=仅本机回环无密钥）
      voice: dsh_default       # 服务启动时注册的固定音色（COSYVOICE_VOICES 精选清单 + 自定义）
      speed: 1.0               # 语速 [0.5, 2]（模型原生参数）
      sampleRate: 24000        # 服务输出采样率（客户端建 AudioBuffer 用；无 UI）
      timeoutMs: 120000        # 整段合成超时（CPU 上 RTF≈4-7，给足余量）
      autoStart: true          # 合成前自动确保本地服务在跑（dsh 拉起并回收）
      pythonPath: ""           # 解释器路径；空=按仓库 local/venv-cosyvoice 自动推导（无 UI，高级）
      streaming: true          # 分句流式：按句切段逐段合成（CPU 慢，段更短）
      segmentChars: 120        # 每段目标字符数（CPU 慢：~120 字符一段约 20-30s 合成；无 UI，高级）
      segmentTimeoutMs: 120000 # 单个音频段的停顿时限（流式路径；CPU 慢，默认已放宽）
      emotionEnabled: true     # 内容驱动情绪指令（LLM 生成 → instruct 通道；关=只用固定/预设指令）
      instruct: ""             # 固定情绪/风格指令（如"用温柔的语气说"；生成失败/关闭时兜底）
  stopOnNewTurn: true
```

### 6.1 配置演进约定（升级纪律）

用户本地 `settings.yaml` 是私有数据，**只补默认、绝不覆盖**。升级时按此纪律处理，防止"用户配置静默丢失 / 悄悄烧 token"：

1. **新字段必须带默认值**（老用户缺了就按默认走，零冲突、零报错）；
2. **改字段语义 / 删字段** → 必须加兼容层（读新名、读不到读旧名，如 `pitchOf` 的 `pitch`→`pitchLevel`）+ **升大版本** + CHANGELOG 顶部写"升级指引"；
3. **字段淘汰优先"UI 隐藏 + schema 保留"**（零风险、向后兼容）；确需真删才写迁移；
4. **兼容/归一逻辑集中在 `lib/voice-compat.js`**（`ttsProviderOf`/`pitchOf`/`normalizeVoiceConfig`），新增归一只往这里加；Client 半同步维护内联镜像。

## 7. 必须守住的不变式（regression 防线）

1. **发给 TTS 的 `text` 不得含 `[#`**——豆包接口不解析内嵌标签、会当正文照读（`extractVoiceTags` 提取剥离，进 `context_texts`）。
2. **只适配豆包语音合成模型 2.0**——不接 1.0 多情感/方言专属音色，不发 `emotion`/`emotion_scale` 数值参数。
3. **情感走 `context_texts`**（所有 2.0 音色生效、不计费、仅第一个值有效）。
4. **方言用 `explicit_dialect`** + vv 音色（voice-compat 不变式：方言⟺vv、English⟺英文音色、zh/auto⟺中文音色）。
5. **服务端缓存只认文本**——`cache_config` 仅当 `ttsFp` 指纹未变才下发；试听/重新生成绝不下发（防"永远四川口音"串音）。
6. **转写完整才写缓存**——WS 中途失败不污染缓存（否则降级命中坏稿、播不完整内容）。
7. **重播零 LLM**——转写 + 情感指令全用缓存（不重新生成）；重新生成（↻）= 全部重新生成。
8. **推理模型撞顶空稿自动按 4 倍额度重试**（先烧 reasoning token）。
9. **`/voice/api` 只接受同源请求**——`Origin` 的 host 与 `Host` 头一致才放行（CSRF 防护：
   付费调用/改配置不得被任意网页跨站触发）；无 `Origin` 的本地非浏览器调用放行。
10. **本地引擎语义分叉**——`local`（Kokoro）固定英文播报且零额外 LLM：转写稿必须英文输出
    （§2.2）、不生成情感指令、转写关闭时回退系统 TTS（带 notice）；
    `local-cosyvoice`（Fun-CosyVoice3）中文播报：转写跟随原文语言、`emotionEnabled` 时生成
    情绪指令走 instruct 通道、转写关闭时中文直读仍可合成；两者都不下发服务端缓存（§4.5 跳过）、
    不受 `autoSpeakCloudTts` 门控（免费引擎）。
11. **本地服务归 dsh 托管**——local 合成前必须先确保服务可用（探 /health → 复用或拉起）；
    拉起的子进程必须经 `ctx.subprocess`（受管范围，dsh 退出即回收），**不得用 shell 工具/后台任务拉起**
    （那些实例随会话被回收，会留"服务不可达"的坑）；`ctx.subprocess` 缺失时只报错，不绕道。
12. **失败必须可分类**——TTS 失败一律带 `ttsErrorKind`（unavailable/timeout/http），
    客户端据此给专用文案，不得让"服务没启动"与"合成失败"共用一句笼统提示。
13. **分句流式不得丢字、不得整条报错**——`splitForStream` 各段拼接必须与转写稿一致（只允许丢段间空白）；
    首段失败 → 降级整段兜底；中途失败 → 保留已播段 + warn 注明从第几段起缺失，绝不把"半篇已播"报成整条失败。
14. **本地分句流式必须边收边入队**——服务端返回的是流式 PCM，Host 收到一块就按 ~0.5s 音频切一段入队，
    **不得攒完整段再入队**（那等于把流式丢掉：首声从"首个分块"退化成"整段合成时长"）。
15. **本地服务必须能在客户端断开后停止合成**——`local-tts-server*.py` 的推理循环每块检查
    `request.is_disconnected()`，断连即退出并释放推理锁。否则被中止的请求会继续烧满 CPU 并长期占锁，
    把后续请求全部拖成超时（症状：点了没声音、CPU 一直满载、越点越没反应）。
16. **播放链路必须可观测**——客户端把播放各步（起播模式/AudioContext 状态/取段/解码/排程/结束）
    上报 Host（`/voice/api/clientDiag` → `clientDiagDump`）：慢引擎首声几十秒，
    "还没算完"与"解码失败/没排上播放"必须能区分，不能只靠耳朵判断。

## 8. 设计决策（为什么）

- 转写在 Host 用 `ctx.llm`（独立辅助调用、不入主历史）：复用已配 provider/凭据、不暴露 key、prompt 可控。
- 默认 TTS = 浏览器兜底：零配置、免费、离线。
- 云 TTS 走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传：`ctx.web` 仅 GET 抓取
  （不能 POST/鉴权头/二进制）；动态沙箱禁 fetch。
- 云 TTS 默认关闭（默认引擎 browser，全免费）；设置页切豆包 = 用户显式为付费 API 买单，
  自动播报才可能走豆包；settings.yaml 直改的旧配置仍由 `autoSpeakCloudTts` 门控防账单失控；
  local 免费引擎不在门控之列。
- 转写与播报分离；成品为正式 bundle（非创造模式动态插件）：动态插件进程内临时、重启丢失、沙箱禁 fetch。
- 自研 TTS 适配层（不引第三方库）：无现成 JS 库支持火山 v3；HTTP 单向协议极简（~150 行零依赖）；避免供应链与失维护风险。
- local 自带 server 脚本而非引 Node 依赖：kokoro-onnx 是 Python 生态，Host 半零新增 npm 依赖；
  仓库只存"方法"（server 脚本 + setup 脚本），模型/二进制不入库（AGENTS.md 依赖管理约定）。
- UI 只占 additive 小槽位（assistant-actions / input.left / turnTail / settings.section / shell.overlay），不碰 `root`/`conversation.session`。

## 9. 参考（源码位置）

- `index.js`：schema `VoiceSettingsSchema`；转写 `streamTranscription`/`transcribe`；
  指令 `generateVoiceInstruction`/`buildVoiceInstruction`/`composeContextText`；
  TTS `synthesizeVolcengine`/`buildVolcReqParams`；双向流 `streamSpeak`；
  服务端缓存 `serverCacheAllowed`/`serverCacheMark`/`ttsFpOf`。
- `volcengine-ws.js`：双向流协议（帧编解码 / 事件 / 连接管理器）。
- `local-supervisor.js`：本地服务托管——`resolveLaunch`（解释器/脚本路径推导）、`healthUrlOf`/`portOf`、
  `createLocalSupervisor`（`ensure` 复用或拉起 / `status` 只读自检 / `terminate` 回收）、`speakError`（带 kind 的错误）。
- `index.js` 的 `splitForStream`（导出，纯函数）：分句切段（§4.3），供 Host 流式与测试共用。
- 本地 TTS：`scripts/local-tts-server.py`（Kokoro 合成服务）、`scripts/local-tts-server-cosyvoice.py`
  （Fun-CosyVoice3 合成服务）、`scripts/setup-local-tts.ps1` / `scripts/setup-local-tts-cosyvoice.ps1`
  （部署脚本）、`scripts/start-local-tts.bat` / `scripts/start-local-tts-cosyvoice.bat`（手动启动器）、
  `docs/local-tts.md` / `docs/local-tts-cosyvoice.md`（部署/对接文档）。
- `speech-clean.js`：`sanitizeForSpeech`（净化）。
- `voice-compat.js`：`LANGUAGE_OPTIONS` / `normalizeVoiceConfig` / `correctSpeakerForLanguage` /
  `ttsProviderOf`（引擎归一）/ `pitchOf`（音调归一）——配置兼容/归一单一事实源；
  `VOLC_VOICES`（音色精选清单）定义在 `index.js`。
- `client.js`：设置页（`settings.section id=voice`）、朗读按钮（`assistant-actions`）、流式播放（Web Audio lookahead）、转写/播报状态机。
- 测试：`scripts/test-host.mjs`（零成本 mock，覆盖转写/缓存/TTS/防串音/重播零 LLM 等）、`scripts/tts-*.mjs`（真实外呼探针，花几分钱）。
