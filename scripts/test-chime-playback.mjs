// 提示音播放行为的 headless 验证：假 AudioContext 记录"谁在响、loop 没有、时长多少"，
// 假 uiSession.sessionStatus 驱动状态变化。每个场景用独立的模块实例（import 带 query 绕开缓存），
// 保证 chime 模块内部状态互不串。
import { readFileSync } from 'node:fs'

const cases = []
let failed = 0
function check(name, cond, detail) {
  cases.push({ name, ok: !!cond })
  if (!cond) failed++
  console.log((cond ? '  ok ' : '  FAIL ') + name + (cond || detail === undefined ? '' : ' | ' + JSON.stringify(detail)))
}

// ---------- 每个场景一套替身 ----------
function makeEnv(chime, options) {
  const opts = options || {}
  const env = {
    started: [],          // 每次 src.start()：{ ac, loop, duration, gain }
    stopped: [],          // 每次 src.stop()
    contexts: [],         // 每次 new AudioContext(opts)
    closes: 0,
    listeners: new Map(), // document 事件
    disposers: [],
    sounds: opts.sounds || {},
  }

  class FakeGain {
    constructor() { this.gain = { value: 1 }; this.kind = 'gain' }
    connect() {} disconnect() {}
  }
  let acSeq = 0
  class FakeAudioContext {
    constructor(ctorOpts) {
      this.id = ++acSeq
      this.state = 'running'
      this.sampleRate = 48000
      this.destination = {}
      this.decodeFails = !!opts.decodeFails
      env.contexts.push({ id: this.id, ctorOpts: ctorOpts || null })
    }
    createGain() { return new FakeGain() }
    createBuffer(channels, len, rate) {
      return { duration: len / rate, getChannelData: () => new Float32Array(len) }
    }
    createBufferSource() {
      const ac = this
      const src = {
        buffer: null, loop: false, onended: null, _started: false,
        connect() {}, disconnect() {},
        start() {
          src._started = true
          env.started.push({ ac: ac.id, loop: src.loop, duration: src.buffer ? src.buffer.duration : 0 })
        },
        stop() { env.stopped.push({ ac: ac.id, loop: src.loop }); src._started = false },
      }
      return src
    }
    decodeAudioData(raw, ok, bad) {
      if (this.decodeFails) { if (bad) bad(new Error('undecodable')); return Promise.reject(new Error('undecodable')) }
      const view = new DataView(raw)
      const ms = raw.byteLength >= 4 ? view.getUint32(0, true) : 1000
      const buffer = { duration: ms / 1000, getChannelData: () => new Float32Array(0) }
      if (ok) ok(buffer)
      return Promise.resolve(buffer)
    }
    resume() { return Promise.resolve() }
    close() { env.closes++; return Promise.resolve() }
  }

  env.document = {
    createElement: () => ({ dataset: {}, textContent: '', append() {}, remove() {} }),
    head: { append() {} },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (!env.listeners.has(type)) env.listeners.set(type, []); env.listeners.get(type).push(fn) },
    removeEventListener: (type, fn) => {
      const list = env.listeners.get(type) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }

  function jsonResponse(obj) {
    return { ok: true, status: 200, json: async () => obj, arrayBuffer: async () => new ArrayBuffer(8) }
  }
  function audioResponse(seconds) {
    const buf = new ArrayBuffer(8)
    new DataView(buf).setUint32(0, Math.round(seconds * 1000), true)
    return { ok: true, status: 200, arrayBuffer: async () => buf, json: async () => ({ ok: true }) }
  }
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/getConfig') >= 0) return jsonResponse({ ok: true, config: { chime } })
    if (target.indexOf('/voice/api/') >= 0) return jsonResponse({ ok: true })
    if (target.indexOf('/voice/sounds/') >= 0) {
      const file = decodeURIComponent(target.split('/voice/sounds/')[1] || '')
      if (env.sounds[file] === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ ok: false }) }
      return audioResponse(env.sounds[file])
    }
    return jsonResponse({ ok: true })
  }

  env.snapshot = new Map()
  env.rows = {}
  env.statusListeners = new Set()
  env.uiSession = {
    sessionStatus: {
      getSnapshot: () => env.snapshot,
      subscribe: (fn) => { env.statusListeners.add(fn); return () => env.statusListeners.delete(fn) },
    },
  }
  env.sessions = { list: { getSnapshot: () => ({ phase: 'ready', ids: Object.keys(env.rows), byId: env.rows }) } }
  env.remoteListeners = new Map()
  env.remote = {
    $on: (ev, fn) => {
      const set = env.remoteListeners.get(ev) || new Set()
      set.add(fn)
      env.remoteListeners.set(ev, set)
      return () => set.delete(fn)
    },
  }
  env.emitRemote = (ev, ...args) => {
    for (const fn of (env.remoteListeners.get(ev) || [])) fn(...args)
  }
  env.setStatus = (id, status) => { env.snapshot.set(id, status); for (const fn of env.statusListeners) fn() }
  env.setRow = (id, row) => { env.rows[id] = row }
  env.dispatch = (type) => { for (const fn of (env.listeners.get(type) || []).slice()) fn({ type }) }
  env.AudioContext = FakeAudioContext
  return env
}

