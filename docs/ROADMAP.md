# 开发规划（ROADMAP）

> 这里是"未来要做什么"的单一存档点：把想法、规划、已讨论未落地的方案都记在这里，
> 而不是散落在聊天记录里。README 只放"现在有什么"；ROADMAP 放"以后想有什么"。
> 每条规划带 `状态：规划中 / 进行中` 与一句"为什么做"；做完的移到"已完成"，只留一句结果。

## 规划中

### 1. 多平台适配（Mac / Linux）
- **状态**：规划中（当前仅 Windows 实测）。
- **为什么**：dsh web 是跨平台产品，用户不只有 Windows。
- **现状**：Host 与 Client 的本地 mock 测试（`test-host.mjs` / `test-client.mjs`）已在 CI 的 `ubuntu-latest`
  上跑通；未验证的是浏览器语音（`speechSynthesis` 的 Mac/Linux 语音引擎行为、`getVoices` 时序）、
  `dsh plugin add` 路径分隔符等。
- **最大不确定项是原生模块**：本地引擎靠 sherpa-onnx 的**预编译产物**，Windows 上现成可用，但 macOS
  （arm64 / x64）与 Linux 各是另一份二进制，还要跟桌面端运行时的 Node ABI 对上——没有对应产物时
  `npm install` 会退到本地编译（要工具链），也可能装上了却加载失败。所以多平台验收至少要跑一次
  「装包 → 下载模型 → 点朗读」这条最短链路，不能只看 CI 绿。
- **待办**：在 Mac / Linux 各跑一遍 `docs/release.md` §3 全新安装模拟 + §4 手动验收；
  把发现的差异记进 `docs/platform-notes.md`（新建），README"平台支持"随之更新。

### 2. 接入下一个 TTS 供应商
- **状态**：规划中（本地 Kokoro 已落地，见"已完成"）。
- **为什么**：豆包是第三方云服务；多一个本地方案或另一家云，能满足不同取舍（成本/音质/隐私）。
- **现状**：provider 适配层已覆盖 `browser` / `volcengine` / `local`（归一逻辑在
  `lib/voice-compat.js` 的 `ttsProviderOf`）；接入规范见 `docs/providers.md`。
- **待办**：按 `docs/providers.md` 的契约接入下一个供应商并写探针。

### 3. Client 半（`lib/client.js`）行为测试
- **状态**：规划中。
- **为什么**：Client 是手写 UI 半，合约测试只覆盖槽位注册形状与 i18n 键对齐；设置页五层的展开状态、
  播放队列、提示音对账这些状态机，现在只能靠手动点。
- **方向**：等 tsdown/TS 化落地后，把设置页/朗读按钮/流式播放的可测逻辑抽成可单测的纯函数
  （参考 `voice-compat.js` 的做法）。

### 4. 文档-代码一致性 CI 守护
- **状态**：规划中。
- **为什么**：此前审计修过一批"注释引用了不存在的文档/文件名漂移"，靠人盯会复发。
- **方向**：加一个不产生外部调用的 CI 步骤——校验 `lib/*.js` 注释里引用的 `docs/*.md` 都存在、
  README 无本机绝对路径、音色/语种清单 Host 与 Client `FALLBACK_META` 一致。

### 5. 安全加固收尾（低危）
- **状态**：规划中。
- **为什么**：当前同源校验已挡跨站 CSRF；以下属于纵深防御，非阻塞项。
- **待办**：考虑把 apiKey 改存 dsh 的 credential 域，而不是 profile patch 明文。
  现状是**有意**不标 `role('secret')`：dsh-settings 的写入路径会把非 volatile 的秘密字段从落盘补丁里剥掉，
  而设置页每次保存都整块重写该条目的 config——标成 secret，用户第一次点保存就会把 patch 里的 apiKey 删掉，
  豆包从此失效。所以 key 保持明文（与旧 settings.yaml 同一安全等级）、设置页可读可改；
  要提升等级，得先解决"保存会把 key 抹掉"这件事。

## 已完成（近几轮）

- 本地 TTS 换成**进程内**合成（`local`：sherpa-onnx + Kokoro v1.1，中英跟随原文）：退役 Python 子进程服务
  与旧引擎的源码权重，不用装 Python、不用管端口和子进程。
- 本地模型**设置页一键安装**：自带清单与 SHA-256、断点续传、取消、删除；装完即用，不重启。
- 设置页改**五层渐进展开**（常用／当前引擎的声音／转写／高级／提示音），层头带当前值摘要。
- **提示音**：工作／完成／提问三种，默认关闭、可上传自定义音；信号只从客户端会话状态对账。
- 重启后一键自检 `scripts/verify-installed.mjs`：Host 路由、Client 半是否进 boot 图、配置、本地运行时。
- 开源发布前审计与脱敏（安全/隐私/SSOT/文档/测试，见 CHANGELOG）。
- 安全收尾：`/voice/audio` 与 `/voice/api` 同源校验统一、custom 端点 https/wss 强制、音频路由 TTL/容量上限、非流式 speak 互斥。
- 重播 1h 免重合成（服务端缓存 `cache_config` + 参数指纹防串音）。
- 音调细粒度 `pitch`（连续半音）替代五档 `pitchLevel`，兼容层集中到 `voice-compat.js`。

## 已讨论未落地（想法池，捡起来再做）

- 播报历史（已朗读过的内容可回看/复听列表）。
- 语速/音调/音量的**单条消息**级临时覆盖（不写全局配置）。
- 把"转写质量 A/B 评测"做成可重复脚本（当前靠耳朵）。
