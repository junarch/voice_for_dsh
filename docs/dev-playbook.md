# 开发手册（dev-playbook）

## 1. 开发循环

> **v1 无构建步骤**：`packages/dsh-plugin-voice/lib/index.js`（Host）、`lib/client.js`（Client）、
> `lib/volcengine-ws.js`（双向流 WS 客户端）、`lib/speech-clean.js`（口播净化 `sanitizeForSpeech`
> + TTS 引擎归一 `ttsProviderOf`；**MP3 帧对齐 `alignToFrameBoundary` 已随 pcm 切段移除**，
> 见 docs/voice-pipeline.md §2.3.1）、`lib/voice-compat.js`（音色↔语种归一 `normalizeVoiceConfig`）是
> **手工编写的纯 JS 源码**（已经创造模式 spike 验证），
> 直接提交进 git（`.gitignore` 不忽略该 lib）。
> `src/` 目录仅为后续 TS/tsdown 化预留的占位。改代码 = 直接改 `lib/`。

### 改 Host 半（lib/index.js）
1. 改 `packages/dsh-plugin-voice/lib/index.js`。
2. 重启 dsh（Ctrl+C 停旧的）：`npx @deepseek-ai/dsh web`（全局安装后可 `dsh web`）。Host 半改动**必须重启**才生效。

### 改 Client 半（lib/client.js）
1. 改 `packages/dsh-plugin-voice/lib/client.js`。
2. 重启 dsh（client-modules 重新扫描、rev 变化），浏览器**手动刷新** `http://127.0.0.1:3080`。
   - v1 没有 dev watcher / HMR；后续接入 tsdown 后才有 `pnpm run dev:web` 无刷新更新。

### 改任意一半之后：跑零成本集成测试
```powershell
node scripts/test-host.mjs   # mock 依赖驱动 Host 全链路，149 条断言（含重复朗读不加 LLM、双向流帧编解码/流式管线、口播净化/引擎归一、pcm 段格式、context_texts 情感对所有 2.0 音色生效、8 方言 explicit_dialect 统一 vv、English 自动切英文音色、无 cache_config、配置 speaker 归一化、T16 音色↔语种归一 / T17 regen / T18 重播零 LLM / T19 WS 兜底缓存完整）
node scripts/tts-probe.mjs   # 真实外呼探针（花几分钱）：验证 HTTP 单向 TTS 接口行为是否变化
node scripts/tts-ws-probe.mjs --case basic   # 真实外呼探针（花几分钱）：验证双向流 WS 端点/帧协议/首包延迟
node scripts/tts-ws-probe.mjs --all          # 双向流全部参数用例（emotion/dialect/instruct/cache/section/expressive/多 session）
node scripts/tts-dialect-probe.mjs           # 方言专项 1：8 方言 explicit_dialect vs context_texts 对照（HTTP 单向）
node scripts/tts-dialect-probe2.mjs          # 方言专项 2：新文本排除缓存 + 补测 shanghai/henan/beijing
node scripts/tts-ws-dialect-probe.mjs        # 方言专项 3：双向流 8 方言 explicit_dialect（默认主路径）
node scripts/tts-voice-avail-probe.mjs       # 音色可用性：精选 中文4男4女 + 英文3 音色在 plan 网关双向流实测
node scripts/tts-pcm-probe.mjs               # 一次性诊断：plan 网关 pcm/wav/mp3 格式支持（双向流已改 pcm）
node scripts/tts-emotion-probe.mjs           # 情绪指令实测：3 段强烈情绪文本 × 6 种指令对照（试听表 docs/tts-emotion-test-form.md）
node scripts/tts-stream-live.mjs             # 真实 E2E：双向流 pcm 全链路 + 裸采样校验（首段延迟/段数/无 error）
```
方法论见 `docs/testing-guide.md`。

## 2. 安装 / 卸载插件（web profile）

```powershell
# 安装（相对路径锚定到调用时的 cwd；未全局安装 dsh 时一律走 npx）
npx @deepseek-ai/dsh plugin --profile web add ../packages/dsh-plugin-voice
# 或链接式（开发时改代码即生效；注意：link 不会代装插件自身依赖，见 §4 常见坑）
npx @deepseek-ai/dsh plugin --profile web add link:../packages/dsh-plugin-voice

# 卸载
npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-voice

# 查看 profile package.json 的 bundles 列表确认
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"
```

注意：
- pnpm 构建脚本被阻止时，在 `profiles\web\pnpm-workspace.yaml` 的 `allowBuilds` 加包名。
- 卸载后 bundles 列表自动 reconcile；必要时手动清理 `cordis.patch.yml` 中残留的补丁行。

## 3. 创造模式（cordis preset）试验手册

> "创造模式" = dsh 内置 `cordis` agent preset。适合做**动态插件原型**，不适合承载长期功能。

### 3.1 怎么进入
- Web 界面新建会话 → 选择 preset → **创造模式**（或任意会话里让 agent 加载 cordis skill）。

### 3.2 能做什么
- `cordis_inspect_list` / `cordis_inspect_query`：查 Host/Client 服务、事件、槽位、工具的真实签名。
- `cordis_define`：提交 `code.host` / `code.client`（纯 JS 函数体，返回 Cordis 插件）。
- `cordis_run`：激活；Client 半需浏览器审批（`awaiting-approval` → 卡片上打勾）。
- `cordis_stop` / `cordis_undefine`：停用 / 删除。
- 修复：define 新 Package（不可变版本）→ update；或 run 回滚到 current。

### 3.3 本插件开发怎么用创造模式
1. 先用创造模式会话做一个"最小 Host 半"原型：
   `harness.handle('voice.ping', ...)` + `ctx.on('session/event')` 打印事件——验证事件监听与 RPC 链路。
