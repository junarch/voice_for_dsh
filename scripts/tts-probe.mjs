#!/usr/bin/env node
/**
 * 火山豆包 seed-tts-2.0 单向接口行为探针 -- 验证 context_texts 指令通道。
 * 端点默认 plan 网关（智能体套餐）；`--gateway standard` 走标准付费端点（新版控制台 Key，同 X-Api-Key 格式），
 * `--url <endpoint>` 走自定义/转接端点。
 *
 * 背景（两轮调研的完整结论）：
 *   1. 内嵌 [#...] 标签：plan 端点不解析，会当正文逐字照读（本项目探针 + 旧项目
 *      独立实测双重印证）。
 *   2. 官方指令通道：req_params.additions.context_texts（数组）。旧项目
 *      把 [#指令内容] 提取成纯文本后从这里传入，实测有效；
 *      其注释还记录了三个官方行为：指令文本不参与计费、仅第一个值有效。
 *
 * 本探针用同一句话做对照实验，每个 case 都保存 mp3 到 tmp/probe-<时间戳>/ 供人工试听：
 *   A1/A2 基线跑两次        -- 估计“同一请求跑两次”的自然波动（噪声底）
 *   B   + context_texts 温柔语气 -- 时长应≈基线（指令不该被读出来）；音色变化请试听
 *   C   + context_texts 慢速语速 -- 若指令生效，时长应显著变长（可计量的证据）
 *   D   内嵌 [#标签]          -- 若标签被照读，时长约为基线 2 倍以上（可计量的证据）
 *   E   + context_texts 东北话   -- 方言指令是否生效（请试听）
 *   F   + context_texts 组合指令 -- 方言+语气合并成一条（插件将要采用的形态，请试听）
 *
 * 用法：node scripts/tts-probe.mjs [--key <api-key>] [--gateway plan|standard] [--url <endpoint>]
 *   不给 --key 时从 %USERPROFILE%\.dsh\settings.yaml 的 voice.tts.volcengine.apiKey 读取。
 * 花费：7 次真实外呼，总字符 <120 ≈ 1~2 个计费块（分币级）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null
const argGateway = process.argv.includes('--gateway') ? process.argv[process.argv.indexOf('--gateway') + 1] : 'plan'
const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : ''
const GATEWAY_ENDPOINTS = {
  plan: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
  standard: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
}
const ENDPOINT = argUrl || GATEWAY_ENDPOINTS[argGateway] || GATEWAY_ENDPOINTS.plan
const key = argKey || (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!key) { console.error('未找到 apiKey：用 --key <api-key> 或在 settings.yaml 配置 voice.tts.volcengine.apiKey'); process.exit(1) }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'probe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
mkdirSync(outDir, { recursive: true })

const SPEAKER = 'zh_female_vv_uranus_bigtts'
const BASE = '你好，这是测试。'

async function synth(name, text, additionsObj = {}) {
  const reqBody = {
    user: { uid: 'dsh-voice-probe' },
    req_params: {
      text, speaker: SPEAKER,
      audio_params: { format: 'mp3', sample_rate: 24000 },
      ...(Object.keys(additionsObj).length ? { additions: JSON.stringify(additionsObj) } : {}),
    },
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0' },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) { console.error(name, 'HTTP', res.status, (await res.text().catch(() => '')).slice(0, 150)); process.exit(1) }
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
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      const code = typeof frame.code === 'number' ? frame.code : 0
      if (code === 0) { if (frame.data) parts.push(frame.data) }
      else if (code === 20000000) break
      else { console.error(name, 'frame error', JSON.stringify(frame).slice(0, 150)); process.exit(1) }
    }
  }
  const mp3 = Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64')))
  const file = path.join(outDir, name + '.mp3')
  writeFileSync(file, mp3)
  const durSec = (mp3.length * 8) / 64000 // bit_rate 默认 64000 的估算
  return { name, bytes: mp3.length, durSec: +durSec.toFixed(2), file }
}

console.log('音频将保存到：' + outDir + '\n')
const rows = []
const cases = [
  ['A1-基线', BASE, {}],
  ['A2-基线再跑一次', BASE, {}],
  ['B-指令-温柔语气', BASE, { context_texts: ['用温柔亲切轻声细语的语气说'] }],
  ['C-指令-慢速语速', BASE, { context_texts: ['用非常慢的语速说话'] }],
  ['D-内嵌标签-压低声音', '[#压低声音、带着温柔的笑意说]' + BASE, {}],
  ['E-指令-东北话', BASE, { context_texts: ['用东北话说'] }],
  ['F-指令-组合-东北话加暧昧', BASE, { context_texts: ['用东北话说，语气温柔暧昧轻声细语'] }],
]
for (const [name, text, additions] of cases) {
  const r = await synth(name, text, additions)
  rows.push(r)
  console.log(r.name.padEnd(16), '时长≈' + r.durSec + 's', ' bytes=' + r.bytes)
}

const by = (n) => rows.find((r) => r.name.startsWith(n))
const a1 = by('A1'), a2 = by('A2'), c = by('C'), d = by('D')
console.log('\n---- 自动判读（时长证据；B/E/F 的音色/方言效果请亲自试听 mp3）----')
if (a1 && a2) console.log('噪声底：A1=' + a1.durSec + 's vs A2=' + a2.durSec + 's（同请求两次的波动）')
if (c && a1) {
  const ratio = c.durSec / a1.durSec
  console.log('C(慢速指令) / A1 = ' + ratio.toFixed(2) + 'x -> context_texts 指令' + (ratio > 1.3 ? '【生效】（时长显著变长）' : '【疑似未生效】（时长接近基线，请试听确认）'))
}
if (d && a1) {
  const ratio = d.durSec / a1.durSec
  console.log('D(内嵌标签) / A1 = ' + ratio.toFixed(2) + 'x -> 内嵌标签' + (ratio > 1.7 ? '【被照读】（时长随标签字数显著变长；请试听 D 确认开头是否念出了标签）' : '【疑似被解析】（时长接近基线，请试听确认）'))
}
console.log('\n请打开文件夹逐个试听（Windows 资源管理器双击即可）：')
for (const r of rows) console.log('  ' + r.file)
