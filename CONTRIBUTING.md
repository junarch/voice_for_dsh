# 贡献指南（Contributing）

感谢你愿意帮忙！这个项目很小、单人维护，几条约定能让双方都省心：

## 报告 Bug / 提需求

- 先开一个 **issue** 讨论，别直接改代码发 PR（避免白干）。
- 报 bug 请带上：DSH 版本、Node 版本、界面版本、目标 profile `cordis.patch.yml` 里 `voice` 条目的配置
  （**贴之前删掉 `apiKey`**）、报错日志。
- 疑似"烧钱/重复计费"问题优先：按 `docs/testing.md` 看 `$DSH_HOME\voice-transcript-cache.json`
  的 `at` 记录和 `[voice]` 日志，贴出来再修。

## 提 PR

1. 先 fork → 在分支上改 → 提 PR 到 `main`。
2. 提交前**必须**通过：`node scripts/test-host.mjs`（本地 mock 集成测试，全绿）。
3. 改动说明写清楚：改了什么、为什么、怎么验证的。
4. 涉及转写/TTS 行为或配置的改动，**同步更新** `docs/pipeline.md`（本项目约定：先更新文档再改代码）。
5. 外部接口行为假设（火山 TTS）请给证据：跑一次 `scripts/tts-*.mjs` 探针，注明是实测还是推测。
6. 提 PR 即表示你同意按本仓库的 [MIT](LICENSE) 协议授权你的贡献。

## 代码约定速记

- Host 半 = `packages/voice-for-dsh/lib/index.js`；Client 半 = `lib/client.js`
  （v1 手写纯 JS，**无构建步骤**，不要跑 `tsc` 期望重建 `lib/`——`src/` 只是占位）。
- 只做 additive 小槽位，不碰 `root`/`conversation.session` 等高危整槽位。
- 命名空间/服务名统一 `voice`。
- 改完 Host 半需重启 dsh；改完 Client 半需重启 dsh + 界面刷新（见 `docs/development.md`）。
