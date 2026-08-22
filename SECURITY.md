# 安全说明（Security）

如果你发现了安全漏洞（比如：未经授权就能触发付费 API 调用、配置/密钥泄露、远程代码执行等），
**不要**发公开 issue——请走 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页 →
Report a vulnerability），或直接私信维护者。

修复流程：确认 → 修复 + 补一条回归测试（见 `docs/testing.md`）→ 发补丁版本 → 发布说明中致谢（可选）。

## 已知安全模型（现状，请知悉）

- 本插件所有 `/voice/api/*` 与 `/voice/audio/*` 路由运行在 dsh web 进程内，
  仅接受**同源**请求（跨站 POST 会被 403 拒绝，防 CSRF）。
- 请保持 dsh web 绑定 `127.0.0.1`（不要绑 `0.0.0.0`）：绑定到局域网等于把
  LLM/TTS 调用与配置写入口暴露给同网段设备。
- `voice.tts.volcengine.apiKey` 明文存在 `settings.yaml`（本机私有，勿提交），
  设置页会回读显示——不要在多人共享的屏幕上长时间停留设置页。
- 转写内容会发送给你配置的第三方 LLM / 豆包 TTS：敏感会话请谨慎。
