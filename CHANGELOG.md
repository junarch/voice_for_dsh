# Changelog

所有显著变更都记录在此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)：x 破坏性 / y 新功能 / z 修 bug。
每个大版本（x 变化）必须在顶部写"升级指引"：改了哪些配置、怎么迁移、不迁移会怎样。

---

## [Unreleased]

（随下一次发版归档到版本号下；当前 `packages/dsh-plugin-voice` 版本 0.4.0。）

### Performance

- **本地 CosyVoice3 CPU 推理提速 1.6-2.1x（RTF 4.56-6.6 → 2.2-3.0），流式首声 21.4s → 5-12s**。
  优化前先量清时间去向：这个"0.5B"只是 AR-LLM 那一段，装机 4.2GB/四个网络、两段串联迭代生成
  （AR-LLM 每秒音频 25 步 → flow 每 chunk 10 步 ODE × CFG 两次前向 → 声码器），
  实测 **flow 是关键路径**（30.2s vs AR-LLM 18.7s，后者跑在并行线程里被盖住）。三条有效杠杆：
  1. **flow ODE 步数 10 → 4**（新增 `--flow-steps`，请求体 `flow_steps` 可覆盖当次；
     设置页新增「合成质量/速度」档：2/3/4/6/10 步）。实测 4 步 flow 19.6s、3 步 13.5s、2 步 9.1s。
  2. **flow 估计器换官方 fp32 ONNX + onnxruntime(CPU)**（`local/onnx/flow.decoder.estimator.fp32.onnx`，
     启动自动探测）：单次前向 **502ms → 280ms**；与 PyTorch 输出相关系数 **1.000000**（同一模型）。
  3. **线程预算分离**（`--torch-threads` 默认 10 / `--ort-threads` 默认 6）：AR-LLM 与 flow 不再抢同一批核，
     同线程预算下首声 12.3s → 5.0s。
  - 被否决：AR-LLM 走 int8 动态量化（每步更快但输出时长 8.8s→12.7s，韵律被改变，整体反而更慢）；
    以后要动 AR-LLM 应走量化 GGUF 后端（社区 PR #1872 未合并）。
  - `/health` 新增 `perf` 字段（当前步数/估计器/线程数），排障时一眼可见实际生效的性能档。
- 新增实测脚本 `tmp/`（不入库）：分段计时 + 配置矩阵、ORT 等价性、线程网格。

### Fixed

- **本地 CosyVoice 播报"点了没声音、CPU 一直满载"**（用户实测）。两个叠加的根因：
  1. **中止不生效 → 孤儿任务占死推理锁**：客户端超时/点停止只断 HTTP，服务端是同步生成器 +
     `list(infer(...))`，会把整段（乃至整篇）算完并一直占着推理锁。实测：**125 字的整段请求被
     客户端 abort 后，服务端仍算满 178.6s（1,999 CPU·秒），期间后续请求被拖到 166.6s 才出声**
     （正常 15-25s）。于是"首段超时 → 整段兜底也超时 → 留下 20 分钟孤儿 → 之后每次点击都排队超时"
     形成死循环，用户侧就是"零声音 + CPU 满载"。
     修法：`local-tts-server-cosyvoice.py` 的推理改为 **async 生成器**，每产出一块前后检查
     `request.is_disconnected()`，断连即退出并释放推理锁；`finally` 里关闭生成器的 await 放进
     `anyio.CancelScope(shield=True)`，**release 放在最后且不依赖任何 await**（取消时 finally 里的
     await 会立刻再次抛 CancelledError，跳过 release 会泄漏锁——这个坑本身也踩了一次）。
     修复后同一实验：中止的请求 22.6s 结束（238 CPU·秒），后续请求 10.6s 出声。
  2. **Host 把流式丢掉了**：`synthesizeLocalSegment` 用 `Buffer.concat` 攒完整段才入队，
     服务端 20 余秒就推了第一块，客户端却要等整段合成完（60 字 ≈ 100s）才有声音。
     修法：改为 `synthesizeLocalSegmentChunks`（边收边吐），Host 每收到一块就按 ~0.5s 音频
     （`采样率×2×0.5` 字节）切一段入队 → **首声从"整段时长"降到"首个分块"**。
- 本地引擎整段兜底不再可能无限空转：孤儿任务消失后，客户端 120s 超时会真正让服务端停下。
- 客户端播放链路可观测：新增 `/voice/api/clientDiag`（客户端上报起播模式 / AudioContext 状态 /
  取段 / 解码 / 结束时的 `played` 段数）与 `/voice/api/clientDiagDump`（读回）。慢引擎首声几十秒，
  "还没算完"与"浏览器没排上播放"必须能区分，不能只靠耳朵。

### Changed

- 本地分句流式首段目标 60 → **40 字**（`splitForStream` 的 firstChars），管线更早进入第 2 段；
  `segmentChars` 保持 120（有了 0.5s 粒度入队后，缩短段长只会增加每段固定的首块开销，反而更慢）。

### Changed

- **转写 prompt 改为"听感优先"取舍标准**：新增总原则——听众只用耳朵、只听一遍、无法回看，
  凡靠眼睛对照才有意义的内容（精确数值、哈希/序列号、版本号、表格逐项参数）不逐个读出，
  用一句定性概括代替；数字仅在承载结论或需据此行动时保留量级/比较。
  同步修正旧规则中鼓励逐字的三处：表格从"逐行转述数值"改为概括结论、
  删除"保留文件名/关键数字"的无差别保留、"必要时读出关键符号名"收紧为标识符/哈希一律不读。
  修复：英文（Kokoro）播报把 commit 哈希、表格字节数等逐字念出的怪异听感。

