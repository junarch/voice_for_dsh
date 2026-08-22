//#region dsh-plugin-voice — 音色 ↔ 语种/方言 兼容矩阵（纯函数，单一事实源）
/**
 * 不变式：方言 ⟺ vv；English ⟺ 英文音色；中文/自动 配中文音色（含 vv）。
 * 设计（docs/voice-pipeline.md §5.5）：
 *  - 交互（设置页）＝后改的字段胜出：改语言→纠音色；改音色→纠语言。
 *  - 静态（settings.yaml 直改）＝normalizeVoiceConfig 确定性定序。
 * 两条路径产出的配置都满足不变式，UI 显示 = 实际发声；合成期 correctSpeakerForLanguage
 * 再兜底一次（方言→vv、English→英文音色）。
 * Client 半因无 import，内联同一份（见 lib/client.js 顶部注释）。
 */

/** 方言唯一音色（explicit_dialect 实测仅 vv 支持）。 */
export const VV_SPEAKER = 'zh_female_vv_uranus_bigtts'
/** English 默认英文音色（实测可用）。 */
export const EN_DEFAULT_SPEAKER = 'en_male_tim_uranus_bigtts'
/** 英文音色 id 前缀。 */
export const EN_VOICE_PREFIXES = ['en_', 'ICL_uranus_en_']

/** 语种/方言选项（方言统一走 vv + explicit_dialect；只适配 2.0，不接 1.0 方言音色）。
 * auto = 跟随原文主体语言。 */
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
 * 归一化 TTS 引擎：只有 'volcengine' 视为豆包；其余（含旧值 openai-compatible）
 * 一律按 'browser' 处理——容忍存量配置里的已废弃值，避免把未知 provider 当云 TTS。
 */
export function ttsProviderOf(cfg) {
  const p = cfg && cfg.tts && cfg.tts.provider
  return p === 'volcengine' ? 'volcengine' : 'browser'
}

export function isEnVoice(speaker) {
  return !!speaker && EN_VOICE_PREFIXES.some((p) => speaker.startsWith(p))
}
export function isVvVoice(speaker) {
  return speaker === VV_SPEAKER
}
/** 音色类别：vv（方言专用）| en（英文）| zh（其余中文/自定义，按中文处理）。 */
export function voiceCategory(speaker) {
  if (isEnVoice(speaker)) return 'en'
  if (isVvVoice(speaker)) return 'vv'
  return 'zh'
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
 * speaker 跟随语种（合成期安全纠错 + 静态归一第 1/2 步）：
 * 方言→vv；English→若当前音色非英文则切默认英文音色；其余→原音色。
 */
export function correctSpeakerForLanguage(cfg, currentSpeaker) {
  const language = cfg && cfg.language
  if (isDialectLanguage(language)) return VV_SPEAKER
  if (language === 'en' && !isEnVoice(currentSpeaker)) return EN_DEFAULT_SPEAKER
  return currentSpeaker
}

/**
 * 语种跟随 speaker（交互期：用户改了音色，让不适配的语种自动跟随）：
 *  - en 音色 → 语种=en；
 *  - vv → 方言/zh/auto 保持，en 改 zh（en 需英文音色，vv 不适配）；
 *  - zh 非 vv → 方言或 en 改 zh，其余保持。
 * 返回修正后的语种 id。
 */
export function correctLanguageForSpeaker(cfg, currentSpeaker) {
  const language = cfg && cfg.language
  const cat = voiceCategory(currentSpeaker)
  if (cat === 'en') return language === 'en' ? language : 'en'
  if (cat === 'vv') return language === 'en' ? 'zh' : language
  if (isDialectLanguage(language) || language === 'en') return 'zh'
  return language
}

/**
 * 静态归一（getConfig/setConfig 用）：确定性定序，输出满足不变式的配置副本。
 * 1) 方言 → speaker=vv（语种锚定：方言需 vv）；
 * 2) 否则 en → speaker=英文音色；
 * 3) 否则（zh/auto）→ 原样保持（含 en 音色读中文的显式手动配置，如实反映，不静默翻转）。
 * 交互侧（设置页）由 correctLanguageForSpeaker/correctSpeakerForLanguage 做"后改字段胜出"的
 * 双向纠错，normalize 只在 getConfig/setConfig/speak 入口兜底一次。
 * 无变化时返回原对象（不产生副本）。
 */
export function normalizeVoiceConfig(cfg) {
  if (!cfg || !cfg.tts || !cfg.tts.volcengine) return cfg
  const v = cfg.tts.volcengine
  const language = cfg.language || ''
  const speaker = v.speaker || ''
  let newSpeaker = speaker
  if (isDialectLanguage(language)) {
    newSpeaker = VV_SPEAKER
  } else if (language === 'en' && !isEnVoice(speaker)) {
    newSpeaker = EN_DEFAULT_SPEAKER
  }
  // 音调归一：仅提供旧 pitchLevel（无新 pitch）时，把五档映射为连续半音，保证 UI 滑块有值
  const pitch = pitchOf(v)
  const vNorm = (typeof v.pitch === 'number' && !Number.isNaN(v.pitch)) || Number.isInteger(v.pitchLevel)
    ? Object.assign({}, v, { pitch })
    : v
  if (newSpeaker === speaker && vNorm === v) return cfg
  return Object.assign({}, cfg, { tts: Object.assign({}, cfg.tts, { volcengine: Object.assign({}, vNorm, { speaker: newSpeaker }) }) })
}
//#endregion
