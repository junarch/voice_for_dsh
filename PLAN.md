# DSH 语音朗读插件（voice-for-dsh）开发计划

> 目标：为 DeepSeek Harness Web（dsh web）编写一个插件，在每轮 DeepSeek 输出结束后，
> 先把输出内容做"口语化转写"（去除/改写代码、表格、Markdown 标记等不适合朗读的部分），
> 再通过 TTS 播报出来。Web 界面提供开关按钮：开启 = 每轮结束自动播报；
> 关闭 = 不自动播报，但每条助手消息上保留一个"转写并朗读"按钮，手动触发。

---

## 0. 结论速览（TL;DR）

- **插件形态**：一个同时包含 **Host 半（node）+ Client 半（browser）** 的 Cordis 插件包（`dsh.bundle` 组合包），
  安装到 `web` profile（`C:\Users\junar\.dsh\profiles\web`），通过 `dsh plugin --profile web <pnpm args>` 管理。
- **口语化转写**：在 **Host 半** 用 `ctx.llm`（`prepareCall` + `stream`）调用已配置的模型
  （复用用户的 DeepSeek / 阿里云百炼 / 全智 provider），一次独立的辅助 LLM 调用，把 `assistant/message` 的正文
  转写成自然口语文稿。**不直接把原文喂给 TTS**。
- **TTS 播报**：采用 **Provider 适配器架构**（自研薄适配层，每 provider 一个文件）：
  `browser`（浏览器 `speechSynthesis`，零配置兜底）/ `openai-compatible`（兼容中转站）/
  `volcengine`（火山引擎 doubao-seed-tts-2.0，v1 主力，走 **HTTP 单向接口**：一个 POST 拿完整 mp3）。
  云 TTS 由 Host 半（正式 bundle = 普通 Node 模块，可直接 fetch）拉取音频，
  经 `ctx.webServer` 临时路由交给浏览器 `<audio>` 播放（dataURL 仅用于试听小片段）。
  成本控制：`voice.autoSpeakCloudTts` 默认关——云 TTS 默认仅手动按钮触发。
- **每轮结束自动播报**：Client 半监听会话事件流（mux/`session/event`），在 `assistant/message` + `turn/end`
  之后判定"一轮结束"，若开关为开则自动走"转写 → 播报"。
- **手动按钮**：注册到 `conversation.chat.assistant-actions` 槽（与点赞/点踩同一排），
  按钮上显示"朗读"；点击后对**该条消息**做转写并播报。
- **开关**：优先放 `conversation.input.left`（输入框工具行）或 `conversation.session.header.actions`
  （会话头部按钮行）；持久化到 `settings.yaml` 的独立命名空间（如 `voice`），Host 注册 `settings` 命名空间，
  Client 用 `ctx.settingsScope` 读写。
- **创造模式（cordis preset）**：用户问的"创造模式"就是 `cordis` agent preset（`dsh` 内置四个 preset：
  `standard`=标准模式、`code`=PTC 模式、`minimal`=极简模式、`cordis`=创造模式）。
  创造模式 = 标准模式全部能力 + Cordis 运行时检查/插件实验/预设创作工具（`cordis_inspect_*`、`cordis_define`、`cordis_run` 等）。
  **开发测试方式**：在 Web 界面新建会话时选择"创造模式"preset，在该会话里让 agent 用 Cordis 工具
  现场 define/run 动态插件（`tool.view.cordis` 卡片交互）。这是动态插件（临时、进程内、可审批）的试验场；
  本插件要**长期使用**，应作为正式组合包（bundle）安装到 profile，而不是只靠动态插件。

---

## 1. 背景与已验证事实（调研结论）

### 1.1 DSH 版本与安装位置

- `@deepseek-ai/dsh` `0.1.0-rc.6`，npx 缓存检出：`C:\Users\junar\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`
- `DSH_HOME=C:\Users\junar\.dsh`；`web` profile 位于 `C:\Users\junar\.dsh\profiles\web`，
  其 `package.json` 的 `dsh.profile.bundles` 目前为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`
- 用户 settings：`C:\Users\junar\.dsh\settings.yaml`（已配置 `llm-pi-ai.providers.aliyuncs` 与 `quanzil`，
  默认 agent 模型 `quanzil/deepseek-v4-flash-0731`）
- Web 界面：`http://127.0.0.1:3080`（`dsh --profile web`）

### 1.2 插件如何安装（dsh plugin）

