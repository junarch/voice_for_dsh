# Changelog

所有显著变更都记录在此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)：x 破坏性 / y 新功能 / z 修 bug。
每个大版本（x 变化）必须在顶部写"升级指引"：改了哪些配置、怎么迁移、不迁移会怎样。

---

## [Unreleased]

（随下一次发版归档到版本号下；当前 `packages/dsh-plugin-voice` 版本 0.4.0。）

### 升级指引（Python 版 → 0.4.0）

本地合成从"独立的 Python 服务"改成"dsh 进程内原生模块"。这一版对本地引擎是**破坏性**的，
照下面四条做一次即可，其余功能不受影响：

- **模型要重下**：模型包换成 `kokoro-multi-lang-v1_1`（中英混读），旧版 `local/models` 里的英文
  Kokoro v1.0 不再被读取。设置页 →「语音播报」→ **常用** 选「本地 Kokoro」→ **当前引擎的声音**
  层头点「下载模型」（下载 348MB、解包后 407MB，只存本机、可断点续传、装完不用重启）。
  已有解包好的目录可以填进 **高级** 层的「模型目录」直接用。
- **`local/` 可以整个删**：venv、旧引擎的源码与权重、旧模型、临时目录都不再被读写
  （逐项清单见 `docs/local-tts.md` §5.1）。**不需要**再装 Python、不用再起本地服务、不用管端口。
- **配置不用改**：`tts.local.sid`/`speed` 继续生效；旧的 `provider: local-cosyvoice` 会自动归一到
  `local`（旧配置的意图就是"用本地引擎"）；已退役的 `baseUrl`/`voice`/`autoStart`/`pythonPath`
  读到会被忽略，下次保存时被清掉。
- **豆包不受影响**：`tts.volcengine.apiKey` 的位置与写法完全不变（仍是 profile `cordis.patch.yml` 里的明文）。

### 升级指引（0.1.x → 0.2.0，配置位置变更）

- **必须做**：把旧的 `voice` 配置搬进目标 profile。0.2.0 起插件配置不再来自 `$DSH_HOME\settings.yaml`
  （首次启动已被改名成 `settings.yaml.imported`），而是来自 profile 的 `cordis.patch.yml`：
  ```powershell
  node scripts/migrate-voice-config.mjs          # 预览
  node scripts/migrate-voice-config.mjs --write  # 落盘（写前自动备份 patch，幂等）
  ```
  不迁移的后果：转写路由、音色/语速、豆包开关与 apiKey 全部掉回默认值（默认引擎 = 系统 TTS（浏览器语音））。
- **若插件装在旧的 `web` profile**：桌面端只读 `desktop` profile，需要重新装到 desktop
  （`& $dsh plugin --profile desktop add link:packages/dsh-plugin-voice`），否则插件页里根本看不到它。

### Added

- **本地合成改为进程内**（`local` provider 重写）：`sherpa-onnx-node@1.13.8` 直接在 dsh 的 Host 进程里合成
  （Kokoro v1.1，中英跟随原文语言，103 个数字音色），**不起子进程、不装 Python、不监听端口**，
  dsh 退出即随进程释放。模型输出 Float32 24kHz，Host 侧转成客户端唯一认的 16bit 小端裸 PCM
  （`float32ToInt16Pcm`）；整段播报则加 WAV 头，走同一条一次性音频路由回传。
  模型**懒加载**：第一次点朗读才读进内存（本机实测 2.8–2.9s），之后常驻复用（约 510MB，合成后约 600MB）；
  改 `tts.local.modelDir` 会作废已加载实例、按新目录重载。
- **分句流式播报**（`tts.local.streaming`，默认开）：转写稿按句切段（`splitForStream`，目标 220 字符，
  向前找句末标点），逐段合成；每产出约 0.5 秒音频（`采样率×2×0.5` 字节）就切一段入队，
  客户端边取边播——模型已加载时**首声约 0.6 秒**；关掉则退回整段合成（对照/排查用）。
  超时语义是**单段停顿时限** `segmentTimeoutMs`（默认 30s），长稿不会因为总时长被掐。
- **失败按因分类**（`ttsErrorKind`）：本地四类——`model-missing`（模型没装）/ `load-failed`（原生模块或模型
  文件坏了）/ `synth-failed`（合成报错）/ `timeout`（合成超时）；豆包路径的非 2xx 与帧错误记为 `http`。
  toast 按 kind 给专用文案，不再让"模型没装"和"合成失败"共用一句笼统提示。
