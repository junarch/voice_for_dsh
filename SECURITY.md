# 安全说明（Security）

如果你发现了安全漏洞（比如：未经授权就能触发第三方 API 调用、配置/密钥泄露、远程代码执行等），
**不要**发公开 issue——请走 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页 →
Report a vulnerability），或直接私信维护者。

修复流程：确认 → 修复 + 补一条回归测试（见 `docs/testing.md`）→ 发补丁版本 → 发布说明中致谢（可选）。

## 已知安全模型（现状，请知悉）

- **插件接口只认本机请求**（0.6.1 起）：`/voice/api/*`、`/voice/audio/*`、`/voice/sounds/*` 三条路由
  都要求「连接的对端是回环地址 + `Host` 是本机名（127.0.0.1 / localhost / ::1）」；带 `Origin` 时它还必须与
  `Host` 相同。这样恶意网页即使把自己的域名同时填进 `Host` 与 `Origin`（域名重绑定），也进不来。
  无 Origin 的本机工具（curl）仍可用。
- 插件接口**不回传密钥原文**：`getConfig` / `getState` / `setConfig` 只给 `secrets.volcengine|deepseek`
  的 `set`（配没配）与 `tail`（末四位）。设置页输入框从空开始，占位提示带尾号；要清掉已保存的 key 点「清除」。
- `custom` 网关的自配端点仅接受 `https://`/`wss://`（`lib/index.js` 的 `volcEndpoints` 校验）：
  明文 HTTP 会把 `X-Api-Key` 暴露给传输路径，插件会直接拒绝。
- 请保持 dsh web 绑定 `127.0.0.1`（不要绑 `0.0.0.0`）：绑定到局域网等于把
  LLM/TTS 调用与配置写入口暴露给同网段设备。插件只放行「Host 就是本机地址」的直连，但同网段设备
  仍能读写配置——这一层靠 dsh 的绑定设置，不靠插件。
- `voice.tts.volcengine.apiKey` 与 `voice.tts.deepseek.apiKey` 都明文存在目标 profile 的
  `cordis.patch.yml`（本机私有，勿提交）。设置页不再回读显示原文，但文件本身是明文，请注意文件权限。
  （标成 dsh 的 secret 字段会更糟：设置页保存时会把非 volatile 的 secret 从补丁里剥掉，等于删掉你的 key，
  见 `docs/pipeline.md` §6.0。）
- **本机还会留下两份内容**：转写稿缓存 `$DSH_HOME/voice-transcript-cache.json`（明文 JSON，上限 200 条，
  按 messageId 命中；删掉即失效，不影响配置），以及上传的自定义提示音 `$DSH_HOME/voice/sounds/`。
- **内容会发往哪些第三方**：① 你配置的转写 LLM（每次首次朗读一次调用，连带最近 `transcribe.contextTurns`
  轮对话上下文）；② 豆包 TTS；③ DeepSeek TTS（只在选了该引擎时）；④ 本地模型下载（GitHub Releases，
  仅在点「下载模型」时）。没有埋点、没有遥测、没有第三方字体或 CDN。
- 转写内容会发送给你配置的第三方 LLM / 豆包 / DeepSeek TTS：敏感会话请谨慎。
