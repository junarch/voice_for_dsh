# 发布手册（release）

> 目的：把 `voice_for_dsh` 以 MIT 协议发出去之后，"装得上、用得起、不炸"。
> 核心关切两条——**① 别因疏忽浪费用户 Token/钱；② 别让用户装不上或装上就报错**。
> 测试方法见 `docs/testing.md`，开发循环见 `docs/development.md`。

## 0. 版本线现状（发版前先看）

| 位置 | 当前 | 说明 |
|---|---|---|
| 本仓库 | `0.4.2` | 根 `package.json` 与 `packages/dsh-plugin-voice/package.json` 必须同号 |
| GitHub main | `0.4.2` | 已发 Release `v0.4.2`（tag 指向发版提交）；更早的 `0.3.1` 是 0.2.0 时代的写法，装到 0.2.1 桌面端会加载失败 |
| npm | 未发布 | npm 上的 `dsh-plugin-voice` 是另一个同名项目（不是本仓库），同名发布会 403；安装走 GitHub，见 §7 |

发版＝推 main、打 tag、写 Release；安装走 GitHub（npm 同名不可用，见 §7）。

## 1. 自动化门槛（不产生外部调用，每次必跑）

- [ ] `node scripts/test-host.mjs` 全绿。
- [ ] `node scripts/test-client.mjs` 通过（i18n zh/en 键数一致）。
- [ ] `node scripts/test-chime-ui.mjs` 与 `node scripts/test-chime-playback.mjs` 全绿。
- [ ] `node scripts/test-settings-ui.mjs` 全绿（三档引擎下该出现的出现、该藏的不出现）。
- [ ] `node scripts/audit-release.mjs` 全绿（密钥、本机路径、发版物夹带，见 §6）。
- [ ] Client 半 XSS 静态守卫通过（CI 里的"forbid unsafe HTML APIs"步骤：`innerHTML`/`document.write` 等不得出现在 `lib/client.js`）。
- [ ] `node --check` 覆盖 `lib/` 下全部 8 个手写模块（CI 已含）。
- [ ] CI（`.github/workflows/test.yml`）在 PR 上跑过一遍。

> 读数以脚本输出为准，文档里不写死历史条数（改了断言不用回来改这一页）：`test-host` / 两个提示音套件 /
> `test-settings-ui` 打印 `结果: N passed, M failed`，`test-client` 打印合约摘要与 i18n 键数（退出码为准）。

## 2. 防 Token 浪费专项（最高优先级）

> 事故原型：转写代码每条消息悄悄转写 4 次，账单爆了才发现。看**数字**，不是"听起来正常"。

- [ ] 重复朗读不增 LLM 调用（test-host 有断言）。
- [ ] 关闭自动播报时零 LLM 调用（任何 turn/end 都不触发转写）。
- [ ] 转写完整才写缓存（中途失败不污染缓存）。
- [ ] 重播 1 小时内免重合成（真实探针验证 `cache_config` 命中）。
- [ ] 试听/重新生成不下发 `cache_config`（防串音）。
- [ ] **账单对账（必须）**：用真实 key 正常用 1~2 天，拿用量页与 `voice-transcript-cache.json` 的 `at` 记录核对。
- [ ] 降级有声音：转写失败走直读时，界面明确显示，不静默。

## 3. 全新安装（模拟用户从零装）

- [ ] 把仓库复制到全新空目录，完全按 README 走一遍（抓"依赖没写全/路径写死/忘提交文件"）。
- [ ] 全新 profile 装完能进设置页、能听到声音。
- [ ] **干净机器无 Python、无 `local/`**：设置页点「下载模型」→ 进度走完 → 中英各播一次正常。
- [ ] 全程不出现 pip / git / venv 等安装步骤。
- [ ] 删除模型后回到未装态；再装一次能成功（不留 `.tmp-*`）。
- [ ] 发行包与 npm 包里不含模型文件（`npm pack --dry-run` 核对体积）。

## 4. 手动验收（浏览器，只能人做）