- **设置页一键安装本地模型**：插件自己下载 → 校验（清单里的 sha256）→ 解包 → 装到
  `<DSH_HOME>/voice/models/kokoro-multi-lang-v1_1`，全程不用终端、装完不用重启。
  - 下载显示已下/总量与百分比，`Range` + `If-Range` **断点续传**（断线自动重试 2 次，失败可点重试接着下）；
    随时可「取消」，取消即清临时文件；解包后归档自动删掉（峰值约 760MB，预检要求 ≥1.2GB 空闲）。
  - 失败分类直接给结论：`network` / `checksum`（上游换了包，等插件升级）/ `disk`（空间不够）/
    `extract`（缺 tar 或写不进去，界面给等价手动命令）。
  - 「删除模型」只删带装机标记的那一份（自己解包的目录显示「不在可删范围」并说明原因）。
  - 代理：`fetch` 默认不走系统代理，需要代理的机器设好 `HTTPS_PROXY`/`HTTP_PROXY` 后加
    `NODE_USE_ENV_PROXY=1` 启动 dsh。
- **设置页改五层渐进展开**：常用（引擎 + 自动播报 + 一行引擎状态）／当前引擎的声音（按引擎只渲染它自己的
  字段，本地模型安装行常驻层头）／转写／高级（线程数、分句流式、模型目录）／提示音。
  除第一层外默认收起，层头带当前值摘要；转写与提示音的主开关放在层头，不展开也能开关。
- **提示音**（`voice.chime`，默认整层关闭）：工作音（顶层会话在跑时）、完成音（running 真→假）、
  提问音（`pendingInteraction` 为 `question`/`plan-review`，审批不响）。信号只从客户端
  `uiSession.sessionStatus` 快照对账，`turn/end` 不参与，播报关掉也照响；子代理会话会被过滤掉。
  - 默认三种音都是程序合成（正弦 + 指数衰减包络），不随包带音频文件。
  - 可上传自定义音：`POST /voice/sounds?kind=work|done|ask&name=<原名>`（≤10MB，按魔数认 mp3/wav/ogg/
    m4a/aac/flac/opus/webm，文件名白名单拒绝 `..`），落盘 `<DSH_HOME>/voice/sounds`；
    `GET /voice/sounds/<file>` 只读不删；未被引用且超过 1 天的文件在启动时清扫。
  - 独立 `AudioContext` + 独立 master gain：提示音不受停止播报影响，播报也不会被提示音打断。
- **运行时自检**：`/voice/api/localStatus` 给模型目录、来源、是否已加载、音色数、采样率、线程数、加载耗时；
  设置页「🔌 运行时自检」按钮手动触发（打开设置页不自动跑）。
- **客户端播放链路可观测**：客户端把起播模式 / AudioContext 状态 / 取段 / 解码 / 结束时的 `played` 段数
  上报 Host（`/voice/api/clientDiag`，`clientDiagDump` 读回）——"还没算完"与"浏览器没排上播放"必须能区分。
- 新增 `scripts/verify-installed.mjs`：重启桌面端后一键自检（Host 路由活着 → Client 半进 boot 图且能取回字节
  → 配置可读 → 本地模型与运行时状态），退出码 0/1，可接进发版检查。

### Changed

- **适配 DSH 0.2.x 的插件配置模型**：`ctx.settings.register(ns, schema)` 已被上游移除，插件改为导出
  `Config`（schemastery schema，可热改字段标 `.volatile()`），插件体 `apply(ctx, config)` 读配置；
  写入仍走 `ctx.settings.update('voice', patch)`（深合并写回 profile patch，volatile 字段热生效、不重挂插件）。
- 依赖与基线对齐：`@deepseek-ai/schemastery ^3.18.4`（`.volatile()` 从该版本才有）、peer 依赖
  `^0.2.1-rc.3`、`@deepseek-ai/cordis ~4.0.4`；新增 `sherpa-onnx-node` 1.13.8（锁死，2.x 不再带 espeak
  回退、词典外的词与数字会被静默跳过）；删掉 0.2.0 里已不存在的 `@deepseek-ai/dsh-client-runtime`，
  peer 全部标 optional。
