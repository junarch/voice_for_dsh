// 提示音设置层（第五层）的 headless 渲染验证：不启浏览器，用一个极小的 React 替身
// （createElement + useState/useEffect/useRef + 一次渲染 = 一次函数调用）把真组件渲染成树，
// 再对树做断言。验证的是真 client.js，不是复制品。
import { readFileSync } from 'node:fs'

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
let scheduled = false

function schedule() { dirty = true; scheduled = true }

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
function byClass(tree, cls) {
  return flatten(tree).filter((n) => n.kind === 'element' && String(n.props.className || '').split(/\s+/).includes(cls))
}
function byAria(tree, label) {
  return flatten(tree).filter((n) => n.kind === 'element' && n.props['aria-label'] === label)
}
function byType(tree, type) {
  return flatten(tree).filter((n) => n.kind === 'element' && n.type === type)
}
function inSubtree(node, pred) {
  return flatten(node).filter(pred)
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
/** 上传是"读时长 → 解码 → POST"的异步链：多跑几圈，等状态落定。 */
async function flushDeep() {
  let tree = null
  for (let i = 0; i < 10; i++) {
    tree = await flush()
    await new Promise((r) => setTimeout(r, 2))
  }
  return tree
}

// ---------- 环境替身 ----------
const styleTags = []
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', append() {}, remove() {} }),
  head: { append: (tag) => styleTags.push(tag) },
  addEventListener() {}, removeEventListener() {},
}

// <audio> 元数据替身：控制"读到的时长"与"读不到"
let audioMetaDuration = 1.0
let audioMetaFails = false
globalThis.Audio = class {
  constructor() { this._src = ''; this.duration = NaN; this.onloadedmetadata = null; this.onerror = null }
  set src(value) {
    this._src = value
    setTimeout(() => {
      if (audioMetaFails) { if (this.onerror) this.onerror() }
      else { this.duration = audioMetaDuration; if (this.onloadedmetadata) this.onloadedmetadata() }
    }, 0)
  }
  get src() { return this._src }
  removeAttribute() {}
  load() {}
}
let blobSeq = 0
globalThis.URL.createObjectURL = () => 'blob:fake-' + (++blobSeq)
globalThis.URL.revokeObjectURL = () => {}

class FakeGain {
  constructor() { this.gain = { value: 1 } }
  connect() {} disconnect() {}
}
class FakeSource {
  constructor() { this.buffer = null; this.loop = false; this.onended = null }
  connect() {} disconnect() {}
  start() {} stop() {}
}
let decodeShouldFail = false
class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.sampleRate = 48000
    this.destination = {}
  }
  createGain() { return new FakeGain() }
  createBuffer(ch, len, rate) { return { duration: len / rate, getChannelData: () => new Float32Array(len) } }
  createBufferSource() { return new FakeSource() }
  decodeAudioData(raw, ok, bad) {
    if (decodeShouldFail) { bad(new Error('undecodable')); return Promise.reject(new Error('undecodable')) }
    ok({ duration: 1.0 })
    return Promise.resolve({ duration: 1.0 })
  }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

globalThis.window = {
  __ModuleLoader__: { load: (entry) => { globalThis.__clientEntry = entry } },
  AudioContext: FakeAudioContext,
}

