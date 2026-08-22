# 口语化转写与 TTS 接入设计（voice-pipeline）

> 核心原则：**播报文稿 ≠ 输出原文**。原文中的代码、表格、Markdown、URL、JSON、diff 等
> 不适合朗读，必须经 LLM 转写为自然口语文稿后再交给 TTS。

## 1. 转写（Transcription）

### 1.1 触发与输入

- 输入：一轮（或一条）`assistant/message` 的 text 块拼接（`message.content` 中 `type:'text'` 的 `text`）。
- 输出：一段口语文稿（纯文本，无 Markdown 标记）。
- 由 Host 半发起独立 LLM 调用（`ctx.llm.prepareCall + stream`），不入主会话历史。

### 1.2 System Prompt（v1 基线，可被 settings 覆盖）

```text
你是一个"文本口语化转写器"。把用户给你的 AI 助手输出改写为适合 TTS 语音朗读的口语文稿。
输出语言与原文保持一致：中文原文输出中文口播，英文原文输出英文口播，混合内容跟随主体语言。

规则：
1. 代码块（\`\`\` ... \`\`\` 或行内 \`code\`）：不要逐字朗读。用一句话概括其作用，例如
   "这里给出了一段 Python 代码，作用是读取文件并统计行数"；必要时才读出关键符号名（读作字母/单词）。
2. 表格：不要朗读 Markdown 表格符号。按行转述："表格第一列是X，第二列是Y；第一行……第二行……"，
   或概括要点。
3. 列表：用口语连接词："第一、……；第二、……" 或 "其中包括……"。
4. URL：只读域名部分（如"链接指向 github 点 com"），不逐字符读。
5. 符号/缩写：保留重要术语与数字；英文缩写按常见读法（如 API 读作 A-P-I）。
6. 删除所有 Markdown 标记（#、*、-、|、> 等）、代码符号、JSON 花括号等，除非其内容是结论的一部分。
7. 保留结论、建议、关键数字、文件名（文件名可读出）、时间等信息。
8. 语气自然口语化，可用"首先/然后/最后/总之"组织；输出纯文本，不加任何解释或前缀。
```

### 1.3 请求参数

- `provider/model`：默认跟随设置 `voice.provider`/`voice.model`，未配置时用会话默认（`agent-default-model`）。
- `maxTokens`：默认 **8192**（可配 `voice.transcribe.maxTokens`）。⚠️ 推理模型（如 deepseek-v4-flash）
  先烧 reasoning token：额度太小会出现 `finish=max-tokens` 且**正文零产出**（2026-08-18 实测，2048 时长消息必现）；
  代码在"撞顶且无正文"时自动以 4 倍额度重试一次。
- `temperature`：0.3（稳定改写）。
- `purpose`：`'voice-transcribe'`（自定义，仅作标记）。
- 超时：60s（可配），超时或失败 → 降级为"纯文本直读"（仅剥离 Markdown 标记，不调 LLM）并提示用户。
- **缓存**：转写稿按 `messageId` 缓存并落盘 `$DSH_HOME/voice-transcript-cache.json`（重启不丢，上限 200 条）；
  仅当 provider/model/prompt/reasoningEffort 四者与当前配置完全一致才命中——同一消息重复点"朗读"、dsh 重启后再点，都直接复用不再调 LLM。
  2026-08-21 起缓存条目额外带 `instruction` 字段（内容驱动语音指令，见 §1.5）：转写稿与指令一起复用，
  同一消息第二次播报**零新增 LLM 调用**。旧缓存条目没有该字段 → 命中时只补生成指令、不重转写。

### 1.5 内容驱动的语音演绎指令（2026-08-21 新增，第二段 LLM 输出）

- **设计动机**（用户提出）：风格预设的 `instruct` 是写死的机械指令（选暧昧就永远"轻声温柔地说"），
  遇到"全部测试通过！"这类内容会违和。真实配音是**拿到稿子、读懂内容、再决定怎么读**——
  "活泼的人有她的方式说伤心的事"：人设（风格）由转写 prompt 落进**文字**，演绎指令根据
  **具体文稿**撰写，落进**声音**，两个维度解耦。
- **实现**：转写完成后（`lib/index.js` transcribe 内），若为云 TTS 且转写开启/非降级，用独立
  system prompt（`INSTRUCTION_EMOTION_SYSTEM`）调 LLM，输入 = 口播文稿，
  输出**严格三行**：① 一句 8~25 字播报指令（如"语气轻快活泼一点"）② 情感标签 ③ 情绪强度 1~5
  （反映事件重要/激动程度，动态）；配置 maxTokens=256、温度 0.3、超时 15s；
  失败/超时/输出异常 → 返回空，调用方回退预设。