- **转写 prompt 改为"听感优先"取舍标准**：新增总原则——听众只用耳朵、只听一遍、无法回看，凡靠眼睛对照才有
  意义的内容（精确数值、哈希/序列号、版本号、表格逐项参数）不逐个读出，用一句定性概括代替；数字只在承载
  结论或需据此行动时保留量级/比较。同步收紧旧规则里鼓励逐字的三处（表格概括结论、不给文件名/关键数字
  无差别保留、标识符与哈希一律不读）。修的是"把 commit 哈希、表格字节数逐字念出来"那种怪听感。
- **`autoSpeakCloudTts` 不再出现在界面上**：引擎是"播报引擎"三选一（系统 TTS／豆包／本地 Kokoro），
  该字段只作为直改配置时的成本门控保留。
- 文档/脚本按 desktop profile 与新配置位置重写（`README`、`AGENTS.md`、`docs/*`），并修正两处与上游不符的
  描述：正式 bundle 的 Client 半**没有** `host`/`styles`（那是动态沙箱专有），`turnTail` 是 list 槽位。
- 记下一条实操事实（`docs/development.md` §2）：装完插件或升级依赖后**必须重启桌面端**——Host 半会随
  Loader 热加载，Client 半只有整个应用重启才进 boot 图。

### Fixed

- **PCM 校验误杀正常段**：最初用 MP3 帧同步字（`0xFF 0xEx`）判断「这段不是裸 PCM」，
  而 PCM 段任意起点约有 3% 会撞上这个字节组合——实测播到第 61 段被误判、流中断。
  改为只认 ID3/RIFF/OggS 这类 4 字节容器头，误判率可忽略。
- **长稿播到中途断流（fetch 404）**：客户端改成实时按需取段后，Host 仍按「跑完 8 秒就清段」处理，
  同时滞留上限只有 64 段——长稿播到十几秒就会取到 404、流中断。现在清理时间按「未取走音频还要播多久」
  顺延（上限 30 分钟），滞留上限 512 段、TTL 30 分钟；慢消费探针（每段按真实时长取）无 404。
- **播放队列收紧**：`pumpQueue` 只预排未来 5 秒（原来会把整条音频一口气排到几十秒后）；
  抓取回调绑定发起时的播放轮次，停止后立刻重播不会再把上一轮的残段漏进新一轮；
  解码结果按请求序号放行，两个请求完成顺序颠倒也不跳段；PCM 段加内容校验（长度、容器头），
  非音频内容按解码失败降级。`seg-decoded` 诊断补 `seq` 与 `ahead`。
- **播报时的「滋滋」电流声**：播放器原来按硬件采样率（48 kHz）建 `AudioContext`，却把 24 kHz 的音频段
  直接塞进去——`AudioBufferSourceNode` 会对每个 buffer 单独做采样率转换，在 12 kHz 以上留下约 -28 dB 的
  频谱镜像（回环录音实测；系统播放器播同一段 WAV 为 -47 dB）。现在 `ensureAudioContext(rate)` 把上下文
  固定成音频段的采样率，段不再转换，输出交给 Chromium 的输出重采样器一次完成（同机 A/B：48000 → -29.6 dB，
  24000 → -76.2 dB）。改的是 Client 半，需要重启桌面端生效。
- **"朗读中…"徽标不会收尾**：播报状态是普通对象、变更不通知 React，且停止播放（按钮/换 turn/消息行卸载）
  只停音频不清状态——播完或停掉后界面仍显示"朗读中…"。现在状态变更通知订阅者，停止/出错/被打断
  一律清掉"朗读中"；"朗读中"徽标点击改为**停止**，不再起一条新播报（避免每次点击都重新转写烧 token）。
- 去掉"消息按钮卸载即停播"的清理（滚动/重渲染会误杀正在播的音频）；停播统一到显式停止、换 turn、
  插件卸载三条路径，并在换 turn 时通知 Host 中止后台管线。
- **停止播报不再丢转写缓存**：旧实现用 `!run.stopped` 兜底，用户听到几秒就点停止会让整条转写成果作废，
  下次再点又从头转写（每次一份完整输入 token）。现在转写完整即写缓存；双向流把转写生产者与 TTS 消费者解耦，
  停止时未被 TTS 消费的尾部文本也计入完整稿；中途停止不记录残缺 `segments`（重播不会漏读后文）。
- **段落情感指令加了成本上限**（`MAX_PARAGRAPH_INSTRUCTIONS`）：旧实现每两句话调一次 LLM，长回复能叠出
  几十次辅助调用；超过上限沿用最后一次指令，run 停止后不再发起。
