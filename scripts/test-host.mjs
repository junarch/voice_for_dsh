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
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const { normalizeVoiceConfig, correctSpeakerForLanguage, correctLanguageForSpeaker, VV_SPEAKER, EN_DEFAULT_SPEAKER, ttsProviderOf, pitchOf, isLocalProvider } = await import('../packages/dsh-plugin-voice/lib/voice-compat.js')
// 本地运行时（local-runtime.js）：模型目录解析 / Float32→Int16 / WAV 封装 / 测试用引擎注入点
const { setEngineLoaderForTest, float32ToInt16Pcm, pcmToWav, resolveModelDir, inspectModelDir, createLocalRuntime } = await import('../packages/dsh-plugin-voice/lib/local-runtime.js')
// 模型安装器（model-installer.js）：下载/续传/校验/解包/删除；测试注入 fetch、解包与磁盘读数
const { createModelInstaller, setInstallerHooksForTest } = await import('../packages/dsh-plugin-voice/lib/model-installer.js')
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

const ctx = {
  get: (name) => (name === 'llm' ? llm : name === 'sessions' ? sessions : undefined),
  settings,
  webServer,
  on: (name, fn) => { if (!eventListeners.has(name)) eventListeners.set(name, []); eventListeners.get(name).push(fn) },
  effect: (fn) => { try { fn() } catch { /* 替身：dispose 回调不执行 */ } },
}

// 替身 6：fetch（网络电话）。插件调火山 TTS 用的是全局 fetch；
// 我们把它整个换成假货--不联网、立刻返回假音频，并记下"打了什么电话、说了什么"。
// 这就是为什么本测试零花费：外呼根本没发生，但请求体会被完整记下来供断言。
// 本地引擎不走网络（进程内合成），所以这里没有 /health、没有 127.0.0.1 分支。
const realFetch = globalThis.fetch
const fetchState = { calls: [], nextOk: true, hang: false, hangFail: false, hangReleasers: [] }
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
  const target = String(url)
  if (fetchState.hang) {
    // 模拟"云 TTS 不响应"：挂住直到超时 abort（或以 500 落地），用于验证超时分支。
    const signal = init && init.signal
    return await new Promise((resolve, reject) => {
      const settle = () => { if (fetchState.hangFail) resolve({ ok: false, status: 500, text: async () => 'hang released', arrayBuffer: async () => new ArrayBuffer(0) }); else reject(new Error('fetch failed')) }
      fetchState.hangReleasers.push(settle)
      if (!signal) return
      if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      else signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  const parsedBody = init && init.body ? JSON.parse(init.body) : null
  fetchState.calls.push({ url: target, local: false, body: parsedBody })
  if (!fetchState.nextOk) return { ok: false, status: 500, body: null, text: async () => 'mock tts boom', arrayBuffer: async () => new ArrayBuffer(0) }
  return fakeTtsResponse()
}

// ---------- 把真插件"装配"到替身上，并做 HTTP 请求的仿真驱动 ----------
// 装配（apply(ctx, config)）在下方"测试数据"段里、初始配置解析之后调用；路由处理器随后再取。
let apiHandler
let audioHandler
let soundsHandler

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
/** 模拟一次 /voice/sounds 请求：POST 的 body 按块喂（测累加上限），GET 无 body。 */
async function soundsRequest(method, url, body, headers) {
  const chunks = []
  if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
  const req = {
    method, url, headers: headers || {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  const res = {
    code: 0, headers: {}, body: null, text: '', mime: '',
    writeHead(c, h) { this.code = c; this.headers = h || {}; this.mime = (h && h['Content-Type']) || '' },
    end(b) {
      this.body = b === undefined ? null : b
      this.text = Buffer.isBuffer(b) ? b.toString('latin1') : String(b == null ? '' : b)
    },
  }
  await soundsHandler(req, res)
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
soundsHandler = (routes.find((r) => r.path === '/voice/sounds') || {}).handler

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
    msgEvent('mstop', 24, '停止播报后仍应保留完整转写，下次再点不再烧 token'),
    msgEvent('mcost', 25, '成本闸门测试内容'),
    msgEvent('msync', 26, 'FinishSession 同步返回测试内容'),
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
check('volatile 边界齐全（9 个顶层字段，缺一个设置页就写不进去）', configRefs(liveConfig).length === 9, configRefs(liveConfig).map((r) => r.path.join('.')))
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
check('注册了 /voice/api、/voice/audio、/voice/sounds 三条路由', routes.length === 3 && !!apiHandler && !!audioHandler && !!soundsHandler)
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
const wsState = { connections: 0, sessions: [], taskRequests: [], lastReqParams: null, suppressFinish: false }
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
      // suppressFinish 场景（"长稿还在播、用户先停"）：给一大块音频，确保首段在等待 SessionFinished 前就入队
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(wsState.suppressFinish ? 20000 : 3000, 0x11) })
    } else if (msg.event === EV.TaskRequest) {
      wsState.taskRequests.push(JSON.parse(msg.payload.toString()))
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(2500, 0x22) })
    } else if (msg.event === EV.FinishSession) {
      emit({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(2000, 0x33) })
      if (!wsState.suppressFinish) emit({ type: MSG.FullServerResponse, event: EV.SessionFinished })
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

section('T11e FinishSession 立即返回也能收尾（先登记等待者，不白等 60s）')
// 真机上服务端可能在 FinishSession 之后立刻回 SessionFinished；旧代码先发后登记等待者，
// 事件会在 await 间隙被丢弃 → 每段白等 60s（音频早播完，界面仍"朗读中"）。
class SyncFinishVolcWS extends MockVolcWS {
  _serve(msg) {
    if (msg.event === EV.FinishSession) {
      const emitSync = (frame) => {
        const b = encodeFrame(frame)
        const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
        if (this.onmessage) this.onmessage({ data: ab })
      }
      emitSync({ type: MSG.AudioOnlyServer, event: EV.TTSResponse, sessionId: msg.sessionId, payload: Buffer.alloc(6000, 0x55) })
      emitSync({ type: MSG.FullServerResponse, event: EV.SessionFinished })
      return
    }
    super._serve(msg)
  }
}
globalThis.WebSocket = SyncFinishVolcWS
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-stream' } }, language: 'auto', transcribe: { enabled: true } } })
llmState.responses = [{ text: '同步结束测试。', finish: 'stop' }]
const s11e = await rpc('speak', { sessionId: 's1', messageId: 'msync' })
const sd11e = await awaitStreamDone(s11e.runId, 3000)
check('同步 SessionFinished：3s 内收尾（不白等 60s）', !sd11e.timeout && !!sd11e.res, sd11e.timeout || sd11e.res)
check('同步结束：音频段仍正常产出', sd11e.urls.length >= 1, sd11e.urls.length)
globalThis.WebSocket = MockVolcWS
await rpc('setConfig', { patch: { language: 'auto' } })


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

section('T19b 停止播报不丢转写缓存（下次再点零 LLM，不重复烧 token）')
// 真实场景：用户听到第一段后点"停止"；旧实现把整条转写成果一起丢弃，下次再点从头转写。
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-stream', emotionGranularity: 'paragraph' } }, language: 'auto', transcribe: { stylePreset: 'standard', enabled: true } } })
wsState.suppressFinish = true // 让最后一段 session 不返回 SessionFinished，模拟"长稿还在播、用户先点停止"
llmState.responses = [{ text: '停止前已经完整转写的内容。第二句。', finish: 'stop' }]
const callsBeforeStop = llmState.calls.length
const s19b = await rpc('speak', { sessionId: 's1', messageId: 'mstop' })
let heard = false
for (let i = 0; i < 100 && !heard; i++) {
  const n = await rpc('streamNext', { runId: s19b.runId })
  if (n.url) heard = true
  else if (n.done) break
  await new Promise((r) => setTimeout(r, 10))
}
check('停止前已收到音频段（用户已听到）', heard === true)
await new Promise((r) => setTimeout(r, 200))
await rpc('stop')
await awaitStreamDone(s19b.runId)
wsState.suppressFinish = false
const callsAfterStopRun = llmState.calls.length
// 切 HTTP 路径（缓存可跨流式/HTTP 互读），对同一条消息重读：应命中缓存、零新增 LLM
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http' } } } })
llmState.responses = []
const r19b = await rpc('speak', { sessionId: 's1', messageId: 'mstop' })
check('停止后重读：转写缓存命中（cached=true）', r19b.ok === true && r19b.cached === true, r19b)
check('停止后重读：零新增 LLM（转写成果没被丢）', llmState.calls.length === callsAfterStopRun, llmState.calls.length - callsAfterStopRun)
check('停止后重读：文稿完整（不是半截）', r19b.transcript === '停止前已经完整转写的内容。第二句。', r19b.transcript)

section('T19c 段落情感指令有成本上限（长稿不再每两句话烧一次 LLM）')
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'bidirection', speaker: 'zh_female_vv_uranus_bigtts', apiKey: 'k-stream', emotionGranularity: 'paragraph' } }, language: 'auto', transcribe: { stylePreset: 'standard', enabled: true } } })
const longLines = Array.from({ length: 60 }, (_, i) => '第' + i + '句测试内容。').join('\n')
llmState.responses = [{ text: longLines, finish: 'stop' }]
const instrBefore = llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length
const s19c = await rpc('speak', { sessionId: 's1', messageId: 'mcost' })
const sd19c = await awaitStreamDone(s19c.runId)
const instrUsed = llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length - instrBefore
check('长稿仍产出音频段', sd19c.res && sd19c.urls.length >= 1, sd19c.urls.length)
check('段落指令调用有上限（≤12 次）', instrUsed > 0 && instrUsed <= 12, instrUsed)
await rpc('setConfig', { patch: { tts: { provider: 'volcengine', volcengine: { interface: 'http' } } } })

