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
 *    reasoningEffort 可配（deepseek: off=关闭思考 / low / high / max），不支持时降级重试
 *  - TTS Provider 适配层：browser（Client speechSynthesis 透传）/
 *    openai-compatible（POST /audio/speech）/ volcengine（HTTP 单向，chunked JSON 行）
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

/** 转写基线 system prompt（docs/voice-pipeline.md §1.2；可被 voice.transcribe.prompt 覆盖） */
const TRANSCRIBE_SYSTEM = '你是一个"文本口语化转写器"。把用户给你的 AI 助手输出改写为适合 TTS 语音朗读的口语文稿。\n输出语言与原文保持一致：中文原文输出中文口播，英文原文输出英文口播，混合内容跟随主体语言。\n规则：\n1. 代码块（``` ... ``` 或行内 `code`）：不要逐字朗读。用一句话概括其作用，例如"这里给出了一段 Python 代码，作用是读取文件并统计行数"；必要时才读出关键符号名（读作字母/单词）。\n2. 表格：不要朗读 Markdown 表格符号。按行转述："表格第一列是X，第二列是Y；第一行……第二行……"，或概括要点。\n3. 列表：用口语连接词："第一、……；第二、……" 或 "其中包括……"。\n4. URL：只读域名部分（如"链接指向 github 点 com"），不逐字符读。\n5. 符号/缩写：保留重要术语与数字；英文缩写按常见读法（如 API 读作 A-P-I）。\n6. 删除所有 Markdown 标记（#、*、-、|、> 等）、代码符号、JSON 花括号等，除非其内容是结论的一部分。\n7. 保留结论、建议、关键数字、文件名（文件名可读出）、时间等信息。\n8. 语气自然口语化，可用"首先/然后/最后/总之"组织；输出纯文本，不加任何解释或前缀。'

/** 简报模式 prompt（readMode=brief：只要结论，忽略细节） */
const BRIEF_SYSTEM = '你是一个"简报式口播器"。把 AI 助手的输出压缩成一段简明扼要的口播简报：\n1. 用一两句话说清楚"做了什么 / 结论是什么"，忽略过程细节。\n2. 代码、表格、配置等只提一句定性描述（如"给出了一段实现某某功能的代码"），不展开。\n3. 总长度控制在 100 字以内，直接输出纯文本，不加任何前缀或解释。'

const PREVIEW_SAMPLE = '你好，这是 dsh 语音播报插件的试听。转写会把代码和表格变成口语，播报验证一二三。'

