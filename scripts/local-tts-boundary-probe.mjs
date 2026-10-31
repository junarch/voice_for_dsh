// 断句听感排查：整段一次合成 vs 逐句分别合成（拼起来），量停顿位置与首尾静音。
// 零成本、纯本地。用法：node scripts/local-tts-boundary-probe.mjs [模型目录]
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(new URL('../packages/voice-for-dsh/package.json', import.meta.url))
const sherpa = require('sherpa-onnx-node')

const dir = process.argv[2] || path.join(os.homedir(), '.dsh', 'voice', 'models', 'kokoro-multi-lang-v1_1')
if (!existsSync(path.join(dir, 'model.onnx'))) { console.error('模型目录不存在：' + dir); process.exit(2) }

const config = {
  model: {
    kokoro: {
      model: path.join(dir, 'model.onnx'),
      voices: path.join(dir, 'voices.bin'),
      tokens: path.join(dir, 'tokens.txt'),
      dataDir: path.join(dir, 'espeak-ng-data'),
      lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
    },
    numThreads: 4,
    provider: 'cpu',
  },
  maxNumSentences: 1,
  numThreads: 4,
}
const rules = ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map((n) => path.join(dir, n))
if (rules.every((p) => existsSync(p))) config.ruleFsts = rules.join(',')

const tts = await sherpa.OfflineTts.createAsync(config)

const S1 = '先说结论，这次改动没有引入新的依赖。'
const S2 = '中间这段解释一下为什么这么处理，主要是为了少写盘。'
const S3 = '最后提醒一句，重启之后才会生效。'
const WHOLE = S1 + S2 + S3

function frames(samples, sampleRate) {
  const size = Math.round(sampleRate * 0.01)
  const out = []
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0
    for (let j = 0; j < size; j++) sum += samples[i + j] * samples[i + j]
    out.push(Math.sqrt(sum / size))
  }
  return out
}
function silenceInfo(samples, sampleRate) {
  const f = frames(samples, sampleRate)
  const peak = f.reduce((m, v) => Math.max(m, v), 0)
  const th = Math.max(0.004, peak * 0.06)
  let lead = 0
  while (lead < f.length && f[lead] < th) lead++
  let tail = 0
  while (tail < f.length && f[f.length - 1 - tail] < th) tail++
  const gaps = []
  let start = -1
  for (let i = 0; i < f.length; i++) {
    const silent = f[i] < th
    if (silent && start < 0) start = i
    if (!silent && start >= 0) {
      const ms = (i - start) * 10
      if (ms >= 120) gaps.push({ at: +(start * 0.01).toFixed(2), ms })
      start = -1
    }
  }
  return { leadMs: lead * 10, tailMs: tail * 10, gaps, sec: +(samples.length / sampleRate).toFixed(2) }
}
function concat(list) {
  const total = list.reduce((n, a) => n + a.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const a of list) { out.set(a, off); off += a.length }
  return out
}

async function synth(text) {
  const a = await tts.generateAsync({ text, generationConfig: { sid: 48, speed: 1 } })
  return a.samples
}

async function main() {
  const whole = await synth(WHOLE)
  const wi = silenceInfo(whole, 24000)
  console.log('A 整段一次合成：' + wi.sec + 's · 首静音 ' + wi.leadMs + 'ms · 尾静音 ' + wi.tailMs + 'ms · 停顿 ' + wi.gaps.length + ' 处 ' + JSON.stringify(wi.gaps))

  const parts = []
  const each = []
  for (const s of [S1, S2, S3]) {
    const a = await synth(s)
    each.push(silenceInfo(a, 24000))
    parts.push(a)
  }
  const joined = concat(parts)
  const ji = silenceInfo(joined, 24000)
  console.log('B 逐句合成再拼接：' + ji.sec + 's · 停顿 ' + ji.gaps.length + ' 处 ' + JSON.stringify(ji.gaps))
  console.log('   单句首尾静音：' + each.map((x, i) => 'S' + (i + 1) + ' ' + x.leadMs + '/' + x.tailMs + 'ms').join('  '))

  console.log('')
  console.log('结论参考：')
  console.log('  整段 vs 拼接 总时长差 = ' + (ji.sec - wi.sec).toFixed(2) + 's')
  console.log('  拼接边界额外静音 ≈ ' + Math.round(each.slice(0, -1).reduce((n, x) => n + x.tailMs, 0)) + 'ms（每段尾部）+ '
    + Math.round(each.slice(1).reduce((n, x) => n + x.leadMs, 0)) + 'ms（每段头部）')
}

await main()