- **i18n 键对齐**：`en` 缺 `read.regenerate`，`zh` 缺 `read.stopTitle`/`read.degraded`（英文界面这两处此前
  显示为 key 本身）；`test-client.mjs` 新增 zh/en 键集合一致性断言，防再漏配。

### Docs

- README 重写项目定位与本地 TTS 安装步骤（现在是设置页一键下载，不再是 PowerShell + venv + Python 服务）；
  术语统一：**转写** = 改写成口语稿、**播报** = 交给 TTS 出声的整段流程、**朗读** = 用户点的那一下；
  引擎名统一为「系统 TTS（浏览器语音）／豆包／本地 Kokoro」，不再拿"云"字称呼豆包。
- `docs/architecture.md` 补设置页五层结构与分层理由、提示音信号来源，路由清单补 `/voice/sounds`；
  `docs/providers.md` 把"本地供应商 = 本地 HTTP 服务"改成"优先进程内原生模块，没有绑定才退回 HTTP"；
  `docs/testing.md` 管线图换成进程内版本、补 T21–T24 与提示音断言；
  `docs/ROADMAP.md` 已落地项移入"已完成"，只留未落地的规划。
- README 分工：根 README 保留完整叙事（定位/安装/成本与隐私），`packages/dsh-plugin-voice/README.md`
  收缩成 npm 页——安装命令、配置位置、三行功能、指向 `docs/`。

## [0.3.1] - 2026-09-06

### Fixed

- CI 徽章红：v0.3.1 新增的 `shell.overlay` toast 槽位未同步 `scripts/test-client.mjs` 的槽位精确清单，
  契约测试报 "unexpected injected slots"（本地只跑 test-host.mjs 未覆盖该测试）。已补清单并本地双测全绿。

- **local 引擎 + 转写关闭的回退对用户可见**（v0.3.0 用户实测踩坑）：转写关闭时直读稿是中文原文，
  按设计不送本地英文引擎、回退系统 TTS——此前该回退只写 console，用户无从得知"为什么还是网页音"。
  - Host：该分支响应新增 `notice`（"本地引擎固定英文播报，需开启「需要转写模型」…"）；
  - Client：新增 `shell.overlay` toast（6s 自动消失），TTS 失败回退 / 转写关闭直读 / 降级直读
    三类降级事件均界面提示，不再只写 console；
  - 设置页：选"本地 Kokoro"但"需要转写模型"未勾选时，当场显示警告。
- 测试：T20 新增 3 条断言（总 196 条全绿）——不合成、notice 文案、零 LLM 调用。

## [0.3.0] - 2026-09-06

### Added

- **本地英文 TTS provider `local`**（Kokoro-82M v1.0，免费、离线、数据不出本机）：
  - 英文播报不变式：`tts.provider=local` 时转写稿固定用英文口语输出（中文回复也转写为英文朗读），
    `voice.language` 的音色↔语种联动仍只作用于豆包；
  - 零额外 LLM：local 无 `context_texts` 情感通道，跳过语音演绎指令生成；
    无服务端缓存语义（本地合成零边际成本）、不走双向流；
  - 免费引擎不受 `autoSpeakCloudTts` 成本门控（自动播报无需付费开关）；
  - 降级直读稿（原文可能是中文）不送 local，客户端回退系统 TTS；
  - 音频格式 WAV（PCM 16bit @24kHz mono），复用 `/voice/audio/<id>` 一次性路由。
- 新配置 `voice.tts.local`（全带默认值，向后兼容）：`baseUrl`（默认
  `http://127.0.0.1:8880/v1/audio/speech`）/ `voice`（默认 `af_heart`）/ `speed` / `timeoutMs`。
- 设置页"云TTS"复选框升级为**播报引擎三选一**：系统 TTS（免费）/ 豆包云 TTS（付费）/
  本地 Kokoro（英文·免费）；切到豆包时仍自动写入 `autoSpeakCloudTts=true`（门控语义不变）。
- `scripts/local-tts-server.py`（OpenAI 兼容 `/v1/audio/speech` 子集，Python + kokoro-onnx）
  与 `scripts/setup-local-tts.ps1`（建 venv + 下载模型到 `local/`，模型不入库）；
  部署/对接文档 `docs/local-tts.md`（同协议现成服务如 remsky/Kokoro-FastAPI 可直接替换）。

### Docs