// 配置：提示音默认关闭（= 验收第 1 条的前提）
const config = {
  autoSpeak: false, autoSpeakCloudTts: false, language: 'auto', provider: 'p1', model: 'p1-m1',
  transcribe: { enabled: true, maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: 'off', stylePreset: 'standard', contextTurns: 2, timeoutMs: 60000 },
  tts: { provider: 'browser', browser: { rate: 1, pitch: 1, voice: '' }, volcengine: { apiKey: '', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000, rateLevel: 2, pitch: 0, pitchLevel: 2, interface: 'bidirection', streaming: true, wsUrl: '', gateway: 'plan', httpUrl: '', emotionGranularity: 'paragraph', bitRate: 64000, loudness: 0, useSectionId: true, expressive: false }, local: { sid: 48, speed: 1, numThreads: 4, modelDir: '', timeoutMs: 30000, streaming: true, segmentChars: 220, segmentTimeoutMs: 30000 } },
  stopOnNewTurn: true,
  chime: { enabled: false, volume: 0.3, work: { enabled: false, source: 'default', file: '' }, done: { enabled: false, source: 'default', file: '' }, ask: { enabled: false, source: 'default', file: '' } },
}
let lastUpload = null
const missingFiles = new Set()
function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, arrayBuffer: async () => new ArrayBuffer(8) }
}
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.indexOf('/voice/api/getConfig') >= 0) return jsonResponse({ ok: true, config })
  if (target.indexOf('/voice/api/meta') >= 0) return jsonResponse({ ok: true, voices: [], languages: [], stylePresets: [], kokoroVoices: [], rateStops: [] })
  if (target.indexOf('/voice/api/deployStatus') >= 0) return jsonResponse({ ok: true, phase: 'idle', installed: false })
  if (target.indexOf('/voice/api/routeInfo') >= 0) return jsonResponse({ ok: true, providers: [], models: [] })
  if (target.indexOf('/voice/api/setConfig') >= 0) {
    const patch = JSON.parse(init.body || '{}').patch || {}
    Object.assign(config, patch)
    return jsonResponse({ ok: true, config })
  }
  if (target.indexOf('/voice/sounds?') >= 0) {
    const params = new URLSearchParams(target.split('?')[1] || '')
    const kind = params.get('kind')
    const name = params.get('name')
    lastUpload = { kind, name, size: init.body && init.body.size }
    return jsonResponse({ ok: true, file: kind + '-11111111-2222-3333-4444-555555555555.wav', ext: 'wav', bytes: 12 })
  }
  if (target.indexOf('/voice/sounds/') >= 0) {
    const file = decodeURIComponent(target.split('/voice/sounds/')[1] || '')
    if (missingFiles.has(file)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ ok: false }) }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({ ok: true }) }
  }
  return jsonResponse({ ok: false, error: 'unknown ' + target })
}

// ---------- 加载真 client.js，取设置页组件 ----------
await import(new URL('../packages/voice-for-dsh/lib/client.js', import.meta.url))
const client = globalThis.__clientEntry.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error('unexpected dependency ' + id)
})

let dicts = null
let settingsComponent = null
const noop = () => {}
client.apply({
  effect: (fn) => { try { fn() } catch (e) { /* 替身：dispose 回调不执行 */ } },
  get: (name) => (name === 'uiSession' ? undefined : name === 'sessions' ? undefined : undefined),
  slots: {
    inject: (name, cb) => cb(),
    register: (options, component) => { if (options.name === 'settings.section') settingsComponent = component },
  },
  locale: { register: (ns, d) => { dicts = d }, bind: () => (k) => (dicts && dicts.zh && dicts.zh[k]) || k },
  uiConversation: { events: { register: noop } },
})
check('设置页组件拿到（settings.section 注册成功）', typeof settingsComponent === 'function')

rootEl = reactStub.createElement(settingsComponent)
let tree = await flush()
// 组件里的 <h2> 是标题，先确认渲染出来了（不是加载中）
check('设置页渲染完成（不是"…"占位）', allText(tree).includes('语音播报'), allText(tree).slice(0, 80))

// 1) 默认关闭：第五层层头在，层体（三行与音量）不在
const l5Layer = byClass(tree, 'dsh-voice-layer').find((n) => allText(n).includes('提示音'))
check('第五层「提示音」层头出现', !!l5Layer)
check('默认关闭：三行提示音不渲染', byClass(tree, 'dsh-voice-chime-row').length === 0)
check('默认关闭：总音量滑块不渲染', inSubtree(l5Layer, (n) => n.kind === 'element' && n.type === 'input' && n.props.type === 'range').length === 0)
check('默认关闭：层头摘要为「关」', allText(l5Layer).includes('关'), allText(l5Layer))

