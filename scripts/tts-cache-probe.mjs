#!/usr/bin/env node
/**
 * 火山豆包双向流 cache_config 服务端缓存行为探针（plan 网关）。
 *
 * 背景：第 8 轮"永远四川口音"事故实锤——服务端缓存只按文本、不认方言/音色/情感，
 * 因此当时从插件彻底移除 cache_config。本轮用户要求"重播 1 小时以内不收钱"，
 * 结论应是：只在重播路径（同一净化稿/音色/方言/情感）下发 cache_config 才安全。
 *
 * 本探针验证（MD5 判定命中，与第 8 轮同法）：
 *   A. 文本 X + 无缓存 + 方言 sichuan → a
 *   B. 文本 X + cache_config + 方言 sichuan → b（若命中，应秒回、且 b 接近 a）
 *   C. 文本 X + cache_config + 方言 dongbei → c（若缓存只按文本，c 应 == b 的音频）
 *   D. 文本 X + 无缓存 + 方言 dongbei → d（应 != c，证明无缓存时方言真实生效）
 *   E. use_segment_cache 是否在 plan 网关可用（双向流分句缓存）
 *
 * 用法：node scripts/tts-cache-probe.mjs [--key <api-key>]
 *   音频存 tmp/cache-probe-<时间戳>/ 供试听。
 * 花费：每次 case 一次真实外呼（短文本，分币级）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { createBidirectionClient } from '../packages/dsh-plugin-voice/lib/volcengine-ws.js'

const argKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null
const key = argKey || (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!key) { console.error('未找到 apiKey：用 --key <api-key> 或在 settings.yaml 配置 voice.tts.volcengine.apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'cache-probe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const VV = 'zh_female_vv_uranus_bigtts'
// 与插件一致：双向流用 pcm（裸采样）；缓存命中与否不影响格式
const TEXT = '这个功能真的特别好用，我非常喜欢它，以后每天都想用它。'

function md5(buf) { return createHash('md5').update(buf).digest('hex') }

async function synth(label, { useCache, useSegmentCache, dialect }) {
  const audio = []
  const conn = createBidirectionClient({
    apiKey: key,
    resourceId: 'seed-tts-2.0',
    url: 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection',
    onAudio: (f) => audio.push(Buffer.from(f)),
    onFatal: (e) => console.error('  [ws] fatal:', e && e.message || e),
  })
  const t0 = Date.now()
  try {
    await conn.start()
    const additions = {}
    if (dialect) additions.explicit_dialect = dialect
    if (useCache) additions.cache_config = { use_cache: true, text_type: 1 }
    if (useSegmentCache) additions.cache_config = { use_segment_cache: true, text_type: 1 }
    const reqParams = {
      speaker: VV,
      audio_params: { format: 'pcm', sample_rate: 24000 },
    }
    if (Object.keys(additions).length) reqParams.additions = JSON.stringify(additions)
    const sid = await conn.startSession(reqParams)
    await conn.sendText(sid, reqParams, TEXT)
    await conn.finishSession(sid)
    await conn.waitSessionFinished(sid, 60000)
    const firstAt = t0
    const buf = Buffer.concat(audio)
    const ms = Date.now() - t0
    console.log(`  ${label}: bytes=${buf.length} md5=${md5(buf).slice(0, 12)} totalMs=${ms} firstAudioAtMs=${firstAt - t0} segments=${audio.length}`)
    writeFileSync(path.join(outDir, label.replace(/[^A-Za-z0-9]+/g, '-') + '.pcm'), buf)
    return buf
  } catch (e) {
    console.error(`  ${label}: FAIL ${e && e.message || e}`)
    return null
  } finally {
    await conn.close()
  }
}

console.log('缓存探针 out=' + outDir)
console.log('文本=' + TEXT)

async function synthChunks(label, chunks, { useCache }) {
  const audio = []
  const conn = createBidirectionClient({
    apiKey: key,
    resourceId: 'seed-tts-2.0',
    url: 'wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection',
    onAudio: (f) => audio.push(Buffer.from(f)),
    onFatal: (e) => console.error('  [ws] fatal:', e && e.message || e),
  })
  const t0 = Date.now()
  try {
    await conn.start()
    const additions = {}
    if (useCache) additions.cache_config = { use_cache: true, text_type: 1 }
    const reqParams = { speaker: VV, audio_params: { format: 'pcm', sample_rate: 24000 } }
    if (Object.keys(additions).length) reqParams.additions = JSON.stringify(additions)
    const sid = await conn.startSession(reqParams)
    for (const c of chunks) await conn.sendText(sid, reqParams, c)
    await conn.finishSession(sid)
    await conn.waitSessionFinished(sid, 60000)
    const buf = Buffer.concat(audio)
    console.log(`  ${label}: bytes=${buf.length} md5=${md5(buf).slice(0, 12)} totalMs=${Date.now() - t0} taskRequests=${chunks.length}`)
    writeFileSync(path.join(outDir, label.replace(/[^A-Za-z0-9]+/g, '-') + '.pcm'), buf)
    return buf
  } catch (e) {
    console.error(`  ${label}: FAIL ${e && e.message || e}`)
    return null
  } finally {
    await conn.close()
  }
}

const a = await synth('A_no-cache-sichuan', { dialect: 'sichuan' })
const b = await synth('B_cache-sichuan', { useCache: true, dialect: 'sichuan' })
const c = await synth('C_cache-dongbei', { useCache: true, dialect: 'dongbei' })
const d = await synth('D_no-cache-dongbei', { dialect: 'dongbei' })
const e = await synth('E_seg-cache-dongbei', { useSegmentCache: true, dialect: 'dongbei' })

// 关键：双向流增量喂（首段多 TaskRequest）与整段单次喂——缓存键粒度
const CHUNKS = ['这个功能真的特别好用，我非常喜欢它，', '以后每天都想用它。']
const f1 = await synthChunks('F1_chunks-cache-write', CHUNKS, { useCache: true })
const f2 = await synthChunks('F2_chunks-cache-hit', CHUNKS, { useCache: true })
const g = await synthChunks('G_whole-cache-after-chunks', [TEXT], { useCache: true })

// HTTP 单向兜底是否也支持 cache_config（决定兜底路径能否复用服务端缓存）
async function synthHttp(label, { useCache }) {
  const t0 = Date.now()
  try {
    const additions = {}
    if (useCache) additions.cache_config = { use_cache: true, text_type: 1 }
    const reqParams = { speaker: VV, audio_params: { format: 'mp3', sample_rate: 24000 } }
    if (Object.keys(additions).length) reqParams.additions = JSON.stringify(additions)
    reqParams.text = TEXT
    const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify({ user: { uid: 'dsh-voice-probe' }, req_params: reqParams }),
    })
    if (!res.ok || !res.body) throw new Error('http ' + res.status + ' ' + (await res.text().catch(() => '')))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const parts = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
        if (!line) continue
        let frame; try { frame = JSON.parse(line) } catch { continue }
        const code = typeof frame.code === 'number' ? frame.code : 0
        if (code === 0) { if (frame.data) parts.push(frame.data) }
        else if (code === 20000000) break
        else throw new Error('frame code ' + code + ' ' + (frame.message || ''))
      }
    }
    const bin = Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64')))
    console.log(`  ${label}: bytes=${bin.length} md5=${md5(bin).slice(0, 12)} totalMs=${Date.now() - t0}`)
    writeFileSync(path.join(outDir, label.replace(/[^A-Za-z0-9]+/g, '-') + '.mp3'), bin)
    return bin
  } catch (e) {
    console.error(`  ${label}: FAIL ${e && e.message || e}`)
    return null
  }
}
const h1 = await synthHttp('H1_http-cache-write', { useCache: true })
const h2 = await synthHttp('H2_http-cache-hit', { useCache: true })

console.log('\n=== 判定 ===')
if (a && b) console.log('B 命中缓存?(同方言同文本): ' + (md5(a) === md5(b) ? 'MD5 一致' : 'MD5 不同（未命中或合成确定性）'))
if (b && c) console.log('C 命中 B 的缓存?(只按文本): ' + (md5(b) === md5(c) ? '实锤——换方言仍返回相同音频' : '不同（方言被缓存纳入键或未命中）'))
if (c && d) console.log('D 与 C 不同?(无缓存方言生效): ' + (md5(c) !== md5(d) ? '是——证明只有开了 cache_config 才命中缓存' : '否——异常，需复查'))
if (e && b) console.log('E(use_segment_cache) 与 B(use_cache) 是否同: ' + (md5(e) === md5(b) ? '一致' : '不同（分句缓存粒度不同）'))
if (f1 && f2) console.log('F2 命中 F1 的缓存?(分片相同): ' + (md5(f1) === md5(f2) ? '实锤——同分片命中' : '不同——同分片未命中（缓存键不是分片文本）'))
if (f1 && g) console.log('G(整段单次) 命中 F1(分片) 的缓存?: ' + (md5(f1) === md5(g) ? '实锤——缓存键=整段文本（分片无关）' : '不同——分片方式影响缓存键，重播须复现分片'))
if (h1 && h2) console.log('H2 命中 H1 的缓存?(HTTP): ' + (md5(h1) === md5(h2) ? '实锤——HTTP 兜底也支持服务端缓存' : '不同——HTTP 未命中（或未支持）'))
