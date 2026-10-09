# dsh-plugin-voice

给 DeepSeek Harness Web（dsh web）的语音朗读插件：每轮 DeepSeek 输出结束后，先把输出做
**口语化转写**（代码/表格/Markdown 等改写为适合朗读的口语文稿），再通过 TTS 播报。

## 功能
- 自动播报开关：开 = 每轮结束自动"转写 + 播报"；关 = 不自动。
- 每条助手消息的"朗读"按钮：手动转写并播报该条输出；已完整朗读过的消息旁有 **↻ 重新生成**按钮
  （`regen`：跳过转写缓存，用当前配置重新转写+合成，覆盖旧条目）。
- TTS 可配置（三选一）：默认浏览器 `speechSynthesis`；豆包 TTS（volcengine：双向流 WebSocket 默认 +
  HTTP 单向兜底，8 种方言统一走 vv + `explicit_dialect`，音色↔语种双向自适应——改音色自动纠语种、
  改语种自动纠音色，不锁定音色下拉）；本地 Kokoro-82M（local：免费离线英文播报，中文回复先转写为
  英文口语再朗读；**分句流式**——按句切段逐段合成，长稿首声约 2.5 秒（`voice.tts.local.streaming`）；
  **服务由 dsh 自动启停**——合成前探 `/health`，没跑就经 `ctx.subprocess` 拉起，dsh 退出即回收，
  `voice.tts.local.autoStart` 可关；部署见 `../../docs/local-tts.md`）。
- 播报失败按因提示：服务不可达 / 合成超时 / 服务报错各有 toast 文案（Host 返回 `ttsErrorKind`）。
- 设置持久化在目标 profile 的 `cordis.patch.yml`（`voice` 条目的 `config`）。

## 安装（开发期）
```powershell
# 在仓库根目录执行（相对路径锚定到 cwd）；桌面端自带 CLI：
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add link:packages/dsh-plugin-voice
# 首次或改动依赖后，在插件目录安装一次依赖（link 不会代装插件自身依赖）：
cd packages/dsh-plugin-voice; npm install
# 然后重启桌面端
```

## 配置
见 `../docs/pipeline.md` §6（配置字段说明；DSH 0.2.0 起为插件 `Config` schema + profile patch）。

## 开发
见 `../docs/development.md`（开发循环、创造模式试验、常见坑）。
