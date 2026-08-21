#!/usr/bin/env node
/**
 * 双向流方言专项探针：确认 plan 网关 WS 双向流上 explicit_dialect 支持哪些方言。
 * 前置（HTTP 单向已测）：8 个值（tianjin/yue/shanghai/henan/beijing/dongbei/sichuan/shaanxi）全部不报错且输出不同。
 * 本探针验证主路径（双向流）同样支持——默认播报走的就是这条。
 * 用法：node scripts/tts-ws-dialect-probe.mjs [--key <api-key>]
 *   音频存 tmp/ws-dialect-probe-<时间戳>/。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const argKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null
const key = argKey || (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!key) { console.error('未找到 apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'ws-dialect-probe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const MSG = { FullClientRequest: 0b0001, FullServerResponse: 0b1001, AudioOnlyServer: 0b1011, Error: 0b1111 }
const FLAG = { NoSeq: 0, PosSeq: 0b0001, WithEvent: 0b0100 }
const EV = {
  StartConnection: 1, FinishConnection: 2, ConnectionStarted: 50, ConnectionFailed: 51,
  StartSession: 100, FinishSession: 102, SessionStarted: 150, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200, TTSEnded: 359,
}
const CONNECTION_EVENTS = new Set([EV.StartConnection, EV.FinishConnection, EV.ConnectionStarted, EV.ConnectionFailed, EV.ConnectionFinished])
function encodeFrame({ type, flag = FLAG.WithEvent, event = 0, sessionId = '', payload = Buffer.alloc(0) }) {
  const chunks = [Buffer.from([(1 << 4) | 1, (type << 4) | flag, (0b0001 << 4) | 0, 0x00])]
  if (flag === FLAG.WithEvent) {
    const eb = Buffer.alloc(4); eb.writeInt32BE(event); chunks.push(eb)
    if (!CONNECTION_EVENTS.has(event)) {
      const sid = Buffer.from(sessionId, 'utf8')
      const sl = Buffer.alloc(4); sl.writeUInt32BE(sid.length); chunks.push(sl)
      if (sid.length) chunks.push(sid)
    }
  }
  const pl = Buffer.alloc(4); pl.writeUInt32BE(payload.length); chunks.push(pl)
  if (payload.length) chunks.push(payload)
  return Buffer.concat(chunks)
}
function decodeFrame(buf) {
  if (buf.length < 4) throw new Error('frame too short')
  const headerSize = (buf[0] & 0x0F) * 4
  const type = buf[1] >> 4
  const flag = buf[1] & 0x0F
  const compression = buf[2] & 0x0F
  let off = headerSize
  let event = 0, sessionId = '', errorCode = 0
  if (flag === FLAG.WithEvent) {
    event = buf.readInt32BE(off); off += 4
    if (!CONNECTION_EVENTS.has(event)) {
      const sidLen = buf.readUInt32BE(off); off += 4
      if (sidLen) { sessionId = buf.toString('utf8', off, off + sidLen); off += sidLen }
    }
  }
  if (type === MSG.Error) { errorCode = buf.readUInt32BE(off); off += 4 }
  else if (flag === FLAG.PosSeq) { off += 4 }
  let payload = Buffer.alloc(0)
  if (off + 4 <= buf.length) {
    const size = buf.readUInt32BE(off); off += 4
    if (size && off + size <= buf.length) payload = buf.subarray(off, off + size)
  }
  return { type, event, sessionId, errorCode, compression, payload }
}

const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection', {
  headers: {
    'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0',
    'X-Api-Connect-Id': randomUUID(), 'X-Control-Require-Usage-Tokens-Return': '*',
  },
})
ws.binaryType = 'arraybuffer'
const queue = []
const waiters = []
ws.onmessage = (e) => {
  const msg = decodeFrame(Buffer.from(e.data instanceof ArrayBuffer ? e.data : e.data))
  if (waiters.length) waiters.shift()(msg); else queue.push(msg)
}
ws.onerror = () => { console.error('ws error'); process.exit(1) }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
function nextMessage(timeout = 15000) {
  if (queue.length) return queue.shift()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeout)
    waiters.push((m) => { clearTimeout(t); resolve(m) })
  })
}
async function sendFrame(msg) { ws.send(encodeFrame(msg)) }

const VV = 'zh_female_vv_uranus_bigtts'
const TEXT = '您吃了吗？介天儿真不错，咱上街遛遛去吧。'
const dialects = ['tianjin', 'yue', 'shanghai', 'henan', 'beijing', 'dongbei', 'sichuan', 'shaanxi']

await sendFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
let m = await nextMessage()
if (m.event !== EV.ConnectionStarted) { console.error('ConnectionFailed'); process.exit(1) }
console.log('双向流方言探针（vv，plan 网关）：\n')

for (const d of dialects) {
  const sessionId = randomUUID()
  const reqParams = { speaker: VV, audio_params: { format: 'pcm', sample_rate: 24000 }, additions: JSON.stringify({ explicit_dialect: d }) }
  const basePayload = { user: { uid: 'dsh-voice-probe' }, namespace: 'BidirectionalTTS', req_params: reqParams }
  try {
    await sendFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.StartSession }))) })
    m = await nextMessage()
    if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + m.payload.toString().slice(0, 120))
    if (m.event === EV.SessionFailed) throw new Error('SessionFailed ' + m.payload.toString().slice(0, 120))
    if (m.event !== EV.SessionStarted) throw new Error('expected SessionStarted, got ' + m.event)
    await sendFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.TaskRequest, req_params: Object.assign({}, reqParams, { text: TEXT }) }))) })
    await sendFrame({ type: MSG.FullClientRequest, event: EV.FinishSession, sessionId, payload: Buffer.from('{}') })
    const parts = []
    for (;;) {
      m = await nextMessage()
      if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + m.payload.toString().slice(0, 120))
      if (m.type === MSG.AudioOnlyServer && m.payload.length) parts.push(m.payload)
      if (m.event === EV.SessionFinished || m.event === EV.TTSEnded) break
      if (m.event === EV.SessionFailed) throw new Error('SessionFailed')
    }
    const pcm = Buffer.concat(parts)
    writeFileSync(path.join(outDir, d + '.pcm'), pcm)
    console.log('  ✓ explicit_dialect=' + d + '  pcmBytes=' + pcm.length + ' (' + (pcm.length / 48000).toFixed(2) + 's@24k)')
  } catch (error) {
    console.log('  ✗ explicit_dialect=' + d + '  ' + String(error && error.message || error).slice(0, 160))
  }
}
await sendFrame({ type: MSG.FullClientRequest, event: EV.FinishConnection, payload: Buffer.from('{}') })
try { ws.close() } catch {}
console.log('\n试听目录（pcm 裸采样，需转 mp3 试听）：' + outDir)
