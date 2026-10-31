// 导出 10 个代表音色的同句样本，供人耳横向比较（零成本、纯本地）。
// 用法：node scripts/local-tts-voice-samples.mjs [输出目录]
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const require = createRequire(new URL('../packages/voice-for-dsh/package.json', import.meta.url))
const sherpa = require('sherpa-onnx-node')
const dir = process.argv[2] || path.join(process.cwd(), 'out', 'voice-samples')
const modelDir = path.join(os.homedir(), '.dsh', 'voice', 'models', 'kokoro-multi-lang-v1_1')
if (!existsSync(path.join(modelDir, 'model.onnx'))) { console.error('模型未安装：' + modelDir); process.exit(2) }
mkdirSync(dir, { recursive: true })

const config = {
  model: {
    kokoro: {
      model: path.join(modelDir, 'model.onnx'),
      voices: path.join(modelDir, 'voices.bin'),
      tokens: path.join(modelDir, 'tokens.txt'),
      dataDir: path.join(modelDir, 'espeak-ng-data'),
      lexicon: [path.join(modelDir, 'lexicon-us-en.txt'), path.join(modelDir, 'lexicon-zh.txt')].join(','),
    },
    numThreads: 4,
    provider: 'cpu',
  },
  maxNumSentences: 1,
  numThreads: 4,
}
const tts = await sherpa.OfflineTts.createAsync(config)

const ZH = '这次改动没有引入新的依赖，主要是把设置项收拢了一下。重启之后才会生效。'
const EN = 'This change adds no new dependency. It mainly tidies up the settings page. Restart to apply.'

const PICKS = [
  { sid: 0, tag: 'en-af_maple', text: EN },
  { sid: 1, tag: 'en-af_sol', text: EN },
  { sid: 2, tag: 'en-bf_vale', text: EN },
  { sid: 3, tag: 'zh-zf_001', text: ZH },
  { sid: 48, tag: 'zh-zf_084', text: ZH },
  { sid: 57, tag: 'zh-zf_099', text: ZH },
  { sid: 58, tag: 'zh-zm_009', text: ZH },
  { sid: 66, tag: 'zh-zm_020', text: ZH },
  { sid: 75, tag: 'zh-zm_041', text: ZH },
  { sid: 102, tag: 'zh-zm_100', text: ZH },
]

function wav(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

for (const pick of PICKS) {
  const audio = await tts.generateAsync({ text: pick.text, generationConfig: { sid: pick.sid, speed: 1, silenceScale: 0.1 } })
  const file = path.join(dir, 'sid-' + String(pick.sid).padStart(3, '0') + '-' + pick.tag + '.wav')
  writeFileSync(file, wav(audio.samples, audio.sampleRate))
  console.log('写入 ' + path.basename(file) + '（' + (audio.samples.length / audio.sampleRate).toFixed(2) + 's）')
}
console.log('\n输出目录：' + dir)