// 2) 层头总开关可用：打开 + 展开层体 → 音量 + 三行出现
const master = byAria(tree, '开启提示音')[0]
check('层头有总开关（aria-label=开启提示音）', !!master)
master.props.onChange({ target: { checked: true } })
tree = await flush()
function l5ToggleOf(t) {
  const layer = byClass(t, 'dsh-voice-layer').find((n) => allText(n).includes('提示音'))
  return inSubtree(layer, (n) => n.kind === 'element' && n.type === 'button' && n.props.className === 'dsh-voice-layer-toggle')[0]
}
check('层头折叠按钮默认收起（aria-expanded=false）', l5ToggleOf(tree).props['aria-expanded'] === false)
l5ToggleOf(tree).props.onClick()
tree = await flush()
check('打开总开关并展开：三行出现且各自独立', byClass(tree, 'dsh-voice-chime-row').length === 3)
check('打开总开关并展开：三行标签都在', ['工作音', '完成音', '提问音'].every((n) => allText(tree).includes(n)))
const volSlider = byType(tree, 'input').filter((n) => n.props.type === 'range' && n.props.max === 1)
check('打开总开关并展开：总音量滑块出现（0–1）', volSlider.length === 1, volSlider.length)

// 3) 三行各自独立：把「工作音」与「完成音」都开成自定义
const rows = () => byClass(tree, 'dsh-voice-chime-row')
const rowOf = (kind) => rows().find((n) => n.props['data-chime-kind'] === kind)
function rowCheckbox(kind) { return byAria(tree, '开关' + ({ work: '工作音', done: '完成音', ask: '提问音' })[kind])[0] }

rowCheckbox('work').props.onChange({ target: { checked: true } })
tree = await flush()
rowCheckbox('done').props.onChange({ target: { checked: true } })
tree = await flush()
check('开「工作音」「完成音」后两行都有音源下拉', !!inSubtree(rowOf('work'), (n) => n.type === 'select').length && !!inSubtree(rowOf('done'), (n) => n.type === 'select').length)
check('没开的「提问音」没有音源下拉', inSubtree(rowOf('ask'), (n) => n.type === 'select').length === 0)
check('默认音源时也有上传按钮与隐藏 file input（不必先切自定义）',
  inSubtree(rowOf('work'), (n) => n.type === 'button' && texts(n).includes('上传')).length === 1
  && inSubtree(rowOf('work'), (n) => n.type === 'input' && n.props.type === 'file').length === 1)

// 切到自定义 → 上传按钮 + 隐藏 file input 出现
inSubtree(rowOf('work'), (n) => n.type === 'select')[0].props.onChange({ target: { value: 'custom' } })
tree = await flush()
const fileInputs = () => inSubtree(rowOf('work'), (n) => n.type === 'input' && n.props.type === 'file')
check('自定义音源：出现隐藏的 input[type=file]', fileInputs().length === 1 && fileInputs()[0].props.style.display === 'none')
check('自定义音源：出现上传按钮', inSubtree(rowOf('work'), (n) => n.type === 'button' && texts(n).includes('上传')).length === 1)
check('没上传时提示"还没上传文件"', inSubtree(rowOf('work'), (n) => texts(n).some((s) => s.includes('还没上传文件'))).length >= 1)

// 3b) 前端上传体检：>60 秒拒、解不了拒、通过才 POST
function fakeFile(name, size) {
  return { name, size, arrayBuffer: async () => new ArrayBuffer(8) }
}
const workFileInput = () => inSubtree(rowOf('work'), (n) => n.type === 'input' && n.props.type === 'file')[0]

audioMetaDuration = 90
lastUpload = null
workFileInput().props.onChange({ target: { files: [fakeFile('long.mp3', 1024)], value: '' } })
tree = await flushDeep()
check('上传 >60 秒：本地直接拒（不发 POST）', lastUpload === null, lastUpload)
check('上传 >60 秒：提示写清秒数', allText(rowOf('work')).includes('超过 60 秒'), allText(rowOf('work')))

audioMetaDuration = 1
decodeShouldFail = true
lastUpload = null
workFileInput().props.onChange({ target: { files: [fakeFile('weird.xyz', 1024)], value: '' } })
tree = await flushDeep()
check('decodeAudioData 解不了：本地拒（不发 POST）', lastUpload === null, lastUpload)
check('解不了：提示"这个格式浏览器解不了"', allText(rowOf('work')).includes('这个格式浏览器解不了'), allText(rowOf('work')))

decodeShouldFail = false
audioMetaDuration = 1
lastUpload = null
workFileInput().props.onChange({ target: { files: [fakeFile('工作音.wav', 2048)], value: '' } })
tree = await flushDeep()
check('通过体检：POST /voice/sounds?kind=work&name=…', !!lastUpload && lastUpload.kind === 'work' && decodeURIComponent(lastUpload.name) === '工作音.wav', lastUpload)
check('上传成功：行内回显落盘文件名', allText(rowOf('work')).includes('work-11111111-2222-3333-4444-555555555555.wav'), allText(rowOf('work')))
check('上传成功：提示"已上传"', allText(rowOf('work')).includes('已上传'), allText(rowOf('work')))

