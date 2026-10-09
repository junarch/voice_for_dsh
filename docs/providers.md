# TTS / 转写供应商接入规范（providers）

> 回答两个问题：**现在有哪些供应商、怎么接入新的（含本地 TTS 模型）**。
> 架构背景见 `docs/architecture.md` §7；管线与不变式见 `docs/pipeline.md`。

## 1. 现状（三个 TTS provider）

| provider | 引擎 | 免费/离线 | 鉴权 | 音频回传 |
|---|---|---|---|---|
| `browser`（默认） | 客户端 `speechSynthesis` | 免费、离线 | 无 | 浏览器直接读文本 |
| `volcengine` | 豆包语音合成 2.0（双向流 WS 默认 + HTTP 单向兜底） | 付费、按字符 | `X-Api-Key` | Host 合成 → `/voice/audio/<id>` |
| `local` | 本地 Kokoro-82M v1.0（英文播报，OpenAI 兼容 `/v1/audio/speech`） | 免费、离线 | 无（本机回环） | Host 合成 WAV → `/voice/audio/<id>` |

**归一铁律**：provider 语义统一由 `ttsProviderOf(cfg)`（`lib/voice-compat.js`）归一——
`volcengine`=付费云 TTS（受成本门控）、`local`=本地免费 TTS、其余任何值（含旧值
`openai-compatible`）一律归 `browser`。新供应商**必须**先在 `ttsProviderOf` 登记，
否则永远不会被调用（这是防"未知 provider 悄悄烧钱"的设计）。

### 1.1 网关（volcengine 内部，`voice.tts.volcengine.gateway`）

协议与鉴权头（新版控制台 `X-Api-Key` + `X-Api-Resource-Id`）在三种网关间**完全一致，仅 URL 路径不同**
（端点解析统一在 `lib/index.js` 的 `volcEndpoints(v)`）：

| gateway | 含义 | HTTP 端点 | WS 端点 |
|---|---|---|---|
| `plan`（默认） | 智能体套餐（当前 key） | `/api/v3/plan/tts/unidirectional` | `/api/v3/plan/tts/bidirection` |
| `standard` | 标准付费（新版控制台 key，格式同 plan） | `/api/v3/tts/unidirectional` | `/api/v3/tts/bidirection` |
| `custom` | 自定义端点（填 `httpUrl`/`wsUrl`） | 用户填 | 用户填 |

- **旧版控制台**（`X-Api-App-Id` + `X-Api-Access-Key`）鉴权：**未实现**（官方推荐新版控制台，见 `docs/pipeline.md` §4.2）。
- **第三方端点**分两种：
  - **原样转发火山协议**（NDJSON / WS 二进制帧 + `X-Api-Key`）→ 选 `custom`、把端点填进 `httpUrl`/`wsUrl` 即可；
  - **OpenAI 兼容**（`/v1/audio/speech` + `Authorization: Bearer`，多数 LLM/TTS 平台）→ 当前**不支持**，需按 §3 新增一个 provider。

## 2. 转写 LLM 供应商

转写走 `ctx.llm`（用户已配置的 provider，`voice.provider`/`voice.model`，空=自动发现），
插件不自带凭据、不新建 provider——所以"转写供应商"不需要在插件里扩展，用户配置即有。

## 3. 如何新增一个 TTS 供应商（契约）

分三处改，三处必须一起：

1. **归一**（`lib/voice-compat.js`）：`ttsProviderOf(cfg)` 里识别新值 → 返回新 provider 名；
   需要的话在 `normalizeVoiceConfig` 加字段归一。
2. **Host 适配层**（`lib/index.js`）：实现该 provider 的"合成一段音频"能力，例如：
   - 单向：仿 `synthesizeVolcengine`（fetch + 解析），在 `transcribe()` 的云 TTS 分支按 provider 分发；
   - 流式（可选）：仿 `streamSpeak` + `lib/volcengine-ws.js`，把音频段经 `audioStore` 一次性路由回传。
   - 配置 schema：在 `VoiceSettingsSchema` 加子对象（**必须带默认值**，遵循配置演进纪律 §6.1）。
3. **Client 播放端**（`lib/client.js`）：`playResult` 的 `mode`/`audioUrl` 分支已通用（`stream` / `audioUrl` /
   `transcript`），通常无需改；若新供应商返回不同格式，补对应解码分支（pcm/mp3 已有）。

**测试**：至少加一条 mock 断言（仿 `scripts/test-host.mjs`：该 provider 的请求形状、不发 `[#...]` 标签、
重复朗读缓存命中零新增调用）。真实接口行为用 `scripts/tts-*.mjs` 探针验证。

**同步清单**（防漂移）：
- Client `FALLBACK_META` 若新增音色/语种/档位清单 → 与 Host 同步（无 import 的内联镜像）；
- `docs/pipeline.md` §4（provider 表格 + 参数）、§6（schema）、README"平台支持/引擎"；
- 音色↔语种不变式（方言⟺vv、en⟺英文音色）若被新 provider 打破，改 `voice-compat.js` 并同步 Client。

## 4. 本地 TTS 模型接入（隐私最好的一条路）

已落地：`local` provider（Kokoro-82M v1.0，英文播报），实现与部署见 `docs/local-tts.md`、
`docs/pipeline.md` §4.3。接入下一个本地 TTS（其他模型 / 本地 TTS 网关）的特别约定：

- **隐私卖点**：内容不出本机（可写进 README）。它通常也是一个 HTTP/WS 服务，实现方式与云 provider
  相同（第 3 节），只是 endpoint 指向 `localhost`（OpenAI 兼容 `/v1/audio/speech` 子集可直换 baseUrl 复用）。
- **鉴权**：本地一般无需 key；若本地网关要 key，走 `voice.tts.<provider>.apiKey`（存在目标 profile 的
  `cordis.patch.yml`，明文，勿提交）。
- **缓存**：本地合成零边际成本，v0.3.0 起 local 不做服务端缓存语义；若新模型合成慢需缓存，
  应做**本机音频文件缓存**（`$DSH_HOME\voice-audio-cache/`），这是与云 provider 差异最大的点，接入时单独设计。
- **延迟/流式**：本地模型若支持流式/增量，优先走 `streamSpeak` 双向流路径；不支持就单向整段（local 现状）。
- **新增 schema 时遵循配置演进纪律**：只补默认、绝不覆盖用户配置；新字段带默认值。

## 5. 明确不做什么

- **不引第三方 TTS 适配库**（保持零依赖：现有实现是手写适配层，理由见 `docs/architecture.md` §7）。
- **不发已被淘汰的参数**（如豆包 1.0 的 `emotion`/`emotion_scale`）。
- **不破坏不变式**（`docs/pipeline.md` §7）：text 不含 `[#`、重播零 LLM、缓存完整才写、regen 绝不下发缓存。