- `docs/pipeline.md`：新增 §4.3「local（本地 Kokoro-82M v1.0，英文播报）」，§6 schema 增补
  `tts.local`，§7 不变式新增第 10 条（local 固定英文播报且零额外 LLM）；
  "云TTS 复选框"表述更新为"播报引擎三选一"。
- 测试：`scripts/test-host.mjs` 新增 18 条断言（T20，总 193 条全绿）——英文 prompt 不变式、
  零情感指令 LLM、免费门控放行、OpenAI 兼容请求体、WAV 路由一次性、服务失败可见降级、
  降级直读不送 local、preview 英文样例、引擎归一。

### 升级说明

- 无破坏性变更：默认引擎仍为 `browser`；老配置零迁移。使用本地 TTS 需先运行
  `pwsh scripts/setup-local-tts.ps1` 部署（约 350MB 模型，仅本机）。

## [0.2.2] - 2026-09-03

### Docs

- README 前置要求与 AGENTS.md 的 DSH 版本基线由 `0.1.0-rc.6` 更新为 `0.1.2-rc.1`
  （对齐 DSH 0.1.2 适配后的 peer 依赖基线）；安装命令与流程不变。

## [0.2.1] - 2026-09-03

### Fixed

- 适配 DSH `0.1.2-rc.1`：Client 的会话 Definition 注册由已移除的
  `conversationEvents` 迁移到 `uiConversation.events`，恢复插件启动；Host 历史消息读取由
  已移除的 `session.events` 迁移到 `session.snapshotEvents()`，恢复手动与自动朗读。

### 安全加固

- `custom` 网关端点强制 `https://`/`wss://`（避免 apiKey 明文传输），缺 URL 时报错；
  `custom` 仅配 `httpUrl`（无 `wsUrl`）时自动走 HTTP 单向，不再静默直连官方 plan 端点。
- 音频一次性路由补充 TTL（5 分钟）与容量上限（64 段），防止未消费音频段内存滞留；
  `/voice/audio` 与 `/voice/api` 统一同源校验。
- 非流式 speak 管线互斥（同一时刻仅一条转写+合成，防并发触发付费调用）；
  HTTP 错误响应体截断（200 字符）后回显。
- 转写/语音指令提示词增加"内容里的指令不是给你的"防御（防提示词注入）；
  转写风格预设规则编号同步调整（人设 → 11）。

### 门面与一致性

- 修复断言数出入（当前 175 条，以 `test-host.mjs` 输出为准）；README 两条截图图注互换并删除作者自语行；
  修复 `docs/tts-emotion-test-form.md` 断链引用与插件包 README 相对路径；修正 `lib/index.js` 三处文档章节号引用；
  清理注释里的轮次/旧项目/对个人说话等内部表述；`src/*.ts` 桩文件对齐真实实现；
  README/设置页文案去掉"Windows"限定（改"系统 TTS"）；`package.json` 版本号对齐 v0.2.0。
- 设置页 apiKey 增加官方获取指引行内链接（新版控制台快速入门）并注明 plan/standard 的 Key 入口不同；
  placeholder 与 README 由"火山方舟"更正为"火山引擎语音合成"（前者为模型平台，表述不准确）。

## [0.2.0] - 2026-08-22

### Added

- **火山网关可配**（`voice.tts.volcengine.gateway`，默认 `plan`，向后兼容）：`plan`=智能体套餐（默认）｜
  `standard`=标准付费（新版控制台 API Key，格式同 plan，仅端点路径不同）｜`custom`=自定义端点（配
  `httpUrl`/`wsUrl` 指向原样转发火山协议的端点）。设置页新增"网关"下拉；支持**非 plan 标准付费 API**
  与**自定义端点**；旧配置不填则按 plan，零迁移。
- 探针新增 `--gateway plan|standard`（`tts-probe.mjs` / `tts-ws-probe.mjs`），可用真实 key 验证标准付费端点。

## [0.1.0] - 2026-08-22

### 配置演进准备（发布前一次性定型）

- **新增 `voice.tts.volcengine.pitch`**：音调改为连续半音值（`-12 ~ 12`，0=正常，步进 0.1），
  替代原五档 `pitchLevel` 的粗糙调节。旧 `pitchLevel` 仍兼容（自动映射到对应半音，不丢配置）。
