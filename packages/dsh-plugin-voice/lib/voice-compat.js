//#region dsh-plugin-voice — 音色能力（语种/方言）+ 旧配置归一（纯函数，单一事实源）
/**
 * 不变式（docs/pipeline.md §4.2）：**能选出来的组合一定合法**。
 *  - 方言只对支持方言的音色开放（官方 2.0 音色表：粤语/上海/河南/北京/天津/四川/陕西/东北
 *    只标在 Vivi 2.0、小何 2.0、云舟 2.0、小天 2.0 四个音色上；其余中文音色只标"中文"）；
 *  - 英文音色只配 English（探针实测：英文音色读中文文本返回空音频）；
 *  - 其余中文音色配 自动/中文/English（探针实测：中文音色读英文文本正常出声）。
 * 交互侧靠下拉过滤保证合法（设置页只渲染 meta 下发的 voices[].languages）；
 * normalizeVoiceConfig 只做旧配置/手改配置的软着陆，对页面产物恒等；合成期不再改写用户选择。
 * Client 半无 import：能力数据随 meta 下发，客户端只做渲染，不存第二份。
 */

/** 支持方言的 4 个音色（顺序即设置页"能说方言"的先后，第一个是方言默认音色）。 */
export const DIALECT_SPEAKERS = [
  'zh_female_vv_uranus_bigtts',
  'zh_female_xiaohe_uranus_bigtts',
  'zh_male_m191_uranus_bigtts',
  'zh_male_taocheng_uranus_bigtts',
]
/** 方言默认音色（旧配置里"方言 + 说不了方言的音色"→ 换成它，保留用户要方言的意图）。 */
export const VV_SPEAKER = DIALECT_SPEAKERS[0]
/** English 默认英文音色。 */
export const EN_DEFAULT_SPEAKER = 'en_male_tim_uranus_bigtts'
/** 英文音色 id 前缀（表外音色也按前缀认）。 */
export const EN_VOICE_PREFIXES = ['en_', 'ICL_uranus_en_']

/** 语种/方言选项（顺序即下拉顺序）。auto = 跟随原文主体语言，不下发 explicit_language。 */
export const LANGUAGE_OPTIONS = [
  { id: 'auto', label: '自动（跟随原文）', instruct: '', dialect: false },
  { id: 'zh', label: '中文（普通话）', instruct: '中文普通话', dialect: false },
  { id: 'en', label: 'English', instruct: 'English', dialect: false },
  { id: 'yue', label: '粤语', instruct: '粤语', dialect: true, dialectId: 'yue' },
  { id: 'shanghai', label: '上海话', instruct: '上海话', dialect: true, dialectId: 'shanghai' },
  { id: 'henan', label: '河南话', instruct: '河南话', dialect: true, dialectId: 'henan' },
  { id: 'beijing', label: '北京话', instruct: '北京话', dialect: true, dialectId: 'beijing' },
  { id: 'tianjin', label: '天津话', instruct: '天津话', dialect: true, dialectId: 'tianjin' },
  { id: 'sichuan', label: '四川话', instruct: '四川话', dialect: true, dialectId: 'sichuan' },
  { id: 'shaanxi', label: '陕西话', instruct: '陕西话', dialect: true, dialectId: 'shaanxi' },
  { id: 'dongbei', label: '东北话', instruct: '东北话', dialect: true, dialectId: 'dongbei' },
]

/** 方言 id 集合（由 LANGUAGE_OPTIONS 派生，避免两处漂移）。 */
export const DIALECT_IDS = new Set(LANGUAGE_OPTIONS.filter((l) => l.dialect && l.dialectId).map((l) => l.dialectId))
/** 方言语种 id 数组（顺序同下拉）。 */
export const DIALECT_LIST = LANGUAGE_OPTIONS.filter((l) => l.dialect).map((l) => l.id)
/** 所有音色都支持的基础语种（顺序同下拉）。 */
export const BASE_LANGUAGE_IDS = ['auto', 'zh', 'en']

/** 语速/音调五档 → 数值参数（speech_rate ∈ [-50,100] 实测生效；pitch 为半音经 additions.post_process.pitch）。
 * 2=正常档不发送参数。 */
export const RATE_VALUES = [-50, -25, 0, 30, 60]
export const PITCH_VALUES = [-6, -3, 0, 3, 6]
/** 音调细粒度：连续半音值（-12~12，0=正常）。 */
export const PITCH_MIN = -12
export const PITCH_MAX = 12

/**
 * 归一音调半音值（兼容迁移）：新字段 `pitch`（连续半音，-12~12，0=正常）优先；
 * 旧字段 `pitchLevel`（五档下标 0–4）映射到 PITCH_VALUES；都没有 → 0（正常）。
 */
export function pitchOf(v) {
  if (v && typeof v.pitch === 'number' && !Number.isNaN(v.pitch)) return v.pitch
  if (v && Number.isInteger(v.pitchLevel) && v.pitchLevel >= 0 && v.pitchLevel < PITCH_VALUES.length) return PITCH_VALUES[v.pitchLevel]
  return 0
}

