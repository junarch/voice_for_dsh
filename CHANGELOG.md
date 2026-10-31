# Changelog

所有显著变更都记录在此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)：x 破坏性 / y 新功能 / z 修 bug。
每个大版本（x 变化）必须在顶部写"升级指引"：改了哪些配置、怎么迁移、不迁移会怎样。

---

## [0.5.2] - 2026-10-31

### Changed

- **声明宿主要求**：`package.json` 增加 `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`，插件市场据此判断能否安装
  （它只从 npm 包的 manifest 读这一项）。版本不在范围内的会被拒绝。
- **`react` 从 `dependencies` 改为可选 `peerDependencies`**：客户端半的 `react` 由宿主加载器提供，随包装的那份从不生效。
  安装时少一个依赖，行为不变。

### Note

无行为变更：`lib/**` 没改，配置、模型、缓存不受影响；已安装的人不需要动。

## [0.5.1] - 2026-10-31

### Added

- **发布到 npm**：包名 `voice-for-dsh`，安装命令 `dsh plugin --profile desktop add voice-for-dsh`。
  包体 131KB（压缩后，131,023 字节），只含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE` 与 `package.json`；
  本地引擎的原生模块按平台随安装下载（win-x64 约 22MB），模型仍从 GitHub Releases 下载，两者都不进包。

### Changed

- 安装说明改为 npm 优先（根 `README.md`、包内 `README.md`、`docs/release.md`）；源码 `link:` 安装降级为开发用法。
- 包内补 `LICENSE`：MIT 全文随包分发，不再只挂在仓库根。

### Note

无行为变更：`lib/**` 一个字没改，配置、模型、缓存都不受影响；已安装的人不需要动。

## [0.5.0] - 2026-10-31

### Changed

- **包改名：`dsh-plugin-voice` → `voice-for-dsh`**（对外名称 **voice for dsh**）。这个名字是首提交（`ac426c5`，2026-08-19）
  按 DSH 插件的 `dsh-plugin-*` 习惯起的，不是产品名；它在插件市场里表现为 `junarch/voice_for_dsh#dsh-plugin-voice`，
  搜「voice for dsh」搜不到。本次统一改成 `voice-for-dsh`：目录 `packages/voice-for-dsh`、`package.json` 的 `name`、
  `cordis.patch.yml` 的模块名、Client 半的模块 id、脚本与测试里的相对路径、文档与 README 的安装命令、
  `~/.dsh/profiles/desktop/package.json` 里的依赖键与 bundle 名；豆包请求里的 `user.uid` 与运行时共享池的 Symbol 一并改名。
- **不变**：配置命名空间仍是 `voice`（`cordis.patch.yml` 的 `id: voice` 与 profile 里的 `voice:` 配置段一个字不动），
  数据目录仍是 `$DSH_HOME/voice/...`（提示音素材、模型）与 `$DSH_HOME/voice-transcript-cache.json`——改名不影响这些。

### 升级指引（必须做一次）

包名变了，旧安装不会自动换成新包，需要重装一次（配置与模型都不丢）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-plugin-voice
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<仓库路径>/packages/voice-for-dsh"
```

然后**重启桌面端**（Client 半只有重启才进 boot 图）。两条命令要连着做、中间不要启动应用——中间态里 patch 的 `- id: voice`
指向一个还没装上的行，只会告警，装完即消失；不需要手工改 patch。

另外：插件市场的条目文件名带目录名，改名后页面地址会从 `…--packages-dsh-plugin-voice/` 变成 `…--packages-voice-for-dsh/`，
以前分享的旧链接会失效。

## [0.4.2] - 2026-10-30

### Changed

- **本地 TTS 运行时改为进程内共享**：插件重挂（拨插件开关）之后不再重新加载 407MB 模型——进程里只留一份，
  按引用计数共享；插件彻底停用后空闲 10 分钟才释放。实测：共享池下「重挂后再朗读」RSS 512 → 512MB，
  而各代各建一份时是 515 → 949MB，首声还要多等 2–3 秒。删除模型时连共享池一起摘掉，下一代实例拿到的是全新运行时。
  `docs/pipeline.md` 不变式 27 改写，`scripts/test-host.mjs` 新增 8 条断言（复用、引用计数、空闲回收、删模型）。

### Fixed

- **插件停止时不交还本地 TTS 运行时**（重挂/停用之后旧实例的模型还挂在内存里）：本地运行时每次
  启动新建，只有「删除模型」这一条路会 dispose 它；卸载后模型对象只能等下一次 GC 才可能收回。
  现在在 `ctx.effect` 里随插件 fiber 交还运行时（并发取消未完成的模型下载）。实测读数：加载一份模型
  约 +460MB RSS，两份同时在场 949MB；`dispose()` 本身不改变 RSS，真正归还发生在丢引用后的那次 GC。
  `docs/pipeline.md` 补不变式 27，`scripts/test-host.mjs` 补 dispose 语义与「卸载即交还」的回归。
- **插件被宿主重挂时语音整项激活失败**（`webserver: duplicate prefix route "/voice/api"`）：Host 半三处
  `ctx.webServer.register()` 丢弃了返回的撤销函数，插件停止时路由不退，新实例第一次登记就撞上旧路由。
  改为经 `ctx.effect` 登记，路由随插件 fiber 一起撤销；`scripts/test-host.mjs` 补上「停止 → 重挂」回归
  （修复前该回归复现同一句报错）。表现为：在设置里拨任意插件开关、或改插件源码触发热替换后，语音被标成
  激活失败、整项不可用（冷启动不受影响）。

## [0.4.1] - 2026-10-30

### Changed

- **适配声明更新到 DSH 0.2.1-rc.5**：设置页版本行"适配 DSH"从 rc.3 升到 rc.5（rc.3→rc.5 的上游变更不涉及插件接口，全套件通过）；README 与文档版本口径同步。peerDependencies 维持 `^0.2.1-rc.3`——语义范围已覆盖 rc.5，抬门槛反而会拦掉 rc.3/rc.4 用户的安装。
- **自动播报队列溢出可观测**：待播队列超过上限丢最旧一条时补一条 `[voice]` 告警日志（原先静默丢弃），test-host 补对应断言。
- **插件包声明 Node.js 22+**（`engines.node`）：从源码装包时 npm 会在版本不满足时提示；桌面端运行不受影响（跑桌面端自带运行时）。
- **依赖路径单一化**：移除仓库根的 `pnpm-workspace.yaml` 与根 build 脚本（无调用方）；依赖一律装在插件包内、npm 口径、lock 已入库。
- **注释与实现纠偏**：清除注释里的事故复盘与旧版对比叙事（音色试听、豆包服务端缓存、内置音变体、豆包音色数量、本地音色名字表、篇幅三档、工作音判据、变体范围、路由发现行为），删除一段不可达的"自愈写回路由"死代码（行为无变化，真实回退路径在转写失败处理里，注释已指明）。
- 发版手册 §1 补记 CI 的 Client 半 XSS 静态守卫一项。

## [0.4.0] - 2026-10-28

### Added

- **转写提示词按引擎各一份**（`transcribe.promptCloud` / `transcribe.promptLocal`）：豆包那份含情绪/语气段，
  本地那份去掉情绪与演绎要求、改为"按字面念"；留空=该引擎内置默认，界面只显示当前引擎那份，可「恢复默认」。
  两份都从同一份总则长出来，改总则只改一处。旧 `transcribe.prompt` 只在两个新字段都空时兜底。
- **转写篇幅三档**（`transcribe.lengthLevel`）：详细播报（原文 0.9 倍）/ 简单播报（原文一半，夹在 80–450 字）/
  极简播报（原文三成，夹在 50–200 字，结论→关键信息→下一步）。只往 prompt 里加约束，不截断、不动 `maxTokens`。
- **转写提示词精简**：从 10 条规则 + 长总则压到 7 条（并补上原来缺的"不得编造"）；
  语气预设（标准/陪伴/俏皮）只影响豆包、只追加一句语气，不再自带"2~4 句"的篇幅指令。
- **本地播报语种**（`tts.local.language`，设置页「播报语种」）：本地 Kokoro 没有语种参数，按文稿语言发音；
  选中文/英文会让口语稿用该语言输出，选「跟随原文」保持原行为。转写关闭时不翻译，仍按原文。
- **方言说明**：音色区写明模型只有中英两种语言、没有方言（官方文档口径），要方言请用豆包。
- **设置页标题下的版本行**：`voice_for_dsh vX.Y.Z · 适配 DSH A.B.C`（版本号取自 package.json，经 `/voice/api/meta` 下发）。
- **本地音色全表（103 个）**：按官方 `sid → 名字` 表生成，下拉按「英文女 3 / 中文女 55 / 中文男 45」分组，
  标签写 `zf_001` 这类官名；音色提示里写明 sid 就是 `voices.bin` 的行号，并给出官方试听页链接。
- **设置页按引擎显隐的回归防线**：新增 `scripts/test-settings-ui.mjs`，用迷你 React 渲染真组件，
  断言三档引擎下该出现的出现、该藏的不出现（含切引擎重渲染），不重启桌面端即可验证。
- **本地音色直连探针**：`scripts/local-tts-probe.mjs` 绕开插件直接打 sherpa，按不同 sid/speed 打印
  音频指纹，分清"模型只出一个声"与"插件没传音色"。

### Changed

- **篇幅档位改为"按原文比例 + 上下限"**：原来写"原文的九成/五到六成/三成"，跨语言时会失效——
  同一份中文改成英文，字符数天然 2–3 倍，"三成"永远不达标；实测出现过"字符比 1.39、内容其实已压到六成"
  的假象。现在上限 = min(原文, clamp(比例×原文, 下限, 上限))：极简 0.3（50–200）、简单 0.5（80–450）、详细 0.9（不封顶）；原文不足 120 字不给数字；
  prompt 末尾固定追加"输出语言 > 篇幅上限 > 语气文采"的优先级，避免软目标顶掉方言/语种约束，
  也避免 playful 语气把稿子带长。超长只记日志（`[voice] length overshoot`），不截断。
- **豆包音色/语种改完不落盘**（回归修复）：这两行在改成"改动即保存"时漏了写入口——只更新了页面草稿，
  磁盘没动，重开设置页就回旧值（豆包专属行，所以只有它会丢）。现在与其它控件一致：改完立刻写盘，
  换英文音色时联动改掉的语种和音色在同一次提交里。顺带把音色加进"保存后核对"的字段清单，
  写盘失败会如实显示"没写进配置文件"。
- **自定义工作音的循环口径写进设置页**：素材 ≥2 秒无缝循环，<2 秒每 2 秒重放一次（不是无缝拼接），
  界面上直接写明；换素材时连"两响之间"的定时器一起清（否则新素材会被 2 秒节拍一直掐断）。
- **工作音重整**：「低吟」这种长音在后台循环没法听，工作音五个：雨滴 / 滴答 / 仪表盘 / 木鱼 / 轻叩
  （循环几十秒也不会被记住旋律）。参考项目 Reasonix 用的是系统提示音、仓库里没有可取的音频资源，
  所以没有搬运第三方音源；想用别的音可以走「自定义上传」。
- **手动停止不再标红**：系统 TTS 点停止会显示「上次失败：speechSynthesis: interrupted」。根因是我们自己调
  `cancel()`，Chromium 把这次取消报成 `interrupted`，被当成真失败。现在 `interrupted`/`canceled` 走
  "取消"通道：收尾状态、清掉失败文案；被新播报打断的上一条消息也不会留红字。
- **换音效立即生效**：工作音是 loop、节点常驻，旧实现"在响就不重起"→ 任务运行期内换音源不生效。
  现在配置指纹一变就停旧循环、立刻用新音重起；完成/提问这类一次性提示音不打断正在响的那一声。
- **句间停顿 440ms → 220ms**：Kokoro 的句间静音由 `generationConfig.silenceScale` 控制（默认 0.2），
  我们的代码从来没传过它——现在固定传 0.1。中文标点停顿约 220ms、英文约 150ms，听感接近正常呼吸间隔。
  这是本次"断句奇怪"的真正原因；上一版文档把它写成"不可配"是错的，已更正。
- **提示音自带内置变体**：完成音=清铃/木琴/余韵，提问音=轻问/上扬/回声，工作音五个（见上一条）；
  名字进下拉，不再出现"程序合成"字样。`chime.*.source` 取值改为 `a|b|c|d|e` 或 `custom`
  （旧值 `default` 归一成 `a`）。
- **豆包发音组：语种/方言在上、音色在下**；切任何引擎都不再自动展开「当前引擎声音设置」。
- **试听按钮自带停止**：正在响时按钮变「停止试听」，点一下即停（顺带停掉正在播的消息朗读）。
- **「当前引擎的声音」改为「当前引擎声音设置」**，本地模型的安装/删除信息从层头收进层内。
- **「保存」按钮退役**：设置页已经是改动即写盘，留着按钮反而让人以为还要手动点。只在保存失败/没落盘时
  出现「重试保存」。

### Removed

- **设置页的说明段落**：页头那句"每轮回答结束后…"、豆包音色/语种下面三句、本地"没有方言"那句，全部退役；
  必要信息只留在选项名里（例如 English 选项直接写"播报稿改写成英文再念"）。
- **「刷新模型/档位列表」「停止播报」两个按钮**：前者在打开设置页与换 provider/model 时已自动拉取；
  后者与试听合并（模态里能停的出口改为试听按钮）。

- **「停顿风格」选项**：「紧凑」实测是"几乎没有停顿"，听感更差；标点一律保留，不再给用户选。
  相应的 `tts.local.pauseStyle` 字段一并删除（旧配置里的值会被 schema 忽略）。

### Fixed

- **长句被硬切在词中间**：分句流式原来只认句末标点，找不到就硬切（像"话说一半"）。现在退到最后一个
  逗号/顿号再切——影响听感的主因是切段位置，不是标点本身。
- **设置页改的东西不点保存就丢**：切到本地 Kokoro、线程数改 8，重启后回到豆包 / 4。根因是改动只存在页面草稿里，
  只有点「保存」才写盘，而这一步没有存在感（按钮在试听/自检进行中还会被禁用）。现在：开关/下拉/滑块防抖
  400ms 自动写盘、引擎切换立即写、文本框失焦或回车才提交（避免逐字写盘留下半截 apiKey/目录）、
  关闭设置页补写最后一次改动；页面显示「未保存 / 已保存」。
- **保存发的是整份配置**：会把 Host 刚自愈写回的路由、聊天里切过的自动播报覆盖回旧值。改成只发改动字段
  （深合并），并去掉保存成功后用服务器返回值回填草稿（回填会吞掉正在输入的内容）。
- **保存成功不等于落盘成功**：`setConfig` 写完后从 profile patch 读回本次涉及的字段核对，
  对不上返回 `persisted:false`，页面显示"没写进磁盘"而不是假装成功。
- **提示音上传后引用不落盘**：素材已进 `voice/sounds`，配置里的引用却还只在草稿，隔天可能被清扫。
  上传成功即保存该行。
- **本地试听永远用已保存的音色**：设置页选「中文男声 75」不保存直接试听，听到的仍是默认女声（保存值 48）。
  根因是本地合成只把文本与超时传下去，音色/语速由运行时自己回读保存配置。现在本地合成显式接收
  `{sid, speed}`：试听按页面草稿、播报按当次配置快照，一次播报中途保存也不会换声。
- **试听样例语种被隐藏的 `voice.language` 决定**：本地引擎的语种行是隐藏的，样例却按它选英文/中文。
  现在按音色的中/英归属选样例（英文音色 sid 0/2 → 英文），自定义 sid 用中文；标签改显当前音色名。
  系统 TTS 的试听标签一并去掉（它的 `utterance.lang` 恒 zh-CN，语种对它从来不生效）。
- **连点两次试听会叠着响**：上一段没停就播下一段，听起来像"还是旧声音"。试听前先停上一段。
- **线程数与模型目录的生效时机没说**：「高级」层与文档写清——线程数重启应用才生效，模型目录保存后
  下一次合成会重新加载模型（几秒到几十秒）。
- **「高级」层在豆包/系统 TTS 下也摆出来**：合成线程数、分句流式、模型目录三项只作用于本地 Kokoro，
  现在这一层只在引擎=本地时出现；不再让人以为在线合成也要调 CPU 线程。
- **前置条件不说，开关看着像坏了**：豆包缺 API Key 时状态行补一句"自动播报会先失败，再退回浏览器语音"；
  自动播报被成本门控关掉（`autoSpeakCloudTts=false`，手改配置或迁移旧配置会落到这个状态）时，
  直接给出恢复办法（把引擎切走再切回豆包）。
- **自定义网关缺 `wsUrl` 时边说边播静默失效**：网关行下面补一句"会整段合成完再播"（`wsUrl` 至今无界面）。
- **系统语音名填错静默默认**：语音名一行补"名字对不上系统里的语音就按默认音播"。

### 本地运行时与音色能力

#### Added

- **音色能力矩阵**：官方 2.0 音色表里只有 Vivi／小何／云舟／小天 四个音色支持方言（8 种一致），
  其余中文音色只有中文、英文音色只有美式英语。设置页的语种/方言下拉按当前音色过滤——
  **说不了的方言不会出现**；选方言时音色下拉只列能说的音色，英文音色只剩 English。
- **英文音色不再无声**：英文音色读中文文本会返回空音频，现在"英文音色 + 中文"这种组合
  在下拉里就选不出来。

#### Changed

- **不再替用户改配置**：删掉「选方言强制换 Vivi」「改音色强制改语种」「保存时再归一一遍」
  三层自动改写，保存前后配置恒等；旧配置里的冲突值改为读取时软着陆（未知语种→自动、
  方言 + 说不了方言的目录音色→Vivi、英文音色 + 非英文→English、自定义音色 id 不覆盖）。
- **resourceId 不再展示**：插件固定使用豆包语音合成 2.0（`seed-tts-2.0`），请求头写死；
  只有 `gateway=custom` 才读存量覆盖值。存量配置里的旧值不再影响发声。
- **试听不再静默写盘**：点试听用页面当前草稿合成，没按保存就不改配置；提示里带上当前语种。

#### Fixed

- **本地引擎在桌面端整条不出声**：Electron 的 native 运行时以 `TTS settlement failed` 拒绝
  `generateAsync`，但音频已由 `onProgress` 全部给到——现在按成功收尾（试听、整段、流式都恢复）。
- **提示音判据是两套、靠巧合才对**：统一口径——工作音按"dsh 里还有活在跑"（含子代理、
  含别的工作区）、完成音按"顶层会话少一个"（子代理结束不响，多窗口先后结束各响一次）。
- **多窗口停播连坐**：`/voice/api/stop` 支持按会话停；一个窗口停播不再把别的窗口的朗读一起掐掉。
- **方言被锁死在 Vivi**：旧实现把 8 种方言一律接到 Vivi，小何/云舟/小天的方言能力被白砍；
  现在按音色下发 `explicit_dialect`，改音色不再连带改语种。
- **指纹语义变更后串音**：`ttsFp` 加 `v2|` 前缀作废旧落盘缓存条目，避免升级后第一次重播
  命中旧参数音频。
#### Added

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
- **提示音**（`voice.chime`，默认整层关闭）：工作音（**任何会话**在跑时，含子代理与别的工作区）、
  完成音（**顶层会话**少一个时）、提问音（`pendingInteraction` 为 `question`/`plan-review`，审批不响）。
  运行态以客户端 `uiSession.sessionStatus` 快照为主，另加全局 `api-session/status` 事件与 Host 的
  `chimeStatus` 账本，覆盖「冷启动前已开跑」和「其他工作区」的会话；播报关掉也照响。
  子代理在跑会响工作音（有活在跑），但子代理结束不响完成音；完成音按 2.5 秒窗合并、刷新页面不补响。
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

#### Changed

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

#### Fixed

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

#### Docs

- README 重写项目定位与本地 TTS 安装步骤（现在是设置页一键下载，不再是 PowerShell + venv + Python 服务）；
  术语统一：**转写** = 改写成口语稿、**播报** = 交给 TTS 出声的整段流程、**朗读** = 用户点的那一下；
  引擎名统一为「系统 TTS（浏览器语音）／豆包／本地 Kokoro」，不再拿"云"字称呼豆包。
- `docs/architecture.md` 补设置页五层结构与分层理由、提示音信号来源，路由清单补 `/voice/sounds`；
  `docs/providers.md` 把"本地供应商 = 本地 HTTP 服务"改成"优先进程内原生模块，没有绑定才退回 HTTP"；
  `docs/testing.md` 管线图换成进程内版本、补 T21–T24 与提示音断言；
  `docs/ROADMAP.md` 已落地项移入"已完成"，只留未落地的规划。
- README 分工：根 README 保留完整叙事（定位/安装/成本与隐私），`packages/dsh-plugin-voice/README.md`
  收缩成 npm 页——安装命令、配置位置、三行功能、指向 `docs/`。

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
  读到会被忽略——它们仍留在 patch 里（插件不读、也不主动清），想清爽就手动删掉那几行。
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
