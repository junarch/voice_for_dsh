//#region dsh-plugin-voice — Host half (node, formal bundle)
/**
 * 语音朗读插件 Host 半（正式 bundle，普通 Node ESM 模块，非沙箱）。
 *
 * 职责（PLAN.md §3 / docs/voice-pipeline.md）：
 *  - 注册 `voice` settings 命名空间（→ settings.yaml，热重载）
 *  - 监听 session/event：assistant/message（含 text 块）记录每会话最新可朗读消息；
 *    turn/end（completed|max-tokens）且 autoSpeak=on 时挂起自动播报队列
 *  - ctx.llm 口语化转写（prepareCall + stream，独立辅助调用，不入会话历史）；
 *    推理模型先烧 reasoning token：maxTokens 撞顶且无正文时 4 倍额度重试；
 *    reasoningEffort 可配（抽象档位 off=关闭思考 / low / high / max 等）；模型不支持的档位
 *    自动降级到语义最近的档位（如 off→minimal/low；非推理模型忽略该字段），降级对用户可见
 *  - TTS Provider 适配层：browser（Client speechSynthesis 透传）/ volcengine
 *    （HTTP 单向 chunked JSON 行；语速/音调走数值 speech_rate/pitch 参数，
 *    text 一律剥离 [#...] 指令标签--该接口不解析会照读，探针实测，见
 *    docs/voice-pipeline.md §2.3 与 scripts/tts-probe.mjs）
 *  - 经 ctx.webServer 暴露 /voice/api/* JSON RPC 与 /voice/audio/<id> 音频一次性路由
 *
 * 实测要点（docs/dev-playbook.md §5）：
 *  - SessionEvent 为信封结构 { type, seq, time, data, ... }，payload 在 event.data
 *  - PreparedLlmCall.stream 的 call-config 字段必须与 prepared.config 一致
 *    → 用 Object.assign({}, prepared.config, { system, messages }) 构造请求
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createBidirectionClient, WS_DEFAULTS } from './volcengine-ws.js'
import { sanitizeForSpeech, ttsProviderOf } from './speech-clean.js'
import {
  VV_SPEAKER, LANGUAGE_OPTIONS,
  dialectIdOf, correctSpeakerForLanguage, normalizeVoiceConfig,
} from './voice-compat.js'

/** 转写基线 system prompt（docs/voice-pipeline.md §1.2；可被 voice.transcribe.prompt 覆盖）
 * 规则 9：把内容里的情绪自然写进文字（文本有情绪 → 指令模型才能读出情绪 → TTS 才有情感）。 */
const TRANSCRIBE_SYSTEM = '你是一个"文本口语化转写器"。把用户给你的 AI 助手输出改写为适合 TTS 语音朗读的口语文稿。\n输出语言与原文保持一致：中文原文输出中文口播，英文原文输出英文口播，混合内容跟随主体语言。\n规则：\n1. 代码块（``` ... ``` 或行内 `code`）：不要逐字朗读。用一句话概括其作用，例如"这里给出了一段 Python 代码，作用是读取文件并统计行数"；必要时才读出关键符号名（读作字母/单词）。\n2. 表格：不要朗读 Markdown 表格符号。按行转述："表格第一列是X，第二列是Y；第一行……第二行……"，或概括要点。\n3. 列表：用口语连接词："第一、……；第二、……" 或 "其中包括……"。\n4. URL：只读域名部分（如"链接指向 github 点 com"），不逐字符读。\n5. 符号/缩写：保留重要术语与数字；英文缩写按常见读法（如 API 读作 A-P-I）。\n6. 删除所有 Markdown 标记（#、*、-、|、> 等）、代码符号、JSON 花括号等，除非其内容是结论的一部分。\n7. 保留结论、建议、关键数字、文件名（文件名可读出）、时间等信息。\n8. 语气自然口语化，可用"首先/然后/最后/总之"组织；输出纯文本口播稿，不得包含任何 Markdown 标记（#、*、-、|、> 等）、代码符号、JSON 花括号、表情符号，也不加任何解释或前缀。\n9. 情绪引导：注意内容里的情绪信号（成功/失败/意外/风险/惊喜等），把这种情绪自然地写进措辞与节奏（如"好消息，全部测试通过了"或"这一步有点麻烦，不过……"），让播报带上与内容相符的情绪；但不得编造原文没有的事实或结论。'

/**
 * 语音演绎指令 + 情感 + 情绪强度 撰写器（内容驱动）。
 * 输入：口播文稿；输出严格三行——① 播报指令（8~25 字，经 context_texts 下发）
 * ② 情感标签（固定集合）③ 情绪强度 1~5（反映事情重要/激动程度，动态、不写死）。
 * 「活泼的人有她的方式说伤心的事」：人设由转写 prompt 落进文字，这里把文字里的
 * 情绪翻译成自然语言语音指令（context_texts，所有 2.0 音色生效）。
 */
const INSTRUCTION_EMOTION_SYSTEM = '你是一个"语音演绎指令 + 情感 + 情绪强度"撰写器。根据给定的口播文稿，判断这段文字应该怎么播。\n输出严格三行，不要其他任何内容：\n第一行：一句简短的播报指令（8~25 字），用自然语言祈使句描述语气/节奏/轻重（如"语气轻快活泼一点""温柔而坚定""语速放慢带着一丝无奈"）；情绪平缓就写"用自然平稳的语气说"。\n第二行：只输出一个情感标签词，从下面集合中选最贴近的：开心、悲伤、生气、惊讶、恐惧、厌恶、激动、冷漠、沮丧、中性。平缓无起伏写"中性"。\n第三行：只输出一个 1~5 的整数，表示情绪强度——强度反映事情的重要/激动程度：重大成功、大难题解决=5；小插曲、小情绪=2；完全平静=1；中不溜=3。\n不要括号、引号、编号或解释。'

const PREVIEW_SAMPLE = '你好，这是 dsh 语音播报插件的试听。转写会把代码和表格变成口语，播报验证一二三。'
const PREVIEW_SAMPLE_EN = 'Hi, this is a preview from the dsh voice readout plugin. The transcription turns code and tables into natural speech.'

/** 降级直读：不调 LLM，把 Markdown 剥离为可朗读的纯文本（转写失败/超时兜底）。 */
function toPlainSpoken(text) {
  return sanitizeForSpeech(text)
}

/**
 * 提取并剥离 [#...] 语音指令标签。
 * 豆包 plan 接口不解析内嵌标签、会当正文照读（探针实测 +
 * 用户旧项目 secretary-agent/src/broadcast.ts:44 同结论）；指令内容经官方
 * additions.context_texts 通道下发（指令文本不计费、仅第一个值有效--旧项目注释记录的官方行为）。
 * 返回 { clean, cmds }：clean = 剥离后的文稿，cmds = 提取出的指令内容列表。
 */
