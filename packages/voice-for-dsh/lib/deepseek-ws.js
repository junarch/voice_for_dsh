//#region deepseek-ws — DeepSeek 官方 TTS「WebSocket 流式」客户端
/**
 * DeepSeek 语音合成 WS 流式客户端（Node 22 全局 WebSocket，零依赖）。
 * 传输层与 volcengine-ws.js 同一套做法（headers 经构造参数、binaryType='arraybuffer'、
 * onopen/onerror/onclose/onmessage + fail 汇聚）；差异只在协议帧：
 * 豆包是二进制帧 + 一条连接多个串行 session，DeepSeek 是 JSON 文本事件 + 单会话。
 *
 * 协议（官方文档 https://api-docs.deepseek.com/zh-cn/guides/tts）：
 *  - 连接 wss://api.deepseek.com/v1/tools/tts?voice_id=…&format=pcm，鉴权 Authorization: Bearer <key>；
 *  - 文本事件 {"event":"text","text":"…"} 逐段喂文字，收尾 {"event":"finish_text"}；
 *  - 二进制消息即音频（pcm 24kHz/16bit/单声道）；
 *  - 会话以 {"event":"finish","code":"success"|…} 结束，code 非 success 视为失败；
 *  - 限制：60 秒无文本断开、单会话 ≤30 分钟音频、≤10,000 计费字符/64KiB、
 *    服务端每 25 秒 ping（Node 自动回 pong）、无续传（停止=关连接丢弃）。
 *
 * 使用：
 *   import { createDeepseekStreamClient } from './deepseek-ws.js'
 *   const c = createDeepseekStreamClient({ apiKey, voiceId, onAudio, onFatal, signal })
 *   await c.ready                      // 连接就绪
 *   c.sendText('第一句……')             // 喂一段（转写 delta / 分句段）
 *   await c.finishText(timeoutMs)      // 收尾并等待 {"event":"finish","code":"success"}
 *   c.close()                          // 主动关闭（不触发 onFatal）
 */

export const DEEPSEEK_TTS_WS_URL = 'wss://api.deepseek.com/v1/tools/tts'

export function createDeepseekStreamClient(opts) {
  const { apiKey, voiceId = 'stella', url = DEEPSEEK_TTS_WS_URL, onAudio, onFatal, signal } = opts
  const timeoutMs = opts.timeoutMs || 60000
  const ws = new WebSocket(url + '?voice_id=' + encodeURIComponent(voiceId) + '&format=pcm', {
    headers: { Authorization: 'Bearer ' + apiKey },
  })
  ws.binaryType = 'arraybuffer'
  let fatal = null
  let readySettled = false
  let readyResolve, readyReject
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej })
  let finishResolve, finishReject
  const finish = new Promise((res, rej) => { finishResolve = res; finishReject = rej })
  finish.catch(() => {}) // 失败可能早于 finishText 落地：先挂空 catch 防 unhandledRejection，真结果由 finishText 的 race 取
  let intentionalClose = false

  function fail(err) {
    if (fatal) return
    fatal = err
    if (!readySettled) { readySettled = true; readyReject(err) }
    try { finishReject(err) } catch { /* 已结束的会话：忽略 */ }
    try { onFatal && onFatal(err) } catch {}
  }

  ws.onopen = () => { readySettled = true; readyResolve() }
  ws.onerror = () => { if (!fatal) fail(new Error('websocket transport error')) }
  ws.onclose = (e) => {
    if (intentionalClose || fatal) return
    fail(new Error('websocket closed code=' + (e && e.code) + ' ' + ((e && e.reason) || '')))
  }
  ws.onmessage = (e) => {
    if (fatal) return
    const data = e.data
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const buf = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data)
      if (!buf.length) return
      try { onAudio && onAudio(buf) } catch (err) { fail(err) }
      return
    }
    let msg
    try { msg = JSON.parse(String(data)) } catch { return } // 非法 JSON 忽略，不当失败
    if (msg && msg.event === 'finish') {
      if (msg.code && msg.code !== 'success') {
        fail(new Error('deepseek tts finish code=' + msg.code + ' ' + String(msg.message || '').slice(0, 200)))
        return
      }
      try { finishResolve(msg) } catch { /* 已结束：忽略 */ }
      return
    }
    // 其余事件（进度/心跳文本）忽略
  }
  if (signal) {
    const onAbort = () => { intentionalClose = true; try { ws.close() } catch {} }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    ready,
    finish,
    /** 喂一段文字（调用方保证非空；计费/64KiB 限额由调用方轮转会话处理）。 */
    sendText(text) {
      if (fatal) throw fatal
      ws.send(JSON.stringify({ event: 'text', text: String(text || '') }))
    },
    /** 发 finish_text 并等待会话结束帧（code=success）；超时/失败抛错。 */
    async finishText(timeout = timeoutMs) {
      if (fatal) throw fatal
      ws.send(JSON.stringify({ event: 'finish_text' }))
      let timer = null
      try {
        return await Promise.race([
          finish,
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('deepseek tts finish 超时（' + timeout + 'ms）')), timeout) }),
        ])
      } finally { if (timer) clearTimeout(timer) }
    },
    close() { intentionalClose = true; try { ws.close() } catch {} },
  }
}
//#endregion
