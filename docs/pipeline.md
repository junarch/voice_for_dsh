# 语音转写与 TTS 播报管线（voice pipeline）

> 本文描述**当前实现**的语音播报管线：一轮 DeepSeek 输出结束后，先口语化转写，再交给 TTS 播报。
> 源码：`packages/dsh-plugin-voice/lib/index.js`（Host 半，主实现）、
> `lib/volcengine-ws.js`（豆包双向流 WS 客户端）、`lib/speech-clean.js`（净化）、
> `lib/voice-compat.js`（音色↔语种归一）、`lib/local-runtime.js`（本地合成运行时：sherpa-onnx + Kokoro）、
> `lib/client.js`（Client 半）。

## 核心原则

**播报文稿 ≠ 输出原文。** 原文里的代码、表格、Markdown、URL、JSON、diff 不适合朗读，
由 LLM 转写为自然口语文稿后再交给 TTS；转写关闭时输出什么读什么（仅去 Markdown、跳过表格代码）。

## 1. 管线总览

```
[assistant/message 文本块]                          (每轮最终消息的 text 块拼接)
   → Host 转写：ctx.llm.prepareCall + stream（独立辅助调用，不入会话历史）
   → 语音演绎指令 + 情感 + 强度（内容驱动，LLM 三行输出；只有豆包有 context_texts 这条通道）
   → TTS：browser(客户端 speechSynthesis) | volcengine(双向流 WS 默认 / HTTP 单向兜底)
        | local(本地 Kokoro v1.1，进程内 sherpa-onnx，中英跟随原文)
        └ local 合成：懒加载模型 → 分句切段（splitForStream）→ 逐段进程内合成
                      → Float32→Int16 → 边出边按 ~0.5s 音频切块入队
   → 音频：/voice/audio/<id> 一次性路由 → 客户端 <audio>/Web Audio 播报
```

转写、指令、TTS 都走缓存（按 messageId）：

- 同一消息重复"朗读" → 转写 + 指令都用缓存，零新增 LLM；
- 1h 内重播 → 豆包服务端缓存命中，免重合成、不重复计费（仅参数指纹未变）。

## 2. 转写（Transcription）

### 2.1 触发与输入

- **手动**：每条消息的"朗读"按钮（`conversation.chat.assistant-actions` 槽），对当条消息转写。
- **自动**：`voice.autoSpeak=true` 时在 `turn/end`（`reason.kind ∈ completed|max-tokens`）触发；
  豆包（付费）自动播报还需 `autoSpeakCloudTts=true`（成本门控）；本地引擎（Kokoro）免费，不受门控。
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

**local provider 跟随原文语言**：`tts.provider=local` 时**不追加任何语言要求**——中文原文出中文
口播稿、英文原文出英文、混合内容跟随主体语言（Kokoro v1.1 中英都能读，§4.3）。
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
- **转写完整即写，与播报是否被停止无关**：只要模型把稿子吐完（生产者已收尾），用户中途点停止/换 turn
  也保存这份稿子——否则"听两秒就停"会让整条转写成果作废，下次再点又从头烧一遍完整输入。
  只有模型没跑完（被中止/中途失败）才不写，避免缓存半截稿。
- 双向流的转写生产者与 TTS 消费者解耦：模型按自己的速度吐 delta，TTS 慢不会反压它；
  停止时未被 TTS 消费的尾部 delta 也计入完整稿（`transcriptParts + 尾部 buffer`）。

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

**成本闸门**：段落粒度下每次切段都会调一次 LLM，长回复能叠出几十次（系统提示本身也有几百 token）。
`MAX_PARAGRAPH_INSTRUCTIONS`（12）封顶：超过后沿用最后一次生成的指令，不再新增调用；
run 已停止/被放弃时也不再发起。指令不是朗读的必要条件，听感差异远小于成本差异。

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

### 4.3 local（本地 Kokoro v1.1，进程内合成，中英跟随原文）

> 定位：免费、离线、数据不出本机的**中英**播报引擎。合成在 Host 进程内完成（`sherpa-onnx-node`
> 原生模块），没有子进程、没有端口、不需要 Python。模型与音色见 `docs/local-tts.md`。