// ==========================================================
// 本地引擎（local）测试：全部走"进程内运行时"这条真路径，只把原生模型换成替身
// ==========================================================
// 为什么不用真模型：模型 387MB、加载要几秒，测试必须零依赖、秒级跑完。
// 替身只替换"怎么拿到 OfflineTts 实例"这一步，后面的切段 / Float32→Int16 /
// 分块入队 / 超时 / 错误分类全部是真的代码。真模型实测单独在 T23（有模型才跑）。

// ---- 模型目录夹具：一个"看起来完整"的模型目录（内容全是占位字节，不会真加载）----
function makeModelFixture(label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-model-' + label + '-'))
  for (const name of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst', 'phone-zh.fst']) {
    writeFileSync(path.join(dir, name), 'stub')
  }
  mkdirSync(path.join(dir, 'espeak-ng-data'), { recursive: true })
  return dir
}
const MODEL_FIXTURE = makeModelFixture('a')
const MODEL_FIXTURE2 = makeModelFixture('b') // 换目录 = 强制重新加载（测加载失败）

// ---- 引擎替身剧本 ----
const engineState = {
  loads: 0,             // 原生引擎被加载了几次
  config: null,         // 最近一次创建引擎时的配置（断言模型路径/线程/规则文件接线）
  calls: [],            // 每次合成：{ text, sid, speed }
  numSpeakers: 103,
  sampleRate: 24000,
  chunksPerCall: 2,     // 每次合成回调几块
  samplesPerChunk: 12000, // 每块 12000 采样 = 0.5s @24k（正好一块入队一段）
  failLoad: false,      // 加载失败（模拟原生模块/模型损坏）
  failFromCall: 0,      // 从第 N 次合成（1-based）起一直失败
  failOnlyCall: 0,      // 只让第 N 次合成失败
  hangFromCall: 0,      // 从第 N 次合成起挂住（不回调、不返回）
}
/** 造一块 Float32 采样：正弦波，便于断言"确实是 16bit 小端 PCM"。 */
function fakeSamples(seed) {
  const out = new Float32Array(engineState.samplesPerChunk)
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((i + seed) / 20) * 0.5
  return out
}
function fakeEngine(config) {
  engineState.loads++
  engineState.config = config
  if (engineState.failLoad) throw new Error('mock sherpa load failed')
  const tts = {
    numSpeakers: engineState.numSpeakers,
    sampleRate: engineState.sampleRate,
    generateAsync({ text, generationConfig, onProgress }) {
      const callNo = engineState.calls.length + 1
      engineState.calls.push({ text, sid: generationConfig && generationConfig.sid, speed: generationConfig && generationConfig.speed })
      if (engineState.failFromCall && callNo >= engineState.failFromCall) return Promise.reject(new Error('mock synth boom'))
      if (engineState.failOnlyCall && callNo === engineState.failOnlyCall) return Promise.reject(new Error('mock synth boom'))
      if (engineState.hangFromCall && callNo >= engineState.hangFromCall) return new Promise(() => {})
      for (let i = 0; i < engineState.chunksPerCall; i++) {
        if (onProgress) onProgress({ samples: fakeSamples(i * 7), progress: (i + 1) / engineState.chunksPerCall })
      }
      return Promise.resolve({ samples: fakeSamples(0), sampleRate: engineState.sampleRate })
    },
  }
  return Promise.resolve(tts)
}
setEngineLoaderForTest(fakeEngine)

// 替身安装时机：必须在 apply 之前（apply 里会创建运行时）。
// 注意：apply 已在文件上半部分调用过，运行时的引擎加载是懒的（第一次合成才调 loader），
// 所以这里设置仍然生效。

section('T20 本地引擎（local：进程内合成 / 中英跟随原文 / 零额外 LLM / 免费门控 / WAV / 失败分类）')
// —— 引擎归一（voice-compat 单测）——
check('ttsProviderOf：local 识别为 local', ttsProviderOf({ tts: { provider: 'local' } }) === 'local')
check('ttsProviderOf：旧值 openai-compatible 归一 browser', ttsProviderOf({ tts: { provider: 'openai-compatible' } }) === 'browser')
check('ttsProviderOf：未知值归一 browser', ttsProviderOf({ tts: { provider: 'whatever' } }) === 'browser')
check('ttsProviderOf：退役的 local-cosyvoice 归一到 local（旧配置的意图是本地引擎）', ttsProviderOf({ tts: { provider: 'local-cosyvoice' } }) === 'local')
check('isLocalProvider：local 与旧值 local-cosyvoice 都算本地（免费，不受云门控）', isLocalProvider({ tts: { provider: 'local' } }) && isLocalProvider({ tts: { provider: 'local-cosyvoice' } }) && !isLocalProvider({ tts: { provider: 'volcengine' } }))
// meta 暴露本地音色清单（设置页下拉数据源）：sid 是数字字符串
const meta20 = await rpc('meta')
check('meta 带本地音色清单（sid 48 在列）', Array.isArray(meta20.kokoroVoices) && meta20.kokoroVoices.some((v) => v.id === '48'), meta20.kokoroVoices && meta20.kokoroVoices.length)
check('meta 不再有 cosyvoiceVoices（CosyVoice 已退役）', meta20.cosyvoiceVoices === undefined)

// —— Float32 → Int16 纯函数（客户端只认 16bit 小端裸 PCM）——
const conv = float32ToInt16Pcm(new Float32Array([0, 1, -1, 0.5, -0.5, 1.5, -2]))
check('Float32→Int16：满量程 ±1 → ±32767', conv.readInt16LE(2) === 32767 && conv.readInt16LE(4) === -32767, [conv.readInt16LE(2), conv.readInt16LE(4)])
check('Float32→Int16：0.5 → 16384（四舍五入）', conv.readInt16LE(6) === 16384, conv.readInt16LE(6))
check('Float32→Int16：超范围钳位到 ±32767（不溢出成噪声）', conv.readInt16LE(10) === 32767 && conv.readInt16LE(12) === -32767, [conv.readInt16LE(10), conv.readInt16LE(12)])
check('Float32→Int16：字节数 = 采样数×2（16bit 单声道）', conv.length === 14, conv.length)
const wavHead = pcmToWav(conv, 24000)
check('PCM→WAV：44 字节头 + RIFF/WAVE 魔数 + 24kHz 单声道 16bit', wavHead.slice(0, 4).toString('ascii') === 'RIFF'
  && wavHead.slice(8, 12).toString('ascii') === 'WAVE' && wavHead.readUInt32LE(24) === 24000
  && wavHead.readUInt16LE(22) === 1 && wavHead.readUInt16LE(34) === 16 && wavHead.length === 44 + conv.length, wavHead.length)

// —— 首次朗读前引擎还没加载（懒加载：不点朗读就不吃 387MB）——
check('首次朗读前原生引擎未加载（懒加载）', engineState.loads === 0, engineState.loads)

// —— 切到 local：转写稿保持原文语言（无英文不变式）；零情感指令调用；进程内合成出 WAV ——
const localCfg = (extra) => ({ patch: { language: 'auto', transcribe: { stylePreset: 'standard' }, tts: { provider: 'local', local: Object.assign({ sid: 48, speed: 1, numThreads: 4, modelDir: MODEL_FIXTURE, timeoutMs: 30000, streaming: false }, extra || {}) } } })
await rpc('setConfig', localCfg())
engineState.calls = []
llmState.responses = [{ text: '本地中文转写稿，保持中文。', finish: 'stop' }]
const instrCount20 = llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length
const calls20 = llmState.calls.length
const r20 = await rpc('speak', { sessionId: 's1', messageId: 'm1' })
const sys20 = llmState.streamOpts[llmState.streamOpts.length - 1] && llmState.streamOpts[llmState.streamOpts.length - 1].system
check('speak ok 且挂了音频路由', r20.ok === true && typeof r20.audioUrl === 'string' && r20.audioUrl.startsWith('/voice/audio/'), r20)
check('转写 prompt 不再有"必须输出英文"不变式', !!sys20 && !sys20.includes('必须用英文') && !sys20.includes('不得输出中文'), sys20 && sys20.slice(-120))
check('转写稿保持原文语言（中文不被改成英文）', r20.transcript === '本地中文转写稿，保持中文。', r20.transcript)
check('零情感指令 LLM 调用（本地引擎没有 context_texts 通道）', llmState.streamOpts.filter((o) => String(o.system).includes('演绎指令')).length === instrCount20)
check('LLM 只调 1 次（转写；重播零新增由 T3/T18 保证）', llmState.calls.length === calls20 + 1, llmState.calls.length - calls20)
check('进程内合成被调用一次，带 sid/speed', engineState.calls.length === 1 && engineState.calls[0].sid === 48 && engineState.calls[0].speed === 1, engineState.calls)
check('送合成的是转写稿本身（中文，未经英文改写）', engineState.calls[0].text === '本地中文转写稿，保持中文。', engineState.calls[0].text)
check('引擎配置接线：model/voices/tokens/espeak-ng-data 指向模型目录', !!engineState.config
  && String(engineState.config.model.kokoro.model).endsWith('model.onnx')
  && String(engineState.config.model.kokoro.voices).endsWith('voices.bin')
  && String(engineState.config.model.kokoro.tokens).endsWith('tokens.txt')
  && String(engineState.config.model.kokoro.dataDir).endsWith('espeak-ng-data'), engineState.config && engineState.config.model.kokoro)
