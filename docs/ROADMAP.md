# 开发规划（ROADMAP）

> 这里是"未来要做什么"的单一存档点：把想法、规划、已讨论未落地的方案都记在这里，
> 而不是散落在聊天记录里。README 只放"现在有什么"；ROADMAP 放"以后想有什么"。
> 每条规划建议带 `状态：规划中 / 进行中 / 已完成` 与一句"为什么做"。

## 规划中

### 1. 多平台适配（Mac / Linux）
- **状态**：规划中（当前仅 Windows 实测）。
- **为什么**：dsh web 是跨平台产品，用户不只有 Windows。
- **现状**：Host 逻辑已在 CI 的 `ubuntu-latest` 上跑通（`node scripts/test-host.mjs`）；
  未验证的是浏览器语音（`speechSynthesis` 的 Mac/Linux 语音引擎行为、`getVoices` 时序）、
  Windows 专属文案、`dsh plugin add` 路径分隔符等。
- **待办**：在 Mac / Linux 各跑一遍 `docs/release.md` §3 全新安装模拟 + §4 手动验收；
  把发现的差异记进 `docs/platform-notes.md`（新建），README"平台支持"随之更新。

### 2. 新增 TTS 供应商（含本地 TTS 模型）
- **状态**：规划中。
- **为什么**：豆包是付费云服务，本地 TTS（如 Piper、Edge-TTS、本地 TTS 网关）可免费、离线、
  隐私最好（内容不出本机）。
- **现状**：代码已预留 provider 适配层（`browser` / `volcengine`，归一逻辑在
  `lib/voice-compat.js` 的 `ttsProviderOf`）；新供应商的接入规范见 `docs/providers.md`。
- **待办**：按 `docs/providers.md` 的契约接第一个本地 TTS 供应商并写探针。

### 3. Client 半（`lib/client.js`）测试覆盖
- **状态**：规划中。
- **为什么**：Client 是手写 UI 半，目前只有 CI 语法冒烟（`node --check`），无行为测试。
- **方向**：等 tsdown/TS 化落地后，把设置页/朗读按钮/流式播放的可测逻辑抽成可单测的纯函数
  （参考 `voice-compat.js` 的做法）。

### 4. 文档-代码一致性 CI 守护
- **状态**：规划中。
- **为什么**：本轮审计修了一大批"注释引用了不存在的文档/文件名漂移"，
  靠人盯会复发（AGENTS.md 约定"三处一起改"）。
- **方向**：加一个零成本 CI 步骤——校验 `lib/*.js` 注释里引用的 `docs/*.md` 都存在、
  README 无本机绝对路径、音色/语种清单 Host 与 Client `FALLBACK_META` 一致。

### 5. 安全加固收尾（低危）
- **状态**：规划中。
- **为什么**：当前同源校验已挡跨站 CSRF；以下属于纵深防御，非阻塞项。
- **待办**：`getConfig` 对 apiKey 脱敏回传（只回传掩码，避免设置页/日志明文）；
  给 `/voice/audio` 也加同源校验；考虑把 apiKey 改存 dsh 的 credential 域而非 settings.yaml 明文。

## 已完成（近几轮）

- 开源发布前审计与脱敏（本仓库：安全/隐私/SSOT/文档/测试，见 CHANGELOG）。
- 重播 1h 免重合成（服务端缓存 `cache_config` + 参数指纹防串音）。
- 音调细粒度 `pitch`（连续半音）替代五档 `pitchLevel`，兼容层集中到 `voice-compat.js`。

## 已讨论未落地（想法池，捡起来再做）

- 播报历史（已朗读过的内容可回看/复听列表）。
- 语速/音调/音量的**单条消息**级临时覆盖（不写全局配置）。
- 把"转写质量 A/B 评测"做成可重复脚本（当前靠耳朵）。
