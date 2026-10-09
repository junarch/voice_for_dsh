# 开发手册（development）

> 本插件 v1 为**手写纯 JS、无构建步骤**：`packages/dsh-plugin-voice/lib/` 下
> `index.js`（Host 半）、`client.js`（Client 半）、`volcengine-ws.js`（双向流 WS 客户端）、
> `speech-clean.js`（净化 `sanitizeForSpeech`）、
> `voice-compat.js`（配置兼容/归一单一事实源：音色↔语种 `normalizeVoiceConfig`、
> 引擎归一 `ttsProviderOf`、音调归一 `pitchOf`）是**源码，直接提交进 git**。
> `src/` 仅为后续 TS/tsdown 化预留的占位。

## 1. 开发循环

### 改 Host 半（`lib/index.js`）
改 → 重启桌面端 dsh 才生效。

### 改 Client 半（`lib/client.js`）
改 → 重启 dsh（client-modules 重新扫描、rev 变化）→ 界面**手动刷新** `http://127.0.0.1:19387`。
v1 无 dev watcher / HMR（后续 tsdown 化后才有 `pnpm run dev:web` 无刷新更新）。

### 改完跑集成测试（mock 零成本 + 探针花几分钱）
```powershell
node scripts/test-host.mjs   # mock 驱动 Host 全链路（转写/缓存/TTS/防串音/重播零 LLM 等断言）
node scripts/tts-probe.mjs       # 真实外呼（花几分钱）：HTTP 单向接口行为
node scripts/tts-ws-probe.mjs --all   # 真实外呼（花几分钱）：双向流参数用例
node scripts/tts-*.mjs             # 其余方言/缓存/音色/流等探针
```
方法论见 `docs/testing.md`。

## 2. 安装 / 卸载插件（desktop profile）

```powershell
# 桌面端自带 CLI（跑同一份 0.2.0-rc.2）
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 在仓库根目录执行（相对路径锚定到调用时的 cwd）
& $dsh plugin --profile desktop add packages/dsh-plugin-voice
# 链接式（开发时改代码即生效；注意：link 不会代装插件自身依赖，见 §4）
& $dsh plugin --profile desktop add link:packages/dsh-plugin-voice

# 卸载
& $dsh plugin --profile desktop remove dsh-plugin-voice
```

- pnpm 构建脚本被阻止时，在 `profiles\desktop\pnpm-workspace.yaml` 的 `allowBuilds` 加包名。
- 卸载后 bundles 列表自动 reconcile；必要时手动清理 `cordis.patch.yml` 残留补丁行。
- 本插件运行需要 `@deepseek-ai/schemastery ≥ 3.18.4`（`.volatile()` 从该版本才有）；桌面版 profile 共享的
  `profiles\node_modules` 里就是 3.18.4，插件自身 `dependencies` 也要跟上，否则 `npm run` 侧的自检会用到旧版。

## 3. 创造模式（cordis preset）试验手册

> "创造模式" = dsh 内置 `cordis` agent preset，适合**动态插件原型**，不适合承载长期功能（重启即丢）。

- 进入：Web 新建会话 → 选 **创造模式**。
- 能做什么：`cordis_inspect_list/query/self`（查 Host/Client 签名）、`cordis_define`（提交 host/client 代码）、
  `cordis_run`（激活，Client 半需浏览器审批）、`cordis_stop`/`cordis_undefine`、修复用 define 新 Package → update。
- 本插件怎么用：先做最小 Host 半原型（`harness.handle('voice.ping')` + `ctx.on('session/event')` 打事件），
  再做最小 Client 半原型（注册 `conversation.chat.assistant-actions` 槽 + `host.call`），验证通过后固化到正式包。
- 坑：动态插件进程内临时、重启丢失；Client 每次运行需浏览器审批；不要用动态插件改 shipped preset/host 组合。

## 4. 常见坑（checklist）

- [ ] 改 `package.json` 依赖 → 必须在插件目录跑一次安装（`npm install`）；`link:` 只是符号链接，不会替被链接的包装它自己的 dependencies。
- [ ] 交付重启前做冷启动冒烟：`node -e "import('<pkg>/lib/index.js').then(()=>console.log('ok'))"`（抓 import/语法级错误）。
- [ ] `host.call` 只传 JSON；Client 半无 `import`/`require`/`JSX`/`TS`。
- [ ] 槽位注册用 `ctx.slots.inject` 包裹，`name` 用全名（如 `conversation.chat.assistant-actions`）。
- [ ] `PreparedLlmCall.stream(options)` 的 call-config 字段必须与 `prepared.config` 一致，
      稳妥写法：`prepared.stream(Object.assign({}, prepared.config, { system, messages }))`。
- [ ] 会话事件为信封结构，payload 在 `event.data`；`assistant/message` 含纯 tool-call 消息，取"最近一条"须过滤含 text 块。
- [ ] schemastery ≠ zod：字面量是 `z.const(v)`（无 `z.literal`）；`z.union(['a','b'])` 可直接给原始字符串数组。
      写 schema 前先查 `node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts`（inspect-first 原则）。
