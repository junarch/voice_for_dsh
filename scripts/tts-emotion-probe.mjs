#!/usr/bin/env node
/* =====================================================================
 * 🎭 情绪化 TTS 指令效果测试探针
 *
 * 为什么做这一轮（来自第一轮试听的教训）：
 *   - 第一轮的测试文本太平淡（"你好，这是测试。"），情绪指令的效果听不出来，
 *     当时实测反馈"文本本身太平淡了，听不太出来区别"。
 *   - 所以这一轮准备了 3 段【情绪强烈】的文本（狂喜 / 悲伤安慰 / 愤怒质问），
 *     每段单独一个目录，每段都先播一遍【无指令基线】，再做对照。
 *
 * 每段文本的对照矩阵（文件都按编号排好，方便按顺序听）：
 *   01-基线-无指令-vv.mp3        没有任何指令，纯文本（对照基准）
 *   02-温柔语气-vv.mp3           context_texts: 轻声温柔地说
 *   03-俏皮语气-vv.mp3           context_texts: 用俏皮可爱的语气说
 *   04-慢速语速-vv.mp3           context_texts: 用非常慢的语速说话
 *   05-基线-无指令-xiaohe.mp3    换音色（小何，台湾腔）再看基线
 *   06-温柔语气-xiaohe.mp3       小何 + 温柔指令
 *
 * 判读要点（听的时候对照着看）：
 *   指令有没有用 = 该指令文件 和 01/05 基线 的【语气】差别大不大
 *   （长度差别是次要的；重点是 温柔/俏皮/慢 的"感觉"是否到位）
 *
 * 用法（VS Code 终端里跑）：
 *   node scripts/tts-emotion-probe.mjs            # 真实外呼（花几分钱）
 *   node scripts/tts-emotion-probe.mjs --dry-run  # 只打印计划，不花一分钱（推荐先跑这个）
 *   node scripts/tts-emotion-probe.mjs --key xxx  # 不用 settings.yaml 里的 key
 *
 * 音频输出到：tmp/probe-emotion/<文本序号>-<情绪名>/ 下
 * 试听结果在本目录 _note.txt 里记录；如需留档请并入 docs/testing.md（每段文本一节，直接往里写）
 * ===================================================================== */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 1. 参数 ----------
const DRY = process.argv.includes('--dry-run')
const argKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null
const key = argKey || (() => {
  try {
    const s = readFileSync(path.join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    return /volcengine:\s*\n\s*apiKey:\s*(\S+)/.exec(s)?.[1]
  } catch { return undefined }
})()
if (!DRY && !key) { console.error('未找到 apiKey：用 --key <api-key> 或在 settings.yaml 配置 voice.tts.volcengine.apiKey'); process.exit(1) }

// ---------- 2. 测试素材：3 段情绪强烈的文本 ----------
// 每段文本都尽量"自带情绪"（感叹号/反问/语气词），这样指令的效果才听得出来。
const TEXTS = [
  { dir: '01-狂喜', text: '天哪！我简直不敢相信！我终于通过了！这场准备了整整一年的考试，我居然一次就过了！我激动得手都在发抖，真想立刻冲出去大喊大叫，告诉全世界这个好消息！' },
  { dir: '02-悲伤安慰', text: '别哭了，好不好？我知道你心里特别难受，我都懂。没关系的，真的没关系，你还有我呢。想哭就靠在我肩膀上哭一会儿，哭完了，我带你去吃你最喜欢的那家店，好不好？' },
  { dir: '03-愤怒质问', text: '你知不知道这件事有多严重？我叮嘱过你多少遍了，你一次都没放在心上！现在出了这么大的纰漏，你让我怎么跟客户交代？立刻给我一个解释，现在，马上！' },
]

// 音色常量（火山文档里的 id）
const VV = 'zh_female_vv_uranus_bigtts'          // Vivi（第一轮主力测试音色）
const XIAOHE = 'zh_female_xiaohe_uranus_bigtts'  // 小何（试听反馈：有台湾腔、听感自然）

// 对照矩阵：每段文本都按这个清单合成（文件名 = 编号-标签）
// { file, speaker, additions }  —— additions 为空 = 无指令基线
function matrixFor(text) {
  return [
    { file: '01-基线-无指令-vv', speaker: VV, additions: {} },
    { file: '02-温柔语气-vv', speaker: VV, additions: { context_texts: ['轻声温柔地说'] } },
    { file: '03-俏皮语气-vv', speaker: VV, additions: { context_texts: ['用俏皮可爱的语气说'] } },
    { file: '04-慢速语速-vv', speaker: VV, additions: { context_texts: ['用非常慢的语速说话'] } },
    { file: '05-基线-无指令-xiaohe', speaker: XIAOHE, additions: {} },
    { file: '06-温柔语气-xiaohe', speaker: XIAOHE, additions: { context_texts: ['轻声温柔地说'] } },
  ]
}

// ---------- 3. 合成（或被 dry-run 跳过） ----------
const outRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'probe-emotion')
let planCount = 0

async function synth(text, speaker, additionsObj) {
  const reqBody = {
    user: { uid: 'dsh-voice-probe' },
    req_params: {
      text, speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 },
      ...(Object.keys(additionsObj).length ? { additions: JSON.stringify(additionsObj) } : {}),
    },
  }
  const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': 'seed-tts-2.0' },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) { console.error('    HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 120)); return null }
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
      else { console.error('    frame error: ' + JSON.stringify(frame).slice(0, 120)); return null }
    }
  }
  return Buffer.concat(parts.map((b64) => Buffer.from(b64, 'base64')))
}

console.log(DRY ? '【干跑模式】只列计划，不会真正调用 TTS，也不建目录（0 花费）\n' : '【真实外呼】会花几分钱（约 18 次小请求 ≈ 2 个计费块）\n')
for (const t of TEXTS) {
  const dir = path.join(outRoot, t.dir)
  if (!DRY) mkdirSync(dir, { recursive: true }) // 干跑不建目录，避免留下空文件夹
  console.log('📂 ' + t.dir + '（' + t.text.length + ' 字）')
  console.log('   文本: ' + t.text)
  for (const v of matrixFor(t)) {
    planCount++
    const file = path.join(dir, v.file + '.mp3')
    if (DRY) {
      console.log('   [计划] ' + v.file + '.mp3' + (Object.keys(v.additions).length ? '  ← 指令: ' + JSON.stringify(v.additions.context_texts) : '  ← 无指令'))
      continue
    }
    const mp3 = await synth(t.text, v.speaker, v.additions)
    if (!mp3) { console.log('   FAIL ' + v.file + '.mp3（外呼失败，可能是 5 小时限额，稍后再试）'); continue }
    writeFileSync(file, mp3)
    const durSec = ((mp3.length * 8) / 64000).toFixed(2)
    console.log('   ✓ ' + v.file + '.mp3  时长≈' + durSec + 's')
  }
  console.log('')
}

if (DRY) {
  console.log('计划共 ' + planCount + ' 个文件，确认无误后去掉 --dry-run 再跑。')
} else {
  console.log('全部完成。试听目录：' + outRoot)
  console.log('试听结果请记录到本目录 _note.txt；如需留档并入 docs/testing.md')
}
