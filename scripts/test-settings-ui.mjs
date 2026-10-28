// 设置页「按引擎显隐」的 headless 渲染验证：不启浏览器、不重启桌面端，用极小的 React 替身
// 把真 VoiceSettingsSection 渲染成树，按 config.tts.provider 三档断言"该出现的出现、该藏的不出现"。
// 验证的是真 client.js，不是复制品；引擎切换走组件自己的 onChange，不另造分支。
import { readFileSync } from 'node:fs'

const VERSION = JSON.parse(readFileSync(new URL('../packages/dsh-plugin-voice/package.json', import.meta.url), 'utf8')).version

const checks = []
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond })
  console.log((cond ? '  ok ' : '  FAIL ') + name + (cond || detail === undefined ? '' : ' | ' + JSON.stringify(detail)))
}

// ---------- 迷你 React 渲染器 ----------
const hookStore = new Map()
let currentKey = ''
let hookIndex = 0
let effectsQueue = []
let dirty = false

function schedule() { dirty = true }

const reactStub = {
  createElement(type, props, ...children) {
    const out = Object.assign({}, props || {})
    out.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: out }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const entry = hookStore.get(currentKey) || { hooks: [] }
    hookStore.set(currentKey, entry)
    const i = hookIndex++
    if (!(i in entry.hooks)) entry.hooks[i] = typeof initial === 'function' ? initial() : initial
    const set = (v) => {
      const next = typeof v === 'function' ? v(entry.hooks[i]) : v
      if (Object.is(next, entry.hooks[i])) return
      entry.hooks[i] = next
      schedule()
    }
    return [entry.hooks[i], set]
  },
  useEffect(fn) {
    const entry = hookStore.get(currentKey) || { hooks: [] }
    hookStore.set(currentKey, entry)
    const i = hookIndex++
    const mark = 'e' + i
    if (!entry[mark]) { entry[mark] = true; effectsQueue.push(fn) }
    return undefined
  },
  useRef(initial) {
    const entry = hookStore.get(currentKey) || { hooks: [] }
    hookStore.set(currentKey, entry)
    const i = hookIndex++
    const mark = 'r' + i
    if (!entry[mark]) entry[mark] = { current: initial === undefined ? null : initial }
    return entry[mark]
  },
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
}

function renderElement(el, path) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el === 'string' || typeof el === 'number') return { kind: 'text', text: String(el) }
  if (Array.isArray(el)) return el.map((child, i) => renderElement(child, path + '/' + i))
  const type = el.type
  const props = el.props || {}
  if (type === reactStub.Fragment) return renderElement(props.children, path)
  if (typeof type === 'function') {
    const key = path + ':' + (type.name || 'C') + ':' + (props.key === undefined ? '' : String(props.key))
    const prevKey = currentKey
    const prevIdx = hookIndex
    currentKey = key
    hookIndex = 0
    let out
    try { out = type(props) } finally { currentKey = prevKey; hookIndex = prevIdx }
    return renderElement(out, key)
  }
  return { kind: 'element', type, props, children: renderElement(props.children, path) }
}

function flatten(tree, out = []) {
  if (!tree) return out
  if (Array.isArray(tree)) { for (const t of tree) flatten(t, out); return out }
  out.push(tree)
  if (tree.children) flatten(tree.children, out)
  return out
}
function texts(tree) {
  return flatten(tree).filter((n) => n.kind === 'text').map((n) => n.text)
}
function allText(tree) { return texts(tree).join(' ') }
function byType(tree, type) {
  return flatten(tree).filter((n) => n.kind === 'element' && n.type === type)
}

let rootEl = null
async function flush() {
  for (let i = 0; i < 30; i++) {
    dirty = false
    effectsQueue = []
    const tree = renderElement(rootEl, 'root')
    const queue = effectsQueue
    effectsQueue = []
    for (const fn of queue) fn()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    if (!dirty) return tree
  }
  return renderElement(rootEl, 'root')
}

// ---------- 环境替身 ----------
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', append() {}, remove() {} }),
  head: { append() {} },
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__clientEntry = entry } } }
globalThis.URL.createObjectURL = () => 'blob:fake'
globalThis.URL.revokeObjectURL = () => {}
// <audio> 替身：试听会 new Audio(url).play()，没有它就测不到"试听标签"这条路
globalThis.Audio = class {
  constructor(src) { this.src = src; this.onended = null; this.onerror = null }
  play() { return Promise.resolve() }
  pause() {}
  removeAttribute() {}
  load() {}
}

