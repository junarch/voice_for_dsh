# 安全说明（Security）

如果你发现了安全漏洞（比如：未经授权就能触发第三方 API 调用、配置/密钥泄露、远程代码执行等），
**不要**发公开 issue——请走 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页 →
Report a vulnerability），或直接私信维护者。

修复流程：确认 → 修复 + 补一条回归测试（见 `docs/testing.md`）→ 发补丁版本 → 发布说明中致谢（可选）。

## 已知安全模型（现状，请知悉）

- 本插件所有 `/voice/api/*` 与 `/voice/audio/*` 路由运行在 dsh web 进程内，
  带 `Origin` 的跨站请求会被 403 拒绝（同源校验，防 CSRF/跨站嵌入）；无 Origin 的本机工具请求放行。
- `custom` 网关的自配端点仅接受 `https://`/`wss://`（`lib/index.js` 的 `volcEndpoints` 校验）：
  明文 HTTP 会把 `X-Api-Key` 暴露给传输路径，插件会直接拒绝。
- 请保持 dsh web 绑定 `127.0.0.1`（不要绑 `0.0.0.0`）：绑定到局域网等于把
  LLM/TTS 调用与配置写入口暴露给同网段设备。
- `voice.tts.volcengine.apiKey` 明文存在目标 profile 的 `cordis.patch.yml`（本机私有，勿提交），
  设置页会回读显示——不要在多人共享的屏幕上长时间停留设置页。
  （标成 dsh 的 secret 字段会更糟：设置页保存时会把非 volatile 的 secret 从补丁里剥掉，等于删掉你的 key，
  见 `docs/pipeline.md` §6.0。）
- 转写内容会发送给你配置的第三方 LLM / 豆包 TTS：敏感会话请谨慎。
