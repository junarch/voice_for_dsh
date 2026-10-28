# dsh 插件架构（architecture）

> 记录本插件依赖的 DSH 插件机制与关键决策，作为扩展/维护时的权威参考，避免臆造 API。
> 管线行为与配置 schema 见 `docs/pipeline.md`；开发循环见 `docs/development.md`；测试见 `docs/testing.md`。

## 1. 版本与环境（本机）

- 目标运行环境：**DSH 桌面版 0.2.1-rc.3**（Electron 应用；代码在 `resources\app.asar\dsh`，只读）。
  需要 inspect 上游实现时用 `node scripts/dsh-inspect-extract.mjs <输出目录> <包名…>` 只读导出
  `dsh/node_modules/@deepseek-ai/*`（不要改安装目录、不要直接读 asar 路径）。
- `DSH_HOME`（默认 `~/.dsh`）；桌面 profile：`$DSH_HOME\profiles\desktop`；Web 界面
  `http://127.0.0.1:<端口>`（端口以启动日志/地址栏为准）。桌面端自带的 CLI：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`
  （跑同一份 0.2.1-rc.3，profile 参数用 `--profile desktop`）。
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
- 两半通信：本插件走 HTTP（`/voice/api/*` JSON 接口 + `/voice/audio/<id>` 音频一次性路由 + `/voice/sounds`
  提示音素材，Host 侧由 `ctx.webServer` 提供）。三条路由的分工：
  - `/voice/api/<method>`：POST JSON 的 RPC（`getConfig`/`setConfig`/`meta`/`speak`/`streamNext`/`stop`/
    `localStatus`/`clientDiag`/`clientDiagDump` 等）；
  - `/voice/audio/<id>`：**GET**，合成音频一次性回传（取一次即删）；
  - `/voice/sounds` 与 `/voice/sounds/<file>`：**POST** 上传自定义提示音（`?kind=work|done|ask&name=<原名>`，
    `application/octet-stream`）、**GET** 取回（只读不删，可反复取）。
  `harness.handle`/`host.call` 是创造模式动态插件的包内 RPC，正式 bundle 用不到。

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
- `ctx.webServer`：`register({kind:'exact'|'prefix', path, handler})` 等（合成音频的一次性路由与提示音素材路由用）。

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
（部分 patch）：整块回写会把 Host 刚写回的值（转写路由自愈、聊天里切过的自动播报）覆盖成打开页面时的旧值。

**保存不需要用户惦记**：开关/下拉/滑块防抖 400ms 自动写盘、引擎切换立即写、文本框失焦才提交；
页面显示「未保存 / 已保存」，写完还会从 profile patch 读回核对（对不上就报「没写进磁盘」）。
细节见 `docs/pipeline.md` §6.0。

### 设置页的五层结构（渐进展开）

设置页（`settings.section id=voice`）按"常用的在上、少用的在下"分五层。除第一层外默认收起；收起时层头
显示当前值摘要，主开关（转写、提示音）放在层头——不展开也能开关，不用进去找。

| 层 | 标题 | 层里放什么 | 收起时层头摘要 |
|---|---|---|---|
| L1 | 常用 | 播报引擎三选一、自动播报、当前引擎的一行状态（本地没装时给「去安装」入口）；豆包缺 API Key 或自动播报被成本门控关掉时，状态行下面再补一句原因与恢复办法 | —（常驻展开） |
| L2 | 当前引擎声音设置 | 按引擎切换渲染：系统 TTS = 语速/音调/语音名；豆包 = 鉴权（网关、apiKey）+ 发音（**语种/方言在上、音色在下**，都随音色能力过滤）；本地 Kokoro = 顶部模型安装/删除信息（层内，不占层头）+ 音色 sid / 语速 / 播报语种 /「🔌 运行时自检」。层内不再放解释段落，必要说明只留在选项名或提示里 | `系统 TTS · 语速 1.00x` / `本地 Kokoro · 音色 48 · 语速 1.00x` / `豆包 · Vivi` |
| L3 | 转写 | 层头开关 + provider / model / temperature / 语气预设（只豆包）/ 篇幅档位 / 提示词（按引擎各一份，整行宽 textarea + 恢复默认）；整块去左缩进 | `开：先改写成口语稿` |
| L4 | 高级 | 本地合成的线程数、分句流式开关、模型目录（**只在引擎=本地 Kokoro 时出现**：这三项对在线/系统 TTS 不生效） | `分句=开 · 线程=4 · 目录=自动` |
| L5 | 提示音 | 层头总开关 + 总音量 + 工作/完成/提问三行（每行可选内置变体：工作音 5 个，完成/提问各 3 个；也可上传自定义音） | `开 · 2/3 种 · 音量 30%` |

设置页标题下方常显一行 `voice_for_dsh vX.Y.Z · 适配 DSH A.B.C`：版本号来自插件 `package.json`
（`/voice/api/meta` 的 `pluginVersion`），适配版本是先验常量 `dshCompat`——排障时第一眼就能确认跑的是哪一版。

## 7. 设计决策（为什么这么搭）

- 转写在 Host 用 `ctx.llm`（独立辅助调用、不入主会话历史）：复用已配 provider/凭据、不暴露 key、prompt 可控。
- 默认 TTS = 浏览器 `speechSynthesis`（设置页里的「系统 TTS（浏览器语音）」）：零配置、免费、离线兜底。
- 豆包走正式 bundle Host 半的 Node `fetch` → `ctx.webServer` 临时路由回传：`ctx.web` 仅 GET 抓取
  （不能 POST/鉴权头/二进制）；创造模式动态沙箱禁 `fetch`。
- 成品为正式 bundle（非创造模式动态插件）：动态插件进程内临时、重启丢失、沙箱禁 fetch。
- TTS 用自研适配层（不引第三方库）：无现成 JS 库支持火山 v3 接口；HTTP 单向协议极简（~150 行零依赖）；
  避免供应链与失维护风险。调研见火山《接入语音模型》官方文档（链接见 `docs/pipeline.md` §4.2）。
- 付费 TTS 默认关闭（设置页"播报引擎"三选一：系统/豆包/本地 Kokoro；默认 browser 全免费；
  选豆包 = 用户显式为付费 API 买单并写入 `autoSpeakCloudTts=true`），
  `autoSpeakCloudTts` 仍作为直改配置的自动播报成本门控防账单失控；local 免费不受门控。
- UI 只占 additive 小槽位，不碰 `root`/`conversation.session` 等高风险整槽位。
- **设置页分层（L1–L5）而不是一屏平铺**：用户平时只动两件事——换引擎、开自动播报；其余是"配一次就忘"的
  参数（豆包鉴权、转写路由、本地线程数）。平铺四十来个字段，每次进来都要从头扫一遍才能确认"还是原来那样"。
  所以：常用项常驻第一层；其余四层收起，层头带当前值摘要（不展开也知道现在是什么）；转写/提示音的主开关
  放层头（收起也能开关）；第二层只渲染**当前引擎**的字段，三套配置互不干扰。
- **提示音的运行态以客户端为主、Host 只补账本**：主信号是 `uiSession.sessionStatus` 快照（`running` /
  `pendingInteraction` / `completionUnread`），另订阅全局 `api-session/status` 事件、轮询 Host 的
  `chimeStatus` 账本，补上「冷启动前已开跑」与「其他工作区」两类快照看不到的会话。理由：提示音要在**播报关闭、
  没读过任何一句话**时照常工作，也要覆盖"子代理在跑""DSH 弹提问等你答"这些与朗读无关的状态；
  挂在播报链上就会互相牵连。
- **工作音与完成音是两套口径**：工作音 = 任何会话在跑（含子代理、含别的工作区）——"dsh 有活在跑"它就响；
  完成音 = 顶层会话（`session.header.origin !== 'subagent'` 且不带 `parentId`）少一个，子代理结束不响。
  Host 账本同时返回 `running`（全部）/ `top`（顶层）/ `epoch`（重载识别），三路信号在客户端并成集合再判断。
  已知限制：多窗口/多标签各自出声（没有跨窗口互斥）。
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
