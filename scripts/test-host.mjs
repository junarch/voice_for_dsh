#!/usr/bin/env node
/* =====================================================================
 * 📖 给第一次接触代码的你：这个文件是什么？怎么用？（读完这段就能上手）
 * =====================================================================
 *
 * 【1. 这是什么文件？】
 *   .mjs 是一个 JavaScript 文件（.mjs 里的 "m" 代表 module，即"模块"，
 *   也就是"一个可以被人 import 引用的代码文件"）。JavaScript 是网页和
 *   Node.js 上最常用的编程语言。Node.js 是一个"让 JavaScript 脱离浏览器、
 *   直接在你电脑上运行"的程序--你已经装好了（终端里 node --version 能
 *   打印版本号就说明装好了）。
 *   一句话：本文件 = 一个用 JavaScript 写的"自动化体检脚本"，专门给
 *   语音插件的"服务端半"（lib/index.js，我们叫它 Host 半）做体检。
 *
 * 【2. 为什么需要它？】
 *   手动测试（打开网页、点按钮、用耳朵听）很贵，而且测不到内部：
 *   "听起来正常"不等于"没重复调 4 次 LLM"。这个脚本不用打开 dsh、
 *   不用浏览器、不花一分钱 API 费，1 秒左右跑完全部检查（总数见最后一行）。
 *
 * 【3. 怎么跑？（VS Code 完整步骤）】
 *   ① 用 VS Code 打开仓库文件夹（本仓库根目录）
 *   ② 顶部菜单"终端" -> "新建终端"（快捷键 Ctrl + ` ，就是 Esc 下面那个键）
 *      --底部会出现一个黑乎乎的输入框，这叫"终端"
 *   ③ 在终端里输入下面这行，然后按回车：
 *        node scripts/test-host.mjs
 *   ④ 看输出：每行 "ok xxx" 是一条检查通过；"FAIL xxx" 是一条检查失败；
 *      最后一行 "结果: N passed, M failed" 是总分。
 *      全部通过时终端最后是绿色的（exit code 0），有失败则是红色的。
 *
 * 【4. 失败了怎么办？】
 *   把终端输出整段复制，贴给 AI，问"为什么这条断言失败？"--
 *   千万不要看到 FAIL 就自己改断言让它变绿（那等于把体温计掰弯）。
 *   先搞清楚：是代码坏了（改代码），还是"事实快照"过期了（见第 5 条）。
 *
 * 【5. 最重要的一段：本测试集里的断言分两类（这是此前确认的洞见，已固化成本设计）
 *
 *   【A 类·不变量】我们自己的代码必须永远满足的要求，断言它永远合理：
 *      例：同一条消息读第二遍，不允许再调一次 LLM（防"转写 4 次烧 token"）。
 *      这类断言放心大胆地信。
 *
 *   【B 类·外部事实快照】对"火山 TTS 接口怎么表现"的记录，依据是某天的
 *      探针实测（scripts/tts-probe.mjs），它可能过时、甚至可能本来就是错的：
 *      例："请求 text 里不得出现 [#...] 标签"--依据是三轮
 *      探针 + 此前独立实测（两边结论一致，可信度高）；
 *      例："context_texts 传指令"--依据是此前项目经验 + 探针显示偶发时长变化，
 *      但效果不稳定（vv 音色上几乎无效果，xiaohe 上有）。
 *   推翻 B 类断言的正确姿势：
 *      ① 先跑 node scripts/tts-probe.mjs 拿新的实测证据（音频会存到 tmp\ 下，亲耳听）
 *      ② 证据确凿后，同时更新：本文件对应断言 + lib/index.js 实现 + docs/pipeline.md
 *      ③ 三处一起改，避免"文档说 A、代码做 B、测试断言 C"的精神分裂
 *   --记住：测试是"把今天的证据钉在墙上"，不是真理本身。
 * ===================================================================== */

/* =====================================================================
 * 下面是正式代码。即使看不懂每行 JS 语法也没关系，每个段落都有"这段在干嘛"
 * 的注释；想学的话按顺序读，注释比代码长是有意的。
 * ===================================================================== */

// import = 从 Node.js 自带的标准库里取工具。
// mkdtempSync 建一个一次性临时文件夹；rmSync 删文件夹。
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 【关键顺序】转写缓存写在 DSH_HOME（默认 ~/.dsh）下，插件代码在"被加载的
// 那一瞬间"就会去读它。所以必须先把 DSH_HOME 指到一个空临时目录，再 import
// 插件--顺序反了就会碰到你真实的缓存文件（那是脏数据，会污染测试结果）。
const home = mkdtempSync(path.join(tmpdir(), 'voice-test-'))
process.env.DSH_HOME = home

// await import(...) = 动态加载真实的插件文件（不是复制粘贴的副本！测的就是它）。
// Config = 插件导出的配置 schema（0.2.0 加载路径：插件用它在加载时解析原始配置，包括默认值与 volatile 引用）。
const { apply, Config, splitForStream } = await import('../packages/dsh-plugin-voice/lib/index.js')
// 双向流帧编解码（volcengine-ws.js 导出的纯函数，字节级单测用）
const { encodeFrame, decodeFrame, MSG, EV } = await import('../packages/dsh-plugin-voice/lib/volcengine-ws.js')
// 口播净化（speech-clean.js 纯函数）
const { sanitizeForSpeech } = await import('../packages/dsh-plugin-voice/lib/speech-clean.js')
// 音色 ↔ 语种/方言 兼容矩阵 + 配置归一（voice-compat.js 纯函数：归一/纠错/纠语言/引擎归一/音调）
const { normalizeVoiceConfig, correctSpeakerForLanguage, correctLanguageForSpeaker, VV_SPEAKER, EN_DEFAULT_SPEAKER, ttsProviderOf, pitchOf, isLocalProvider, localBlockKeyOf } = await import('../packages/dsh-plugin-voice/lib/voice-compat.js')
// 本地服务托管（local-supervisor.js 纯函数：路径推导 / 端点推导）
const { resolveLaunch } = await import('../packages/dsh-plugin-voice/lib/local-supervisor.js')
// 本仓库根（用于断言"已部署/未部署"两种分支）
const REPO_ROOT_FOR_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 断言工具：测试的"计分器" ----------
// 断言（assertion）= 一句"我宣称 X 应该为真"的检查。
// check("名字", 条件, 详情) ：条件为真记 1 分，为假记 1 个失败并打印详情。
let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')) }
}
// section = 分节标题，纯粹让输出好读。
function section(name) { console.log('\n== ' + name + ' ==') }

// ---------- mock（替身）基础设施 ----------
// "mock" = 用一个假货替换真实的外部服务，假货会"记账"（把每次调用记下来），
// 让我们能数出"到底调了几次、参数是什么"。这是管线测试的核心手法：
// 把不可数的"听感"换成可数的"调用记录"。

// 替身 1：LLM（转写模型）。真实世界里它要花钱、要几秒、结果随机；
// 替身瞬间返回、结果由我们剧本指定、每次调用都记账。
const llmState = {
  calls: [],       // 每次"成功拨通"的调用参数（数它的长度 = 花了几次钱）
  attempts: 0,     // 连"拨号失败"也计数（测降级路径用）
  streamOpts: [],  // 每次收到的完整请求（含 system prompt--验证 prompt 组装）
  responses: [],   // 剧本队列：每次"转写"调用弹出一条 { text, finish }；空则用默认值
  failAll: false,  // 设为 true = 模拟"LLM 服务挂了"
  failInstruction: false, // 设为 true = 只让"语音指令撰写"这次调用失败（测回退预设）
  resolveModelInfoFail: false, // 设为 true = 能力查询失败（测运行时兜底）
  rejectEffort: '',  // 设为某档位：prepareCall 对该 reasoningEffort 抛"不支持"错误（测降级链）
}
const llm = {
  // 插件只用到的这些方法，替身只需要它们；'rp/r-m1' 是"推理模型"（支持 minimal/low/medium/high，无 off）
  listProviders: () => [{ id: 'p1' }, { id: 'p2' }, { id: 'rp' }],
  listModels: async (p) => p === 'rp' ? [{ id: 'r-m1' }] : [{ id: p + '-m1' }, { id: p + '-m2' }],
  async resolveModelInfo(provider, model) {
    if (llmState.resolveModelInfoFail) throw new Error('mock resolveModelInfo down')
    if (model === 'r-m1') {
      return { reasoning: {
        efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
        defaultEffort: 'medium',
      } }
    }
    return {} // 非推理模型：无 reasoning 元数据
  },
  async prepareCall(config) {
    llmState.attempts++
    if (llmState.failAll) throw new Error('mock llm down')
    if (llmState.rejectEffort && config.reasoningEffort === llmState.rejectEffort) {
      throw new Error('provider "p" model "m" does not support reasoning effort "' + config.reasoningEffort + '"')
    }
    llmState.calls.push(config)
    return {
      config,
      // stream = 转写内容的流式返回。这里用"异步生成器"伪造：先吐正文，再吐结束原因。
      // 关键：转写管线会有【两种】 LLM 调用——
      //   ① 转写调用（system = 风格预设 prompt）
      //   ② 语音演绎指令调用（system 含"演绎指令"），输出一句话音指令，maxTokens=256
      // 替身靠 system 内容区分二者，分别给默认输出；剧本队列优先喂给转写调用。
      stream: (opts) => {
        llmState.streamOpts.push(opts)
        const isInstruction = typeof opts.system === 'string' && opts.system.includes('演绎指令')
        if (isInstruction && llmState.failInstruction) throw new Error('mock instruction down')
        const r = llmState.responses.length
          ? llmState.responses.shift()
          : (isInstruction ? { text: '用自然平稳的语气说\n中性\n4', finish: 'stop' } : { text: '默认转写结果', finish: 'stop' })
        return (async function* () {
          if (isInstruction) {
            // 指令/情感/强度是"三行结构"，必须整体一次性吐出（保留 \n），否则解析被破坏
            if (r.text) yield { type: 'text-delta', text: r.text }
          } else {
            // 转写稿按 \n 切成多个 delta，模拟真实流式
            const parts = String(r.text || '').split('\n').filter((s) => s.length > 0)
            for (const p of parts.length ? parts : [r.text]) {
              if (p) yield { type: 'text-delta', text: p }
            }
          }
          yield { type: 'finish', reason: { kind: r.finish || 'stop' } }
        })()
      },
    }
  },
}

// 替身 2：会话服务（存"AI 说过什么"的地方）。插件从这里捞消息原文。
const sessionsState = { sessions: {} }
const sessions = { get: (id) => sessionsState.sessions[id] }

// 替身 3：设置（配置）。插件不再自注册命名空间：字段由导出的 Config schema 声明，
// 加载时按 profile 条目的原始 config 解析成"volatile 引用"（作为 apply 的第二参交给插件）。
// 用户改设置走 ctx.settings.update('voice', patch)：深合并进原始 config，dsh-settings 校验后
// 把新快照直接提交进运行中的引用（不重挂插件）。替身按同一模型实现：
// 没有 register（旧 API 已移除）--若插件代码还调它，apply 就会抛 TypeError（这正是原缺陷）。
function deepMerge(target, patch) {
  const out = Object.assign({}, target)
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && target && typeof target[k] === 'object' && !Array.isArray(target[k])
      ? deepMerge(target[k], v) : v
  }
  return out
}
// volatile 引用用 Symbol.for('cosmokit.volatile.write') 作写入口（跨 ESM/CJS 副本共享的协议），
// 所以替身不需要引入 cosmokit 就能像 loader 那样提交新值。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function configRefs(value, path = []) {
  // 同 loader 的 volatileEntries：只收集引用，不深入引用内部的快照
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) return [{ path, ref: value }]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => configRefs(v, [...path, k]))
}
function resolveConfig(raw) {
  // 与 cordis resolveConfig 同一条路径：真 Config schema 补默认值 + 把 volatile 字段包成引用
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error('invalid voice config: ' + JSON.stringify(result.issues))
  return result.value
}
const settingsState = { raw: null, updates: [], resolveErrors: [] }
let liveConfig = null
const settings = {
  update: async (_ns, patch) => {
    settingsState.updates.push(patch)
    settingsState.raw = deepMerge(settingsState.raw, patch)
    try {
      const next = resolveConfig(settingsState.raw)
      for (const { path, ref } of configRefs(liveConfig)) {
        const source = path.reduce((v, k) => Reflect.get(v, k), next)
        ref[VOLATILE_WRITE](source.get()) // 与 loader._commitVolatile 一致：把候选快照提交进引用
      }
    } catch (error) { settingsState.resolveErrors.push(String((error && error.message) || error)) }
  },
}

// 替身 4：web 路由注册表。插件会把 /voice/api 和 /voice/audio 两个"处理器"
// 注册进来--我们把处理器存起来，就能像真的 HTTP 请求那样调用它们。
const routes = []
const webServer = { register: (r) => routes.push(r) }

// 替身 5：事件监听。插件用 ctx.on('session/event') 订阅会话事件；
// 我们把监听函数存起来，测试里就能"伪造"事件（turn 开始/结束等）。
const eventListeners = new Map()

// 替身 7：subprocess（进程托管）。local 引擎在播报前会 ensure 本地服务：已在跑就复用，
// 没跑就经 ctx.subprocess.spawn 拉起。替身不真的起进程，只记录 spawn 参数，
// 并允许测试决定"拉起后服务是否就绪"（healthOk）。
const subprocessState = { spawns: [], healthOk: false, terminateCalls: 0 }
function fakeHandle() {
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    stdin: undefined, stdout: undefined, stderr: undefined,
    collected: { stdout: reader(''), stderr: reader('') },
    done: new Promise(() => {}), // 永远不退出（模拟常驻服务）
    terminate: () => { subprocessState.terminateCalls++ },
    waitForExit: async () => true,
  }
}
const subprocess = {
  spawn: (spec) => {
    subprocessState.spawns.push(spec)
    subprocessState.healthOk = true // 拉起后服务就绪（测试可提前置 true 表示"已在跑"）
    return fakeHandle()
  },
}

const ctx = {
  get: (name) => (name === 'llm' ? llm : name === 'sessions' ? sessions : name === 'subprocess' ? subprocess : undefined),
  settings,
  webServer,
  on: (name, fn) => { if (!eventListeners.has(name)) eventListeners.set(name, []); eventListeners.get(name).push(fn) },
  effect: (fn) => { try { fn() } catch { /* 替身：dispose 回调不执行 */ } },
}

