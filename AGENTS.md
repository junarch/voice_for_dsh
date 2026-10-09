# AGENTS.md — voice_for_dsh 仓库指南

## 仓库使命（一句话）

> 给 dsh web 增加"输出朗读"能力：开关开启 = 每轮结束自动"转写 + 播报"；关闭 = 不自动，
> 但每条助手消息上有"朗读"按钮可手动转写并播报。

## 技术栈与关键事实（先读这里，避免走弯路）

- **目标平台**：DSH 桌面版（Electron，`http://127.0.0.1:19387`），profile = `desktop`。
- **DSH 版本**：`0.2.0-rc.2`（装机自带，代码在 `<安装目录>\resources\app.asar\dsh`，只读）。
  要 inspect 上游实现：`node scripts/_tmp-asar-extract.mjs <输出目录> <包名…>` 只读导出
  `dsh/node_modules/@deepseek-ai/*`（别直接读 asar 路径，也别改安装目录）。
- **DSH_HOME**：默认 `~/.dsh`；桌面 profile：`$DSH_HOME\profiles\desktop`
  （bundle 列表在 `profiles\desktop\package.json` 的 `dsh.profile.bundles`）。
- **用户设置**：profile 的 `cordis.patch.yml`（patch 层，含本插件 `voice` 条目的 config；勿提交）。
  旧 `$DSH_HOME\settings.yaml` 在 0.2.0 首次启动已改名成 `settings.yaml.imported`，不再被读取。

### 插件形态（本仓库的产物）

