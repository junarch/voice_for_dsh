#!/usr/bin/env node
/**
 * DeepSeek 官方 TTS 真实外呼探针（整段 POST + WS 流式各跑一遍）。
 *
 * 用 mock 的 ctx（settings/sessions/llm/webServer）装配真实 lib/index.js：
 * mock LLM 出转写稿（零转写费），TTS 打真实 DeepSeek 端点。验证：
 *   1. POST 整段：端点/鉴权/voice_id/PCM→WAV（两音色各一条）
 *   2. WS 流式：连接/喂段/音频帧/finish（stella 一条，报告首声延迟与段数）
 *   3. 英文样句一条（POST；DeepSeek 语种自动识别）
 *
 * 花费：样句都很短（≤0.1 元，限时 5 折内更低）。Key 从 env DEEPSEEK_API_KEY 读，
 * 绝不落仓库。失败退出码 1。运行：node scripts/tts-deepseek-probe.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!KEY) {
  console.error('未找到 DEEPSEEK_API_KEY（env）——探针需要一把 DeepSeek 开放平台 API Key，不落仓库')
  process.exit(1)
}

const home = mkdtempSync(path.join(tmpdir(), 'voice-ds-probe-'))
process.env.DSH_HOME = home

const { apply, Config } = await import('../packages/voice-for-dsh/lib/index.js')

// ---- mock 基础设施（与 test-host.mjs 同一套装配路径：真 schema → volatile 引用 → apply） ----
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    target[k] = v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])
      ? deepMerge(target[k], v) : v
  }
  return target
}
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error('invalid voice config: ' + JSON.stringify(result.issues))
  return result.value
}
const settingsState = { raw: null }
const settings = {
  update: async (_ns, patch) => {
    settingsState.raw = deepMerge(settingsState.raw, patch)
    const next = resolveConfig(settingsState.raw)
    // 与 loader._commitVolatile 一致：**只**把候选快照提交进插件正握着的那些引用，
    // 引用本身不换代（换成本次解析出的新树就等于写进没人看的对象——第二次 setConfig 起就不生效了，
    // 探针会误判"WS 流式没走"，实际插件读到的还是上一次的值）。
    for (const { path, ref } of collectRefs(liveConfig)) {
      const source = path.reduce((v, k) => Reflect.get(v, k), next)
      ref[VOLATILE_WRITE](source.get())
    }
  },
}
function collectRefs(value, path = []) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) return [{ path, ref: value }]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => collectRefs(v, [...path, k]))
}

const sessions = {
  get: () => ({
    header: { id: 'live-ds' },
    snapshotEvents: () => [{
      type: 'assistant/message', data: { turn: 1, message: { id: 'live-ds-1', content: [{ type: 'text', text: '这是 DeepSeek 官方 TTS 的真实外呼探针。今天天气不错，我们出门走走。' }] } },
    }],
  }),
}
// mock LLM：转写稿直出（官方口播语义），不做指令生成（DeepSeek 无情感通道）
const llm = {
  listProviders: () => [{ id: 'p1' }],
  listModels: async () => [{ id: 'm1' }],
  resolveModelInfo: async () => ({}),
  prepareCall: (c) => ({ config: c, stream: () => (async function* () {
    yield { type: 'text-delta', text: '这是 DeepSeek 官方语音合成的真实外呼探针。' }
    yield { type: 'text-delta', text: '今天天气不错，我们出门走走。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() }),
}
const routes = []
const webServer = { register: (r) => routes.push(r) }
const ctx = {
  get: (n) => (n === 'llm' ? llm : n === 'sessions' ? sessions : n === 'configEditor' ? { configuration: () => [] } : undefined),
  settings, webServer, on: () => {},
  // 路由登记挂在 ctx.effect 上（卸载时摘掉）；替身必须立刻执行回调，否则路由表为空
  effect: (fn) => { try { fn() } catch { /* 替身：不收集撤销函数 */ } },
}

let liveConfig = null
settingsState.raw = {
  autoSpeak: false, autoSpeakCloudTts: true, language: 'auto', provider: 'p1', model: 'm1',
  transcribe: { enabled: true, maxTokens: 8192, temperature: 0.3, reasoningEffort: 'off', contextTurns: 0, timeoutMs: 60000 },
  tts: { provider: 'deepseek', deepseek: { apiKey: KEY, voiceId: 'stella', streaming: true } },
  stopOnNewTurn: true,
}
liveConfig = resolveConfig(settingsState.raw)
apply(ctx, liveConfig)
const apiHandler = routes.find((r) => r.path === '/voice/api').handler
const audioHandler = routes.find((r) => r.path === '/voice/audio').handler