check('引擎配置接线：中文数字规则文件（date/number/phone-zh.fst）已挂上', !!engineState.config && String(engineState.config.ruleFsts).includes('number-zh.fst'), engineState.config && engineState.config.ruleFsts)
check('引擎配置接线：线程数来自配置（numThreads=4）', !!engineState.config && engineState.config.numThreads === 4, engineState.config && engineState.config.numThreads)
check('引擎配置接线：中英词典都挂上（lexicon-us-en + lexicon-zh）', !!engineState.config
  && String(engineState.config.model.kokoro.lexicon).includes('lexicon-us-en.txt')
  && String(engineState.config.model.kokoro.lexicon).includes('lexicon-zh.txt'), engineState.config && engineState.config.model.kokoro.lexicon)
check('引擎只加载一次（第二次朗读复用实例）', engineState.loads === 1, engineState.loads)
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

// —— 降级直读（LLM 挂了，直读原文）：本地引擎能读中文 → 照样出声，不再回退系统朗读 ——
llmState.failAll = true
engineState.calls = []
const r20c = await rpc('speak', { sessionId: 's1', messageId: 'm3' })
check('降级直读：本地引擎仍合成（audioUrl 有值，degraded=true）', r20c.ok === true && r20c.degraded === true && typeof r20c.audioUrl === 'string', { d: r20c.degraded, a: r20c.audioUrl })
check('降级直读：中文原文直接送本地合成', engineState.calls.length === 1 && engineState.calls[0].text === '降级测试', engineState.calls[0] && engineState.calls[0].text)
llmState.failAll = false

// —— 转写关闭 + local：不调模型、直接本地合成中文（旧行为是回退系统朗读）——
sessionEvents.push(msgEvent('m19', 31, '转写关闭直读内容'))
await rpc('setConfig', { patch: { transcribe: { enabled: false } } })
const calls20d = llmState.calls.length
engineState.calls = []
const r20d = await rpc('speak', { sessionId: 's1', messageId: 'm19' })
check('转写关闭 + local：直接本地合成音频（中文可读）', r20d.ok === true && typeof r20d.audioUrl === 'string', r20d)
check('转写关闭 + local：零 LLM 调用（直读不烧 token）', llmState.calls.length === calls20d, llmState.calls.length - calls20d)
check('转写关闭 + local：不再有"回退系统朗读"的 notice', r20d.notice === undefined, r20d.notice)
check('转写关闭 + local：送合成的是去 Markdown 的中文原文', engineState.calls.length === 1 && engineState.calls[0].text.includes('转写关闭直读内容'), engineState.calls[0] && engineState.calls[0].text)
await rpc('setConfig', { patch: { transcribe: { enabled: true } } })

// —— preview：local 走进程内合成（语言跟随 voice.language；auto → 中文样例）——
engineState.calls = []
const pv20 = await rpc('preview')
check('preview 走本地合成', pv20.ok === true && pv20.mode === 'audio' && typeof pv20.audioUrl === 'string', pv20)
check('preview 中文样例（auto 语言）', engineState.calls.length === 1 && String(engineState.calls[0].text).startsWith('你好'), engineState.calls[0] && engineState.calls[0].text)
await rpc('setConfig', { patch: { language: 'en' } })
engineState.calls = []
await rpc('preview')
check('preview 语言固定 en → 英文样例', engineState.calls.length === 1 && String(engineState.calls[0].text).startsWith('Hi, this is a preview'), engineState.calls[0] && engineState.calls[0].text)
await rpc('setConfig', { patch: { language: 'auto' } })

// —— 模型未安装：一条明确的"模型未安装"，不静默失败 ——
// 语义：模型目录被删/被指到空目录后，即使之前加载过也要按"未安装"报错（验收要求），
// 而不是拿内存里那份继续出声。
sessionEvents.push(msgEvent('m20x', 32, '模型缺失测试内容'))
await rpc('setConfig', localCfg({ modelDir: path.join(MODEL_FIXTURE, 'no-such-dir') }))
const loadsBefore20x = engineState.loads
const r20x = await rpc('speak', { sessionId: 's1', messageId: 'm20x' })
check('模型目录不存在 → ttsErrorKind=model-missing', r20x.ttsErrorKind === 'model-missing', { k: r20x.ttsErrorKind, e: r20x.ttsError })
check('模型未安装文案明确中文说明 + 缺什么', /模型未安装/.test(String(r20x.ttsError)) && /模型目录/.test(String(r20x.ttsError)) && /kokoro-multi-lang-v1_1/.test(String(r20x.ttsError)), r20x.ttsError)
check('模型缺失时不加载引擎（不白吃内存）', engineState.loads === loadsBefore20x, engineState.loads - loadsBefore20x)

// —— 加载失败：ttsErrorKind=load-failed，且同一个错误只打一次日志 ——
// 换到另一个（看起来完整的）模型目录 = 强制重新加载，让替身在这一步抛错。
const consoleErrors = []
const realConsoleError = console.error
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); }
engineState.failLoad = true
await rpc('setConfig', localCfg({ modelDir: MODEL_FIXTURE2 }))
const r20y = await rpc('speak', { sessionId: 's1', messageId: 'm20x', regen: true })
const r20y2 = await rpc('speak', { sessionId: 's1', messageId: 'm20x', regen: true })
engineState.failLoad = false
console.error = realConsoleError
check('加载失败 → ttsErrorKind=load-failed', r20y.ttsErrorKind === 'load-failed', { k: r20y.ttsErrorKind, e: r20y.ttsError })
check('加载失败文案含原因（不吞异常）', /加载失败/.test(String(r20y.ttsError)), r20y.ttsError)
check('加载失败只报一次日志（连续两次朗读只有一条）', consoleErrors.filter((m) => m.includes('local tts load failed')).length === 1, consoleErrors.length)
await rpc('setConfig', localCfg())

// —— 合成失败：ttsErrorKind=synth-failed ——
sessionEvents.push(msgEvent('m20z', 33, '合成失败测试内容'))
engineState.calls = []
engineState.failFromCall = 1
const r20z = await rpc('speak', { sessionId: 's1', messageId: 'm20z' })
engineState.failFromCall = 0
check('原生合成抛错 → ttsErrorKind=synth-failed', r20z.ttsErrorKind === 'synth-failed', { k: r20z.ttsErrorKind, e: r20z.ttsError })
check('合成失败文案保留底层原因', /mock synth boom/.test(String(r20z.ttsError)), r20z.ttsError)

// —— 超时：整段合成卡住 → ttsErrorKind=timeout ——
sessionEvents.push(msgEvent('m20t', 34, '超时测试内容'))
engineState.calls = []
engineState.hangFromCall = 1
await rpc('setConfig', localCfg({ timeoutMs: 200 }))
const t20t0 = Date.now()
const r20t = await rpc('speak', { sessionId: 's1', messageId: 'm20t' })
engineState.hangFromCall = 0
check('合成卡住 → ttsErrorKind=timeout（不死等）', r20t.ttsErrorKind === 'timeout' && Date.now() - t20t0 < 5000, { k: r20t.ttsErrorKind, ms: Date.now() - t20t0 })
await rpc('setConfig', localCfg())

// ================= T21 本机运行时（模型目录解析 / 自检 / 停止） =================
section('T21 本地运行时（模型目录解析 / 自检读数 / 停止）')

