# 发布手册（release）

> 目的：把 `voice_for_dsh` 以 MIT 协议发到 GitHub 前，用一张可勾选的清单确认"这项目能放心给别人用"。
> 核心关切只有两条——**① 别因疏忽浪费用户 Token/钱；② 别让用户装不上、用起来炸**。
> 方法见 `docs/testing.md`，命令见 `docs/development.md`。

## 0. 前置

- [ ] `git status` 干净（无未提交改动）。
- [ ] 最近改完 Host 半已重启 dsh；改完 Client 半已刷新浏览器。

## 1. 自动化测试（零成本，每次跑）

- [ ] `node scripts/test-host.mjs` 全绿（每次改 Host 后必跑）。
- [ ] 真实外呼探针（`node scripts/tts-probe.mjs` / `tts-ws-probe.mjs --all`）发布前至少跑一次，确认外部接口没变。

> 记住 testing 的分级：A 类·不变量放心长期信；B 类·外部事实快照是对火山接口某天的记录，发布前跑探针是给它"续命"。

## 2. 防 Token 浪费专项（最高优先级）

> 事故原型：转写代码每条消息悄悄转写 4 次，账单爆了才发现。以下每项看**数字**，不是"听起来正常"。

- [ ] **重复朗读不增 LLM 调用**（test-host 断言：同一消息重复朗读，LLM 调用数不变）。
- [ ] **关闭自动播报时零 LLM**（任何 turn/end 都不触发转写）。
- [ ] **转写完整才写缓存**（WS 中途失败不污染缓存）。
- [ ] **重播 1h 内免重合成**（真实探针验证 `cache_config` 命中、MD5 一致、秒回）。
- [ ] **试听/重新生成绝不下发 cache_config**（防串音）。
- [ ] **账单对账（[必须]）**：用真实 key 正常用 1~2 天，拿火山/DeepSeek 用量页 vs `voice-transcript-cache.json` 的 `at` 记录核对。
- [ ] **降级有声音**：转写失败走兜底时，设置页/按钮显示"转写失败已直读"，不静默。

## 3. 全新安装测试（模拟用户从零装）

- [ ] 把整个仓库复制到全新空目录，完全按 README 的安装步骤走一遍（抓到"依赖没写全/路径写死/忘提交某文件"）。
- [ ] 全新 profile（或干净环境）装完能进设置页、能听到声音。
- [ ] README 无写死的本机绝对路径（如 `C:\Users\junar\...`）；跨平台命令（Windows/macOS/Linux）都齐。
- [ ] `dsh-plugin-voice` 自身的 `lib/` 源码确实在 git 里（别被 .gitignore 误忽略）。

## 4. 手动验收（浏览器，只能人做）

- [ ] 设置页正常渲染；改动能保存（重启后仍在）。
- [ ] 自动播报开/关行为正确；朗读按钮状态机（播放中可停止；播完出现 ↻）。
- [ ] 快速连点、同时两会话——不重播、不卡死、不重叠出声。
- [ ] 长文/纯代码/表格/Markdown/emoji——转写后不破音、不卡壳。
- [ ] 音色↔语种联动：改音色自动纠语种，改语种自动纠音色，不出现"某方言永远改不掉"。
- [ ] 试听不消耗转写（独立路径，不写缓存、不下发 cache_config）。
- [ ] 无声音时（浏览器 + 云 TTS 都失败）有明确提示，不静默失败。

## 5. 跨平台 / 跨环境（[推荐]）

- [ ] Linux 或 WSL 上按 README 装一遍（项目文档目前以 Windows 为主，路径/命令要补跨平台写法）。
- [ ] 两个浏览器（Chrome / Edge）跑一遍核心流程。
- [ ] CI 已配好（`.github/workflows/test.yml`）：发布后 push/PR 自动跑 `node scripts/test-host.mjs`。

## 6. 发布文件就绪（[必须]）

- [ ] 根目录 `README.md`（发布前替换 `<你的用户名>` 占位 + 补截图）。
- [ ] `LICENSE`（MIT 全文，发布前替换署名占位；`packages/dsh-plugin-voice/package.json` 已标 `"license": "MIT"`）。
- [ ] `CODE_OF_CONDUCT.md` / `CONTRIBUTING.md` / `SECURITY.md`（GitHub 有模板）。
- [ ] `.gitignore` 覆盖：`node_modules/`、`tmp/`、本地密钥/配置（`settings.yaml`、`*.key`、`.env`）、日志。
- [ ] **仓库无真实 API key / 私人邮箱 / 本机用户名**：发布前跑 `git grep -n "sk-\|apikey\|api_key"` 自查，
      含 git 历史（若有，发布前用 `git filter-repo` 清洗或至少知道历史里留着）。
- [ ] README 写明**成本与隐私**：哪些操作花 token/钱、内容发往哪些第三方（火山 TTS、DeepSeek/阿里云 LLM）。

## 7. 提交前最终检查（[必须]）

- [ ] 全部自动化测试绿；全新安装测试（§3）通过；手动验收无阻塞项（§4）。
- [ ] 文档三者一致：`README.md` / `docs/pipeline.md` / `docs/development.md` 说的命令、行为、成本与代码对得上。
- [ ] `git log` 提交信息清晰，没有把"工作日志/日期/人名"写进代码注释（版本信息归 git 管）。
- [ ] 打 tag + 写 release notes（`v0.1.0` 起步）。

## 8. 发版流程（SemVer）

```
1. 改代码（本仓库）  2. node scripts/test-host.mjs 全绿  3. 更新 CHANGELOG.md
4. git add 相关 && git commit -m "feat(voice): ..."  5. git push
6. git tag v0.2.0 && git push origin v0.2.0  7. GitHub Releases 写说明
```

**版本号规则（配置演进纪律）**：

| 变更性质 | 版本 | 必须做的 |
|---|---|---|
| 删字段 / 改字段语义 / 配置不兼容 | **x 大版本**（v1→v2） | 兼容层（读新名、读不到读旧名）+ CHANGELOG 顶部"升级指引" |
| 加新字段（带默认值，向后兼容） | **y 中版本**（v0.1→v0.2） | 新字段必须有默认值 |
| 修 bug | **z 小版本**（v0.1.0→v0.1.1） | 无 |

**配置演进铁律**（详见 `docs/pipeline.md` §6"配置演进约定"）：
1. 用户本地 `settings.yaml` 是私有数据——只补默认，绝不覆盖；
2. 新配置永远带默认值（缺了就按默认走，零冲突）；
3. 字段淘汰优先"UI 隐藏 + schema 保留"（零风险），确需真删才写迁移；
4. 改字段语义必须走兼容层（如 `pitchLevel`→`pitch` 用 `pitchOf` 映射）。

## 9. 发布后 72 小时观察窗

- [ ] 盯自己真实使用 + GitHub 首个 issue：有没有"装不上 / 转写多次 / 重复计费"类反馈。
- [ ] 若有人报问题，先复现、先取证（看 `voice-transcript-cache.json` 和 `[voice]` 日志），再改代码。
- [ ] 任何修复都先补一条断言，再改实现。
