#!/usr/bin/env node
/**
 * auto-start 冒烟探针：在**真实机器**上验证「本地 TTS 服务托管」这一段——不启动 dsh、不花 API 费用。
 *
 * 做法：只注入一个替身 ctx（提供真实的 ctx.subprocess 等价物：本机进程 spawn），
 * 其余全部走真实实现（lib/local-supervisor.js 的路径推导 / 健康探测 / 拉起 / 回收），
 * 合成请求打的是真实本地服务。
 *
 * 用法：node scripts/local-autostart-probe.mjs [--port 8899] [--keep] [--stream]
 *   默认在 8899（演习端口）跑完整的"拉起 → 合成 → 回收"闭环，不碰 8880 上可能正在跑的服务；
 *   --port 8880 可对真实默认端口做同样的验证（要求该端口此刻空闲）。
 *   --keep  拉起后不回收（留给后续手工验证；用完请自己结束该进程）
 *   --stream 额外跑"分句流式"仿真：用插件真实的 splitForStream 切分真实转写稿（读转写缓存），
 *           逐段请求裸 PCM，量出首声延迟与总时长（docs/local-tts.md §4 实测表的复现手段）
 * 输出：每步结论 + 退出码（0=全通，1=有失败）
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createLocalSupervisor } = await import('../packages/dsh-plugin-voice/lib/local-supervisor.js')
const { splitForStream } = await import('../packages/dsh-plugin-voice/lib/index.js')
const pluginUrl = new URL('../packages/dsh-plugin-voice/lib/index.js', import.meta.url).href
const keep = process.argv.includes('--keep')
const portFlag = process.argv.indexOf('--port')
const port = portFlag > 0 && process.argv[portFlag + 1] ? Number(process.argv[portFlag + 1]) : 8899
let failed = 0
const check = (name, ok, detail) => {
  if (ok) console.log('  ok ' + name)
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')) }
}

// 最小替身：ctx.get('subprocess') 返回一个用 node:child_process 实现的受管 spawn（接口形状与 dsh 服务一致）
const spawns = []
const subprocessStub = {
  spawn: (spec) => {
    console.log('  · spawn argv=' + JSON.stringify(spec.argv) + ' cwd=' + spec.cwd)
    spawns.push(spec)
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, stdio: 'ignore' })
    return {
      done: new Promise((resolve) => child.on('close', (code, signal) => resolve({ exitCode: code, signal }))),
      collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      terminate: () => { try { child.kill() } catch { /* 已退出 */ } },
      waitForExit: async () => true,
    }
  },
}

const baseUrl = 'http://127.0.0.1:' + port + '/v1/audio/speech'
const ctx = { get: (name) => (name === 'subprocess' ? subprocessStub : undefined) }
const config = { tts: { local: { baseUrl, autoStart: true, pythonPath: '', voice: 'af_sarah', speed: 1, timeoutMs: 30000 } } }
const supervisor = createLocalSupervisor({ ctx, getConfig: () => config, pluginUrl })

console.log('端口 ' + port + '：拉起前状态（只读自检）')
const before = await supervisor.status()
console.log('   running=' + before.running + ' venvFound=' + before.venvFound + ' python=' + before.pythonPath)
check('自检能推导出解释器路径（venvFound）', before.venvFound === true, before)
if (before.running) {
  console.log('  ! 该端口已有服务在跑：本次只验证"复用"分支，不验证拉起/回收')
}

console.log('2) ensure()：没跑 → 拉起并等到就绪')
const t0 = Date.now()
const ready = await supervisor.ensure()
const seconds = ((Date.now() - t0) / 1000).toFixed(1)
console.log('   running=' + ready.running + ' started=' + ready.started + ' 耗时 ' + seconds + 's' + (ready.error ? ' error=' + ready.error : ''))
check('ensure 后服务在跑', ready.running === true, ready)
if (!before.running) {
  check('本次确实拉起了服务（started=true）', ready.started === true && spawns.length === 1, { started: ready.started, spawns: spawns.length })
  check('spawn 参数：解释器 + 服务脚本 + --port ' + port, spawns[0] && spawns[0].argv[2] === '--port' && spawns[0].argv[3] === String(port), spawns[0] && spawns[0].argv)
}

