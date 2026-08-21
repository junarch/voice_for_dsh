#!/usr/bin/env node
/**
 * 火山豆包 seed-tts-2.0「WebSocket 双向流式-V3」行为探针。
 *
 * 验证（文档 https://www.volcengine.com/docs/6561/1329505）：
 *   1. 端点 wss://openspeech.bytedance.com/api/v3/tts/bidirection + X-Api-Key 鉴权
 *   2. 二进制帧协议（4 字节头 + event/session_id/payload，大端）编解码
 *   3. 事件流：StartConnection→ConnectionStarted→StartSession→SessionStarted→
 *      TaskRequest→(AudioOnlyServer…)→FinishSession→SessionFinished→FinishConnection
 *   4. 逐段 TaskRequest（增量喂文本）是否可用；一条连接多 session 复用
 *   5. 参数：emotion/emotion_scale、explicit_dialect、context_texts、cache_config、
 *      section_id、req_params.model=seed-tts-2.0-expressive
 *   6. 首包延迟（StartSession→首批音频字节的耗时）
 *
 * 用法：node scripts/tts-ws-probe.mjs [--key <api-key>] [--case <name>] [--all]
 *   不给 --key 时从 %USERPROFILE%\.dsh\settings.yaml 的 voice.tts.volcengine.apiKey 读取。
 *   每个 case 的音频存 tmp/ws-probe-<时间戳>/<case>.mp3 供人工试听。
 * 花费：每 case 一次真实外呼，文本都很短（分币级）。
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
if (!key) { console.error('未找到 apiKey：用 --key <api-key> 或在 settings.yaml 配置 voice.tts.volcengine.apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'ws-probe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const URL = process.env.VOLC_WS_URL || 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection'
// 注：默认走 plan 网关（现有 ark- Key 兼容）。新 V3 网关 wss://openspeech.bytedance.com/api/v3/tts/bidirection
// 需要新版控制台签发/开通的 Key（实测当前 Key 在 v3 网关返回 401 Invalid X-Api-Key）。
const RESOURCE = 'seed-tts-2.0'

// ---------------------------------------------------------------------------
// 帧协议（依据官方文档二进制协议 + 社区参考实现 doubao-speech/_ws_client.py 定稿）
// ---------------------------------------------------------------------------
const MSG = { FullClientRequest: 0b0001, AudioOnlyClient: 0b0010, FullServerResponse: 0b1001, AudioOnlyServer: 0b1011, Error: 0b1111 }
const FLAG = { NoSeq: 0, PosSeq: 0b0001, LastNoSeq: 0b0010, NegSeq: 0b0011, WithEvent: 0b0100 }
const EV = {
  StartConnection: 1, FinishConnection: 2,
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  StartSession: 100, CancelSession: 101, FinishSession: 102,
  SessionStarted: 150, SessionCanceled: 151, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352, TTSEnded: 359,
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
  if (buf.length < 4) throw new Error('frame too short: ' + buf.length)
  const headerSize = (buf[0] & 0x0F) * 4
  const type = buf[1] >> 4
  const flag = buf[1] & 0x0F
  const serialization = buf[2] >> 4
  const compression = buf[2] & 0x0F
  let off = headerSize
  let event = 0, sessionId = '', errorCode = 0
  if (flag === FLAG.WithEvent) {
    event = buf.readInt32BE(off); off += 4
    if (!CONNECTION_EVENTS.has(event)) {
      const sidLen = buf.readUInt32BE(off); off += 4
      if (sidLen) { sessionId = buf.toString('utf8', off, off + sidLen); off += sidLen }
    } else if (type === MSG.FullServerResponse) {
      if (off + 4 <= buf.length) { const cidLen = buf.readUInt32BE(off); off += 4; if (cidLen) off += cidLen }
    }
  }
  if (type === MSG.Error) { errorCode = buf.readUInt32BE(off); off += 4 }
  else if (flag === FLAG.PosSeq || flag === FLAG.NegSeq) { off += 4 } // sequence
  let payload = Buffer.alloc(0)
  if (off + 4 <= buf.length) {
    const size = buf.readUInt32BE(off); off += 4
    if (size && off + size <= buf.length) payload = buf.subarray(off, off + size)
  }
  return { type, flag, serialization, compression, event, sessionId, errorCode, payload }
}

function jsonPayload(payload, compression) {
  if (!payload.length) return null
  try { return JSON.parse((compression === 1 ? gunzipSync(payload) : payload).toString('utf8')) } catch { return null }
}

// ---------------------------------------------------------------------------
// 连接：有序消息队列 + 发送助手
// ---------------------------------------------------------------------------
function openConn({ onError }) {
  const ws = new WebSocket(URL, { headers: {
    'X-Api-Key': key,
    'X-Api-Resource-Id': RESOURCE,
    'X-Api-Connect-Id': randomUUID(),
    'X-Control-Require-Usage-Tokens-Return': '*',
  } })
  ws.binaryType = 'arraybuffer'
  const queue = []
  const anyWaiters = []
  let fatal = null // 致命错误（连接级）
  let fatalReject = null
  const fatalP = new Promise((_, rej) => { fatalReject = rej })
  let readyResolve
  const ready = new Promise((r) => { readyResolve = r })

  ws.onopen = () => { readyResolve() }

  ws.onmessage = (e) => {
    let msg
    try { msg = decodeFrame(Buffer.from(e.data instanceof ArrayBuffer ? e.data : e.data)) }
    catch (err) { onError && onError('decode: ' + err.message); return }
    if (msg.type === MSG.Error) {
      const j = jsonPayload(msg.payload, msg.compression)
      onError && onError('error frame code=' + msg.errorCode + ' ' + JSON.stringify(j))
    }
    queue.push(msg)
    anyWaiters.splice(0).forEach((r) => r())
  }
  ws.onerror = (e) => { fatalReject(new Error('ws error: ' + String(e && e.message || e))) }
  ws.onclose = (e) => { fatalReject(new Error('ws closed code=' + e.code + ' ' + (e.reason || ''))) }

  async function nextMessage(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (queue.length === 0) {
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('timeout waiting for server frame')
      const p = new Promise((r) => { anyWaiters.push(r) })
      await Promise.race([p, fatalP.then(() => { throw fatal || new Error('conn dead') })])
    }
    return queue.shift()
  }
  async function sendFrame(msg) { await ready; ws.send(encodeFrame(msg)) }
  return {
    ready, nextMessage, sendFrame,
    async close() { try { ws.close() } catch {} },
  }
}

// ---------------------------------------------------------------------------
// 单个 TTS 会话
// ---------------------------------------------------------------------------
async function runSession(conn, { text, speaker, additionsObj, extraParams, chunks, onAudio }) {
  const sessionId = randomUUID()
  const reqParams = Object.assign({}, extraParams, {
    speaker,
    audio_params: Object.assign({ format: 'mp3', sample_rate: 24000 }, extraParams && extraParams.audioParams || {}),
  })
  if (additionsObj && Object.keys(additionsObj).length) reqParams.additions = JSON.stringify(additionsObj)
  const basePayload = { user: { uid: 'dsh-voice-probe' }, namespace: 'BidirectionalTTS', req_params: reqParams }

  const t0 = Date.now()
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId, payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.StartSession }))) })
  let m = await conn.nextMessage()
  if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + JSON.stringify(jsonPayload(m.payload, m.compression)))
  if (m.event === EV.SessionFailed) throw new Error('SessionFailed: ' + JSON.stringify(jsonPayload(m.payload, m.compression)))
  if (m.event !== EV.SessionStarted) throw new Error('expected SessionStarted, got event=' + m.event)

  const chunksToSend = Array.isArray(chunks) ? chunks : [text]
  for (const c of chunksToSend) {
    await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId,
      payload: Buffer.from(JSON.stringify(Object.assign({}, basePayload, { event: EV.TaskRequest, req_params: Object.assign({}, reqParams, { text: c }) }))) })
  }
  await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.FinishSession, sessionId, payload: Buffer.from('{}') })

  let firstAudioAt = null
  let audioBytes = 0
  const audioParts = []
  for (;;) {
    m = await conn.nextMessage()
    if (m.type === MSG.Error) throw new Error('error frame code=' + m.errorCode + ' ' + JSON.stringify(jsonPayload(m.payload, m.compression)))
    if (m.type === MSG.AudioOnlyServer && m.payload.length) {
      if (firstAudioAt === null) firstAudioAt = Date.now()
      audioBytes += m.payload.length
      audioParts.push(m.payload)
      if (onAudio) onAudio(m.payload)
    }
    if (m.event === EV.SessionFinished || m.event === EV.TTSEnded) break
    if (m.event === EV.SessionFailed) throw new Error('SessionFailed')
  }
  return { firstAudioLatencyMs: firstAudioAt === null ? null : firstAudioAt - t0, audioBytes, audio: Buffer.concat(audioParts) }
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------
const VV = 'zh_female_vv_uranus_bigtts'
const EMO = 'zh_female_roumeinvyou_emo_v2_mars_bigtts' // 柔美女友2.0（多情感）

const CASES = {
  basic: { text: '你好，这是一段双向流式语音合成的测试。', speaker: VV, note: '基线：单段文本，测量首包延迟' },
  stream2: { text: '这是一段分两片发送的流式文本。', speaker: VV, chunks: ['这是一段分两片发送的', '流式文本。'], note: '增量 TaskRequest（两片）' },
  emotion: { text: '今天的心情特别开心！', speaker: EMO, extraParams: { audioParams: { emotion: 'happy', emotion_scale: 5 } }, note: 'emotion=happy + emotion_scale=5（柔美女友2.0）' },
  dialect: { text: '这事整得挺得劲，老铁们听好了。', speaker: VV, additions: { explicit_dialect: 'dongbei' }, note: 'explicit_dialect=dongbei（vv 音色）' },
  instruct: { text: '这个结果真是太棒了！', speaker: VV, additions: { context_texts: ['语气轻快活泼一点'] }, note: 'context_texts 语音指令' },
  cache: { text: '缓存功能测试，这句话应该被服务端缓存。', speaker: VV, additions: { cache_config: { use_cache: true, text_type: 1 } }, note: 'cache_config 服务端缓存' },
  section: { text: '多轮会话上下文测试。', speaker: VV, additions: { section_id: randomUUID() }, note: 'section_id 会话关联' },
  expressive: { text: '这个功能真的绝了，太厉害了！', speaker: VV, extraParams: { model: 'seed-tts-2.0-expressive' }, additions: { context_texts: ['语气兴奋一点'] }, note: 'model=expressive + 指令' },
  session2: { text: '', speaker: VV, twoSessions: ['第一段会话的文本。', '第二段会话的文本。'], note: '一条连接跑两个串行 session' },
}

async function runCase(name, spec) {
  console.log('\n=== case ' + name + ' === ' + (spec.note || ''))
  const conn = openConn({ onError: (e) => console.error('  [ws] error:', e) })
  try {
    await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
    let m = await conn.nextMessage()
    if (m.event === EV.ConnectionFailed) throw new Error('ConnectionFailed: ' + JSON.stringify(jsonPayload(m.payload, m.compression)))
    if (m.event !== EV.ConnectionStarted) throw new Error('expected ConnectionStarted, got event=' + m.event)
    console.log('  connect ok')

    if (spec.twoSessions) {
      for (let i = 0; i < spec.twoSessions.length; i++) {
        const r = await runSession(conn, { text: spec.twoSessions[i], speaker: spec.speaker, additionsObj: spec.additions, extraParams: spec.extraParams })
        console.log(`  session${i + 1}: audio=${r.audioBytes}B firstAudio=${r.firstAudioLatencyMs}ms`)
        if (r.audio.length) writeFileSync(path.join(outDir, name + '-' + (i + 1) + '.mp3'), r.audio)
      }
    } else {
      const r = await runSession(conn, { text: spec.text, chunks: spec.chunks, speaker: spec.speaker, additionsObj: spec.additions, extraParams: spec.extraParams })
      console.log(`  audio=${r.audioBytes}B firstAudio=${r.firstAudioLatencyMs}ms`)
      if (r.audio.length) writeFileSync(path.join(outDir, name + '.mp3'), r.audio)
    }

    await conn.sendFrame({ type: MSG.FullClientRequest, event: EV.FinishConnection, payload: Buffer.from('{}') })
    try { await conn.nextMessage(8000) } catch {}
    console.log('  ok')
  } catch (e) {
    console.error('  FAIL:', e && e.message || e)
  } finally {
    await conn.close()
  }
}

const requested = process.argv.includes('--all') ? Object.keys(CASES)
  : process.argv.includes('--case') ? (() => {
      const list = []
      for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === '--case') list.push(process.argv[i + 1])
      return list
    })()
  : ['basic']

let failed = 0
for (const c of requested) {
  if (!CASES[c]) { console.error('unknown case: ' + c); process.exit(1) }
  try { await runCase(c, CASES[c]) } catch (e) { console.error('  case crash:', e); failed++ }
}
console.log('\n输出目录: ' + outDir)
process.exit(failed ? 1 : 0)
