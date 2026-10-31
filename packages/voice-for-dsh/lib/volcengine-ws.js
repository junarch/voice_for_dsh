//#region volcengine-ws — 豆包双向流（WebSocket Bidirection）客户端
/**
 * 豆包语音合成 2.0「WebSocket 双向流式」客户端（Node 22 全局 WebSocket，零依赖）。
 *
 * 依据官方文档 https://www.volcengine.com/docs/6561/1329505 二进制协议 + 社区参考实现
 * doubao-speech/_ws_client.py 定稿；探针（scripts/tts-ws-probe.mjs）在
 * plan 网关 wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection 上实测通过
 * （首包 310~390ms；流式喂文本 / 多 session 复用 / context_texts / explicit_dialect /
 * cache_config / section_id / model=expressive 均可用）。
 *
 * 使用：
 *   import { createBidirectionClient } from './volcengine-ws.js'
 *   const conn = createBidirectionClient({ apiKey, resourceId, url, onAudio, onFatal, signal })
 *   await conn.start()
 *   const sid = await conn.startSession({ user, namespace, req_params }, sessionId)
 *   await conn.sendText(sid, reqParamsBase, '第一句……')
 *   await conn.sendText(sid, reqParamsBase, '第二句……')
 *   await conn.finishSession(sid)
 *   await conn.waitSessionFinished(sid, timeoutMs)
 *   // 下一段：再 startSession（同一条连接，串行 session）
 *   await conn.finishConnection()
 */
export const WS_DEFAULTS = {
  url: 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection',
  resourceId: 'seed-tts-2.0',
}

// ---- 协议常量 --------------------------------------------------------------
export const MSG = { FullClientRequest: 0b0001, AudioOnlyClient: 0b0010, FullServerResponse: 0b1001, AudioOnlyServer: 0b1011, Error: 0b1111 }
export const FLAG = { NoSeq: 0, PosSeq: 0b0001, LastNoSeq: 0b0010, NegSeq: 0b0011, WithEvent: 0b0100 }
export const EV = {
  StartConnection: 1, FinishConnection: 2,
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  StartSession: 100, CancelSession: 101, FinishSession: 102,
  SessionStarted: 150, SessionCanceled: 151, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200, UpdateConfig: 201,
  TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352, TTSEnded: 359,
}
const CONNECTION_EVENTS = new Set([EV.StartConnection, EV.FinishConnection, EV.ConnectionStarted, EV.ConnectionFailed, EV.ConnectionFinished])