console.log('3) 真实合成一次（英文样例，验证整条链路可用）')
const res = await fetch(baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'kokoro', input: 'Auto start probe: the local engine is ready.', voice: 'af_sarah', speed: 1, response_format: 'wav' }),
}).catch((e) => ({ ok: false, status: 0, text: async () => String(e && e.message || e), arrayBuffer: async () => new ArrayBuffer(0) }))
const wav = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0)
check('合成返回 WAV（RIFF 魔数）', res.ok === true && wav.slice(0, 4).toString('ascii') === 'RIFF', { status: res.status, bytes: wav.length })

console.log('4) 复用语义：再 ensure 一次不应重复拉起')
const spawnsBeforeReuse = spawns.length
const again = await supervisor.ensure()
check('已在跑时不重启', again.running === true && again.started === false && spawns.length === spawnsBeforeReuse, { started: again.started, spawns: spawns.length })

if (process.argv.includes('--stream')) {
  console.log('5) 分句流式仿真（真实转写稿 + 插件真实切分 + 裸 PCM 逐段请求）')
  const cachePath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'voice-transcript-cache.json')
  let script = ''
  try {
    const entries = JSON.parse(readFileSync(cachePath, 'utf8'))
    const rows = Array.isArray(entries) ? entries : []
    const newest = rows.map((e) => (Array.isArray(e) ? e[1] : null)).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0]
    script = (newest && newest.transcript) || ''
  } catch { /* 无缓存：用内置样例 */ }
  if (!script) script = 'The local engine now streams segment by segment. '.repeat(20)
  const segments = splitForStream(script, 220) // 220 = voice.tts.local.segmentChars 默认值（与插件实际切分一致）
  console.log('   稿长 ' + script.length + ' 字符 → ' + segments.length + ' 段（段长 ' + segments.slice(0, 6).map((s) => s.length).join('/') + '…）')
  let firstAt = 0
  const t0 = Date.now()
  let pcmBytes = 0
  let sampleRate = 0
  for (let i = 0; i < segments.length; i++) {
    const r = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: segments[i], voice: 'af_sarah', speed: 1, response_format: 'pcm16' }),
    })
    if (!r.ok) { check('段 ' + (i + 1) + ' 合成成功', false, r.status); break }
    if (!sampleRate) sampleRate = Number(r.headers.get('X-Sample-Rate')) || 24000
    const buf = Buffer.from(await r.arrayBuffer())
    pcmBytes += buf.length
    if (i === 0) {
      firstAt = Date.now() - t0
      check('首段为裸 PCM（audio/pcm）且字节数为偶', r.headers.get('Content-Type') === 'audio/pcm' && buf.length % 2 === 0, { ctype: r.headers.get('Content-Type'), bytes: buf.length })
    }
  }
  const total = Date.now() - t0
  const audioSeconds = pcmBytes / 2 / sampleRate
  console.log('   首段就绪 ' + (firstAt / 1000).toFixed(1) + 's ｜ 全部合成 ' + (total / 1000).toFixed(1) + 's ｜ 音频总长 ' + audioSeconds.toFixed(1) + 's')
  check('首声延迟 < 5s（长稿也不必等整篇）', firstAt > 0 && firstAt < 5000, firstAt)
  check('合成快于播放（不会播到一半断粮）', total / 1000 < audioSeconds, { total: total / 1000, audioSeconds })
}

if (keep) {
  console.log('6) --keep：保留服务进程，不回收')
} else if (before.running) {
  console.log('6) 该端口本就有别人的服务：跳过回收验证（不误杀）')
} else {
  console.log('6) terminate()（模拟 dsh 退出回收）')
  supervisor.terminate()
  await new Promise((r) => setTimeout(r, 2000))
  const after = await supervisor.status()
  check('回收后服务不可达', after.running === false, after)
}

console.log('\n结果: ' + (failed ? failed + ' failed' : 'all passed'))
process.exit(failed ? 1 : 0)

