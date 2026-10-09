# dsh 插件架构（architecture）

> 记录本插件依赖的 DSH 插件机制与关键决策，作为扩展/维护时的权威参考，避免臆造 API。
> 管线行为与配置 schema 见 `docs/pipeline.md`；开发循环见 `docs/development.md`；测试见 `docs/testing.md`。

## 1. 版本与环境（本机）

- 目标运行环境：**DSH 桌面版 0.2.0-rc.2**（Electron 应用；代码在 `resources\app.asar\dsh`，只读）。
  需要 inspect 上游实现时用 `node scripts/dsh-inspect-extract.mjs <输出目录> <包名…>` 只读导出
  `dsh/node_modules/@deepseek-ai/*`（不要改安装目录、不要直接读 asar 路径）。
- `DSH_HOME`（默认 `~/.dsh`）；桌面 profile：`$DSH_HOME\profiles\desktop`；Web 界面
  `http://127.0.0.1:19387`。桌面端自带的 CLI：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`
  （跑同一份 0.2.0-rc.2，profile 参数用 `--profile desktop`）。
- 用户设置：profile 的 `cordis.patch.yml`（用户 patch 层，含插件 config）；旧的
  `$DSH_HOME\settings.yaml` 在 0.2.0 首次启动被改名成 `settings.yaml.imported`，不再被读取。

## 2. 组合包（bundle）机制

- `dsh.profile.bundles` 数组按顺序叠加 patch；每个 bundle 是一个 npm 包，`package.json` 声明 `dsh.bundle.patch`。
- patch 文件为 YAML 列表：`- insert: [...]` 插入新行；`- id: xxx` 覆盖既有行的 `config`（整体替换，不合并）。
- 解析顺序：dsh 安装目录 → 共享 `profiles\node_modules` → profile 自身 `node_modules`。
- `dsh plugin --profile desktop <pnpm args>` 在 profile 目录转发 pnpm 命令，成功退出后按已装依赖的
  `dsh.bundle` 声明 reconcile bundles 列表。

## 3. 双半插件

- 包导出 `./client`（浏览器半）+ `.`（Host 半）；`dsh.client` 声明 `{ platform: 'web', inject: [...] }`。
- client-modules 扫描声明 `dsh.client` 的包，把 `client.js` 经 `/plugins/<id>/client.js` 注入
  `window.__DSH_BOOT__`，浏览器端用 `window.__ModuleLoader__.load({ id, factory })` 注册。
- 两半通信：本插件走 HTTP（`/voice/api/*` JSON 接口 + `/voice/audio/<id>` 音频一次性路由，Host 侧由
  `ctx.webServer` 提供）；`harness.handle`/`host.call` 是创造模式动态插件的包内 RPC，正式 bundle 用不到。

### Client 半（正式静态 bundle）
factory 只拿到 `require`（可解析 `react` 等少数共享模块），`ctx` 由 `apply(ctx)` 传入；**没有** `host`/`styles`
（`CLIENT_BUILTIN_INSPECTION` 里那套 `ctx`/`React`/`host`/`styles`/`console` 是**创造模式动态沙箱半**专有的）。
因此：与 Host 通信走 HTTP `fetch('/voice/api/…')`，样式自己插 `<style data-plugin-css>` +
`ctx.effect` 清理。禁止 `import`/`JSX`/`TS`；React 用 `React.createElement`。

### Host 半
`export { apply, inject, Config }`；`apply(ctx, config)` 拿解析后的插件配置。正式 bundle 是普通 Node ESM
模块，Node API（fetch/fs/子进程）直用；`HOST_BUILTIN_INSPECTION` 的闭包限制只作用于动态沙箱半。

## 4. Host 关键服务

- `ctx.sessions`（`SessionStore`）：`session/event`（`(session, event)`）等。事件：`turn/start`、
  `turn/end`（`{turn, reason}`）、`assistant/message`（`{turn, step, message, usage?}`）、`user/message` 等。
  已加载会话的历史须用 `session.snapshotEvents()` 读取；`session.events` 已在 0.1.2 移除。
- `ctx.llm`（`LlmRuntime`）：`prepareCall(config, signal?)` → `PreparedLlmCall`；`stream(options)` → AsyncIterable<StreamChunk>。
  StreamChunk：`text-delta`、`reasoning-delta`、`block-end`、`usage`、`finish` 等。
- `ctx.settings`（`SettingsProvider`）：插件配置由插件自己导出 `Config` schema 声明，条目 config 存在
  profile 的 `cordis.patch.yml`；`update(ns, patch)` 深合并写入（`ns` = profile patch 条目 id，本插件是 `voice`），
  标了 `.volatile()` 的字段热生效、不重挂载插件。`register(ns, schema)` 在 0.2.0 已移除。
- `ctx.webServer`：`register({kind:'exact'|'prefix', path, handler})` 等（TTS 音频一次性路由用）。

## 5. Client 关键槽位

| 槽位 | kind | scope | owner props | 用途 |
|---|---|---|---|---|
| `conversation.chat.assistant-actions` | list | session | `{ messageId }` | 每条最终助手消息操作行 → "朗读"按钮 + ↻ 重新生成 |
| `conversation.chat.turnTail` | list | session | `{ turn, seq, openFile }` | 收尾尾巴 → 播报状态徽标（本轮没读过就返回 null 不占位） |
| `conversation.input.left` | list | session | 会话标准 kit | 输入框工具行 → 自动播报开关 |
| `settings.section` | list | root | `{ close }` | 语音设置页（id=voice；`id`=导航键、`order`=导航位次、`label`=导航文案） |
| `shell.overlay` | list | root | 根标准 kit | toast/浮层（该层默认点击穿透，浮层自己要 `pointer-events:auto`） |

Client 注册方式：`ctx.slots.inject('<slot>', () => ctx.slots.register({ name, id, order }, Component))`。
**list 槽位必须有 `id`**（同名+同 priority 重复注册会抛错）；`select` 是 chain 槽位专有的（list 传了不生效，
"要不要渲染"由组件自己返回 null 决定）。

## 6. 插件配置（Config）与设置页

Host 半导出 `Config`（schemastery schema，定义在 `packages/dsh-plugin-voice/lib/index.js`），插件体
`apply(ctx, config)` 读配置；可热改字段标 `.volatile()`，边界见 `docs/pipeline.md` §6.0。条目 id 是 `voice`
（bundle 补丁插入的行），config 落在 profile 的 `cordis.patch.yml`。Client 设置页经 `/voice/api` 的
`getConfig`/`setConfig` RPC 读写（Host 归一后返回，UI 显示 = 实际发声）；`setConfig` 只提交改动过的字段
（部分 patch），因为秘密字段（`tts.volcengine.apiKey`）不进浏览器，整块回写会把它抹掉。

## 7. 设计决策（为什么这么搭）

- 转写在 Host 用 `ctx.llm`（独立辅助调用、不入主会话历史）：复用已配 provider/凭据、不暴露 key、prompt 可控。
- 默认 TTS = 浏览器 `speechSynthesis`：零配置、免费、离线兜底。
- 云 TTS 走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传：`ctx.web` 仅 GET 抓取
  （不能 POST/鉴权头/二进制）；创造模式动态沙箱禁 `fetch`。
- 成品为正式 bundle（非创造模式动态插件）：动态插件进程内临时、重启丢失、沙箱禁 fetch。
- TTS 用自研适配层（不引第三方库）：无现成 JS 库支持火山 v3 接口；HTTP 单向协议极简（~150 行零依赖）；
  避免供应链与失维护风险。调研见火山《接入语音模型》官方文档（链接见 `docs/pipeline.md` §4.2）。
- 付费 TTS 默认关闭（设置页"播报引擎"三选一：系统/豆包/本地 Kokoro；默认 browser 全免费；
  选豆包 = 用户显式为付费 API 买单并写入 `autoSpeakCloudTts=true`），
  `autoSpeakCloudTts` 仍作为直改配置的自动播报成本门控防账单失控；local 免费不受门控。
- UI 只占 additive 小槽位，不碰 `root`/`conversation.session` 等高风险整槽位。
- 命名空间/服务名统一用 `voice`，避免与既有插件冲突。
- 设置页"语音播报"导航图标 = **CSS 遮罩替身**：shell 的 `navIcon(id)` 只识别 models/agent-presets/plugins，
  其余回退齿轮（源码硬编码，无扩展点）；`settings.section` 注册仅 id/order/label，不支持自定义 icon。
  做法：面板挂载后给语音行加类名 → CSS 隐藏齿轮 svg、`::before` mask 显示喇叭（不动 React 节点，
  MutationObserver 负责补齐类名）；DSH 升级若改导航 DOM/文案，最坏回退为齿轮，无副作用，升级后需回查。
  喇叭 SVG 几何存一份常量（`SPEAKER_*`）：React 组件与遮罩 data-URI 共用，避免两处漂移。

## 8. 参考（DSH 源码，只读）

- bundle 补丁：`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`
- 双半插件范例：`dsh-client-ui-deliverables`、`dsh-client-ui-message-feedback`
- 客户端闭包：`dsh-cordis-client-runner/lib/client.js`（`CLIENT_BUILTIN_INSPECTION`）
- Host 闭包：`dsh-cordis-host-runner/lib/types/sandbox.d.ts`（`HOST_BUILTIN_INSPECTION`）
- 会话事件：`dsh-session/lib/types/types.d.ts`（`SessionEventMap`）与 `lib/types/index.d.ts`
  （`snapshotEvents()`）
- LLM：`dsh-llm/lib/types/index.d.ts`（`prepareCall`/`stream`）、`types.d.ts`（`GenerateOptions`）
- 设置：`dsh-settings`（`SettingsScope`）、`dsh-settings-file`
- 槽位契约：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`、`dsh-client-ui-settings/.../slots.d.ts`
- 创造模式 preset：`dsh/config/agent-presets/cordis/`
