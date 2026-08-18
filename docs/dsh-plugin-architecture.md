# dsh 插件架构调研笔记

> 本文是 PLAN.md §1 的展开版，记录已核实的 DSH 插件机制，避免实现时臆造 API。

## 1. 版本与环境（本机）

- `@deepseek-ai/dsh@0.1.0-rc.6`（`C:\Users\junar\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`）
- `DSH_HOME=C:\Users\junar\.dsh`；web profile：`C:\Users\junar\.dsh\profiles\web`
- profile bundles：`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`
- settings：`C:\Users\junar\.dsh\settings.yaml`

## 2. 组合包（bundle）机制

- `dsh.profile.bundles` 数组按顺序叠加 patch；每个 bundle 是一个 npm 包，`package.json` 声明 `dsh.bundle.patch`。
- patch 文件为 YAML 列表：`- insert: [...]` 插入新行；`- id: xxx` 覆盖既有行的 `config`（整体替换，不合并）。
- 解析顺序：dsh 安装目录 → profile 自身 `node_modules`。
- `dsh plugin --profile web <pnpm args>` 在 profile 目录转发 pnpm 命令，成功退出后按已装依赖的
  `dsh.bundle` 声明 reconcile bundles 列表（`@deepseek-ai/dsh/lib/plugin-*.js`）。

## 3. 双半插件

- 包导出 `./client`（浏览器半）+ `.`（Host 半）；`dsh.client` 声明 `{ platform: 'web', inject: [...] }`。
- client-modules 扫描 loader 条目里声明 `dsh.client` 的包，把 `client.js` 经 `/plugins/<id>/client.js`
  注入 `window.__DSH_BOOT__`，浏览器端用 `window.__ModuleLoader__.load({ id, factory })` 注册。
- 两半通信：Host `harness.handle(method, fn)` / Client `host.call(method, args)`（JSON only）。

### Client 半闭包（`CLIENT_BUILTIN_INSPECTION`）
`ctx`（get/on/provide/effect）、`React`、`host`（host.call）、`styles`、`console`。
禁止 import/require/JSX/TS；React 用 `React.createElement`。

### Host 半闭包（`HOST_BUILTIN_INSPECTION`）
`ctx`、`harness`（handle/defineTool/registerTool）、`console`、`btoa/atob/TextEncoder/TextDecoder`。
Node API 经 `ctx.fs`/`ctx.web`/`ctx.bash`/Cordis timer。

## 4. Host 关键服务

- `ctx.sessions`（`SessionStore`）：`session/created`、`session/disposed`、`session/event`（`(session, event)`）、
  `session/flush`。事件：`turn/start`、`turn/end`（`{turn, reason}`）、`assistant/message`（`{turn, step, message, usage?}`）、
  `assistant/chunk`、`tool/call`、`tool/result`、`user/message`、`request/header`。
- `ctx.llm`（`LlmRuntime`）：`prepareCall(config, signal?)` → `PreparedLlmCall`；`stream(options)` → AsyncIterable<StreamChunk>。
  `GenerateOptions`：provider/model/messages/system/tools/temperature/maxTokens/stop/signal/sessionId/purpose。
  StreamChunk：`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。
- `ctx.settings`（`SettingsProvider`）：`register(ns, schema, {base, applies, validate})` → `SettingsScope`
  （`get/watch/update/replace`）；dsh-settings-file 持久化到 `$DSH_HOME/settings.yaml`，热重载。
- `ctx.webServer`：`register({kind:'exact'|'prefix', path, handler})`、`registerUpgrade`、`registerFallback`、`tapIndex`。

## 5. Client 关键槽位（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`）

| 槽位 | kind | scope | owner props | 用途 |
|---|---|---|---|---|
| `conversation.chat.assistant-actions` | list | session | `{ messageId }` | 每条最终助手消息操作行 → "朗读"按钮 |
| `conversation.chat.turnTail` | chain | session | `{ turn, seq, openFile }` | 收尾尾巴 → 播报状态 |
| `conversation.input.left` / `.right` | list | session | `{ session, input }` | 输入框工具行 → 自动播报开关 |
| `conversation.session.header.actions` | list | session | （框架 kit） | 会话头按钮 → 开关备选 |
| `settings.section` | list | root | `{ close }` | 语音设置页 |
| `settings.general.item` | list | root | （空） | General 单行偏好 |
| `shell.overlay` | list | root | — | toast/浮层 |

Client 注册方式（参考 ui-deliverables / ui-message-feedback）：
`ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name, id, order, locale, inject: (sessionId) => ({...}) }, Component))`。

## 6. Client 读消息文本

- 标准 props `useSession` 提供 `ConversationSnapshot`；`chat.nodes`（ChatNodeStore）按 key 取节点；
  `AssistantMessageNode` 含 `messageId`、`blocks`（`kind:'text' → text`）、`turn`、`step`。
- 更稳路径：注册 conversation Definition（`ctx.conversationEvents.register`），match `assistant/message` +
  `turn/end`，把"每轮最终文本"聚合进 turn 数据（`buildLocationData`），槽位经 `turn.data.get(...)` 读取。

## 7. 设置命名空间（Client 读/写）

- Host 注册 `voice` 命名空间（schemastery schema + base 默认值）。
- Client 用 `ctx.settingsScope`（`SettingsScopeBinder`/注入 `attachSettings`）读快照、`set(field, value)` 写。