/**
 * 归一化 TTS 引擎：'volcengine'=豆包（付费），'local'=本地 Kokoro v1.1（免费，
 * 进程内 sherpa-onnx，中英跟随原文）；已退役的 'local-cosyvoice' 归一到 'local'
 * （旧配置的意图是"用本地免费引擎"，不是"用系统朗读"）；其余（含旧值
 * openai-compatible）一律按 'browser' 处理——容忍存量配置里的已废弃值，
 * 避免把未知 provider 当豆包。
 */
export function ttsProviderOf(cfg) {
  const p = cfg && cfg.tts && cfg.tts.provider
  if (p === 'volcengine') return 'volcengine'
  if (p === 'local' || p === 'local-cosyvoice') return 'local'
  return 'browser'
}

/** 本地引擎（免费、离线、进程内合成）。 */
export function isLocalProvider(cfg) {
  return ttsProviderOf(cfg) === 'local'
}

export function isEnVoice(speaker) {
  return !!speaker && EN_VOICE_PREFIXES.some((p) => speaker.startsWith(p))
}
export function isDialectVoice(speaker) {
  return DIALECT_SPEAKERS.includes(speaker)
}
/** 音色类别：en（英文音色）| dialect（能说方言）| zh（其余中文/自定义）。 */
export function voiceCategory(speaker) {
  if (isEnVoice(speaker)) return 'en'
  if (isDialectVoice(speaker)) return 'dialect'
  return 'zh'
}
/** 目录内音色（官方 2.0 目录里的中英文音色）：旧配置自动纠错时只改这类音色，不碰用户手填的 id。 */
export function isCatalogVoice(speaker) {
  return isEnVoice(speaker) || /^zh_(female|male)_/.test(String(speaker || ''))
}
export function isDialectLanguage(language) {
  return DIALECT_IDS.has(language)
}
/** 语言 id → 方言参数值（非方言返回空串）。 */
export function dialectIdOf(languageId) {
  const lang = LANGUAGE_OPTIONS.find((l) => l.id === languageId)
  return (lang && lang.dialect && lang.dialectId) || ''
}
/** 语言 id → LANGUAGE_OPTIONS 条目（未命中返回 undefined）。 */
export function languageOptionOf(id) {
  return LANGUAGE_OPTIONS.find((l) => l.id === id)
}

/**
 * 该音色能选的语种/方言 id 列表（顺序同 LANGUAGE_OPTIONS）。设置页下拉直接照它过滤。
 * 表外音色按前缀判英文；其余按中文音色处理（没有能力数据就不开放方言——宁可少给，不给错）。
 */
export function languagesForVoice(speaker) {
  if (isEnVoice(speaker)) return ['en']
  const ids = BASE_LANGUAGE_IDS.slice()
  if (isDialectVoice(speaker)) ids.push(...DIALECT_LIST)
  return ids
}

/** 该音色是否支持某语种/方言。 */
export function voiceSupportsLanguage(speaker, languageId) {
  return languagesForVoice(speaker).includes(languageId)
}

/**
 * 有效发声参数（合成与指纹共用，避免两处各推一遍）：音色 + 方言 + 显式语种。
 * 方言只在音色真的会说时才下发；英文音色只在语种为 en 时下发 explicit_language。
 */
export function effectiveVoiceOf(cfg) {
  const speaker = (cfg && cfg.tts && cfg.tts.volcengine && cfg.tts.volcengine.speaker) || ''
  const language = (cfg && cfg.language) || ''
  const dialect = isDialectVoice(speaker) ? dialectIdOf(language) : ''
  const explicitLanguage = !dialect && language === 'en' ? 'en' : ''
  return { speaker, dialectId: dialect, explicitLanguage }
}

/**
 * 旧配置/手改配置软着陆（getConfig / speak / preview 入口各兜一次；页面产物恒等）：
 * 1) 未知语种 id → auto；
 * 2) 方言 + 说不了方言的音色：目录内音色 → 换成 Vivi（保留"要方言"的意图）；
 *    自定义 id → 语种降为 zh（绝不改写用户手填的 id）；
 * 3) 英文音色 + 非英文语种 → en（英文音色读中文返回空音频）；
 * 4) 音调：只有旧 pitchLevel 时补出新 pitch，保证滑块有值。
 * 无变化时返回原对象（不产生副本）。
 */
export function normalizeVoiceConfig(cfg) {
  if (!cfg || !cfg.tts || !cfg.tts.volcengine) return cfg
  const v = cfg.tts.volcengine
  const speaker = v.speaker || ''
  let language = cfg.language || ''
  let newSpeaker = speaker
  if (!LANGUAGE_OPTIONS.some((l) => l.id === language)) language = 'auto'
  if (isDialectLanguage(language) && !isDialectVoice(speaker)) {
    if (!speaker || isCatalogVoice(speaker)) newSpeaker = VV_SPEAKER
    else language = 'zh'
  }
  if (isEnVoice(newSpeaker) && language !== 'en') language = 'en'
  const pitch = pitchOf(v)
  const vNorm = (typeof v.pitch === 'number' && !Number.isNaN(v.pitch)) || Number.isInteger(v.pitchLevel)
    ? Object.assign({}, v, { pitch })
    : v
  if (language === cfg.language && newSpeaker === speaker && vNorm === v) return cfg
  return Object.assign({}, cfg, {
    language,
    tts: Object.assign({}, cfg.tts, { volcengine: Object.assign({}, vNorm, { speaker: newSpeaker }) }),
  })
}
//#endregion