// —— 模型目录解析顺序：配置覆盖 > env > 用户目录 > 仓库 local/models ——
const resolvedCfgDir = resolveModelDir({ override: MODEL_FIXTURE, pluginUrl: import.meta.url })
check('模型目录：配置覆盖生效（source=config）', resolvedCfgDir.exists === true && resolvedCfgDir.source === 'config' && resolvedCfgDir.dir === MODEL_FIXTURE, resolvedCfgDir)
const resolvedMissing = resolveModelDir({ override: '', pluginUrl: 'file:///Q:/no-such-place/lib/index.js', envDir: '' })
check('模型目录：都没有时指向用户目录预期位置（exists=false）', resolvedMissing.exists === false && /voice[\\/]models/.test(resolvedMissing.dir), resolvedMissing)
const resolvedBadOverride = resolveModelDir({ override: path.join(MODEL_FIXTURE, 'no-such-dir'), pluginUrl: import.meta.url, envDir: '' })
check('模型目录：显式指定但目录不存在 → 不静默回落到别的模型（exists=false）', resolvedBadOverride.exists === false && resolvedBadOverride.source === 'config', resolvedBadOverride)
const inspectOk = inspectModelDir(MODEL_FIXTURE)
check('模型目录检查：完整目录 → ok 且认出 fp32 模型文件', inspectOk.ok === true && inspectOk.model.endsWith('model.onnx'), inspectOk)
const halfModel = mkdtempSync(path.join(tmpdir(), 'voice-model-half-'))
writeFileSync(path.join(halfModel, 'model.onnx'), 'stub')
const inspectHalf = inspectModelDir(halfModel)
check('模型目录检查：半截目录 → 列出缺失项（voices.bin / espeak-ng-data 等）', inspectHalf.ok === false
  && inspectHalf.missing.some((m) => m.includes('voices.bin')) && inspectHalf.missing.some((m) => m.includes('espeak-ng-data')), inspectHalf.missing)
rmSync(halfModel, { recursive: true, force: true })

// —— localStatus：报运行时状态（模型目录/是否加载/音色数/采样率/线程数）——
engineState.calls = []
const st21 = await rpc('localStatus')
check('localStatus：installed=true 且带模型目录', st21.ok === true && st21.installed === true && st21.modelDir === MODEL_FIXTURE, st21)
check('localStatus：报告已加载 + 音色数（103）+ 采样率（24k）+ 线程数', st21.loaded === true && st21.numSpeakers === 103 && st21.sampleRate === 24000 && st21.numThreads === 4, st21)
check('localStatus：报告模型文件名与加载耗时', String(st21.modelFile).includes('model.onnx') && typeof st21.loadMs === 'number' && st21.loadMs >= 0, st21)
await rpc('setConfig', localCfg({ modelDir: path.join(MODEL_FIXTURE, 'no-such-dir') }))
const st21b = await rpc('localStatus')
check('localStatus：模型缺失 → installed=false + 中文说明（不抛错）', st21b.ok === true && st21b.installed === false && /模型未安装/.test(String(st21b.error)), st21b)
await rpc('setConfig', localCfg())

// —— 停止：流式播报中途 stop → run 正常收尾，队列不再增长 ——
await rpc('setConfig', localCfg({ streaming: true, segmentChars: 60 }))
sessionEvents.push(msgEvent('m21stop', 40, '停止测试长稿'))
llmState.responses = [{ text: ('这是用于停止测试的一句话。'.repeat(20)), finish: 'stop' }]
const s21stop = await rpc('speak', { sessionId: 's1', messageId: 'm21stop' })
check('流式 speak 立即返回 runId', s21stop.ok === true && s21stop.mode === 'stream' && typeof s21stop.runId === 'string', s21stop)
await rpc('stop')
const sd21stop = await awaitStreamDone(s21stop.runId)
check('stop 后 run 正常收尾（无死锁、有 done）', !!sd21stop.res && sd21stop.res.done === true, sd21stop)
await rpc('setConfig', localCfg())

// ================= T22 本地分句流式（分块入队 / 中途失败 / 首段失败降级 / 整段失败） =================
section('T22 本地分句流式（分块入队 / 中途失败 / 首段失败降级 / 段超时）')

const LOCAL_STREAM_CFG = { sid: 48, speed: 1, numThreads: 4, modelDir: MODEL_FIXTURE, timeoutMs: 30000, streaming: true, segmentChars: 300, segmentTimeoutMs: 30000 }
const localStreamPatch = (extra) => ({ patch: { tts: { provider: 'local', local: Object.assign({}, LOCAL_STREAM_CFG, extra || {}) } } })
// 长稿：8 句 × ~185 字符 ≈ 1480 字符 → segmentChars=300 时应切成 ≥4 段（且每段 ≤ 600 = 2×target）
const LONG_SENTENCE = 'The quick brown fox jumps over the lazy dog while the local engine keeps synthesizing audio in small chunks so that playback can start almost immediately instead of waiting for the entire transcript to finish. '
const LONG_TRANSCRIPT = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => LONG_SENTENCE.trim() + ' Number ' + i + '.').join(' ')

engineState.failFromCall = 0
engineState.hangFromCall = 0
engineState.calls = []
await rpc('setConfig', localStreamPatch())

// —— 22a：默认（streaming=true）走分句流式 ——
sessionEvents.push(msgEvent('m22a', 51, 'Long streaming source'))
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const r22a = await rpc('speak', { sessionId: 's1', messageId: 'm22a' })
check('streaming 默认开 → mode=stream + runId', r22a.ok === true && r22a.mode === 'stream' && typeof r22a.runId === 'string', r22a)
check('流式响应带 sampleRate（24k）', r22a.sampleRate === 24000, r22a.sampleRate)
const sd22a = await awaitStreamDone(r22a.runId)
check('长稿被切成 ≥3 段合成（分句流式生效）', engineState.calls.length >= 3, engineState.calls.length)
check('每段 format=pcm（裸采样，零解码延迟）', sd22a.formats.length >= 1 && sd22a.formats.every((f) => f === 'pcm'), sd22a.formats)
check('每段合成文本互不相同（确实是分句，不是整篇重复）', new Set(engineState.calls.map((c) => c.text)).size >= 3, engineState.calls.map((c) => c.text.length))
// 边出边入队：一次段合成内出现多个音频分块 → 播放器不必等整段算完
check('边收边入队：音频分块数 > 段合成数（0.5s 粒度切块）', sd22a.urls.length > engineState.calls.length, { audioChunks: sd22a.urls.length, engineCalls: engineState.calls.length })
check('流式结束 done=true', !!(sd22a.res && sd22a.res.done === true), sd22a.res)
check('流式全程零 LLM 额外调用（本地无情感指令通道）', sd22a.res && sd22a.res.error === undefined)

// —— 22b：段音频是 16bit 小端 PCM（字节数偶数、内容=替身采样的转换）——
const seg22 = await fetchAudio(sd22a.urls[0].replace('/voice/audio/', ''))
check('首段音频可取（裸 PCM，字节数为偶数且 > 0）', seg22.code === 200 && seg22.body && seg22.body.length > 0 && seg22.body.length % 2 === 0, seg22.body && seg22.body.length)
check('首段音频 mime=audio/pcm', seg22.mime === 'audio/pcm', seg22.mime)
// 替身第一块 = fakeSamples(0)：第 0 个采样为 0，第 10 个采样 = sin(0.5)*0.5 ≈ 0.2397 → 7854
const expected10 = Math.round(Math.sin(10 / 20) * 0.5 * 32767)
check('首段字节与 Float32 转换一致（第 10 个采样）', Math.abs(seg22.body.readInt16LE(20) - expected10) <= 1, { got: seg22.body.readInt16LE(20), want: expected10 })

// —— 22c：重播命中转写缓存 → 零新增 LLM 调用 ——
const callsBeforeReplay22 = llmState.calls.length
engineState.calls = []
const r22c = await rpc('speak', { sessionId: 's1', messageId: 'm22a' })
const sd22c = await awaitStreamDone(r22c.runId)
check('重播仍产出音频段', sd22c.urls.length >= 3, sd22c.urls.length)
check('重播零 LLM（转写缓存命中）', llmState.calls.length === callsBeforeReplay22, llmState.calls.length - callsBeforeReplay22)

// —— 22d：中途某段失败 → 保留已播段 + warn，不整条报错 ——
sessionEvents.push(msgEvent('m22d', 52, 'Mid-stream failure source'))
engineState.calls = []
engineState.failFromCall = 3
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const r22d = await rpc('speak', { sessionId: 's1', messageId: 'm22d' })
const sd22d = await awaitStreamDone(r22d.runId)
engineState.failFromCall = 0
check('中途失败：已播段保留（≥2 段）', sd22d.urls.length >= 2, sd22d.urls.length)
check('中途失败：warn 说明后续未播报', !!(sd22d.res && sd22d.res.warn && sd22d.res.warn.includes('合成失败')), sd22d.res && sd22d.res.warn)
check('中途失败：不当作整条错误（error 为空）', !(sd22d.res && sd22d.res.error), sd22d.res && sd22d.res.error)

// —— 22e：首段即失败 → 降级整段合成（wav 单段），用户仍能听到 ——
sessionEvents.push(msgEvent('m22e', 53, 'First segment fails source'))
engineState.calls = []
engineState.failOnlyCall = 1 // 只让第一次合成（首段）失败；整段兜底那次成功
llmState.responses = [{ text: LONG_TRANSCRIPT, finish: 'stop' }]
const r22e = await rpc('speak', { sessionId: 's1', messageId: 'm22e' })
const sd22e = await awaitStreamDone(r22e.runId)
engineState.failOnlyCall = 0
check('首段失败 → 降级出 1 段音频', sd22e.urls.length === 1, sd22e.urls.length)
check('降级段 format=wav（整段 WAV 兜底）', sd22e.formats[0] === 'wav', sd22e.formats)
check('降级 warn 说明"回退为整段合成"', !!(sd22e.res && sd22e.res.warn && sd22e.res.warn.includes('回退')), sd22e.res && sd22e.res.warn)
check('降级后不算失败（error 为空）', !(sd22e.res && sd22e.res.error), sd22e.res && sd22e.res.error)

