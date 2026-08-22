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
 *   不用浏览器、不花一分钱 API 费，1 秒左右跑完 145 条检查。
 *
 * 【3. 怎么跑？（VS Code 完整步骤）】
 *   ① 用 VS Code 打开仓库文件夹 E:\project\voice_for_dsh
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
 * 【5. 最重要的一段：本测试集里的断言分两类（这是你提出的洞见，已固化成本设计）
 *
 *   【A 类·不变量】我们自己的代码必须永远满足的要求，断言它永远合理：
 *      例：同一条消息读第二遍，不允许再调一次 LLM（防"转写 4 次烧 token"）。
 *      这类断言放心大胆地信。
 *
 *   【B 类·外部事实快照】对"火山 TTS 接口怎么表现"的记录，依据是某天的
 *      探针实测（scripts/tts-probe.mjs），它可能过时、甚至可能本来就是错的：
 *      例："请求 text 里不得出现 [#...] 标签"--依据是三轮
 *      探针 + 你旧项目 secretary-agent 的独立实测（两边结论一致，可信度高）；
 *      例："context_texts 传指令"--依据是旧项目经验 + 探针显示偶发时长变化，
 *      但效果不稳定（vv 音色上几乎无效果，xiaohe 上有）。
 *   推翻 B 类断言的正确姿势：
 *      ① 先跑 node scripts/tts-probe.mjs 拿新的实测证据（音频会存到 tmp\ 下，亲耳听）
 *      ② 证据确凿后，同时更新：本文件对应断言 + lib/index.js 实现 + docs/voice-pipeline.md
 *      ③ 三处一起改，避免"文档说 A、代码做 B、测试断言 C"的精神分裂
 *   --记住：测试是"把今天的证据钉在墙上"，不是真理本身。
 * ===================================================================== */

/* =====================================================================
 * 下面是正式代码。即使看不懂每行 JS 语法也没关系，每个段落都有"这段在干嘛"
 * 的注释；想学的话按顺序读，注释比代码长是有意的。
 * ===================================================================== */

// import = 从 Node.js 自带的标准库里取工具。
// mkdtempSync 建一个一次性临时文件夹；rmSync 删文件夹。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 【关键顺序】转写缓存写在 DSH_HOME（默认 ~/.dsh）下，插件代码在"被加载的
// 那一瞬间"就会去读它。所以必须先把 DSH_HOME 指到一个空临时目录，再 import
// 插件--顺序反了就会碰到你真实的缓存文件（那是脏数据，会污染测试结果）。
const home = mkdtempSync(path.join(tmpdir(), 'voice-test-'))
process.env.DSH_HOME = home

// await import(...) = 动态加载真实的插件文件（不是复制粘贴的副本！测的就是它）。
const { apply } = await import('../packages/dsh-plugin-voice/lib/index.js')
// 双向流帧编解码（volcengine-ws.js 导出的纯函数，字节级单测用）
const { encodeFrame, decodeFrame, MSG, EV } = await import('../packages/dsh-plugin-voice/lib/volcengine-ws.js')
// 口播净化 / TTS 引擎归一（speech-clean.js 纯函数）
const { sanitizeForSpeech, ttsProviderOf } = await import('../packages/dsh-plugin-voice/lib/speech-clean.js')
// 音色 ↔ 语种/方言 兼容矩阵（voice-compat.js 纯函数：归一/纠错/纠语言）
const { normalizeVoiceConfig, correctSpeakerForLanguage, correctLanguageForSpeaker, VV_SPEAKER, EN_DEFAULT_SPEAKER } = await import('../packages/dsh-plugin-voice/lib/voice-compat.js')

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

// 替身 3：设置。scope.get() 返回"当前配置"--测试里想改配置就直接改这个对象，
// 模拟用户在设置页点了什么。
function deepMerge(target, patch) {
  const out = Object.assign({}, target)
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && target && typeof target[k] === 'object' && !Array.isArray(target[k])
      ? deepMerge(target[k], v) : v
  }
  return out
}
const settingsState = { config: null, updates: [] }
const settings = {
  register: (_ns, schema) => { settingsState.schema = schema; return { get: () => settingsState.config } },
  update: async (_ns, patch) => {
    settingsState.updates.push(patch)
    settingsState.config = deepMerge(settingsState.config, patch)
  },
}