- **优先级链**（lib/index.js `buildVoiceInstruction`）：用户自定义 prompt 里显式写的 `[#指令]`
  （extractedCmd，明确意图）> 内容驱动生成指令 > 预设机械指令（instruct，最后兜底）。
  方言不再拼进 context_texts（2026-08-19 探针实测无效，改走 explicit_dialect，见 §2.3.2）。
- **段落粒度扩展（双向流路径，`streamSpeak`）**：`emotionGranularity='paragraph'` 时按段开 session，
  每段用 `INSTRUCTION_EMOTION_SYSTEM` 生成三行（指令 / 情感标签 / 情绪强度）；段 0 用预设机械指令
  （零等待，增量直喂尽早出声），段 N 用段 N-1 的文本并行生成（重叠零延迟）；三行全部织进
  `context_texts` 自然语言指令（`composeContextText`，所有 2.0 音色生效，见 §2.3.3）。
- **跳过场景**（白花钱无收益）：browser TTS（speechSynthesis 不吃 context_texts）、
  转写关闭（`transcribe.enabled=false`，不调任何 LLM）、降级直读稿（LLM 刚失败过，不再多调一次）。
- **成本**：非流式 = 1 次转写 + 1 次小指令（封顶 256 token）+ 1 次 TTS；双向流段落粒度 = 1 次转写 +
  每段 1 次小指令（封顶 256 token，重叠）+ 每段 1 个 TTS session；指令随转写稿缓存，重复播报不增。

### 1.4 降级直读（fallback，已实现）

不调用 LLM 的纯文本提取（`sanitizeForSpeech`，`lib/speech-clean.js`：代码块/表格**整块跳过**、
URL→「链接+域名」、剥 Markdown 标记/装饰符号/表情，保留中文标点与数字百分比）。触发：转写抛错 /
超时（`transcribe.timeoutMs`，默认 60s）/ 撞顶重试后仍空稿。
降级稿**不写缓存**（下次点击仍重试转写），响应带 `degraded: true`，Client 提示后照常播报。

> **净化是全链路统一的**：转写开启时，LLM 输出同样先经 `extractVoiceTags`（提取 `[#...]`）再
> `sanitizeForSpeech` 才喂 TTS/写缓存；流式路径在每次 `sendText` 前按句净化（含跨句代码块围栏跟踪）。
> 效果：**Markdown 符号、装饰标点、表情符号不会被读出来**；转写关闭时「输出什么直接读，表格/代码跳过」。

## 2. TTS Provider 适配层

> **不引第三方 TTS 适配器库**。调研结论（见 `docs/research/plan-review-tts-adapter-report.html`）：
> 无现成 JS 库支持火山引擎 v3 接口；候选库（lobe-tts / edge-tts / LiteLLM 等）要么不覆盖火山、
> 要么过重或维护不稳。插件内自研薄适配层：统一接口 + 每 provider 一个文件（约 100–150 行），
> 零新增 npm 依赖，新增供应商 = 加一个文件。

```ts
interface TtsProvider {
  id: 'browser' | 'volcengine'   // openai-compatible 已于第 3 轮移除（见 §2.2）
  // 云 provider 在 Host 半实现（正式 bundle = 普通 Node 模块，直接用全局 fetch）；
  // browser 是透传：Host 只回文稿，Client 侧 speechSynthesis 播报
  synthesize?(req: { text: string; speaker?: string; signal?: AbortSignal }):
    Promise<{ audio: Buffer; mime: string }>
}
```

### 2.1 `browser`（零配置兜底，默认）

- 浏览器 `speechSynthesis`：`speechSynthesis.speak(new SpeechSynthesisUtterance(text))`。
- 语速 `utterance.rate`（settings `voice.tts.browser.rate`，默认 1.0）、音调 `pitch`（默认 1.0）、
  音色 `voice`（settings `voice.tts.browser.voice`，可空 = 系统默认）。
- 停止：`speechSynthesis.cancel()`。
- 优点：零配置、免费、离线。局限：依赖浏览器/系统语音（Windows 需安装中文语音包）；无 SSR。

### 2.2 `openai-compatible`（已移除，2026-08-23 第 10 轮审计删除）

- 原为兼容 `POST {baseUrl}/audio/speech` 的中转站接入，第 3 轮已从设置页移除；本轮审计确认
  `synthesizeOpenAICompat` 分支**不可达**（调用点均被 `ttsProviderOf !== 'browser'` 守卫，只可能走
  volcengine）、schema `openaiCompatible` 组与 settings.yaml 相应块均为死代码 → 全部删除。
- 保留 `ttsProviderOf` 归一（存量配置里旧值 `openai-compatible` 一律按 `browser` 处理，不炸启动）。

### 2.3 `volcengine`（主接口：双向流 WebSocket；HTTP 单向兜底）

- 模型：豆包语音合成模型 2.0（`doubao-seed-tts-2.0`），头 `X-Api-Resource-Id: seed-tts-2.0`，
  鉴权 `X-Api-Key: <方舟专属 API Key>`。