/** 起一个新模块实例（绕过 import 缓存），apply 到给定环境。 */
let seq = 0
async function boot(env) {
  globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__entry = entry } }, AudioContext: env.AudioContext }
  globalThis.document = env.document
  globalThis.fetch = env.fetch
  globalThis.speechSynthesis = { cancel() {}, speak() {} }
  const url = new URL('../packages/voice-for-dsh/lib/client.js', import.meta.url).href + '?case=' + (++seq)
  await import(url)
  const entry = globalThis.__entry
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState: (v) => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: (f) => f(), useCallback: (f) => f,
  }
  const client = entry.factory((id) => { if (id === 'react') return reactStub; throw new Error('dep ' + id) })
  const ctx = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') env.disposers.push(d) },
    get: (name) => (name === 'uiSession' ? env.uiSession : name === 'sessions' ? env.sessions : name === 'remote' ? env.remote : undefined),
    slots: { inject: () => {}, register: () => {} },
    locale: undefined,
    uiConversation: { events: { register: () => {} } },
  }
  client.apply(ctx)
  await settle(6)
  return client
}

async function settle(n) {
  for (let i = 0; i < (n || 3); i++) await new Promise((r) => setTimeout(r, 0))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const baseChime = (over) => Object.assign({
  enabled: true, volume: 0.3,
  work: { enabled: true, source: 'default', file: '' },
  done: { enabled: true, source: 'default', file: '' },
  ask: { enabled: true, source: 'default', file: '' },
}, over || {})

const workStarts = (env) => env.started.filter((s) => s.loop)
const startsByDuration = (env, d) => env.started.filter((s) => Math.abs(s.duration - d) < 0.05)

// ============ 场景 1：两个顶层会话同时跑 / 只响一份工作音；结束+提问两种音都响 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setRow('s2', { id: 's2', origin: 'session' })
  env.setStatus('s1', { running: true })
  env.setStatus('s2', { running: true })
  await settle()
  check('两个会话同时跑：只起一份工作音', env.started.length === 1, env.started)
  check('工作音用 loop 播放（默认音 2.4 秒）', env.started[0] && env.started[0].loop === true && env.started[0].duration > 2, env.started[0])

  env.setStatus('s1', { running: false })
  await settle()
  const doneStarts = startsByDuration(env, 0.7)
  check('一个会话结束：响一次完成音', doneStarts.length === 1, env.started)
  check('另一个还在跑：工作音没被停（也不重起）', env.started.filter((s) => s.loop).length === 1 && env.stopped.filter((s) => s.loop).length === 0, env.stopped)

  env.setStatus('s1', { running: false, pendingInteraction: { kind: 'question', key: 'q1', sessionId: 's1' } })
  await settle()
  check('同时有提问：提问音也响（不互相吞掉）', startsByDuration(env, 0.62).length === 1, env.started)
  check('提示音都起在同一个独立上下文里', env.started.every((s) => s.ac === env.started[0].ac), env.started)
  check('提示音上下文没有按 24kHz 参数创建（与播报链分开）', env.contexts.every((c) => c.ctorOpts === null), env.contexts)
}

// ============ 场景 2：审批（approval）不触发提问音 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'approval', key: 'a1', sessionId: 's1' } })
  await settle()
  check('审批弹窗（kind=approval）不响提问音', env.started.filter((s) => Math.abs(s.duration - 0.62) < 0.05).length === 0, env.started)
}

