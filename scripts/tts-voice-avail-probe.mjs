#!/usr/bin/env node
/**
 * 音色候选可用性探针：验证 2.0 音色在当前 plan 网关 + seed-tts-2.0 + 双向流是否可用。
 * 目的：精选 4 男 4 女中文 + 英文音色前，先确认哪些真的能出声（避免把不可用音色写进下拉）。
 * 用法：node scripts/tts-voice-avail-probe.mjs [--key <api-key>]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
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
const jsonPayload = (buf, compression) => {
  const b = compression === 1 ? gunzipSync(buf) : buf
  try { return JSON.parse(b.toString()) } catch { return b.toString().slice(0, 200) }
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

const CANDIDATES = [
  // 中文男声 2.0
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', zh: true },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0', zh: true },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0', zh: true },
  { id: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年 2.0', zh: true },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛 2.0', zh: true },
  // 中文女声 2.0 候选
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 2.0', zh: true },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0', zh: true },
  // 英文 2.0
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim (EN)', zh: false },
  { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey (EN)', zh: false },
  { id: 'en_female_stokie_uranus_bigtts', name: 'Stokie (EN)', zh: false },
  { id: 'en_female_brittney_uranus_bigtts', name: 'Brittney (EN)', zh: false },
  { id: 'en_male_alex_uranus_bigtts', name: 'Alex (EN)', zh: false },
]

const ZHTEXT = '今天天气真不错，咱们一起去吃个饭吧。'
const ENTEXT = 'Hello! This is a voice preview. Let us go grab a meal together.'

await sendFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
let m = await nextMessage()
if (m.event !== EV.ConnectionStarted) { console.error('ConnectionFailed'); process.exit(1) }
console.log('音色可用性探针（双向流，plan 网关，seed-tts-2.0）：\n')

for (const c of CANDIDATES) {
  const sessionId = randomUUID()
  const text = c.zh ? ZHTEXT : ENTEXT
  const additions = c.zh ? {} : { explicit_language: 'en' }
  const reqParams = { speaker: c.id, audio_params: { format: 'pcm', sample_rate: 24000 }, ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}) }
  const basePayload = { user: { uid: 'dsh-voice-probe' }, namespace: 'BidirectionalTTS', req_params: reqParams }
  try {
    await sendFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.StartSession }))) })
    m = await nextMessage()
    if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + jsonPayload(m.payload, m.compression))
    if (m.event === EV.SessionFailed) throw new Error('SessionFailed ' + jsonPayload(m.payload, m.compression))
    if (m.event !== EV.SessionStarted) throw new Error('expected SessionStarted, got ' + m.event)
    await sendFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.TaskRequest, req_params: Object.assign({}, reqParams, { text }) }))) })
    await sendFrame({ type: MSG.FullClientRequest, event: EV.FinishSession, sessionId, payload: Buffer.from('{}') })
    let bytes = 0
    let failed = false
    for (;;) {
      m = await nextMessage()
      if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + jsonPayload(m.payload, m.compression))
      if (m.type === MSG.AudioOnlyServer && m.payload.length) bytes += m.payload.length
      if (m.event === EV.SessionFinished || m.event === EV.TTSEnded) break
      if (m.event === EV.SessionFailed) throw new Error('SessionFailed ' + jsonPayload(m.payload, m.compression))
    }
    console.log('  ✓ ' + c.id + '  (' + c.name + ')  pcmBytes=' + bytes + (bytes ? '' : '  <-- 0 bytes!'))
  } catch (error) {
    console.log('  ✗ ' + c.id + '  (' + c.name + ')  ' + String(error && error.message || error).slice(0, 160))
  }
}
await sendFrame({ type: MSG.FullClientRequest, event: EV.FinishConnection, payload: Buffer.from('{}') })
try { ws.close() } catch {}
console.log('\n完成。')
