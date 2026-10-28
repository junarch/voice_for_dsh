// 本地 Kokoro 中文播报的"喘气感"排查：同一段文字按几种喂法合成，量静音间隙与语速。
// 零成本、纯本地。用法：node scripts/local-tts-rhythm-probe.mjs [模型目录]
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(new URL('../packages/dsh-plugin-voice/package.json', import.meta.url))
const sherpa = require('sherpa-onnx-node')

const dir = process.argv[2] || path.join(os.homedir(), '.dsh', 'voice', 'models', 'kokoro-multi-lang-v1_1')
if (!existsSync(path.join(dir, 'model.onnx'))) {
  console.error('模型目录不存在或不完整：' + dir)
  process.exit(2)
}

function buildConfig(maxSentences) {
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
    maxNumSentences: maxSentences,
    numThreads: 4,
  }
  const rules = ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map((n) => path.join(dir, n))
  if (rules.every((p) => existsSync(p))) config.ruleFsts = rules.join(',')
  return config
}

const TEXT = '这个方案我看过了，主要问题是配置没有落盘。我们先把它改成自动保存，然后再看试听的效果。'
const SPACED = Array.from(TEXT).join(' ')
const NO_PUNCT = TEXT.replace(/[，。、；：！？]/g, '')

/** 逐 10ms 帧算 RMS，返回 {seconds, gaps:[{at,ms}], longestMs, speechSec} */
function analyze(samples, sampleRate) {
  const frame = Math.round(sampleRate * 0.01)
  const frames = []
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0
    for (let j = 0; j < frame; j++) sum += samples[i + j] * samples[i + j]
    frames.push(Math.sqrt(sum / frame))
  }
  const peak = frames.reduce((m, v) => Math.max(m, v), 0)
  const threshold = Math.max(0.004, peak * 0.06)
  const gaps = []
  let runStart = -1
  for (let i = 0; i < frames.length; i++) {
    const silent = frames[i] < threshold
    if (silent && runStart < 0) runStart = i
    if (!silent && runStart >= 0) {
      const ms = (i - runStart) * 10
      if (ms >= 120) gaps.push({ at: +(runStart * 0.01).toFixed(2), ms })
      runStart = -1
    }
  }
  if (runStart >= 0) {
    const ms = (frames.length - runStart) * 10
    if (ms >= 120) gaps.push({ at: +(runStart * 0.01).toFixed(2), ms })
  }
  const totalSec = samples.length / sampleRate
  const silenceSec = gaps.reduce((s, g) => s + g.ms, 0) / 1000
  return { totalSec: +totalSec.toFixed(2), gaps, longestMs: gaps.reduce((m, g) => Math.max(m, g.ms), 0), speechSec: +(totalSec - silenceSec).toFixed(2) }
}

async function run(label, tts, text) {
  const t0 = Date.now()
  const audio = await tts.generateAsync({ text, generationConfig: { sid: 48, speed: 1 } })
  const a = analyze(audio.samples, audio.sampleRate)
  const chars = Array.from(text).filter((c) => !/\s/.test(c)).length
  console.log(label)
  console.log('  时长 ' + a.totalSec + 's（有声 ' + a.speechSec + 's）· 停顿 ' + a.gaps.length + ' 处 · 最长 ' + a.longestMs + 'ms · 语速 ' + (chars / a.speechSec).toFixed(1) + ' 字/秒 · 合成 ' + (Date.now() - t0) + 'ms')
  if (a.gaps.length) console.log('  停顿位置：' + a.gaps.slice(0, 12).map((g) => g.at + 's/' + g.ms + 'ms').join('  '))
  return a
}

const tts1 = await sherpa.OfflineTts.createAsync(buildConfig(1))
console.log('maxNumSentences=1（当前插件设置）')
await run('A 原文（带全角标点）', tts1, TEXT)
await run('B 每个字之间插入空格', tts1, SPACED)
await run('C 去掉全部标点', tts1, NO_PUNCT)

const tts4 = await sherpa.OfflineTts.createAsync(buildConfig(4))
console.log('\nmaxNumSentences=4')
await run('D 原文', tts4, TEXT)

const tts20 = await sherpa.OfflineTts.createAsync(buildConfig(20))
console.log('\nmaxNumSentences=20（整段一起）')
await run('E 原文', tts20, TEXT)

// 句间静音：GenerationConfig.silenceScale（Kokoro 支持与否看实测）
for (const scale of [0.8, 0.5, 0.2]) {
  const t0 = Date.now()
  const audio = await tts1.generateAsync({ text: TEXT, generationConfig: { sid: 48, speed: 1, silenceScale: scale } })
  const a = analyze(audio.samples, audio.sampleRate)
  console.log('F silenceScale=' + scale + ' → 时长 ' + a.totalSec + 's · 停顿 ' + a.gaps.length + ' 处 · 最长 ' + a.longestMs + 'ms · 合成 ' + (Date.now() - t0) + 'ms')
}

// 文本侧：把句末标点降级成逗号（只影响停顿，不改字词）
const TIGHT = TEXT.replace(/[。！？!?]/g, '，')
await run('G 句号→逗号', tts1, TIGHT)
// 只降级短句的句号（长句保留句号，避免一口气读太长）
const SHORT_TIGHT = TEXT.split(/(?<=[。！？])/).map((s) => (Array.from(s.replace(/[。！？]/g, '')).length <= 14 ? s.replace(/[。！？]/g, '，') : s)).join('')
await run('H 短句句号→逗号', tts1, SHORT_TIGHT)
// 句内标点换成空格（只留句末停顿）
await run('I 逗号/顿号→空格，句号保留', tts1, TEXT.replace(/[，、；：]/g, ' '))
// 全部标点换成空格/直接去掉
await run('J 全部标点→空格', tts1, TEXT.replace(/[，。、；：！？]/g, ' '))



