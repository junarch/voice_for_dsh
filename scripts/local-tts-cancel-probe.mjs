#!/usr/bin/env node
/**
 * local-tts-cancel-probe.mjs — 本地 TTS 服务"断连即停 + 不泄漏推理锁"探针。
 *
 * 回答的问题：客户端超时/点停止/重复点击之后，服务端是否还在算、是否还占着推理锁？
 * 历史故障（2026-09）：同步生成器 + list(infer(...)) 的服务端打断不了，
 * 125 字的整段请求被 abort 后仍算满 178.6s（1,999 CPU·秒），后续请求被拖到 166.6s 才出声；
 * Host 侧再叠加"整段兜底超时"就形成死循环——用户看到的就是"点了没声音、CPU 一直满载"。
 *
 * 判据（全部通过才 exit 0）：
 *   1. 整段 wav 请求被 abort 后，服务端在 ~1 个分块内收尾（总耗时远小于文本所需时长）；
 *   2. 中止后立刻发的流式请求能正常出声（锁没被孤儿占住）；
 *   3. 流式请求被 cancel 后再发一个，仍能正常出声（取消不会泄漏推理锁）。
 *
 * 用法：node scripts/local-tts-cancel-probe.mjs [--url http://127.0.0.1:8882/v1/audio/speech] [--repeat 5]
 * 默认打 8882（CosyVoice）；Kokoro 用 --url http://127.0.0.1:8880/v1/audio/speech。
 * 需要服务已在跑（先用 /health 探活）；CPU 合成较慢，一轮约 1-3 分钟。
 */

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const URL_ = argOf('--url', 'http://127.0.0.1:8882/v1/audio/speech')
const REPEAT = Number(argOf('--repeat', '5'))
const IS_COSY = /8882|cosyvoice/i.test(URL_)
const VOICE = IS_COSY ? 'dsh_default' : 'af_heart'
const MODEL = IS_COSY ? 'fun-cosyvoice3' : 'kokoro'
const ABORT_MS = 10000
const LONG = '这一段文本用来验证中止之后服务端是否还在整段合成。'.repeat(REPEAT)
const SHORT = IS_COSY ? '短句测试。' : 'Short probe sentence.'

const say = (m) => console.log(new Date().toTimeString().slice(0, 8), m)
const post = (body, signal) => fetch(URL_, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
})
const bodyOf = (text, format) => ({ model: MODEL, input: text, voice: VOICE, speed: 1, response_format: format, instruct: '' })

const failures = []
const expect = (ok, label, detail) => {
  console.log((ok ? '  ok  ' : ' FAIL ') + label + (detail === undefined ? '' : ' | ' + JSON.stringify(detail)))
  if (!ok) failures.push(label)
}
/** 发一个流式请求并返回"首个分块"耗时（读完第一块就主动 cancel，模拟客户端放弃）。 */
async function firstChunk(label, cancelAfter = true) {
  const t0 = Date.now()
  const res = await post(bodyOf(SHORT, 'pcm16'))
  const reader = res.body.getReader()
  const { value } = await reader.read()
  const seconds = (Date.now() - t0) / 1000
  if (cancelAfter) reader.cancel().catch(() => {})
  say(label + '：首块 ' + seconds.toFixed(1) + 's（' + (value ? value.length : 0) + ' 字节）')
  return seconds
}

say('探针目标 ' + URL_ + '（文本 ' + LONG.length + ' 字，' + ABORT_MS / 1000 + 's 后 abort 整段请求）')
const health = await fetch(URL_.replace(/\/v1\/audio\/speech$/, '/health')).catch(() => null)
if (!health || !health.ok) {
  console.error('服务未就绪：' + URL_ + '（先启动本地 TTS 服务）')
  process.exit(2)
}

// A) 整段 wav 请求 → 客户端 abort
const ac = new AbortController()
const t0 = Date.now()
const pA = post(bodyOf(LONG, 'wav'), ac.signal)
  .then((r) => r.arrayBuffer())
  .then((b) => ({ ok: true, bytes: b.byteLength }))
  .catch((e) => ({ ok: false, why: e.name }))
setTimeout(() => { say('A) 客户端 abort()'); ac.abort() }, ABORT_MS)

// B) 中止后立刻发流式请求（验证锁没被孤儿占住）
setTimeout(async () => {
  const dtB = await firstChunk('B) 中止后的流式请求')
  expect(dtB < 60, 'B) 中止后流式请求未被孤儿占锁（首块 < 60s）', dtB)

  // C) 流式请求被 cancel 后再发一个（验证取消不泄漏推理锁）
  const dtC = await firstChunk('C) 取消后的新流式请求')
  expect(dtC < 60, 'C) 取消后新请求仍能出声（推理锁未泄漏）', dtC)

  const resA = await pA
  const wall = (Date.now() - t0) / 1000
  expect(resA.ok === false, 'A) 整段请求确实被 abort（客户端已放弃）', resA)
  // 修复前：这个数字是文本所需的全量合成时长（125 字 ≈ 178s）；修复后应在 ~1-2 个分块内收尾
  expect(wall < 90, 'A) 服务端在 ~1 个分块内收尾（未继续算完整段）', wall.toFixed(1) + 's')
  console.log('\n结果: ' + (failures.length ? '失败 ' + failures.length + ' 项 -> ' + failures.join(' / ') : '全部通过'))
  process.exit(failures.length ? 1 : 0)
}, ABORT_MS + 2000)