const oversizeUpload = { name: 'big.wav', size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(8) }
lastUpload = null
workFileInput().props.onChange({ target: { files: [oversizeUpload], value: '' } })
tree = await flushDeep()
check('上传 >10MB：本地直接拒（不发 POST）', lastUpload === null, lastUpload)
check('上传 >10MB：提示换个小文件', allText(rowOf('work')).includes('超过 10MB'), allText(rowOf('work')))

// 3b) 内置音三种变体：下拉里 3 个名字 + 自定义；不再出现"程序合成"这类实现词
{
  const sel = inSubtree(rowOf('work'), (n) => n.type === 'select')[0]
  const opts = flatten(sel).filter((n) => n.kind === 'element' && n.type === 'option').map((n) => texts(n).join(''))
  check('提示音：工作音有 5 个内置变体 + 自定义', opts.length === 6 && opts[5] === '自定义（上传音频）', opts)
  check('提示音：变体有名字（工作音=雨滴/滴答/仪表盘）',
    opts[0] === '雨滴' && opts[1] === '滴答' && opts[2] === '仪表盘', opts)
  check('提示音：界面不再出现「程序合成」字样', !allText(tree).includes('程序合成'))
}


// 4) 关掉「工作音」这一行 → 它的音源与上传都不渲染，另一行不受影响
rowCheckbox('work').props.onChange({ target: { checked: false } })
tree = await flush()
check('关「工作音」：该行音源下拉不渲染', inSubtree(rowOf('work'), (n) => n.type === 'select').length === 0)
check('关「工作音」：该行 file input 不渲染', inSubtree(rowOf('work'), (n) => n.type === 'input' && n.props.type === 'file').length === 0)
check('关「工作音」：该行上传按钮不渲染', inSubtree(rowOf('work'), (n) => n.type === 'button' && texts(n).includes('上传')).length === 0)
check('关「工作音」：另一行（完成音）音源仍渲染', inSubtree(rowOf('done'), (n) => n.type === 'select').length === 1)
check('关「工作音」：该行开关本身还在', !!rowCheckbox('work'))

// 5) 层头折叠按钮：aria-expanded 反映展开状态（收起后层体消失）
const l5Toggle = inSubtree(byClass(tree, 'dsh-voice-layer').find((n) => allText(n).includes('提示音')), (n) => n.kind === 'element' && n.type === 'button' && n.props.className === 'dsh-voice-layer-toggle')[0]
check('层头折叠按钮 aria-expanded=true（已展开）', l5Toggle && l5Toggle.props['aria-expanded'] === true)
l5Toggle.props.onClick()
tree = await flush()
check('点层头折叠：层体消失（三行不渲染）', byClass(tree, 'dsh-voice-chime-row').length === 0)

// 6) 配置里的文件不存在：设置页给"已回落到默认音"的提示（新组件实例 → 重新拉配置）
// 自动保存是防抖的：先让上一段改动写完，否则排队中的 patch 会把这里换上的新配置盖掉
await new Promise((resolve) => setTimeout(resolve, 600))
config.chime = {
  enabled: true, volume: 0.3,
  work: { enabled: true, source: 'custom', file: 'gone.wav' },
  done: { enabled: false, source: 'default', file: '' },
  ask: { enabled: false, source: 'default', file: '' },
}
missingFiles.add('gone.wav')
const MissingCase = function ChimeMissingCase() { return reactStub.createElement(settingsComponent) }
rootEl = reactStub.createElement(MissingCase)
tree = await flushDeep()
l5ToggleOf(tree).props.onClick()
tree = await flushDeep()
check('配置里的文件读不到：展开后提示已回落到默认音', allText(tree).includes('已回落到默认音'), allText(tree).slice(0, 400))
check('配置里的文件读不到：三行仍渲染（不因此崩）', byClass(tree, 'dsh-voice-chime-row').length === 3)

const failed = checks.filter((c) => !c.ok)
console.log('\n结果: ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed')
process.exit(failed.length ? 1 : 0)