- `dsh plugin --profile web <pnpm args>` = 在 profile 目录里转发给 pnpm（`add/remove/update`），
  随后按"已安装依赖是否声明 `dsh.bundle`"自动 reconcile `dsh.profile.bundles` 列表
  （`@deepseek-ai/dsh/plugin`：`exportsPatch` 读取包 manifest 的 `dsh.bundle.patch`）。
- 相对路径参数（`.`、`../x`、`file:`/`link:` 前缀）会锚定到**调用 dsh 时的 cwd**。
- 所以开发流程可以是：`dsh plugin --profile web add ../packages/dsh-plugin-voice`（或 `link:`），
  让 pnpm 把本仓库的包链接进 profile，插件补丁作为新 bundle 层自动加入。
- pnpm 构建脚本被阻止时需在 `profiles\web\pnpm-workspace.yaml` 的 `allowBuilds` 白名单加包名（本插件纯 JS 应无需）。

### 1.3 插件架构：bundle 补丁 + 双半插件

- **bundle**：一个 npm 包，`package.json` 里声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`），
  该 YAML 是一系列 `insert:` 行，往 profile 配置树加插件行；按 `- insert:` / `- id: xxx` 定位。
- **插件行**：`{ id, name: '@scope/pkg', config: {...} }`；name 解析顺序：dsh 安装目录 →
  profile 自身 `node_modules`。所以**本地开发包先装进 profile 的 node_modules**。
- **双半插件**（如 `@deepseek-ai/dsh-client-ui-deliverables` 的模式）：
  - 包内 `client.js`（`window.__ModuleLoader__.load({ id, factory })` 格式）是浏览器半，由 client-modules 扫描
    `dsh.client` 声明后经 `/plugins/<id>/client.js` 注入 `window.__DSH_BOOT__`；
  - `lib/index.js`（Cordis 插件，`apply(ctx)`）是 Host 半；
  - 两者通过 `harness.handle(method, handler)`（Host 注册）与 `host.call(method, args)`（Client 调用）做
    Package-private JSON RPC。
- **Client 半可用闭包符号**（`dsh-cordis-client-runner` 的 `CLIENT_BUILTIN_INSPECTION`）：
  `ctx`（`get/on/provide/effect`）、`React`（`createElement`、hooks）、`host`（`host.call`）、`styles`、`console`。
  禁止 `import/require/JSX/TS`；依赖通过 `inject` 或 `ctx.get`。
- **Host 半可用闭包符号**（`HOST_BUILTIN_INSPECTION`）：`ctx`、`harness`（`handle/defineTool/registerTool`）、
  `console`、`btoa/atob/TextEncoder/TextDecoder`；Node API 经 `ctx.fs`/`ctx.web`/`ctx.bash`/Cordis timer 陷阱。

### 1.4 关键服务与事件（Host 半可用）

- **会话事件**：`ctx.on('session/event', (session, event) => ...)`；事件类型见 `SessionEventMap`：
  `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/chunk`、`assistant/message`
  （`{ turn, step, message: AssistantMessage, usage? }`，`message.content` 为 `ContentBlock[]`，正文在
  `{ type: 'text', text }` 块）、`tool/call`、`tool/result`、`user/message`、`request/header` 等。
  > **订正（2026-08-18 spike 实测）**：运行时的 `SessionEvent` 是**信封结构**
  > `{ type, seq, time, data, sourceEventSeqs, surfaceOp }`，上表 payload 在 **`event.data`** 里；
  > 且 `assistant/message` 含纯 tool-call 步骤消息（无 text 块），取"最近一条"须过滤 text。
- **LLM 调用**：`ctx.llm`（`LlmRuntime`）`prepareCall(config, signal?)` → `PreparedLlmCall.stream(options)`；
  `GenerateOptions` 含 `provider/model/messages/system/temperature/maxTokens/stop/signal/sessionId/purpose`。
  `purpose` 目前只有 `'compaction' | 'session-title'`（类型可扩展；自定义用途传自定义字符串即可）。
- **持久设置**：`ctx.settings`（`SettingsProvider`）`register(namespace, schema, opts)` → `SettingsScope`，
  支持 `get()/watch()/update()/replace()`；`dsh-settings-file` 落到 `$DSH_HOME/settings.yaml`（热重载）。
- **WebServer**：`ctx.webServer.register({kind, path, handler})` 可挂自定义 HTTP 路由（TTS 音频回传用）。
- **出网能力（已核实，订正早期假设）**：`ctx.web`（`@deepseek-ai/dsh-web` 的 `WebRuntime`）只是
  search/fetch 能力缝——`WebFetchRequest` **仅有 `url` 字段**，响应体只分 `html`/`text` 两种 kind：
  **不能 POST、不能自定义鉴权头、不能读二进制音频**，无法用于 TTS 外呼。创造模式动态插件的 Host 沙箱
  还把全局 `fetch` 陷阱为抛错（引导改用 `ctx.web`）。**但正式 bundle 的 Host 半是普通 Node 模块、
  不经沙箱**，可直接用 Node 18+ 全局 `fetch`（含流式响应）调外部 TTS API——这是"成品必须为正式
  bundle"（D9）的又一理由，也意味着创造模式 spike 无法试验 TTS 外呼（见 Phase 1）。
- **Agent/会话**：`ctx.sessions`（`SessionStore`）`list()/get(id)`；`Session.header` 有 `cwd`、`agentPreset` 等。
  会话归属/作用域通过 `@deepseek-ai/dsh-scope`（`Scoped`）按 agent 过滤。

### 1.5 关键槽位与 UI 集成点（Client 半可用）

- `conversation.chat.assistant-actions`：**list** 槽，scope=session，owner props 仅 `{ messageId }`，
  渲染在每条最终助手消息的 IconActions 行（点赞/点踩同排，按 `order` 升序）。
  → 手动"朗读"按钮的最佳位置。
- `conversation.chat.turnTail`：chain 槽，owner 为 `{ turn: TurnLocation, seq, openFile }`，
  每条收尾助手消息下方的尾巴。→ 可放"自动播报状态/本轮已朗读"提示。
- `conversation.session.header.actions`：list 槽，会话头部按钮行 → 自动播报开关的备选位置。
- `conversation.input.left` / `conversation.input.right`：list 槽，输入框工具行左右端 → 开关的另一个位置。
- `settings.section`：list 槽，`settings.section` 注册整页设置；`settings.general.item` 是 General 里的单行偏好。
  → 可加一个"语音播报"设置页（TTS 提供商、语速、音色、模型选择）。
- `shell.overlay`：全局浮层（toast/通知）→ 播报失败/进行中的轻提示。
- **Client 读会话数据**：`useSession`（标准 props）拿到 `ConversationSnapshot`；`chat.nodes`/`chat.locations`
  可定位消息节点（`AssistantMessageNode` 有 `messageId`、`blocks`、`turn`、`step`）。
  也可像 ui-deliverables 那样注册一个 conversation Definition（`conversationEvents.register`），
  把 `assistant/message` 的文本聚合成 turn 数据，供尾部/按钮读取——这是最稳的"消息 id → 文本"路径。
- **Client 远程调用**：`ctx.remote.<namespace>.<method>`（Typert Remote），或对本包自己的 Host 半用 `host.call`。

### 1.6 创造模式（cordis preset）答疑

- `dsh` 内置 preset 元数据（`config/agent-presets/*/preset.yml`）：
  - `standard`：**标准模式**（全功能编码 Agent，order 1）
  - `code`：**PTC 模式**（Code Mode SDK，order 2）
  - `minimal`：**极简模式**（双工具，order 3）
  - `cordis`：**创造模式**（"用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导"，order 4）
- 创造模式 preset 的 persona 明确写着："You can read and modify the harness you run on. Its composition is Cordis…"，
  并自带 `cordis-plugin-development` / `editing-cordis-compositions` 两个 skill。
- **创造模式用法（正是你想问的）**：在 Web 新建会话时选"创造模式" preset → 会话里 agent 拥有
  `cordis_inspect_list/query/self`、`cordis_define/run/stop/undefine` 等工具 → 可以让 agent 现场编写并运行
  动态 Cordis 插件（Host/Client 双半），在 `tool.view.cordis` 卡片上预览、审批（`awaiting-approval` → 打勾）、
  运行、修复（define 新 Package → update）。
- **局限**：动态插件是**进程内、临时**的——重启丢失、不可持久化设置、Client 代码需浏览器授权。
  所以本语音插件的最终形态是**正式 bundle**（写进 profile 的 bundles 列表），
  而**创造模式适合开发试验**（快速原型、验证 `host.call`/槽位注入/事件监听是否可行），
  验证通过后再固化为正式包。

---

## 2. 目标与非目标

### 目标
1. 每轮 DeepSeek 输出结束后，把该轮**最终 assistant 消息正文**做口语化转写，再用 TTS 播报。
2. Web 界面有"自动播报"开关：开 → 每轮结束自动播报；关 → 不自动，但保留手动按钮。
3. 手动按钮：每条助手消息（assistant-actions 行）一个"朗读"按钮，点击转写并播报**当条**输出。
4. 转写必须**不是直接朗读原文**：代码块、表格、Markdown 语法、URL、JSON、diff 等要改写为口语描述；
   由 LLM 转写（可配置模型，默认跟随会话/默认模型）。
5. TTS 可配置：Provider 适配器架构——默认浏览器 `speechSynthesis` 兜底；v1 主力火山引擎
   doubao-seed-tts-2.0（HTTP 单向）；另支持 OpenAI-compatible `/audio/speech`（可接中转站）。
6. 播报中可停止（再次点击停止/全局停止按钮）。
7. 所有持久配置落在 `settings.yaml`（`voice:` 命名空间），UI 上可编辑。

### 非目标（v1 明确不做）
- 不做流式"边生成边朗读"（只读最终消息；流式朗读留待 v2）。
- 不做多语言自动检测之外的额外语言处理（v1 跟随 TTS 引擎能力）。
- 不做完整的语音输入/ASR。
- 不修改 dsh 内核或 shipped preset（遵守"off-limits"：只复制不改写 shipped preset）。
- 不覆盖 `root`/`conversation.session` 等高风险整槽位（只做 additive 小槽位）。

---

## 3. 总体架构

```
┌───────────────────────────── Browser (Client 半) ─────────────────────────────┐
│  UI: 开关(header/input) + 每消息"朗读"按钮 + turnTail 状态 + shell.overlay 提示  │
│  监听: conversationEvents(assistant/message 聚合) / useSession / settingsScope  │
│  播报: speechSynthesis(browser provider) 或 <audio> 播放 Host 经 webserver 路由提供的音频  │
│  通信: host.call('voice.speak', {sessionId, messageId, text})  →  Host          │
└──────────────────────────────────────┬─────────────────────────────────────────┘
                                       │ host.call / remote
┌──────────────────────────────────────▼─────────────────────────────────────────┐
│  Host 半 (Cordis 插件, 随 web profile 常驻)                                     │
│  • ctx.on('session/event') 监听 assistant/message + turn/end → 触发自动播报队列  │
│  • harness.handle('voice.speak'|'voice.stop'|...) 处理 Client 请求              │
│  • 口语化转写: ctx.llm.prepareCall + stream (独立辅助调用, 带专用 system prompt)  │
│  • TTS Provider 适配层: browser(透传 Client speechSynthesis) / openai-compatible /     │
│    volcengine(doubao-seed-tts-2.0, HTTP 单向接口, Node fetch, 长文稿按段串行合成)      │
│  • settings: 注册 voice 命名空间(开关/模型/TTS/语速…) → settings.yaml           │
│  • 会话文本查找: ctx.sessions.get(id).events 里按 messageId 定位 assistant/message│
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 数据流（自动播报，开关=开）
1. Host 半收到 `session/event`：`assistant/message`（记下最新正文）→ `turn/end`（reason.kind ∈
   `completed | 'max-tokens'`，跳过 `aborted/error/blocked/interrupted`）。
2. Host 检查 `voice.autoSpeak=true`（settings，热读）。
3. Host 把该轮最终 `assistant/message` 的 text 块拼接 → 组装"转写请求"（system 提示词 + 原文）。
4. `ctx.llm.prepareCall({ provider, model, ... })` → `stream()` 收集 text-delta → 得到口语文稿。
5. 播报：若 provider=browser → 经 `host.call` 响应/事件把文稿推给 Client，Client `speechSynthesis.speak`；
   若 provider=云（openai-compatible/volcengine）→ Host Node `fetch` 合成音频 →
   经 `ctx.webServer` 临时路由 `/voice/audio/<id>` 提供 → Client `<audio src>` 播放。
   （自动播报 + 云 provider 还需 `voice.autoSpeakCloudTts=true`，否则跳过并提示。）
6. 播报中状态通过 `shell.overlay` toast / turnTail 徽标展示；可点停止。

### 数据流（手动朗读）
1. 用户点某条消息的"朗读"按钮（`assistant-actions` 槽，props.messageId）。
2. Client `host.call('voice.speak', { sessionId, messageId })`。
3. Host 从 `ctx.sessions.get(sessionId).events` 按 `messageId` 找 `assistant/message` → 取 text。
4. 同 3–6（转写 → TTS），但只播这一条。

---

## 4. 目录结构（落盘规划）

```
E:\project\voice_for_dsh\
├── PLAN.md                        # 本计划
├── AGENTS.md                      # 仓库级 agent 指南（本文件）
├── .gitignore                     # node_modules / lib / dist 等
├── pnpm-workspace.yaml            # 仓库自身 workspace（可选，开发期用）
├── package.json                   # 根：脚本（build/watch/dev:web 说明）
├── docs/
│   ├── dsh-plugin-architecture.md # 调研结论：bundle/patch/双半插件/slots/事件（本计划 1.x 展开）
│   ├── voice-pipeline.md          # 转写 prompt 设计 + TTS 接入方案（含示例 system prompt）
│   └── dev-playbook.md            # 创造模式试验手册 + 安装/构建/验证 checklist
└── packages/
    └── dsh-plugin-voice/
        ├── package.json           # name: dsh-plugin-voice（或 @voice/dsh-plugin-voice）
        │                          #   dsh.bundle.patch → ./cordis.patch.yml
        │                          #   exports: . / ./client / ./package.json
        │                          #   dsh.client: { platform: 'web', inject: [...] }
        ├── cordis.patch.yml       # insert: 语音插件 host 行（id: voice）
        ├── tsconfig.json          # 构建用（tsdown/tsc 产物到 lib/）
        ├── src/
        │   ├── host/
        │   │   ├── index.ts       # apply(ctx)：注册 settings 命名空间、session/event 监听、
        │   │   │                   #   harness.handle('voice.*')、llm 转写、TTS 后端分发
        │   │   ├── transcribe.ts  # 口语化转写：prompt 组装 + ctx.llm 调用 + 结果归一
        │   │   ├── tts/           # TTS Provider 适配层（自研，不引第三方适配器库）
        │   │   │                  #   types.ts(统一接口) / browser.ts(透传) /
        │   │   │                  #   openai-compatible.ts(/audio/speech) /
        │   │   │                  #   volcengine.ts(HTTP 单向, ~150 行, 零新增依赖)
        │   │   ├── session-text.ts# 按 messageId 从 Session.events 提取 assistant 文本
        │   │   └── settings.ts    # voice 命名空间 schema（schemastery）与默认值
        │   └── client/
        │       ├── index.ts       # 浏览器半 apply(ctx)：注册槽位、conversation definition、
        │       │                   #   host.call 封装、speechSynthesis/audio 播放器
        │       ├── slots.ts       # assistant-actions 朗读按钮 + header 开关 + turnTail 状态
        │       ├── player.ts      # speechSynthesis 封装（队列、停止、语速/音色）
        │       ├── definitions.ts # conversationEvents 注册：assistant/message 文本聚合(turn 数据)
        │       └── locales.ts     # zh/en 文案（NS='voice'）
        ├── lib/                   # 构建产物（gitignore）
        └── README.md              # 插件使用说明（安装/配置/权限）
```

> 说明：Client 半的产物格式必须匹配 `window.__ModuleLoader__.load({ id, factory })`
> （参考 `dsh-client-ui-deliverables/lib/client.js`），构建链与 `dsh-client-*` 一致（tsdown 打包、
> 导出 `./client`）。Host 半是普通 ESM Cordis 插件。开发期可先用"单一 package + 手写 bundle 脚本"，
> 再逐步对齐官方 `tsdown` 产物（HMR：`pnpm run dev:web` 会重建 client bundle，浏览器无刷新加载；
> Host 半改动需重启 dsh）。

---

## 5. 实现步骤（按依赖排序，每步可独立验证）

### Phase 0：地基（本仓库）
- [ ] 根 `package.json`（private）+ `pnpm-workspace.yaml` + `.gitignore` + 本 `PLAN.md`/`AGENTS.md`。
- [ ] `docs/` 三篇文档（架构结论、转写/TTS 设计、开发手册）。

### Phase 1：最小可行插件（MVP，验证链路）
- [x] **创造模式 spike（先于正式包代码）**：在创造模式会话用动态插件验证三件事——
      ① `ctx.llm.prepareCall`/`stream` 签名与凭据解析；② `assistant-actions` 槽位注入；
      ③ `host.call` 双半通信。注意：动态沙箱禁 `fetch`、且 `ctx.web` 仅支持 GET 抓取，
      **spike 不含 TTS 外呼**（云 TTS 链路留到正式包阶段验证，或先用独立本地脚本对火山接口冒烟）。
      **✅ 2026-08-18 完成**（voice-1 pkg-8，端到端出声成功；结论见 `docs/dev-playbook.md` §5）。
- [ ] `packages/dsh-plugin-voice` 包骨架：`package.json`（`dsh.bundle.patch`、`dsh.client`、exports）、
      `cordis.patch.yml`（insert `id: voice` 行）。
- [ ] Host 半 v1：
      - `apply(ctx)`：`settings.register('voice', schema)`——**schema 一次按 provider 分组定稿**
        （避免后续迁移用户 settings.yaml）：`autoSpeak`、`autoSpeakCloudTts: false`、
        转写 `provider/model`、`tts.provider: browser|openai-compatible|volcengine`、
        `tts.browser.{rate,pitch,voice}`、`tts.openaiCompatible.{baseUrl,apiKey,model,voice,format}`、
        `tts.volcengine.{apiKey,resourceId,speaker,sampleRate}`、`stopOnNewTurn`；
      - `harness.handle('voice.speak', ...)`：入参 `{ sessionId, messageId }` → 提取文本 →
        转写（固定用默认/配置 provider）→ 返回 `{ transcript }`（v1 先只返回文稿，TTS 下一步）；
      - `ctx.on('session/event')`：`assistant/message` + `turn/end` 收集 → 若 `autoSpeak` 触发
        `voice.speak` 流程（并发去重：同一 turn 只触发一次；新 turn 开始停止旧播报）。
- [ ] Client 半 v1：
      - `assistant-actions` 槽注册"朗读"按钮（`host.call('voice.speak')` → 用 `speechSynthesis` 播报返回文稿）；
      - `conversation.input.left` 注册自动播报开关（读/写 `voice` settings 命名空间）；
      - 播报状态小 toast（`shell.overlay` 或本槽内文案）。
- [ ] 验证：`dsh plugin --profile web add <path>` 后重启 dsh，浏览器里测：手动朗读一条消息成功；
      开关打开后新的一轮结束自动朗读。

### Phase 2：转写质量与 TTS 后端
- [ ] 转写 prompt 迭代：`docs/voice-pipeline.md` 维护 system prompt（规则：代码块→一句话概述、
        表格→逐行口语、列表→"第一/第二"、URL→读域名、符号→读音、保留结论/数字/术语）；
        支持自定义 `voice.transcribe.prompt`（settings 可覆盖）。
- [ ] 转写超时/失败处理：LLM 出错 → 降级为"原文直读（去除 markdown 标记的纯文本）"并提示；
        超时上限（如 60s）与 token 上限（`maxTokens`）。
- [ ] **TTS Provider 适配层实现**（自研薄层，不引第三方适配器库——调研结论见
        `docs/research/plan-review-tts-adapter-report.html`：无现成 JS 库支持火山 v3 接口，
        候选库过重或维护不稳）：
      - `browser`：透传 Client speechSynthesis（默认兜底，零配置）；
      - `openai-compatible`：POST `{baseUrl}/audio/speech`（可接 new-api/one-api 等中转站）；
      - **`volcengine`（v1 主力）**：doubao-seed-tts-2.0，HTTP 单向接口
        `POST /api/v3/plan/tts/unidirectional` → 逐行解析 chunked JSON（base64 音频段累加、
        `code 20000000` 结束帧）→ 拼完整 mp3；超长文稿按段落切分、串行合成、顺序播放
        （单次请求文本上限 Phase 2 实测）。选 HTTP 而非 WS 单向流式：v1 整段播报用不上
        长连接复用/逐帧流播，且无需实现官方二进制帧协议；v2 流式朗读时再升级（接口已隔离）。
      - 音频回传默认经 `ctx.webServer` 临时路由 `/voice/audio/<id>`（dataURL 仅试听小片段）。
- [ ] **"语音播报"设置页**（`settings.section` 独立导航页，从 Phase 3 提前——槽位契约已核实：
        每 list 条目 = 一个带 `id/order/label` 的设置页）：provider 切换、各 provider 配置表单
        （火山：API Key / speaker 音色 / sampleRate）、语速/音调、**试听按钮**、
        `autoSpeakCloudTts` 开关（默认关，云 TTS 成本门控）。
- [ ] 停止语义：`voice.stop`（Host 中止 LLM 流 + 通知 Client 停 speechSynthesis/audio）；
        新 turn 开始自动停止上一条。

### Phase 3：体验完善
- [ ] 设置页完善：火山可用音色清单（拉取/缓存或内置快照）、zh/en 双语言文案、配置校验与错误提示。
- [ ] `turnTail` 状态徽标（"已朗读 ✓ / 朗读中… / 失败"）与失败重试按钮。
- [ ] 并发与多会话：多个会话同时跑时的播报队列/冲突策略（同一时刻只播一条；或按会话独立）。
- [ ] 配置校验（schemastery）与 UI 文案（zh/en 双语言）。

### Phase 4：固化与文档
- [ ] 从创造模式原型中把已验证的代码回填到正式包（若 Phase 1–3 用了动态插件试验）。
- [ ] README：安装（`dsh plugin --profile web add` / `link:`）、配置、权限说明、卸载。
- [ ] `docs/dev-playbook.md`：开发循环（改 Host → 重启 dsh；改 Client → `pnpm run dev:web` watcher）、
        常见坑（`allowBuilds`、slot 占用、`host.call` JSON-only、HMR 前提）。

---

## 6. 关键设计决策与理由

| # | 决策 | 理由 |
|---|------|------|
| D1 | 转写在 **Host**（`ctx.llm`）而非浏览器 | 复用已配置的 provider/凭据；不把 API key 暴露给浏览器；转写与 TTS 分离 |
| D2 | 转写用**独立辅助 LLM 调用**（非主对话） | 不污染会话历史；`purpose` 可标记；prompt 完全可控 |
| D3 | 默认 TTS = 浏览器 `speechSynthesis`（未配云凭据时的兜底） | 零配置、离线可用、免费；Windows 有内置中文语音 |
| D4 | 云 TTS 走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传 | `ctx.web` 仅 GET 抓取（不能 POST/鉴权头/二进制）；动态沙箱禁 fetch；webserver 路由避免 host.call JSON 大 payload 与 CORS/凭据暴露（dataURL 仅试听小片段） |
| D5 | 开关持久化在 `settings.yaml`（`voice` 命名空间） | DSH 原生设置机制：热重载、多会话共享、UI 可编辑 |
| D6 | UI 只占 additive 小槽位（assistant-actions / input.left / turnTail） | 不替换任何产品 UI 区域；不碰 `root`/`conversation.session` |
| D7 | 消息文本来源 = Session 事件日志（`assistant/message` 的 text 块） | 权威、可回放、与 UI 渲染一致；Client 侧同时用 conversation Definition 聚合 |
| D8 | 自动播报触发点 = `assistant/message` + `turn/end` | "一轮结束"以 `turn/end` 为权威；排除 `aborted/error` 等 |
| D9 | 成品为正式 bundle，创造模式只做原型 | 动态插件进程内临时、重启丢失；且沙箱禁 fetch 无法试验 TTS 外呼；长期功能必须组合固化 |
| D10 | TTS 用**自研 Provider 适配层**，不引第三方适配器库（npm 依赖或 vendor 第三方代码均不采用） | 联网调研：无现成 JS 库支持火山 v3 接口（lobe-tts 无火山、edge-tts 维护波动、LiteLLM 过重、xiaozhi 等是应用不是库）；火山 HTTP 单向协议极简（~150 行零依赖）；避免供应链与失维护风险。详见 `docs/research/plan-review-tts-adapter-report.html` |
| D11 | 火山 v1 用 **HTTP 单向接口**而非 WebSocket 单向流式 | v1 整段播报用不上 WS 的长连接复用/逐帧流播；HTTP 无需实现官方二进制帧协议（protocols.py），curl 可调试；v2 流式朗读再升级，provider 接口已隔离 |

---

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| `ctx.llm` 在动态/自定义 Host 半里的可用性细节未完全确认 | 转写调用可能需调整（如直接 `registerAdapter` 或走 `llm/stream` waterfall） | Phase 1 先用创造模式做一次最小 Host 半试验，确认 `prepareCall` 签名与凭据解析 |
| `host.call` 仅支持 JSON、且 client 半闭包受限 | 传输大文本/音频受限 | 文本走 `host.call` 返回值；音频默认走 `ctx.webServer` 临时路由（dataURL 仅试听小片段） |
| 火山 v3 接口单次文本长度上限/协议细节未完全确认 | 长文稿合成失败或报错 | Phase 2 实测上限；按段落切分串行合成；官方 PDF 已存档 `docs/research/` 供对照 |
| `speechSynthesis` 在无声卡/远程浏览器可能无声 | 播报体验差 | 设置页提供"试听"；文档说明浏览器/系统语音要求；云 provider（openai-compatible/volcengine）兜底 |
| 转写 LLM 超时/失败 | 自动播报中断 | 降级直读 + 错误提示；可重试（手动按钮） |
| 多会话并发播报互相打断 | 混乱 | v1 全局单播队列（后到打断先到或排队，可配 `stopOnNewTurn`） |
| 云 TTS 按字符计费，自动播报花费失控 | 意外账单 | `autoSpeakCloudTts` 默认关：云 provider 下自动播报跳过并提示，仅手动按钮触发；设置页明示 |
| 插件行与服务名冲突 | 启动失败 | bundle 插件 id 用 `voice`，服务名/Remote 命名空间用 `voice`，避免与既有重名 |
| 客户端 bundle 未构建 | 浏览器报模块缺失 | 按 client-modules 的报错提示先 `pnpm run build`；开发期 `pnpm run dev:web` |

---

## 8. 验收标准（Definition of Done）

1. 安装后 `dsh --profile web` 启动无新错误，浏览器无 console 报错（插件相关）。
2. 每条 assistant 消息的 IconActions 行出现"朗读"按钮；点击后：
   - 转写结果不是原文逐字朗读（代码/表格被口语化），
   - 有声音输出（浏览器 TTS 或配置的外部 TTS），
   - 播报可停止。
3. 自动播报开关：
   - 打开后，一轮（`turn/end` completed）结束自动播报该轮最终消息；
   - 关闭后不自动播报，但手动按钮仍可用；
   - 开关状态在 settings.yaml（`voice:` 节）持久化，重启后保留。
4. 转写失败时优雅降级（提示 + 可选直读），不中断会话。
5. 多会话/快速连续提问时不出现播报死循环或崩溃。
6. 文档齐备：README（安装/配置）+ docs/ 三篇（架构、转写/TTS 设计、开发手册）。
7. 设置页（`settings.section`"语音播报"独立页）：可切换 TTS provider、填写火山 API Key、
   选择音色、调整语速，试听成功；配置写入 settings.yaml 并热生效。
8. 云 TTS 成本门控：`autoSpeakCloudTts=false`（默认）时自动播报不调用云 TTS（仅手动按钮可用）；
   打开后自动播报走云 provider。
9. 火山 provider 冒烟：配置 doubao-seed-tts-2.0 后，手动"朗读"一条含代码/表格的消息，
   能听到火山合成的口播音频（转写后非原文逐字）。

---

## 9. 参考（已核实源码位置）

- dsh README（入口/plugin/profile）：`node_modules/@deepseek-ai/dsh/README.zh.md`
- bundle 补丁机制：`@deepseek-ai/dsh-base/cordis.patch.yml`、`@deepseek-ai/dsh-web-app/cordis.patch.yml`
- `dsh plugin` 实现：`@deepseek-ai/dsh/lib/plugin-*.js`（`exportsPatch`/`reconcilePlugins`/`anchorPathSpec`）
- 双半插件范例：`@deepseek-ai/dsh-client-ui-deliverables`（client.js 全文）、`dsh-client-ui-message-feedback`
- 客户端闭包：`@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（`CLIENT_BUILTIN_INSPECTION`）
- Host 闭包：`@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.d.ts`（`HOST_BUILTIN_INSPECTION`）
- 会话事件：`@deepseek-ai/dsh-session/lib/types/types.d.ts`（`SessionEventMap`）、`index.d.ts`（`session/event`）
- LLM 服务：`@deepseek-ai/dsh-llm/lib/types/index.d.ts`（`prepareCall`/`stream`）、`types.d.ts`（`GenerateOptions`/`StreamChunk`）
- 设置：`@deepseek-ai/dsh-settings`（`SettingsScope`）、`dsh-settings-file`（settings.yaml）
- 槽位契约：`@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
  （`assistant-actions`/`turnTail`/`input.left`/`header.actions`）、`dsh-client-ui-settings`（`settings.section`）
- 创造模式 preset：`@deepseek-ai/dsh/config/agent-presets/cordis/`（persona + skills）
- WebServer：`@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts`（`register`/`registerUpgrade`）
- 出网能力缝（ctx.web 限制核实）：`@deepseek-ai/dsh-web/lib/types/index.d.ts`/`types.d.ts`
  （`WebFetchRequest` 仅 `url`）；Host 沙箱 fetch 陷阱：`dsh-cordis-host-runner/lib/types/sandbox.js`
- 设置槽位契约：`@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`
  （`settings.section` = 每 list 条目一个独立设置页，带 id/order/label）
- 火山引擎 TTS 调研与 PLAN 审查报告：`docs/research/plan-review-tts-adapter-report.html`；
  官方文档存档：`docs/research/volcengine-ark-speech.pdf` / `.txt`（doubao-seed-tts-2.0，
  HTTP 单向 `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，
  头 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`，体 `req_params.{text,speaker,audio_params}`，
  响应 chunked JSON 行 base64 音频段 + `code 20000000` 结束帧）