// ============ 场景 3：子代理也算"有活在跑"（工作音响），但不触发完成音 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setRow('sub1', { id: 'sub1', origin: 'subagent', parentId: 's1' })
  env.setStatus('sub1', { running: true })
  await settle()
  check('只有子代理在跑：工作音也响（子代理也算有活在跑）', workStarts(env).length === 1, env.started)
  env.setStatus('sub1', { running: false })
  await settle()
  check('子代理结束：不响完成音', startsByDuration(env, 0.7).length === 0, env.started)
  await sleep(900) // 工作音停止有 800ms 去抖
  check('子代理结束后没有活：工作音停', env.stopped.filter((s) => s.loop).length >= 1, env.stopped)
  const before = workStarts(env).length
  env.setStatus('s1', { running: true })
  await settle()
  check('顶层会话在跑：工作音重新起来（只一条）', workStarts(env).length === before + 1, env.started)
}

// ============ 场景 4：提问音按 interaction key 去重，消失后清 key ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'question', key: 'q1', sessionId: 's1' } })
  await settle()
  const ask = () => env.started.filter((s) => Math.abs(s.duration - 0.62) < 0.05).length
  check('同一交互第一次：响一次', ask() === 1, env.started)
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'question', key: 'q1', sessionId: 's1' } })
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'question', key: 'q1', sessionId: 's1' } })
  await settle()
  check('同一交互重复上报：不重复响', ask() === 1, env.started)
  env.setStatus('s1', { running: true })
  await settle()
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'question', key: 'q1', sessionId: 's1' } })
  await settle()
  check('交互消失后清 key：同一个 key 再出现会再响', ask() === 2, env.started)
  env.setStatus('s1', { running: true, pendingInteraction: { kind: 'plan-review', key: 'p1', sessionId: 's1' } })
  await settle()
  check('plan-review 也算提问（响）', ask() === 3, env.started)
}

// ============ 场景 5：完成音 1 秒抑制窗 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setRow('s2', { id: 's2', origin: 'session' })
  env.setStatus('s1', { running: true })
  env.setStatus('s2', { running: true })
  await settle()
  env.setStatus('s1', { running: false })
  env.setStatus('s2', { running: false })
  await settle()
  check('两条会话几乎同时结束：完成音只响一次', env.started.filter((s) => Math.abs(s.duration - 0.7) < 0.05).length === 1, env.started)
  await sleep(900) // 工作音停止有 800ms 去抖
  check('两个都结束后：工作音停掉', env.stopped.filter((s) => s.loop).length === 1, env.stopped)
}

// ============ 场景 6：工作音素材 <2 秒 → 不 loop，改每 2 秒一次 ============
{
  const env = makeEnv(baseChime({ work: { enabled: true, source: 'custom', file: 'short.wav' } }), { sounds: { 'short.wav': 1.2 } })
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle(8)
  check('短素材：第一声不是 loop', env.started.length === 1 && env.started[0].loop === false, env.started)
  check('短素材：按时长读出来（1.2 秒）', Math.abs(env.started[0].duration - 1.2) < 0.05, env.started[0])
  await sleep(2100)
  check('短素材：2 秒后自动再响一次', env.started.length >= 2, env.started.length)
  env.setStatus('s1', { running: false })
  await settle()
  const after = env.started.length
  await sleep(1100)
  check('会话结束后短素材不再响', env.started.length === after, env.started.length - after)
}

// ============ 场景 7：工作音素材 >=2 秒 → loop 单条 ============
{
  const env = makeEnv(baseChime({ work: { enabled: true, source: 'custom', file: 'long.wav' } }), { sounds: { 'long.wav': 5 } })
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle(8)
  check('长素材：loop=true 且只起一条', env.started.length === 1 && env.started[0].loop === true, env.started)
  await sleep(2100)
  check('长素材：2 秒后不重复起新实例', env.started.length === 1, env.started.length)
}

// ============ 场景 8：配置里的文件不存在 → 回落默认音 ============
{
  const env = makeEnv(baseChime({ work: { enabled: true, source: 'custom', file: 'gone.wav' } }), { sounds: {} })
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle(8)
  check('文件读不到（404）：回落默认工作音并继续 loop', env.started.length === 1 && env.started[0].loop === true && Math.abs(env.started[0].duration - 2.4) < 0.1, env.started)
}

// ============ 场景 9：首次 pointerdown 预热（关着时不建提示音上下文） ============
{
  const env = makeEnv(baseChime({ enabled: false }))
  await boot(env)
  const chimeCtxCount = () => env.contexts.filter((c) => c.ctorOpts === null).length
  check('总开关关着：不建提示音上下文', chimeCtxCount() === 0, env.contexts)
  env.dispatch('pointerdown')
  await settle()
  check('首次 pointerdown：预热建出提示音上下文（不指定采样率）', chimeCtxCount() === 1, env.contexts)
  const total = env.contexts.length
  env.dispatch('keydown')
  await settle()
  check('预热是一次性的（keydown 不重复建）', env.contexts.length === total, env.contexts)
}