- **运行时（`lib/local-runtime.js`）**：`sherpa-onnx-node@1.13.8`（锁版本；2.x 去掉 espeak 回退，
  数字与词典外词会被静默跳过）。`OfflineTts.createAsync(config)` **懒加载**，一个插件实例一份实例；
  改 `modelDir` 会作废已加载实例并按新目录重载。
- **模型目录解析**：`voice.tts.local.modelDir`（显式）> `VOICE_LOCAL_MODEL_DIR`（显式）>
  `<DSH_HOME>/voice/models/kokoro-multi-lang-v1_1` > `<仓库>/local/models/kokoro-multi-lang-v1_1`。
  前两项是显式指定，**不静默回落到别的目录**（否则用户设了目录却听到另一个模型）。
- **合成**：`generateAsync({ text, generationConfig: { sid, speed }, onProgress })`；模型输出
  **Float32 单声道 24kHz**，Host 侧 `float32ToInt16Pcm` 转 **16bit 小端裸 PCM**（客户端只认这个格式），
  整段路径再套 44 字节 WAV 头。`onProgress` 是唯一中断点：超时/停止后返回 0，sherpa 自行收尾。
- **分句流式（默认开，`streaming`）**：`splitForStream(transcript, segmentChars)`（默认 220 字符）
  → 逐段 `streamPcm`（边出边入队，约 0.5s 音频一段）→ `run.queue`（复用豆包那套段队列 + 客户端预取）。
  - 实测（本机 Intel Core Ultra 9 285H）：模型加载 2.8s；首声约 0.6s（4 线程）；RTF 0.32–0.36（4 线程）/
    0.25（8 线程）；常驻内存约 0.5–0.6GB。
  - 失败分档：首段失败 → 降级整段合成兜底（用户仍能听到，`warn` 说明）；第 N 段失败 → 保留已播段 +
    `warn` "第 N/M 段起未播报" + 保留 `ttsErrorKind`；`streaming:false` → 直接整段合成。
  - 单段超时 `segmentTimeoutMs`（默认 30s），整段超时 `timeoutMs`（默认 30s）。
- **失败分类（`ttsErrorKind`）**：`model-missing`（模型未安装/目录被删/显式目录指错）、
  `load-failed`（原生模块或模型加载失败，日志只报一次）、`synth-failed`（合成抛错/sid 越界）、
  `timeout`（段级或整段超时）；客户端按此选 toast（`toast.ttsModelMissing` / `toast.ttsLoadFailed` /
  `toast.ttsSynthFailed` / `toast.ttsTimeout`，无 kind 退回 `toast.fallback`）。
  豆包路径的非 2xx 与帧错误仍标 `http`。
- **自检**：`/voice/api/localStatus` → 模型目录、来源、是否已加载、音色数、采样率、线程数、加载耗时；
  模型已装时顺带加载一次（设置页「🔌 运行时自检」按钮触发，不随设置页打开自动跑）。
- **音色**：模型只暴露数字 `sid`（0–102，无官方名字表）；设置页精选 9 个 + 「手填 sid」。
  超范围明确报错，不静默改音色。
- **不走的通道**（与豆包的差异，全为省 LLM/复杂度）：
  - 无情感指令：`context_texts` 是豆包专属，§3 的 LLM 指令生成对 local 跳过 = 零额外 LLM；
  - 无服务端缓存（§4.5 是豆包语义，本地合成零边际成本，重播直接重合成）；
  - 无 WS 双向流（豆包专属；本地是"进程内分块流式"，见上）；
  - 不参与成本门控：`autoSpeakCloudTts` 只拦豆包（付费），本地免费，自动播报不拦。
- **转写关闭时的行为**：直读稿直接送本地合成（中英都能读），**不再回退系统朗读**，也没有 `notice`。
- **语言**：转写稿跟随原文语言（不套英文不变式）；中英混读由模型自己切音素。
- **不变式**：发给 local 的 text 同样不得含 `[#`（§7.1 的净化在 provider 之前，天然满足）。
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
- **停止要停到 Host**：客户端停播（停止按钮/新 turn/"朗读中"徽标）要调 `/voice/api/stop` 中止后台管线；
  只停浏览器音频会让 Host 继续跑段落指令 LLM 与合成，白花钱。
- **徽标状态必须能收尾**：播放开始 → `speaking`；自然结束 → `done`；停止/出错/被打断 → 清除。
  状态变更通知所有订阅者（徽标、消息按钮），否则 React 不会重渲染，界面会停在"朗读中…"。