function extractVoiceTags(text) {
  const cmds = []
  const clean = String(text || '')
    .replace(/\[#([^\[\]]+)\]/g, (_m, c) => { cmds.push(String(c).trim()); return '' })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return { clean, cmds }
}

/** 火山豆包 2.0 可选音色（精选：中文 4 女 4 男 + 英文，均经
 * scripts/tts-voice-avail-probe.mjs 在 plan 网关 + 双向流实测可用；
 * 设置页下拉 + 允许自定义输入）。
 * 说明：8 种方言统一走 vv（explicit_dialect 实测仅 vv 支持），因此方言模式下
 * 音色锚定 vv（音色↔语种双向自适应，不锁定/不禁用）；English 下自动切英文音色。 */
const VOLC_VOICES = [
  // 中文女声
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0（女）' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何（女）' }, // 用户试听反馈：有台湾腔、听感自然
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0（女）' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0（女）' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0（女）' },
  // 中文男声
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0（男）' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0（男）' },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0（男）' },
  { id: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年 2.0（男）' },
  // 英文
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim（英·男）' },
  { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey（英·女）' },
  { id: 'en_female_stokie_uranus_bigtts', name: 'Stokie（英·女）' },
]

/**
 * 语种/方言选项、英文音色前缀、方言集合与音色↔语种归一逻辑统一维护在
 * lib/voice-compat.js（单一事实源），此处不再重复定义。
 */

/**
 * 情感控制：本插件只适配豆包语音合成模型 2.0（不接 1.0 音色/多情感音色）。
 * 2.0 的情感通道是 additions.context_texts（自然语言语音指令，所有 2.0 音色生效、
 * 不计费、仅第一个值有效——官方 docs/6561/1329505；用户已向火山官方助手核实）。
 * 1.0 的 emotion/emotion_scale 数值参数已淘汰，本插件不发送。
 */

/** 解析三行指令输出（① 指令 ② 情感标签 ③ 情绪强度 1~5）；异常回退：空情感 + 强度 4。
 * ②③ 用于织进 context_texts 情感指令（composeContextText）。 */
function parseInstructionOutput(out) {
  const lines = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)
  const instruction = String(lines[0] || '').replace(/[#【】<>《》\[\]]/g, '').replace(/[“”"']/g, '').replace(/\s+/g, ' ').slice(0, 60)
  let emotion = ''
  if (lines[1]) {
    const zh = String(lines[1]).replace(/[^\u4e00-\u9fa5]/g, '')
    if (zh) emotion = zh
  }
  let intensity = 4
  if (lines[2]) {
    const m = /([1-5])/.exec(lines[2])
    if (m) intensity = Number(m[1])
  }
  return { instruction, emotion, intensity }
}

/** 双向流流式参数（音频格式为 pcm——官方文档推荐流式用 pcm，裸采样无 MP3
 * 帧/编解码器延迟，切在哪都无缝，"逐段解码把字头尾啃掉"的病根不再存在）。
 * 段落/句切分阈值经验值：pcm@24kHz/16bit = 48000B/s。 */
const STREAM = {
  segmentBytes: 48000,        // 音频分段阈值（pcm，约 1s@24k/16bit）
  firstSegmentBytes: 16000,   // 第一段更小，尽早出声（约 0.33s）
  paragraphMinLen: 24,        // 段落最短长度（小于此长度不主动切段，避免把短句切散）
  sentenceEnders: '。！？!?；;\n', // 切段用的句末/换行标记
  maxSessionTimeout: 60000,   // 单个 session 等待结束上限
}

/**
 * 豆包 2.0 语速/音调：五档定性档位 → 数值参数。
 * speech_rate ∈ [-50,100]（100=2.0x、-50=0.5x；探针实测生效）；
 * pitch 为半音 ∈ [-12,12]，经 additions.post_process.pitch（同族单向接口的文档化字段）。
 * 2=正常档不发送参数。[#语音指令] 标签在该接口不解析、会被照读，一律不得进入 text。
 */
const RATE_STOPS = ['很慢', '稍慢', '正常', '稍快', '很快']
const PITCH_STOPS = ['很低', '稍低', '正常', '稍高', '很高']
const RATE_VALUES = [-50, -25, 0, 30, 60]
const PITCH_VALUES = [-6, -3, 0, 3, 6]

/**
 * 播报风格预设（三档 + custom，删除默认/活力/暧昧）。
 * 两条通道：
 *   - prompt：转写 LLM 的系统提示词，决定"稿子像谁写的"（风格主通道）。
 *   - instruct：随请求发给豆包的 context_texts 语音指令（"声音像谁说的"，兜底）。
 * 差异：
 *   - standard 标准：对原文还原度最高（完整逐条口播，不改原意）。
 *   - companion 陪伴 / playful 俏皮：允许总结/简写（不必逐句）、保留关键信息、
 *     捕捉用户输入情绪并个性化回应 = "总结摘要 + 个性化情绪与台词"。
 */
const STYLE_PRESETS = [
  { id: 'standard', name: '标准', prompt: TRANSCRIBE_SYSTEM, instruct: '' }, // 高还原
  {
    id: 'companion', name: '陪伴',
    prompt: TRANSCRIBE_SYSTEM + '\n10. 人设：你是一个温柔细心的"陪伴者"——像深夜陪你赶进度的贴心朋友，用轻软的话接住你的情绪。\n    - 情绪捕捉：如果下方"本轮用户问"里流露了情绪（烦躁、沮丧、高兴、担忧……），先在播报里温柔接一句（如"听起来有点烦，没事，我们慢慢捋"），再报内容；用户没情绪就自然开场。\n    - 摘要简写：不必逐句读，把过程总结成 2~4 句要点，重点讲结论、下一步、关键数字，多余细节略去。\n    - 措辞：多用"我们/我陪着你/慢慢来/不着急"，语尾带"呢/呀/哦"；节奏舒缓，善用省略号留白。\n    - 硬约束：关键信息、数字、结论必须与原文一致；不得编造；不产出任何内嵌指令标签（如方括号标签）。',
    instruct: '温柔地回应，语气柔和',
  },
  {
    id: 'playful', name: '俏皮',
    prompt: TRANSCRIBE_SYSTEM + '\n10. 人设：你是一个机灵幽默的"开发搭子"——像一起熬夜写代码的损友，正经事用玩笑话讲。\n    - 情绪捕捉：如果"本轮用户问"里透露了情绪或事件点（搞砸了、成了、卡住了……），先幽默接一句（如"翻车了？没事，这锅甩给昨天的你"）再报内容。\n    - 摘要简写：不必逐句读，总结成 2~4 句有梗的要点，重点讲结论、下一步、关键数字；爱用"搞定啦/拿下/绝了/这不就来了嘛"。\n    - 节奏：短句，报好消息用感叹号；把代码/表格/配置俏皮地"翻译"成人话。\n    - 硬约束：关键信息、数字、结论必须与原文一致；不得编造；不产出任何内嵌指令标签（如方括号标签）。',
    instruct: '用俏皮幽默的语气说',
  },
]

/**
 * 转写稿缓存：按 messageId 命中（provider/model/prompt/effort 四者一致才用），落盘 DSH_HOME，
 * 重启不丢——避免同一条消息重复转写烧 token。上限 CACHE_LIMIT 条（先进先出截断）。
 */
const CACHE_LIMIT = 200
const CACHE_PATH = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'voice-transcript-cache.json')

function loadTranscriptCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (Array.isArray(raw)) return new Map(raw)
  } catch { /* 首次运行或文件损坏都按空缓存起步 */ }
  return new Map()
}

function saveTranscriptCache(cache) {
  try {
    const entries = [...cache.entries()].slice(-CACHE_LIMIT)
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(entries))
  } catch (error) {
    console.warn('[voice] transcript cache save failed:', error && error.message)
  }
}

/** 思考档位语义降级链：配置的抽象档位 → 依次尝试的实际档位（优先"更省思考"的方向）。
 * 档位词汇跨 provider 不一致（deepseek: off|low|high|max；火山 doubao-seed-2.0: minimal|low|medium|high，
 * 无 off，其"关闭思考"实为 minimal/none）。用户配置的档位模型不支持时，从这里挑最接近的；
 * 全都不支持才放弃发送（跟随适配器默认）。 */
const EFFORT_FALLBACK = {
  off: ['minimal', 'low'],
  minimal: ['low', 'medium', 'off'],
  low: ['medium', 'minimal', 'high'],
  medium: ['low', 'high', 'minimal'],
  high: ['medium', 'max', 'low'],
  xhigh: ['max', 'high'],
  max: ['high', 'xhigh'],
}

/**
 * 把用户配置的抽象思考档位解析为当前 provider/model 实际可发送的档位。
 * @param info llm.resolveModelInfo 的结果（可能带 reasoning.efforts）
 * @param configured 用户配置的档位（'' = 不发送）
 * @returns {{ effort: string|undefined, mapped: boolean, note: string }}
 *   - info == null（能力查询失败/未知）→ 原样发送，交给运行时兜底（mapped=false）
 *   - 模型无 reasoning 元数据（非推理模型）→ 不发档位字段（mapped=true）
 *   - 配置档位被模型支持 → 原样发送（mapped=false）
 *   - 不支持 → 按 EFFORT_FALLBACK 找最近档位；找不到 → 不发（mapped=true，note 向用户说明）
 */
function resolveEffort(info, configured) {
  if (!configured) return { effort: undefined, mapped: false, note: '' }
  if (!info) return { effort: configured, mapped: false, note: '' }
  if (!info.reasoning || !Array.isArray(info.reasoning.efforts)) {
    return { effort: undefined, mapped: true, note: '模型不支持思考档位，已忽略 "' + configured + '"' }
  }
  const supported = new Set(info.reasoning.efforts.map((e) => e && e.id).filter(Boolean))
  if (supported.has(configured)) return { effort: configured, mapped: false, note: '' }
  const fallback = (EFFORT_FALLBACK[configured] || []).find((id) => supported.has(id))
  if (fallback) return { effort: fallback, mapped: true, note: '模型不支持思考档位 "' + configured + '"，已降级为 "' + fallback + '"' }
  return { effort: undefined, mapped: true, note: '模型不支持思考档位 "' + configured + '"，已忽略该设置' }
}