// 替身 6：fetch（网络电话）。插件调火山 TTS / 本地 Kokoro 用的是全局 fetch；
// 我们把它整个换成假货--不联网、立刻返回假音频，并记下"打了什么电话、说了什么"。
// 这就是为什么本测试零花费：外呼根本没发生，但请求体会被完整记下来供断言。
// 健康探测（GET /health）：由 subprocessState.healthOk 决定通/不通，驱动"自动启动"分支。
const realFetch = globalThis.fetch
const fetchState = { calls: [], nextOk: true, hang: false, never: false, localSegIndex: 0, localFailOnSegment: 0, localFailPcm: false, hangCount: 0, hangFail: false, hangReleasers: [] }
const LOCAL_TTS_URL = 'http://127.0.0.1:8880/v1/audio/speech' // 与 schema 默认值一致；URL 含此串即路由到 local 假响应
function fakeTtsResponse() {
  // 伪造"分块 JSON 行"响应：两段 base64 音频（解码后是 'ABC'/'DEF'）+ 结束帧。
  const enc = new TextEncoder()
  const lines = [JSON.stringify({ code: 0, data: 'QUJD' }), JSON.stringify({ code: 0, data: 'REVG' }), JSON.stringify({ code: 20000000 })].join('\n') + '\n'
  let off = 0
  return {
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (off >= lines.length) return { done: true, value: undefined }
          const v = enc.encode(lines.slice(off, off + 16))
          off += 16
          return { done: false, value: v }
        },
      }),
    },
    text: async () => '',
  }
}
function fakeLocalWavResponse() {
  // 伪造本地 Kokoro 服务响应：合法 WAV 头（'RIFF' 魔数）+ 占位数据，经 arrayBuffer() 消费。
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
  return {
    ok: true, status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === 'x-sample-rate' ? '24000' : null) },
    arrayBuffer: async () => bytes.buffer,
    text: async () => 'mock wav',
  }
}
function fakeLocalPcmResponse(segIndex) {
  // 伪造"裸 PCM"响应（分句流式：response_format=pcm16）：16bit 小端 mono，带 X-Sample-Rate。
  // 每个响应分两块吐字节（各 ≥0.5s 音频），用来验证 Host"边收边按 0.5s 切块入队"——
  // 一次段请求应当产出多个音频分块，而不是等整段算完才入队（首声延迟的关键）。
  const samples = 24000 * (segIndex + 1)
  const bytes = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((i / 24) * Math.PI) * 8000)
    bytes[i * 2] = v & 0xff
    bytes[i * 2 + 1] = (v >> 8) & 0xff
  }
  return {
    ok: true, status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === 'x-sample-rate' ? '24000' : null) },
    body: {
      getReader: () => {
        let sent = 0
        // 分两次吐字节：验证"按无数据间隔计时"的实现能吃多块响应体
        const half = Math.floor(bytes.length / 2)
        return {
          read: async () => {
            if (sent === 0) { sent = 1; return { done: false, value: bytes.slice(0, half) } }
            if (sent === 1) { sent = 2; return { done: false, value: bytes.slice(half) } }
            return { done: true, value: undefined }
          },
        }
      },
    },
    text: async () => 'mock pcm',
  }
}
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const parsedBodyEarly = init && init.body ? (() => { try { return JSON.parse(init.body) } catch { return null } })() : null
  const isHealth = target.includes('/health')
  if (isHealth) {
    if (!subprocessState.healthOk) throw new Error('fetch failed') // 模拟"服务没在跑"（连接被拒）
    return { ok: true, status: 200, text: async () => '{"ok":true}' }
  }
  if (fetchState.never && target.includes('127.0.0.1:8880') && parsedBodyEarly && parsedBodyEarly.response_format === 'pcm16') {
    // 模拟"段请求永远不返回"（服务卡死）：只受超时中止，验证段级超时（T22f）
    const signal = init && init.signal
    fetchState.hangCount++
    return await new Promise((_, reject) => {
      if (!signal) return
      if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      else signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  if (fetchState.hang && target.includes('127.0.0.1:8880')) {
    // 模拟"服务在跑但不响应"：挂住直到超时 abort（或以 500 落地），用于验证"段级超时"。
    // 记下本次挂起，测试可显式 releaseHang() 让请求以 500 收尾，避免与 pipeline 抢时序。
    const signal = init && init.signal
    fetchState.hangCount++
    return await new Promise((resolve, reject) => {
      const settle = () => { if (fetchState.hangFail) resolve({ ok: false, status: 500, text: async () => 'hang released', arrayBuffer: async () => new ArrayBuffer(0) }); else reject(new Error('fetch failed')) }
      fetchState.hangReleasers.push(settle)
      if (!signal) return
      if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      else signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  const isLocal = target.includes('127.0.0.1:8880') || target.includes('127.0.0.1:8882') // Kokoro 8880 / CosyVoice 8882
  const parsedBody = init && init.body ? JSON.parse(init.body) : null
  fetchState.calls.push({ url: target, local: isLocal, body: parsedBody })
  if (!fetchState.nextOk) return { ok: false, status: 500, body: null, text: async () => 'mock tts boom', arrayBuffer: async () => new ArrayBuffer(0) }
  if (isLocal) {
    // localFailPcm：所有流式段请求直接失败（验证"首段即失败 → 整段兜底"）
    if (fetchState.localFailPcm && parsedBody && parsedBody.response_format === 'pcm16') {
      fetchState.localSegIndex++
      return { ok: false, status: 500, text: async () => 'pcm endpoint boom', arrayBuffer: async () => new ArrayBuffer(0) }
    }
    // localFailOnSegment = N：第 N 个流式段（1-based）起返回 500（验证"中途失败保留已播段"）
    if (fetchState.localFailOnSegment && fetchState.localSegIndex + 1 >= fetchState.localFailOnSegment && parsedBody && parsedBody.response_format === 'pcm16') {
      fetchState.localSegIndex++
      return { ok: false, status: 500, text: async () => 'segment boom', arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if (parsedBody && parsedBody.response_format === 'pcm16') {
      const idx = fetchState.localSegIndex++
      return fakeLocalPcmResponse(idx)
    }
    return fakeLocalWavResponse()
  }
  return fakeTtsResponse()
}

// ---------- 把真插件"装配"到替身上，并做 HTTP 请求的仿真驱动 ----------
// 装配（apply(ctx, config)）在下方"测试数据"段里、初始配置解析之后调用；路由处理器随后再取。
let apiHandler
let audioHandler

// rpc = 模拟"浏览器向插件发 HTTP 请求"。和 curl 的区别：不用起服务器，直接调处理函数。
async function rpc(method, args, headers) {
  const body = JSON.stringify(args || {})
  const req = {
    method: 'POST', url: '/voice/api/' + method, headers: headers || {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
  }
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b || '') } }
  await apiHandler(req, res)
  try { return JSON.parse(res.body) } catch { return { ok: false, parseError: res.body, code: res.code } }
}
async function fetchAudio(id) {
  const req = { method: 'GET', url: '/voice/audio/' + id }
  const res = { code: 0, body: null, mime: '', writeHead(c, h) { this.code = c; if (h && h['Content-Type']) this.mime = h['Content-Type'] }, end(b) { this.body = b } }
  await audioHandler(req, res)
  return res
}
// fire = 伪造一条会话事件，喂给插件的事件监听器。
function fire(event) {
  for (const fn of eventListeners.get('session/event') || []) fn({ header: { id: 's1' } }, event)
}
const msgEvent = (id, turn, text) => ({ type: 'assistant/message', data: { turn, message: { id, content: [{ type: 'text', text }] } } })

// ---------- 测试数据：一份"用户配置"（原始 config）和几条"历史消息" ----------
// 这份原始 config 等价于 profile 条目 voice 的 config：加载时由真 Config schema 解析
// （补默认值 + 把 volatile 字段包成引用），解析结果才是 apply 的第二参。
settingsState.raw = {
  autoSpeak: false,
  autoSpeakCloudTts: false,
  language: 'auto',
  provider: 'p1',
  model: 'p1-m1',
  transcribe: { enabled: true, maxTokens: 8192, temperature: 0.3, prompt: '', reasoningEffort: 'off', stylePreset: 'companion', contextTurns: 0, timeoutMs: 60000 },
  tts: {
    provider: 'browser',
    browser: { rate: 1, pitch: 1, voice: '' },
    openaiCompatible: { baseUrl: '', apiKey: '', model: 'tts-1', voice: '', format: 'mp3' },
    volcengine: { apiKey: 'k-test', resourceId: 'seed-tts-2.0', speaker: 'spk-1', sampleRate: 24000, rateLevel: 2, pitchLevel: 2, interface: 'http', streaming: false },
  },
  stopOnNewTurn: true,
}

// 加载路径：原始 config → 真 Config schema（默认值 + volatile 引用）→ apply(ctx, config)。
// apply 若抛错（例如代码还去调已移除的 ctx.settings.register），先记下来，由 T0 断言并终止。
liveConfig = resolveConfig(settingsState.raw)
let applyError = null
try { apply(ctx, liveConfig) } catch (error) { applyError = error }
// apply 抛错时路由不存在（下面 T0 会先断言并给出可读报告，而不是在这里崩栈）
apiHandler = (routes.find((r) => r.path === '/voice/api') || {}).handler
audioHandler = (routes.find((r) => r.path === '/voice/audio') || {}).handler

const sessionEvents = [
    msgEvent('m1', 1, '原始回复内容'),
    msgEvent('m2', 2, '撞顶测试内容'),
    msgEvent('m3', 3, '# 降级测试\n```js\nlet x = 1\n```'),
    msgEvent('m4', 4, '火山链路内容'),
    msgEvent('m5', 5, 'TTS 失败链路内容'),
    msgEvent('m7', 11, '自动播报内容'),
    msgEvent('m8', 12, '门控测试内容'),
    msgEvent('m9', 13, '中断轮内容'),
    msgEvent('m10', 14, '双向流测试内容'),
    msgEvent('m11', 15, '双向流停止内容'),
    msgEvent('m12', 16, '双向流兜底内容'),
    msgEvent('m13', 17, '净化测试内容'),
    msgEvent('m14', 18, '归一化测试内容'),
    msgEvent('m15', 19, '流式缓存重播内容'),
    msgEvent('m16', 20, '重新生成测试内容'),
    msgEvent('m17', 21, '兜底完整性测试内容'),
    msgEvent('m6e', 22, '音调细粒度测试内容'),
    msgEvent('m6e0', 23, '音调正常测试内容'),
]
sessionsState.sessions.s1 = {
  header: { id: 's1' },
  // 与 DSH 0.1.2 一致：只暴露快照读取 API，禁止测试意外依赖已移除的 events 字段。
  snapshotEvents: () => Object.freeze([...sessionEvents]),
}

/* =====================================================================
 * A 类·不变量：我们代码自身必须永远成立的行为
 * （以下断言与外部接口无关，放心长期维护）
 * ===================================================================== */

section('T0 配置加载路径（导出的 Config schema → volatile 引用 → apply 第二参）')
// 这一节覆盖的是"插件能不能被装起来"：配置不再由插件自注册命名空间（旧 ctx.settings.register
// 已移除），而是由导出的 Config 声明、由运行时解析后作为 apply 的第二参传入。
// 替身故意不提供 settings.register —— 若实现退回旧写法，apply 立刻抛 TypeError。
check('替身不提供 settings.register（旧 API 已移除）', settings.register === undefined)
check('apply(ctx, resolvedConfig) 不抛错（对真实加载路径的冒烟）', applyError === null, applyError && String(applyError.stack || applyError))
if (applyError) {
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed（配置加载路径断了，后续断言无意义）')
  process.exit(1)
}
const defaultCfg = resolveConfig({})
check('空配置解析出全部默认值（tts 音色 / 转写上下文轮数 / 自动播报开关）',
  defaultCfg.tts.get().volcengine.speaker === 'zh_female_vv_uranus_bigtts' && defaultCfg.transcribe.get().contextTurns === 2 && defaultCfg.autoSpeak.get() === false,
  { speaker: defaultCfg.tts.get().volcengine.speaker, contextTurns: defaultCfg.transcribe.get().contextTurns, autoSpeak: defaultCfg.autoSpeak.get() })
check('volatile 引用 .get() 返回普通对象（cfg.tts.volcengine.speaker 同形可读）',
  typeof defaultCfg.tts.get() === 'object' && defaultCfg.tts.get().volcengine.speaker === 'zh_female_vv_uranus_bigtts' && defaultCfg.stopOnNewTurn.get() === true)
check('volatile 边界齐全（8 个顶层字段，缺一个设置页就写不进去）', configRefs(liveConfig).length === 8, configRefs(liveConfig).map((r) => r.path.join('.')))
// apiKey 有意不标 role=secret：dsh-settings 写入时会把非 volatile 的 secret 字段从落盘补丁里剥掉，
// 而设置页每次保存都整块重写该条目 config —— 标了 secret，用户第一次点保存就把 patch 里的 apiKey 删掉
// （docs/pipeline.md §6.0）。这条断言就是防止有人"顺手加回来"。
check('apiKey 不标 role=secret（标了会被设置页保存从落盘补丁里剥掉）',
  Config.dict.tts.dict.volcengine.dict.apiKey.meta.role === undefined,
  Config.dict.tts.dict.volcengine.dict.apiKey.meta.role)
check('当前配置（原始 config + 真 schema）读出用户自定义值', liveConfig.tts.get().volcengine.speaker === 'spk-1' && liveConfig.transcribe.get().stylePreset === 'companion')
// 设置写入 = 深合并进原始 config + 提交进运行引用（不重挂插件）；改完恢复原值，不留副作用
await settings.update('voice', { tts: { browser: { rate: 1.5 } } })
check('settings.update 直接提交进运行中的引用（无需重挂插件）', liveConfig.tts.get().browser.rate === 1.5, liveConfig.tts.get().browser.rate)
await settings.update('voice', { tts: { browser: { rate: 1 } } })
check('再次 update 恢复原值', liveConfig.tts.get().browser.rate === 1, liveConfig.tts.get().browser.rate)
check('替身没有解析失败残留（配置补丁全部合法）', settingsState.resolveErrors.length === 0, settingsState.resolveErrors)

section('T1 apply/路由注册')
check('注册了 /voice/api 与 /voice/audio 两条路由', routes.length === 2 && !!apiHandler && !!audioHandler)
check('ping', (await rpc('ping')).ok === true)

section('T1b 同源校验（CSRF 防护：跨站不得触发付费调用/改配置）')
const cr1 = await rpc('ping', {}, { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })
check('同源 POST（Origin host == Host）放行', cr1.ok === true, cr1)
const cr2 = await rpc('ping', {}, { origin: 'https://evil.example.com', host: '127.0.0.1:3080' })
check('跨站 POST（Origin 与 Host 不一致）拒绝 403', cr2.ok === false && cr2.error === 'cross-origin request rejected', cr2)
const cr3 = await rpc('ping', {}, { origin: 'http://localhost:3080', host: '127.0.0.1:3080' })
check('跨端口/跨 host（localhost vs 127.0.0.1）拒绝 403', cr3.ok === false && cr3.error === 'cross-origin request rejected', cr3)
const cr4 = await rpc('ping')
check('无 Origin 头（本地 curl/非浏览器）放行', cr4.ok === true, cr4)
const cr5 = await rpc('ping', { big: 'x'.repeat(1_000_001) })
check('请求体超 1MB 拒绝 413', cr5.ok === false && cr5.error === 'payload too large', cr5)

section('T3 重复朗读 = 缓存命中，LLM 调用数不变【防"转写 N 次"烧 token】')
// 剧本：让假 LLM 返回一段带 [#...] 标签的转写稿（模拟自定义 prompt/旧缓存残留）
llmState.responses = [{ text: '[#压低声音、带着温柔的笑意说] 温柔的转写结果', finish: 'stop' }]
const r1 = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
check('ok 且无 audioUrl（browser 透传）', r1.ok === true && r1.audioUrl === undefined)
check('LLM 输出的 [#...] 标签被剥离', r1.transcript === '温柔的转写结果', r1.transcript)
check('转写了 1 次 LLM', llmState.calls.length === 1)
const sysPrompt = llmState.streamOpts[0] && llmState.streamOpts[0].system
check('系统 prompt 为陪伴预设且不含 [#', !!sysPrompt && sysPrompt.includes('陪伴者') && !sysPrompt.includes('[#'))
const r1b = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
check('第二次朗读命中缓存（cached=true）', r1b.cached === true)
check('缓存命中后 LLM 调用数不变', llmState.calls.length === 1, llmState.calls.length)
check('缓存稿同样被剥离标签', r1b.transcript === '温柔的转写结果', r1b.transcript)

section('T4 撞顶空稿自动 4 倍额度重试【防"额度太小永远空稿"】')
llmState.responses = [{ text: '', finish: 'max-tokens' }, { text: '重试后的转写', finish: 'stop' }]
const r2 = await rpc('speak', { sessionId: 's1', messageId: 'm2' })
check('重试拿到正文', r2.ok === true && r2.transcript === '重试后的转写', r2.transcript)
check('LLM 调用 2 次（1 次撞顶 + 1 次 4x 重试）', llmState.calls.length === 3)
check('重试 maxTokens = 4 倍', llmState.calls[llmState.calls.length - 1].maxTokens === 8192 * 4, llmState.calls[llmState.calls.length - 1].maxTokens)

section('T5 转写失败降级直读（不许静默失败，也不许写脏缓存）')
llmState.failAll = true
const before = llmState.attempts
const r3 = await rpc('speak', { sessionId: 's1', messageId: 'm3' })
check('降级 ok 且 degraded=true（对用户可见）', r3.ok === true && r3.degraded === true)
check('降级稿剥离 Markdown/代码块（整块跳过，不朗读代码内容）', r3.transcript === '降级测试' && !r3.transcript.includes('```') && !r3.transcript.includes('let'), r3.transcript)
check('走了两次尝试（配置路由 + 发现路由）后放弃', llmState.attempts - before === 2)
llmState.failAll = false

section('T-effort 思考档位降级机制')
// 场景 1：推理模型 rp/r-m1 只支持 minimal/low/medium/high（无 off）→ 配置 off 自动降级 minimal 且对用户可见
await rpc('setConfig', { patch: { provider: 'rp', model: 'r-m1', transcribe: { reasoningEffort: 'off' } } })
const e1 = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
check('off → 自动降级为 minimal 再调用', llmState.calls[llmState.calls.length - 1].reasoningEffort === 'minimal', llmState.calls[llmState.calls.length - 1])
check('响应 effortMapped=true', e1.effortMapped === true)
check('响应带中文降级说明', typeof e1.effortNote === 'string' && e1.effortNote.includes('minimal'), e1.effortNote)
// 场景 2：模型支持的档位原样发送、不降级
await rpc('setConfig', { patch: { transcribe: { reasoningEffort: 'medium' } } })
const e2 = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
check('medium 原样发送', llmState.calls[llmState.calls.length - 1].reasoningEffort === 'medium', llmState.calls[llmState.calls.length - 1])
check('effortMapped=false', e2.effortMapped === false)
// 场景 3：非推理模型 p1/p1-m1 → 忽略档位字段，且对用户可见
await rpc('setConfig', { patch: { provider: 'p1', model: 'p1-m1', transcribe: { reasoningEffort: 'off' } } })
const e3 = await rpc('speak', { sessionId: 's1', messageId: 'm3' })
check('非推理模型不发 reasoningEffort 字段', llmState.calls[llmState.calls.length - 1].reasoningEffort === undefined)
check('非推理模型 effortMapped=true', e3.effortMapped === true)
// 场景 4：能力查询失败（未知）→ 原样发送 off 被拒 → 运行时按降级链兜底到 minimal
await rpc('setConfig', { patch: { provider: 'p2', model: 'p2-m1' } })
llmState.resolveModelInfoFail = true
llmState.rejectEffort = 'off'
const e4 = await rpc('speak', { sessionId: 's1', messageId: 'm3' })
check('能力未知 + off 被拒 → 运行时兜底成功', e4.ok === true && e4.effortMapped === true, e4)
check('运行时兜底用 minimal 成功', llmState.calls[llmState.calls.length - 1].reasoningEffort === 'minimal', llmState.calls[llmState.calls.length - 1])
llmState.resolveModelInfoFail = false
llmState.rejectEffort = ''
// 恢复默认路由，避免影响后续测试（T9 起的转写路由回到 p1/p1-m1）
await rpc('setConfig', { patch: { provider: 'p1', model: 'p1-m1', transcribe: { reasoningEffort: 'off' } } })

section('T9 自动播报事件管线（门控与消费）')
// 场景 0：把 TTS 切到云 provider（成本门控只对云 TTS 生效；browser 不计费无门控）
await rpc('setConfig', { patch: { tts: { provider: 'volcengine' } } })
// 场景 1：autoSpeak=false -> 无 pending
fire({ type: 'turn/start', data: { turn: 10 } })
fire(msgEvent('m6', 10, '不该播'))
fire({ type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })
check('autoSpeak=false 时无 pending', (await rpc('pollSpeak')).pending === null)
// 场景 2：开启（云 TTS 已允许）
await rpc('setConfig', { patch: { autoSpeak: true, autoSpeakCloudTts: true } })
check('getState 反映 autoSpeak=true', (await rpc('getState')).autoSpeak === true)
fire({ type: 'turn/start', data: { turn: 11 } })
fire(msgEvent('m7', 11, '自动播报内容'))
fire({ type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } })
const p1 = await rpc('pollSpeak')
check('completed 轮挂起播报 m7', p1.pending && p1.pending.messageId === 'm7', p1.pending)
check('pending 只消费一次', (await rpc('pollSpeak')).pending === null)
// 场景 3：云 TTS 成本门控
await rpc('setConfig', { patch: { autoSpeakCloudTts: false } })
fire({ type: 'turn/start', data: { turn: 12 } })
fire(msgEvent('m8', 12, '门控测试内容'))
fire({ type: 'turn/end', data: { turn: 12, reason: { kind: 'completed' } } })
check('云 TTS 未允许时自动播报被门控', (await rpc('pollSpeak')).pending === null)
// 场景 4：非 completed/max-tokens 的结束原因
await rpc('setConfig', { patch: { autoSpeakCloudTts: true } })
fire({ type: 'turn/start', data: { turn: 13 } })
fire(msgEvent('m9', 13, '中断轮内容'))
fire({ type: 'turn/end', data: { turn: 13, reason: { kind: 'aborted' } } })
check('aborted 轮不播报', (await rpc('pollSpeak')).pending === null)
// 场景 5：stopOnNewTurn 信号
fire({ type: 'turn/start', data: { turn: 14 } })
const gen1 = (await rpc('pollSpeak')).gen
fire({ type: 'turn/start', data: { turn: 15 } })
const gen2 = (await rpc('pollSpeak')).gen
check('turn/start 自增 turnGeneration（客户端停旧播报信号）', typeof gen1 === 'number' && gen2 === gen1 + 1, { gen1, gen2 })

section('T10 preview')
// T9 已把 provider 切到 volcengine；云预览走真（mock）fetch
await rpc('setConfig', { patch: { tts: { volcengine: { rateLevel: 0 } } } })
const pv = await rpc('preview')
check('云 provider 预览返回 audioUrl', pv.ok === true && pv.mode === 'audio' && typeof pv.audioUrl === 'string', pv)
const pvBody = fetchState.calls[fetchState.calls.length - 1].body
check('预览语速档 0 -> speech_rate=-50', pvBody.req_params.audio_params.speech_rate === -50, pvBody.req_params.audio_params)
check('预览文本无 [# 标签', !pvBody.req_params.text.includes('[#'))
await rpc('setConfig', { patch: { tts: { provider: 'browser' } } })
const pv2 = await rpc('preview')
check('browser 预览返回文稿模式', pv2.ok === true && pv2.mode === 'browser' && pv2.text.length > 0)

section('T11 双向流：流式播报管线（帧编解码/段落/参数/缓存/停止/兜底）')
// ---- 帧编解码字节级单测（纯函数，不联网） ----
const taskFrame = encodeFrame({ type: MSG.FullClientRequest, event: EV.TaskRequest, sessionId: 'sid-1', payload: Buffer.from('{"text":"hi"}') })
const taskDec = decodeFrame(taskFrame)
check('帧编解码 round-trip（事件/session/payload）', taskDec.event === EV.TaskRequest && taskDec.sessionId === 'sid-1' && taskDec.payload.toString() === '{"text":"hi"}')
const connFrame = encodeFrame({ type: MSG.FullClientRequest, event: EV.StartConnection, payload: Buffer.from('{}') })
check('StartConnection 帧无 sessionId 段', decodeFrame(connFrame).event === EV.StartConnection && decodeFrame(connFrame).sessionId === '')
check('StartSession 帧带 event=100 与 sessionId', decodeFrame(encodeFrame({ type: MSG.FullClientRequest, event: EV.StartSession, sessionId: 's', payload: Buffer.from('{}') })).event === 100)

// ---- WebSocket 替身（模拟豆包双向流服务端；记录上/下行帧供断言） ----
const wsState = { connections: 0, sessions: [], taskRequests: [], lastReqParams: null }
class MockVolcWS {
  constructor(url, opts) {
    this.binaryType = 'blob'
    this.url = url
    wsState.lastUrl = url
    this.closed = false
    wsState.connections++
    setTimeout(() => this.onopen && this.onopen(), 0)
  }
  send(data) {
    const buf = Buffer.from(data instanceof ArrayBuffer ? data : data)
    const msg = decodeFrame(buf)
    this._serve(msg)
  }
  _serve(msg) {
    const emit = (frame) => {
      const b = encodeFrame(frame)
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      setTimeout(() => { if (!this.closed && this.onmessage) this.onmessage({ data: ab }) }, 0)
    }
    if (msg.event === EV.StartConnection) emit({ type: MSG.FullServerResponse, event: EV.ConnectionStarted })
    else if (msg.event === EV.StartSession) {
      const payload = JSON.parse(msg.payload.toString())
      wsState.lastReqParams = payload.req_params
      wsState.sessions.push(payload.req_params)
      emit({ type: MSG.FullServerResponse, event: EV.SessionStarted })
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(3000, 0x11) })
    } else if (msg.event === EV.TaskRequest) {
      wsState.taskRequests.push(JSON.parse(msg.payload.toString()))
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(2500, 0x22) })
    } else if (msg.event === EV.FinishSession) {
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(2000, 0x33) })
      emit({ type: MSG.FullServerResponse, event: EV.SessionFinished })
    } else if (msg.event === EV.FinishConnection) {
      emit({ type: MSG.FullServerResponse, event: EV.ConnectionFinished })
      this.close()
    } else if (msg.event === EV.CancelSession) {
      emit({ type: MSG.FullServerResponse, event: EV.SessionCanceled })
    }
  }
  close() { this.closed = true; setTimeout(() => this.onclose && this.onclose({ code: 1000, reason: '' }), 0) }
}
async function awaitStreamDone(runId, timeoutMs = 8000) {
  const urls = []
  const formats = []
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await rpc('streamNext', { runId })
    if (r.url) { urls.push(r.url); formats.push(r.format); continue }
    if (r.done) return { urls, formats, res: r }
    await new Promise((res) => setTimeout(res, 25))
  }
  return { urls, formats, res: null, timeout: true }
}
globalThis.WebSocket = MockVolcWS
await rpc('setConfig', { patch: {
  tts: { provider: 'volcengine', volcengine: {
    apiKey: 'k-stream', resourceId: 'seed-tts-2.0', speaker: 'zh_female_vv_uranus_bigtts',
    sampleRate: 24000, rateLevel: 2, pitchLevel: 2, interface: 'bidirection', streaming: true,
    emotionGranularity: 'paragraph', bitRate: 64000, useSectionId: true, expressive: false,
  } },
  language: 'dongbei',
} })
llmState.responses = [{ text: '第一句。第二句。\n第三句。', finish: 'stop' }]
const s1 = await rpc('speak', { sessionId: 's1', messageId: 'm10' })
check('speak 立即返回 mode=stream + runId', s1.ok === true && s1.mode === 'stream' && typeof s1.runId === 'string', s1)
check('speak 返回 sampleRate（pcm 客户端解码用）', typeof s1.sampleRate === 'number' && s1.sampleRate > 0, s1)
const sd = await awaitStreamDone(s1.runId)
check('流式音频分段落成（≥1 段 url）', sd.res && sd.urls.length >= 1 && sd.urls.every((u) => u.startsWith('/voice/audio/')), { urls: sd.urls.length, res: sd.res })
check('双向流段 format=pcm（裸采样，无接缝）', sd.formats.length >= 1 && sd.formats.every((f) => f === 'pcm'), sd.formats)
check('streamNext 结束返回 done', sd.res && sd.res.done === true)
check('启动了 ≥2 个 session（段落粒度动态情感）', wsState.sessions.length >= 2, wsState.sessions.length)
const fs = wsState.sessions[0] || {}
check('首段 req_params 用 pcm（双向流；bit_rate 仅 mp3/HTTP，pcm 不下发）', fs.speaker === 'zh_female_vv_uranus_bigtts' && fs.audio_params && fs.audio_params.format === 'pcm' && fs.audio_params.bit_rate === undefined, fs)
const fsAdd = fs.additions ? JSON.parse(fs.additions) : {}
check('首段 additions 含 context_texts + explicit_dialect=dongbei + cache_config(初次写入) + section_id',
  Array.isArray(fsAdd.context_texts) && fsAdd.explicit_dialect === 'dongbei' && fsAdd.cache_config && fsAdd.cache_config.use_cache === true && fsAdd.cache_config.text_type === 1 && typeof fsAdd.section_id === 'string', fsAdd)