// —— 22f：整条流式全失败（每段都超时） → errorKind=timeout + 降级整段仍出声 ——
// hangFromCall=1：所有合成都不返回（连整段兜底也超时）；再把 timeoutMs 调小，
// 验证"段级超时"与"整段超时"两条线都真的会停，不死等。
sessionEvents.push(msgEvent('m22f', 54, 'Segment timeout source'))
engineState.calls = []
engineState.hangFromCall = 1
await rpc('setConfig', localStreamPatch({ segmentTimeoutMs: 200, timeoutMs: 200 }))
llmState.responses = [{ text: LONG_TRANSCRIPT + ' Extra tail sentence for the timeout case.', finish: 'stop' }]
const t22f0 = Date.now()
const r22f = await rpc('speak', { sessionId: 's1', messageId: 'm22f' })
check('speak 立即返回（不等合成完成）', Date.now() - t22f0 < 1000, Date.now() - t22f0)
const sd22f = await awaitStreamDone(r22f.runId, 12000)
engineState.hangFromCall = 0
await rpc('setConfig', localStreamPatch({ segmentTimeoutMs: 30000, timeoutMs: 30000 }))
check('段级超时 → errorKind=timeout（客户端选专用文案）', !!(sd22f.res && sd22f.res.errorKind === 'timeout'), { kind: sd22f.res && sd22f.res.errorKind, error: sd22f.res && sd22f.res.error })
check('超时文案说明是本地合成超时', /超时/.test(String(sd22f.res && sd22f.res.error)), sd22f.res && sd22f.res.error)
check('整条流式全失败 → run 仍收尾（done=true，不死等）', !!(sd22f.res && sd22f.res.done === true), sd22f.res)

// —— 22f2：部分段失败且已播出内容 → 保留 errorKind（不谎报"全部成功"） ——
sessionEvents.push(msgEvent('m22f2', 56, 'Partial failure source'))
engineState.calls = []
engineState.failFromCall = 3
llmState.responses = [{ text: LONG_TRANSCRIPT + ' Partial variant tail.', finish: 'stop' }]
const r22f2 = await rpc('speak', { sessionId: 's1', messageId: 'm22f2' })
const sd22f2 = await awaitStreamDone(r22f2.runId)
engineState.failFromCall = 0
check('部分失败：已播段 + errorKind=synth-failed 都保留', sd22f2.urls.length >= 2 && sd22f2.res && sd22f2.res.errorKind === 'synth-failed', { urls: sd22f2.urls.length, kind: sd22f2.res && sd22f2.res.errorKind })
check('部分失败：warn 说明从第几段起未播报', !!(sd22f2.res && /段起合成失败/.test(String(sd22f2.res.warn))), sd22f2.res && sd22f2.res.warn)

// —— 22g：streaming=false → 回整段合成（无 stream 模式） ——
sessionEvents.push(msgEvent('m22g', 55, 'Non-streaming source'))
await rpc('setConfig', localStreamPatch({ streaming: false, timeoutMs: 30000 }))
engineState.calls = []
llmState.responses = [{ text: 'Short non-streaming transcript.', finish: 'stop' }]
const r22g = await rpc('speak', { sessionId: 's1', messageId: 'm22g' })
check('streaming=false → 非流式（直接给 audioUrl）', r22g.ok === true && r22g.mode === undefined && typeof r22g.audioUrl === 'string', r22g)
check('streaming=false → 整段一次合成', engineState.calls.length === 1, engineState.calls.length)

// —— 22h：splitForStream 纯函数（切分不丢字、段长受控） ——
const segs22h = splitForStream(LONG_TRANSCRIPT, 300)
check('splitForStream：长稿切成 ≥3 段', segs22h.length >= 3, segs22h.length)
check('splitForStream：每段 ≤ 2×target（600）', segs22h.every((s) => s.length <= 600), segs22h.map((s) => s.length))
check('splitForStream：拼接后与原文一致（去空白比对）', segs22h.join(' ').replace(/\s+/g, '') === LONG_TRANSCRIPT.replace(/\s+/g, ''))
check('splitForStream：短稿整段返回（不硬切）', splitForStream('One short sentence.', 300).length === 1)
check('splitForStream：优先切在句末（首段以标点结尾）', /[.!?。！？]$/.test(segs22h[0]), segs22h[0].slice(-20))
await rpc('setConfig', { patch: { tts: { provider: 'browser', local: { streaming: true, segmentChars: 300, segmentTimeoutMs: 30000 } } } })

// =====================================================================
// T23 真模型端到端（有模型才跑；fp32 包，进程内出声）
// =====================================================================
section('T23 真模型端到端（进程内出声 / 数字可读 / 中英混读）')
// 说明：测试不下载模型。运行前把 VOICE_LOCAL_MODEL_DIR 指向解包好的
// kokoro-multi-lang-v1_1（model.onnx + voices.bin + tokens.txt + espeak-ng-data），
// 这段才会真加载 387MB 模型并合成；否则跳过（不把"没模型"当失败）。
const realModelDir = process.env.VOICE_LOCAL_MODEL_DIR || ''
const realModelInfo = realModelDir ? inspectModelDir(realModelDir) : { ok: false, missing: ['VOICE_LOCAL_MODEL_DIR 未设置'] }
if (!realModelInfo.ok) {
  console.log('  skip 真模型实测（' + realModelInfo.missing.join('、') + ' 未就绪；设 VOICE_LOCAL_MODEL_DIR 后可跑）')
} else {
  // 真模型这一段必须走真 sherpa：把上面的引擎替身摘掉，跑完再装回来
  setEngineLoaderForTest(null)
  const realRuntime = createLocalRuntime({ pluginUrl: import.meta.url, getConfig: () => ({ tts: { local: { sid: 48, speed: 1, numThreads: 4, modelDir: realModelDir } } }) })
  const t23load = Date.now()
  const realStatus = await realRuntime.status() // 这次会真的加载模型（自检语义）
  const coldMs = Date.now() - t23load
  // 首声读数：模型已加载后，从"开始合成"到"第一块音频到手"
  const t23a = Date.now()
  let first = 0, total = 0
  for await (const pcm of realRuntime.streamPcm({ text: '你好，这是本地语音播报的测试。', timeoutMs: 60000 })) {
    if (!first) first = Date.now() - t23a
    total += pcm.length
  }
  const synthMs = Date.now() - t23a
  const durSec = total / (2 * 24000)
  console.log('  # 真模型读数：冷启动加载 ' + coldMs + 'ms · 首声 ' + first + 'ms · 合成本段 ' + synthMs
    + 'ms / 音频 ' + durSec.toFixed(2) + 's · RTF ' + (synthMs / 1000 / durSec).toFixed(2))
  check('真模型：中文一句在进程内合成出音频', total > 24000 * 0.5, { bytes: total, firstMs: first })
  check('真模型：首声 ≤ 2s（模型已加载；验收线）', first > 0 && first <= 2000, first)
  check('真模型：冷启动（加载模型 + 首声）≤ 10s', coldMs + first <= 10000, { coldMs, first })
  check('真模型：输出是 16bit 小端 PCM（字节数为偶数）', total % 2 === 0, total)
  check('真模型：自检报出音色数 103 / 采样率 24000', realStatus.numSpeakers === 103 && realStatus.sampleRate === 24000, realStatus)
  // 数字可读：同一句加不加数字，音频时长应明显不同（数字被读出来才有这个差）
  const synthDur = async (text) => {
    let bytes = 0
    for await (const pcm of realRuntime.streamPcm({ text, timeoutMs: 60000 })) bytes += pcm.length
    return bytes / (2 * 24000)
  }
  const withNum = await synthDur('今天的转化率下降了68%，主要原因是流量质量。')
  const noNum = await synthDur('今天的转化率下降了，主要原因是流量质量。')
  check('真模型：阿拉伯数字能读出来（加数字后时长 +0.3s 以上）', withNum - noNum > 0.3, { withNum: +withNum.toFixed(2), noNum: +noNum.toFixed(2) })
  const enDur = await synthDur('The conversion rate dropped 68 percent this month.')
  check('真模型：英文一句也能读（时长 > 1s）', enDur > 1, +enDur.toFixed(2))
  const mixDur = await synthDur('你好，这是中英混读 test 一二三。')
  check('真模型：中英混读一句能出声（时长 > 1s）', mixDur > 1, +mixDur.toFixed(2))
  // 换个音色（英文音色 sid 0）也要能出声：证明 sid 真的透传给了引擎
  const rtSid0 = createLocalRuntime({ pluginUrl: import.meta.url, getConfig: () => ({ tts: { local: { sid: 0, speed: 1, numThreads: 4, modelDir: realModelDir } } }) })
  let bytesSid0 = 0
  for await (const pcm of rtSid0.streamPcm({ text: 'Hello, this is a voice check.', timeoutMs: 60000 })) bytesSid0 += pcm.length
  check('真模型：换 sid（英文音色 0）也能合成', bytesSid0 > 24000, bytesSid0)
}