function baseConfig() {
  return {
    autoSpeak: false, autoSpeakCloudTts: false, language: 'auto', provider: 'p1', model: 'p1-m1',
    transcribe: { enabled: true, maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: 'off', stylePreset: 'standard', contextTurns: 2, timeoutMs: 60000 },
    tts: {
      provider: 'browser',
      browser: { rate: 1, pitch: 1, voice: '' },
      volcengine: { apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitch: 0, pitchLevel: 2, interface: 'bidirection', streaming: true, wsUrl: '', gateway: 'plan', httpUrl: '', emotionGranularity: 'paragraph', bitRate: 64000, loudness: 0, useSectionId: true, expressive: false },
      local: { sid: 48, speed: 1, numThreads: 4, modelDir: '', timeoutMs: 30000, streaming: true, segmentChars: 220, segmentTimeoutMs: 30000 },
    },
    stopOnNewTurn: true,
    chime: { enabled: false, volume: 0.3, work: { enabled: false, source: 'default', file: '' }, done: { enabled: false, source: 'default', file: '' }, ask: { enabled: false, source: 'default', file: '' } },
  }
}
let config = baseConfig()
function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, arrayBuffer: async () => new ArrayBuffer(8) }
}
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.indexOf('/voice/api/getConfig') >= 0) return jsonResponse({ ok: true, config })
  if (target.indexOf('/voice/api/preview') >= 0) {
    // 标签由 Host 给（本地=音色名）；客户端只负责显示，不在前端拼
    return jsonResponse({ ok: true, mode: 'audio', audioUrl: '/voice/audio/preview-1', voiceLabel: '中文男声 · 中（sid 75）' })
  }
  if (target.indexOf('/voice/api/meta') >= 0) {
    return jsonResponse({
      ok: true,
      voices: [{ id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', languages: ['zh', 'en', 'auto', 'yue'] }],
      kokoroVoices: [{ id: 48, name: 'Kokoro 48' }],
      languages: [{ id: 'zh', label: '普通话' }, { id: 'en', label: 'English' }, { id: 'auto', label: '自动' }, { id: 'yue', label: '粤语', dialect: true, dialectId: 'yue' }],
      stylePresets: [{ id: 'standard', name: '标准', prompt: '' }],
      rateStops: ['很慢', '偏慢', '正常', '偏快', '很快'],
    })
  }
  if (target.indexOf('/voice/api/deployStatus') >= 0) return jsonResponse({ ok: true, phase: 'idle', installed: true })
  if (target.indexOf('/voice/api/routeInfo') >= 0) return jsonResponse({ ok: true, providers: [], models: [] })
  if (target.indexOf('/voice/api/setConfig') >= 0) {
    const patch = JSON.parse((init && init.body) || '{}').patch || {}
    Object.assign(config, patch)
    return jsonResponse({ ok: true, config })
  }
  return jsonResponse({ ok: false, error: 'unknown ' + target })
}

// ---------- 加载真 client.js，取设置页组件 ----------
await import(new URL('../packages/dsh-plugin-voice/lib/client.js', import.meta.url))
const client = globalThis.__clientEntry.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error('unexpected dependency ' + id)
})

let settingsComponent = null
const noop = () => {}
client.apply({
  effect: (fn) => { try { fn() } catch { /* 替身：不执行 dispose */ } },
  get: () => undefined,
  slots: {
    inject: (name, cb) => cb(),
    register: (options, component) => { if (options.name === 'settings.section') settingsComponent = component },
  },
  locale: { register: (ns, d) => { globalThis.__dicts = d }, bind: () => (k) => (globalThis.__dicts && globalThis.__dicts.zh && globalThis.__dicts.zh[k]) || k },
  uiConversation: { events: { register: noop } },
})
check('设置页组件拿到（settings.section 注册成功）', typeof settingsComponent === 'function')

// 每档引擎一个独立的包装组件名 → 独立 hook 槽，互不串状态
function CaseBrowser() { return reactStub.createElement(settingsComponent) }
function CaseVolcNoKey() { return reactStub.createElement(settingsComponent) }
function CaseVolcGated() { return reactStub.createElement(settingsComponent) }
function CaseVolcCustom() { return reactStub.createElement(settingsComponent) }
function CaseLocal() { return reactStub.createElement(settingsComponent) }

async function mount(Case, mutate) {
  config = baseConfig()
  if (mutate) mutate(config)
  rootEl = reactStub.createElement(Case)
  return await flush()
}
function engineSelect(tree) {
  return byType(tree, 'select')[0]
}
/** 折起的层体不渲染内容：先按层头标题找到那一层，再点它的折叠按钮展开。 */
function layerNode(tree, title) {
  return flatten(tree).find((n) => n.kind === 'element'
    && String(n.props.className || '').split(/\s+/).includes('dsh-voice-layer')
    && allText(n).includes(title))
}
async function expand(tree, title) {
  const node = layerNode(tree, title)
  if (!node) return tree
  const btn = flatten(node).find((n) => n.kind === 'element' && n.type === 'button' && n.props.className === 'dsh-voice-layer-toggle')
  if (btn && btn.props['aria-expanded'] === false) { btn.props.onClick(); return await flush() }
  return tree
}

// 1) 系统 TTS：不该出现任何本地合成参数；语音名带兜底说明
let tree = await mount(CaseBrowser)
check('系统 TTS：页面渲染完成', allText(tree).includes('语音播报'), allText(tree).slice(0, 60))
check('系统 TTS：没有「高级」层', !allText(tree).includes('高级'), allText(tree).slice(0, 120))
check('系统 TTS：没有合成线程数', !allText(tree).includes('合成线程数'))
tree = await expand(tree, '当前引擎的声音')
check('系统 TTS：展开声音层后仍没有分句流式播报', !allText(tree).includes('分句流式播报'))
check('系统 TTS：展开声音层后仍没有模型目录', !allText(tree).includes('模型目录'))
check('系统 TTS：语音名有"名字对不上就按默认音播"的说明', allText(tree).includes('名字对不上系统里的语音'), allText(tree).slice(0, 200))