check('TaskRequest 逐句发送（≥2 次）', wsState.taskRequests.length >= 2, wsState.taskRequests.length)
check('emotion 未发送（vv 非多情感音色，参数被跳过）', !(fs.audio_params || {}).emotion, fs.audio_params)
// 流式转写稿已写缓存：切回 HTTP 重播应 cached=true 且不再调 LLM
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http' } } } })
const callsBeforeReplay = llmState.calls.length
const replay = await rpc('speak', { sessionId: 's1', messageId: 'm10' })
check('流式稿已被缓存（HTTP 重播 cached=true 且 LLM 调用数不变）', replay.ok === true && replay.cached === true && llmState.calls.length === callsBeforeReplay, { replay, calls: llmState.calls.length })

section('T11b 双向流：停止（stop 不抛错 + 停止后 run 结束）')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection' } } } })
llmState.responses = [{ text: '停止测试内容。', finish: 'stop' }]
const s2 = await rpc('speak', { sessionId: 's1', messageId: 'm11' })
const stopRes = await rpc('stop')
check('stop ok', stopRes.ok === true)
const sd2 = await awaitStreamDone(s2.runId)
check('停止后 run 仍正常收尾（无死锁）', !!sd2.res, sd2)

section('T11c 双向流：连接失败自动兜底 HTTP 整段')
class FailingVolcWS extends MockVolcWS {
  constructor(...a) { super(...a); setTimeout(() => this.onerror && this.onerror({ message: 'conn refused' }), 0) }
}
globalThis.WebSocket = FailingVolcWS
llmState.responses = [{ text: '兜底转写内容', finish: 'stop' }]
const s3 = await rpc('speak', { sessionId: 's1', messageId: 'm12' })
const sd3 = await awaitStreamDone(s3.runId)
check('连接失败自动回退 HTTP 整段（1 段 url + warn 含回退）', sd3.res && sd3.urls.length === 1 && sd3.res.warn && sd3.res.warn.includes('回退'), sd3)
check('兜底段 format=mp3（客户端走 decodeAudioData）', sd3.formats.length === 1 && sd3.formats[0] === 'mp3', sd3.formats)
globalThis.WebSocket = MockVolcWS
await rpc('setConfig', { patch: { language: 'auto' } })