// 替身 4：web 路由注册表。插件会把 /voice/api 和 /voice/audio 两个"处理器"
// 注册进来--我们把处理器存起来，就能像真的 HTTP 请求那样调用它们。
const routes = []
const webServer = { register: (r) => routes.push(r) }

// 替身 5：事件监听。插件用 ctx.on('session/event') 订阅会话事件；
// 我们把监听函数存起来，测试里就能"伪造"事件（turn 开始/结束等）。
const eventListeners = new Map()
const ctx = {
  get: (name) => (name === 'llm' ? llm : name === 'sessions' ? sessions : undefined),
  settings,
  webServer,
  on: (name, fn) => { if (!eventListeners.has(name)) eventListeners.set(name, []); eventListeners.get(name).push(fn) },
}

// 替身 6：fetch（网络电话）。插件调火山 TTS 用的是全局 fetch；
// 我们把它整个换成假货--不联网、立刻返回一小段假音频，并记下"打了什么电话、说了什么"。
// 这就是为什么本测试零花费：外呼根本没发生，但请求体会被完整记下来供断言。
const realFetch = globalThis.fetch
const fetchState = { calls: [], nextOk: true }
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
globalThis.fetch = async (url, init) => {
  fetchState.calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null })
  if (fetchState.nextOk) return fakeTtsResponse()
  return { ok: false, status: 500, body: null, text: async () => 'mock tts boom' }
}

// ---------- 把真插件"装配"到替身上，并做 HTTP 请求的仿真驱动 ----------
apply(ctx) // 跑插件的安装函数（对真实代码的第一次冒烟：不抛错就是通过）
const apiHandler = routes.find((r) => r.path === '/voice/api').handler
const audioHandler = routes.find((r) => r.path === '/voice/audio').handler