/** 降级直读：不调 LLM，把 Markdown 剥离为可朗读的纯文本（转写失败/超时兜底）。 */
function toPlainSpoken(text) {
  let t = String(text || '')
  t = t.replace(/```[\s\S]*?```/g, '（此处有一段代码，略去不读）')
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/^\s*\|.*\|\s*$/gm, (line) => {
    const cells = line.split('|').map((s) => s.trim()).filter((s) => s && !/^[-:]+$/.test(s))
    return cells.length ? cells.join('，') : ''
  })
  t = t.replace(/https?:\/\/[^\s)\]]+/g, (u) => { try { return '链接' + new URL(u).hostname } catch { return '链接' } })
  t = t.replace(/^#{1,6}\s*/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^\s*\d+\.\s+/gm, '')
  t = t.replace(/[*_~]/g, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/** 火山豆包 2.0 可选音色（docs/research：豆包语音_音色列表.pdf；设置页下拉 + 允许自定义输入） */
const VOLC_VOICES = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0' },
]

/**
 * 语种/方言选项。zh/en 只影响转写文稿语言；方言额外给豆包 TTS 注入 [#方言] 语音指令
 *（方言发音由 TTS 指令实现，文稿仍是中文用字+方言语汇）。auto = 跟随原文主体语言。
 */
const LANGUAGE_OPTIONS = [
  { id: 'auto', label: '自动（跟随原文）', instruct: '', dialect: false },
  { id: 'zh', label: '中文（普通话）', instruct: '中文普通话', dialect: false },
  { id: 'en', label: 'English', instruct: 'English', dialect: false },
  { id: 'yue', label: '粤语', instruct: '粤语', dialect: true },
  { id: 'shanghai', label: '上海话', instruct: '上海话', dialect: true },
  { id: 'henan', label: '河南话', instruct: '河南话', dialect: true },
  { id: 'beijing', label: '北京话', instruct: '北京话', dialect: true },
  { id: 'tianjin', label: '天津话', instruct: '天津话', dialect: true },
  { id: 'sichuan', label: '四川话', instruct: '四川话', dialect: true },
  { id: 'shaanxi', label: '陕西话', instruct: '陕西话', dialect: true },
  { id: 'dongbei', label: '东北话', instruct: '东北话', dialect: true },
]

/** 豆包 2.0 语速/音调：五档定性档位 → 语音指令（该接口无数值参数，指令是文档化能力） */
const RATE_STOPS = ['很慢', '稍慢', '正常', '稍快', '很快']
const PITCH_STOPS = ['很低', '稍低', '正常', '稍高', '很高']

/** 播报风格预设 = 转写 prompt 模板（俏皮/暧昧/活力在基线规则上追加风格与语音指令标签约定） */
const STYLE_PRESETS = [
  { id: 'default', name: '默认模式', prompt: '' }, // 内置基线，不含语音指令标签
  {
    id: 'playful', name: '俏皮',
    prompt: TRANSCRIBE_SYSTEM + '\n9. 语气风格：俏皮活泼、机灵可爱，可用活泼的感叹词；在合适的位置可插入极少量豆包语音指令标签（格式 [#...]，如 [#俏皮地笑着说]），每段至多一个，不得影响信息准确。',
  },
  {
    id: 'ambiguous', name: '暧昧',
    prompt: TRANSCRIBE_SYSTEM + '\n9. 语气风格：温柔暧昧、轻声细语、欲言又止；在合适的位置可插入极少量豆包语音指令标签（格式 [#...]，如 [#压低声音、带着温柔的笑意说]），每段至多一个，不得影响信息准确。',
  },
  {
    id: 'energetic', name: '活力',
    prompt: TRANSCRIBE_SYSTEM + '\n9. 语气风格：充满活力、语速明快、情绪饱满有感染力；在合适的位置可插入极少量豆包语音指令标签（格式 [#...]，如 [#元气满满地说]），每段至多一个，不得影响信息准确。',
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

/** settings.yaml 的 voice: 命名空间（字段一次定稿，避免迁移；docs/voice-pipeline.md §4） */
const VoiceSettingsSchema = z.object({
  autoSpeak: z.boolean().default(false),
  autoSpeakCloudTts: z.boolean().default(false),
  language: z.string().default('auto'), // LANGUAGE_OPTIONS 的 id；auto = 跟随原文
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  transcribe: z.object({
    maxTokens: z.number().default(8192),
    temperature: z.number().default(0.3),
    prompt: z.string().default(''), // stylePreset=custom 时的自定义 prompt
    reasoningEffort: z.string().default('off'), // '' = 跟随适配器默认；deepseek: off|low|high|max
    stylePreset: z.string().default('default'), // default|playful|ambiguous|energetic|custom
    readMode: z.string().default('default'),    // default=完整转写 | brief=简报模式
    contextTurns: z.number().default(2), // 引用上文：转写时携带的最近轮数（0=关闭）
    timeoutMs: z.number().default(60000), // 单次转写超时；超时/失败降级为直读
  }).default({ maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: 'off', stylePreset: 'default', readMode: 'default', contextTurns: 2, timeoutMs: 60000 }),
  tts: z.object({
    provider: z.union([z.const('browser'), z.const('openai-compatible'), z.const('volcengine')]).default('browser'),
    browser: z.object({
      rate: z.number().default(1),
      pitch: z.number().default(1),
      voice: z.string().default(''),
    }).default({ rate: 1, pitch: 1, voice: '' }),
    openaiCompatible: z.object({
      baseUrl: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default('tts-1'),
      voice: z.string().default(''),
      format: z.string().default('mp3'),
    }).default({ baseUrl: '', apiKey: '', model: 'tts-1', voice: '', format: 'mp3' }),
    volcengine: z.object({
      apiKey: z.string().default(''),
      resourceId: z.string().default('seed-tts-2.0'),
      speaker: z.string().default('zh_female_vv_uranus_bigtts'),
      sampleRate: z.number().default(24000),
      rateLevel: z.number().default(2),  // RATE_STOPS 下标 0–4
      pitchLevel: z.number().default(2), // PITCH_STOPS 下标 0–4
    }).default({ apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitchLevel: 2 }),
  }).default({
    provider: 'browser',
    browser: { rate: 1, pitch: 1, voice: '' },
    openaiCompatible: { baseUrl: '', apiKey: '', model: 'tts-1', voice: '', format: 'mp3' },
    volcengine: { apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitchLevel: 2 },
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
  let latestGlobal = null
  let pendingSpeak = null
  const transcriptCache = loadTranscriptCache()
  const audioStore = new Map() // id → { buf: Buffer, mime: string }（一次性取出）
  let currentAbort = null // 进行中的转写，voice.stop 中止
  let turnGeneration = 0 // 每个 turn/start 自增：stopOnNewTurn 的客户端停播信号
  // 引用上文状态：每会话最近的用户输入与已播报文稿（供转写语境 + TTS 上文引用）
  const turnBySession = new Map()        // sid → 当前 turn（turn/start）
  const userTurnsBySession = new Map()   // sid → [{ turn, text }]（上限 6）
  const transcriptsBySession = new Map() // sid → [{ turn, text }]（上限 4）

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
        latestGlobal = entry
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
      if (cfg.tts.provider !== 'browser' && !cfg.autoSpeakCloudTts) {
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

  /** 解析实际使用的转写 prompt：简报模式 > 预设风格 > 自定义 > 内置基线；叠加语种/方言要求。 */
  function resolvePrompt(cfg) {
    let base
    if (cfg.transcribe.readMode === 'brief') {
      base = BRIEF_SYSTEM // 简报模式：忽略风格预设与自定义 prompt
    } else {
      const preset = cfg.transcribe.stylePreset || 'default'
      if (preset === 'custom') base = cfg.transcribe.prompt || TRANSCRIBE_SYSTEM
      else { const hit = STYLE_PRESETS.find((p) => p.id === preset); base = (hit && hit.prompt) || TRANSCRIBE_SYSTEM }
    }
    const lang = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
    if (lang && lang.id !== 'auto') {
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

  /** 豆包 TTS 文本组装：[#上文引用] + [#方言/语速/音调指令] + 文稿（指令只影响演绎，不被朗读）。 */
  function buildVolcText(transcript, cfg, currentUserText) {
    const v = cfg.tts.volcengine
    const directives = []
    const lang = LANGUAGE_OPTIONS.find((l) => l.id === cfg.language)
    if (lang && lang.dialect) directives.push('用' + lang.instruct + '播报')
    if (v.rateLevel !== 2 && RATE_STOPS[v.rateLevel]) directives.push('语速' + RATE_STOPS[v.rateLevel] + '一点')
    if (v.pitchLevel !== 2 && PITCH_STOPS[v.pitchLevel]) directives.push('音调' + PITCH_STOPS[v.pitchLevel] + '一点')
    let text = transcript
    if (directives.length) text = '[#' + directives.join('，') + ']' + text
    if (currentUserText) text = '[#上文：' + currentUserText.slice(0, 200) + ']' + text
    return text
  }

  // ---- TTS Provider 适配层 -----------------------------------------------------
  async function synthesizeVolcengine(text, v) {
    if (!v.apiKey) throw new Error('volcengine apiKey 未配置（voice.tts.volcengine.apiKey）')
    const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': v.apiKey,
        'X-Api-Resource-Id': v.resourceId || 'seed-tts-2.0',
      },
      body: JSON.stringify({
        req_params: { text, speaker: v.speaker, audio_params: { format: 'mp3', sample_rate: v.sampleRate } },
      }),
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

  async function synthesizeOpenAICompat(text, o) {
    if (!o.baseUrl) throw new Error('openai-compatible baseUrl 未配置（voice.tts.openaiCompatible.baseUrl）')
    const res = await fetch(o.baseUrl.replace(/\/+$/, '') + '/audio/speech', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, o.apiKey ? { Authorization: 'Bearer ' + o.apiKey } : {}),
      body: JSON.stringify({ model: o.model || 'tts-1', input: text, voice: o.voice || undefined, response_format: o.format || 'mp3' }),
    })
    if (!res.ok) throw new Error('openai-compatible http ' + res.status + ' ' + (await res.text().catch(() => '')))
    return Buffer.from(await res.arrayBuffer())
  }

  /** 合成并挂一次性音频路由；返回 '/voice/audio/<id>'。 */
  async function synthToRoute(text, cfg) {
    const buf = cfg.tts.provider === 'volcengine'
      ? await synthesizeVolcengine(text, cfg.tts.volcengine)
      : await synthesizeOpenAICompat(text, cfg.tts.openaiCompatible)
    const id = randomUUID()
    audioStore.set(id, { buf, mime: 'audio/mpeg' })
    return '/voice/audio/' + id
  }

  async function transcribe(sessionId, messageId) {
    const found = extractText(sessionId, messageId)
    if (found.error) return { ok: false, error: found.error }
    const cfg = scope.get()
    const configured = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null
    const promptUsed = resolvePrompt(cfg)
    const effortUsed = cfg.transcribe.reasoningEffort || ''
    const ctxRef = buildContext(sessionId, found.turn || 0, cfg.transcribe.contextTurns)

    // 缓存命中：同一条消息 + 同一路由 + 同一 prompt/effort → 直接复用转写稿
    let route = configured
    const cached = transcriptCache.get(String(messageId))
    let transcript = null
    let fromCache = false
    if (cached && configured && cached.provider === configured.provider && cached.model === configured.model
      && cached.prompt === promptUsed && (cached.effort || '') === effortUsed) {
      transcript = cached.transcript
      fromCache = true
    }

    let degraded = false
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
        if (!route) route = await discoverRoute()
        let result
        try {
          result = await attempt(route, maxTokens, effortUsed || undefined)
        } catch (e1) {
          const msg = String(e1 && e1.message || e1)
          if (effortUsed && /effort|reasoning/i.test(msg)) {
            console.warn('[voice] reasoningEffort unsupported, retrying without:', msg)
            result = await attempt(route, maxTokens, undefined)
          } else if (configured) {
            console.warn('[voice] configured route failed, falling back to discovery:', msg)
            route = await discoverRoute()
            result = await attempt(route, maxTokens, effortUsed || undefined)
          } else {
            throw e1
          }
        }
        // 推理模型思考烧光额度 → 4 倍重试
        if (!result.transcript && result.finishKind === 'max-tokens') {
          console.warn('[voice] transcript empty at max-tokens, retrying with 4x budget')
          result = await attempt(route, maxTokens * 4, undefined)
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

    // TTS：browser 透传 Client speechSynthesis；云 provider 在 Host 合成后挂一次性音频路由
    let audioUrl
    let ttsError
    if (cfg.tts.provider !== 'browser') {
      try {
        const ttsText = cfg.tts.provider === 'volcengine' ? buildVolcText(transcript, cfg, ctxRef.currentUserText) : transcript
        audioUrl = await synthToRoute(ttsText, cfg)
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
      audioUrl,
      ttsError,
      speech: { rate: cfg.tts.browser.rate, pitch: cfg.tts.browser.pitch, voice: cfg.tts.browser.voice },
    }
  }

  // ---- /voice/api/* JSON RPC -------------------------------------------------
  const methods = {
    ping: async () => ({ ok: true, now: new Date().toISOString() }),
    defaultPrompt: async () => ({ ok: true, prompt: TRANSCRIBE_SYSTEM }),
    meta: async () => ({
      ok: true,
      voices: VOLC_VOICES,
      languages: LANGUAGE_OPTIONS.map((l) => ({ id: l.id, label: l.label })),
      stylePresets: STYLE_PRESETS.map((p) => ({ id: p.id, name: p.name, prompt: p.id === 'default' ? TRANSCRIBE_SYSTEM : p.prompt })),
      readModes: [
        { id: 'default', name: '默认模式（完整转写）' },
        { id: 'brief', name: '简报模式（简明扼要）' },
      ],
      briefPrompt: BRIEF_SYSTEM,
      rateStops: RATE_STOPS,
      pitchStops: PITCH_STOPS,
    }),
    getState: async () => {
      const cfg = scope.get()
      return { ok: true, autoSpeak: cfg.autoSpeak, pending: !!pendingSpeak, tts: cfg.tts }
    },
    getConfig: async () => ({ ok: true, config: scope.get() }),
    setConfig: async (args) => {
      const patch = args && args.patch
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'missing patch' }
      await ctx.settings.update('voice', patch)
      return { ok: true, config: scope.get() }
    },
    routeInfo: async (args) => {
      const a = args || {}
      const providers = llm.listProviders().map((p) => String(p.id))
      const provider = a.provider || providers[0] || ''
      let models = []
      try { models = (await llm.listModels(provider)).map((m) => String(m.id)) } catch { /* 忽略，留空 */ }
      const model = a.model || models[0] || ''
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
      const cfg = scope.get()
      if (cfg.tts.provider === 'browser') {
        return { ok: true, mode: 'browser', text: PREVIEW_SAMPLE, speech: { rate: cfg.tts.browser.rate, pitch: cfg.tts.browser.pitch, voice: cfg.tts.browser.voice } }
      }
      try {
        const sample = cfg.tts.provider === 'volcengine' ? buildVolcText(PREVIEW_SAMPLE, cfg, '') : PREVIEW_SAMPLE
        const audioUrl = await synthToRoute(sample, cfg)
        return { ok: true, mode: 'audio', audioUrl }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    },
    stop: async () => {
      if (currentAbort) currentAbort.abort()
      pendingSpeak = null
      return { ok: true }
    },
    speak: async (args) => {
      const a = args || {}
      if (!a.sessionId || !a.messageId) return { ok: false, error: 'missing sessionId or messageId' }
      try {
        return await transcribe(String(a.sessionId), String(a.messageId))
      } catch (error) {
        console.error('[voice] speak failed:', error)
        return { ok: false, error: String(error && error.message || error) }
      }
    },
    speakLatest: async () => {
      if (!latestGlobal) return { ok: false, error: 'no assistant/message recorded yet' }
      try {
        return await transcribe(latestGlobal.sessionId, latestGlobal.messageId)
      } catch (error) {
        console.error('[voice] speakLatest failed:', error)
        return { ok: false, error: String(error && error.message || error) }
      }
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