section('T11d 网关变体（WS 端点）：standard 走 V3 网关（鉴权同为 X-Api-Key，仅 URL 不同）')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { apiKey: 'k-gw', interface: 'bidirection', gateway: 'standard' } } } })
llmState.responses = [{ text: '标准网关 WS', finish: 'stop' }]
const rgw = await rpc('speak', { sessionId: 's1', messageId: 'm11' })
check('standard：speak 正常启动', rgw.ok === true, rgw)
check('standard：WS 端点 = /api/v3/tts/bidirection（无 /plan/）', wsState.lastUrl.includes('/api/v3/tts/bidirection') && !wsState.lastUrl.includes('/plan/'), wsState.lastUrl)
const sgw = await rpc('stop')
check('standard：stop ok', sgw.ok === true)
await rpc('setConfig', { patch: { tts: { volcengine: { gateway: 'plan', httpUrl: '', wsUrl: '' } } } })

section('T12a 转写关闭（transcribe.enabled=false）-> 直接读原文、不调模型')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http' } }, transcribe: { enabled: false } } })
const callsBeforeOff = llmState.calls.length
llmState.responses = [] // 不应消费任何 LLM
const roff = await rpc('speak', { sessionId: 's1', messageId: 'm3' }) // m3 含代码块
check('关转写：ok 且 transcript 为去 Markdown 原文（代码块整块跳过）', roff.ok === true && roff.transcript === '降级测试' && !roff.transcript.includes('```'), roff.transcript)
check('关转写：零 LLM 调用', llmState.calls.length === callsBeforeOff, llmState.calls.length)
const bodyOff = fetchState.calls[fetchState.calls.length - 1].body
check('关转写：发给 TTS 的是纯文本（无代码块）', bodyOff && !String(bodyOff.req_params.text).includes('```'), bodyOff && bodyOff.req_params && bodyOff.req_params.text)
await rpc('setConfig', { patch: { transcribe: { enabled: true } } })

section('T12b 方言自动纠错：非 vv 音色 + 东北话 -> 强制 vv + explicit_dialect')
await rpc('setConfig', { patch: { language: 'dongbei', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } } })
llmState.responses = [{ text: '自动纠错转写', finish: 'stop' }]
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
const bodyD = fetchState.calls[fetchState.calls.length - 1].body
check('请求 speaker 强制为 vv（无需用户手动改）', bodyD.req_params.speaker === 'zh_female_vv_uranus_bigtts', bodyD.req_params.speaker)
const addD = bodyD.req_params.additions ? JSON.parse(bodyD.req_params.additions) : {}
check('explicit_dialect=dongbei 照常下发', addD.explicit_dialect === 'dongbei', addD)
await rpc('setConfig', { patch: { language: 'auto', tts: { volcengine: { speaker: 'spk-1' } } } })

section('T12c 情绪/强度动态：段落指令输出 开心/5 -> 段 1 织进 context_texts（2.0 唯一情感通道，不发送 emotion 数值参数）')
wsState.sessions = []
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', emotionGranularity: 'paragraph' } } } })
// 转写分两片（段 0 + 段 1）；第二条响应 = 段 1 的指令+情感+强度（三行）
llmState.responses = [{ text: '第一句。第二句。\n第三句。', finish: 'stop' }, { text: '语气轻快一点\n开心\n5', finish: 'stop' }]
const se = await rpc('speak', { sessionId: 's1', messageId: 'm10', regen: true }) // regen=强制重新转写（流式已读缓存，动态情感测试需新生成）
await awaitStreamDone(se.runId)
const para1 = wsState.sessions[1] || {}
const add1 = para1.additions ? JSON.parse(para1.additions) : {}
check('段 1 动态情感织进 context_texts（含开心+强度措辞，非配置写死）', Array.isArray(add1.context_texts) && add1.context_texts[0].includes('开心') && add1.context_texts[0].includes('明显'), add1.context_texts)
check('不发送 emotion/emotion_scale 数值参数（1.0 淘汰字段，2.0 不用）', !(para1.audio_params || {}).emotion && !(para1.audio_params || {}).emotion_scale, para1.audio_params)
const para0 = wsState.sessions[0] || {}
check('段 0 用预设指令', Array.isArray(JSON.parse(para0.additions || '{}').context_texts), para0)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { speaker: 'zh_female_vv_uranus_bigtts', interface: 'bidirection' } } } })

section('T12d 情感控制不依赖 _emo_ 音色：普通 2.0 音色（vv）经 context_texts 收到动态情感指令')
// 官方 docs/6561/1329505：context_texts 语音指令（情绪/语气调整）对所有豆包 2.0 音色生效，
// 无需 _emo_ 音色或专属资源/Key。
wsState.sessions = []
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', emotionGranularity: 'paragraph' } } } })
llmState.responses = [{ text: '第一句。第二句。\n第三句。', finish: 'stop' }, { text: '语气低沉一点\n悲伤\n3', finish: 'stop' }]
const svv = await rpc('speak', { sessionId: 's1', messageId: 'm10', regen: true }) // regen=强制重新转写
await awaitStreamDone(svv.runId)
const pvv1 = wsState.sessions[1] || {}
const addvv1 = pvv1.additions ? JSON.parse(pvv1.additions) : {}
check('普通 vv 音色：动态情感经 context_texts 下发（含悲伤+强度措辞）', Array.isArray(addvv1.context_texts) && addvv1.context_texts[0].includes('悲伤') && addvv1.context_texts[0].includes('语气'), addvv1.context_texts)
check('普通 vv 音色：不发送 emotion/emotion_scale 数值参数', !(pvv1.audio_params || {}).emotion && !(pvv1.audio_params || {}).emotion_scale, pvv1.audio_params)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { speaker: 'zh_female_vv_uranus_bigtts', interface: 'bidirection' } } } })

section('T2 meta：预设清单【快照：预设 prompt 不含内嵌标签】')
const meta = await rpc('meta')
check('meta ok', meta.ok === true)
check('音色清单至少 4 项且含小何', Array.isArray(meta.voices) && meta.voices.length >= 4 && meta.voices.some((v) => v.id === 'zh_female_xiaohe_uranus_bigtts'))
check('风格预设齐全（标准/陪伴/俏皮）', ['standard', 'companion', 'playful'].every((id) => meta.stylePresets.some((p) => p.id === id)))
check('所有预设 prompt 均不含 [# 内嵌指令标签', meta.stylePresets.every((p) => !p.prompt.includes('[#')), meta.stylePresets.map((p) => p.prompt.slice(0, 20)))
check('陪伴预设含人设规则', (meta.stylePresets.find((p) => p.id === 'companion') || {}).prompt.includes('陪伴者'))
check('meta 不再含 1.0 多情感音色清单（emo 参数已淘汰）', meta.emoVoices === undefined)
check('languages 含方言信息（dongbei 带 dialectId）', meta.languages.some((l) => l.id === 'dongbei' && l.dialectId === 'dongbei'))

section('T4 getConfig')
check('getConfig 返回配置', (await rpc('getConfig')).ok === true)

section('T6 火山 TTS 请求组装【快照：text 无标签 + 指令走 context_texts + 数值参数】')
// 依据：tmp 下三轮探针音频 + 此前独立实测。
// - 内嵌 [#...] 会被逐字照读（D 实验：时长 2.37 倍）=> text 必须干净
// - 数值 speech_rate 可靠生效（-50 -> 时长 2.2 倍）=> 语速/音调走数值参数
// - context_texts 是官方指令通道（不计费、仅第一个值有效），效果依赖音色/措辞
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { apiKey: 'k-test', resourceId: 'seed-tts-2.0', speaker: 'spk-1', sampleRate: 24000, rateLevel: 3, pitch: -3, pitchLevel: 1, interface: 'http' } } } })
const fetchCallsBefore = fetchState.calls.length // 记住调用数基线（T10 预览已产生过 1 次）
llmState.responses = [{ text: '火山转写结果', finish: 'stop' }]
const r4 = await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('ok 且返回 audioUrl', r4.ok === true && typeof r4.audioUrl === 'string' && r4.audioUrl.startsWith('/voice/audio/'))
check('外呼 1 次火山接口', fetchState.calls.length === fetchCallsBefore + 1 && fetchState.calls[fetchState.calls.length - 1].url.includes('openspeech.bytedance.com/api/v3/plan/tts/unidirectional'))
const body = fetchState.calls[fetchState.calls.length - 1].body
check('请求 text 无 [# 标签且为转写稿', body.req_params.text === '火山转写结果', body.req_params.text)
check('speaker 下发正确', body.req_params.speaker === 'spk-1')
check('语速档 3 -> speech_rate=30（数值参数）', body.req_params.audio_params.speech_rate === 30, body.req_params.audio_params)
// 音调：真 Config schema 已给 pitch 默认值 0，所以线上永远是"pitch 优先"（旧 pitchLevel 只在
// 纯函数层留兼容，见 T6e 的 pitchOf 断言）；这里给 -3 半音，验证它按数值参数下发。
const additions6 = body.req_params.additions ? JSON.parse(body.req_params.additions) : {}
check('音调 -3 半音 -> additions.pitch=-3（pitch 优先于旧 pitchLevel）', additions6.post_process && additions6.post_process.pitch === -3, additions6)
// 指令由第二段 LLM 按文稿内容撰写（mock 默认回"用自然平稳的语气说"），
// 取代预设写死的机械指令——内容驱动的优先级 > 预设回退。
check('内容驱动指令 -> context_texts=[用自然平稳的语气说]', Array.isArray(additions6.context_texts) && additions6.context_texts[0] === '用自然平稳的语气说', additions6)
check('指令调用用的是独立 system prompt（演绎指令撰写器）', llmState.streamOpts.some((o) => o.system && o.system.includes('演绎指令')))
// 指令随转写稿一起缓存：同消息第二次播报，LLM 总调用数不再增长（转写+指令都复用）
const callsAfterFirst = llmState.calls.length
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('第二次播报：LLM 调用数不变（转写与指令均缓存命中）', llmState.calls.length === callsAfterFirst, { callsAfterFirst, now: llmState.calls.length })

section('T6e 音调细粒度 pitch（连续半音优先；旧 pitchLevel 经 pitchOf 兼容映射）')
// 依据：设置页音调改连续半音（-12~12, step 0.1），旧五档 pitchLevel 字段保留兼容。
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { apiKey: 'k-test', resourceId: 'seed-tts-2.0', speaker: 'spk-1', sampleRate: 24000, rateLevel: 2, pitch: 1.5, interface: 'http' } } } })
const fcT6e = fetchState.calls.length
llmState.responses = [{ text: '音调细粒度转写', finish: 'stop' }]
const rT6e = await rpc('speak', { sessionId: 's1', messageId: 'm6e' })
check('ok', rT6e.ok === true, rT6e)
const bodyT6e = fetchState.calls[fetchState.calls.length - 1].body
const addT6e = bodyT6e.req_params.additions ? JSON.parse(bodyT6e.req_params.additions) : {}
check('新字段 pitch=1.5 -> additions.pitch=1.5（连续半音）', addT6e.post_process && addT6e.post_process.pitch === 1.5, addT6e)
check('外呼 1 次', fetchState.calls.length === fcT6e + 1)
// pitch=0（正常）不应发送 post_process（沿用旧逻辑：0=正常不发送）
await rpc('setConfig', { patch: { tts: { volcengine: { pitch: 0 } } } })
llmState.responses = [{ text: '音调正常转写', finish: 'stop' }]
const rT6e0 = await rpc('speak', { sessionId: 's1', messageId: 'm6e0' })
const bodyT6e0 = fetchState.calls[fetchState.calls.length - 1].body
const addT6e0 = bodyT6e0.req_params.additions ? JSON.parse(bodyT6e0.req_params.additions) : {}
check('pitch=0（正常）-> 不发送 post_process', !addT6e0.post_process, addT6e0)
// 纯函数：pitchOf 直接断言（旧 pitchLevel 映射 + 新 pitch 优先）
check('pitchOf 新字段优先', pitchOf({ pitch: 2.2, pitchLevel: 1 }) === 2.2)
check('pitchOf 旧 pitchLevel 映射', pitchOf({ pitchLevel: 4 }) === 6 && pitchOf({ pitchLevel: 0 }) === -6)
check('pitchOf 缺省=0', pitchOf({}) === 0 && pitchOf(undefined) === 0)

section('T6d 指令生成失败 -> 回退预设 instruct（不能因指令坏了就整个播报失败）')
// 用 m2：它在 T4（browser 模式）下写过缓存、但旧条目没有 instruction 字段——
// 命中缓存时指令缺失，会触发"生成"，正好演练生成失败的回退路径。
llmState.failInstruction = true // 只让"指令撰写"调用抛错，转写正常
const r6d = await rpc('speak', { sessionId: 's1', messageId: 'm2' })
llmState.failInstruction = false
check('ok 且播报正常', r6d.ok === true && r6d.audioUrl !== undefined)
const body6d = fetchState.calls[fetchState.calls.length - 1].body
const additions6d = body6d.req_params.additions ? JSON.parse(body6d.req_params.additions) : {}
check('回退到预设机械指令 温柔地回应', additions6d.context_texts && additions6d.context_texts[0] === '温柔地回应，语气柔和', additions6d)

section('T6b LLM 插入的标签 -> 提取进 context_texts（自定义 prompt 场景）')
// 剧本：预设切回 standard（无预设指令），假 LLM 却输出了 [#...] 标签--
// 期望：标签从 text 里消失，内容出现在 context_texts 里（此前项目的成熟设计）。
await rpc('setConfig', { patch: { transcribe: { stylePreset: 'standard' } } })
llmState.responses = [{ text: '[#用俏皮可爱的语气说] 自定义指令转写结果', finish: 'stop' }]
const r6 = await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('ok', r6.ok === true, r6)
const body6b = fetchState.calls[fetchState.calls.length - 1].body
check('text 干净', body6b.req_params.text === '自定义指令转写结果', body6b.req_params.text)
const additions6b = body6b.req_params.additions ? JSON.parse(body6b.req_params.additions) : {}
check('提取的指令进 context_texts', additions6b.context_texts && additions6b.context_texts[0] === '用俏皮可爱的语气说', additions6b)