// 2) 切到豆包：仍然没有本地参数；缺 Key 且自动播报开着 → 说明会先失败再回退
tree = await mount(CaseVolcNoKey, (c) => {
  c.tts.provider = 'volcengine'
  c.tts.volcengine.apiKey = ''
  c.autoSpeak = true
  c.autoSpeakCloudTts = true
})
check('豆包：没有「高级」层', !allText(tree).includes('高级'))
tree = await expand(tree, '当前引擎的声音')
check('豆包：展开声音层后仍无合成线程数 / 分句流式 / 模型目录',
  !allText(tree).includes('合成线程数') && !allText(tree).includes('分句流式播报') && !allText(tree).includes('模型目录'))
check('豆包缺 Key + 自动播报：状态行说清会先失败再回退浏览器语音',
  allText(tree).includes('自动播报会先失败'), allText(tree).slice(0, 240))
check('豆包：有 apiKey 行（引擎专属字段照常出现）', allText(tree).includes('apiKey'))

// 3) 成本门控（手改配置/迁移旧配置才会落到这个状态）：状态行下面给可操作的原因
tree = await mount(CaseVolcGated, (c) => {
  c.tts.provider = 'volcengine'
  c.tts.volcengine.apiKey = 'k-123'
  c.autoSpeak = true
  c.autoSpeakCloudTts = false
})
check('成本门控：出现"被成本门控关掉了"的告警', allText(tree).includes('被成本门控关掉了'), allText(tree).slice(0, 240))
check('成本门控：告警写了怎么恢复（切走再切回豆包）', allText(tree).includes('切走再切回豆包'))

// 4) 自定义网关没有 wsUrl：说明边说边播失效
tree = await mount(CaseVolcCustom, (c) => {
  c.tts.provider = 'volcengine'
  c.tts.volcengine.apiKey = 'k-123'
  c.tts.volcengine.gateway = 'custom'
  c.tts.volcengine.httpUrl = 'https://relay.example.com/tts'
  c.tts.volcengine.wsUrl = ''
})
tree = await expand(tree, '当前引擎的声音')
check('自定义网关缺 wsUrl：出现"整段合成完再播"的说明', allText(tree).includes('整段合成完再播'), allText(tree).slice(0, 240))

// 4b) 配了 wsUrl 就不该再报（同一包装组件实例，改配置后重新拉一遍）
config.tts.volcengine.wsUrl = 'wss://relay.example.com/tts'
rootEl = reactStub.createElement(function CaseVolcCustomWithWs() { return reactStub.createElement(settingsComponent) })
tree = await flush()
tree = await expand(tree, '当前引擎的声音')
check('自定义网关配了 wsUrl：说明消失（不再误报）', !allText(tree).includes('整段合成完再播'), allText(tree).slice(0, 240))

// 5) 本地引擎：「高级」层回来，三项与层头摘要都在
tree = await mount(CaseLocal, (c) => { c.tts.provider = 'local' })
check('本地：出现「高级」层', allText(tree).includes('高级'))
check('本地：层头摘要带当前值（线程=4）', allText(tree).includes('线程=4'), allText(tree).slice(0, 240))
tree = await expand(tree, '当前引擎的声音')
tree = await expand(tree, '高级')
check('本地：合成线程数 / 分句流式播报 / 模型目录 三项都在',
  allText(tree).includes('合成线程数') && allText(tree).includes('分句流式播报') && allText(tree).includes('模型目录'), allText(tree).slice(0, 300))

// 试听：标签内容由 Host 给（本地=音色名），客户端只负责显示
const previewBtn = byType(tree, 'button').find((n) => texts(n).join('').includes('试听'))
previewBtn.props.onClick()
tree = await flush()
check('试听状态行显示 Host 给的音色名（本地引擎）', allText(tree).includes('中文男声 · 中（sid 75）'), allText(tree).slice(-160))

// 6) 引擎切换走组件自己的 onChange：系统 TTS → 本地，本地参数随之出现
tree = await mount(CaseBrowser)
check('切引擎前：没有本地参数', !allText(tree).includes('合成线程数'))
engineSelect(tree).props.onChange({ target: { value: 'local' } })
tree = await flush()
tree = await expand(tree, '高级')
check('切到本地：合成线程数出现（同一实例按引擎重渲染）', allText(tree).includes('合成线程数'), allText(tree).slice(0, 300))
engineSelect(tree).props.onChange({ target: { value: 'volcengine' } })
tree = await flush()
check('再切回豆包：本地参数又消失', !allText(tree).includes('合成线程数') && !allText(tree).includes('高级'))

const failed = checks.filter((c) => !c.ok)
console.log('\n结果: ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed')
process.exit(failed.length ? 1 : 0)
