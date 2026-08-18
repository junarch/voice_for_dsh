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
  仅当 provider/model/prompt 三者与当前配置完全一致才命中——同一消息重复点"朗读"、dsh 重启后再点，都直接复用不再调 LLM。

### 1.4 降级直读（fallback，已实现）

不调用 LLM 的纯文本提取（`toPlainSpoken`：代码块→"此处有一段代码"、表格行→逗号连接、URL→域名、
剥 Markdown 标记）。触发：转写抛错 / 超时（`transcribe.timeoutMs`，默认 60s）/ 撞顶重试后仍空稿。
降级稿**不写缓存**（下次点击仍重试转写），响应带 `degraded: true`，Client 提示后照常播报。

## 2. TTS Provider 适配层

> **不引第三方 TTS 适配器库**。调研结论（见 `docs/research/plan-review-tts-adapter-report.html`）：
> 无现成 JS 库支持火山引擎 v3 接口；候选库（lobe-tts / edge-tts / LiteLLM 等）要么不覆盖火山、
> 要么过重或维护不稳。插件内自研薄适配层：统一接口 + 每 provider 一个文件（约 100–150 行），
> 零新增 npm 依赖，新增供应商 = 加一个文件。

```ts
interface TtsProvider {
  id: 'browser' | 'openai-compatible' | 'volcengine'
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

### 2.2 `openai-compatible`

- 兼容 OpenAI 的 `POST {baseUrl}/audio/speech`：`{ model, input, voice, response_format }` → 音频二进制。
- 可接 new-api / one-api 等自建中转站（如果你已有聚合网关，火山等渠道也可经此间接接入）。
- 由 **Host 半** Node `fetch` 拉取（凭据不出 Host）。
  注意：`ctx.web` 只是 search/fetch 能力缝（`WebFetchRequest` 仅 `url`，不能 POST/鉴权头/二进制），
  **不能**用于 TTS 外呼；创造模式动态沙箱禁 `fetch`，故此 provider 只能在正式 bundle 中工作。

### 2.3 `volcengine`（v1 主力）

- 模型：豆包语音合成模型 2.0（`doubao-seed-tts-2.0`），头 `X-Api-Resource-Id: seed-tts-2.0`，
  鉴权 `X-Api-Key: <方舟专属 API Key>`。
- **接口选择：HTTP 单向**（`POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`）。
  与 WebSocket 单向流式的取舍（v1 选 HTTP 的理由）：

  | | HTTP 单向 | WS 单向流式 |
  |---|---|---|
  | 协议 | 普通 POST，响应 chunked JSON 行 | 官方自定义二进制帧协议（protocols.py：消息头/事件/序号/gzip） |
  | 实现量 | ~100–150 行（fetch + 逐行解析） | WS 客户端 + 帧编解码 + 会话生命周期，数倍复杂度 |
  | 音频回传 | base64 JSON 行（+33% 体积） | 二进制帧无膨胀，可逐帧边收边播 |
  | 连接 | 每次独立连接（TLS 握手开销） | 长连接复用，连续合成延迟更低 |
  | 调试/故障面 | curl 可复现；失败即重发 POST | 断线重连/半开连接/会话恢复需自理 |

  v1 是"整段转写完 → 一次合成 → 整段播放"的串行模式，WS 的长连接复用与逐帧流播都用不上；
  v2 做流式朗读时再升级 WS（provider 接口已隔离，替换 `volcengine.ts` 内部实现不影响其他层）。
- 请求体：`{ req_params: { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }`。
- 响应：chunked JSON 行——`{code:0, data:<base64 音频段>}` 累加；`{code:20000000}` 结束；
  其他 code = 错误。全部段拼接 base64 解码 → 完整 mp3。
- 长文本：单次请求文本上限待实测（PLAN §7 风险表）；超长文稿按段落切分、串行合成、顺序播放。
- 情绪/语气：方舟 Agent Plan 此接口文档未含情绪参数（官方 PDF 存档
  `docs/research/volcengine-ark-speech.txt`）；v1 只支持多音色（`speaker`）选择，
  情绪控制能力（若需要）在另一套语音合成大模型接口文档，留待后续评估。

### 2.4 音频回传与播放（云 provider 通用）

- Host 合成得音频 Buffer → `ctx.webServer` 注册临时路由 `/voice/audio/<id>` →
  Client `<audio src>` 播放。**不用 dataURL 做主通道**（base64 +33%，host.call JSON 大 payload 有风险）；
  dataURL 仅用于设置页试听等小片段。
- 停止：Host `AbortController` 中断合成请求 + 摘除路由；Client `audio.pause()` /
  `speechSynthesis.cancel()`。

## 3. 播报状态机

```
idle → transcribing(转写中) → speaking(播报中) → idle
                    ↓ 失败/超时              ↓ 停止(用户/新turn)
               fallback(直读)或 error(提示)  → idle
```

- 并发规则（v1）：全局单播——新播报打断当前播报；`voice.stopOnNewTurn` 已实现：Host 在 `turn/start`
  自增 `turnGeneration`，Client 轮询发现 gen 变化即停旧播报。
- 成本门控：`tts.provider` 为云 provider（openai-compatible / volcengine）时，自动播报需
  `voice.autoSpeakCloudTts=true`（默认 false），否则自动播报跳过并 toast 提示；
  手动"朗读"按钮不受此限。
- 状态同步：Client 本地 state + `shell.overlay` toast / turnTail 徽标；Host 侧记录最近一次播报结果供查询。

## 4. settings.yaml 命名空间（`voice:`）定稿

```yaml
voice:
  autoSpeak: false            # 每轮结束自动播报
  autoSpeakCloudTts: false    # 自动播报允许使用云 TTS（默认关：云 TTS 仅手动按钮触发）
  language: auto              # auto|zh|en|yue|shanghai|henan|beijing|tianjin|sichuan|shaanxi|dongbei
                              # 固定语种/方言时无论原文语言都按所选转写；方言发音经豆包 [#指令] 实现
  provider: deepseek-official # 转写 LLM provider（配错自动回退到"第一个已注册路由"）
  model: deepseek-v4-flash
  transcribe:
    maxTokens: 8192           # 推理模型先烧 reasoning token；撞顶无正文自动 4 倍重试
    temperature: 0.3
    prompt: ""                # stylePreset=custom 时生效的自定义 prompt
    reasoningEffort: off      # '' = 跟随适配器默认；deepseek: off(关闭思考)|low|high|max；不支持自动降级
    stylePreset: default      # default|playful(俏皮)|ambiguous(暧昧)|energetic(活力)|custom
    readMode: default         # default=完整转写 | brief=简报模式（一两句话说清结论，忽略细节；忽略风格预设与自定义 prompt）
    contextTurns: 2           # 引用上文：转写携带最近 N 轮用户输入+播报文稿（0=关闭）
  tts:
    provider: browser         # browser | openai-compatible | volcengine
    browser:
      rate: 1.0               # 语速滑块 0.5–2.0
      pitch: 1.0              # 音调滑块 0.5–2.0
      voice: ""               # 浏览器语音名（可空）
    openaiCompatible:
      baseUrl: ""             # 如 https://your-gateway/v1
      apiKey: ""
      model: tts-1
      voice: ""
      format: mp3
    volcengine:
      apiKey: ""              # 方舟专属 API Key（settings.yaml 为明文文件，注意保管）
      resourceId: seed-tts-2.0
      speaker: zh_female_vv_uranus_bigtts  # Vivi 2.0；下拉另含 邻家女孩/撒娇学妹/高冷御姐 2.0，可自定义
      sampleRate: 24000       # 8000|16000|24000|44100|48000
      rateLevel: 2            # 语速五档 0很慢–4很快（2=正常）；经 [#语音指令] 实现
      pitchLevel: 2           # 音调五档 0很低–4很高（2=正常）
  stopOnNewTurn: true
```

> 以上字段已在 `lib/index.js` 的 `VoiceSettingsSchema` 定稿（2026-08-18 Phase 2）；
> 设置页（settings.section「语音播报」）可全部可视化编辑 + 试听；改动 schema 需评估对存量 settings.yaml 的影响。
> 语音指令/引用上文语法（`[#...]`）见官方存档 `docs/research/volcengine-ark-speech.txt` 与
> 用户提供的《豆包语音_语音指令与标签》PDF；音色 ID 见《豆包语音_音色列表》PDF。

## 5. Phase 2 新增能力（2026-08-18）

### 5.1 语种/方言选择（`voice.language`）
- `auto`（默认）：跟随原文主体语言；
- 固定语种/方言：转写 prompt 追加"必须用 X 输出"；方言（如北京话）额外在豆包 TTS 文本前注入 `[#用北京话播报]` 指令；
- 浏览器 TTS 不支持方言指令，仅影响转写文稿的语汇。

### 5.2 转写模式与播报风格预设（`voice.transcribe.readMode` / `stylePreset`）
- `readMode`：`default` = 完整转写（§1.2 基线规则）；`brief` = **简报模式**（内置简报 prompt：一两句话说清
  "做了什么/结论是什么"，100 字以内，忽略过程细节；简报模式下风格预设与自定义 prompt 不生效）；
- `stylePreset`（仅默认模式生效）：`default` = 内置基线，不含语音指令标签；
  `playful` / `ambiguous` / `energetic` = 基线 + 语气风格规则 + 允许插入极少量 `[#...]` 标签；
  `custom` = 使用 `transcribe.prompt` 的自定义文本；
- 设置页"风格预设"下拉切换，选预设时 textarea 只读显示模板；选"自定义"后可自由编辑。

### 5.3 引用上文（`voice.transcribe.contextTurns`）
- 转写时组装最近 N 轮（默认 2）的上下文：用户输入 + 已播报文稿；
- 上下文块标注"仅供参考，不要转写"；帮助 LLM 把握语境、情绪与术语一致性；
- 豆包 TTS 额外在文本前注入 `[#上文：本轮用户输入]` 引用指令（只引用不合成）。

### 5.4 火山语速/音调（`rateLevel`/`pitchLevel`）
- 豆包 2.0 的语速/音调**无数值参数**，官方文档明确通过 `[#语音指令]` 控制；
- 实现为五档定性滑块（很慢/稍慢/正常/稍快/很快），映射为 `[#语速稍快一点]` 等指令前缀。

### 5.5 音色选择（`voice.tts.volcengine.speaker`）
- 设置页提供下拉（datalist，可自由输入）；
- 内置 4 个音色：Vivi 2.0 / 邻家女孩 2.0 / 撒娇学妹 2.0 / 高冷御姐 2.0；
- 完整音色列表见用户提供的《豆包语音_音色列表》PDF。

### 5.6 健壮性与可视化（2026-08-18 收尾）
- 转写超时：`transcribe.timeoutMs`（默认 60s），超时/失败 → 降级直读（§1.4）；
- `turnTail` 徽标：conversation Definition 把每轮最后一条含 text 的助手消息 id 写进 turn 数据（key `voice`），
  徽标只 claim 本轮已朗读过的 turn（`select` 返回 null 让位），不与 deliverables 产物链冲突；
  显示"已朗读 ✓ / 朗读中…"，点击重播（缓存命中，秒出）；
- i18n：client 注册 `voice` locale 命名空间（zh/en 词典），按钮/开关/徽标/设置页标签随系统语言。