#### 2.3.1 双向流（WebSocket Bidirection，2026-08-21 起默认，`interface='bidirection'`）

- **端点**：`wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection`（plan 网关，当前 Key 可用；
  新 V3 网关 `wss://openspeech.bytedance.com/api/v3/tts/bidirection` 需新版控制台签发的 Key——
  **2026-08-21 实测当前 ark- Key 在 V3 网关返回 401 Invalid X-Api-Key**，故默认走 plan 网关；
  可用 `tts.volcengine.wsUrl` 切换）。
- **能力**：文本流式输入（增量 TaskRequest）+ 音频流式返回（AudioOnlyServer 帧，mp3 raw）；
  一条连接多个**串行** session（不支持并行）；探针实测**首包延迟 310~390ms**。
- **协议**：二进制帧——4 字节头（v1 / 消息类型+flags / JSON-or-raw / 无压缩）+ event(int32 BE) +
  session_id(长度+字节) + payload(长度+字节)。事件：1 StartConnection / 50 ConnectionStarted /
  100 StartSession / 150 SessionStarted / 200 TaskRequest / 350 TTSSentenceStart / 351 TTSSentenceEnd /
  352 TTSResponse / 102 FinishSession / 152 SessionFinished / 101 CancelSession / 2 FinishConnection。
  音频经 AudioOnlyServer(0b1011) 帧返回。实现见 `lib/volcengine-ws.js`（帧编解码 + 事件驱动连接管理器）。
- **流式管线**（`lib/index.js` `streamSpeak`）：
  1. 点「朗读」→ `speak` 立即返回 `{ mode:'stream', runId }`，后台开一条 WS 连接。
  2. 转写 LLM 流式产出 → 按「完整句」缓冲（`findSentenceEnd`）逐句 TaskRequest 喂入（低延迟）；
     每 2 句切一段（`emotionGranularity='paragraph'`）→ 换 StartSession → 换语音指令/情感。
  3. 音频按大小分段（首段 16KB≈0.33s 尽早出声，后续 48KB≈1s，**pcm@24kHz/16bit**）→ 挂
     `/voice/audio/<id>`（**format 标记：pcm 裸采样 | mp3 兜底段**）→ Client 取段。
     **音频格式用 pcm**（官方文档 2532486 明确"流式场景推荐使用 pcm"）：裸采样无 MP3 帧/编解码器
     延迟，任意字节位切断都无缝——"逐段独立解码把字头尾啃掉一点"的接缝问题按构造消除
     （旧 mp3 实测：段边界落在句中被劈成两段、逐段解码与连续解码差 ~576 采样/24ms）。
     播放端用 Web Audio：pcm 段直接 Int16→Float32 建 AudioBuffer（同步、无解码延迟），mp3 兜底段走
     decodeAudioData；lookahead 无缝调度 + 预取 ≤3 段，无 AudioContext 时回退顺序 `<audio>`。
     首次交互预热 AudioContext。
  4. 指令链：段 0 用风格预设机械指令（零等待）；段 N 用段 N-1 的文本并行生成「指令+情感标签」
     （`INSTRUCTION_EMOTION_SYSTEM`，重叠零延迟）。**重播（缓存命中）不生成**——整条复用缓存指令，
     段落照常切分但零 LLM（见 §5.7）。
  5. 结束：FinishSession → SessionFinished → FinishConnection；转写稿按 messageId 写本地缓存
     （**与 HTTP 路径同形状**：净化稿 + 首条动态指令/情感/强度；流式与 HTTP 可互读，见 §5.7；
     仅**转写完整**时写缓存，WS 中途失败不污染缓存）。
  6. 失败兜底：双向流失败/零音频 → **丢弃未完成的半截音频段**（否则会误触发播放截断内容、抑制兜底）
     → 自动降级 HTTP 单向整段合成（run.warn 提示；降级走转写缓存，命中则零重复转写、不烧 token）。
- **参数（StartSession 级，session 内固定；改参数=开新 session）**：
  - `audio_params`：**双向流 `format=pcm`**（裸采样、无缝；HTTP 单向仍 `mp3`）、`sample_rate`、
    `speech_rate`（五档）、`bit_rate`（**mp3 专用，仅 HTTP 单向生效**）、`loudness_rate`（音量）。
  - `additions`：`context_texts`（**语音指令/情感通道**，所有 2.0 音色生效、仅首个值有效、不计费）、
    `explicit_dialect`（方言，8 种方言统一 vv，§2.3.2）、
    `explicit_language`（仅固定英文）、
    `section_id`（跨次合成语气连续）、`post_process.pitch`（五档半音）。
    **不再下发 `cache_config`**：服务端缓存只按文本、不认方言/音色/情感参数，试听文本固定会命中
    缓存返回旧音频（2026-08-23 实测：同文本 + 三方言 → 音频完全一致）；本地转写缓存已足够。
  - `req_params.model='seed-tts-2.0-expressive'`（表现力增强，`tts.volcengine.expressive`，效果抽卡，默认关）。