- [ ] 设置页首屏只有「常用」一层（引擎 + 自动播报 + 至多一行状态），其余四层收起。
- [ ] 切引擎自动展开「当前引擎的声音」并换成对应内容。
- [ ] 转写层收起时能直接开关；关掉后体内字段不出现。
- [ ] 本地模型：未装/下载中/已装/失败四态都见过一次；删除有二次确认。
- [ ] 提示音默认关闭；打开后出现音量条与三行；三种音都能响。
- [ ] 两个会话同时跑：只要有一份工作音；一个结束 + 一个提问：两种音都能听到。
- [ ] 别的工作区有会话在跑时，切过去仍能听到工作音（Host 账本生效）。
- [ ] 自动播报开/关行为正确；朗读按钮状态机（播放中可停止；播完出现 ↻）。
- [ ] 快速连点、同时两会话——不重播、不卡死、不重叠出声。
- [ ] 长文 / 纯代码 / 表格 / Markdown / emoji——转写后不破音、不卡壳。
- [ ] 音色↔语种联动：改音色自动纠语种，改语种自动纠音色。
- [ ] 无声音时（本地模型缺失 / 豆包失败）有明确提示，不静默失败。

## 5. 跨平台 / 跨环境（推荐）

- [ ] Linux 或 WSL 按 README 装一遍。
- [ ] Chrome / Edge 各跑一遍核心流程。
- [ ] **确认 `sherpa-onnx-node` 在目标平台有预编译产物**（当前验证的是 win32-x64 + Electron 44）。

## 6. 发布文件就绪（必须）

- [ ] README 的安装步骤与截图是新设置页（层数与截图一致：豆包／系统 TTS 四层，本地多一层「高级」）。
- [ ] 对外文档零内部流程用语（不出现项目内部代号、内部页面名、内部术语）。
- [ ] `LICENSE` / `CONTRIBUTING.md` / `SECURITY.md` 内容仍准确。
- [ ] `.gitignore` 覆盖 `node_modules/`、`tmp*/`、`local/`、密钥与日志。
- [ ] `node scripts/audit-release.mjs` 全绿：无密钥形态、无本机用户名路径、profile 与密钥文件未被跟踪、
      发版物只含源码与清单（见下一节）。
- [ ] README 的成本与隐私段落写明：哪些操作花钱、内容发往哪些第三方、模型占盘与内存、提示音素材只存本机。

### 6.1 隐私与安全体检（发版前必跑）

一键：`node scripts/audit-release.mjs`（不联网、不产生外部调用、不改文件；CI 也跑这一条）。它覆盖机器能判的部分：

| 项 | 判据 | 失败意味着 |
|---|---|---|
| 密钥形态 | 跟踪文件里没有 `sk-…`／GitHub token／AWS key／私钥块／硬编码 Bearer／内联 key 赋值 | 有人把真 key 写进了仓库 |
| 本机身份 | 跟踪文件里没有 `C:\Users\<名字>`、`/Users/<名字>`、`/home/<名字>` | 文档或截图路径泄露使用者的用户名 |
| 密钥文件 | 没有跟踪 `.env`、`settings.yaml`、`profiles/`、`*.key`、`*.pem` | 用户配置被提交 |
| 忽略规则 | `.gitignore` 仍覆盖 `node_modules/`、`local/`、`out/`、`*.key`、`*.pem`、`.env`、`tmp*/` | 下次会把模型或密钥提上去 |
| 发版物 | `npm pack --dry-run` 的清单里没有模型／音频／测试／文档目录 | 装包体积失控或夹带本地文件 |
| 体积基线 | 打印本机模型、提示音素材、转写缓存的体积与条目数 | 只用来对比"有没有异常增长" |
| 提交历史 | 全部分支的新增行同样扫一遍，**只报告不判失败**（历史改不掉） | 有人曾经把 key 提交过；要处理得单独改写历史 |

机器判不了、只能人看的四条：

- [ ] **Token 消耗对账**：真实 key 正常用 1–2 天，把用量页与 `voice-transcript-cache.json` 的 `at` 记录对一遍；
      单条消息的 LLM 调用应为「首次朗读 1 次、重播 0 次」（豆包另加段落情感指令，见 §2）。
- [ ] **密钥归属**：`tts.volcengine.apiKey` 只在 profile 的 `cordis.patch.yml` 里（本机私有），
      没有出现在 README、截图、issue、日志或提交里。
- [ ] **资源占用**：本地模型加载后常驻内存约 0.5–0.6GB；不选本地引擎时不加载。
      长时间挂着看任务管理器，Host 进程内存应稳定（模型加载后不再爬升）。
- [ ] **网络出口**：只有三个地方发请求——配置的转写 LLM、豆包 TTS、模型下载（GitHub Releases）。
      没有埋点、没有遥测、没有第三方字体或 CDN。

## 7. 分发方式

