// 导出提示音候选样本（wav），供人耳挑选。零成本、纯本地。
// 合成公式与 lib/client.js 的 synthChimeBuffer 一致（本脚本是镜像，改那边要同步改这里）。
// 用法：node scripts/chime-samples.mjs [输出目录]
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const dir = process.argv[2] || path.join(process.cwd(), 'out', 'chime-samples')
mkdirSync(dir, { recursive: true })
const RATE = 48000

// 内置的五个工作音（雨滴 / 滴答 / 仪表盘 / 木鱼 / 轻叩）
const VARIANTS = {
  'work-a-raindrop': { total: 2.4, notes: [{ f: 523.25, t: 0, d: 0.26, g: 0.45 }, { f: 392.0, t: 1.2, d: 0.4, g: 0.4 }] },
  'work-b-ticktock': { total: 2.4, notes: [{ f: 1180, t: 0, d: 0.09, g: 0.42, p: [[1, 1], [2.4, 0.2]] }, { f: 880, t: 1.2, d: 0.1, g: 0.36, p: [[1, 1], [2.4, 0.2]] }] },
  'work-c-dashboard': { total: 3.2, notes: [
    { f: 1568, t: 0.00, d: 0.10, g: 0.42, p: [[1, 1], [2.4, 0.2]] },
    { f: 2093, t: 0.18, d: 0.08, g: 0.34 },
    { f: 1319, t: 0.42, d: 0.10, g: 0.40, p: [[1, 1], [3, 0.15]] },
    { f: 2637, t: 0.60, d: 0.07, g: 0.28, noise: 0.18 },
    { f: 1760, t: 0.88, d: 0.09, g: 0.36 },
    { f: 2349, t: 1.05, d: 0.08, g: 0.30 },
    { f: 1397, t: 1.32, d: 0.12, g: 0.40, p: [[1, 1], [2.7, 0.2]] },
    { f: 1976, t: 1.55, d: 0.09, g: 0.32, noise: 0.12 },
    { f: 1568, t: 1.80, d: 0.10, g: 0.38 },
    { f: 2637, t: 2.02, d: 0.08, g: 0.26 },
    { f: 1760, t: 2.30, d: 0.11, g: 0.34, p: [[1, 1], [2.2, 0.2]] },
    { f: 2093, t: 2.55, d: 0.09, g: 0.30 },
  ] },
  'work-d-woodfish': { total: 2.4, notes: [{ f: 760, t: 0, d: 0.14, g: 0.5, p: [[1, 1], [2.7, 0.22], [5.3, 0.1]] }, { f: 760, t: 1.2, d: 0.14, g: 0.4, p: [[1, 1], [2.7, 0.22]] }] },
  'work-e-softtap': { total: 2.4, notes: [{ f: 520, t: 0, d: 0.2, g: 0.45, p: [[1, 1], [2.2, 0.28]] }, { f: 520, t: 1.2, d: 0.16, g: 0.12, p: [[1, 1], [2.2, 0.2]] }] },
  // 参考项目那种"柔和钟片"的仿做（供比较；不稳定泛音 + 长尾 + 软起音）
  'candidate-soft-bell': { total: 2.4, notes: [{ f: 587, t: 0, d: 1.3, g: 0.22, p: [[1, 1], [2.76, 0.35], [5.4, 0.12], [8.9, 0.05]] }] },
  'candidate-soft-bell-2': { total: 2.4, notes: [{ f: 880, t: 0, d: 1.1, g: 0.18, p: [[1, 1], [2.4, 0.3], [4.7, 0.1]] }, { f: 1174, t: 0.12, d: 0.9, g: 0.1, p: [[1, 1], [2.4, 0.25]] }] },
}

function render(spec) {
  const len = Math.round(spec.total * RATE)
  const data = new Float32Array(len)
  for (const note of spec.notes) {
    const partials = note.p || [[1, 1]]
    const start = Math.round(note.t * RATE)
    const dur = Math.max(1, Math.round(note.d * RATE))
    let noiseState = 0
    for (let i = 0; i < dur; i++) {
      const idx = start + i
      if (idx >= len) break
      const t = i / RATE
      const env = Math.exp(-4.5 * (i / dur))
      const attack = Math.min(1, t / 0.004)
      for (const [ratio, gain] of partials) {
        data[idx] += Math.sin(2 * Math.PI * note.f * ratio * t) * env * attack * note.g * gain
      }
      if (note.noise) {
        noiseState = noiseState * 0.6 + (Math.random() * 2 - 1) * 0.4
        data[idx] += noiseState * env * attack * note.g * note.noise
      }
    }
  }
  let peak = 0
  for (const v of data) peak = Math.max(peak, Math.abs(v))
  if (peak > 0.95) { const s = 0.95 / peak; for (let i = 0; i < len; i++) data[i] *= s }
  return data
}

function wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

for (const [name, spec] of Object.entries(VARIANTS)) {
  const file = path.join(dir, name + '.wav')
  writeFileSync(file, wav(render(spec)))
  console.log('写入 ' + path.basename(file))
}
console.log('\n输出目录：' + dir)