- **设置页精简（UI 隐藏，schema 保留，向后兼容）**：以下选项不再显示、走固定默认值——
  `bitRate`(64000)、`expressive`(false)、`emotionGranularity`(paragraph)、`wsUrl`('')、
  `streaming`(true)、`useSectionId`(true)、`interface`(bidirection)、`sampleRate`(24000)。
  老用户在 settings.yaml 里手动配过的这些值仍会被读取生效，不受影响。
- **设置页"云TTS"复选框升级为引擎总开关**：原"云 TTS 自动播报"更名为"云TTS"，并移除"播报方式"下拉。
  勾选 = 引擎切到豆包（付费 API Key 生效）并展开豆包专属配置；取消 = 免费 Windows TTS，
  豆包配置全部隐藏（含手动"朗读"按钮也走免费 TTS）。
  `tts.provider`/`autoSpeakCloudTts` 字段不变：勾选/取消分别写入 `volcengine`/`browser` 与 `true`/`false`，
  直改 settings.yaml 的旧值行为不变。
- 设置页删除"情感控制"说明文字（context_texts 动态情感指令行为未变，仅不再展示）；
  `transcribe.temperature` 滑块补充作用说明（值越大越发散、准确度越低）。
- **`transcribe.reasoningEffort` 固定默认 `off`（转写不开启思考）**，设置页不再显示下拉；
  旧值仍兼容（走降级链）。
- **`transcribe.contextTurns` 固定为 2（引用上文最多往前两轮）**，设置页不再显示输入框。
- **`transcribe.maxTokens` 设置页不再显示**（schema 保留，默认 8192，无需用户调节）：撞顶空稿时
  自动按 4 倍额度重试一次；老用户在 settings.yaml 里手动配置的值仍生效。
- **兼容层集中**：`ttsProviderOf`（引擎归一）、`pitchOf`（音调归一）并入 `lib/voice-compat.js`
  成为配置兼容/归一单一事实源；`speech-clean.js` 只保留文本净化。

### Added

- 开源发布准备：根 `README.md`、`LICENSE`（MIT）、`.github/workflows/test.yml`（CI 自动跑零成本断言集，
  当前 175 条）、`docs/`（architecture / pipeline / development / testing / release）。
- 重播 1h 内免重合成（豆包服务端缓存 `cache_config`，参数指纹一致才命中，试听/regen 不下发）。

### Changed

- 转写、指令、TTS 走缓存；重播零 LLM、1h 内重播零重合成（详见 docs/pipeline.md）。
- **安全加固**：`/voice/api` 增加**同源校验**（`Origin` 与 `Host` 不一致即 403，防恶意网页跨站
  触发付费转写/TTS 与改配置）+ 请求体 1MB 上限；新增对应回归断言（见 scripts/test-host.mjs T1b）。
- 新增 `CODE_OF_CONDUCT.md` / `CONTRIBUTING.md` / `SECURITY.md`；README 增加"贡献与安全"入口。
- 文档/注释脱敏：去除本机绝对路径（`C:\Users\...`）与旧项目引用；修复代码注释对
  `docs/voice-pipeline.md`/`dev-playbook.md`/`PLAN.md` 的断链；移除 `docs/research/` 下的
  火山官方文档副本与内部规划报告（版权/隐私考量）。
- **修复潜在破坏**：`tsconfig.json` 输出目录 `lib`→`dist`（避免 `tsc` 覆盖手写 `lib/client.js`）；
  `package.json` 移除指向不存在的 `lib/types/*` 的类型声明，补 `files` 白名单。
- CI 增加手写 `lib/*.js` 语法冒烟（`node --check`）。
- **图标对齐 DeepSeek 原生风格（`ic_ds_*`）**：消息行的"朗读"按钮去掉文字、改喇叭图标（播放中变停止方块），
  "重新生成"改为纯圆形刷新图标（hover 提示"重新生成"）；"自动朗读"开关只保留"自动"+ 喇叭图标；
  设置页"语音播报"导航图标由齿轮改为喇叭（shell 对未知 section id 回退齿轮，插件用 CSS 替身实现，不侵入 shell）。
  喇叭图形为经典喇叭口 Outline 造型（左箱体 + 扩张喇叭口 + 双声波弧，16×16、stroke 1.3、圆角圆头、铺满画布）；
  React 组件与设置页遮罩共用同一组几何常量。

### Fixed

- 文档与代码不一致项清理（断言数、dev:web 描述、文件引用断链）。

### Removed

- 无破坏性删除（被精简项为 UI 隐藏，schema 字段保留兼容）。