// =====================================================================
// T24 模型安装器（下载 / 续传 / 校验失败 / 取消 / 磁盘不足 / 删除）
// =====================================================================
// 全部零网络、零 348MB：用注入的假 fetch 供一小段字节，用注入的解包函数摆出
// "关键的 9 个文件"。被真实验证的仍是安装器自己的逻辑：流式写盘、Range 续传、
// sha256 校验、临时目录清理、单任务、磁盘预检、删除范围判定。
section('T24 模型安装器（下载 / 续传 / 校验失败 / 取消 / 磁盘不足 / 删除）')
// 本段不测真合成：把引擎替身装回来（T23 真模型段会把它摘掉），避免 localStatus 真去加载夹具模型。
setEngineLoaderForTest(fakeEngine)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEPLOY_ARCHIVE = Buffer.alloc(200000)
for (let i = 0; i < DEPLOY_ARCHIVE.length; i++) DEPLOY_ARCHIVE[i] = (i * 37 + 11) % 251
const DEPLOY_SHA = createHash('sha256').update(DEPLOY_ARCHIVE).digest('hex')
const DEPLOY_ETAG = '"fixture-etag-1"'
const DEPLOY_FILES = [
  { name: 'model.onnx', bytes: 10 },
  { name: 'voices.bin', bytes: 5 },
  { name: 'tokens.txt', bytes: 3 },
  { name: 'lexicon-us-en.txt', bytes: 2 },
  { name: 'lexicon-zh.txt', bytes: 2 },
  { name: 'date-zh.fst', bytes: 1 },
  { name: 'number-zh.fst', bytes: 1 },
  { name: 'phone-zh.fst', bytes: 1 },
  { name: 'espeak-ng-data', dir: true },
]
const deployManifest = (over) => Object.assign({
  version: 'kokoro-multi-lang-v1_1',
  displayVersion: 'v1.1',
  sourceLabel: '测试来源',
  url: 'https://example.test/kokoro-multi-lang-v1_1.tar.bz2',
  archiveBytes: DEPLOY_ARCHIVE.length,
  archiveSha256: DEPLOY_SHA,
  extractedBytes: 26,
  keyFiles: DEPLOY_FILES,
}, over || {})
/** 假解包：在目标目录下摆出 `kokoro-multi-lang-v1_1/` 与全部关键文件。 */
async function deployExtract(_archive, dest) {
  const dir = path.join(dest, 'kokoro-multi-lang-v1_1')
  mkdirSync(path.join(dir, 'espeak-ng-data'), { recursive: true })
  for (const file of DEPLOY_FILES) if (!file.dir) writeFileSync(path.join(dir, file.name), 'x'.repeat(file.bytes))
  writeFileSync(path.join(dir, 'LICENSE'), 'fixture')
}
/**
 * 假下载源：按 Range 供字节、能中途断网、能放慢，并记下每次请求的 Range 与"请求那一刻的进度"。
 * @param opts.chunk - 每次给多少字节
 * @param opts.delayMs - 每块之间的延迟（测取消用）
 * @param opts.failAfterBytes - 第一次请求给出这么多字节后断网（测续传）
 * @param opts.status - () => installer.status()（记录断点续传时进度有没有清零）
 */
function makeDeployFetch(opts = {}) {
  const state = { calls: [], receivedAtCall: [] }
  const chunk = opts.chunk || 32768
  const getStatus = opts.status || (() => ({ received: 0 }))
  async function* body(from, failAfter) {
    let off = from
    while (off < DEPLOY_ARCHIVE.length) {
      if (opts.delayMs) await sleep(opts.delayMs)
      const end = Math.min(off + chunk, DEPLOY_ARCHIVE.length)
      yield DEPLOY_ARCHIVE.subarray(off, end)
      off = end
      if (failAfter && off >= from + failAfter) throw new Error('socket hang up')
    }
  }
  state.fetch = async (_url, init) => {
    const headers = (init && init.headers) || {}
    const range = headers.Range || ''
    const from = range ? Number(String(range).replace('bytes=', '').replace('-', '')) : 0
    state.calls.push({ range, ifRange: headers['If-Range'] || '', from })
    state.receivedAtCall.push(Number(getStatus().received) || 0)
    const failAfter = state.calls.length === 1 && opts.failAfterBytes ? opts.failAfterBytes : 0
    return {
      ok: true,
      status: from > 0 ? 206 : 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? DEPLOY_ETAG : null) },
      body: body(from, failAfter),
    }
  }
  return state
}
const noTmpLeft = (root) => !existsSync(root) || !readdirSync(root).some((name) => name.startsWith('.tmp-'))
const modelDirOf = (root) => path.join(root, 'kokoro-multi-lang-v1_1')
/** 摆一份"已经装好"的目录（带装机标记），供删除/不可删用例。 */
function makeInstalledFixture(root) {
  const dir = modelDirOf(root)
  mkdirSync(path.join(dir, 'espeak-ng-data'), { recursive: true })
  for (const file of DEPLOY_FILES) if (!file.dir) writeFileSync(path.join(dir, file.name), 'x'.repeat(file.bytes))
  writeFileSync(path.join(dir, '.voice-install.json'), JSON.stringify({
    version: 'kokoro-multi-lang-v1_1', sha256: DEPLOY_SHA, installedAt: '2026-01-01T00:00:00.000Z', bytes: 25,
  }))
  return dir
}
async function waitDeploy(installer, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const st = installer.status()
    if (['downloading', 'verifying', 'extracting'].indexOf(st.phase) < 0) return st
    if (Date.now() - started > timeoutMs) return st
    await sleep(5)
  }
}

// —— A. 正常安装：流式写盘 → 校验 → 解包 → 改名 → 写标记 → 清临时文件 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-a-'))
  const fetchState = makeDeployFetch({ delayMs: 5, status: () => installerA.status() })
  const installerA = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: '', dir: '' }),
  })
  const started = await installerA.start()
  check('deployStart：返回 started + phase=downloading', started.ok === true && started.started === true && started.state.phase === 'downloading', started)
  check('deployStart：进度分母是清单里的归档字节数', started.state.total === DEPLOY_ARCHIVE.length, started.state.total)
  const seen = []
  const poller = setInterval(() => seen.push(installerA.status()), 3)
  const done = await waitDeploy(installerA)
  clearInterval(poller)
  check('下载阶段报 received/percent（走完 0→100，不是一步到位）', seen.some((s) => s.phase === 'downloading' && s.percent > 0 && s.percent < 100), seen.map((s) => s.percent).slice(0, 8))
  check('安装完成：phase=done + installed=true', done.phase === 'done' && done.installed === true, { phase: done.phase, installed: done.installed, error: done.error })
  const marker = JSON.parse(readFileSync(path.join(modelDirOf(root), '.voice-install.json'), 'utf8'))
  check('装机标记写清版本/sha256/时间/占用', marker.version === 'kokoro-multi-lang-v1_1' && marker.sha256 === DEPLOY_SHA
    && /^\d{4}-\d{2}-\d{2}T/.test(marker.installedAt) && marker.bytes > 0, marker)
  check('归档与断点目录用完即删（不留 348MB）', !existsSync(path.join(root, '.partial')))
  check('失败/成功后都不留 .tmp-*（只有正式目录）', noTmpLeft(root) && readdirSync(root).join(',') === 'kokoro-multi-lang-v1_1', readdirSync(root))
  check('重复点下载：识别为已装、不重复下载', (await installerA.start()).reason === 'already-installed' && fetchState.calls.length === 1, fetchState.calls.length)
  rmSync(root, { recursive: true, force: true })
}

// —— B. 断网续传：Range + If-Range，进度不清零 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-b-'))
  const fetchState = makeDeployFetch({ failAfterBytes: 60000, status: () => installerB.status() })
  const installerB = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: '', dir: '' }),
  })
  await installerB.start()
  const done = await waitDeploy(installerB)
  check('断网：自动重试后续传装完（phase=done）', done.phase === 'done' && done.installed === true, { phase: done.phase, error: done.error })
  check('续传：第 2 次请求带 Range: bytes=<已下字节>-', fetchState.calls.length >= 2
    && fetchState.calls[1].range === 'bytes=' + fetchState.calls[1].from + '-' && fetchState.calls[1].from >= 60000, fetchState.calls)
  check('续传：第 2 次请求带 If-Range（文件变了就让服务器回 200 从头来）', fetchState.calls.length >= 2 && fetchState.calls[1].ifRange === DEPLOY_ETAG, fetchState.calls[1])
  check('续传：重试那一刻进度没有清零（还留着已下字节）', fetchState.receivedAtCall.length >= 2 && fetchState.receivedAtCall[1] >= 60000, fetchState.receivedAtCall)
  check('续传：两次请求就装完（第 1 次断网、第 2 次接着下）', fetchState.calls.length === 2, fetchState.calls.length)
  check('续传：最终文件从断点拼回完整（安装成功）', done.installed === true)
  rmSync(root, { recursive: true, force: true })
}