**GitHub Release（当前唯一渠道）**：用户按 README 用 `dsh plugin --profile desktop add link:<仓库路径>/packages/dsh-plugin-voice` 安装。

**npm 同名走不通**：npm 上的 `dsh-plugin-voice` 属于另一个同名项目（不是本仓库），同名发布会 403，也不能替它标废弃。
要走 npm 只能换包名（`@账号/dsh-plugin-voice` 或一个全新的名字）；换名要连带改 `cordis.patch.yml` 里的模块名、
profile 里已装的条目与 README 的安装命令，属改名级别改动，需要重装一次插件。

无论走哪条，发布前都要确认：`packages/dsh-plugin-voice/package.json` 的 `files` 只含 `lib/`、`cordis.patch.yml`、`README.md`（模型与测试不入包）。

## 8. 发版流程（SemVer）

1. 改代码（本仓库）。
2. 五个套件 + `node scripts/audit-release.mjs` 全绿（§1）。
3. 更新 `CHANGELOG.md`：把 `[Unreleased]` 收成 `[0.4.0] - 日期`（同一版本只留一个标题）。
4. `git add` 相关文件并 commit。
5. `git push`，等 CI 在 HEAD 上跑绿（README 徽章转绿）。
6. `git tag v0.4.0 && git push origin v0.4.0`。
7. GitHub Release 写说明（含"Python 版 → 0.4.0"升级指引）。
8. 向目录提收录（§9.1），商店随后自动能搜到。

**版本号规则（配置演进纪律）**：

| 变更性质 | 版本 | 必须做的 |
|---|---|---|
| 删字段 / 改字段语义 / 配置不兼容 | **x 大版本** | 兼容层（读新名、读不到读旧名）+ CHANGELOG 顶部"升级指引" |
| 加新字段（带默认值，向后兼容） | **y 中版本** | 新字段必须有默认值 |
| 修 bug | **z 小版本** | 无 |

**配置演进铁律**（详见 `docs/pipeline.md` §6）：
1. 用户本地的 profile patch 是私有数据——只补默认，绝不覆盖；
2. 新配置永远带默认值（缺了就按默认走）；
3. 字段淘汰优先"UI 隐藏 + schema 保留"，确需真删才写迁移；
4. 改字段语义必须走兼容层（如 `provider: local-cosyvoice` 自动归一到 `local`）。

## 9. 发布后 72 小时观察窗

- [ ] 盯真实使用 + 首个 issue：有没有"装不上 / 模型下不来 / 重复计费"类反馈。
- [ ] 提交到目录（§9.1），截图用新版设置页。
- [ ] 有人报问题：先复现、先取证（看 `[voice]` 日志与缓存文件），再改代码。
- [ ] 任何修复都先补一条断言，再改实现。

### 9.1 上架（目录 + 商店）

目录（`awesome-dsh-plugin`）与商店（`dsh-market`）读同一份清单：**只向目录提一次 PR，商店随后自动能搜到**。
前置是 GitHub main 已经是能装的版本——否则别人从目录点进来，装到的是坏的。

1. fork 目录仓库，加一个文件 `data/plugins/junarch__voice_for_dsh--packages-dsh-plugin-voice.yml`：

```yaml
url: https://github.com/junarch/voice_for_dsh/tree/main/packages/dsh-plugin-voice
name: junarch/voice_for_dsh#dsh-plugin-voice
category: voice
description:
  en: Reads each reply aloud after spoken-style transcription, with system TTS, Doubao, or an optional local Kokoro model.
  zh: 把每轮回答改写成口语稿再朗读；支持系统朗读、豆包和可选的本地 Kokoro 模型。
```

2. 提 PR。CI 先校验 YAML、仓库年龄、`dsh-plugin` topic、子包里的 `dsh.bundle`、README 能否重新生成；
   然后人工读仓库，判断描述是否属实、分类是否贴合。**夸大是被退回的主要原因**，描述只写现在真能做的。
3. 合并后，商店（Plugins → Plugin Market）搜 `voice_for_dsh` 就能看到；目录的 README 由脚本生成，不要手改。

维护：

- 卡片上的「DSH 要求」读自 `package.json` 的 `@deepseek-ai/dsh-*` peers，抬版本时同步改 peer 即可；
- 改描述要再提一次 PR 改那个 YAML；README 与截图跟着仓库走，不用重新提；
- 可选加分项：在 YAML 里加 `icon:`，指向仓库中 180×180 的 png（否则列表回退成作者头像）。
