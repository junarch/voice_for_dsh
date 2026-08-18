# AGENTS.md — voice_for_dsh 仓库指南

本仓库开发一个 **DSH（DeepSeek Harness）Web 语音朗读插件**：每轮 DeepSeek 输出结束后，把输出内容先做
**口语化转写**（代码/表格/Markdown 等不适合朗读的内容改写为口语），再通过 TTS 播报。

## 仓库使命（一句话）

> 给 dsh web 增加"输出朗读"能力：开关开启 = 每轮结束自动"转写 + 播报"；关闭 = 不自动，
> 但每条助手消息上有"朗读"按钮可手动转写并播报。

## 技术栈与关键事实（先读这里，避免走弯路）

- **目标平台**：dsh web（`dsh --profile web`），运行于 `http://127.0.0.1:3080`。
- **DSH 版本**：`@deepseek-ai/dsh@0.1.0-rc.6`（npx 缓存检出：
  `C:\Users\junar\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`）。
  该检出**不是 git 仓库**，是 npx 缓存；不要在里面改任何文件。
- **DSH_HOME**：`C:\Users\junar\.dsh`；web profile：`C:\Users\junar\.dsh\profiles\web`
  （bundle 列表在 `profiles\web\package.json` 的 `dsh.profile.bundles`）。
- **用户设置**：`C:\Users\junar\.dsh\settings.yaml`（含 `llm-pi-ai.providers`：
  `aliyuncs` 阿里云百炼、`quanzil` 全智；默认模型 `quanzil/deepseek-v4-flash-0731`）。

### 插件形态（本仓库的产物）

1. **正式组合包（bundle）**：npm 包，`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，
   由 `dsh plugin --profile web add <path>`（或 `link:`）装进 profile 的 `node_modules`，
   补丁自动作为新 bundle 层加入 `dsh.profile.bundles`。
2. **双半插件**：
   - Host 半（node）：`lib/index.js`，Cordis 插件 `apply(ctx)`；闭包符号仅
     `ctx`/`harness`/`console`/`btoa`/`atob`/`TextEncoder`/`TextDecoder`。
   - Client 半（browser）：`lib/client.js`，`window.__ModuleLoader__.load({ id, factory })` 格式；
     闭包符号仅 `ctx`/`React`/`host`/`styles`/`console`；**禁止** `import`/`require`/JSX/TS。
   - 两半通信：Host `harness.handle(method, fn)`，Client `host.call(method, args)`（JSON only）。
3. **关键服务（Host）**：`ctx.sessions`（会话事件 `session/event`，事件含 `assistant/message`、
   `turn/end` 等）、`ctx.llm`（`prepareCall` + `stream` 做独立辅助 LLM 调用=口语化转写）、
   `ctx.settings`（注册 `voice` 命名空间 → settings.yaml）、`ctx.webServer`（可选 TTS 音频路由）。
4. **关键槽位（Client）**：`conversation.chat.assistant-actions`（每条消息的操作行 → "朗读"按钮）、
   `conversation.input.left`/`conversation.session.header.actions`（自动播报开关）、
   `conversation.chat.turnTail`（播报状态徽标）、`settings.section`（语音设置页）、
   `shell.overlay`（toast）。**只做 additive 小槽位**，绝不占用 `root`/`conversation.session`。

### 权威文档/代码位置（实现前必查，勿臆造 API）

- 计划与设计：`PLAN.md`（本仓库根；含调研结论、架构、步骤、验收标准）。
- `docs/dsh-plugin-architecture.md`、`docs/voice-pipeline.md`、`docs/dev-playbook.md`。
- DSH 源码参考（只读）：npx 检出的 `node_modules/@deepseek-ai/*`：
  - bundle 补丁：`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`
  - 双半插件范例：`dsh-client-ui-deliverables`、`dsh-client-ui-message-feedback`
  - 客户端闭包：`dsh-cordis-client-runner/lib/client.js`（`CLIENT_BUILTIN_INSPECTION`）
  - Host 闭包：`dsh-cordis-host-runner/lib/types/sandbox.d.ts`（`HOST_BUILTIN_INSPECTION`）
  - 会话事件：`dsh-session/lib/types/types.d.ts`（`SessionEventMap`）
  - LLM：`dsh-llm/lib/types/index.d.ts`（`prepareCall`/`stream`）、`types.d.ts`（`GenerateOptions`）
  - 设置：`dsh-settings`（`SettingsScope`）、`dsh-settings-file`（settings.yaml）
  - 槽位：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
  - 设置槽位：`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`

## 工作约定（开发时遵守）

1. **不要修改 DSH 安装/缓存/ shipped preset**（`agent-presets` 目录、npx 检出、`$DSH_HOME` 下 shipped 文件）。
   用户可写的只有：本仓库、`C:\Users\junar\.dsh\profiles\web\cordis.patch.yml`（用户的 patch 层）、
   `C:\Users\junar\.dsh\settings.yaml`（设置）。
2. **改 Host 半** → 需要重启 dsh（`dsh --profile web`）才能生效。
   **改 Client 半** → 需要重建 client bundle（`pnpm run dev:web` watcher 或 `pnpm run build`）；
   无刷新 HMR 仅在 dev watcher 运行时可用。
3. **验证循环**：装包 → 重启 dsh → 浏览器操作 → 看 console/日志；动态原型可用"创造模式"preset 会话。
4. **命名空间/服务名统一用 `voice`**，避免与既有插件冲突。
5. 转写与 TTS 的 prompt/配置细节统一维护在 `docs/voice-pipeline.md`，改动先更新文档再改代码。
6. 新增 API 调用前，先在 npx 检出的 `.d.ts` 里确认签名（本项目遵循"inspect first"原则）。

## 目录结构

```
voice_for_dsh/
├── PLAN.md                  # 开发计划（总纲）
├── AGENTS.md                # 本文件
├── docs/                    # 架构/转写设计/开发手册
└── packages/
    └── dsh-plugin-voice/    # 插件包（host + client 双半 + cordis.patch.yml）
        ├── src/host/        # Host 半源码
        ├── src/client/      # Client 半源码
        └── lib/             # 构建产物（不提交）
```

## 相关模式（dsh 内置 preset，选择会话时可见）

- `standard` **标准模式** / `code` **PTC 模式** / `minimal` **极简模式** / `cordis` **创造模式**。
- 创造模式 = 标准能力 + Cordis 运行时检查/动态插件实验/预设创作工具，适合**开发试验**；
  成品插件仍要固化为正式 bundle 安装到 web profile。