// ---- 帧编解码（大端；4 字节头 + event/session_id + payload） -----------------
export function encodeFrame({ type, flag = FLAG.WithEvent, event = 0, sessionId = '', payload = Buffer.alloc(0) }) {
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

export function decodeFrame(buf) {
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
  else if (flag === FLAG.PosSeq || flag === FLAG.NegSeq) { off += 4 }
  let payload = Buffer.alloc(0)
  if (off + 4 <= buf.length) {
    const size = buf.readUInt32BE(off); off += 4
    if (size && off + size <= buf.length) payload = buf.subarray(off, off + size)
  }
  return { type, flag, serialization, compression, event, sessionId, errorCode, payload }
}

/**
 * 事件驱动的双向流连接管理器。
 * @param {object} opts
 *   apiKey, resourceId, url(可选), onAudio(frame)=>void, onFatal(err)=>void,
 *   signal(AbortSignal), timeoutMs(单步超时，默认 30000)
 * @returns 见文件头注释
 */
export function createBidirectionClient(opts) {
  const { apiKey, resourceId = WS_DEFAULTS.resourceId, url = WS_DEFAULTS.url, onAudio, onFatal, signal } = opts
  const timeoutMs = opts.timeoutMs || 30000
  const ws = new WebSocket(url, {
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2),
      'X-Control-Require-Usage-Tokens-Return': '*',
    },
  })
  ws.binaryType = 'arraybuffer'
  const waiters = [] // { predicate(msg), resolve, reject }
  let fatal = null
  let readySettled = false
  let readyResolve, readyReject
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej })
  ws.onopen = () => { readySettled = true; readyResolve() }
  ws.onerror = () => { if (!fatal) fail(new Error('websocket transport error')) }
  let intentionalClose = false
  ws.onclose = (e) => { if (!intentionalClose && !fatal) fail(new Error('websocket closed code=' + e.code + ' ' + (e.reason || ''))) }

  function fail(err) {
    if (fatal) return
    fatal = err
    if (!readySettled) { readySettled = true; readyReject(err) }
    const w = waiters.splice(0)
    for (const it of w) it.reject(err)
    try { onFatal && onFatal(err) } catch {}
  }

  ws.onmessage = (e) => {
    if (fatal) return
    let msg
    try { msg = decodeFrame(Buffer.from(e.data instanceof ArrayBuffer ? e.data : e.data)) }
    catch (err) { fail(new Error('decode: ' + err.message)); return }
    if (msg.type === MSG.Error) {
      fail(new Error('server error frame code=' + msg.errorCode + ' payload=' + String(msg.payload).slice(0, 200)))
      return
    }
    if (msg.type === MSG.AudioOnlyServer && msg.payload.length) {
      try { onAudio && onAudio(msg.payload) } catch (err) { fail(err) }
      return
    }
    // FullServerResponse / 其他：按谓词投递给等待者，无等待者则忽略（进度帧）
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) { const [w] = waiters.splice(i, 1); w.resolve(msg); return }
    }
  }

  function waitFor(predicate, timeout = timeoutMs, label = 'event') {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const onAbort = () => {
        const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1)
        done(reject, new Error('aborted'))
      }
      const done = (fn, v) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        fn(v)
      }
      const w = { predicate, resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) }
      waiters.push(w)
      timer = setTimeout(() => {
        const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1)
        done(reject, new Error('timeout waiting ' + label))
      }, timeout)
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    })
  }
  function sendFrame(frame) { if (fatal) throw fatal; ws.send(encodeFrame(frame)) }

  return {
    ws, ready,
    /**
     * 建连 + StartConnection。
     */
    async start() {
      await ready
      sendFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
      const m = await waitFor((x) => x.event === EV.ConnectionStarted || x.event === EV.ConnectionFailed, timeoutMs, 'ConnectionStarted')
      if (m.event === EV.ConnectionFailed) throw new Error('ConnectionFailed')
    },
    /**
     * 开始一个会话（参数在 reqParams 中）。返回 sessionId。
     * @param {object} reqParams 含 speaker/audio_params/additions 等（不含 text）
     * @param {string} sessionId 可选，默认自动生成
     */
    async startSession(reqParams, sessionId) {
      const sid = sessionId || ((globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2))
      const payload = JSON.stringify({ user: { uid: 'voice-for-dsh' }, namespace: 'BidirectionalTTS', event: EV.StartSession, req_params: reqParams })
      sendFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId: sid, payload: Buffer.from(payload) })
      const m = await waitFor((x) => x.event === EV.SessionStarted || x.event === EV.SessionFailed, timeoutMs, 'SessionStarted')
      if (m.event === EV.SessionFailed) throw new Error('SessionFailed')
      return sid
    },
    /** 增量发送文本（TaskRequest）。reqParams 须与 startSession 一致并含 text。 */
    async sendText(sessionId, reqParams, text) {
      const payload = JSON.stringify({ user: { uid: 'voice-for-dsh' }, namespace: 'BidirectionalTTS', event: EV.TaskRequest, req_params: Object.assign({}, reqParams, { text }) })
      sendFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId, payload: Buffer.from(payload) })
    },
    async finishSession(sessionId) {
      sendFrame({ type: MSG.FullClientRequest, event: EV.FinishSession, sessionId, payload: Buffer.from('{}') })
    },
    /** 等待本会话结束（SessionFinished / TTSEnded / SessionFailed）。 */
    async waitSessionFinished(sessionId, timeout = timeoutMs) {
      const m = await waitFor((x) => (x.event === EV.SessionFinished || x.event === EV.TTSEnded || x.event === EV.SessionFailed) && (!x.sessionId || x.sessionId === sessionId), timeout, 'SessionFinished')
      if (m.event === EV.SessionFailed) throw new Error('SessionFailed')
    },
    async cancelSession(sessionId) {
      try { sendFrame({ type: MSG.FullClientRequest, event: EV.CancelSession, sessionId, payload: Buffer.from('{}') }) } catch { /* 连接已死 */ }
    },
    async finishConnection() {
      try { sendFrame({ type: MSG.FullClientRequest, event: EV.FinishConnection, payload: Buffer.from('{}') }) } catch { /* 连接已死 */ }
    },
    async close() {
      intentionalClose = true
      try { ws.close() } catch { /* 已关 */ }
    },
  }
}

//#endregion