- 双向流：`speak` 立即返回 `{mode:'stream', runId}`，管线后台跑；Client 经 `streamNext` 取段播放；
  失败/零音频自动降级 HTTP 整段（warn 提示）。
- 重播（缓存命中）：转写 + 指令全用缓存（零 LLM），段落照常切分但复用缓存指令；音频重合成但 1h 内走服务端缓存免费。
- 重新生成（↻）：转写 + 指令全部重新生成（force 跳过缓存），结果覆盖该 messageId 条目。
- 成本门控：设置页"播报引擎"选豆包时写入 `autoSpeakCloudTts=true`（= 用户显式选择付费 API），
  引擎为免费引擎（browser/local）时该开关为 false 且豆包不参与自动播报（全免费，含手动按钮）；
  profile patch 里直改的配置若 `autoSpeakCloudTts=false`，豆包自动播报仍被拦截（防手工配置烧钱），
  手动按钮与 local（免费）不受限。

## 6. `voice:` 配置 schema 定稿

> **配置存放位置（DSH 0.2.0 起）**：字段写在目标 profile 的 `cordis.patch.yml` 里 `id: voice` 条目的
> `config:` 下。0.1.x 时代的 `$DSH_HOME\settings.yaml` 已不再被读取（0.2.0 首次启动把它改名为
> `settings.yaml.imported`）——迁移用 `node scripts/migrate-voice-config.mjs --write`（先不加 `--write`
> 预览；幂等，已迁移会拒绝重写，写前自动备份 patch）。
> schema 定义在 `index.js` 的 `Config`（插件 Config，见 §6.0）。所有字段带默认值 → 全新安装不带 voice 块
> 也能跑（默认 browser TTS）。设置页（`settings.section id=voice`"语音播报"）只暴露常用项，
> 以下标注"（无 UI）"的字段**已从设置页隐藏**：schema 保留（向后兼容，老配置里的值仍生效）、
> 走固定默认值，仅需高级/内部逻辑时在 profile patch 直改。

### 6.0 配置模型与热改边界（0.2.0 起）

- 插件通过导出 `Config`（schemastery schema）声明可配置字段，插件体 `apply(ctx, config)` 拿到解析后的配置；
  `ctx.settings.register(...)` 在 0.2.0 已移除，**不要再使用**。
- 需要"改了立刻生效、不重启"的字段在 schema 里标 `.volatile()`，读取时是**引用对象**（`.get()` 取当前值）；
  未标 volatile 的字段改动会触发插件重挂载。
- **volatile 只能落在固定对象路径上，不能嵌套**：`tts` / `transcribe` 两个整块各是一个 volatile 单位
  （`.get()` 返回普通对象），`autoSpeak` / `autoSpeakCloudTts` / `language` / `provider` / `model` /
  `stopOnNewTurn` 各自单独标 volatile。改 schema 时若把 volatile 标到 `tts.xxx` 之下，解析会直接报
  "volatile fields require a fixed object path"。
- 写入仍走 `ctx.settings.update('voice', patch)`（深合并；patch 只需带改动的字段）。
- 老配置里只有 `pitchLevel`、没有 `pitch` 时（0.1.x 时代 settings.yaml 的写法）：`pitchOf` 里 `pitch` 的 schema
  默认值 0 恒存在且优先，所以**搬过来的 `pitchLevel` 不影响发声**（存储上不丢，听感按 0 处理）。
  要让老五档音调重新生效，把 `tts.volcengine.pitch` 写成对应半音值（五档映射常数见 `lib/voice-compat.js` 的 `pitchOf`）。
  `RATE_STOPS`/`PITCH_STOPS` 仍在 schema 里（设置页的语速/音调档位用），只是 `pitchLevel` 不再影响发声。