section('T6c 方言 -> explicit_dialect（不再拼 context_texts「用X说」，8 种方言统一 vv）')
await rpc('setConfig', { patch: { language: 'dongbei', transcribe: { stylePreset: 'companion' }, tts: { volcengine: { speaker: 'zh_female_vv_uranus_bigtts' } } } })
llmState.responses = [{ text: '方言指令转写结果', finish: 'stop' }]
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
const body6c = fetchState.calls[fetchState.calls.length - 1].body
const additions6c = body6c.req_params.additions ? JSON.parse(body6c.req_params.additions) : {}
check('explicit_dialect = dongbei（官方方言通道）', additions6c.explicit_dialect === 'dongbei', additions6c)
check('context_texts 不再含「用东北话说」', !additions6c.context_texts || !additions6c.context_texts[0].includes('用东北话说'), additions6c.context_texts)
check('context_texts 仍含内容驱动指令', Array.isArray(additions6c.context_texts) && additions6c.context_texts[0].includes('语气'), additions6c.context_texts)
// 天津话（实测：explicit_dialect=tianjin 在 plan 网关双向流+HTTP 均生效）不再丢通道
await rpc('setConfig', { patch: { language: 'tianjin', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } } })
llmState.responses = [{ text: '天津话转写结果', finish: 'stop' }]
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
const bodyT = fetchState.calls[fetchState.calls.length - 1].body
const addT = bodyT.req_params.additions ? JSON.parse(bodyT.req_params.additions) : {}
check('天津话：speaker 自动纠错为 vv', bodyT.req_params.speaker === 'zh_female_vv_uranus_bigtts', bodyT.req_params.speaker)
check('天津话：explicit_dialect=tianjin 下发（不再按普通话）', addT.explicit_dialect === 'tianjin', addT)
await rpc('setConfig', { patch: { language: 'auto', tts: { volcengine: { speaker: 'spk-1' } } } })

section('T6f 网关变体（HTTP 端点）：standard / custom（鉴权同为 X-Api-Key，仅 URL 不同）')
// standard：HTTP 端点走 /api/v3/tts/unidirectional（无 /plan/ 前缀，新版控制台 Key）
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { apiKey: 'k-gw', interface: 'http', gateway: 'standard' } } } })
llmState.responses = [{ text: '标准付费网关 HTTP', finish: 'stop' }]
const fcGw = fetchState.calls.length
const rGw = await rpc('speak', { sessionId: 's1', messageId: 'm6e' })
check('standard：ok', rGw.ok === true, rGw)
check('standard：HTTP 端点含 /api/v3/tts/unidirectional 且无 /plan/', fetchState.calls[fetchState.calls.length - 1].url.includes('/api/v3/tts/unidirectional') && !fetchState.calls[fetchState.calls.length - 1].url.includes('/plan/'), fetchState.calls[fetchState.calls.length - 1].url)
// custom：httpUrl 优先于默认端点（原样转发火山协议的转接服务）
await rpc('setConfig', { patch: { tts: { volcengine: { gateway: 'custom', httpUrl: 'https://relay.example.com/v3/tts/unidirectional' } } } })
llmState.responses = [{ text: '自定义转接 HTTP', finish: 'stop' }]
const fcGw2 = fetchState.calls.length
const rGw2 = await rpc('speak', { sessionId: 's1', messageId: 'm6e0' })
check('custom：ok', rGw2.ok === true, rGw2)
check('custom：HTTP 走 httpUrl（转接端点）', fetchState.calls[fetchState.calls.length - 1].url === 'https://relay.example.com/v3/tts/unidirectional', fetchState.calls[fetchState.calls.length - 1].url)
// —— 安全：custom 端点协议校验（防 apiKey 明文传输）+ 缺 URL 报错 + 无 wsUrl 不流式 ——
await rpc('setConfig', { patch: { tts: { volcengine: { gateway: 'custom', httpUrl: 'http://relay.example.com/v3/tts/unidirectional' } } } })
llmState.responses = [{ text: '明文端点', finish: 'stop' }]
const rBad1 = await rpc('speak', { sessionId: 's1', messageId: 'm6e0' })
check('custom：http:// 端点被拒绝（必须 https，防明文凭据）', rBad1.ok === true && /https/.test(String(rBad1.ttsError)), rBad1)
await rpc('setConfig', { patch: { tts: { volcengine: { gateway: 'custom', httpUrl: '', wsUrl: '' } } } })
const rBad2 = await rpc('speak', { sessionId: 's1', messageId: 'm6e0' })
check('custom：httpUrl/wsUrl 都缺时报错', rBad2.ok === true && /需要配置/.test(String(rBad2.ttsError)), rBad2)
await rpc('setConfig', { patch: { tts: { volcengine: { gateway: 'custom', interface: 'bidirection', httpUrl: 'https://relay.example.com/v3/tts/unidirectional', wsUrl: '' } } } })
llmState.responses = [{ text: 'custom 无 wsUrl', finish: 'stop' }]
const rGw4 = await rpc('speak', { sessionId: 's1', messageId: 'm6e0' })
check('custom：仅有 httpUrl（无 wsUrl）→ 不流式，走自定义 HTTP 端点', rGw4.ok === true && rGw4.mode !== 'stream' && fetchState.calls[fetchState.calls.length - 1].url === 'https://relay.example.com/v3/tts/unidirectional', rGw4)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { gateway: 'plan', httpUrl: '', wsUrl: '', interface: 'http', apiKey: 'k-test' } } } })

section('T8 云 TTS 失败 -> ttsError 降级标记（浏览器语音兜底）')
fetchState.nextOk = false
llmState.responses = [{ text: 'TTS 失败转写', finish: 'stop' }]
const r5 = await rpc('speak', { sessionId: 's1', messageId: 'm5' })
fetchState.nextOk = true
check('ok 且带 ttsError（Client 走浏览器语音兜底）', r5.ok === true && /500/.test(String(r5.ttsError)), r5.ttsError)
check('transcript 仍返回', r5.transcript === 'TTS 失败转写')

section('T6e 语种联动：English -> 自动切英文音色 + explicit_language=en；试听用英文样本')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-test', interface: 'http' } }, language: 'en' } })
const callsBeforeE = fetchState.calls.length
llmState.responses = [{ text: 'english transcript', finish: 'stop' }]
const re = await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('English 朗读 ok', re.ok === true && typeof re.audioUrl === 'string', re)
const bodyE = fetchState.calls[fetchState.calls.length - 1].body
check('English：speaker 自动切英文音色', bodyE.req_params.speaker.startsWith('en_'), bodyE.req_params.speaker)
const addE = bodyE.req_params.additions ? JSON.parse(bodyE.req_params.additions) : {}
check('English：explicit_language=en 下发', addE.explicit_language === 'en', addE)
// 试听：English 下 preview 用英文样本文本
const callsBeforePE = fetchState.calls.length
const pvE = await rpc('preview')
check('English preview 返回 audioUrl', pvE.ok === true && pvE.mode === 'audio', pvE)
const bodyPE = fetchState.calls[fetchState.calls.length - 1].body
check('English preview 文本为英文样本（不再中文）', bodyPE.req_params.text && /[a-zA-Z]{4,}/.test(bodyPE.req_params.text) && !bodyPE.req_params.text.includes('你好'), bodyPE.req_params.text && bodyPE.req_params.text.slice(0, 40))
check('English preview speaker 也是英文音色', bodyPE.req_params.speaker.startsWith('en_'), bodyPE.req_params.speaker)
// 方言联动：非 vv 音色 + 天津话 -> vv + explicit_dialect=tianjin（与 T6c 同断言，双保险）
await rpc('setConfig', { patch: { language: 'tianjin', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } } })
llmState.responses = [{ text: 'tianjin transcript', finish: 'stop' }]
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
const bodyT2 = fetchState.calls[fetchState.calls.length - 1].body
const addT2 = bodyT2.req_params.additions ? JSON.parse(bodyT2.req_params.additions) : {}
check('天津话：speaker 强制 vv（方言锁定）', bodyT2.req_params.speaker === 'zh_female_vv_uranus_bigtts', bodyT2.req_params.speaker)
check('天津话：explicit_dialect=tianjin', addT2.explicit_dialect === 'tianjin', addT2)
// 配置自适应：setConfig 时归一化 speaker——language=en -> 英文音色；方言 -> vv
await rpc('setConfig', { patch: { language: 'en', tts: { volcengine: { speaker: 'zh_female_vv_uranus_bigtts' } } } })
const cfgEn = (await rpc('getConfig')).config
check('保存 English：配置 speaker 自动归一化为英文音色（UI 与发声一致）', cfgEn.tts.volcengine.speaker.startsWith('en_'), cfgEn.tts.volcengine.speaker)
await rpc('setConfig', { patch: { language: 'tianjin', tts: { volcengine: { speaker: 'en_male_tim_uranus_bigtts' } } } })
const cfgTj = (await rpc('getConfig')).config
check('保存方言：配置 speaker 自动归一化为 vv（方言仅 vv）', cfgTj.tts.volcengine.speaker === 'zh_female_vv_uranus_bigtts', cfgTj.tts.volcengine.speaker)
await rpc('setConfig', { patch: { language: 'auto', tts: { provider: 'volcengine', volcengine: { speaker: 'spk-1' } } } })

section('T7 一次性音频路由（接 T6 的 audioUrl）')
const aid = r4.audioUrl.slice('/voice/audio/'.length)
const a1 = await fetchAudio(aid)
check('首次取音频 200 且字节正确', a1.code === 200 && Buffer.compare(a1.body, Buffer.from('ABCDEF')) === 0, a1.body && a1.body.toString())
const a2 = await fetchAudio(aid)
check('再次取同 id 音频 404（一次性）', a2.code === 404)

