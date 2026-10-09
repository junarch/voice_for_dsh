# 如何测试语音插件（testing）

> 回答："除了手动点、用耳朵听，我怎么知道内部管线正不正常？"
> 真实教训：AI 写的转写代码曾每条消息悄悄转写 4 次，用了很久直到 token 账单爆了才发现。
> 手动使用发现不了这类问题，因为**表面（有声音、内容对）掩盖了内部事实（调了几次、花了多少、走了哪条分支）**。

## 0. 核心心法

1. **不问"听起来对吗"，问"每一步发生了什么、发生了几次"。** 把"听感"换成可数指标：LLM 调用次数、TTS 请求次数、缓存命中率、错误码。
2. **每个外部接口都不可信。** 文档会过期、接口会变。对"接口应该怎么表现"的每个假设，要么小实验证实，要么在代码里防御。
3. **发现的事实要固化成可重复的检查。** 实验结论写进文档会过期，写成断言（测试）不会。
4. **断言分两类，别混着信。** "不变量"是我们代码自身的要求，放心长期信；"外部事实快照"是对别人接口某天行为的记录，
   **可能错、会过期**——推翻它必须先拿新证据（跑探针、亲耳听），再同步更新断言+实现+文档三处。测试文件里用醒目注释分开。

## 1. 管线地图（知道要测什么）

```
[DeepSeek 输出完成] -> Host 监听 turn/end(completed|max-tokens) -> 提取最后一条含 text 的助手消息
   -> LLM 口语化转写（独立调用，prompt 由风格预设/语种拼） -> 转写稿缓存（provider/model/prompt/effort 四者一致才命中）
   -> TTS：browser=客户端 speechSynthesis | volcengine=豆包云合成 | local=本地 Kokoro（英文稿）
        └ local：先 supervisor.ensure（探 /health → 复用或经 ctx.subprocess 拉起；dsh 退出回收）
                  → splitForStream 分句 → 逐段 pcm16 合成 → 段队列（首段 ~2.5s 出声）
        | Host 合成 + 一次性音频路由 -> 浏览器播放
```

每一步都有独立失败方式：事件没触发、消息提取错、转写失败/超时/撞顶、缓存没命中（重复烧钱）、TTS 报错、播放失败。
**测试就是逐段验证，而不是只测最后一环。**

## 2. 四层测试手段（从便宜到贵）

### 第 1 层：零成本——mock 集成测试 `scripts/test-host.mjs`
不启动 dsh、不花一分钱，用 mock 的 llm/sessions/settings/fetch 加载真实 `lib/index.js` 驱动完整链路；
插件配置按**真实导出的 `Config` schema**解析（含默认值 + volatile 引用），所以"插件能不能被 0.2.0 正常加载并解析出配置"
这件事本身就有断言兜着（旧缺陷正是加载即 `TypeError`）。已固化大量断言，每条对应一个历史坑：TTS 请求不得含 `[#...]` 标签、数值参数映射、**同一消息重复朗读 LLM 调用数不变**、
撞顶 4 倍额度重试、失败降级、自动播报门控、context_texts 指令组装、音色↔语种归一、重播零 LLM、regen 重新生成、
cache_config 初次/重播下发而 regen/换音色重播不下发等。
每次改完 Host 半必跑。

### 第 1.5 层：零成本——Client 半合约测试 `scripts/test-client.mjs`
不启动浏览器，用最小替身加载真实 `lib/client.js`，**真的执行**槽位注册回调：
按上游 `SlotRegistry.register` 的规则校验（list 槽位必须有 `id`、`select` 只有 chain 槽位认），
并驱动 turnTail 徽标的 claim 逻辑（本轮没有可朗读消息 / 该消息没读过 → 必须返回 null 不占位）、
会话 Definition 注册与 zh/en i18n 键对齐。每次改完 Client 半必跑。