- `tts.volcengine.apiKey` **不标 `role('secret')`**（有意）：dsh-settings 的写入路径会把非 volatile 的秘密字段
  从落盘补丁里剥掉（`strip(raw, form)`），而设置页每次保存都会整块重写该条目的 config——一旦标 secret，
  用户第一次在设置页点保存就会**把 patch 里的 apiKey 删掉**，云 TTS 从此失效。所以 key 保持在 profile patch 里
  明文（与旧 settings.yaml 同一安全等级），设置页可读可改。

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
    provider: browser         # browser | volcengine | local（已退役的 local-cosyvoice 归一到 local；其余旧值归一为 browser）
    browser: { rate: 1.0, pitch: 1.0, voice: "" }
    volcengine:
      apiKey: ""              # 火山方舟专属 API Key（明文存在目标 profile 的 cordis.patch.yml，注意保管，别提交）
                              #   不标 role('secret') 的原因见 §6.0 末条（标了会被设置页保存删除）
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
      sid: 48                  # 音色编号 0–102（模型无官方名字表；设置页精选 9 个 + 手填）
      speed: 1.0               # 语速 [0.5, 2]（模型原生参数，不是变速播放）
      numThreads: 4            # 合成线程数 1–16（线程多首声更快、更吃 CPU）
      modelDir: ""             # 模型目录覆盖；空=自动找（配置 > env > 用户目录 > 仓库 local/models）
      timeoutMs: 30000         # 整段合成超时；失败 → ttsError(+ttsErrorKind)
      streaming: true          # 分句流式：按句切段逐段合成，首声约 0.6s（关=整段合成）
      segmentChars: 220        # 分句流式的每段目标字符数（无 UI，高级）
      segmentTimeoutMs: 30000  # 单个音频段的超时（流式路径；替代整段死线）
      # 历史字段 baseUrl / voice / autoStart / pythonPath 已随 Python 服务退役：
      #   读到也不再生效（schema 里已删），存量配置里的值会被忽略、下次保存时被清掉。
  stopOnNewTurn: true
  chime:                      # 提示音（设置页第五层）；默认整层关闭，与朗读互不依赖
    enabled: false
    volume: 0.3               # 总音量 0–1（客户端 master gain）
    work: { enabled: false, source: default, file: "" }   # 工作音：顶层会话在跑时循环
    done: { enabled: false, source: default, file: "" }   # 完成音：顶层会话 running 真→假
    ask:  { enabled: false, source: default, file: "" }   # 提问音：question / plan-review（审批不算）