// ============ 场景 10：dispose 停机（音频上下文关掉、实例停止） ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle()
  check('dispose 前：工作音在响', env.started.length === 1)
  for (const d of env.disposers) { try { d() } catch (e) {} }
  await settle()
  check('dispose：提示音上下文关闭', env.closes >= 1, env.closes)
  check('dispose：正在响的实例被停掉', env.stopped.length >= 1, env.stopped)
}

// ============ 场景 11：停止播报不影响提示音（独立上下文 + 独立实例表） ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle()
  const before = env.stopped.length
  // stopPlaybackOnly 的动作：cancel 系统语音 + 停 <audio>；这里直接调系统语音取消
  globalThis.speechSynthesis.cancel()
  await settle()
  check('停播报（cancel 系统语音）后：工作音没被停', env.stopped.length === before, { before, after: env.stopped.length })
  check('提示音只在它自己的上下文里（没混进播报的 24k 上下文）', env.contexts.every((c) => c.ctorOpts === null), env.contexts)
}

// ============ 场景 12：别的工作区有会话在跑（不在 sessionStatus 里）也要响 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  // 当前工作区没有任何会话；另一个工作区的会话通过全局 api-session/status 进来
  env.emitRemote('api-session/status', 'other-ws-1', true)
  await settle()
  check('别的项目有会话在跑：工作音也要响', env.started.filter((s) => s.loop).length === 1, env.started)
  check('别的工作区的会话不在当前列表里也算数', Object.keys(env.rows).length === 0)

  globalThis.fetch = env.fetch
  const doneBefore = startsByDuration(env, 0.7).length
  env.emitRemote('api-session/status', 'other-ws-1', false)
  await settle()
  // 只有 id、没有列表行 → 判不出是顶层还是子代理。宁可漏一声，不误响：
  // 别的工作区的顶层会话结束，靠 Host 账本的 top 列表补（见场景 13b）。
  check('层级未知的会话结束：不响完成音（判不出层级宁可不响）', startsByDuration(env, 0.7).length === doneBefore, env.started)
  await sleep(900)
  check('都停了以后：工作音停掉', env.stopped.filter((s) => s.loop).length >= 1, env.stopped)
}

// ============ 场景 13b：别的工作区的顶层会话结束——Host 账本的 top 说了算 ============
{
  const env = makeEnv(baseChime())
  const baseFetch = env.fetch
  let phase = 1
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      const body = phase === 1
        ? { ok: true, running: ['other-ws-9'], top: ['other-ws-9'], count: 1, topCount: 1, lastEndedAt: 0, epoch: 'e1' }
        : { ok: true, running: [], top: [], count: 0, topCount: 0, lastEndedAt: 999, epoch: 'e1' }
      return { ok: true, status: 200, json: async () => body }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  await boot(env)
  await sleep(300)
  check('账本 top 里有别的工作区的会话：工作音起', env.started.filter((s) => s.loop).length === 1, env.started)
  phase = 2
  await sleep(2400)
  check('账本 top 掉了别的工作区的会话：响一次完成音', startsByDuration(env, 0.7).length === 1, env.started)
}

// ============ 场景 13：Host 账本里有会话在跑（已开跑、之后没有状态变化）也要响 ============
{
  const env = makeEnv(baseChime())
  const baseFetch = env.fetch
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, running: ['host-1'], top: ['host-1'], count: 1, topCount: 1, lastEndedAt: 0, epoch: 'e0' }) }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  await boot(env)
  await settle()
  check('Host 账本说有会话在跑：工作音起（补上已开跑的情况）', env.started.filter((s) => s.loop).length === 1, env.started)

  // 账本掉到 0 → 完成音 + 工作音停
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, running: [], top: [], count: 0, topCount: 0, lastEndedAt: 123456, epoch: 'e0' }) }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  const doneBefore = startsByDuration(env, 0.7).length
  env.emitRemote('api-session/status', 'probe-wake', true)
  env.emitRemote('api-session/status', 'probe-wake', false)
  await sleep(3400)
  check('Host 账本报结束：响一次完成音', startsByDuration(env, 0.7).length >= doneBefore + 1, env.started)
  check('账本归零后工作音停下', env.stopped.filter((s) => s.loop).length >= 1, env.stopped)
}