### Added

- **本地 Kokoro 分句流式播报**（`voice.tts.local.streaming`，默认开）：转写稿按句切成 ~220 字符的段
  （`splitForStream`，纯函数、导出可单测），逐段 `POST response_format:'pcm16'` 取**裸 PCM**，
  复用豆包那套段队列 / 客户端预取 3 段 / Web Audio lookahead 无缝播放（客户端播放链路零改动）。
  - 首声延迟：3606 字符稿从 **40.1s（且撞 30s 超时失败）→ 2.5s**（实测本机 CPU，12 段；
    全篇合成 ~43s 而音频总长 ~220s，合成快于播放、播放不断粮）；
  - 超时语义从"整段死线"改为**单段停顿时限** `segmentTimeoutMs`（默认 30s）：长稿不再因总时长被掐；
  - 失败分档：首段失败 → 自动降级整段 WAV 兜底；中途第 N 段失败 → 保留已播段 + `warn` 注明
    "第 N/M 段起未播报" + 保留 `ttsErrorKind`（toast 仍按因分类）；第三方服务不认 `pcm16` 同样走这条降级；
  - `streaming:false` 可退回整段合成（对照/排查用）；`segmentChars` 可调段长。
- 服务端 `scripts/local-tts-server.py`：`response_format:'pcm16'` 现在真的返回**裸 PCM**
  （16bit 小端 mono、`audio/pcm`）；两种形态都带 `X-Sample-Rate` 响应头（采样率唯一事实源）。
- 新增实机探针 `scripts/local-autostart-probe.mjs --stream`：真实拉起服务 + 真实切分 + 真实合成计时，
  复现上表数字（回归基线）。
- **本地 TTS 服务由 dsh 自动启停**（`voice.tts.local.autoStart`，默认开）：local 合成前先探 `GET /health`——
  已在跑则复用，没跑则经 `ctx.subprocess` 拉起 `scripts/local-tts-server.py` 并轮询到就绪（30s 上限）。
  该子进程归 dsh 托管：插件卸载 / dsh 退出时被回收，不留孤儿、不撞端口——用户不再需要手动跑启动命令。
  新增 `lib/local-supervisor.js`（路径推导 / 健康探测 / 拉起 / 回收 / `speakError`），
  解释器与脚本路径按插件真实位置推导（穿透 profile junction），可用 `voice.tts.local.pythonPath` 覆盖。
- 设置页 local 区块新增「自动启动本地服务」开关与「🔌 本地服务自检」按钮（只读探测，不拉起服务）；
  新增 `/voice/api/localStatus`。
- **TTS 失败文案分类**：播报失败响应新增 `ttsErrorKind`（`unavailable` / `timeout` / `http`），
  toast 由笼统的「TTS 失败，已回退系统朗读」改为按因分类——服务不可达会提示"已尝试自动启动"并指向
  `docs/local-tts.md`，合成超时/服务报错各有专用文案；无 kind 时退回原文案（向后兼容）。
  豆包路径的非 2xx 与帧错误同样标 `http`。

### Fixed

- **`pcm16` 契约与实现不符**：此前该分支被接受却仍返回 WAV 容器（而 `docs/local-tts.md` §4 写的是裸采样），
  现按契约返回裸 PCM；`wav` 分支行为不变。
- i18n 键对齐：`en` 缺 `read.regenerate`，`zh` 缺 `read.stopTitle`/`read.degraded`（英文界面这两处此前显示为 key 本身）；
  `test-client.mjs` 新增 zh/en 键集合一致性断言，防再漏配。
- **本地 Kokoro 播报失败（HTTP 500 Permission denied）**：从 dsh 会话的 shell 启动本地 TTS 服务时，
  进程继承文件沙箱限制；espeak 后端（phonemizer）会在系统临时目录下新建子目录并复制 `espeak-ng.dll`，
  该写入被拒绝 → `/v1/audio/speech` 返回 500（`synthesis failed: [Errno 13] Permission denied: ...\Temp\dsh-*\tmp*\espeak-ng.dll`）
  → 客户端 toast「TTS 失败，已回退系统朗读」，播报落到浏览器 TTS。
  `scripts/local-tts-server.py` 现于加载模型前修正两处：临时目录不可写时改用仓库内 `local/tmp/`，
  且用普通 `mkdir` 替代 `tempfile.mkdtemp`（mkdtemp 的 0o700 目录在沙箱下不可写）；并在启动时清掉残留的 espeak 库副本。
  故障排查已记入 `docs/local-tts.md` §5。
- **本地 TTS 服务的手动启动器**：新增 `scripts/start-local-tts.bat`（双击启动、退出时保留报错输出），
  作为自动启动之外的手动/排查手段（`docs/local-tts.md` §2.2）。

### Docs

- README 新增"项目定位"声明（个人项目 + 双引擎动机：豆包=情感化朗读体验、本地英文 TTS=英文播报中文内容以节省认知资源）与本地 TTS 安装步骤；一致性清理：providers.md（三个 provider 表/归一铁律）、ROADMAP.md（本地 TTS 移出待办）、testing.md 管线图。

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
