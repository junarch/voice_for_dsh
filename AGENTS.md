# AGENTS.md — voice_for_dsh 仓库指南

## 仓库使命（一句话）

> 给 dsh web 增加"输出朗读"能力：开关开启 = 每轮结束自动"转写 + 播报"；关闭 = 不自动，
> 但每条助手消息上有"朗读"按钮可手动转写并播报。

## 技术栈与关键事实（先读这里，避免走弯路）

- **目标平台**：dsh web（`dsh --profile web`），运行于 `http://127.0.0.1:3080`。
- **DSH 版本**：`@deepseek-ai/dsh@0.1.2-rc.1`（npx 缓存检出，路径用 `npm root` 定位，只读）。
- **DSH_HOME**：默认 `~/.dsh`；web profile：`$DSH_HOME\profiles\web`
  （bundle 列表在 `profiles\web\package.json` 的 `dsh.profile.bundles`）。
- **用户设置**：`$DSH_HOME\settings.yaml`（含本机私有 provider 配置，勿提交）。

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

- 本仓库文档：`docs/architecture.md`（DSH 插件机制与关键决策）、`docs/pipeline.md`
  （转写/TTS 管线行为 + `voice:` schema + 必须守住的不变式）、`docs/development.md`（开发循环）、
  `docs/testing.md`（测试方法）、`docs/release.md`（发布清单）。改动前必读 `docs/pipeline.md` §7"不变式"。
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
   用户可写的只有：本仓库、`$DSH_HOME\profiles\web\cordis.patch.yml`（用户的 patch 层）、
   `$DSH_HOME\settings.yaml`（设置）。
2. **改 Host 半**（`packages/dsh-plugin-voice/lib/index.js`）→ 需要重启 dsh（`dsh --profile web`）才能生效。
   **改 Client 半**（`packages/dsh-plugin-voice/lib/client.js`）→ 重启 dsh（client-modules 重新扫描、rev 变化）
   后浏览器**手动刷新**；v1 为手写纯 JS、**无构建步骤**（`build` 无实际产物），dev:web watcher / HMR 仅后续
   tsdown 化后才可用（详见 `docs/development.md` §1）。
3. **验证循环**：装包 → 重启 dsh → 浏览器操作 → 看 console/日志；开发试验可用 dsh 内置
   "创造模式"preset（= 标准能力 + 动态插件实验），成品仍固化为正式 bundle 安装到 web profile。
4. **命名空间/服务名统一用 `voice`**，避免与既有插件冲突。
5. 转写与 TTS 的 prompt/配置细节统一维护在 `docs/pipeline.md`，改动先更新文档再改代码。
6. 新增 API 调用前，先在 npx 检出的 `.d.ts` 里确认签名（本项目遵循"inspect first"原则）。
7. **依赖管理**（原则：git 仓库只存"清单和方法"，不存"货物"）：
   - npm 依赖只声明在 `packages/dsh-plugin-voice/package.json`，`node_modules/` 永不入库；
     引入前核对许可证与必要性。
   - 模型/二进制文件不入库：`.gitignore` 排除目录 + `scripts/` 提供下载脚本 + 文档记录版本
     （例：本地 TTS 的 ONNX 模型、可执行文件）。
   - 外部服务（如本地 TTS server、豆包云端）不作为仓库依赖管理，只写部署/对接文档。
   - 引入新依赖前先说明"为什么需要它、有没有更轻的替代"。

## 目录结构

```
voice_for_dsh/
├── README.md                  # 项目总说明（安装/成本/隐私/协议）
├── AGENTS.md                  # 本文件
├── docs/                      # architecture / pipeline / development / testing / release
├── scripts/                   # 测试与真实外呼探针（test-host.mjs 零成本；tts-*.mjs 花几分钱）
└── packages/
    └── dsh-plugin-voice/    # 插件包（host + client 双半 + cordis.patch.yml）
        ├── lib/             # ★ 手写纯 JS 源码（提交，即真实实现）：
        │                    #   index.js=Host 半 / client.js=Client 半 /
        │                    #   speech-clean.js(文本净化) / voice-compat.js(音色↔语种+兼容/归一) /
        │                    #   volcengine-ws.js(豆包双向流)
        └── src/             # 仅结构占位（host/index.ts、client/index.ts 桩，无实际逻辑；
                             #   后续 TS/tsdown 化时的家）
```