1. **正式组合包（bundle）**：npm 包，`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，
   由桌面端 CLI `<安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add <path>`
   （或 `link:`）装进 profile 的 `node_modules`，补丁自动作为新 bundle 层加入 `dsh.profile.bundles`。
2. **双半插件**：
   - Host 半（node）：`lib/index.js`，Cordis 插件 `export { apply, inject, Config }`，
     插件体 `apply(ctx, config)`；正式 bundle 是普通 Node ESM 模块，Node API 直用。
   - Client 半（browser）：`lib/client.js`，`window.__ModuleLoader__.load({ id, factory })` 格式。
     **正式 bundle 的 factory 只拿到 `require`**（可解析 `react` 等少数共享模块）；`ctx` 由 `apply(ctx)` 传入，
     没有 `host`/`styles`（那两个是动态沙箱半专有）。所以与 Host 通信走 HTTP `fetch('/voice/api/…')`，
     样式自己插 `<style data-plugin-css>`。**禁止** `import`/`require`/JSX/TS（除 `require('react')`）。
   - 两半通信：正式 bundle 的 Client 半走 HTTP `fetch('/voice/api/…')`（Host 用 `ctx.webServer` 暴露）；
     `harness.handle` / `host.call` 只在创造模式动态插件里用。
3. **关键服务（Host）**：`ctx.sessions`（会话事件 `session/event`，事件含 `assistant/message`、
   `turn/end` 等）、`ctx.llm`（`prepareCall` + `stream` 做独立辅助 LLM 调用=口语化转写）、
   `ctx.settings`（写入走 `update('voice', patch)`；配置 schema 由插件导出的 `Config` 声明）、
   `ctx.webServer`（可选 TTS 音频路由）、`ctx.subprocess`（拉起本地 TTS 服务）。
4. **关键槽位（Client）**：`conversation.chat.assistant-actions`（每条消息的操作行 → "朗读"按钮）、
   `conversation.input.left`（自动播报开关）、`conversation.chat.turnTail`（播报状态徽标）、
   `settings.section`（语音设置页）、`shell.overlay`（toast）。**只做 additive 小槽位**，
   绝不占用 `root`/`conversation.session`。list 槽位必须有 `id`（`select` 是 chain 槽位专有）。

### 权威文档/代码位置（实现前必查，勿臆造 API）

- 本仓库文档：`docs/architecture.md`（DSH 插件机制与关键决策）、`docs/pipeline.md`
  （转写/TTS 管线行为 + `voice:` schema + 必须守住的不变式）、`docs/development.md`（开发循环）、
  `docs/testing.md`（测试方法）、`docs/release.md`（发布清单）。改动前必读 `docs/pipeline.md` §7"不变式"。
- DSH 源码参考（只读）：用 `scripts/_tmp-asar-extract.mjs` 导出的 `@deepseek-ai/*`：
  - bundle 补丁：`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`
  - 双半插件范例：`dsh-client-ui-deliverables`、`dsh-client-ui-message-feedback`
  - 插件配置模型范例：`dsh-agent-default-model/lib/index.js`（`static Config` + `.volatile()` + `configEditor.edit`）
  - 客户端闭包：`dsh-cordis-client-runner/lib/client.js`（`CLIENT_BUILTIN_INSPECTION`）
  - Host 闭包：`dsh-cordis-host-runner/lib/index.js`（动态沙箱才受限；正式 bundle 是普通 Node 模块）
  - 会话事件：`dsh-session/lib/types/types.js`（`SessionEventMap`）
  - LLM：`dsh-llm/lib/types/index.js`（`prepareCall`/`stream`）
  - 设置：`dsh-settings`（`describe/update/replace/mutate` + `Config` schema 投影）、
    `dsh-config-editor`（写 profile patch 的唯一出口）
  - 槽位：`dsh-client-ui-conversation`、`dsh-client-ui-settings` 的 `lib/index.js`（槽位声明）

## 工作约定（开发时遵守）

1. **不要修改 DSH 安装/缓存/ shipped preset**（`agent-presets` 目录、app.asar 内代码、`$DSH_HOME` 下 shipped 文件）。
   用户可写的只有：本仓库、`$DSH_HOME\profiles\desktop\cordis.patch.yml`（用户的 patch 层，含插件配置）。
2. **改 Host 半**（`packages/dsh-plugin-voice/lib/index.js`）→ 需要重启桌面端 dsh 才能生效。
   **改 Client 半**（`packages/dsh-plugin-voice/lib/client.js`）→ 重启 dsh（client-modules 重新扫描、rev 变化）
   后界面**手动刷新**；v1 为手写纯 JS、**无构建步骤**（`build` 无实际产物），dev:web watcher / HMR 仅后续
   tsdown 化后才可用（详见 `docs/development.md` §1）。
3. **验证循环**：装包 → 重启 dsh → 界面操作 → 看 console/日志；开发试验可用 dsh 内置
   "创造模式"preset（= 标准能力 + 动态插件实验），成品仍固化为正式 bundle 安装到 desktop profile。
4. **命名空间/服务名统一用 `voice`**，避免与既有插件冲突。
5. 转写与 TTS 的 prompt/配置细节统一维护在 `docs/pipeline.md`，改动先更新文档再改代码。
6. 新增 API 调用前，先确认签名：上游实现用 `scripts/_tmp-asar-extract.mjs` 从 app.asar 只读导出后查
   （本项目遵循 "inspect first" 原则）。
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
│                              #   本地 TTS：local-tts-server.py(合成服务) / setup-local-tts.ps1(部署，
│                              #   模型下载到 local/，不入库) / dsh-read-session.mjs(会话日志读取)
└── packages/
    └── dsh-plugin-voice/    # 插件包（host + client 双半 + cordis.patch.yml）
        ├── lib/             # ★ 手写纯 JS 源码（提交，即真实实现）：
        │                    #   index.js=Host 半 / client.js=Client 半 /
        │                    #   speech-clean.js(文本净化) / voice-compat.js(音色↔语种+兼容/归一) /
        │                    #   volcengine-ws.js(豆包双向流)
        └── src/             # 仅结构占位（host/index.ts、client/index.ts 桩，无实际逻辑；
                             #   后续 TS/tsdown 化时的家）
```