/** settings.yaml 的 voice: 命名空间（字段一次定稿，避免迁移；docs/voice-pipeline.md §4） */
const VoiceSettingsSchema = z.object({
  autoSpeak: z.boolean().default(false),
  autoSpeakCloudTts: z.boolean().default(false),
  language: z.string().default('auto'), // LANGUAGE_OPTIONS 的 id；auto = 跟随原文
  provider: z.string().default(''), // 转写 LLM provider（空 = 启动时发现并自愈写回可用路由）
  model: z.string().default('deepseek-v4-flash'),
  transcribe: z.object({
    enabled: z.boolean().default(true), // 主开关：关=不调转写模型，直接读原文（去 Markdown）
    maxTokens: z.number().default(8192),
    temperature: z.number().default(0.3),
    prompt: z.string().default(''), // stylePreset=custom 时的自定义 prompt
    reasoningEffort: z.string().default('off'), // '' = 跟随适配器默认；deepseek: off|low|high|max
    stylePreset: z.string().default('standard'), // standard|companion|playful|custom（旧值 ambiguous/default/energetic 回退 standard）
    contextTurns: z.number().default(2), // 引用上文：转写时携带的最近轮数（0=关闭）
    timeoutMs: z.number().default(60000), // 单次转写超时；超时/失败降级为直读
  }).default({ enabled: true, maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: 'off', stylePreset: 'standard', contextTurns: 2, timeoutMs: 60000 }),
  tts: z.object({
    provider: z.string().default('browser'), // TTS 引擎：volcengine=豆包；其余（含旧值 openai-compatible）归一为 browser
    browser: z.object({
      rate: z.number().default(1),
      pitch: z.number().default(1),
      voice: z.string().default(''),
    }).default({ rate: 1, pitch: 1, voice: '' }),
    volcengine: z.object({
      apiKey: z.string().default(''),
      resourceId: z.string().default('seed-tts-2.0'),
      speaker: z.string().default('zh_female_vv_uranus_bigtts'),
      sampleRate: z.number().default(24000),
      rateLevel: z.number().default(2),  // RATE_STOPS 下标 0–4
      pitchLevel: z.number().default(2), // PITCH_STOPS 下标 0–4
      // —— 双向流（新增，全部带默认值，向后兼容）——
      interface: z.union([z.const('bidirection'), z.const('http')]).default('bidirection'), // bidirection=WS 双向流 | http=旧 HTTP 单向兜底
      streaming: z.boolean().default(true),   // 双向流下启用"边转写边合成边播"
      wsUrl: z.string().default(''),          // 空 = 默认 plan 网关；可指到 v3 网关（需对应 Key）
      emotionGranularity: z.union([z.const('paragraph'), z.const('message'), z.const('off')]).default('paragraph'), // context_texts 情感指令的动态粒度
      bitRate: z.number().default(64000),     // MP3 比特率（0=不设置；默认 64k 防音质损耗）
      loudness: z.number().default(0),        // 音量 [-50,100]（0=不变）
      useSectionId: z.boolean().default(true),   // additions.section_id（跨次合成语气连续）
      expressive: z.boolean().default(false),    // req_params.model=seed-tts-2.0-expressive（表现力增强）
    }).default({ apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitchLevel: 2, interface: 'bidirection', streaming: true, wsUrl: '', emotionGranularity: 'paragraph', bitRate: 64000, loudness: 0, useSectionId: true, expressive: false }),
  }).default({
    provider: 'browser',
    browser: { rate: 1, pitch: 1, voice: '' },
    volcengine: { apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitchLevel: 2, interface: 'bidirection', streaming: true, wsUrl: '', emotionGranularity: 'paragraph', bitRate: 64000, loudness: 0, useSectionId: true, expressive: false },
  }),
  stopOnNewTurn: z.boolean().default(true),
})

const inject = ['settings', 'webServer']

