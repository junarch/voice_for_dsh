#!/usr/bin/env node
/**
 * 双向流流式管线真实端到端验证（mock LLM 免转写费 + 真实 plan 网关 TTS）。
 *
 * 用 mock 的 ctx（settings/sessions/llm/webServer）装配真实 lib/index.js，
 * 触发 `speak` → 真实 WebSocket 连 plan 网关 → 逐句 TaskRequest → 收真实音频段
 * → streamNext 轮询取出 → 存 tmp/。验证：
 *   1. streamSpeak 完整编排（段落 session / 分段 / streamNext）
 *   2. 真实端点 + 鉴权 + 帧协议
 *   3. 首段延迟 / 段数 / 段落数
 *
 * 花费：一次真实 TTS 外呼（文本很短，分币级）。失败退出码 1。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(path.join(tmpdir(), 'voice-live-'))
process.env.DSH_HOME = home

const { apply } = await import('../packages/dsh-plugin-voice/lib/index.js')

const settingsYaml = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
const KEY = /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(settingsYaml)?.[1]
if (!KEY) { console.error('未找到 volcengine apiKey'); process.exit(1) }

// ---- mock：settings / sessions / llm（canned 多句转写 + 段落指令） / webServer ----
let config = null
const settings = { register: (_ns, _s) => ({ get: () => config }) }
const sessions = {
  get: () => ({
    header: { id: 'live-s1' },
    events: [{
      type: 'assistant/message', data: { turn: 1, message: { id: 'live-1', content: [{ type: 'text', text: '这是真实双向流端到端测试的原文。' }] } },
    }],
  }),
}
const llm = {
  listProviders: () => [{ id: 'p1' }],
  listModels: async () => [{ id: 'm1' }],
  resolveModelInfo: async () => ({}),
  prepareCall: (c) => ({ config: c, stream: (opts) => {
    const isInstr = String(opts.system || '').includes('演绎指令')
    const text = isInstr ? '语气自然平稳\n中性\n4' : '第一句。第二句。\n第三句。第四句。'
    return (async function* () {
      if (isInstr) { if (text) yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      for (const p of text.split('\n').filter(Boolean)) yield { type: 'text-delta', text: p }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  } }),
}
const routes = []
const webServer = { register: (r) => routes.push(r) }
const ctx = { get: (n) => (n === 'llm' ? llm : n === 'sessions' ? sessions : undefined), settings, webServer, on: () => {} }

config = {
  autoSpeak: false, autoSpeakCloudTts: true, language: 'auto', provider: 'p1', model: 'm1',
  transcribe: { maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: '', stylePreset: 'ambiguous', readMode: 'default', contextTurns: 0, timeoutMs: 60000 },
  tts: {
    provider: 'volcengine',
    browser: { rate: 1, pitch: 1, voice: '' },
    openaiCompatible: { baseUrl: '', apiKey: '', model: 'tts-1', voice: '', format: 'mp3' },
    volcengine: {
      apiKey: KEY, resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts', sampleRate: 24000,
      rateLevel: 2, pitchLevel: 2, interface: 'bidirection', streaming: true, emotionGranularity: 'paragraph',
      bitRate: 64000, useServerCache: true, useSectionId: true, expressive: false, wsUrl: '',
    },
  },
  stopOnNewTurn: true,
}
apply(ctx)
const apiHandler = routes.find((r) => r.path === '/voice/api').handler
const audioHandler = routes.find((r) => r.path === '/voice/audio').handler

async function rpc(method, args) {
  const body = JSON.stringify(args || {})
  const req = { method: 'POST', url: '/voice/api/' + method, async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') } }
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b || '') } }
  await apiHandler(req, res)
  try { return JSON.parse(res.body) } catch { return { ok: false, parseError: res.body } }
}
async function fetchAudio(id) {
  const req = { method: 'GET', url: '/voice/audio/' + id }
  const res = { code: 0, body: null, writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await audioHandler(req, res)
  return res
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'live-stream-' + Date.now())
mkdirSync(outDir, { recursive: true })

// ---- 触发流式播报 ----
const t0 = Date.now()
const s = await rpc('speak', { sessionId: 'live-s1', messageId: 'live-1' })
if (!s.ok || s.mode !== 'stream') { console.error('speak 未走流式:', s); process.exit(1) }
const tSpeak = Date.now() - t0
const SAMPLE_RATE = s.sampleRate || 24000

// ---- 轮询 streamNext，收集音频段 ----
const urls = []
let firstSegmentMs = null
let doneRes = null
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const r = await rpc('streamNext', { runId: s.runId })
  if (r.url) {
    if (firstSegmentMs === null) firstSegmentMs = Date.now() - t0
    urls.push(r.url)
  }
  if (r.done) { doneRes = r; break }
  await new Promise((res) => setTimeout(res, 50))
}

if (!doneRes || urls.length === 0) {
  console.error('流式未产出音频:', { urls: urls.length, done: doneRes })
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

// 取每段音频字节并落盘（pcm 裸采样，16bit 小端）
let totalBytes = 0
const segFormats = []
for (let i = 0; i < urls.length; i++) {
  const id = urls[i].replace('/voice/audio/', '')
  const a = await fetchAudio(id)
  if (a.code !== 200) { console.error('音频段 ' + i + ' 取回失败 code=' + a.code); process.exit(1) }
  segFormats.push(a.body.length % 2 === 0 ? 'pcm?' : 'odd-len!')
  writeFileSync(path.join(outDir, 'seg-' + i + '.pcm'), a.body)
  totalBytes += a.body.length
}
// pcm 校验：非 mp3/ID3 头 + 偶数长度（16bit 采样）
const firstSeg = readFileSync(path.join(outDir, 'seg-0.pcm'))
const isRaw = firstSeg.length > 0 && !(firstSeg[0] === 0xff && (firstSeg[1] & 0xe0) === 0xe0) && !(firstSeg[0] === 0x49 && firstSeg[1] === 0x44)
const evenOk = segFormats.every((f) => f === 'pcm?')
writeFileSync(path.join(outDir, '_report.txt'),
  'speak 返回: ' + tSpeak + 'ms\n首段音频就绪: ' + firstSegmentMs + 'ms\n音频段数: ' + urls.length + '\n段落数: ' + doneRes.paragraphs + '\n总字节: ' + totalBytes + '\n采样率: ' + SAMPLE_RATE + '\npcm 裸采样校验: ' + (isRaw && evenOk ? 'OK' : 'FAIL') + '\nwarn: ' + (doneRes.warn || '') + '\nerror: ' + (doneRes.error || ''))

console.log('=== 双向流真实 E2E（pcm）===')
console.log('speak 返回:', tSpeak + 'ms  | 首段音频就绪:', firstSegmentMs + 'ms  | 段数:', urls.length, '| 段落数:', doneRes.paragraphs)
console.log('总字节:', totalBytes, '| 采样率:', SAMPLE_RATE, '| pcm 裸采样校验:', isRaw && evenOk ? 'OK' : 'FAIL', '| warn:', doneRes.warn || '无', '| error:', doneRes.error || '无')
console.log('音频落盘:', outDir)
rmSync(home, { recursive: true, force: true })
process.exit(!doneRes.error && isRaw && evenOk ? 0 : 1)
