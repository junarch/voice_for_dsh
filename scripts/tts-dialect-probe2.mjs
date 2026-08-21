#!/usr/bin/env node
/**
 * 方言专项探针（补测）：
 *   1. 用【不同文本】复测，排除服务端缓存干扰（首轮 context_texts 组与 dongbei 字节完全相同，可疑）。
 *   2. 补测 explicit_dialect 其余方言值：shanghai / henan / beijing / dongbei / sichuan / shaanxi / tianjin / yue。
 *   3. 复测 context_texts 自然语言指令 vs 基线，判断 context_texts 是否真的有效/被忽略。
 *   4. 小何音色（文档标 8 方言）也测 explicit_dialect=tianjin。
 * 用法：node scripts/tts-dialect-probe2.mjs [--key <api-key>]
 *   音频存 tmp/dialect-probe2-<时间戳>/。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const argKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null
const key = argKey || (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!key) { console.error('未找到 apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'dialect-probe2-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const VV = 'zh_female_vv_uranus_bigtts'
const XIAOHE = 'zh_female_xiaohe_uranus_bigtts'
// 与首轮完全不同的文本，含天津味语气词，避免缓存
const TEXT = '哎哟喂，我说大妹子，你介是干嘛呢？晌午头儿上咱上哪块儿吃去，你说话啊，别净顾着乐。'

async function synth({ speaker, additions, text = TEXT }) {
  const reqBody = {
    user: { uid: 'dsh-voice-probe' },
    req_params: {
      text, speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 },
      ...(additions && Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}),
    },
  }
  const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': randomUUID() },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200))
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const parts = []
  let serverErr = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      const code = typeof frame.code === 'number' ? frame.code : 0
      if (code === 0) { if (frame.data) parts.push(frame.data) }
      else if (code === 20000000) break
      else { serverErr = 'code=' + code + ' msg=' + (frame.message || '') }
    }
  }
  return { mp3: Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64'))), serverErr }
}

const cases = [
  { file: 'a1-vv-基线', speaker: VV, additions: {} },
  { file: 'a2-vv-explicit-tianjin', speaker: VV, additions: { explicit_dialect: 'tianjin' } },
  { file: 'a3-vv-explicit-yue', speaker: VV, additions: { explicit_dialect: 'yue' } },
  { file: 'a4-vv-explicit-shanghai', speaker: VV, additions: { explicit_dialect: 'shanghai' } },
  { file: 'a5-vv-explicit-henan', speaker: VV, additions: { explicit_dialect: 'henan' } },
  { file: 'a6-vv-explicit-beijing', speaker: VV, additions: { explicit_dialect: 'beijing' } },
  { file: 'a7-vv-explicit-dongbei', speaker: VV, additions: { explicit_dialect: 'dongbei' } },
  { file: 'a8-vv-explicit-sichuan', speaker: VV, additions: { explicit_dialect: 'sichuan' } },
  { file: 'a9-vv-explicit-shaanxi', speaker: VV, additions: { explicit_dialect: 'shaanxi' } },
  { file: 'b1-vv-context-用天津话说', speaker: VV, additions: { context_texts: ['用天津话说'] } },
  { file: 'b2-vv-context-天津腔', speaker: VV, additions: { context_texts: ['模仿天津口音，说天津话'] } },
  { file: 'b3-vv-context-粤语', speaker: VV, additions: { context_texts: ['用粤语说'] } },
  { file: 'c1-xiaohe-基线', speaker: XIAOHE, additions: {} },
  { file: 'c2-xiaohe-explicit-tianjin', speaker: XIAOHE, additions: { explicit_dialect: 'tianjin' } },
  { file: 'c3-xiaohe-explicit-dongbei', speaker: XIAOHE, additions: { explicit_dialect: 'dongbei' } },
]

console.log('方言探针2（新文本，排除缓存）：\n')
for (const c of cases) {
  try {
    const { mp3, serverErr } = await synth({ speaker: c.speaker, additions: c.additions })
    const file = path.join(outDir, c.file + '.mp3')
    writeFileSync(file, mp3)
    console.log('  ✓ ' + c.file + '  bytes=' + mp3.length + ' 时长≈' + ((mp3.length * 8) / 64000).toFixed(2) + 's' + (serverErr ? ' | err=' + serverErr : ''))
  } catch (error) {
    console.log('  ✗ ' + c.file + '  ' + String(error && error.message || error).slice(0, 200))
  }
}
console.log('\n试听目录：' + outDir)