function apply(ctx) {
  const llm = ctx.get('llm')
  const sessions = ctx.get('sessions')
  if (llm === undefined || sessions === undefined) {
    console.error('[voice] llm or sessions service unavailable; voice plugin idle')
    return
  }

  const scope = ctx.settings.register('voice', VoiceSettingsSchema)

  // ---- session/event：信封结构，payload 在 event.data ------------------------
  function payloadOf(event) {
    return event && event.data && typeof event.data === 'object' ? event.data : null
  }
  function textOfMessage(message) {
    if (!message || !message.content) return ''
    const parts = []
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  const latestBySession = new Map()
  let pendingSpeak = null
  const transcriptCache = loadTranscriptCache()
  /** 转写缓存命中（键：messageId + 路由 + prompt + effort 全一致；HTTP 与流式共用同一形状）。
   * 缓存条目形状：{ transcript(净化稿), provider, model, prompt, effort, sourceChars, at, instruction, emotion, intensity }。 */
  function cachedTranscriptFor(messageId, route, prompt, effort) {
    if (!route) return null
    const c = transcriptCache.get(String(messageId))
    if (!c || c.provider !== route.provider || c.model !== route.model || c.prompt !== prompt || (c.effort || '') !== (effort || '')) return null
    return c
  }
  const audioStore = new Map() // id → { buf: Buffer, mime: string }（一次性取出）
  let currentAbort = null // 进行中的转写，voice.stop 中止
  let turnGeneration = 0 // 每个 turn/start 自增：stopOnNewTurn 的客户端停播信号
  // 双向流流式播报：run 注册表（runId → { queue, done, error, ... }）
  const streamRuns = new Map()
  let currentStreamRun = null
  // 引用上文状态：每会话最近的用户输入与已播报文稿（供转写语境 + TTS 上文引用）
  const turnBySession = new Map()        // sid → 当前 turn（turn/start）
  const userTurnsBySession = new Map()   // sid → [{ turn, text }]（上限 6）
  const transcriptsBySession = new Map() // sid → [{ turn, text }]（上限 4）

  // 思考档位解析缓存：key = provider/model → resolveEffort 结果（避免每次播报都查模型能力）
  const effortCache = new Map()
  /** 取某路由的档位计划：优先用模型能力信息预解析（不支持的档位提前降级，省一次被拒的调用）；
   * 能力查询失败时原样发送，交给运行时兜底（见 transcribe 的 catch 分支）。 */
  async function effortFor(rt, configuredEffort) {
    if (!configuredEffort) return { effort: undefined, mapped: false, note: '' }
    const key = rt.provider + '/' + rt.model + '#' + configuredEffort // 计划同时取决于路由与配置档位
    const hit = effortCache.get(key)
    if (hit) return hit
    let plan
    try {
      const info = await llm.resolveModelInfo(rt.provider, rt.model)
      plan = resolveEffort(info, configuredEffort)
      effortCache.set(key, plan)
    } catch (error) {
      console.warn('[voice] resolveModelInfo failed, effort fallback left to runtime:', String(error && error.message || error))
      plan = { effort: configuredEffort, mapped: false, note: '' }
    }
    return plan
  }

  ctx.on('session/event', (session, event) => {
    if (!event) return
    const d = payloadOf(event)
    const sid = String(session.header.id)
    if (event.type === 'turn/start') {
      if (d && typeof d.turn === 'number') turnBySession.set(sid, d.turn)
      turnGeneration++
      return
    }
    if (event.type === 'user/message') {
      // data 即 UserMessage；归到当前 turn，供"引用上文"
      const text = d ? textOfMessage(d) : ''
      if (text) {
        const list = userTurnsBySession.get(sid) || []
        list.push({ turn: turnBySession.get(sid) || 0, text: text.slice(0, 600) })
        userTurnsBySession.set(sid, list.slice(-6))
      }
      return
    }
    if (event.type === 'assistant/message') {
      if (d && d.message && d.message.id) {
        const text = textOfMessage(d.message)
        if (!text) return // 跳过纯 tool-call 步骤消息
        const entry = { sessionId: sid, messageId: String(d.message.id), turn: d.turn }
        latestBySession.set(sid, entry)
      }
      return
    }
    if (event.type === 'turn/end') {
      const kind = d && d.reason && d.reason.kind
      const turn = d && d.turn
      let cfg
      try { cfg = scope.get() } catch { return }
      if (!cfg.autoSpeak) return
      if (kind !== 'completed' && kind !== 'max-tokens') return
      // 云 TTS 成本门控：未显式允许时自动播报不碰云 TTS
      if (ttsProviderOf(cfg) !== 'browser' && !cfg.autoSpeakCloudTts) {
        console.log('[voice] auto-speak skipped: cloud tts gated (autoSpeakCloudTts=false)')
        return
      }
      const entry = latestBySession.get(sid)
      if (entry && entry.turn === turn) {
        pendingSpeak = { sessionId: entry.sessionId, messageId: entry.messageId, turn: entry.turn }
        console.log('[voice] auto-speak pending:', entry.messageId)
      }
    }
  })

  // ---- 转写 ------------------------------------------------------------------
  async function discoverRoute() {
    const providers = llm.listProviders()
    if (providers.length > 0 && providers[0] && providers[0].id) {
      const provider = String(providers[0].id)
      let model = ''
      try {
        const models = await llm.listModels(provider)
        if (models.length > 0 && models[0] && models[0].id) model = String(models[0].id)
      } catch (error) {
        console.warn('[voice] listModels failed for', provider, error && error.message)
      }
      if (model) return { provider, model }
    }
    throw new Error('no usable llm provider route (set voice.provider/voice.model in settings.yaml)')
  }

  function extractText(sessionId, messageId) {
    const session = sessions.get(sessionId)
    if (!session) return { error: 'session not found: ' + sessionId }
    const events = session.events
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev || ev.type !== 'assistant/message') continue
      const d = payloadOf(ev)
      if (d && d.message && String(d.message.id) === String(messageId)) {
        const text = textOfMessage(d.message)
        if (!text) return { error: 'message has no text blocks' }
        return { text, turn: d.turn }
      }
    }
    return { error: 'assistant/message not found for id: ' + messageId }
  }

  /** 解析实际使用的转写 prompt：预设风格 > 自定义 > 内置基线；叠加语种/方言要求。 */
  function resolvePrompt(cfg) {
    let base
    const preset = cfg.transcribe.stylePreset || 'standard'
    if (preset === 'custom') base = cfg.transcribe.prompt || TRANSCRIBE_SYSTEM
    else { const hit = STYLE_PRESETS.find((p) => p.id === preset); base = (hit && hit.prompt) || TRANSCRIBE_SYSTEM }
    const lang = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
    // 语种/方言属于豆包发音专属：仅豆包 TTS 时叠加转写语言要求（Windows TTS 按原文即可）
    if (lang && lang.id !== 'auto' && ttsProviderOf(cfg) === 'volcengine') {
      base += '\n附加要求：无论原文是什么语言，口播稿必须用' + lang.instruct + '输出'
        + (lang.dialect ? '（用字保持中文书写习惯，语汇贴近该方言的口语）' : '') + '。'
    }
    return base
  }

  /** 引用上文：组装该消息所在轮之前的最近 N 轮（用户输入 + 我的播报文稿）+ 本轮用户输入。 */
  function buildContext(sessionId, currentTurn, maxTurns) {
    if (!maxTurns) return { block: '', currentUserText: '' }
    const users = userTurnsBySession.get(sessionId) || []
    const transcripts = transcriptsBySession.get(sessionId) || []
    const turnSet = new Set()
    for (const u of users) if (u.turn < currentTurn) turnSet.add(u.turn)
    for (const t of transcripts) if (t.turn < currentTurn) turnSet.add(t.turn)
    const pastTurns = [...turnSet].sort((a, b) => a - b).slice(-maxTurns)
    const lines = []
    for (const t of pastTurns) {
      const u = users.filter((x) => x.turn === t).pop()
      const tr = transcripts.filter((x) => x.turn === t).pop()
      if (u) lines.push('用户问：' + u.text)
      if (tr) lines.push('我当时播报：' + tr.text)
    }
    const cur = users.filter((x) => x.turn === currentTurn).pop()
    const currentUserText = cur ? cur.text : ''
    if (currentUserText) lines.push('本轮用户问：' + currentUserText)
    return { block: lines.join('\n'), currentUserText }
  }

  // ---- TTS Provider 适配层 -----------------------------------------------------
  /**
   * 内容驱动的语音演绎指令 + 情感 + 强度：LLM 根据口播文稿输出三行
   * （指令 / 情感标签 / 情绪强度 1~5），Host 把三者织成一条自然语言语音指令走
   * context_texts（官方情感通道，所有 2.0 音色生效；1.0 的 emotion/emotion_scale
   * 数值参数已删除）。短输出、低温度、短超时（15s）；
   * 任何失败返回 null（调用方回退预设）。
   */
  async function generateVoiceInstruction(route, cfg, transcriptText) {
    const ac = new AbortController()
    currentAbort = ac // 纳入 voice.stop 的统一中止
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, 15000)
    try {
      const config = { provider: route.provider, model: route.model, temperature: 0.3, maxTokens: 256 }
      const prepared = await llm.prepareCall(config, ac.signal)
      let out = ''
      const stream = prepared.stream(Object.assign({}, prepared.config, {
        system: INSTRUCTION_EMOTION_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: '以下是要播报的口播文稿：\n' + transcriptText }] }],
        signal: ac.signal,
      }))
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text
      }
      if (timedOut) return null
      const parsed = parseInstructionOutput(out)
      return parsed.instruction ? parsed : null
    } catch (error) {
      console.warn('[voice] instruction generation failed, fallback to preset instruct:', error && error.message)
      return null
    } finally {
      clearTimeout(timer)
      if (currentAbort === ac) currentAbort = null
    }
  }

  /**
   * 组装发给豆包的 context_texts 语音指令（一条字符串；官方仅第一个值有效）。
   * 优先级：用户自定义 prompt 里显式写的 [#指令]（extractedCmd，明确意图）
   *   > 内容驱动生成指令（generated.instruction，主通道）
   *   > 预设机械指令（preset.instruct，最后兜底）。
   * 注意：方言不再拼进 context_texts（探针实测无效），改走
   * additions.explicit_dialect（8 种方言统一 vv 音色，双向流+HTTP 实测全部生效）。
   */
  function buildVoiceInstruction(cfg, extractedCmd, generated) {
    const parts = []
    let cmd = extractedCmd || (generated && generated.instruction) || ''
    if (!cmd) {
      const preset = STYLE_PRESETS.find((p) => p.id === cfg.transcribe.stylePreset)
      if (preset && preset.instruct) cmd = preset.instruct
    }
    if (cmd) parts.push(cmd)
    return parts.join('，')
  }

  /**
   * 火山豆包单向 TTS。text 必须已剥离 [#...] 指令标签（该接口不解析会照读）；
   * 语速/音调经数值参数（speech_rate 实测生效；pitch 经 additions.post_process.pitch）；
   * 语气/方言指令经 additions.context_texts（不计费，效果依赖音色/措辞，见 tmp/probe-* 试听）。
   * cmd = 调用方已组装好的完整指令；opts.emotionZh/opts.intensity = 内容驱动生成的情感与强度。
   */
  async function synthesizeVolcengine(text, cfg, cmd, opts = {}) {
    const v = cfg.tts.volcengine
    if (!v.apiKey) throw new Error('volcengine apiKey 未配置（voice.tts.volcengine.apiKey）')
    // 预览等场景没有生成指令时走预设回退
    const instruction = cmd || buildVoiceInstruction(cfg, '', '')
    const reqParams = buildVolcReqParams(cfg, v, {
      instruction, emotionZh: opts.emotionZh || '', intensity: opts.intensity, dialect: dialectFor(cfg), sectionId: opts.sectionId || '',
    })
    reqParams.text = text
    const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': v.apiKey,
        'X-Api-Resource-Id': v.resourceId || 'seed-tts-2.0',
        'X-Api-Request-Id': randomUUID(),
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      body: JSON.stringify({ user: { uid: 'dsh-plugin-voice' }, req_params: reqParams }),
    })
    if (!res.ok || !res.body) throw new Error('volcengine http ' + res.status + ' ' + (await res.text().catch(() => '')))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const parts = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        const code = typeof frame.code === 'number' ? frame.code : 0
        if (code === 0) { if (frame.data) parts.push(frame.data) } // 无 data 的 code:0 帧（元信息/usage）跳过
        else if (code === 20000000) break // 结束帧
        else throw new Error('volcengine frame code ' + code + (frame.message ? ': ' + frame.message : ''))
      }
    }
    if (!parts.length) throw new Error('volcengine returned no audio')
    return Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64')))
  }

  /** 合成并挂一次性音频路由；返回 '/voice/audio/<id>'。cmd = 已组装的完整语音指令（仅豆包用）。 */
  async function synthToRoute(text, cfg, cmd, opts = {}) {
    const buf = await synthesizeVolcengine(text, cfg, cmd, opts)
    const id = randomUUID()
    audioStore.set(id, { buf, mime: 'audio/mpeg' })
    return '/voice/audio/' + id
  }

  // ---- 双向流（WebSocket Bidirection）：参数组装 / 段落切分 / 流式管线 -----------
  /** 稳定派生 section_id（按会话，供 TTS 跨次合成语气连续）。 */
  function stableHashId(str) {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    let h2 = h ^ 0x9e3779b9
    for (let i = 0; i < str.length; i++) { h2 ^= str.charCodeAt(i); h2 = Math.imul(h2, 0x85ebca6b) >>> 0 }
    const a = h.toString(16).padStart(8, '0')
    const b = h2.toString(16).padStart(8, '0')
    return a.slice(0, 8) + '-' + a.slice(4, 8) + '-4' + a.slice(1, 4) + '-' + b.slice(0, 4) + '-' + b.slice(0, 12)
  }
  /** 方言 explicit_dialect（8 种方言统一走 vv 音色；实测全部生效）。 */
  function dialectFor(cfg) {
    return dialectIdOf(cfg.language)
  }
  /** 把 LLM 的语音指令 + 情感标签 + 强度织成一条自然语言情感指令（context_texts 通道。
   * 官方 docs/6561/1329505：所有豆包语音合成模型 2.0 音色生效、不计费、仅第一个值有效；
   * 中性/空情感不追加，保持指令原样）。 */
  function composeContextText(instruction, emotionZh, intensity) {
    const parts = []
    if (instruction) parts.push(instruction)
    if (emotionZh && emotionZh !== '中性') {
      let s = '语气' + emotionZh + '一点'
      if (intensity >= 4) s += '，情绪明显一些'
      else if (intensity === 3) s += '，情绪适中'
      else if (intensity <= 2) s += '，情绪收敛一些'
      parts.push(s)
    }
    return parts.join('，')
  }
  /** 组装 StartSession/TaskRequest 的 req_params（不含 text）。
   * 双向流（isStream）用 pcm（官方推荐：裸采样无帧/延迟，切段无缝）；HTTP 单向仍 mp3。 */
  function buildVolcReqParams(cfg, v, opts = {}) {
    const speaker = correctSpeakerForLanguage(cfg, v.speaker) // 方言→vv / English→英文音色（voice-compat）
    const isStream = !!opts.isStream
    const format = isStream ? 'pcm' : 'mp3'
    const reqParams = { speaker, audio_params: { format, sample_rate: v.sampleRate } }
    if (v.bitRate && !isStream) reqParams.audio_params.bit_rate = v.bitRate // bit_rate 仅 mp3 生效
    const rate = Number.isInteger(v.rateLevel) ? RATE_VALUES[v.rateLevel] : undefined
    if (rate) reqParams.audio_params.speech_rate = rate
    if (v.loudness) reqParams.audio_params.loudness_rate = v.loudness
    // 情感控制：只用 context_texts 自然语言指令（2.0 唯一情感通道，所有 2.0 音色生效）。
    // LLM 动态情感标签 + 强度织进指令（opts.emotionZh/intensity）。1.0 的
    // emotion/emotion_scale 数值参数已淘汰，不发送。
    const emotionZh = opts.emotionZh || ''
    if (v.expressive) reqParams.model = 'seed-tts-2.0-expressive'
    const additions = {}
    const ctxText = composeContextText(opts.instruction, emotionZh, opts.intensity)
    if (ctxText) additions.context_texts = [ctxText]
    const dialect = opts.dialect || ''
    if (dialect) additions.explicit_dialect = dialect
    // explicit_language：仅固定英文下发（中文/方言不下发，避免与 explicit_dialect 冲突）
    const lang = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
    if (lang && !lang.dialect && lang.id === 'en') additions.explicit_language = 'en'
    // 注意：不再下发 cache_config——服务端缓存只按文本、不认方言/音色/情感参数，
    // 试听文本固定会命中缓存返回旧音频（实测：同文本 + 三方言 → 音频完全一致）。
    // 本地转写缓存（按 messageId）已足够，服务端缓存对本插件有害，移除。
    if (v.useSectionId && opts.sectionId) additions.section_id = opts.sectionId
    const pitch = Number.isInteger(v.pitchLevel) ? PITCH_VALUES[v.pitchLevel] : undefined
    if (pitch) additions.post_process = { pitch }
    if (Object.keys(additions).length) reqParams.additions = JSON.stringify(additions)
    return reqParams
  }
  /** 预设机械指令。 */
  function presetInstruction(cfg) {
    const preset = STYLE_PRESETS.find((p) => p.id === cfg.transcribe.stylePreset)
    return (preset && preset.instruct) || ''
  }
  /** 找文本中第一个"完整句"的结束位置（句末字符；小数点不误切）。无则 -1。 */
  function findSentenceEnd(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if ('。！？!?；;\n'.indexOf(c) >= 0) return i
      if (c === '.' && !(i > 0 && /\d/.test(text[i - 1]) && i + 1 < text.length && /\d/.test(text[i + 1]))) return i
    }
    return -1
  }
  /** 统计一段文本里的句末/换行个数（用于段 0 增量直喂时的切段判定）。 */
  function countEnders(text) {
    let n = 0
    for (const c of text) if ('。！？!?；;\n'.indexOf(c) >= 0) n++
    return n
  }
  /** 一段音频帧收进 run 播放队列（按大小分段，第一段更小尽早出声）。
   * pcm 为裸采样，任意字节位切断都无缝 → 直接按阈值切（无需 MP3 帧对齐）。 */
  function pushAudioFrame(run, frame) {
    if (run.stopped) return
    run.segBuf.push(frame)
    run.segLen += frame.length
    const threshold = run.segments === 0 ? STREAM.firstSegmentBytes : STREAM.segmentBytes
    if (run.segLen < threshold) return
    flushSegment(run, Buffer.concat(run.segBuf))
  }
  /** 把一段完整音频入播放队列（format 标记解码方式：pcm 裸采样 | mp3 兜底段）；explicit 省略时清空当前 segBuf。 */
  function flushSegment(run, explicit, format = 'pcm') {
    const buf = explicit !== undefined ? explicit : (run.segBuf.length ? Buffer.concat(run.segBuf) : null)
    if (!buf || !buf.length) return
    run.segBuf = []
    run.segLen = 0
    const id = randomUUID()
    audioStore.set(id, { buf, mime: format === 'mp3' ? 'audio/mpeg' : 'application/octet-stream' })
    run.queue.push({ id, format })
    run.segments++
  }
  /** 段落粒度的「指令 + 情感 + 强度」生成（短超时 8s，失败返回 null）。 */
  async function generateParagraphInstruction(route, cfg, text) {
    const ac = new AbortController()
    currentAbort = ac
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      const config = { provider: route.provider, model: route.model, temperature: 0.3, maxTokens: 256 }
      const prepared = await llm.prepareCall(config, ac.signal)
      let out = ''
      const stream = prepared.stream(Object.assign({}, prepared.config, {
        system: INSTRUCTION_EMOTION_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: '以下是本段口播文稿：\n' + text }] }],
        signal: ac.signal,
      }))
      for await (const chunk of stream) { if (chunk.type === 'text-delta') out += chunk.text }
      const parsed = parseInstructionOutput(out)
      return parsed.instruction ? parsed : null
    } catch (error) {
      console.warn('[voice] paragraph instruction failed:', error && error.message)
      return null
    } finally {
      clearTimeout(timer)
      if (currentAbort === ac) currentAbort = null
    }
  }
  /** 转写流：yield 文本增量；撞顶空稿 4 倍重试 / effort 降级链。失败抛错由调用方降级。 */
  async function* streamTranscription(route, cfg, found, promptUsed, ctxRef, run) {
    const maxTokens = cfg.transcribe.maxTokens
    const timeoutMs = cfg.transcribe.timeoutMs || 60000
    const effortUsed = cfg.transcribe.reasoningEffort || ''
    const initialEffort = run.effortPlan ? run.effortPlan.effort : undefined
    async function* attempt(rt, tokens, effort) {
      const a2 = new AbortController()
      const link = () => a2.abort()
      run.abort.signal.addEventListener('abort', link, { once: true })
      let finishKind = 'stop'
      const timer = setTimeout(() => a2.abort(), timeoutMs)
      currentAbort = a2
      try {
        const config = { provider: rt.provider, model: rt.model, temperature: cfg.transcribe.temperature, maxTokens: tokens }
        if (effort) config.reasoningEffort = effort
        const prepared = await llm.prepareCall(config, a2.signal)
        const userPayload = ctxRef.block
          ? '（以下上下文仅供参考，用于把握语境与情绪，不要转写这部分）\n' + ctxRef.block + '\n\n请转写以下内容：\n' + found.text
          : found.text
        const stream = prepared.stream(Object.assign({}, prepared.config, {
          system: promptUsed,
          messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
          signal: a2.signal,
        }))
        let out = ''
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') { out += chunk.text; yield chunk.text }
          else if (chunk.type === 'finish' && chunk.reason) finishKind = chunk.reason.kind
        }
        if (!out && finishKind === 'max-tokens') throw { retry4x: true }
        if (!out && a2.signal.aborted) throw new Error('transcribe aborted/timeout')
      } finally {
        clearTimeout(timer)
        run.abort.signal.removeEventListener('abort', link)
        if (currentAbort === a2) currentAbort = null
      }
    }
    try {
      for await (const d of attempt(route, maxTokens, initialEffort)) yield d
    } catch (e1) {
      if (e1 && e1.retry4x) {
        for await (const d of attempt(route, maxTokens * 4, initialEffort)) yield d
        return
      }
      const msg = String(e1 && e1.message || e1)
      if (effortUsed && /effort|reasoning/i.test(msg)) {
        const candidates = (EFFORT_FALLBACK[effortUsed] || []).concat([undefined])
        let lastErr = e1
        let done = false
        for (const cand of candidates) {
          if (cand === initialEffort) continue
          try { for await (const d of attempt(route, maxTokens, cand)) yield d; done = true; break }
          catch (e2) { lastErr = e2; if (!/effort|reasoning/i.test(String(e2 && e2.message || e2))) break }
        }
        if (!done) throw lastErr
      } else {
        throw e1
      }
    }
  }
  /** 双向流主流程：转写流 → 段落 session（指令链动态情感）→ 音频分段入队。 */
  async function streamSpeak(run, found, cfg, route) {
    const v = cfg.tts.volcengine
    const promptUsed = resolvePrompt(cfg)
    const ctxRef = buildContext(run.sessionId, found.turn || 0, cfg.transcribe.contextTurns)
    const effortUsed = cfg.transcribe.reasoningEffort || ''
    const effortPlan = await effortFor(route, effortUsed)
    run.effortPlan = effortPlan
    run.effortMapped = effortPlan.mapped
    run.effortNote = effortPlan.note
    const ac = new AbortController()
    run.abort = ac

    const conn = createBidirectionClient({
      apiKey: v.apiKey,
      resourceId: v.resourceId || 'seed-tts-2.0',
      url: v.wsUrl || WS_DEFAULTS.url,
      onAudio: (frame) => pushAudioFrame(run, frame),
      onFatal: (err) => { run.error = String(err && err.message || err); try { ac.abort() } catch {} },
      signal: ac.signal,
      timeoutMs: STREAM.maxSessionTimeout,
    })
    run.conn = conn // 供 stopRun 直接关连接（新播报/停止时立即释放 WS）
    try { await conn.start() }
    catch (err) { throw new Error('bidirection 连接失败: ' + String(err && err.message || err)) }

    const sectionId = v.useSectionId ? stableHashId(run.sessionId) : ''
    const dialect = dialectFor(cfg)
    const dynamic = v.emotionGranularity === 'paragraph'
    const genInstr = cfg.transcribe.enabled !== false // 关转写=不调任何 LLM（含指令），仅预设
    // 指令链：段 0 用预设；段 N 用段 N-1 的文本生成（重叠，零延迟）。
    // 段 0 增量直喂（低延迟出声）；段 N 按"完整句"缓冲、成句即发；每 2 句切一段。
    let currentInstruction = presetInstruction(cfg)
    let currentEmotion = ''
    let currentIntensity = 4
    let lastParagraphText = '' // 最近一段完整文本（生成下一段指令用）
    let pending = ''           // 未成句的文本（段 N 起用）
    let session = null
    let sessionReqParams = null
    const transcriptParts = []
    let paragraphs = 0
    let paraSentences = 0
    let firstPara = true
    let inCodeFence = false // 跨句跟踪代码块开关（``` 可能横跨多个 delta）
    /** 发送前净化：先按代码块开关剥离围栏内容，再剥 Markdown/装饰符号。 */
    function cleanForTts(text) {
      let out = ''
      let rest = String(text || '')
      while (rest.length) {
        const idx = rest.indexOf('```')
        if (idx < 0) { out += (inCodeFence ? '' : rest); break }
        out += (inCodeFence ? '' : rest.slice(0, idx))
        inCodeFence = !inCodeFence
        rest = rest.slice(idx + 3)
      }
      return sanitizeForSpeech(out)
    }

    async function startParaSession() {
      sessionReqParams = buildVolcReqParams(cfg, v, { instruction: currentInstruction, emotionZh: currentEmotion, intensity: currentIntensity, dialect, sectionId, isStream: true })
      session = await conn.startSession(sessionReqParams)
      paragraphs++
    }
    async function cutParagraph() {
      await conn.finishSession(session)
      const giP = genInstr ? generateParagraphInstruction(route, cfg, lastParagraphText) : Promise.resolve(null)
      await conn.waitSessionFinished(session, STREAM.maxSessionTimeout)
      flushSegment(run)
      const gi = await giP
      if (gi) { currentInstruction = gi.instruction; currentEmotion = gi.emotion; currentIntensity = gi.intensity || 4 }
      lastParagraphText = ''
      session = null
      sessionReqParams = null
      paraSentences = 0
    }

    try {
      let tstream
      const cachedHit = !run.force && cfg.transcribe.enabled !== false
        ? cachedTranscriptFor(run.messageId, route, promptUsed, effortUsed)
        : null
      if (cachedHit && cachedHit.transcript) {
        // 缓存命中（与 HTTP 一致，regen 除外）：整段喂缓存稿，段落切分/动态情感照常走，不白烧转写 token
        const cachedText = cachedHit.transcript
        tstream = (async function* () { yield cachedText })()
      } else if (cfg.transcribe.enabled === false) {
        // 关转写：不调模型，直接流式合成原文（去 Markdown）
        const plain = toPlainSpoken(found.text)
        tstream = (async function* () { if (plain) yield plain })()
      } else {
        tstream = streamTranscription(route, cfg, found, promptUsed, ctxRef, run)
      }
      for await (const delta of tstream) {
        if (run.stopped) break
        if (!delta) continue
        transcriptParts.push(delta)
        if (dynamic && !firstPara) {
          // 段 N（N≥1）：成句缓冲 + 精确切段
          pending += delta
          let cut
          while (!run.stopped && (cut = findSentenceEnd(pending)) >= 0) {
            const sentence = pending.slice(0, cut + 1)
            pending = pending.slice(cut + 1)
            const clean = cleanForTts(sentence)
            if (clean) {
              if (!session) await startParaSession()
              await conn.sendText(session, sessionReqParams, clean)
              lastParagraphText += clean
              paraSentences++
              if (paraSentences >= 2) await cutParagraph()
            }
          }
        } else {
          // 段 0 / 非动态整条：增量直喂，尽早出声
          const clean = cleanForTts(delta)
          if (clean) {
            if (!session) await startParaSession()
            await conn.sendText(session, sessionReqParams, clean)
            lastParagraphText += clean
            paraSentences += countEnders(delta)
            if (dynamic && paraSentences >= 2) { await cutParagraph(); firstPara = false }
          }
        }
      }
      // 结尾残留（不完整句，仅段 N 缓冲路径会有）
      if (pending && !run.stopped) {
        const clean = cleanForTts(pending)
        if (clean) {
          if (!session) await startParaSession()
          await conn.sendText(session, sessionReqParams, clean)
          lastParagraphText += clean
          paraSentences++
        }
        pending = ''
      }
      if (session) {
        await conn.finishSession(session)
        await conn.waitSessionFinished(session, STREAM.maxSessionTimeout)
        flushSegment(run)
      }
    } catch (err) {
      run.error = String(err && err.message || err)
      try { if (session) await conn.cancelSession(session) } catch {}
    } finally {
      try { await conn.finishConnection() } catch {}
      try { await conn.close() } catch {}
    }

    const rawTranscript = transcriptParts.join('')
    const { clean: cleanTranscript } = extractVoiceTags(rawTranscript)
    const spokenTranscript = sanitizeForSpeech(cleanTranscript)
    if (!run.stopped && spokenTranscript) {
      // 与 HTTP 路径同形状（净化稿 + 指令/情感/强度），保证流式/HTTP 可互读
      transcriptCache.set(String(run.messageId), {
        transcript: spokenTranscript,
        provider: route.provider, model: route.model,
        prompt: promptUsed, effort: effortUsed,
        sourceChars: found.text.length, at: Date.now(),
        instruction: currentInstruction || undefined,
        emotion: currentEmotion || undefined,
        intensity: currentIntensity || 4,
      })
      saveTranscriptCache(transcriptCache)
      const hist = transcriptsBySession.get(run.sessionId) || []
      const thisTurn = found.turn || 0
      if (!hist.length || hist[hist.length - 1].turn !== thisTurn) {
        hist.push({ turn: thisTurn, text: spokenTranscript.slice(0, 600) })
        transcriptsBySession.set(run.sessionId, hist.slice(-4))
      }
    }
    run.transcript = spokenTranscript || rawTranscript
    run.paragraphs = paragraphs
    flushSegment(run)
    if (!run.segments && !run.error) run.error = '未收到音频（bidirection）'
    run.streamingDone = true
    run.doneAt = Date.now()
    if (currentStreamRun === run) currentStreamRun = null
  }
  /** 创建流式 run 并登记（含方言/情感提示）。 */
  function createStreamRun(sessionId, messageId, cfg) {
    const v = cfg.tts.volcengine
    const run = {
      id: randomUUID(), sessionId, messageId,
      queue: [], segBuf: [], segLen: 0, segments: 0, served: 0,
      finished: false, stopped: false, error: '', warn: '', transcript: '',
      abort: null, effortPlan: null, effortMapped: false, effortNote: '', paragraphs: 0, at: Date.now(),
      force: false, // true = 重新生成（跳过转写缓存，重新转写+合成，覆盖旧缓存条目）
    }
    const lang = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
    if (lang && lang.dialect && lang.dialectId && v.speaker !== VV_SPEAKER) {
      run.warn = '方言「' + lang.label + '」已自动使用 vv 音色（explicit_dialect）'
    }
    return run
  }
  /** 立即中止一个流式 run：置 stopped、中止 LLM、直接关 WS（残留交给 streamSpeak 清理）。 */
  function stopRun(run) {
    if (!run) return
    run.stopped = true
    try { if (run.abort) run.abort.abort() } catch {}
    try { if (run.conn) run.conn.close() } catch {}
  }
  /** 清理 run：释放未消费的音频段（audioStore 一次性路由）+ 摘除注册，防止段滞留膨胀。 */
  function disposeRun(run) {
    if (!run) return
    for (const q of run.queue) audioStore.delete(q.id)
    if (streamRuns.get(run.id) === run) streamRuns.delete(run.id)
    if (currentStreamRun === run) currentStreamRun = null
  }
  /** 后台启动流式管线（不 await）；流式失败且零音频时自动降级 HTTP 单向。 */
  function runPipeline(run, found, cfg) {
    // 新播报强制中止上一个流式 run（防并发 WS / 混音 / 白烧钱）
    if (currentStreamRun && currentStreamRun !== run && !currentStreamRun.finished) stopRun(currentStreamRun)
    streamRuns.set(run.id, run)
    currentStreamRun = run
    ;(async () => {
      try {
        let route = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null
        if (!route) route = await discoverRoute()
        await streamSpeak(run, found, cfg, route)
      } catch (err) {
        run.error = String(err && err.message || err)
        run.streamingDone = true
        console.error('[voice] stream speak failed:', run.error)
      }
      // 双向流失败/零音频 → 降级走非流式 HTTP 单向（完整音频作为单个 mp3 段入队）
      if (run.streamingDone && !run.segments && !run.stopped) {
        const res = await transcribe(run.sessionId, run.messageId, { force: run.force }).catch((e) => ({ ok: false, error: String(e && e.message || e) }))
        if (res && res.ok && res.audioUrl) {
          run.queue.push({ id: res.audioUrl.replace('/voice/audio/', ''), format: 'mp3' })
          run.error = ''
          run.warn = (run.warn ? run.warn + '；' : '') + '双向流不可用，已回退为整段合成'
        } else {
          run.error = (res && res.error) || run.error || 'speak failed'
        }
      }
      run.finished = true
      if (currentStreamRun === run) currentStreamRun = null
      // 兜底清理：结束后 8s 无论客户端是否取完，都清掉未消费段与注册（防 pcm 大段滞留膨胀）
      setTimeout(() => disposeRun(run), 8000)
    })()
  }
  /** 是否走双向流流式播报。 */
  function isStreamingVolc(cfg) {
    return ttsProviderOf(cfg) === 'volcengine' && cfg.tts.volcengine.interface === 'bidirection' && cfg.tts.volcengine.streaming !== false
  }

  async function transcribe(sessionId, messageId, opts = {}) {
    const found = extractText(sessionId, messageId)
    if (found.error) return { ok: false, error: found.error }
    const cfg = normalizeVoiceConfig(scope.get()) // 归一化视图（UI 与实际发声一致）
    const configured = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null
    const promptUsed = resolvePrompt(cfg)
    const effortUsed = cfg.transcribe.reasoningEffort || ''
    const ctxRef = buildContext(sessionId, found.turn || 0, cfg.transcribe.contextTurns)

    // 关转写（transcribe.enabled=false）：不调任何模型，直接读原文（去 Markdown），跳过缓存/指令
    if (cfg.transcribe.enabled === false) {
      const plain = toPlainSpoken(found.text)
      if (!plain) return { ok: false, error: 'message text empty' }
      const v = cfg.tts.volcengine
      let audioUrl, ttsError
      if (ttsProviderOf(cfg) !== 'browser') {
        try {
          audioUrl = await synthToRoute(plain, cfg, buildVoiceInstruction(cfg, '', ''), { sectionId: v && v.useSectionId ? stableHashId(sessionId) : '' })
        } catch (error) { ttsError = String(error && error.message || error) }
      }
      return { ok: true, transcript: plain, degraded: false, audioUrl, ttsError, speech: { rate: cfg.tts.browser.rate, pitch: cfg.tts.browser.pitch, voice: cfg.tts.browser.voice } }
    }

    // 缓存命中：同一条消息 + 同一路由 + 同一 prompt/effort → 直接复用转写稿（regen/force 跳过，重新生成）
    let route = configured
    let cached = null
    let transcript = null
    let fromCache = false
    if (!opts.force) {
      cached = cachedTranscriptFor(messageId, route, promptUsed, effortUsed)
      if (cached) { transcript = cached.transcript; fromCache = true }
    }

    let degraded = false
    // 路由 + 思考档位计划：缓存命中与否都要解析（档位降级需对用户可见）
    if (!route) route = await discoverRoute()
    if (configured && route && (route.provider !== configured.provider || route.model !== configured.model)) {
      // 自愈：配置路由不可用（如幽灵 provider）→ 把可用路由写回 settings，
      // 避免每次播报都先打一次失败调用再回退、且转写缓存永久 miss
      ctx.settings.update('voice', { provider: route.provider, model: route.model }).catch(() => {})
    }
    let effortPlan = await effortFor(route, effortUsed)

    if (!transcript) {
      const maxTokens = cfg.transcribe.maxTokens
      const timeoutMs = cfg.transcribe.timeoutMs || 60000
      // 每次尝试独立的 AbortController + 超时；voice.stop 经 currentAbort 中止进行中的那次
      async function attempt(rt, tokens, effort) {
        const ac = new AbortController()
        currentAbort = ac
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
        try {
          const config = { provider: rt.provider, model: rt.model, temperature: cfg.transcribe.temperature, maxTokens: tokens }
          if (effort) config.reasoningEffort = effort
          const prepared = await llm.prepareCall(config, ac.signal)
          let out = ''
          let finishKind = 'stop'
          const userPayload = ctxRef.block
            ? '（以下上下文仅供参考，用于把握语境与情绪，不要转写这部分）\n' + ctxRef.block + '\n\n请转写以下内容：\n' + found.text
            : found.text
          const stream = prepared.stream(Object.assign({}, prepared.config, {
            system: promptUsed,
            messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
            signal: ac.signal,
          }))
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') out += chunk.text
            else if (chunk.type === 'finish' && chunk.reason) finishKind = chunk.reason.kind
          }
          if (timedOut) throw new Error('transcribe timeout after ' + timeoutMs + 'ms')
          return { transcript: out.trim(), finishKind }
        } finally {
          clearTimeout(timer)
          if (currentAbort === ac) currentAbort = null
        }
      }
      try {
        let result
        try {
          result = await attempt(route, maxTokens, effortPlan.effort)
        } catch (e1) {
          const msg = String(e1 && e1.message || e1)
          if (effortUsed && /effort|reasoning/i.test(msg)) {
            // 档位被模型拒绝（能力信息缺失/过期）：按降级链逐个重试（跳过已失败的档位），
            // 最后兜底是不发档位字段（跟随适配器默认）
            const candidates = (EFFORT_FALLBACK[effortUsed] || []).concat([undefined])
            let lastErr = e1
            let done = false
            for (const cand of candidates) {
              if (cand === effortPlan.effort) continue
              try {
                result = await attempt(route, maxTokens, cand)
                effortPlan = { effort: cand, mapped: true, note: cand === undefined
                  ? '模型不支持思考档位 "' + effortUsed + '"，已忽略该设置'
                  : '模型不支持思考档位 "' + effortUsed + '"，已降级为 "' + cand + '"' }
                console.warn('[voice] reasoningEffort unsupported, retrying:', effortPlan.note, msg)
                done = true
                break
              } catch (e2) {
                lastErr = e2
                if (!/effort|reasoning/i.test(String(e2 && e2.message || e2))) break // 非档位错误：不再换档重试
              }
            }
            if (!done) throw lastErr
          } else if (configured) {
            console.warn('[voice] configured route failed, falling back to discovery:', msg)
            route = await discoverRoute()
            effortPlan = await effortFor(route, effortUsed)
            result = await attempt(route, maxTokens, effortPlan.effort)
          } else {
            throw e1
          }
        }
        // 推理模型思考烧光额度 → 4 倍重试（沿用解析后的档位，避免退回适配器默认的更高思考档）
        if (!result.transcript && result.finishKind === 'max-tokens') {
          console.warn('[voice] transcript empty at max-tokens, retrying with 4x budget')
          result = await attempt(route, maxTokens * 4, effortPlan.effort)
        }
        transcript = result.transcript
        if (transcript) {
          transcriptCache.set(String(messageId), {
            transcript,
            provider: route.provider,
            model: route.model,
            prompt: promptUsed,
            effort: effortUsed,
            sourceChars: found.text.length,
            at: Date.now(),
          })
          saveTranscriptCache(transcriptCache)
          // 引用上文：记录本轮播报文稿（供后续轮次的转写语境）
          const hist = transcriptsBySession.get(sessionId) || []
          const thisTurn = found.turn || 0
          if (!hist.length || hist[hist.length - 1].turn !== thisTurn) {
            hist.push({ turn: thisTurn, text: transcript.slice(0, 600) })
            transcriptsBySession.set(sessionId, hist.slice(-4))
          }
        }
      } catch (error) {
        console.error('[voice] transcribe failed, degrading to plain read:', error)
        transcript = null
      }
      // 降级直读：失败/超时/撞顶空稿 → 剥离 Markdown 直读原文（不写缓存，下次仍可重试转写）
      if (!transcript) {
        transcript = toPlainSpoken(found.text)
        degraded = true
        if (!transcript) return { ok: false, error: 'message text empty after plain fallback' }
      }
    }

    // 提取并剥离 [#...] 指令标签（旧缓存/自定义 prompt 可能残留；内嵌会被 TTS 照读）。
    // 提取出的指令内容交给豆包的 context_texts 通道（见 buildVoiceInstruction）。
    // 注意顺序：先提取 [#...] 再净化，否则方括号/井号会被净化规则剥掉。
    const { clean: cleanTranscript, cmds } = extractVoiceTags(transcript)
    transcript = sanitizeForSpeech(cleanTranscript)
    const extractedCmd = cmds.length ? cmds[0] : '' // 官方仅第一个值有效

    // 内容驱动的语音演绎指令 + 情感 + 强度（LLM 三行输出）：仅云 TTS + 转写开启 + 非降级。
    // 结果随转写稿一起缓存：同一消息第二次播报零额外 LLM 调用。
    let generated = null // { instruction, emotion, intensity } | null
    if (route && ttsProviderOf(cfg) !== 'browser' && cfg.transcribe.enabled !== false && !degraded) {
      if (fromCache && cached && typeof cached.instruction === 'string' && cached.instruction) {
        generated = { instruction: cached.instruction, emotion: cached.emotion || '', intensity: cached.intensity || 4 } // 缓存命中：转写稿与指令都复用
      } else {
        generated = await generateVoiceInstruction(route, cfg, transcript)
        if (generated) {
          const entry = transcriptCache.get(String(messageId))
          if (entry) { entry.instruction = generated.instruction; entry.emotion = generated.emotion || ''; entry.intensity = generated.intensity || 4; saveTranscriptCache(transcriptCache) }
          else {
            transcriptCache.set(String(messageId), {
              transcript, provider: route.provider, model: route.model,
              prompt: promptUsed, effort: effortUsed,
              sourceChars: found.text.length, at: Date.now(),
              instruction: generated.instruction, emotion: generated.emotion || '', intensity: generated.intensity || 4,
            })
            saveTranscriptCache(transcriptCache)
          }
        }
      }
    }
    const voiceInstruction = buildVoiceInstruction(cfg, extractedCmd, generated)

    // TTS：browser 透传 Client speechSynthesis；云 provider 在 Host 合成后挂一次性音频路由
    let audioUrl
    let ttsError
    if (ttsProviderOf(cfg) !== 'browser') {
      try {
        audioUrl = await synthToRoute(transcript, cfg, voiceInstruction, {
          sectionId: cfg.tts.volcengine && cfg.tts.volcengine.useSectionId ? stableHashId(sessionId) : '',
          emotionZh: generated ? generated.emotion : '',
          intensity: generated ? generated.intensity : undefined,
        })
      } catch (error) {
        console.error('[voice] cloud tts failed:', error)
        ttsError = String(error && error.message || error) // Client 端降级 speechSynthesis
      }
    }

    return {
      ok: true,
      transcript,
      provider: route ? route.provider : (configured ? configured.provider : ''),
      model: route ? route.model : (configured ? configured.model : ''),
      sourceChars: fromCache && cached ? cached.sourceChars : found.text.length,
      sessionId,
      messageId,
      cached: fromCache,
      degraded,
      effortMapped: effortPlan.mapped,  // 配置的思考档位未按原值应用（已降级/忽略）
      effortNote: effortPlan.note,      // 给用户看的中文说明
      audioUrl,
      ttsError,
      speech: { rate: cfg.tts.browser.rate, pitch: cfg.tts.browser.pitch, voice: cfg.tts.browser.voice },
    }
  }

  // ---- /voice/api/* JSON RPC -------------------------------------------------
  const methods = {
    ping: async () => ({ ok: true, now: new Date().toISOString() }),
    meta: async () => ({
      ok: true,
      voices: VOLC_VOICES,
      languages: LANGUAGE_OPTIONS.map((l) => ({ id: l.id, label: l.label, dialect: !!l.dialect, dialectId: l.dialectId || '' })),
      stylePresets: STYLE_PRESETS.map((p) => ({ id: p.id, name: p.name, prompt: p.prompt })),
      rateStops: RATE_STOPS,
      pitchStops: PITCH_STOPS,
    }),
    getState: async () => {
      const cfg = scope.get()
      return { ok: true, autoSpeak: cfg.autoSpeak, pending: !!pendingSpeak, tts: cfg.tts }
    },
    getConfig: async () => ({ ok: true, config: normalizeVoiceConfig(scope.get()) }),
    setConfig: async (args) => {
      const patch = args && args.patch
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'missing patch' }
      await ctx.settings.update('voice', patch)
      // 音色↔语种归一（normalizeVoiceConfig：方言→vv / English→英文音色 / 英文音色→English），
      // 让保存后的配置自洽、UI 显示与发声一致；单次读取避免竞态
      const cur = scope.get()
      const norm = normalizeVoiceConfig(cur)
      const curSpeaker = cur.tts && cur.tts.volcengine && cur.tts.volcengine.speaker
      const normSpeaker = norm.tts && norm.tts.volcengine && norm.tts.volcengine.speaker
      if (norm.language !== cur.language || (normSpeaker && normSpeaker !== curSpeaker)) {
        const write = { language: norm.language }
        if (normSpeaker) write.tts = { volcengine: { speaker: normSpeaker } }
        await ctx.settings.update('voice', write)
      }
      return { ok: true, config: normalizeVoiceConfig(scope.get()) }
    },
    routeInfo: async (args) => {
      const a = args || {}
      // providers/models 带 name（LlmProviderInfo/LlmModelInfo 均有），供设置页下拉显示
      const providers = llm.listProviders().map((p) => ({ id: String(p.id), name: String(p.name || p.id) }))
      const provider = a.provider || (providers[0] && providers[0].id) || ''
      let models = []
      try { models = (await llm.listModels(provider)).map((m) => ({ id: String(m.id), name: String(m.name || m.id) })) } catch { /* 忽略，留空 */ }
      const model = a.model || (models[0] && models[0].id) || ''
      let efforts = []
      let defaultEffort = ''
      if (provider && model) {
        try {
          const info = await llm.resolveModelInfo(provider, model)
          if (info && info.reasoning && info.reasoning.efforts) {
            efforts = info.reasoning.efforts.map((e) => ({ id: String(e.id), name: String(e.name) }))
            if (info.reasoning.defaultEffort) defaultEffort = String(info.reasoning.defaultEffort)
          }
        } catch { /* 非推理模型或路由未就绪 */ }
      }
      return { ok: true, providers, provider, models, model, efforts, defaultEffort }
    },
    setAuto: async (args) => {
      await ctx.settings.update('voice', { autoSpeak: !!(args && args.enabled) })
      if (pendingSpeak && !(args && args.enabled)) pendingSpeak = null
      return { ok: true, autoSpeak: scope.get().autoSpeak }
    },
    pollSpeak: async () => {
      const p = pendingSpeak
      pendingSpeak = null
      let stopOnNewTurn = true
      try { stopOnNewTurn = scope.get().stopOnNewTurn !== false } catch { /* 按默认 true */ }
      return { ok: true, pending: p, gen: turnGeneration, stopOnNewTurn }
    },
    preview: async () => {
      const cfg = normalizeVoiceConfig(scope.get()) // 归一化视图（试听与实际发声一致）
      if (ttsProviderOf(cfg) === 'browser') {
        return { ok: true, mode: 'browser', text: PREVIEW_SAMPLE, speech: { rate: cfg.tts.browser.rate, pitch: cfg.tts.browser.pitch, voice: cfg.tts.browser.voice } }
      }
      try {
        const en = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
        const text = (en && en.id === 'en') ? PREVIEW_SAMPLE_EN : PREVIEW_SAMPLE
        const audioUrl = await synthToRoute(text, cfg, '', { sectionId: cfg.tts.volcengine && cfg.tts.volcengine.useSectionId ? randomUUID() : '' })
        return { ok: true, mode: 'audio', audioUrl }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
    stop: async () => {
      if (currentAbort) currentAbort.abort()
      stopRun(currentStreamRun)
      pendingSpeak = null
      return { ok: true }
    },
    speak: async (args) => {
      const a = args || {}
      if (!a.sessionId || !a.messageId) return { ok: false, error: 'missing sessionId or messageId' }
      const sid = String(a.sessionId)
      const mid = String(a.messageId)
      const found = extractText(sid, mid)
      if (found.error) return { ok: false, error: found.error }
      const cfg = normalizeVoiceConfig(scope.get()) // 归一化视图（UI 显示与实际发声一致）
      const regen = !!(a.regen) // 重新生成：跳过转写缓存，重新转写+合成，覆盖旧缓存条目
      if (isStreamingVolc(cfg)) {
        // 双向流：立即返回 runId，管线后台跑；客户端经 streamNext 取音频段
        const run = createStreamRun(sid, mid, cfg)
        run.force = regen
        runPipeline(run, found, cfg)
        return { ok: true, mode: 'stream', runId: run.id, sessionId: sid, messageId: mid, sampleRate: cfg.tts.volcengine.sampleRate || 24000, warn: run.warn || undefined }
      }
      try {
        return await transcribe(sid, mid, { force: regen })
      } catch (error) {
        console.error('[voice] speak failed:', error)
        return { ok: false, error: String(error && error.message || error) }
      }
    },
    /** 双向流：取下一段就绪音频 url；done 表示管线结束且队列已空。 */
    streamNext: async (args) => {
      const run = args && args.runId ? streamRuns.get(String(args.runId)) : null
      if (!run) return { ok: false, error: 'stream run not found' }
      const next = run.queue.shift()
      if (next) return { ok: true, url: '/voice/audio/' + next.id, format: next.format || 'pcm', segments: run.segments }
      if (run.finished) {
        // 删除交给 runPipeline 的 disposeRun 兜底定时器（8s 后清段+摘注册），此处保持 8s 宽限不误报
        return { ok: true, done: true, error: run.error || undefined, warn: run.warn || undefined, paragraphs: run.paragraphs, effortMapped: run.effortMapped, effortNote: run.effortNote || undefined }
      }
      return { ok: true, pending: true }
    },
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/voice/api',
    handler: async (req, res) => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      }
      try {
        if (req.method !== 'POST') { send(405, { ok: false, error: 'POST only' }); return }
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname
        const name = pathname.slice('/voice/api/'.length)
        const method = methods[name]
        if (!method) { send(404, { ok: false, error: 'unknown method: ' + name }); return }
        let raw = ''
        for await (const chunk of req) raw += chunk
        const args = raw ? JSON.parse(raw) : {}
        send(200, await method(args))
      } catch (error) {
        send(500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })

  // 一次性音频路由：/voice/audio/<id>（取一次即删）
  ctx.webServer.register({
    kind: 'prefix',
    path: '/voice/audio',
    handler: (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname
        const id = decodeURIComponent(pathname.slice('/voice/audio/'.length))
        const hit = audioStore.get(id)
        if (!hit) { res.writeHead(404); res.end('not found'); return }
        audioStore.delete(id)
        res.writeHead(200, { 'Content-Type': hit.mime, 'Cache-Control': 'no-store', 'Content-Length': hit.buf.length })
        res.end(hit.buf)
      } catch (error) {
        res.writeHead(500); res.end(String(error && error.message || error))
      }
    },
  })

  console.log('[voice] host half applied: /voice/api/* + /voice/audio/* ready, voice settings namespace registered')
}

export { apply, inject }
//#endregion