// —— C. 校验失败：中止、说明"上游文件已更新"、清临时目录、不装 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-c-'))
  const fetchState = makeDeployFetch()
  const installerC = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest({ archiveSha256: 'deadbeef'.repeat(8) }), // 篡改清单里的 sha256
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: '', dir: '' }),
  })
  await installerC.start()
  const done = await waitDeploy(installerC)
  check('校验失败：phase=failed + errorKind=checksum', done.phase === 'failed' && done.errorKind === 'checksum', { phase: done.phase, kind: done.errorKind })
  check('校验失败：文案说明"上游文件已更新，请升级插件"', /上游文件已更新/.test(done.error) && /升级插件/.test(done.error), done.error)
  check('校验失败：不重试（只下载 1 次）', fetchState.calls.length === 1, fetchState.calls.length)
  check('校验失败：临时目录与断点数据都清掉', noTmpLeft(root) && !existsSync(path.join(root, '.partial')))
  check('校验失败：没有装出半截模型目录', !existsSync(modelDirOf(root)))
  rmSync(root, { recursive: true, force: true })
}

// —— D. 取消：立刻停、清临时目录、回到未装态 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-d-'))
  const fetchState = makeDeployFetch({ delayMs: 20, chunk: 16000 })
  const installerD = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: '', dir: '' }),
  })
  await installerD.start()
  await sleep(50) // 让它真的下到一半
  const mid = installerD.status()
  const cancelled = await installerD.cancel()
  check('取消：下载中途确实在下载（received>0）', mid.phase === 'downloading' && mid.received > 0, { phase: mid.phase, received: mid.received })
  check('取消：返回 cancelled=true 且回到未装态', cancelled.ok === true && cancelled.cancelled === true && installerD.status().phase === 'idle' && installerD.status().installed === false, cancelled.state)
  check('取消：临时目录与断点数据都清空', noTmpLeft(root) && !existsSync(path.join(root, '.partial')), readdirSync(root))
  check('取消：没有装出模型目录', !existsSync(modelDirOf(root)))
  rmSync(root, { recursive: true, force: true })
}

// —— E. 磁盘不足：直接拒绝，说明还差多少 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-e-'))
  const fetchState = makeDeployFetch()
  const installerE = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 100 * 1024 ** 2, // 只剩 100MB，门槛 1.2GB
    getActive: () => ({ source: '', dir: '' }),
  })
  const refused = await installerE.start()
  check('磁盘不足：直接拒绝（ok=false, errorKind=disk）', refused.ok === false && refused.errorKind === 'disk', refused)
  check('磁盘不足：说明"还差 X MB"', /还差/.test(refused.error) && /MB/.test(refused.error), refused.error)
  check('磁盘不足：一个字节都没下、也没建目录', fetchState.calls.length === 0 && !existsSync(modelDirOf(root)), fetchState.calls.length)
  check('磁盘不足：状态里也带着失败原因（界面刷新后仍能看到）', installerE.status().errorKind === 'disk' && /还差/.test(installerE.status().error), installerE.status().error)
  rmSync(root, { recursive: true, force: true })
}

// —— F. 删除：只删我们装的那一份 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-f-'))
  const dir = makeInstalledFixture(root)
  const installerF = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: makeDeployFetch().fetch,
    extractImpl: deployExtract,
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: 'user', dir }), // 当前用的就是这份
  })
  check('删除：有标记的安装目录可删（deletable=true）', installerF.status().deletable === true, installerF.status())
  const removed = await installerF.remove()
  check('删除：返回 removed=true 且目录消失', removed.ok === true && removed.removed === true && !existsSync(dir), removed)
  check('删除：删完回到未装态（installed=false）', installerF.status().installed === false)
  rmSync(root, { recursive: true, force: true })
}

// —— G. 不可删：当前模型来自仓库 local/models 或自定义目录 ——
{
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-g-'))
  const dir = makeInstalledFixture(root)
  const installerRepo = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: makeDeployFetch().fetch,
    extractImpl: deployExtract,
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: 'repo', dir: 'E:/repo/local/models/kokoro-multi-lang-v1_1' }),
  })
  const blockedRepo = await installerRepo.remove()
  check('来自仓库 local/models：删除被拒（不在可删范围）', blockedRepo.ok === false && blockedRepo.errorKind === 'not-removable' && /不在可删范围/.test(blockedRepo.error), blockedRepo)
  check('来自仓库：目录原样留着（没有误删）', existsSync(dir) && installerRepo.status().installed === true)
  const installerCfg = createModelInstaller({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: makeDeployFetch().fetch,
    extractImpl: deployExtract,
    freeBytes: () => 5 * 1024 ** 3,
    getActive: () => ({ source: 'config', dir: MODEL_FIXTURE }),
  })
  const blockedCfg = await installerCfg.remove()
  check('来自自定义 modelDir：删除被拒并说明来源', blockedCfg.ok === false && /自定义目录/.test(blockedCfg.error) && /不在可删范围/.test(blockedCfg.error), blockedCfg.error)
  rmSync(root, { recursive: true, force: true })
}

// —— H. 走 /voice/api：deployStatus / deployStart / deployRemove 的接线与状态口径 ——
{
  // 本机跑 T23 时可能设了 VOICE_LOCAL_MODEL_DIR（真模型段用），它会盖过用户目录；
  // 这里先摘掉，测完再装回去——否则"当前源=env"会让删除按设计被拒，测不到正常删除。
  const savedEnvModelDir = process.env.VOICE_LOCAL_MODEL_DIR
  delete process.env.VOICE_LOCAL_MODEL_DIR
  const root = mkdtempSync(path.join(tmpdir(), 'voice-deploy-rpc-'))
  const fetchState = makeDeployFetch()
  setInstallerHooksForTest({
    rootDir: () => root,
    manifest: deployManifest(),
    fetchImpl: fetchState.fetch,
    extractImpl: deployExtract,
    retryDelaysMs: [5, 5],
    freeBytes: () => 5 * 1024 ** 3,
  })
  await rpc('setConfig', { patch: { tts: { provider: 'local', local: { modelDir: '' } } } })
  const loadsBefore = engineState.loads
  const ds0 = await rpc('deployStatus')
  check('deployStatus：未装时 phase=idle + installed=false', ds0.ok === true && ds0.phase === 'idle' && ds0.installed === false, ds0)
  check('deployStatus：带清单口径（来源/下载量/解包容积/版本）', ds0.manifest && ds0.manifest.sourceLabel === '测试来源'
    && ds0.manifest.archiveLabel === '195KB' && ds0.manifest.displayVersion === 'v1.1', ds0.manifest)
  check('deployStatus：只查文件，不加载模型（不动引擎）', engineState.loads === loadsBefore, engineState.loads - loadsBefore)
  const dsrStart = await rpc('deployStart')
  check('deployStart：经 /voice/api 开始安装', dsrStart.ok === true && dsrStart.started === true, dsrStart)
  let dsr = await rpc('deployStatus')
  for (let i = 0; i < 400 && ['downloading', 'verifying', 'extracting'].indexOf(dsr.phase) >= 0; i++) {
    await sleep(10)
    dsr = await rpc('deployStatus')
  }
  check('deployStatus：装完 phase=done + installed=true + deletable=true', dsr.phase === 'done' && dsr.installed === true && dsr.deletable === true, { phase: dsr.phase, installed: dsr.installed, deletable: dsr.deletable, error: dsr.error })
  // 界面刷新靠 localStatus：把模型目录指到"刚装好的这份"，运行时应立刻认出它（不用重启 dsh）
  await rpc('setConfig', { patch: { tts: { local: { modelDir: root } } } })
  check('装完 localStatus 立刻报 installed=true（不重启 dsh）', (await rpc('localStatus')).installed === true)
  const blocked = await rpc('deployRemove')
  check('deployRemove：当前模型来自自定义目录 → 拒绝且不删目录', blocked.ok === false && blocked.errorKind === 'not-removable' && existsSync(modelDirOf(root)), blocked)
  await rpc('setConfig', { patch: { tts: { local: { modelDir: '' } } } })
  const removed = await rpc('deployRemove')
  check('deployRemove：我们装的那一份删得掉（目录消失）', removed.ok === true && removed.removed === true && !existsSync(modelDirOf(root)), removed)
  const dsAfter = await rpc('deployStatus')
  check('删除后 deployStatus 回到未装态', dsAfter.installed === false && dsAfter.deletable === false, dsAfter)
  setInstallerHooksForTest(null)
  if (savedEnvModelDir !== undefined) process.env.VOICE_LOCAL_MODEL_DIR = savedEnvModelDir
  rmSync(root, { recursive: true, force: true })
}

