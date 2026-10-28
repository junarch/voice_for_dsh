#!/usr/bin/env node

// DSH Client 半的最小合约测试：不启动浏览器，只验证 ModuleLoader 导出的依赖、槽位注册形状、
// turnTail 徽标的"claim 逻辑"、会话 Definition 与 i18n 键对齐。
//
// 关键点：槽位注册形状按上游 SlotRegistry.register 的校验规则复刻（list 槽位必须有 id；
// select 只有 chain 槽位才认），并且真的**执行** slots.inject 的回调——上一版只把槽位名塞进数组，
// register 从未被调用，于是"turnTail 用 select 又漏 id"这个会让注册直接抛错的缺陷被漏掉了。
import { readFileSync } from 'node:fs'

const loaded = []
const originalWindow = globalThis.window

try {
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => loaded.push(entry),
    },
  }

  await import(new URL('../packages/dsh-plugin-voice/lib/client.js?client-contract', import.meta.url))

  if (loaded.length !== 1) throw new Error('expected one ModuleLoader entry, got ' + loaded.length)

  // React 替身：createElement 返回可断言的普通节点描述；hooks 只返回固定值（不跑真实渲染）
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  }
  const client = loaded[0].factory((id) => {
    if (id === 'react') return reactStub
    throw new Error('unexpected client dependency: ' + id)
  })

  // 槽位替身：inject 立即执行回调（真跑注册），register 复刻上游 list 槽位的必需字段校验
  const registrations = []
  const slots = {
    inject: (name, callback) => {
      currentInject = name
      callback()
      currentInject = null
    },
    register: (options, component) => {
      const slotName = options.name
      if (!slotName) throw new Error('slot registration without name')
      if (options.select !== undefined) {
        throw new Error(`slot "${slotName}" 用了 chain 槽位专有的 select（list 槽位应把 claim 判断放进组件）`)
      }
      if (!options.id) throw new Error(`list slot "${slotName}" requires options.id`)
      if (currentInject !== null && currentInject !== slotName) {
        throw new Error(`slots.inject("${currentInject}") 里注册了别的槽位 "${slotName}"`)
      }
      registrations.push({ options, component })
    },
  }
  let currentInject = null

  const definitions = []
  const effects = []
  client.apply({
    effect: (callback) => { effects.push(callback) },
    slots,
    locale: undefined,
    uiConversation: { events: { register: (definition) => definitions.push(definition) } },
  })

  const expectedSlots = [
    'conversation.chat.assistant-actions',
    'conversation.input.left',
    'conversation.chat.turnTail',
    'settings.section',
    'shell.overlay',
  ]
  const names = registrations.map((r) => r.options.name)
  const hasExactSlots = expectedSlots.length === names.length && expectedSlots.every((n, i) => names[i] === n)
  if (!hasExactSlots) throw new Error('unexpected registered slots: ' + JSON.stringify(names))
  const noId = registrations.filter((r) => !r.options.id)
  if (noId.length) throw new Error('registered without id: ' + JSON.stringify(noId.map((r) => r.options.name)))
  const notComponent = registrations.filter((r) => typeof r.component !== 'function')
  if (notComponent.length) throw new Error('slot without a component: ' + JSON.stringify(notComponent.map((r) => r.options.name)))

  if (!client.inject.includes('uiConversation') || client.inject.includes('conversationEvents')) {
    throw new Error('client inject must require uiConversation and not conversationEvents: ' + JSON.stringify(client.inject))
  }
  if (definitions.length !== 1 || definitions[0].kind !== 'voice') {
    throw new Error('voice Definition was not registered through uiConversation.events')
  }

  // turnTail 徽标：读本轮 turn 数据里的 voice.messageId；读不到 / 该消息从未被朗读 → 返回 null（不占位）
  const badge = registrations.find((r) => r.options.name === 'conversation.chat.turnTail')
  const turnData = (value) => ({ data: { get: (key) => (key === 'voice' ? value : undefined) } })
  const claimCases = [
    ['本轮没有可朗读消息', undefined],
    ['本轮消息字段为空', {}],
    ['该消息从未被朗读', { messageId: 'm-1' }],
    ['turn.data 缺失', null],
  ]
  for (const [label, value] of claimCases) {
    const rendered = badge.component({ sessionId: 's1', turn: value === null ? {} : turnData(value) })
    if (rendered !== null) {
      throw new Error(`badge 在"${label}"时应返回 null（不许占位），实际: ${JSON.stringify(rendered)}`)
    }
  }

  // i18n 键对齐：zh / en 两套文案的 key 集合必须一致（漏配一边会显示成 key 本身）
  const source = readFileSync(new URL('../packages/dsh-plugin-voice/lib/client.js', import.meta.url), 'utf8')
  const blockOf = (name) => {
    const start = source.indexOf('var ' + name + ' = {')
    if (start < 0) throw new Error('i18n block not found: ' + name)
    const end = source.indexOf('\n    };', start)
    return source.slice(start, end < 0 ? source.length : end)
  }
  // 一行里可能并列多个键（zh 常见），故匹配任意位置的 "key":，不锚定行首
  const keysOf = (block) => [...block.matchAll(/"([^"]+)":/g)].map((m) => m[1]).sort()
  const zhKeys = keysOf(blockOf('zh'))
  const enKeys = keysOf(blockOf('en'))
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
  if (!zhKeys.length) throw new Error('i18n key extraction returned nothing: ' + JSON.stringify(zhKeys))
  if (onlyZh.length || onlyEn.length) {
    throw new Error('i18n keys mismatch — only zh: ' + JSON.stringify(onlyZh) + ' ; only en: ' + JSON.stringify(onlyEn))
  }
  // 播报失败分类文案（Host 的 ttsErrorKind 依赖这三条 + 兜底）
  for (const k of ['toast.fallback', 'toast.ttsUnavailable', 'toast.ttsTimeout', 'toast.ttsHttp']) {
    if (!zhKeys.includes(k)) throw new Error('missing toast key: ' + k)
  }
  // 提示音第五层：层头/层体/上传/校验的文案缺一条，界面上就会露出 key 本身
  const chimeKeys = [
    'layer.l5.title', 'layer.l5.summary.on', 'layer.l5.summary.off',
    'row.chimeEnabled', 'row.chimeVolume', 'hint.chime',
    'chime.work', 'chime.done', 'chime.ask',
    'chime.source.custom',
    'chime.variant.work.a', 'chime.variant.work.b', 'chime.variant.work.c',
    'chime.variant.done.a', 'chime.variant.done.b', 'chime.variant.done.c',
    'chime.variant.ask.a', 'chime.variant.ask.b', 'chime.variant.ask.c',
    'chime.upload', 'chime.uploading', 'chime.uploaded', 'chime.uploadFail',
    'chime.tooLarge', 'chime.tooLong', 'chime.undecodable',
    'chime.noFile', 'chime.missing', 'chime.preview', 'chime.previewFail',
    'chime.audioUnavailable', 'chime.rowToggle',
  ]
  for (const k of chimeKeys) {
    if (!zhKeys.includes(k)) throw new Error('missing chime key: ' + k)
  }

  // 音色能力过滤（防漂移）：Client 不许再内联一份能力数据，只按 meta 下发过滤
  for (const gone of ['DIALECT_IDS', 'correctSpeakerForLanguage', 'correctLanguageForSpeaker', 'var VV_SPEAKER']) {
    if (source.includes(gone)) throw new Error('Client 不应再内联音色能力逻辑（发现 ' + gone + '）：能力数据只在 Host voice-compat.js，经 meta 下发')
  }
  for (const need of ['languagesOfVoice', 'shownLanguages', 'shownVoices']) {
    if (!source.includes(need)) throw new Error('Client 缺少按音色能力过滤的实现：' + need)
  }
  // 设置页不再暴露 resourceId，也不再出现 vv/explicit_dialect 这类黑话
  if (zhKeys.includes('row.resourceId')) throw new Error('设置页不应再展示 resourceId')
  for (const jargon of ['explicit_dialect', '方言需 vv 音色']) {
    if (source.includes(jargon)) throw new Error('设置页文案不应出现术语：' + jargon)
  }
  // 语种/音色各留一条必要文案（英文改写说明挪进了 English 选项名）
  for (const k of ['dialect.onlyVoices', 'language.enOption']) {
    if (!zhKeys.includes(k)) throw new Error('missing capability hint key: ' + k)
  }

  console.log('client contract: uiConversation.events + voice Definition + ' + registrations.length +
    ' slots(带 id、无 select) + turnTail claim 逻辑 + i18n(' + zhKeys.length + ' keys) OK')
} finally {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
}
