// 本地 Kokoro 音色（sid）与语速是否真的生效：直接调用 sherpa-onnx-node，不走插件。
// 零成本（纯本地），用不同 sid 合成同一句话，比较音频指纹与时长。
// 用法：node scripts/local-tts-probe.mjs [模型目录]
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(new URL('../packages/voice-for-dsh/package.json', import.meta.url))
const sherpa = require('sherpa-onnx-node')

const dir = process.argv[2] || path.join(os.homedir(), '.dsh', 'voice', 'models', 'kokoro-multi-lang-v1_1')
if (!existsSync(path.join(dir, 'model.onnx'))) {
  console.error('模型目录不存在或不完整：' + dir)
  process.exit(2)
}

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
const ruleFsts = [path.join(dir, 'date-zh.fst'), path.join(dir, 'number-zh.fst'), path.join(dir, 'phone-zh.fst')]
if (ruleFsts.every((p) => existsSync(p))) config.ruleFsts = ruleFsts.join(',')

const text = '你好，这是本地音色测试。'
const tts = await sherpa.OfflineTts.createAsync(config)
console.log('numSpeakers=' + tts.numSpeakers + ' sampleRate=' + tts.sampleRate)

function stamp(samples) {
  const f32 = Float32Array.from(samples)
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
  return { hash: createHash('sha1').update(buf).digest('hex').slice(0, 12), samples: f32.length, seconds: +(f32.length / tts.sampleRate).toFixed(2) }
}

async function run(label, obj) {
  const audio = await tts.generateAsync(obj)
  const s = stamp(audio.samples)
  console.log(label.padEnd(28) + ' hash=' + s.hash + ' samples=' + s.samples + ' (' + s.seconds + 's)')
  return s.hash
}

// 三条路径：generationConfig.sid（插件当前用法）、顶层 sid（旧 API）、换 speed
const h0 = await run('generationConfig sid=0', { text, generationConfig: { sid: 0, speed: 1 } })
const h75 = await run('generationConfig sid=75', { text, generationConfig: { sid: 75, speed: 1 } })
const h48 = await run('generationConfig sid=48', { text, generationConfig: { sid: 48, speed: 1 } })
const hLegacy = await run('legacy top-level sid=75', { text, sid: 75, speed: 1 })
const hSpeed = await run('generationConfig speed=1.5', { text, generationConfig: { sid: 75, speed: 1.5 } })

console.log('')
console.log('sid 生效（0/48/75 互不相同）：' + (h0 !== h75 && h48 !== h75 && h0 !== h48))
console.log('顶层 sid 生效：' + (hLegacy === h75 ? '与 generationConfig 结果一致' : '与 generationConfig 结果不一致'))
console.log('speed 生效：' + (hSpeed !== h75))