// rpc = 模拟"浏览器向插件发 HTTP 请求"。和 curl 的区别：不用起服务器，直接调处理函数。
async function rpc(method, args) {
  const body = JSON.stringify(args || {})
  const req = {
    method: 'POST', url: '/voice/api/' + method,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
  }
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b || '') } }
  await apiHandler(req, res)
  try { return JSON.parse(res.body) } catch { return { ok: false, parseError: res.body, code: res.code } }
}
async function fetchAudio(id) {
  const req = { method: 'GET', url: '/voice/audio/' + id }
  const res = { code: 0, body: null, writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await audioHandler(req, res)
  return res
}
// fire = 伪造一条会话事件，喂给插件的事件监听器。
function fire(event) {
  for (const fn of eventListeners.get('session/event') || []) fn({ header: { id: 's1' } }, event)
}
const msgEvent = (id, turn, text) => ({ type: 'assistant/message', data: { turn, message: { id, content: [{ type: 'text', text }] } } })

// ---------- 测试数据：一份"用户配置"和几条"历史消息" ----------
settingsState.config = {
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
sessionsState.sessions.s1 = {
  header: { id: 's1' },
  events: [
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
  ],
}

/* =====================================================================
 * A 类·不变量：我们代码自身必须永远成立的行为
 * （以下断言与外部接口无关，放心长期维护）
 * ===================================================================== */

section('T1 apply/路由注册')
check('注册了 /voice/api 与 /voice/audio 两条路由', routes.length === 2 && !!apiHandler && !!audioHandler)
check('ping', (await rpc('ping')).ok === true)

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
check('首段 additions 含 context_texts + explicit_dialect=dongbei + section_id（不再发 cache_config：服务端缓存不认方言/音色，有害）',
  Array.isArray(fsAdd.context_texts) && fsAdd.explicit_dialect === 'dongbei' && fsAdd.cache_config === undefined && typeof fsAdd.section_id === 'string', fsAdd)
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
// 依据：tmp 下三轮探针音频 + 你旧项目 secretary-agent 的独立实测。
// - 内嵌 [#...] 会被逐字照读（D 实验：时长 2.37 倍）=> text 必须干净
// - 数值 speech_rate 可靠生效（-50 -> 时长 2.2 倍）=> 语速/音调走数值参数
// - context_texts 是官方指令通道（不计费、仅第一个值有效），效果依赖音色/措辞
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { apiKey: 'k-test', resourceId: 'seed-tts-2.0', speaker: 'spk-1', sampleRate: 24000, rateLevel: 3, pitchLevel: 1, interface: 'http' } } } })
const fetchCallsBefore = fetchState.calls.length // 记住调用数基线（T10 预览已产生过 1 次）
llmState.responses = [{ text: '火山转写结果', finish: 'stop' }]
const r4 = await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('ok 且返回 audioUrl', r4.ok === true && typeof r4.audioUrl === 'string' && r4.audioUrl.startsWith('/voice/audio/'))
check('外呼 1 次火山接口', fetchState.calls.length === fetchCallsBefore + 1 && fetchState.calls[fetchState.calls.length - 1].url.includes('openspeech.bytedance.com/api/v3/plan/tts/unidirectional'))
const body = fetchState.calls[fetchState.calls.length - 1].body
check('请求 text 无 [# 标签且为转写稿', body.req_params.text === '火山转写结果', body.req_params.text)
check('speaker 下发正确', body.req_params.speaker === 'spk-1')
check('语速档 3 -> speech_rate=30（数值参数）', body.req_params.audio_params.speech_rate === 30, body.req_params.audio_params)
const additions6 = body.req_params.additions ? JSON.parse(body.req_params.additions) : {}
check('音调档 1 -> additions.pitch=-3（半音）', additions6.post_process && additions6.post_process.pitch === -3, additions6)
// 指令由第二段 LLM 按文稿内容撰写（mock 默认回"用自然平稳的语气说"），
// 取代预设写死的机械指令——内容驱动的优先级 > 预设回退。
check('内容驱动指令 -> context_texts=[用自然平稳的语气说]', Array.isArray(additions6.context_texts) && additions6.context_texts[0] === '用自然平稳的语气说', additions6)
check('指令调用用的是独立 system prompt（演绎指令撰写器）', llmState.streamOpts.some((o) => o.system && o.system.includes('演绎指令')))
// 指令随转写稿一起缓存：同消息第二次播报，LLM 总调用数不再增长（转写+指令都复用）
const callsAfterFirst = llmState.calls.length
await rpc('speak', { sessionId: 's1', messageId: 'm4' })
check('第二次播报：LLM 调用数不变（转写与指令均缓存命中）', llmState.calls.length === callsAfterFirst, { callsAfterFirst, now: llmState.calls.length })

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
// 期望：标签从 text 里消失，内容出现在 context_texts 里（你旧项目的成熟设计）。
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
const s18a = await rpc('speak', { sessionId: 's1', messageId: 'm15' })
const sd18a = await awaitStreamDone(s18a.runId)
check('流式首次生成 ≥1 段', sd18a.res && sd18a.urls.length >= 1, sd18a.urls.length)
const callsMid18 = llmState.calls.length
check('流式首次产生 LLM 调用（转写+段落指令）', callsMid18 > callsBefore18, { callsBefore18, callsMid18 })
// 重播：缓存命中 → 转写与情感指令都用缓存，绝对零 LLM（不重新生成任何东西）
const s18b = await rpc('speak', { sessionId: 's1', messageId: 'm15' })
const sd18b = await awaitStreamDone(s18b.runId)
check('流式重播也产出音频（缓存稿单段直喂）', sd18b.res && sd18b.urls.length >= 1, sd18b.urls.length)
check('流式重播零 LLM（转写+情感指令都用缓存，LLM 调用数不变）', llmState.calls.length === callsMid18, llmState.calls.length - callsMid18)
// 反向：regen（重新生成）必须重新转写 + 重新生成情感指令（LLM 增加）
llmState.responses = [{ text: 'regen 全新转写。又有两句。', finish: 'stop' }, { text: '语气激动\n开心\n5', finish: 'stop' }]
const calls18c = llmState.calls.length
const s18c = await rpc('speak', { sessionId: 's1', messageId: 'm15', regen: true })
const sd18c = await awaitStreamDone(s18c.runId)
check('regen 重新生成：LLM 调用增加（转写+情感指令都重写）', llmState.calls.length > calls18c, llmState.calls.length - calls18c)
check('regen 流式也产出音频', sd18c.res && sd18c.urls.length >= 1, sd18c.urls.length)

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

// ---------- 收尾 ----------
// 善后三件事：恢复真 fetch（否则这个进程里再联网会打到假货）、删临时目录、交成绩单。
globalThis.fetch = realFetch
rmSync(home, { recursive: true, force: true })
console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed')
console.log('(B 类"外部事实快照"断言若失败：先跑 node scripts/tts-probe.mjs 拿新证据，再三处同步更新，见文件头第 5 条)')
process.exit(failed ? 1 : 0) // 退出码：0=全过，1=有失败（脚本工具靠它判断成败）