// ============ 场景 13c：Host 重载（epoch 变了、账本归零）不补响完成音 ============
{
  const env = makeEnv(baseChime())
  const baseFetch = env.fetch
  let epoch = 'e1'
  let run = ['host-1']
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, running: run, top: run, count: run.length, topCount: run.length, lastEndedAt: 0, epoch }),
      }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  await boot(env)
  await sleep(300)
  check('重载前：账本说在跑，工作音起', env.started.filter((s) => s.loop).length === 1, env.started)
  // 模拟 Host 重载：插件实例换了（epoch 变），账本从零开始
  epoch = 'e2'
  run = []
  await sleep(2400)
  check('Host 重载导致账本归零：不响完成音（epoch 变了只重建基线）', startsByDuration(env, 0.7).length === 0, env.started)
  check('Host 重载后工作音收尾', env.stopped.filter((s) => s.loop).length >= 1, env.stopped)
}

// ============ 场景 14：刷新/重开不凭空响完成音（账本基线只记不响） ============
{
  const env = makeEnv(baseChime())
  const baseFetch = env.fetch
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      // 这个 Host 进程里以前结束过 turn，但当前没有任何会话在跑
      return { ok: true, status: 200, json: async () => ({ ok: true, running: [], count: 0, lastEndedAt: 987654321 }) }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  await boot(env)
  await sleep(2200)
  check('刷新后首轮只建基线：不凭空响完成音', startsByDuration(env, 0.7).length === 0, env.started)
  check('刷新后没有会话在跑：不起工作音', env.started.filter((s) => s.loop).length === 0, env.started)
}

// ============ 场景 15：一次结束只响一次（观察 3 秒，覆盖三路信号重复触发） ============
{
  const env = makeEnv(baseChime())
  const baseFetch = env.fetch
  let ledgerCount = 1
  env.fetch = async (url) => {
    const target = String(url)
    if (target.indexOf('/voice/api/chimeStatus') >= 0) {
      return { ok: true, status: 200, json: async () => ({ ok: true, running: [], count: ledgerCount, lastEndedAt: 555 }) }
    }
    return baseFetch(url)
  }
  globalThis.fetch = env.fetch
  await boot(env)
  await settle()
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setStatus('s1', { running: true })
  await settle()
  ledgerCount = 0
  env.setStatus('s1', { running: false })
  await sleep(3200)
  const doneCount = startsByDuration(env, 0.7).length
  check('一次结束：3 秒内只响一声完成音（快照 + 账本不重复）', doneCount === 1, { doneCount })
}

// ============ 场景 16：子代理（remote 那一路）也响工作音，但不响完成音 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('sub-a', { id: 'sub-a', origin: 'subagent' })
  env.emitRemote('api-session/status', 'sub-a', true)
  await settle()
  check('子代理开跑：工作音照响', env.started.filter((s) => s.loop).length === 1, env.started)
  env.emitRemote('api-session/status', 'sub-a', false)
  await settle()
  check('子代理结束：不响完成音', startsByDuration(env, 0.7).length === 0, env.started)
}

// ============ 场景 17：主会话与子代理同时在跑——完成音只在主会话结束时响一次 ============
{
  const env = makeEnv(baseChime())
  await boot(env)
  env.setRow('s1', { id: 's1', origin: 'session' })
  env.setRow('sub2', { id: 'sub2', origin: 'subagent', parentId: 's1' })
  env.setStatus('s1', { running: true })
  env.setStatus('sub2', { running: true })
  await settle()
  check('主会话 + 子代理：只起一份工作音', workStarts(env).length === 1, env.started)

  env.setStatus('s1', { running: false })   // 主会话这一轮跑完，子代理还在跑
  await settle()
  check('主会话结束：响一次完成音', startsByDuration(env, 0.7).length === 1, env.started)
  check('子代理还在跑：工作音不停', env.stopped.filter((s) => s.loop).length === 0, env.stopped)

  env.setStatus('sub2', { running: false }) // 子代理收尾
  await settle()
  check('子代理结束：不再补第二声完成音', startsByDuration(env, 0.7).length === 1, env.started)
  await sleep(900) // 工作音停止有 800ms 去抖
  check('全停了：工作音停掉', env.stopped.filter((s) => s.loop).length === 1, env.stopped)
}

console.log('\n结果: ' + (cases.length - failed) + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
