#!/usr/bin/env node
/**
 * 方言专项探针：确认 2.0 音色（vv）到底怎么触发各地方言。
 *
 * 背景矛盾：
 *   - 音色列表文档 1257544：vv 支持 8 种方言（粤/上海/河南/北京/天津/四川/陕西/东北）。
 *   - API 参数文档 1329505：explicit_dialect 仅 vv 支持 dongbei/sichuan/shaanxi 3 种。
 *   用户实测四川/陕西正常，天津话"有天津人的说话方式但没口音"。
 *   本探针逐个测：explicit_dialect 传 tianjin 是否报错、context_texts 自然语言指令是否有效。
 *
 * 用法：node scripts/tts-dialect-probe.mjs [--key <api-key>] [--all]
 *   音频存 tmp/dialect-probe-<时间戳>/ 供人工试听。
 * 花费：每 case 一次真实外呼（文本很短，分币级）。
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
if (!key) { console.error('未找到 apiKey：用 --key <api-key> 或在 settings.yaml 配置 voice.tts.volcengine.apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'dialect-probe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const VV = 'zh_female_vv_uranus_bigtts'
const XIAOHE = 'zh_female_xiaohe_uranus_bigtts'

// 文本：日常句子，各地方言差异主要在语气词/词汇/口音上
const TEXT = '今天这天气可真不错，咱们一起去吃个饭吧，我跟你说啊，这事儿啊就这么定了。'

/** HTTP 单向合成（plan 网关），返回 Buffer 或抛错 */
async function synth({ speaker, additions, text = TEXT, label }) {
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
  const mp3 = Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64')))
  return { mp3, serverErr }
}

const cases = [
  // —— 对照：无方言基线 ——
  { file: '01-vv-基线-无方言', speaker: VV, additions: {} },
  // —— explicit_dialect 逐个试（文档只保证 3 种，试天津/粤/上海/河南/北京是否报错）——
  { file: '02-vv-explicit-dialect-tianjin', speaker: VV, additions: { explicit_dialect: 'tianjin' } },
  { file: '03-vv-explicit-dialect-yue', speaker: VV, additions: { explicit_dialect: 'yue' } },
  { file: '04-vv-explicit-dialect-dongbei', speaker: VV, additions: { explicit_dialect: 'dongbei' } }, // 已知可用对照
  { file: '05-vv-explicit-dialect-sichuan', speaker: VV, additions: { explicit_dialect: 'sichuan' } }, // 用户确认正常
  { file: '06-vv-explicit-dialect-shaanxi', speaker: VV, additions: { explicit_dialect: 'shaanxi' } }, // 用户确认正常
  // —— context_texts 自然语言指令（另一条候选通道）——
  { file: '07-vv-context-用天津话说', speaker: VV, additions: { context_texts: ['用天津话说'] } },
  { file: '08-vv-context-用粤语说', speaker: VV, additions: { context_texts: ['用粤语说'] } },
  { file: '09-vv-context-天津味', speaker: VV, additions: { context_texts: ['模仿天津话的口音说话'] } },
  // —— 小何（文档也标 8 方言）对照 ——
  { file: '10-xiaohe-基线', speaker: XIAOHE, additions: {} },
  { file: '11-xiaohe-explicit-tianjin', speaker: XIAOHE, additions: { explicit_dialect: 'tianjin' } },
  { file: '12-xiaohe-context-用天津话说', speaker: XIAOHE, additions: { context_texts: ['用天津话说'] } },
]

console.log('方言专项探针（vv + 小何，plan 网关）：\n')
const results = []
for (const c of cases) {
  try {
    const { mp3, serverErr } = await synth({ speaker: c.speaker, additions: c.additions })
    const file = path.join(outDir, c.file + '.mp3')
    writeFileSync(file, mp3)
    const durSec = ((mp3.length * 8) / 64000).toFixed(2)
    results.push({ file: c.file, ok: true, bytes: mp3.length, dur: durSec, err: serverErr })
    console.log('  ✓ ' + c.file + '  bytes=' + mp3.length + ' 时长≈' + durSec + 's' + (serverErr ? ' | serverErr=' + serverErr : ''))
  } catch (error) {
    results.push({ file: c.file, ok: false, err: String(error && error.message || error).slice(0, 200) })
    console.log('  ✗ ' + c.file + '  ' + String(error && error.message || error).slice(0, 200))
  }
}

console.log('\n全部完成。试听目录：' + outDir)