```

### 6.1 配置演进约定（升级纪律）

用户本地的 profile patch（`voice` 条目的 config）是私有数据，**只补默认、绝不覆盖**。升级时按此纪律处理，防止"用户配置静默丢失 / 悄悄烧 token"：

1. **新字段必须带默认值**（老用户缺了就按默认走，零冲突、零报错）；
2. **改字段语义 / 删字段** → 必须加兼容层（读新名、读不到读旧名，如 `pitchOf` 的 `pitch`→`pitchLevel`）+ **升大版本** + CHANGELOG 顶部写"升级指引"；
3. **字段淘汰优先"UI 隐藏 + schema 保留"**（零风险、向后兼容）；确需真删才写迁移；
4. **兼容/归一逻辑集中在 `lib/voice-compat.js`**（`ttsProviderOf`/`pitchOf`/`normalizeVoiceConfig`），新增归一只往这里加；Client 半同步维护内联镜像。

### 6.2 提示音（chime）

- **信号只从客户端来**，Host 不推送：`uiSession.sessionStatus`（`Map<sessionId, {running, pendingInteraction, completionUnread}>`，
  有 `getSnapshot/subscribe`）。三种音全部由这个快照对账得出，`turn/end` 不参与（它只服务自动播报）。
- **工作音**：顶层会话 `running` 计数 `0→>0` 起、`>0→0` 停。素材 ≥2 秒用 `loop=true` 单条循环；
  短于 2 秒不 loop（会变蜂鸣），改成每 2 秒响一次。
- **完成音**：顶层会话 `running` 由真变假触发；领先播放 + 1 秒抑制窗（多条会话几乎同时结束只响一次）。
- **提问音**：`pendingInteraction.kind` 只认 `question` 与 `plan-review`；**审批（`approval`）不响**。
  按 interaction `key` 去重，交互消失时清 key（同一个 key 再出现会再响）。
- **只认顶层会话**：子代理也会写同一个 status store，必须 join `ctx.sessions.list` 的快照，
  过滤 `origin === 'subagent'` 与带 `parentId` 的行；拿不到会话表时按顶层处理（不因缺信息丢音）。
- **上下文独立**：提示音用自己的 `AudioContext` + master gain。播报上下文固定 24kHz 且会被
  `stopPlaybackOnly` 连坐，两者不能共用；提示音不参与播报的停止/中断，播报也压不掉提示音（叠放）。
- **默认三音程序合成**（正弦振荡 + 指数衰减包络，按上下文缓存），不随包带音频文件；自定义音走
  `GET /voice/sounds/<file>` 取回后 `decodeAudioData` 解码，读不到时回落默认音（设置页同时提示）。
- **素材存储**：`POST /voice/sounds?kind=work|done|ask&name=<原名>` 上传（`application/octet-stream`，
  累加 ≤10MB，魔数白名单 mp3/wav/ogg/m4a/aac/flac/opus/webm，文件名白名单并拒绝 `..`），
  落盘 `<DSH_HOME>/voice/sounds/<kind>-<uuid>.<ext>`（tmp + rename，GET 永远看不到半个文件）；
  config 里 `chime.*.file` 只存**文件名**（相对路径 → 重启后仍读得到，DSH_HOME 搬家也不丢）。
  `GET /voice/sounds/<file>` 只读不删（要反复取），按扩展名给 Content-Type，拒绝路径穿越。
- **启动清扫**：目录里未被 `chime.*.file` 引用、且超过 1 天的文件删掉；引用着的、以及刚上传还没保存的都留着。
- **前端先体检再上传**：`new Audio(URL.createObjectURL(file))` 读时长 >60 秒直接拒；
  `decodeAudioData` 试解一次，解不了提示"这个格式浏览器解不了"；通过后才 POST。Host 只管大小与魔数。
- **缺 `uiSession` 服务时静默降级**：不建上下文、不发提示音，播报链完全不受影响。

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
10. **本地引擎跟随原文语言且零额外 LLM**——`local`（Kokoro v1.1）转写稿跟随原文语言（§2.2）、
    不生成情感指令（`context_texts` 是豆包专属）、不下发服务端缓存（§4.5 跳过）、
    不受 `autoSpeakCloudTts` 门控（免费引擎）；转写关闭时**直接本地合成**（中英都能读），
    不得回退系统朗读、不得再带"需开启转写"的 notice。
11. **本地合成必须在 Host 进程内**——`sherpa-onnx-node` 直接加载（`OfflineTts.createAsync`），
    **不得**再引入 Python 子进程、服务端口或 `ctx.subprocess`；引擎懒加载、失败只报一次日志。
12. **失败必须可分类**——TTS 失败一律带 `ttsErrorKind`（model-missing/load-failed/synth-failed/
    timeout/http），客户端据此给专用文案，不得让"模型没装"与"合成失败"共用一句笼统提示。
13. **分句流式不得丢字、不得整条报错**——`splitForStream` 各段拼接必须与转写稿一致（只允许丢段间空白）；
    首段失败 → 降级整段兜底；中途失败 → 保留已播段 + warn 注明从第几段起缺失，绝不把"半篇已播"报成整条失败。
14. **本地分句流式必须边出边入队**——`onProgress` 每回一块就按 ~0.5s 音频切一段入队，
    **不得攒完整段再入队**（那等于把流式丢掉：首声从"首块算完"退化成"整段合成时长"）。
15. **本地合成必须可中断**——停止播报/超时时，`onProgress` 返回 0 让 sherpa 收尾，
    不得让被中止的合成继续烧满 CPU（客户端感知：点停止后 CPU 很快回落）。
16. **播放链路必须可观测**——客户端把播放各步（起播模式/AudioContext 状态/取段/解码/排程/结束）
    上报 Host（`/voice/api/clientDiag` → `clientDiagDump`）：
    "还没算完"与"解码失败/没排上播放"必须能区分，不能只靠耳朵判断。
17. **停止播报必须同时收尾状态**——停音频时清掉该消息的 `spokenState`，并通知订阅者重渲染；
    否则徽标永远停在"朗读中…"（浏览器中断播放不会回调 onend）。"朗读中"点击 = 停止，
    不得再起一条新播报（每次新起都是一次完整转写 = 再烧一次 token）。
18. **停止播报不得丢弃已完成的转写**——转写稿只在模型未跑完时放弃；
    完整稿必须落缓存，保证下次点击零 LLM（"听两秒就停"不能变成每次都从头转写）。
19. **段落情感指令必须有成本上限**——每两句话一次 LLM 会让长稿的辅助调用数失控；
    上限 `MAX_PARAGRAPH_INSTRUCTIONS` 之外沿用最后一次指令，run 停止后不再发起。
20. **提示音不得与播报共用播放链**——独立 `AudioContext`（不指定 24kHz）+ 独立实例表；
    提示音不受 `stopPlaybackOnly`/停止播报影响，播报也不会被提示音打断（两者叠放）。
21. **提示音只认顶层会话与提问交互**——按 `ctx.sessions.list` 过滤 `origin==='subagent'` 与带 `parentId` 的行；
    `pendingInteraction` 只认 `question`/`plan-review`，**审批 `approval` 不响**；缺 `uiSession` 时静默降级。
22. **提示音素材只能落在 `<DSH_HOME>/voice/sounds`**——上传按魔数认格式（不信扩展名）、≤10MB、
    文件名白名单拒绝 `..` 与路径分隔符；GET 只读不删、拒绝路径穿越；未被配置引用且超过 1 天的文件在启动时清扫。

## 8. 设计决策（为什么）

- 转写在 Host 用 `ctx.llm`（独立辅助调用、不入主历史）：复用已配 provider/凭据、不暴露 key、prompt 可控。
- 默认 TTS = 浏览器兜底：零配置、免费、离线。
- 云 TTS 走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传：`ctx.web` 仅 GET 抓取
  （不能 POST/鉴权头/二进制）；动态沙箱禁 fetch。
- 云 TTS 默认关闭（默认引擎 browser，全免费）；设置页切豆包 = 用户显式为付费 API 买单，
  自动播报才可能走豆包；profile patch 里直改的配置仍由 `autoSpeakCloudTts` 门控防账单失控；
  local 免费引擎不在门控之列。
- 转写与播报分离；成品为正式 bundle（非创造模式动态插件）：动态插件进程内临时、重启丢失、沙箱禁 fetch。
- 自研 TTS 适配层（不引第三方库）：无现成 JS 库支持火山 v3；HTTP 单向协议极简（~150 行零依赖）；避免供应链与失维护风险。
- local 换掉了 Python 子进程服务，改为进程内 `sherpa-onnx-node`：用户不必装 Python、不必管端口与
  子进程生命周期；代价是原生模块进了 Host 进程（崩溃域变大）、模型常驻内存约 0.5–0.6GB。
  仓库只存"方法"（依赖声明 + 文档），模型/二进制不入库（AGENTS.md 依赖管理约定）。
- UI 只占 additive 小槽位（assistant-actions / input.left / turnTail / settings.section / shell.overlay），不碰 `root`/`conversation.session`。

## 9. 参考（源码位置）

- `index.js`：schema `VoiceSettingsSchema`；转写 `streamTranscription`/`transcribe`；
  指令 `generateVoiceInstruction`/`buildVoiceInstruction`/`composeContextText`；
  TTS `synthesizeVolcengine`/`buildVolcReqParams`；双向流 `streamSpeak`；
  服务端缓存 `serverCacheAllowed`/`serverCacheMark`/`ttsFpOf`。
- `volcengine-ws.js`：双向流协议（帧编解码 / 事件 / 连接管理器）。
- `local-runtime.js`：本地合成运行时——`resolveModelDir`（模型目录解析）/ `inspectModelDir`（缺什么）、
  `createLocalRuntime`（`ensureLoaded` 懒加载 / `streamPcm` 分块合成 / `synthesizeWav` 整段 / `status` 自检）、
  `float32ToInt16Pcm` / `pcmToWav`（Float32→16bit 小端）、`speakError`（带 kind 的错误）。
- `speech-clean.js`：`sanitizeForSpeech`（净化）。
- `voice-compat.js`：`LANGUAGE_OPTIONS` / `normalizeVoiceConfig` / `correctSpeakerForLanguage` /
  `ttsProviderOf`（引擎归一）/ `pitchOf`（音调归一）——配置兼容/归一单一事实源；
  `VOLC_VOICES`（音色精选清单）定义在 `index.js`。
- `client.js`：设置页（`settings.section id=voice`）、朗读按钮（`assistant-actions`）、流式播放（Web Audio lookahead）、转写/播报状态机。
- 测试：`scripts/test-host.mjs`（零成本 mock，覆盖转写/缓存/TTS/防串音/重播零 LLM 等）、`scripts/tts-*.mjs`（真实外呼探针，花几分钱）。