- **探针验证**（`scripts/tts-ws-probe.mjs`，plan 网关实呼）：流式喂文本 / 多 session 复用 /
  context_texts / explicit_dialect / section_id / model=expressive 全部通过；
  **情感只走 context_texts**（1.0 的 emotion/emotion_scale 已删除，见 §2.3.3），对所有 2.0 音色生效。

#### 2.3.2 方言（2026-08-23 实测定案：8 种方言统一 vv + explicit_dialect）

- **根因（历史）**：此前方言走 `context_texts`「用X说」指令，实测基本无效（vv 上无可计量时长变化）。
- **定案（2026-08-23 三轮探针实测）**：`additions.explicit_dialect` 在 plan 网关对 vv 音色
  **8 种方言值全部生效**——HTTP 单向（`tts-dialect-probe.mjs` / `tts-dialect-probe2.mjs`）与
  双向流（`tts-ws-dialect-probe.mjs`）均返回 200、音频互不相同且不报错：
  `tianjin` / `yue` / `shanghai` / `henan` / `beijing` / `dongbei` / `sichuan` / `shaanxi`。
  音色列表文档 1257544（8 方言）与实测一致；**API 参数文档 1329505「仅 dongbei/sichuan/shaanxi」
  已过时**。
- **天津话"有天津味但无口音"之谜**：第 3 轮把方言从 context_texts 迁到 explicit_dialect 时，
  天津话没有 dialectId → 什么都不下发（纯普通话）。根因是**我们没发参数，不是服务端不支持**。
  本轮 `LANGUAGE_OPTIONS` 8 种方言全部补 `dialectId`。
- **只适配 2.0**：方言统一走 vv + explicit_dialect；**不再接 1.0 方言专属音色**（粤语小溏/豫州子轩/
  北京小爷 等均为 seed-tts-1.0 资源，本插件不接）。
- **自动纠错（音色锚定，voice-compat.js）**：改语种/方言 → 自动纠音色（方言→vv、English→英文音色）；
  改音色 → 自动纠语种（选"小何"而当前是河南话 → 语种自动改普通话，**不再锁定/禁用音色下拉**）。
  静态冲突（settings.yaml 直改）由 `normalizeVoiceConfig` 确定性定序：方言→vv、English→英文音色、
  zh/auto 保持。UI 显示 = 实际发声。
- 代码：`LANGUAGE_OPTIONS`/`EN_VOICE_PREFIXES`/`DIALECT_IDS` 与归一逻辑统一维护在 `lib/voice-compat.js`
  （单一事实源，Client 内联镜像）；`buildVolcReqParams` 下发 `explicit_dialect`；`buildVoiceInstruction`
  不拼「用X说」进 context_texts。

#### 2.3.3 情感（context_texts 是 2.0 唯一通道；1.0 emotion 数值参数已删除）

- **context_texts 语音指令 = 情感控制通道**（官方 docs/6561/1329505；用户向火山官方助手核实，
  2026-08-23）：**所有豆包语音合成模型 2.0 音色可用、无需 `_emo_` 音色或专属 Key、指令不计费、
  仅第一个值有效**。传**自然语言情感描述**（如"你可以用特别特别痛心的语气说话吗?"）。
  动态按段下发（内容驱动，见 §1.5 扩展）。
- **LLM 三行输出全部进 context_texts**（2026-08-23 起，`composeContextText`，lib/index.js）：
  ① 播报指令 + ② 情感标签 + ③ 情绪强度 1~5 织成一条自然语言指令
  （如"语气轻快活泼一点，语气开心一点，情绪明显一些"）→ 普通 vv 音色也能表达情感。
- **1.0 的 `emotion`/`emotion_scale` 数值参数已删除**（2026-08-23，用户指令"只适配 2.0"）：
  该参数仅 1.0 多情感音色（`_emo_v2_`，如柔美女友2.0/阳光青年2.0/爽快思思2.0）支持，
  本插件不再适配 1.0 音色，`EMO_VOICES`/`EMOTION_ZH2EN`/schema 字段/meta.emoVoices 全部移除。
- 动态性：context_texts 为 **StartSession 级参数**（session 内固定）→ 动态 = 按段开新 session
  （paragraph 粒度）。

#### 2.3.4 HTTP 单向（内部兜底，`interface='http'`；设置页不暴露手动切换）