section('T13 口播净化 sanitizeForSpeech（Markdown/装饰符号/表情 不再读出）')
check('代码块整体跳过', sanitizeForSpeech('开头\n```js\nlet x = 1\n```\n结尾') === '开头\n\n结尾', sanitizeForSpeech('开头\n```js\nlet x = 1\n```\n结尾'))
const t13b = sanitizeForSpeech('| a | b |\n|---|---|\n| 1 | 2 |')
check('表格行跳过', !t13b.includes('|') && !t13b.includes('1'), t13b)
check('行内代码去反引号保留内容', sanitizeForSpeech('用 `npm run build` 编译').includes('npm run build'), sanitizeForSpeech('用 `npm run build` 编译'))
const t13d = sanitizeForSpeech('# 标题\n**加粗** _斜_ [x](u) 50%')
check('标题/强调/方括号/圆括号净化', !/[#*_\[\]()]/.test(t13d), t13d)
check('数字与 % 保留', t13d.includes('50%'), t13d)
const t13e = sanitizeForSpeech('见 https://docs.volcengine.com/a 页')
check('链接转「链接+域名」', t13e.includes('链接docs.volcengine.com') && !t13e.includes('https'), t13e)
check('表情符号删除', !sanitizeForSpeech('搞定啦🎉').includes('🎉'), sanitizeForSpeech('搞定啦🎉'))
check('中文标点保留', sanitizeForSpeech('你好，世界！') === '你好，世界！', sanitizeForSpeech('你好，世界！'))
// 转写开启：LLM 输出带 Markdown/表情 → 播报稿与缓存均为净化后文本（browser 路径不合成）
await rpc('setConfig', { patch: { transcribe: { enabled: true, stylePreset: 'standard' }, tts: { provider: 'browser' } } })
llmState.responses = [{ text: '**重点** 是 `pnpm build`，见 [文档](https://x.com) 🎉', finish: 'stop' }]
const rS = await rpc('speak', { sessionId: 's1', messageId: 'm13' })
check('转写稿净化：无 **/反引号/方括号/圆括号', rS.ok && !/[\*\`\[\]()]/.test(rS.transcript), rS.transcript)
check('转写稿净化：表情删除', rS.transcript && !rS.transcript.includes('🎉'), rS.transcript)
check('转写稿净化：链接转链接+域名', rS.transcript && rS.transcript.includes('链接x.com'), rS.transcript)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine' } } })

section('T14 TTS 引擎归一 ttsProviderOf（旧值 openai-compatible 按 browser 处理）')
check('volcengine → volcengine', ttsProviderOf({ tts: { provider: 'volcengine' } }) === 'volcengine')
check('openai-compatible → browser', ttsProviderOf({ tts: { provider: 'openai-compatible' } }) === 'browser')
check('空/未知 → browser', ttsProviderOf({ tts: {} }) === 'browser' && ttsProviderOf({}) === 'browser')
await rpc('setConfig', { patch: { tts: { provider: 'openai-compatible' } } })
check('provider 字段原样保留（z.string 容错，不炸启动）', (await rpc('getConfig')).config.tts.provider === 'openai-compatible')
const pv14 = await rpc('preview')
check('预览按 browser（mode=browser、无 audioUrl）', pv14.ok && pv14.mode === 'browser' && pv14.audioUrl === undefined, pv14)
llmState.responses = [{ text: '归一化转写', finish: 'stop' }]
const r14 = await rpc('speak', { sessionId: 's1', messageId: 'm14' })
check('speak 按 browser 透传（无 audioUrl）', r14.ok && r14.audioUrl === undefined, r14)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine' } } })

section('T16 音色↔语种归一（voice-compat：静态定序 + 交互纠错逻辑）')
// —— normalizeVoiceConfig 静态定序（settings.yaml 直改冲突时的确定性结果）——
const n16a = normalizeVoiceConfig({ language: 'henan', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } })
check('静态：henan+小何 → speaker 归一 vv（方言需 vv）', n16a.tts.volcengine.speaker === VV_SPEAKER, n16a.tts.volcengine.speaker)
const n16b = normalizeVoiceConfig({ language: 'en', tts: { volcengine: { speaker: 'zh_female_vv_uranus_bigtts' } } })
check('静态：en+vv → 英文音色 Tim', n16b.language === 'en' && n16b.tts.volcengine.speaker === EN_DEFAULT_SPEAKER, n16b.tts.volcengine.speaker)
const n16c = normalizeVoiceConfig({ language: 'zh', tts: { volcengine: { speaker: 'en_male_tim_uranus_bigtts' } } })
check('静态：zh+英文音色 → 原样保持（显式手动配置如实反映，不静默翻转）', n16c.language === 'zh' && n16c.tts.volcengine.speaker === 'en_male_tim_uranus_bigtts', n16c)
const n16d = normalizeVoiceConfig({ language: 'auto', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } })
check('静态：auto+中文音色 → 不变', n16d.language === 'auto' && n16d.tts.volcengine.speaker === 'zh_female_xiaohe_uranus_bigtts')
const n16e = normalizeVoiceConfig({ language: 'yue', tts: { volcengine: { speaker: VV_SPEAKER } } })
check('静态：yue+vv → 保持（vv 支持方言）', n16e.language === 'yue' && n16e.tts.volcengine.speaker === VV_SPEAKER)
// —— 交互纠错（后改字段胜出：改音色→纠语种；改语种→纠音色）——
check('交互：henan 下选小何 → 语种改 zh', correctLanguageForSpeaker({ language: 'henan' }, 'zh_female_xiaohe_uranus_bigtts') === 'zh')
check('交互：en 下选 Tim → 语种保持 en', correctLanguageForSpeaker({ language: 'en' }, 'en_male_tim_uranus_bigtts') === 'en')
check('交互：en 下选 vv → 语种改 zh', correctLanguageForSpeaker({ language: 'en' }, VV_SPEAKER) === 'zh')
check('交互：henan 下选 vv → 语种保持 henan', correctLanguageForSpeaker({ language: 'henan' }, VV_SPEAKER) === 'henan')
check('交互：改 henan → 音色 vv', correctSpeakerForLanguage({ language: 'henan' }, 'zh_female_xiaohe_uranus_bigtts') === VV_SPEAKER)
check('交互：改 en → 音色英文', correctSpeakerForLanguage({ language: 'en' }, VV_SPEAKER) === EN_DEFAULT_SPEAKER)
check('交互：改 zh 且音色为英文 → 保持（如实反映用户选择）', correctSpeakerForLanguage({ language: 'zh' }, 'en_male_tim_uranus_bigtts') === 'en_male_tim_uranus_bigtts')
// —— 集成（setConfig 保存 → getConfig 归一，UI 与实际发声一致）——
await rpc('setConfig', { patch: { language: 'henan', tts: { volcengine: { speaker: 'zh_female_xiaohe_uranus_bigtts' } } } })
const cfg16 = (await rpc('getConfig')).config
check('集成：保存 henan+小何 → getConfig 为 henan+vv', cfg16.language === 'henan' && cfg16.tts.volcengine.speaker === VV_SPEAKER, { l: cfg16.language, s: cfg16.tts.volcengine.speaker })
await rpc('setConfig', { patch: { language: 'en', tts: { volcengine: { speaker: VV_SPEAKER } } } })
const cfg16b = (await rpc('getConfig')).config
check('集成：保存 en+vv → getConfig 为 en+英文音色', cfg16b.language === 'en' && cfg16b.tts.volcengine.speaker.startsWith('en_'), { l: cfg16b.language, s: cfg16b.tts.volcengine.speaker })
await rpc('setConfig', { patch: { language: 'auto', tts: { provider: 'volcengine', volcengine: { speaker: 'spk-1' } } } })

section('T17 重新生成（regen：跳过转写缓存、覆盖旧条目、不膨胀）')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http', speaker: 'spk-1', apiKey: 'k-test' } }, language: 'auto', transcribe: { stylePreset: 'standard', enabled: true } } })
llmState.responses = [{ text: 'm16 首次转写', finish: 'stop' }]
const r17a = await rpc('speak', { sessionId: 's1', messageId: 'm16' })
check('m16 首次朗读 ok（非缓存）', r17a.ok === true && r17a.cached !== true, r17a)
const calls17a = llmState.calls.length
const r17b = await rpc('speak', { sessionId: 's1', messageId: 'm16' })
check('m16 普通重读命中缓存', r17b.cached === true, r17b)
check('缓存命中后 LLM 调用数不变', llmState.calls.length === calls17a, llmState.calls.length - calls17a)
llmState.responses = [{ text: 'm16 regen 新转写', finish: 'stop' }]
const calls17b = llmState.calls.length
const r17c = await rpc('speak', { sessionId: 's1', messageId: 'm16', regen: true })
check('regen 返回 ok 且 cached=false（跳过缓存）', r17c.ok === true && r17c.cached !== true, r17c)
check('regen 触发新转写（LLM 调用增加）', llmState.calls.length > calls17b, llmState.calls.length - calls17b)
const r17d = await rpc('speak', { sessionId: 's1', messageId: 'm16' })
check('regen 后普通重读再次命中缓存（旧条目已覆盖，不膨胀）', r17d.cached === true, r17d)

section('T18 双向流：重播零 LLM（转写与情感指令都用缓存）；regen 才全部重新生成')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-stream' } }, language: 'auto', transcribe: { stylePreset: 'standard', enabled: true } } })
const callsBefore18 = llmState.calls.length
llmState.responses = [{ text: '流式首次。有第二句。', finish: 'stop' }, { text: '语气平稳\n中性\n2', finish: 'stop' }]
wsState.sessions = []
wsState.taskRequests = []
const s18a = await rpc('speak', { sessionId: 's1', messageId: 'm15' })
const sd18a = await awaitStreamDone(s18a.runId)
check('流式首次生成 ≥1 段', sd18a.res && sd18a.urls.length >= 1, sd18a.urls.length)
const callsMid18 = llmState.calls.length
check('流式首次产生 LLM 调用（转写+段落指令）', callsMid18 > callsBefore18, { callsBefore18, callsMid18 })
// 初次合成：带 cache_config 写服务端缓存（供 1h 内重播命中免费）
const s18aReqs = wsState.sessions.map((s) => (s.additions ? JSON.parse(s.additions) : {}))
check('流式初次合成会话带 cache_config（写入服务端缓存）', s18aReqs.length >= 1 && s18aReqs.every((a) => a.cache_config && a.cache_config.use_cache === true), s18aReqs)
// 重播：缓存命中 → 转写与情感指令都用缓存，绝对零 LLM（不重新生成任何东西）
wsState.sessions = []
wsState.taskRequests = []
const s18b = await rpc('speak', { sessionId: 's1', messageId: 'm15' })
const sd18b = await awaitStreamDone(s18b.runId)
check('流式重播也产出音频（缓存稿单段直喂）', sd18b.res && sd18b.urls.length >= 1, sd18b.urls.length)
check('流式重播零 LLM（转写+情感指令都用缓存，LLM 调用数不变）', llmState.calls.length === callsMid18, llmState.calls.length - callsMid18)
// 重播（指纹一致）：也带 cache_config 命中服务端缓存（免费）；且逐段复现初次会话切分
const s18bReqs = wsState.sessions.map((s) => (s.additions ? JSON.parse(s.additions) : {}))
check('流式重播带 cache_config（命中服务端缓存，1h 内免重合成）', s18bReqs.length >= 1 && s18bReqs.every((a) => a.cache_config && a.cache_config.use_cache === true), s18bReqs)
// 反向：regen（重新生成）必须重新转写 + 重新生成情感指令（LLM 增加）
llmState.responses = [{ text: 'regen 全新转写。又有两句。', finish: 'stop' }, { text: '语气激动\n开心\n5', finish: 'stop' }]
const calls18c = llmState.calls.length
wsState.sessions = []
const s18c = await rpc('speak', { sessionId: 's1', messageId: 'm15', regen: true })
const sd18c = await awaitStreamDone(s18c.runId)
check('regen 重新生成：LLM 调用增加（转写+情感指令都重写）', llmState.calls.length > calls18c, llmState.calls.length - calls18c)
check('regen 流式也产出音频', sd18c.res && sd18c.urls.length >= 1, sd18c.urls.length)
// regen：绝不下发 cache_config（用户要全新合成，不能命中旧缓存）
const s18cReqs = wsState.sessions.map((s) => (s.additions ? JSON.parse(s.additions) : {}))
check('regen 会话不带 cache_config（全新合成，绝不命中旧缓存）', s18cReqs.every((a) => a.cache_config === undefined), s18cReqs)
// 防串音：换音色后重播（指纹变了）→ 不再命中服务端缓存（否则会返回旧音色音频）
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_xiaohe_uranus_bigtts', apiKey: 'k-stream' } } } })
wsState.sessions = []
const s18d = await rpc('speak', { sessionId: 's1', messageId: 'm15' })
const sd18d = await awaitStreamDone(s18d.runId)
const s18dReqs = wsState.sessions.map((s) => (s.additions ? JSON.parse(s.additions) : {}))
check('换音色后重播（指纹变）不带 cache_config（防命中旧音色，串音）', sd18d.res && s18dReqs.every((a) => a.cache_config === undefined), s18dReqs)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { speaker: 'zh_female_vv_uranus_bigtts' } } } })

section('T19 双向流兜底：WS 中途失败不写半截缓存，降级走 HTTP 整段且缓存完整')
// 模拟"转写已完成但 WS 在收尾时挂掉"：FinishSession 时不回 SessionFinished、而是触发 onerror → 中止。
// 这样 waitSessionFinished 被 abort 打断（确定性），转写仍是完整跑完（transcriptionDone=true），
// 缓存保存完整稿，降级 transcribe 命中缓存 → 播放完整内容、零额外转写。
class MidwayFailVolcWS extends MockVolcWS {
  _serve(msg) {
    if (msg.event === EV.FinishSession) {
      setTimeout(() => this.onerror && this.onerror({ message: 'midway drop' }), 0)
      return
    }
    super._serve(msg)
  }
}
globalThis.WebSocket = MidwayFailVolcWS
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-stream' } }, language: 'auto', transcribe: { stylePreset: 'standard', enabled: true } } })
llmState.responses = [{ text: '兜底完整转写内容。', finish: 'stop' }]
const s19 = await rpc('speak', { sessionId: 's1', messageId: 'm17' })
const sd19 = await awaitStreamDone(s19.runId)
check('WS 中途失败自动降级 HTTP 整段（1 段 mp3 + warn 回退）', sd19.res && sd19.urls.length === 1 && sd19.formats[0] === 'mp3' && sd19.res.warn && sd19.res.warn.includes('回退'), sd19)
// 缓存必须保存完整转写（不被半截稿污染）→ 切回 HTTP 重读应 cached=true 且内容完整
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http' } } } })
llmState.responses = []
const r19 = await rpc('speak', { sessionId: 's1', messageId: 'm17' })
check('兜底后缓存为完整转写（cached=true 且内容完整）', r19.ok === true && r19.cached === true && r19.transcript === '兜底完整转写内容。', { ok: r19.ok, cached: r19.cached, t: r19.transcript })
globalThis.WebSocket = MockVolcWS

section('T20 本地 TTS provider（local：英文不变式 / 零额外 LLM / 免费门控 / WAV / 失败降级）')
// —— 引擎归一（voice-compat 单测）——
check('ttsProviderOf：local 识别为 local', ttsProviderOf({ tts: { provider: 'local' } }) === 'local')
check('ttsProviderOf：旧值 openai-compatible 归一 browser', ttsProviderOf({ tts: { provider: 'openai-compatible' } }) === 'browser')
check('ttsProviderOf：未知值归一 browser', ttsProviderOf({ tts: { provider: 'whatever' } }) === 'browser')
// meta 暴露 Kokoro 音色清单（设置页下拉数据源）
check('meta 带 kokoroVoices 精选清单', (await rpc('meta')).kokoroVoices.some((v) => v.id === 'af_heart'))
// —— 切到 local：转写 prompt 含英文不变式；只调转写 LLM、零情感指令调用；合成走本地 WAV ——
// （测试配置同样经真 Config schema 解析（默认值已补齐）；这里仍显式写全 tts.local，让断言不依赖默认值从哪来）
// 本段只验证"整段合成"链路（streaming:false）→ 非流式契约（audioUrl/字段）；分句流式在 T22 专测。
// 同时先置"服务已在跑"（healthOk=true）→ 不该触发自动拉起；拉起行为在 T21 专测。
subprocessState.healthOk = true
await rpc('setConfig', { patch: { language: 'auto', transcribe: { stylePreset: 'standard' }, tts: { provider: 'local', local: { baseUrl: LOCAL_TTS_URL, voice: 'af_heart', speed: 1, timeoutMs: 30000, streaming: false } } } })
fetchState.calls = []
llmState.responses = [{ text: 'Local English transcript.', finish: 'stop' }]
const instrCount20 = llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length
const calls20 = llmState.calls.length
const r20 = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
const sys20 = llmState.streamOpts[llmState.streamOpts.length - 1] && llmState.streamOpts[llmState.streamOpts.length - 1].system
check('speak ok 且挂了音频路由', r20.ok === true && typeof r20.audioUrl === 'string' && r20.audioUrl.startsWith('/voice/audio/'), r20)
check('转写 prompt 含英文不变式（中文也转写为英文）', !!sys20 && sys20.includes('English') && sys20.includes('不得输出中文'), sys20)
check('零情感指令 LLM 调用（local 无 context_texts 通道）', llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length === instrCount20)
check('LLM 只调 1 次（转写；重播零新增由 T3/T18 保证）', llmState.calls.length === calls20 + 1, llmState.calls.length - calls20)
const localCall = fetchState.calls.find((c) => c.local)
check('本地请求打到 baseUrl，OpenAI 兼容字段正确', !!localCall && localCall.url.includes('/v1/audio/speech') && localCall.body.model === 'kokoro' && localCall.body.voice === 'af_heart' && localCall.body.response_format === 'wav' && localCall.body.speed === 1, localCall)
check('本地请求 input = 英文转写稿（净化后）', localCall && localCall.body.input === 'Local English transcript.', localCall && localCall.body.input)
const wav20 = await fetchAudio(r20.audioUrl.replace('/voice/audio/', ''))
check('音频一次性路由返回 WAV（RIFF 魔数，取一次即删）', wav20.code === 200 && wav20.body && wav20.body.slice(0, 4).toString('ascii') === 'RIFF')
check('同一路由第二次取 404（一次性）', (await fetchAudio(r20.audioUrl.replace('/voice/audio/', ''))).code === 404)
// —— 免费引擎不受成本门控：autoSpeak=true + autoSpeakCloudTts=false 仍自动播报 ——
sessionEvents.push(msgEvent('m18', 30, '本地自动播报内容'))
fire({ type: 'turn/start', data: { turn: 30 } })
fire(msgEvent('m18', 30, '本地自动播报内容'))
fire({ type: 'turn/end', data: { turn: 30, reason: { kind: 'completed' } } })
const pLocal20 = await rpc('pollSpeak')
check('local 免费：autoSpeakCloudTts=false 不拦截自动播报', pLocal20.pending && pLocal20.pending.messageId === 'm18', pLocal20)
check('pending 只消费一次', (await rpc('pollSpeak')).pending === null)
// —— 本地服务失败：ttsError 可见（客户端降级系统 TTS），不静默 ——
fetchState.nextOk = false
llmState.responses = [{ text: 'Failure path transcript.', finish: 'stop' }]
const r20b = await rpc('speak', { sessionId: 's1', messageId: 'm2' })
check('本地服务 500 → ttsError 可见、audioUrl 为空', r20b.ok === true && r20b.audioUrl === undefined && typeof r20b.ttsError === 'string' && r20b.ttsError.includes('500'), r20b.ttsError)
check('转写稿仍正常返回（失败只在合成层）', r20b.transcript === 'Failure path transcript.', r20b.transcript)
fetchState.nextOk = true
// —— 降级直读（中文原文）不送 local：客户端走系统 TTS ——
llmState.failAll = true
const r20c = await rpc('speak', { sessionId: 's1', messageId: 'm3' })
check('降级直读 degraded=true 且不产生音频路由（local 只读英文转写稿）', r20c.ok === true && r20c.degraded === true && r20c.audioUrl === undefined && r20c.ttsError === undefined, { d: r20c.degraded, a: r20c.audioUrl, e: r20c.ttsError })
llmState.failAll = false
// —— preview：local 固定英文样例 ——
const pv20 = await rpc('preview')
const pvLocalCall = fetchState.calls[fetchState.calls.length - 1]
check('preview 走本地并播英文样例', pv20.ok === true && pv20.mode === 'audio' && pvLocalCall.local === true && String(pvLocalCall.body.input).startsWith('Hi, this is a preview'), { pv: pv20, input: pvLocalCall.body && pvLocalCall.body.input })
// —— 转写关闭 + local：直读中文不送 local，回退系统 TTS，且 notice 对用户可见（防"以为 local 没生效"）——
sessionEvents.push(msgEvent('m19', 31, '转写关闭直读内容'))
await rpc('setConfig', { patch: { transcribe: { enabled: false } } })
const calls20d = llmState.calls.length
const r20d = await rpc('speak', { sessionId: 's1', messageId: 'm19' })
check('转写关闭 + local：不合成音频', r20d.ok === true && r20d.audioUrl === undefined && r20d.degraded === false, r20d)
check('转写关闭 + local：notice 提示需开启转写（客户端 toast 素材）', typeof r20d.notice === 'string' && r20d.notice.includes('需要转写模型'), r20d.notice)
check('转写关闭 + local：零 LLM 调用（直读不烧 token）', llmState.calls.length === calls20d, llmState.calls.length - calls20d)
await rpc('setConfig', { patch: { transcribe: { enabled: true } } })

// ================= T21 本地服务托管（自动拉起 / 复用 / 失败分类） =================
section('T21 本地服务托管（autoStart 自动拉起 / 已跑则复用 / ttsErrorKind 分类）')

const spawnCount = () => subprocessState.spawns.length
const localPatch = (extra) => ({ patch: { tts: { provider: 'local', local: Object.assign({ baseUrl: LOCAL_TTS_URL, voice: 'af_heart', speed: 1, timeoutMs: 30000, autoStart: true, pythonPath: '', streaming: false }, extra || {}) } } })

// —— 21a：服务没在跑 → 自动拉起一次，并等待就绪后合成成功 ——
subprocessState.healthOk = false
subprocessState.spawns = []
await rpc('setConfig', localPatch())
llmState.responses = [{ text: 'Autostart transcript.', finish: 'stop' }]
const r21a = await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('未跑 → spawn 恰好 1 次', spawnCount() === 1, spawnCount())
const spec21 = subprocessState.spawns[0] || {}
check('spawn argv = 解释器 + 服务脚本 + --port 8880', Array.isArray(spec21.argv) && spec21.argv.length === 4
  && /python(\.exe)?$/.test(spec21.argv[0]) && /local-tts-server\.py$/.test(spec21.argv[1])
  && spec21.argv[2] === '--port' && spec21.argv[3] === '8880', spec21.argv)
check('spawn cwd = 仓库根（含 local/）', !!spec21.cwd && /voice_for_dsh$/.test(String(spec21.cwd)), spec21.cwd)
check('spawn stdio 三项显式（stdin=ignore，stdout/stderr 有界收集）', spec21.stdio
  && spec21.stdio.stdin === 'ignore' && spec21.stdio.stdout && spec21.stdio.stdout.maxBytes > 0
  && spec21.stderr === undefined && spec21.stdio.stderr && spec21.stdio.stderr.maxBytes > 0, spec21.stdio)
check('spawn graceMs 为正整数', Number.isInteger(spec21.graceMs) && spec21.graceMs > 0, spec21.graceMs)
check('拉起后合成成功、返回音频路由', r21a.ok === true && typeof r21a.audioUrl === 'string' && r21a.ttsErrorKind === undefined, { a: r21a.audioUrl, k: r21a.ttsErrorKind })

// —— 21b：服务已在跑 → 复用，不重复拉起 ——
subprocessState.healthOk = true
const spawnsBefore21b = spawnCount()
llmState.responses = [{ text: 'Reuse transcript.', finish: 'stop' }]
const r21b = await rpc('speak', { sessionId: 's1', messageId: 'm5' })
check('已在跑 → 不再 spawn', spawnCount() === spawnsBefore21b, spawnCount())
check('复用时合成正常', r21b.ok === true && typeof r21b.audioUrl === 'string', r21b.audioUrl)

// —— 21c：autoStart=false 且服务没跑 → 不拉起，报 unavailable（文案给出补救路径） ——
// 注意：播报需要"这条消息存在"，故每个用例用独立 messageId 并补一条会话事件（也避开转写缓存）
sessionEvents.push(msgEvent('m21c', 41, 'No autostart content'))
subprocessState.healthOk = false
const spawnsBefore21c = spawnCount()
await rpc('setConfig', localPatch({ autoStart: false }))
llmState.responses = [{ text: 'No autostart transcript.', finish: 'stop' }]
const r21c = await rpc('speak', { sessionId: 's1', messageId: 'm21c' })
check('autoStart=false → 零 spawn', spawnCount() === spawnsBefore21c, spawnCount())
check('autoStart=false → ttsErrorKind=unavailable（客户端走专用文案）', r21c.ttsErrorKind === 'unavailable', r21c.ttsErrorKind)
check('autoStart=false → 文案含"自动启动"开关与兜底启动方式', /自动启动/.test(String(r21c.ttsError)) && /start-local-tts/.test(String(r21c.ttsError)), r21c.ttsError)

// —— 21d：未部署（pythonPath 覆盖到非 venv 路径） → 不 spawn，报 unavailable 并指引 setup 脚本 ——
// 覆盖后能否回落自动推导，取决于本机仓库是否已有 local/venv：没有 venv 时直接报错，
// 已有 venv（开发机）时回落并成功拉起。两种分支分别断言，都在真机语义内。
// 纯函数分支（找不到 local/ 的仓库根）在下方 21h 直接验证，不依赖本机部署状态。
sessionEvents.push(msgEvent('m21d', 42, 'Missing venv content'))
await rpc('setConfig', localPatch({ autoStart: true, pythonPath: 'Z:/no/such/venv/Scripts/python.exe' }))
llmState.responses = [{ text: 'Missing venv transcript.', finish: 'stop' }]
const spawnsBefore21d = spawnCount()
const r21d = await rpc('speak', { sessionId: 's1', messageId: 'm21d' })
const thisVenvExists = existsSync(path.join(REPO_ROOT_FOR_TEST, 'local', 'venv', 'Scripts', 'python.exe'))
if (thisVenvExists) {
  check('覆盖到非 venv 路径但本机已部署 → 回落自动推导并拉起', spawnCount() === spawnsBefore21d + 1, spawnCount() - spawnsBefore21d)
  check('回落路径合成正常', r21d.ok === true && typeof r21d.audioUrl === 'string', r21d.audioUrl)
} else {
  check('未部署 → 零 spawn', spawnCount() === spawnsBefore21d, spawnCount())
  check('未部署 → ttsErrorKind=unavailable', r21d.ttsErrorKind === 'unavailable', r21d.ttsErrorKind)
  check('未部署 → 文案指向 setup-local-tts.ps1', /setup-local-tts\.ps1/.test(String(r21d.ttsError)), r21d.ttsError)
}

// —— 21e：服务在跑但返回 500 → ttsErrorKind=http（与"不可达"区分） ——
sessionEvents.push(msgEvent('m21e', 43, 'Http error content'))
await rpc('setConfig', localPatch())
subprocessState.healthOk = true
fetchState.nextOk = false
llmState.responses = [{ text: 'Http error transcript.', finish: 'stop' }]
const r21e = await rpc('speak', { sessionId: 's1', messageId: 'm21e' })
check('服务 500 → ttsErrorKind=http', r21e.ttsErrorKind === 'http' && /500/.test(String(r21e.ttsError)), { k: r21e.ttsErrorKind, e: r21e.ttsError })
fetchState.nextOk = true

// —— 21f：服务在跑但不响应 → ttsErrorKind=timeout ——
sessionEvents.push(msgEvent('m21f', 44, 'Timeout content'))
await rpc('setConfig', localPatch({ timeoutMs: 300 }))
fetchState.hang = true
llmState.responses = [{ text: 'Timeout transcript.', finish: 'stop' }]
const r21f = await rpc('speak', { sessionId: 's1', messageId: 'm21f' })
fetchState.hang = false
check('不响应 → ttsErrorKind=timeout', r21f.ttsErrorKind === 'timeout' && /timeout/.test(String(r21f.ttsError)), { k: r21f.ttsErrorKind, e: r21f.ttsError })

// —— 21g：localStatus 只读自检（不拉起服务） ——
await rpc('setConfig', localPatch())
subprocessState.healthOk = true
const st21run = await rpc('localStatus')
check('localStatus：在跑时报 running=true 且带健康端点', st21run.ok === true && st21run.running === true && String(st21run.url).endsWith('/health'), st21run)
subprocessState.healthOk = false
const spawnsBefore21g = spawnCount()
const st21down = await rpc('localStatus')
check('localStatus：没跑时报 running=false', st21down.ok === true && st21down.running === false, st21down)
check('localStatus：只读探测，不触发拉起', spawnCount() === spawnsBefore21g, spawnCount())
check('localStatus：报告部署状态与开关', st21down.venvFound === true && st21down.autoStart === true && st21down.subprocessAvailable === true, st21down)

// —— 21h：路径推导纯函数分支（不依赖本机是否部署） ——
// 不存在的盘符路径 → 上溯找不到任何含 local/ 的目录，必然报"未找到运行环境"并指引 setup 脚本
const asFileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/')
const orphanLaunch = resolveLaunch(asFileUrl('Q:/no-such-place/lib/index.js'), '')
check('resolveLaunch：找不到部署时给出部署指引（root 留空）', orphanLaunch.root === '' && orphanLaunch.python === '' && /setup-local-tts\.ps1/.test(orphanLaunch.error), orphanLaunch)
// 只有 local/ 没有 scripts/（半部署）→ 认出局部根，但仍报"未找到运行环境"
const halfDir = mkdtempSync(path.join(tmpdir(), 'voice-halfdeploy-'))
mkdirSync(path.join(halfDir, 'local'), { recursive: true })
mkdirSync(path.join(halfDir, 'lib'), { recursive: true })
const halfLaunch = resolveLaunch(asFileUrl(path.join(halfDir, 'lib', 'index.js')), '')
check('resolveLaunch：半部署（有 local/ 无 scripts/）仍报缺运行环境', /setup-local-tts\.ps1/.test(halfLaunch.error) && halfLaunch.script.indexOf('local-tts-server.py') > 0, halfLaunch)
rmSync(halfDir, { recursive: true, force: true })
// pythonPath 覆盖：指向真实存在的文件时优先采用（显式配置不被自动推导覆盖）
const overrideDir = mkdtempSync(path.join(tmpdir(), 'voice-override-'))
const fakePython = path.join(overrideDir, 'fake-python.exe')
writeFileSync(fakePython, 'stub')
const overrideLaunch = resolveLaunch(asFileUrl(path.join(REPO_ROOT_FOR_TEST, 'packages', 'dsh-plugin-voice', 'lib', 'index.js')), fakePython)
check('resolveLaunch：pythonPath 覆盖优先于自动推导', overrideLaunch.python === fakePython, overrideLaunch.python)
// 真实仓库根下的推导结果：脚本指向本仓库（junction 也能穿透）
const realLaunch = resolveLaunch(asFileUrl(path.join(REPO_ROOT_FOR_TEST, 'packages', 'dsh-plugin-voice', 'lib', 'index.js')), '')
check('resolveLaunch：从真实仓库根推导出脚本路径', /scripts[\\/]local-tts-server\.py$/.test(realLaunch.script), realLaunch.script)
rmSync(overrideDir, { recursive: true, force: true })
// 复位：验证实例释放（幂等，不抛错）
subprocessState.healthOk = true

// ================= T22 本地分句流式（首声早 / 单段超时 / 降级整段） =================
section('T22 本地分句流式（pcm16 分段 / 单段超时 / 首段失败降级整段）')

const LOCAL_STREAM_CFG = { baseUrl: LOCAL_TTS_URL, voice: 'af_heart', speed: 1, timeoutMs: 30000, autoStart: true, pythonPath: '', streaming: true, segmentChars: 300, segmentTimeoutMs: 30000 }
const localStreamPatch = (extra) => ({ patch: { tts: { provider: 'local', local: Object.assign({}, LOCAL_STREAM_CFG, extra || {}) } } })
// 长稿：8 句 × ~185 字符 ≈ 1480 字符 → segmentChars=300 时应切成 ≥4 段（且每段 ≤ 600 = 2×target）
const LONG_SENTENCE = 'The quick brown fox jumps over the lazy dog while the local engine keeps synthesizing audio in small chunks so that playback can start almost immediately instead of waiting for the entire transcript to finish. '
const LONG_TRANSCRIPT = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => LONG_SENTENCE.trim() + ' Number ' + i + '.').join(' ')

subprocessState.healthOk = true
fetchState.localFailPcm = false
fetchState.localFailOnSegment = 0
fetchState.localSegIndex = 0
await rpc('setConfig', localStreamPatch())

// —— 22a：默认（streaming=true）走分句流式 ——
sessionEvents.push(msgEvent('m22a', 51, 'Long streaming source'))
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const pcmCallsBefore22a = fetchState.calls.filter((c) => c.local && c.body && c.body.response_format === 'pcm16').length
const r22a = await rpc('speak', { sessionId: 's1', messageId: 'm22a' })
check('streaming 默认开 → mode=stream + runId', r22a.ok === true && r22a.mode === 'stream' && typeof r22a.runId === 'string', r22a)
check('流式响应带 sampleRate（24k）', r22a.sampleRate === 24000, r22a.sampleRate)
const sd22a = await awaitStreamDone(r22a.runId)
check('长稿被切成 ≥3 段（分句流式生效）', sd22a.urls.length >= 3, sd22a.urls.length)
check('每段 format=pcm（裸采样，零解码延迟）', sd22a.formats.length >= 1 && sd22a.formats.every((f) => f === 'pcm'), sd22a.formats)
check('段请求用 response_format=pcm16（服务端契约）', fetchState.calls.filter((c) => c.local && c.body && c.body.response_format === 'pcm16').length >= 3, fetchState.calls.filter((c) => c.local).length)
check('每段请求体互不相同（确实是分句，不是整篇重复）', new Set(fetchState.calls.filter((c) => c.local && c.body).map((c) => c.body.input)).size >= 3)
// 边收边入队：一次段请求内出现多个音频分块 → 播放器不必等整段合成完（首声从"整段时长"降到"首个分块"）
const pcmReqs22a = fetchState.calls.filter((c) => c.local && c.body && c.body.response_format === 'pcm16').length - pcmCallsBefore22a
check('边收边入队：音频分块数 > 段请求数（0.5s 粒度切块）', sd22a.urls.length > pcmReqs22a, { audioChunks: sd22a.urls.length, pcmRequests: pcmReqs22a })
check('流式结束 done=true', !!(sd22a.res && sd22a.res.done === true), sd22a.res)

// —— 22b：段内容校验（字节数 = 样本数×2，偶数边界） ——
const seg22 = await fetchAudio(sd22a.urls[0].replace('/voice/audio/', ''))
check('首段音频可取（裸 PCM，字节数为偶数且 > 0）', seg22.code === 200 && seg22.body && seg22.body.length > 0 && seg22.body.length % 2 === 0, seg22.body && seg22.body.length)
check('首段音频 mime=audio/pcm', seg22.mime === 'audio/pcm', seg22.mime)

// —— 22c：重播命中转写缓存 → 零新增 LLM 调用 ——
const callsBeforeReplay22 = llmState.calls.length
fetchState.localSegIndex = 0
const r22c = await rpc('speak', { sessionId: 's1', messageId: 'm22a' })
const sd22c = await awaitStreamDone(r22c.runId)
check('重播仍产出音频段', sd22c.urls.length >= 3, sd22c.urls.length)
check('重播零 LLM（转写缓存命中）', llmState.calls.length === callsBeforeReplay22, llmState.calls.length - callsBeforeReplay22)

// —— 22d：中途某段失败 → 保留已播段 + warn，不整条报错 ——
sessionEvents.push(msgEvent('m22d', 52, 'Mid-stream failure source'))
fetchState.localSegIndex = 0
fetchState.localFailOnSegment = 3
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const r22d = await rpc('speak', { sessionId: 's1', messageId: 'm22d' })
const sd22d = await awaitStreamDone(r22d.runId)
check('中途失败：已播段保留（≥2 段）', sd22d.urls.length >= 2, sd22d.urls.length)
check('中途失败：warn 说明后续未播报', !!(sd22d.res && sd22d.res.warn && sd22d.res.warn.includes('合成失败')), sd22d.res && sd22d.res.warn)
check('中途失败：不当作整条错误（error 为空）', !(sd22d.res && sd22d.res.error), sd22d.res && sd22d.res.error)
fetchState.localFailOnSegment = 0

// —— 22e：首段即失败 → 降级整段合成（wav 单段），用户仍能听到 ——
sessionEvents.push(msgEvent('m22e', 53, 'First segment fails source'))
fetchState.localSegIndex = 0
fetchState.localFailPcm = true
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const r22e = await rpc('speak', { sessionId: 's1', messageId: 'm22e' })
const sd22e = await awaitStreamDone(r22e.runId)
check('首段失败 → 降级出 1 段音频', sd22e.urls.length === 1, sd22e.urls.length)
check('降级段 format=wav（整段 WAV 兜底）', sd22e.formats[0] === 'wav', sd22e.formats)
check('降级 warn 说明"回退为整段合成"', !!(sd22e.res && sd22e.res.warn && sd22e.res.warn.includes('回退')), sd22e.res && sd22e.res.warn)
check('降级后不算失败（error 为空）', !(sd22e.res && sd22e.res.error), sd22e.res && sd22e.res.error)
fetchState.localFailPcm = false

// —— 22f：整条流式全失败（每段都超时） → errorKind=timeout + 降级整段仍出声 ——
// never：PCM 段请求永不返回；segmentTimeoutMs=200 → 每段都以 timeout 收尾 → 零段 → 触发整段兜底。
// 用变体文本确保走"真转写 + 真合成"而不是命中 22a 的转写缓存
sessionEvents.push(msgEvent('m22f', 54, 'Segment timeout source'))
fetchState.localSegIndex = 0
fetchState.hangCount = 0
fetchState.never = true
await rpc('setConfig', localStreamPatch({ segmentTimeoutMs: 200 }))
llmState.responses = [{ text: LONG_TRANSCRIPT + ' Extra tail sentence for the timeout case.', finish: 'stop' }]
const t22f0 = Date.now()
const r22f = await rpc('speak', { sessionId: 's1', messageId: 'm22f' })
check('speak 立即返回（不等合成完成）', Date.now() - t22f0 < 1000, Date.now() - t22f0)
// 等段请求真的挂上（最多 3s），证明超时计时确实作用在挂住的请求上
for (let i = 0; i < 120 && fetchState.hangCount === 0; i++) await new Promise((r) => setTimeout(r, 25))
check('段请求已挂住（模拟服务卡死）', fetchState.hangCount >= 1, fetchState.hangCount)
const sd22f = await awaitStreamDone(r22f.runId)
fetchState.never = false
check('段级超时 → errorKind=timeout（客户端选专用文案）', !!(sd22f.res && sd22f.res.errorKind === 'timeout'), { kind: sd22f.res && sd22f.res.errorKind, error: sd22f.res && sd22f.res.error })
check('超时文案是"段级"而非整段死线（含 segment timeout）', !!(sd22f.res && /segment timeout/.test(String(sd22f.res.error))), sd22f.res && sd22f.res.error)
check('整条流式全失败 → 仍降级整段兜底（用户仍能听到）', sd22f.urls.length >= 1 && sd22f.formats.includes('wav'), { urls: sd22f.urls.length, formats: sd22f.formats })

// —— 22f2：部分段失败且已播出内容 → 保留 errorKind（不谎报"全部成功"） ——
sessionEvents.push(msgEvent('m22f2', 56, 'Partial failure source'))
fetchState.localSegIndex = 0
fetchState.localFailOnSegment = 3
fetchState.never = false
await rpc('setConfig', localStreamPatch({ segmentTimeoutMs: 30000 }))
llmState.responses = [{ text: LONG_TRANSCRIPT + ' Partial variant tail.', finish: 'stop' }]
const r22f2 = await rpc('speak', { sessionId: 's1', messageId: 'm22f2' })
const sd22f2 = await awaitStreamDone(r22f2.runId)
check('部分失败：已播段 + errorKind=http 都保留', sd22f2.urls.length >= 2 && sd22f2.res && sd22f2.res.errorKind === 'http', { urls: sd22f2.urls.length, kind: sd22f2.res && sd22f2.res.errorKind })
check('部分失败：warn 说明从第几段起未播报', !!(sd22f2.res && /段起合成失败/.test(String(sd22f2.res.warn))), sd22f2.res && sd22f2.res.warn)
fetchState.localFailOnSegment = 0

// —— 22g：streaming=false → 回整段合成（无 stream 模式） ——
sessionEvents.push(msgEvent('m22g', 55, 'Non-streaming source'))
await rpc('setConfig', localStreamPatch({ streaming: false, timeoutMs: 30000 }))
llmState.responses = [{ text: 'Short non-streaming transcript.', finish: 'stop' }]
const r22g = await rpc('speak', { sessionId: 's1', messageId: 'm22g' })
check('streaming=false → 非流式（直接给 audioUrl）', r22g.ok === true && r22g.mode === undefined && typeof r22g.audioUrl === 'string', r22g)
check('streaming=false → 请求 response_format=wav（整段路径）', fetchState.calls[fetchState.calls.length - 1].body.response_format === 'wav', fetchState.calls[fetchState.calls.length - 1].body)

// —— 22h：splitForStream 纯函数（切分不丢字、段长受控） ——
const segs22h = splitForStream(LONG_TRANSCRIPT, 300)
check('splitForStream：长稿切成 ≥3 段', segs22h.length >= 3, segs22h.length)
check('splitForStream：每段 ≤ 2×target（600）', segs22h.every((s) => s.length <= 600), segs22h.map((s) => s.length))
check('splitForStream：拼接后与原文一致（去空白比对）', segs22h.join(' ').replace(/\s+/g, '') === LONG_TRANSCRIPT.replace(/\s+/g, ''))
check('splitForStream：短稿整段返回（不硬切）', splitForStream('One short sentence.', 300).length === 1)
check('splitForStream：优先切在句末（首段以标点结尾）', /[.!?。！？]$/.test(segs22h[0]), segs22h[0].slice(-20))
await rpc('setConfig', { patch: { tts: { provider: 'browser', local: { streaming: true, segmentChars: 300, segmentTimeoutMs: 30000 } } } })

// =====================================================================
// T23 本地 CosyVoice（local-cosyvoice：中文播报 / 情绪指令 / 免费 / 直读可合成）
// =====================================================================
section('T23 本地 CosyVoice（local-cosyvoice：中文播报 + 情绪指令 + 免费 + 直读可合成）')
check('ttsProviderOf：local-cosyvoice 识别为 local-cosyvoice', ttsProviderOf({ tts: { provider: 'local-cosyvoice' } }) === 'local-cosyvoice')
check('isLocalProvider：两个本地引擎都算本地（免费，不受云门控）', isLocalProvider({ tts: { provider: 'local' } }) && isLocalProvider({ tts: { provider: 'local-cosyvoice' } }) && !isLocalProvider({ tts: { provider: 'volcengine' } }))
check('localBlockKeyOf：local-cosyvoice → localCosyvoice 配置块', localBlockKeyOf('local-cosyvoice') === 'localCosyvoice' && localBlockKeyOf('local') === 'local')
const meta23 = await rpc('meta')
check('meta 带 cosyvoiceVoices 精选清单', Array.isArray(meta23.cosyvoiceVoices) && meta23.cosyvoiceVoices.some((v) => v.id === 'dsh_default'))
const cosyLaunch = resolveLaunch(asFileUrl(path.join(REPO_ROOT_FOR_TEST, 'packages', 'dsh-plugin-voice', 'lib', 'index.js')), '', 'local-cosyvoice')
check('resolveLaunch(cosyvoice)：脚本为 local-tts-server-cosyvoice.py', /local-tts-server-cosyvoice\.py$/.test(cosyLaunch.script), cosyLaunch.script)
check('resolveLaunch(cosyvoice)：venv 指向 venv-cosyvoice', /venv-cosyvoice$/.test(cosyLaunch.venvDir), cosyLaunch.venvDir)

const COSY_TTS_URL = 'http://127.0.0.1:8882/v1/audio/speech'
const cosyPatch = (extra) => ({ patch: { language: 'auto', transcribe: { stylePreset: 'companion', enabled: true }, tts: { provider: 'local-cosyvoice', localCosyvoice: Object.assign({ baseUrl: COSY_TTS_URL, voice: 'dsh_default', speed: 1, sampleRate: 24000, timeoutMs: 30000, autoStart: true, pythonPath: '', streaming: false, segmentChars: 120, segmentTimeoutMs: 30000, emotionEnabled: true, instruct: '' }, extra || {}) } } })
subprocessState.healthOk = true
sessionEvents.push(msgEvent('m23a', 60, 'CosyVoice source'))
await rpc('setConfig', cosyPatch())
llmState.responses = [{ text: '中文口语转写结果，保留中文。', finish: 'stop' }]
const instr23a = llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length
const r23a = await rpc('speak', { sessionId: 's1', messageId: 'm23a' })
check('cosyvoice：ok 且挂音频路由', r23a.ok === true && typeof r23a.audioUrl === 'string', r23a)
check('cosyvoice：转写稿保持中文（无英文不变式）', r23a.transcript === '中文口语转写结果，保留中文。', r23a.transcript)
const cosyCall = fetchState.calls.filter((c) => c.local && c.body && c.body.model === 'fun-cosyvoice3').pop()
check('cosyvoice：请求 model=fun-cosyvoice3 / voice=dsh_default / wav', !!cosyCall && cosyCall.body.voice === 'dsh_default' && cosyCall.body.response_format === 'wav', cosyCall && cosyCall.body)
check('cosyvoice：情绪指令 LLM 已调用（emotionEnabled 默认开）', llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length === instr23a + 1)
check('cosyvoice：instruct 通道携带生成的指令', !!cosyCall && typeof cosyCall.body.instruct === 'string' && cosyCall.body.instruct.length > 0, cosyCall && cosyCall.body.instruct)

// —— 转写关闭 + cosyvoice：中文直读仍合成（区别于 Kokoro 回退系统 TTS） ——
sessionEvents.push(msgEvent('m23d', 61, '原始回复内容'))
await rpc('setConfig', cosyPatch({ emotionEnabled: false }))
await rpc('setConfig', { patch: { transcribe: { enabled: false } } })
const calls23d = llmState.calls.length
const r23d = await rpc('speak', { sessionId: 's1', messageId: 'm23d' })
check('转写关闭 + cosyvoice：仍合成音频（中文直读可读）', r23d.ok === true && typeof r23d.audioUrl === 'string', r23d)
check('转写关闭 + cosyvoice：零 LLM 调用（不烧 token）', llmState.calls.length === calls23d, llmState.calls.length)
const cosyCallD = fetchState.calls.filter((c) => c.local && c.body && c.body.model === 'fun-cosyvoice3').pop()
check('转写关闭 + cosyvoice：直读中文原文送合成', cosyCallD && String(cosyCallD.body.input).includes('原始回复内容'), cosyCallD && cosyCallD.body.input)

// —— preview：中文样例 ——
await rpc('setConfig', cosyPatch())
const pv23 = await rpc('preview')
const cosyPvCall = fetchState.calls.filter((c) => c.local && c.body && c.body.model === 'fun-cosyvoice3').pop()
check('preview：中文样例（非 Kokoro 的英文样例）', pv23.ok === true && cosyPvCall && String(cosyPvCall.body.input).startsWith('你好'), cosyPvCall && cosyPvCall.body.input)

// —— 流式：分句 pcm16 + 每段带 instruct ——
sessionEvents.push(msgEvent('m23s', 62, 'CosyVoice streaming source'))
await rpc('setConfig', cosyPatch({ streaming: true }))
await rpc('setConfig', { patch: { transcribe: { enabled: true } } })
llmState.responses = [{ text: '今天天气不错，我们一起去公园散步吧。然后回家吃饭，路上顺便买了水果。明天还要早起开会，准备一下材料。'.repeat(6), finish: 'stop' }]
const r23s = await rpc('speak', { sessionId: 's1', messageId: 'm23s' })
check('cosyvoice 流式：mode=stream + runId', r23s.ok === true && r23s.mode === 'stream' && !!r23s.runId, r23s)
const sd23s = await awaitStreamDone(r23s.runId)
const cosyPcmCalls = fetchState.calls.filter((c) => c.local && c.body && c.body.model === 'fun-cosyvoice3' && c.body.response_format === 'pcm16')
check('cosyvoice 流式：段请求 response_format=pcm16 且 ≥2 段', cosyPcmCalls.length >= 2, cosyPcmCalls.length)
check('cosyvoice 流式：每段带 instruct（情绪指令透传）', cosyPcmCalls.filter((c) => typeof c.body.instruct === 'string' && c.body.instruct.length > 0).length >= 2, cosyPcmCalls.map((c) => c.body.instruct))
check('cosyvoice 流式：透传 flow_steps（质量/速度档，越小越快）', cosyPcmCalls.every((c) => c.body.flow_steps === 4), cosyPcmCalls.map((c) => c.body.flow_steps))
check('cosyvoice 流式：边收边入队（分块数 > 段请求数）且无错误', sd23s.urls.length > cosyPcmCalls.length && !sd23s.res.error, { urls: sd23s.urls.length, reqs: cosyPcmCalls.length, err: sd23s.res && sd23s.res.error })
await rpc('setConfig', cosyPatch())

// 恢复 browser（测试以免费引擎收尾，保持无副作用）
await rpc('setConfig', { patch: { autoSpeak: false, tts: { provider: 'browser' } } })

// ---------- 收尾 ----------
// 善后三件事：恢复真 fetch（否则这个进程里再联网会打到假货）、删临时目录、交成绩单。
globalThis.fetch = realFetch
rmSync(home, { recursive: true, force: true })
console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed')
console.log('(B 类"外部事实快照"断言若失败：先跑 node scripts/tts-probe.mjs 拿新证据，再三处同步更新，见文件头第 5 条)')
process.exit(failed ? 1 : 0) // 退出码：0=全过，1=有失败（脚本工具靠它判断成败）