2. 再做一个"最小 Client 半"原型：注册 `conversation.chat.assistant-actions` 槽，渲染一个按钮，
   `host.call('voice.ping')` → 验证 host.call 与槽位注入。
3. 验证通过后，把代码固化到 `packages/dsh-plugin-voice`（正式 bundle），重新走 §1 开发循环。

### 3.4 创造模式的坑
- 动态插件进程内临时：dsh 重启即丢失，所有东西要能重做。
- Client 半每次运行需浏览器审批。
- 不要用动态插件改 shipped preset / host 组合（off-limits）。

## 4. 常见坑（checklist）

- [ ] `ctx.llm` 调用前先确认 `prepareCall` 返回（provider/model 必须已注册；凭据走 credentials seam）。
- [ ] `host.call` 只传 JSON；不传函数/类/Service 实例。
- [ ] Client 半代码里没有 import/require/JSX/TS。
- [ ] 槽位注册用 `ctx.slots.inject` 包裹，`name` 用全名（如 `conversation.chat.assistant-actions`）。
- [ ] settings 命名空间用小写 kebab（`voice`），Client 端 `ctx.settingsScope` 命名一致。
- [ ] 事件监听器用 `ctx.on` 注册并在插件停用时自动清理；不用裸全局回调。
- [ ] 新服务/Remote 命名空间不与既有冲突（查 `Service.listService` / `remote` 目录）。
- [ ] 构建产物 `lib/` 不提交（.gitignore）。**例外**：dsh-plugin-voice 的 `lib/` 是手写源码，要提交。
- [ ] **改了 `package.json` 依赖 → 必须在插件目录跑一次安装**（`pnpm install` 或 `npm install`）。
  `link:` 安装只是符号链接，**不会替被链接的包安装它自己的 dependencies**；
  Host 半 `import` 的每个包都要能从插件目录向上解析到 node_modules（2026-08-18 启动事故）。
- [ ] **交付重启前做冷启动冒烟**：`node -e "import('<pkg>/lib/index.js').then(()=>console.log('ok'))"`
  能在不启动 dsh 的情况下抓住 import/语法级错误。
- [ ] **schemastery ≠ zod**：字面量是 `z.const(v)`（没有 `z.literal`）；`z.union(['a','b'])` 可直接给
  原始字符串数组。写 schema 前先查 `node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts`
  （inspect-first 原则对依赖库同样适用）。

## 5. Spike 结论（2026-08-18，动态插件 voice-1，pkg-1→pkg-8 实测）

> 端到端已验证：槽位按钮 → `host.call` → Session 事件查文本 → `ctx.llm` 转写 → `speechSynthesis` 出声。
> 以下全部为 rc.6 运行实例上的**实测结论**（优先于 .d.ts 推断）。

### 已验证契约
- **SessionEvent 是信封结构**：`{ type, seq, time, data, sourceEventSeqs, surfaceOp }`，
  `SessionEventMap` 描述的 payload 在 **`event.data`** 里（如 `assistant/message` → `data.{turn,step,message,usage}`，
  `message.id` 为 MessageId 字符串）。⚠️ PLAN §1.4 早期按扁平字段描述是错误的。
- `assistant/message` 包含**纯 tool-call 步骤消息**（blocks=`[reasoning,tool-call]`，无 text）；
  记录"最近一条可朗读消息"时必须过滤出含 `text` 块的消息。
- `ctx.llm`：`listProviders()` → `[deepseek-official, aliyuncs, kimi-coding]`（provider 路由名与
  settings.yaml 里的 key 不一定一致，要做发现+回退）；`listModels(provider)[0].id` 可取默认模型。
- **`PreparedLlmCall.stream(options)` 的 call-config 字段**（provider/model/reasoningEffort/temperature/maxTokens/stop）
  **必须与 prepared.config 完全一致**，否则抛 `prepared LLM call config changed before adapter dispatch`。
  稳妥写法：`prepared.stream(Object.assign({}, prepared.config, { system, messages }))`。
- 转写耗时参考：77 字原文 → 约 7s（deepseek-v4-flash，含首 token），transcript 82 字。
- Client 沙箱可用全局：`speechSynthesis`/`SpeechSynthesisUtterance`/`window`/`document`；
  被陷阱的只有 `setTimeout/setInterval/clearTimeout/clearInterval/fetch/require`（+`harness`/`process`/`Buffer`）。
- 槽位 `conversation.chat.assistant-actions`：注册 `{ name, id, order, label }`，
  props = `{ messageId }` + 标准 props（`sessionId` 等）；与 shipped `feedback`（order 10）并存无冲突（用 order 20）。

### 动态沙箱限制（正式 bundle 不受影响）
- `fs.writeText` 写 session 工作区文件被 workspace-write 策略拒绝（动态插件沙箱根与会话工作区不同）。
- Host `console` 输出对 agent 不可见；`cordis_inspect_self` 也**不**回传 client 的 console.error 镜像。

### 高效调试模式（强烈推荐复用）
- **诊断工具回传法**：Host 半用 `harness.defineTool` + `harness.registerTool` 注册 agent 可见工具
  （如 `voice_debug_log` 回传内存日志缓冲、`voice_scan` 扫描事件直方图），agent 可直接调用读取 Host 内部状态，
  不需要用户复制 console。defineTool DSL：`parameters: {}`，
  `output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] }`。
- 审批时勾**双勾**（授权后续版本）→ 之后 `cordis_run update` 免审批，修复循环秒级。
- 典型修复循环：define 新 Package（旧版不可变保留）→ update → 失败读 `cordis_inspect_self` 诊断 → 再 define。
