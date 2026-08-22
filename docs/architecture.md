# dsh 插件架构（architecture）

> 记录本插件依赖的 DSH 插件机制与关键决策，作为扩展/维护时的权威参考，避免臆造 API。
> 管线行为与配置 schema 见 `docs/pipeline.md`；开发循环见 `docs/development.md`；测试见 `docs/testing.md`。

## 1. 版本与环境（本机）

- `@deepseek-ai/dsh@0.1.0-rc.6`（npx 缓存检出：`C:\Users\junar\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`）
- `DSH_HOME=C:\Users\junar\.dsh`；web profile：`C:\Users\junar\.dsh\profiles\web`
- 用户设置：`C:\Users\junar\.dsh\settings.yaml`；web 界面 `http://127.0.0.1:3080`

## 2. 组合包（bundle）机制

- `dsh.profile.bundles` 数组按顺序叠加 patch；每个 bundle 是一个 npm 包，`package.json` 声明 `dsh.bundle.patch`。
- patch 文件为 YAML 列表：`- insert: [...]` 插入新行；`- id: xxx` 覆盖既有行的 `config`（整体替换，不合并）。
- 解析顺序：dsh 安装目录 → profile 自身 `node_modules`。
- `dsh plugin --profile web <pnpm args>` 在 profile 目录转发 pnpm 命令，成功退出后按已装依赖的
  `dsh.bundle` 声明 reconcile bundles 列表。

## 3. 双半插件

- 包导出 `./client`（浏览器半）+ `.`（Host 半）；`dsh.client` 声明 `{ platform: 'web', inject: [...] }`。
- client-modules 扫描声明 `dsh.client` 的包，把 `client.js` 经 `/plugins/<id>/client.js` 注入
  `window.__DSH_BOOT__`，浏览器端用 `window.__ModuleLoader__.load({ id, factory })` 注册。
- 两半通信：Host `harness.handle(method, fn)` / Client `host.call(method, args)`（JSON only）。

### Client 半闭包（`CLIENT_BUILTIN_INSPECTION`）
`ctx`（get/on/provide/effect）、`React`、`host`（host.call）、`styles`、`console`。
禁止 `import`/`require`/`JSX`/`TS`；React 用 `React.createElement`。

### Host 半闭包（`HOST_BUILTIN_INSPECTION`）
`ctx`、`harness`（handle/defineTool/registerTool）、`console`、`btoa`/`atob`/`TextEncoder`/`TextDecoder`。
Node API（fetch/fs 等）在正式 bundle 里可直接用（普通 Node 模块），无需经 `ctx.web`。

## 4. Host 关键服务

- `ctx.sessions`（`SessionStore`）：`session/event`（`(session, event)`）等。事件：`turn/start`、
  `turn/end`（`{turn, reason}`）、`assistant/message`（`{turn, step, message, usage?}`）、`user/message` 等。
- `ctx.llm`（`LlmRuntime`）：`prepareCall(config, signal?)` → `PreparedLlmCall`；`stream(options)` → AsyncIterable<StreamChunk>。
  StreamChunk：`text-delta`、`reasoning-delta`、`block-end`、`usage`、`finish` 等。
- `ctx.settings`（`SettingsProvider`）：`register(ns, schema, opts)` → `SettingsScope`（`get/watch/update/replace`）；
  `dsh-settings-file` 持久化到 `$DSH_HOME/settings.yaml`，热重载。
- `ctx.webServer`：`register({kind:'exact'|'prefix', path, handler})` 等（TTS 音频一次性路由用）。

## 5. Client 关键槽位（`dsh-client-ui-conversation/.../slots.d.ts`）

| 槽位 | kind | scope | owner props | 用途 |
|---|---|---|---|---|
| `conversation.chat.assistant-actions` | list | session | `{ messageId }` | 每条最终助手消息操作行 → "朗读"按钮 + ↻ 重新生成 |
| `conversation.chat.turnTail` | chain | session | `{ turn, seq, openFile }` | 收尾尾巴 → 播报状态 |
| `conversation.input.left` / `.right` | list | session | `{ session, input }` | 输入框工具行 → 自动播报开关 |
| `conversation.session.header.actions` | list | session | （框架 kit） | 会话头按钮 → 开关备选 |
| `settings.section` | list | root | `{ close }` | 语音设置页（id=voice） |
| `settings.general.item` | list | root | （空） | General 单行偏好 |
| `shell.overlay` | list | root | — | toast/浮层 |

Client 注册方式：`ctx.slots.inject('<slot>', () => ctx.slots.register({ name, id, order, locale, inject }, Component))`。

## 6. 设置命名空间

Host 用 `ctx.settings.register('voice', VoiceSettingsSchema)` 注册 `voice:` 命名空间（schema 定义在
`packages/dsh-plugin-voice/lib/index.js`）。Client 用 `ctx.settingsScope` 读快照、`set` 写。

## 7. 设计决策（为什么这么搭）

- 转写在 Host 用 `ctx.llm`（独立辅助调用、不入主会话历史）：复用已配 provider/凭据、不暴露 key、prompt 可控。
- 默认 TTS = 浏览器 `speechSynthesis`：零配置、免费、离线兜底。
- 云 TTS 走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传：`ctx.web` 仅 GET 抓取
  （不能 POST/鉴权头/二进制）；创造模式动态沙箱禁 `fetch`。
- 成品为正式 bundle（非创造模式动态插件）：动态插件进程内临时、重启丢失、沙箱禁 fetch。
- TTS 用自研适配层（不引第三方库）：无现成 JS 库支持火山 v3 接口；HTTP 单向协议极简（~150 行零依赖）；
  避免供应链与失维护风险。调研见 `docs/research/plan-review-tts-adapter-report.html`。
- 云 TTS 默认仅手动按钮触发（`autoSpeakCloudTts=false` 成本门控）：防自动播报账单失控。
- UI 只占 additive 小槽位，不碰 `root`/`conversation.session` 等高风险整槽位。
- 命名空间/服务名统一用 `voice`，避免与既有插件冲突。

## 8. 参考（DSH 源码，只读）

- bundle 补丁：`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`
- 双半插件范例：`dsh-client-ui-deliverables`、`dsh-client-ui-message-feedback`
- 客户端闭包：`dsh-cordis-client-runner/lib/client.js`（`CLIENT_BUILTIN_INSPECTION`）
- Host 闭包：`dsh-cordis-host-runner/lib/types/sandbox.d.ts`（`HOST_BUILTIN_INSPECTION`）
- 会话事件：`dsh-session/lib/types/types.d.ts`（`SessionEventMap`）
- LLM：`dsh-llm/lib/types/index.d.ts`（`prepareCall`/`stream`）、`types.d.ts`（`GenerateOptions`）
- 设置：`dsh-settings`（`SettingsScope`）、`dsh-settings-file`
- 槽位契约：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`、`dsh-client-ui-settings/.../slots.d.ts`
- 创造模式 preset：`dsh/config/agent-presets/cordis/`