- 保留原实现：`POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，chunked JSON 行，
  `{code:0,data:base64}` 累加 + `{code:20000000}` 结束；语速/音调走数值参数。同参数字段
  （bit_rate / loudness / explicit_dialect / section_id / `X-Api-Request-Id` / usage 头）。
  不再下发 cache_config（见 §2.3.1 说明）。
- 双向流不可用（网络/Key 问题）时自动降级到本路径（整段合成，run.warn 提示）。
- **语音指令能力实测（2026-08-19/20 三轮探针 `scripts/tts-probe.mjs` + 用户旧项目
  secretary-agent 独立实测；音频存档在 tmp 下 probe 目录，可亲耳复听）**：
  - 内嵌 `[#...]` 标签（句首/句中/指令格式/`[#上文]`）**全部按普通文本照读**（时长随标签字数
    线性增长，D 实验 2.37 倍；旧项目 broadcast.ts:44 注释「Jun 重启后实测实锤」同结论）。
    => **不变量：发给该接口的 `text` 不得含 `[#`**（Host `extractVoiceTags` 提取剥离）。
  - 官方指令通道是 `req_params.additions.context_texts`（数组；旧项目注释记录：指令文本不参与
    计费、仅第一个值有效）。本仓库实测：指令效果**不稳定且依赖音色/措辞**--vv 音色上「温柔语气/
    慢速/东北话」单句指令时长零变化，组合指令 +10%、包裹形式 `[#…]` +38%；xiaohe 音色上「慢速」
    +49%、旧项目模板措辞（「轻声温柔地说」「用俏皮可爱的语气说」）+15%。
  - **人耳复听结论（2026-08-20，用户逐文件试听 tmp/probe-*/ 后反馈）**：
    - 内嵌标签被照读：确认（D 文件开头念出标签）；
    - 慢速指令：**最可靠**（G「确实能感觉到慢速」、K 包裹形式「特别慢」、L 小何「慢一点有停顿感」）；
    - 温柔/暧昧：有但微弱（B「好像温柔了一些」、F 组合「暧昧的感觉能听出来」、H/N/P「一点点」）；
    - 俏皮：偏明快（O「明快不少」、Q「一点点」）；
    - 东北话：**基本无效**（E/F/I 均听不出）；
    - 文本平淡时情绪差异难分辨（本轮教训），下一轮 `scripts/tts-emotion-probe.mjs` 已改用
      3 段情绪强烈文本 + 每段独立目录 + 无指令基线对照，试听表见 docs/tts-emotion-test-form.md。
  - 数值参数**可靠**：`audio_params.speech_rate` 实测生效（-50 -> 同文本时长约 2.2 倍）；
    `additions.post_process.pitch`（半音）为同族接口文档化字段。
  - 现行方案：语速/音调走数值参数；**演绎指令 = 第二段 LLM 按文稿内容撰写**（§1.5，主通道），
    失败回退预设 instruct；方言走 explicit_dialect（不再拼进 context_texts，见 §2.3.2）；
    转写文稿的语气措辞（风格预设 prompt）仍是"人设"
    的主通道；LLM 自行插入的 `[#...]` 标签提取后优先于一切（明确意图）。

### 2.4 音频回传与播放（云 provider 通用）

- Host 合成得音频 Buffer → `ctx.webServer` 注册临时路由 `/voice/audio/<id>` →
  Client `<audio src>` 播放。**不用 dataURL 做主通道**（base64 +33%，host.call JSON 大 payload 有风险）；
  dataURL 仅用于设置页试听等小片段。
- 双向流播放：Client 轮询 `streamNext` 取段；**pcm 段直接 Int16→Float32 建 AudioBuffer**（无解码延迟，
  切在哪都无缝），mp3 兜底段走 `decodeAudioData`；Web Audio lookahead 调度无缝连播，首段 0.03s 内起播，
  后续段按上一段结束时刻精确衔接；预取 ≤3 段。无 AudioContext / 被浏览器策略挂起 → 回退顺序 `<audio>`。
  首次用户交互时预热 `AudioContext`。
- **缓存防膨胀**：音频段只存内存、取一次即删（一次性路由）；run 结束后 8s 由 `disposeRun` 兜底
  清掉未消费段并摘注册——pcm 段更大，保证不会滞留堆积（转写稿缓存仍是纯文本，不受影响）。
- 停止：Host `AbortController` 中断合成请求 + 摘除路由；Client 停掉已调度 source /
  `audio.pause()` / `speechSynthesis.cancel()`。

## 3. 播报状态机

```
idle → transcribing(转写中) → speaking(播报中) → idle
                    ↓ 失败/超时              ↓ 停止(用户/新turn)
               fallback(直读)或 error(提示)  → idle
```

- 并发规则（v1）：全局单播——新播报打断当前播报；`voice.stopOnNewTurn` 已实现：Host 在 `turn/start`
  自增 `turnGeneration`，Client 轮询发现 gen 变化即停旧播报。
- 双向流流式（`interface='bidirection'`）：`speak` 立即返回 `{mode:'stream', runId}`，管线后台跑；
  Client 经 `streamNext` 轮询取音频段顺序 `<audio>` 播放；`voice.stop` 中止 LLM + CancelSession +
  清播放队列；双向流失败/零音频自动降级 HTTP 单向整段（warn 提示）。
- 成本门控：`tts.provider` 为云 provider（volcengine）时，自动播报需
  `voice.autoSpeakCloudTts=true`（默认 false），否则自动播报跳过并 toast 提示；
  手动"朗读"按钮不受此限。
- 状态同步：Client 本地 state + `shell.overlay` toast / turnTail 徽标；Host 侧记录最近一次播报结果供查询。

## 4. settings.yaml 命名空间（`voice:`）定稿

```yaml
voice:
  autoSpeak: false            # 每轮结束自动播报
  autoSpeakCloudTts: false    # 自动播报允许使用云 TTS（默认关：云 TTS 仅手动按钮触发）
  language: auto              # auto|zh|en|yue|shanghai|henan|beijing|tianjin|sichuan|shaanxi|dongbei
                              # 固定语种/方言时无论原文语言都按所选转写；8 种方言统一走 vv + explicit_dialect（实测生效）
  provider: ""                 # 转写 LLM provider（空=启动发现；配错自动回退并自愈写回可用路由）
  model: deepseek-v4-flash
  transcribe:
    enabled: true             # 主开关：关=不调模型，直接读原文（去 Markdown）
    maxTokens: 8192           # 推理模型先烧 reasoning token；撞顶无正文自动 4 倍重试
    temperature: 0.3
    prompt: ""                # stylePreset=custom 时生效的自定义 prompt
    reasoningEffort: off      # '' = 跟随适配器默认；off(关闭思考)|minimal|low|medium|high|max 等"抽象档位"，跨 provider 词汇不同
                              #   deepseek: off|low|high|max；火山 doubao-seed-2.0: minimal|low|medium|high（无 off，"关闭思考"=minimal/none）
                              #   模型不支持的档位自动降级到语义最近档（off→minimal/low）；非推理模型忽略该字段；降级对用户可见
    stylePreset: standard     # standard(标准=高还原) | companion(陪伴=摘要+情绪) | playful(俏皮=摘要+幽默) | custom
                              #   旧值 ambiguous/default/energetic 自动回退 standard；陪伴/俏皮自带"总结摘要+个性化情绪"，不再有独立简报模式
    contextTurns: 2           # 引用上文：转写携带最近 N 轮用户输入+播报文稿（陪伴/俏皮的情绪捕捉依赖它）
    timeoutMs: 60000          # 单次转写超时；超时/失败降级为直读（§1.4）
  tts:
    provider: browser         # browser | volcengine（openai-compatible 已从设置页移除；
                              #   存量配置该旧值经 ttsProviderOf 归一为 browser，不炸启动）
    browser:
      rate: 1.0               # 语速滑块 0.5–2.0
      pitch: 1.0              # 音调滑块 0.5–2.0
      voice: ""               # 浏览器语音名（可空）
    volcengine:
      apiKey: ""              # 方舟专属 API Key（settings.yaml 为明文文件，注意保管）
      resourceId: seed-tts-2.0
      speaker: zh_female_vv_uranus_bigtts  # Vivi 2.0；下拉另含 中文4男4女 + 英文3音色 + 自定义输入
      sampleRate: 24000       # 8000|16000|24000|44100|48000
      rateLevel: 2            # 语速五档 0很慢–4很快（2=正常）；经数值 speech_rate 参数实现
      pitchLevel: 2           # 音调五档 0很低–4很高（2=正常）；经 additions.post_process.pitch 实现
      # —— 双向流（2026-08-21 新增，带默认值，向后兼容）——
      interface: bidirection  # bidirection=WS 双向流（默认；设置页不暴露手动切换）| http=仅内部降级兜底
      streaming: true         # 双向流下启用"边转写边合成边播"
      wsUrl: ""               # 空=plan 网关；可指 V3 网关（需对应 Key）
      emotionGranularity: paragraph  # paragraph=按段动态情感（默认）| message=整条单会话 | off=仅预设指令
      bitRate: 64000          # MP3 比特率（mp3 专用：仅 HTTP 单向生效；双向流用 pcm 无此参数）
      loudness: 0             # 音量 [-50,100]（0=不变）
      useSectionId: true      # additions.section_id（跨次合成语气连续）
      expressive: false       # req_params.model=seed-tts-2.0-expressive（表现力增强）
  stopOnNewTurn: true
```

> 以上字段已在 `lib/index.js` 的 `VoiceSettingsSchema` 定稿（2026-08-18 Phase 2）；
> 设置页（settings.section「语音播报」）可全部可视化编辑 + 试听；改动 schema 需评估对存量 settings.yaml 的影响。
> **设置页层级（2026-08-21 整改，通用→专属 / 主→次）**：基本配置 = ① 播报方式（TTS 引擎）下拉
> （Windows 系统 TTS / 豆包 TTS）② 是否需要转写模型（关=直读，表格/代码跳过）③ 自动播报。
> 选中某引擎只展开该引擎专属区：Windows=语速/音调/语音名；豆包=鉴权→发音（音色/语种·方言/语速/音调/音量）→
> 音频（sampleRate/bitRate）→双向流（流式/情感粒度/连续/表现力/WS 地址；interface 已从 UI 移除，HTTP 仅内部兜底）。
> `language` 归入豆包「发音」区展示；`resolvePrompt` 仅在豆包引擎下叠加语种/方言要求（Windows 按原文）。
> 文本净化统一走 `lib/speech-clean.js` 的 `sanitizeForSpeech`（§1.4）；播放端 Web Audio 无缝调度（§2.3.1/§2.4）。
> **音色↔语种归一（2026-08-23 第 10 轮）**：`lib/voice-compat.js` 提供不变式
> （方言 ⟺ vv；English ⟺ 英文音色；中文/auto 配中文音色）。`getConfig`/`setConfig`/`speak`/`preview`
> 均经 `normalizeVoiceConfig` 归一（静态定序：方言→vv、English→英文音色、其余保持），保证
> **UI 显示 = 实际发声**；设置页交互为"后改字段胜出"双向纠错（§5.5）。旧的 `emotion`/`emotionScale`
> （1.0 数值情感）与 `useServerCache`（服务端缓存，见 §2.3.1）已从 schema 移除。
> **思考档位降级机制**：`reasoningEffort` 是"抽象档位"，跨 provider 词汇不一致。Host 播报前先经
> `llm.resolveModelInfo` 查当前模型的真实档位列表（结果按 `provider/model` 缓存），配置档位不被支持时按
> `EFFORT_FALLBACK`（lib/index.js）降级到语义最近档（`off`→`minimal`→`low`）；非推理模型直接忽略该字段；
> 能力信息缺失/过期时走运行时兜底（`prepareCall` 抛 "does not support reasoning effort" 后按降级链重试，
> 最后兜底为不发档位字段）。降级通过播报响应的 `effortMapped`/`effortNote` 对用户可见
> （Client console.warn + 设置页黄色警告）。
> 语音指令/引用上文语法（`[#...]`）曾参考官方存档 `docs/research/volcengine-ark-speech.txt` 与
> 用户提供的《豆包语音_语音指令与标签》PDF；**2026-08-19 实测更正：该语法在此 Agent Plan 单向接口
> 不生效（照读）**，详见 §2.3；音色 ID 见《豆包语音_音色列表》PDF。

## 5. Phase 2 新增能力（2026-08-18）

### 5.1 语种/方言选择（`voice.language`）
- `auto`（默认）：跟随原文主体语言；
- 固定语种/方言：转写 prompt 追加"必须用 X 输出"；
- 方言（如北京话）**影响转写文稿的语汇**（用字保持中文书写习惯、语汇贴近该方言口语），
  发音经 `additions.explicit_dialect` 下发（不再拼进 context_texts「用X说」，见 §2.3.2）。

### 5.2 播报风格预设（`voice.transcribe.stylePreset`，2026-08-21 重组为三档）

- **三档 + custom，取消默认/活力/暧昧，取消独立"简报模式"（readMode）**——陪伴/俏皮自带
  "总结摘要 + 个性化情绪与台词"：
  - `standard` 标准：`TRANSCRIBE_SYSTEM` 基线，**对原文还原度最高**（完整逐条口播，不改原意）；
  - `companion` 陪伴：基线 + "温柔的陪伴者"人设——**捕捉用户输入中的情绪并温柔回应**（依赖
    `contextTurns` 提供的"本轮用户问"）、**允许总结/简写**（不必逐句）、保留关键信息/数字/结论；
  - `playful` 俏皮：基线 + "幽默的开发搭子"人设——捕捉用户情绪/事件点并玩笑化解、总结/简写、
    保留关键信息；
  - `custom` = 使用 `transcribe.prompt` 的自定义文本；可主动写 `[#指令]`（Host 提取进
    context_texts、不让进 text）。
- 旧值 `ambiguous/default/energetic` 自动回退 `standard`（存量 settings.yaml 无需迁移）。
- `instruct` 仅作**回退兜底**（主通道是内容驱动的演绎指令，见 §1.5）；设置页"风格预设"下拉切换，
  选预设时 textarea 只读显示模板；选"自定义"后可自由编辑。

### 5.3 引用上文（`voice.transcribe.contextTurns`）
- 转写时组装最近 N 轮（默认 2）的上下文：用户输入 + 已播报文稿；
- 上下文块标注"仅供参考，不要转写"；帮助 LLM 把握语境、情绪与术语一致性；
- （2026-08-19 实测更正：此前曾把本轮用户输入以 `[#上文：…]` 注入豆包 TTS 文本，该接口不解析
  会照读，此注入已移除；引用上文仅用于转写语境。）

### 5.4 火山语速/音调（`rateLevel`/`pitchLevel`）
- Agent Plan 存档文档未列语速/音调参数，但**实测数值参数可用**（2026-08-19，见 §2.3）；
- 实现为五档定性滑块（很慢/稍慢/正常/稍快/很快），映射 `speech_rate = [-50,-25,0,30,60]`、
  `pitch = [-6,-3,0,3,6]` 半音（经 `additions.post_process.pitch`）；2=正常档不发送参数。

### 5.5 音色选择（`voice.tts.volcengine.speaker`）
- 设置页提供 select 下拉（与其他下拉显示一致）+「自定义」选项可输入任意音色 ID
  （原 datalist 方案在部分浏览器会按输入框当前值过滤候选项、只显示一项，已废弃）；
- 精选 2.0 音色（2026-08-23 起，经 `scripts/tts-voice-avail-probe.mjs` 在 plan 网关 +
  双向流实测可用）：中文女声 Vivi 2.0 / 小何 / 邻家女孩 2.0 / 高冷御姐 2.0 / 撒娇学妹 2.0，
  中文男声 云舟 2.0 / 小天 2.0 / 刘飞 2.0 / 阳光青年 2.0，英文 Tim / Dacey / Stokie；
- **音色↔语种配对（2026-08-23 第 10 轮重做为"音色锚定"双向自适应，voice-compat.js）**：
  - 不变式：方言 ⟺ vv；English ⟺ 英文音色；中文/auto 配中文音色（含 vv）。
  - **交互 = 后改的字段胜出**（设置页）：
    - 改语种：选方言 → 音色自动 vv；选 English → 自动切英文音色（Tim 兜底）；zh/auto → 保持；
    - 改音色：选英文音色 → 语种自动 English；选中文音色（如"小何"）而语种是方言/English → 语种自动
      改普通话；选 vv → 保持（仅 en 时改普通话）。
    - **不再锁定/禁用音色下拉**——"选了河南话就不能选小何"这类简单粗暴已废除；
  - **静态（settings.yaml 直改冲突）**：`normalizeVoiceConfig` 确定性定序——方言→vv、English→英文音色、
    zh/auto 保持（如实反映显式配置，不静默翻转）。
  - `getConfig`/`setConfig`/`speak`/`preview` 统一用归一化视图，UI 显示 = 实际发声。
- 自定义音色未实测，UI 标注"不保证功能正常"；完整音色列表见用户提供的《豆包语音_音色列表》PDF。

### 5.7 重新生成按钮（2026-08-23 第 10 轮）

- 「朗读」按钮旁新增 **↻ 重新生成**：仅在该消息**完整朗读过一次**后显示（`spokenState[messageId]==='done'`）；
  点击后 `speak { regen:true }` → **跳过转写缓存与指令缓存，用当前配置全新转写+合成**（改音色/语速/风格后
  想看新效果）。
- **重播零 LLM（第 11 轮）**：重播 = 把刚生成的东西重新播一遍，**不重新生成任何东西**——转写文字与
  情感指令**都用缓存**（HTTP 与双向流一致）。双向流重播时段落照常切分（音频分段）但复用缓存指令、
  不再按段调 LLM。缓存缺指令（极短文稿/旧条目）= 初次本就没生成，重播同样不补。
- **重新生成（↻）** = 转写 + 情感指令**全部重新生成**（force 跳过缓存），结果覆盖该 messageId 条目
  （单键覆盖 + `CACHE_LIMIT=200` 截断 + audioStore 一次性即删 + `disposeRun` 8s 兜底 → 不膨胀）。
- **流式/HTTP 缓存统一**（审计 A7 修复）：同一 messageId 两种路径共用同一形状
  `{ transcript(净化稿), provider, model, prompt, effort, sourceChars, at, instruction, emotion, intensity }`；
  **流式也读缓存**（regen 除外）；仅**转写完整**时写缓存（WS 中途失败不污染，降级走 HTTP 时命中完整稿）。

### 5.6 健壮性与可视化（2026-08-18 收尾）
- 转写超时：`transcribe.timeoutMs`（默认 60s），超时/失败 → 降级直读（§1.4）；
- `turnTail` 徽标：conversation Definition 把每轮最后一条含 text 的助手消息 id 写进 turn 数据（key `voice`），
  徽标只 claim 本轮已朗读过的 turn（`select` 返回 null 让位），不与 deliverables 产物链冲突；
  显示"已朗读 ✓ / 朗读中…"，点击重播（缓存命中，秒出）；
- i18n：client 注册 `voice` locale 命名空间（zh/en 词典），按钮/开关/徽标/设置页标签随系统语言。