// —— I. 提示音素材：/voice/sounds 上传 + 读取 + 启动清扫 + chime 配置默认值 ——
{
  const cfgNow = liveConfig.chime.get()
  check('chime 默认值：总开关关、音量 0.3、三种音各自独立（默认音）',
    cfgNow.enabled === false && cfgNow.volume === 0.3
    && ['work', 'done', 'ask'].every((k) => cfgNow[k].enabled === false && cfgNow[k].source === 'default' && cfgNow[k].file === ''),
    cfgNow)
  check('getConfig 带回 chime（设置页第五层读得到）', !!(await rpc('getConfig')).config.chime && (await rpc('getConfig')).config.chime.volume === 0.3)

  const soundsDir = path.join(home, 'voice', 'sounds')
  const listSounds = () => (existsSync(soundsDir) ? readdirSync(soundsDir) : [])
  const wavBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])
  const mp3Bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(24)])

  const up1 = await soundsRequest('POST', '/voice/sounds?kind=work&name=%E5%B7%A5%E4%BD%9C%E9%9F%B3.wav', wavBytes)
  const up1Body = JSON.parse(up1.text)
  check('上传 wav：200 + ok + 落盘名 <kind>-<uuid>.<ext>',
    up1.code === 200 && up1Body.ok === true && /^work-[0-9a-f-]{36}\.wav$/.test(up1Body.file),
    { code: up1.code, body: up1Body })
  check('上传 wav：扩展名由魔数判定（audio/wav 内容 → .wav）', up1Body.ext === 'wav', up1Body.ext)
  check('上传 wav：文件真的写进了 <DSH_HOME>/voice/sounds', existsSync(path.join(soundsDir, up1Body.file)))
  check('上传 wav：落盘字节与上传一致', readFileSync(path.join(soundsDir, up1Body.file)).equals(wavBytes))

  const dirBefore = listSounds().length
  const up2 = await soundsRequest('POST', '/voice/sounds?kind=done&name=done.mp3', mp3Bytes)
  const up2Body = JSON.parse(up2.text)
  check('上传 mp3（ID3 头）：200 且识别为 mp3', up2.code === 200 && up2Body.ok === true && up2Body.ext === 'mp3', up2Body)

  const bigChunk = Buffer.alloc(1024 * 1024, 0x41)
  const big = Buffer.concat([Buffer.from('RIFF'), bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk, bigChunk])
  const upBig = await soundsRequest('POST', '/voice/sounds?kind=ask&name=big.wav', big)
  check('上传 >10MB：413 拒绝且不落盘', upBig.code === 413 && JSON.parse(upBig.text).ok === false && listSounds().length === dirBefore + 1, { code: upBig.code, n: listSounds().length })

  const upBadMagic = await soundsRequest('POST', '/voice/sounds?kind=ask&name=note.txt', Buffer.from('这根本不是音频'))
  check('魔数不在白名单（纯文本）：415 拒绝', upBadMagic.code === 415 && JSON.parse(upBadMagic.text).ok === false, { code: upBadMagic.code, text: upBadMagic.text })
  check('魔数不对：不落盘', listSounds().length === dirBefore + 1)

  const upDot = await soundsRequest('POST', '/voice/sounds?kind=work&name=..%2F..%2Fevil.wav', wavBytes)
  check('文件名带 ..：400 拒绝', upDot.code === 400, { code: upDot.code, text: upDot.text })
  const upSlash = await soundsRequest('POST', '/voice/sounds?kind=work&name=a%2Fb.wav', wavBytes)
  check('文件名带路径分隔符：400 拒绝', upSlash.code === 400, { code: upSlash.code, text: upSlash.text })
  const upKind = await soundsRequest('POST', '/voice/sounds?kind=evil&name=a.wav', wavBytes)
  check('kind 不在 work|done|ask：400 拒绝', upKind.code === 400, { code: upKind.code, text: upKind.text })
  check('被拒的上传都没有落盘', listSounds().length === dirBefore + 1, listSounds().length)

  const g1 = await soundsRequest('GET', '/voice/sounds/' + up1Body.file)
  check('GET 素材：200 + 正确 Content-Type + 字节一致', g1.code === 200 && g1.mime === 'audio/wav' && Buffer.isBuffer(g1.body) && g1.body.equals(wavBytes), { code: g1.code, mime: g1.mime })
  const g2 = await soundsRequest('GET', '/voice/sounds/' + up1Body.file)
  check('GET 只读不删（第二次仍 200——不能复用"取一次即删"的 /voice/audio）', g2.code === 200 && g2.body.equals(wavBytes), g2.code)
  check('GET mp3 素材：Content-Type = audio/mpeg', (await soundsRequest('GET', '/voice/sounds/' + up2Body.file)).mime === 'audio/mpeg')

  const gTrav = await soundsRequest('GET', '/voice/sounds/%2e%2e%2f%2e%2e%2fpackage.json')
  check('GET 路径穿越（编码后的 ../）：403 拒绝', gTrav.code === 403, { code: gTrav.code, text: gTrav.text })
  const gTrav2 = await soundsRequest('GET', '/voice/sounds/..%5C..%5Cwin.ini')
  check('GET 路径穿越（反斜杠）：403 拒绝', gTrav2.code === 403, { code: gTrav2.code })
  const gMiss = await soundsRequest('GET', '/voice/sounds/' + 'nope-1234.wav')
  check('GET 不存在的素材：404', gMiss.code === 404, gMiss.code)
  const gExt = await soundsRequest('GET', '/voice/sounds/evil.exe')
  check('GET 非白名单扩展名：415', gExt.code === 415, gExt.code)
  const gOrigin = await soundsRequest('POST', '/voice/sounds?kind=work&name=a.wav', wavBytes, { origin: 'https://evil.example.com', host: '127.0.0.1:3080' })
  check('/voice/sounds 同源校验：跨站 POST 403', gOrigin.code === 403, { code: gOrigin.code, text: gOrigin.text })

  // 启动清扫：配置引用的留着；没引用且超过 1 天的删；没引用但还新的留
  await settings.update('voice', { chime: { enabled: true, work: { enabled: true, source: 'custom', file: 'work-keep.wav' } } })
  mkdirSync(soundsDir, { recursive: true })
  const old = (Date.now() - 48 * 60 * 60 * 1000) / 1000
  writeFileSync(path.join(soundsDir, 'work-keep.wav'), wavBytes)
  writeFileSync(path.join(soundsDir, 'old-orphan.wav'), wavBytes)
  writeFileSync(path.join(soundsDir, 'fresh-orphan.wav'), wavBytes)
  utimesSync(path.join(soundsDir, 'work-keep.wav'), old, old)
  utimesSync(path.join(soundsDir, 'old-orphan.wav'), old, old)
  // 再 apply 一次 = 模拟一次 Host 启动（用独立的 webServer 替身，不污染已有路由表）
  const restartCtx = Object.assign({}, ctx, { webServer: { register: () => {} } })
  apply(restartCtx, liveConfig)
  check('启动清扫：未被引用且超过 1 天的素材删掉', !existsSync(path.join(soundsDir, 'old-orphan.wav')))
  check('启动清扫：配置引用着的旧文件留着', existsSync(path.join(soundsDir, 'work-keep.wav')))
  check('启动清扫：未被引用但还没满 1 天的留着（防删刚上传未保存的）', existsSync(path.join(soundsDir, 'fresh-orphan.wav')))
  check('启动清扫：上传过的素材仍在（都还新）', listSounds().length >= 3, listSounds())

  await settings.update('voice', { chime: { enabled: false, volume: 0.3, work: { enabled: false, source: 'default', file: '' } } })
  check('chime 配置可经 settings.update 写回（设置页保存路径）', liveConfig.chime.get().work.enabled === false && liveConfig.chime.get().enabled === false)
}

// —— 提示音的全局 running 账本（跨工作区补齐，客户端轮询 chimeStatus） ——
fire({ type: 'turn/start', data: { turn: 90 } })
{
  const a = await rpc('chimeStatus', {})
  check('chimeStatus：turn/start 后账本记下会话', a.ok === true && a.count === 1 && Array.isArray(a.running) && a.running.includes('s1'), a)
  fire({ type: 'turn/end', data: { turn: 90, reason: { kind: 'completed' } } })
  const b = await rpc('chimeStatus', {})
  check('chimeStatus：turn/end 后账本归零并给出结束时间', b.ok === true && b.count === 0 && b.lastEndedAt > 0, b)
}

// 恢复 browser（测试以免费引擎收尾，保持无副作用）
await rpc('setConfig', { patch: { autoSpeak: false, tts: { provider: 'browser' } } })

// ---------- 收尾 ----------
// 善后三件事：恢复真 fetch（否则这个进程里再联网会打到假货）、删临时目录、交成绩单。
globalThis.fetch = realFetch
rmSync(home, { recursive: true, force: true })
console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed')
console.log('(B 类"外部事实快照"断言若失败：先跑 node scripts/tts-probe.mjs 拿新证据，再三处同步更新，见文件头第 5 条)')
process.exit(failed ? 1 : 0) // 退出码：0=全过，1=有失败（脚本工具靠它判断成败）