### 第 2 层：零成本——直接打 RPC 接口（dsh 运行中）
一键自检（推荐先跑这个，逐条打印证据、退出码 0/1）：
```powershell
# token 从应用启动日志给的地址里取
node scripts/verify-installed.mjs --url "http://127.0.0.1:19387/?token=xxxx"
```
单项手工打（`curl.exe` 在本机 PowerShell 里可能不可用，改用 `Invoke-WebRequest`）：
```powershell
curl.exe -s -X POST http://127.0.0.1:19387/voice/api/ping
curl.exe -s -X POST http://127.0.0.1:19387/voice/api/getConfig
curl.exe -s -X POST http://127.0.0.1:19387/voice/api/meta
curl.exe -s -X POST http://127.0.0.1:19387/voice/api/preview    # 试听（云 TTS 花几分钱）
curl.exe -s -X POST http://127.0.0.1:19387/voice/api/clientDiagDump   # 读回浏览器播放链路事件
```
看返回关键字段：`cached`（true=缓存命中没花钱）、`degraded`（true=转写失败走兜底）、`ttsError`、`audioUrl`。
播报"没声音"时先看 `clientDiagDump`：`stream-start` 的 `ctx` 是不是 `suspended`、`stream-end` 的 `played`
是不是 0——把"服务端还没算完"与"浏览器根本没排上播放"分开（本地 CPU 引擎首声几十秒，靠耳朵分不出来）。

### 第 3 层：几分钱——真实外呼探针 `scripts/tts-*.mjs`
对火山 TTS 做受控实验（读目标 profile `cordis.patch.yml` 里 `voice.tts.volcengine.apiKey`）。时长对比只能证明"标签被照读/数值参数生效"这类强信号；
**语气、音色、方言这类只有人耳能判断的效果，必须听音频**。怀疑任何外部接口行为时，先跑探针再改代码。

本地服务另有两个零成本探针：`scripts/local-autostart-probe.mjs --stream`（真拉起服务 + 真切分合成计时）
与 `scripts/local-tts-cancel-probe.mjs`（中止/取消后服务端是否停下、推理锁是否被泄漏）。

### 第 4 层：手动验收（最贵，只测前三层测不到的）
浏览器里：设置页渲染、下拉/滑块交互、朗读按钮状态机、自动播报节奏、方言试听。只在这一层测"人能感知"的东西。

## 3. 账单防御

"转写四次"类问题特征：功能表面正常，成本暗中异常。防御手段：

1. **调用计数**：mock 断言"重复朗读不增加 LLM 调用"。
2. **缓存审计**：`$DSH_HOME\voice-transcript-cache.json` 每条含 `at`（时间戳）、`provider/model/prompt`；
   同一条消息出现多条不同 `at`，= 有重复转写（合理原因：改了配置；不合理 = bug）。
3. **降级可见性**：`degraded=true` 时提示"转写失败已直读"——降级是好事，但**静默降级是账单刺客**。
4. **控制台日志**：Host 进程日志里每个关键分支都有 `[voice]` 前缀日志（auto-speak pending / skipped: gated / transcribe failed / cloud tts failed）。
5. **供应商用量页**：每周扫一眼火山/DeepSeek 用量曲线，和平时的形状对比。

## 4. 怎么和 AI 协作做这些

- **让 AI 先写测试再改代码**："先读 docs/testing.md 和 scripts/test-host.mjs，为要改的行为加断言，跑通后再改实现，改完再跑给我看两轮结果"。
- **要 AI 报告"调用次数"而不是"我测过了"**：让它贴出 `node scripts/test-host.mjs` 与 `node scripts/test-client.mjs` 的完整输出。
- **外部接口假设必须给证据**：问一句"这是实测还是推测？"——探针脚本就是为此存在的。
- **每个 bug 修复后问一句**："这个坑怎么变成一条断言？"
- **git 是时光机**：改坏了一键回退。修复前 `git status` 确认干净，修复后 `git diff` 逐行看改动范围。

## 5. 为什么有些断言看着像"故事"（A/B 类断言的由来）

历史上踩过两个典型坑，正好说明"断言必须贴着原始证据"：

- **内嵌 `[#...]` 标签被照读**（2026-08-19）：风格播报把指令标签读出来了。取证→受控实验（同文本 ±标签对比时长）
  实锤"接口不解析标签、照读"。修法不只是"让 LLM 别输出"，而是预设 prompt 不插标签 + Host 兜底剥离一切 `[#...]` +
  语速/音调改走数值参数。每条修法都固化成断言。
- **"字节级相同"的错误结论**（2026-08-20）：第一版探针比较文件**大小**就宣称"指令无效"——CBR 码率 MP3 相同时长必然同大小，
  哈希一查全不同。教训：**断言必须贴着原始证据（哈希/音频/次数），推理链每步都要能被推翻**。这正是 A/B 类断言分工的由来。
