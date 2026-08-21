#!/usr/bin/env node
/**
 * 一次性诊断：plan 网关是否支持 audio_params.format = 'pcm'（官方文档推荐流式用 pcm）。
 * 另测：逐句 TaskRequest 时，服务端是否每句返回一个带 ID3 的新 MP3（接缝根因佐证）。
 * 驱动方式照搬 scripts/tts-ws-probe.mjs（自研低层帧驱动）。只做观测，不改插件。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeFrame, decodeFrame, MSG, EV } from '../packages/dsh-plugin-voice/lib/volcengine-ws.js'

const key = (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!key) { console.error('no apiKey'); process.exit(1) }

const URL = process.env.VOLC_WS_URL || 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection'

function openConn() {
  const ws = new WebSocket(URL, { headers: { 'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0' } })
  ws.binaryType = 'arraybuffer'
  const queue = []
  const anyWaiters = []
  let fatalReject
  const fatalP = new Promise((_, rej) => { fatalReject = rej })
  let readyResolve
  const ready = new Promise((r) => { readyResolve = r })
  ws.onopen = () => readyResolve()
  ws.onmessage = (e) => {
    let msg
    try { msg = decodeFrame(Buffer.from(e.data instanceof ArrayBuffer ? e.data : e.data)) } catch { return }
    if (msg.type === MSG.Error) { try { fatalReject(new Error('error frame code=' + msg.errorCode)) } catch {} }
    queue.push(msg)
    anyWaiters.splice(0).forEach((r) => r())
  }
  ws.onerror = () => fatalReject(new Error('ws error'))
  ws.onclose = () => fatalReject(new Error('ws closed'))
  async function nextMessage(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (queue.length === 0) {
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('timeout waiting for server frame')
      const p = new Promise((r) => { anyWaiters.push(r) })
      await Promise.race([p, fatalP.then(() => { throw new Error('conn dead') })])
    }
    return queue.shift()
  }
  return {
    ready, nextMessage,
    async sendFrame(m) { await ready; ws.send(encodeFrame(m)) },
    async close() { try { ws.close() } catch {} },
  }
}

async function runSession(conn, { format, chunks }) {
  const sessionId = randomUUID()
  const reqParams = { speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format, sample_rate: 24000 } }
  const basePayload = { user: { uid: 'dsh-voice-diag' }, namespace: 'BidirectionalTTS', req_params: reqParams }
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.StartSession }))) })
  let m = await conn.nextMessage()
  if (m.event === EV.SessionFailed || m.event !== EV.SessionStarted) throw new Error('session start failed event=' + m.event)
  for (const c of chunks) {
    await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId,
      payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.TaskRequest, req_params: Object.assign({}, reqParams, { text: c }) }))) })
  }
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.FinishSession, sessionId, payload: Buffer.from('{}') })
  const parts = []
  let firstAt = null
  const t0 = Date.now()
  for (;;) {
    m = await conn.nextMessage()
    if (m.type === MSG.AudioOnlyServer && m.payload.length) {
      if (firstAt === null) firstAt = Date.now()
      parts.push(Buffer.from(m.payload))
    }
    if (m.event === EV.SessionFinished || m.event === EV.TTSEnded) break
    if (m.event === EV.SessionFailed) throw new Error('SessionFailed')
  }
  return { audio: Buffer.concat(parts), firstAudioLatencyMs: firstAt === null ? null : firstAt - t0 }
}

const conn = openConn()
try {
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
  let m = await conn.nextMessage()
  if (m.event !== EV.ConnectionStarted) throw new Error('connect failed event=' + m.event)
  console.log('connect ok (plan 网关)')

  for (const format of ['pcm', 'wav', 'mp3']) {
    try {
      const r = await runSession(conn, { format, chunks: ['第一句，讲清楚现状。', '第二句，说明下一步该怎么做。'] })
      const head = r.audio.subarray(0, 24).toString('hex')
      let id3 = 0
      for (let i = 0; i < r.audio.length - 2; i++) if (r.audio[i] === 0x49 && r.audio[i + 1] === 0x44 && r.audio[i + 2] === 0x33) id3++
      const isRaw = r.audio.length > 0 && r.audio[0] !== 0xff && !(r.audio[0] === 0x49 && r.audio[1] === 0x44)
      console.log(`\nformat=${format}  audio=${r.audio.length}B firstAudio=${r.firstAudioLatencyMs}ms  ID3次数=${id3}`)
      console.log(`  前24字节: ${head}`)
      console.log(`  首字节非MPEG/ID3(似裸采样)? ${isRaw}`)
    } catch (e) {
      console.log(`\nformat=${format}  FAIL: ${e.message}`)
    }
  }
} finally {
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.FinishConnection, payload: Buffer.from('{}') }).catch(() => {})
  await conn.close()
}
process.exit(0)