async function rpc(method, args) {
  const body = JSON.stringify(args || {})
  const req = { method: 'POST', url: '/voice/api/' + method, async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') } }
  const res = { code: 0, body: '', writeHead() {}, end(b) { this.body = String(b || '') } }
  await apiHandler(req, res)
  try { return JSON.parse(res.body) } catch { return { ok: false, parseError: res.body } }
}
async function fetchAudio(id) {
  const req = { method: 'GET', url: '/voice/audio/' + id }
  const res = { code: 0, body: null, mime: '', writeHead(_c, h) { this.mime = (h && h['Content-Type']) || '' }, end(b) { this.body = b } }
  await audioHandler(req, res)
  return res
}
async function setConfig(patch) { await rpc('setConfig', { patch }) }

const outDir = path.join('tmp', 'deepseek-probe')
mkdirSync(outDir, { recursive: true })
let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('  ok ' + name)
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')) }
}

async function runWhole(voiceId, label) {
  await setConfig({ tts: { provider: 'deepseek', deepseek: { voiceId, streaming: false } } })
  const t0 = Date.now()
  const r = await rpc('speak', { sessionId: 'live-ds', messageId: 'live-ds-1' })
  const ms = Date.now() - t0
  if (!(r.ok && r.audioUrl)) { check('POST[' + label + '] speak ok', false, r); return }
  const wav = await fetchAudio(r.audioUrl.replace('/voice/audio/', ''))
  const ok = wav.body && wav.body.length > 44 && wav.body.toString('ascii', 0, 4) === 'RIFF' && wav.mime === 'audio/wav'
  check('POST[' + label + '] WAV 头/大小（' + (wav.body ? wav.body.length : 0) + 'B，' + ms + 'ms）', ok, { mime: wav.mime })
  const file = path.join(outDir, 'post-' + voiceId + '.wav')
  writeFileSync(file, wav.body)
  console.log('    → ' + file)
}

async function runStream(voiceId, label) {
  await setConfig({ tts: { provider: 'deepseek', deepseek: { voiceId, streaming: true } } })
  const r = await rpc('speak', { sessionId: 'live-ds', messageId: 'live-ds-1' })
  if (!(r.ok && r.mode === 'stream')) { check('WS[' + label + '] speak mode=stream', false, r); return }
  const t0 = Date.now()
  let firstAt = 0
  const pcm = []
  let done = null
  for (;;) {
    const n = await rpc('streamNext', { runId: r.runId })
    if (n.url) {
      if (!firstAt) firstAt = Date.now() - t0
      const seg = await fetchAudio(n.url.replace('/voice/audio/', ''))
      pcm.push(seg.body)
      continue
    }
    if (n.done) { done = n; break }
    await new Promise((res) => setTimeout(res, 50))
  }
  check('WS[' + label + '] 首声延迟 ' + firstAt + 'ms、段数 ' + pcm.length, pcm.length >= 1 && firstAt < 30000, { firstAt, segments: pcm.length })
  check('WS[' + label + '] finish code=success', done && !done.error, done && { error: done.error, warn: done.warn })
  const file = path.join(outDir, 'ws-' + voiceId + '.pcm')
  writeFileSync(file, Buffer.concat(pcm))
  console.log('    → ' + file + '（24kHz/16bit/单声道裸 PCM，' + Buffer.concat(pcm).length + 'B）')
}

async function runEnglish() {
  // 英文样例走临时消息：直接改 sessions 里的原文（POST 路径即可，DeepSeek 自动识别语种）
  sessions.get = () => ({
    header: { id: 'live-ds' },
    snapshotEvents: () => [{
      type: 'assistant/message', data: { turn: 1, message: { id: 'live-ds-en', content: [{ type: 'text', text: 'Hello from DeepSeek text to speech. This is a real API probe.' }] } },
    }],
  })
  await setConfig({ tts: { provider: 'deepseek', deepseek: { streaming: false } } })
  const r = await rpc('speak', { sessionId: 'live-ds', messageId: 'live-ds-en' })
  if (!(r.ok && r.audioUrl)) { check('POST[en] speak ok', false, r); return }
  const wav = await fetchAudio(r.audioUrl.replace('/voice/audio/', ''))
  check('POST[en] 英文样句出声（WAV ' + (wav.body ? wav.body.length : 0) + 'B）', !!(wav.body && wav.body.length > 44), { mime: wav.mime })
  const file = path.join(outDir, 'post-en.wav')
  writeFileSync(file, wav.body)
  console.log('    → ' + file)
}

console.log('== DeepSeek TTS 真实外呼探针（样句均为短句，费用 ≤0.1 元） ==')
await runWhole('stella', '海星')
await runWhole('tide', '暗潮')
await runStream('stella', '海星')
await runEnglish()

if (failures) {
  console.log('\n结果: ' + failures + ' failed')
  process.exit(1)
}
console.log('\n全部通过。音频已存 tmp/deepseek-probe/，请亲耳试听确认。')
