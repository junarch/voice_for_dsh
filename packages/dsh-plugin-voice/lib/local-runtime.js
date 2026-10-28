//#region dsh-plugin-voice — 本地 TTS 运行时（进程内 sherpa-onnx + Kokoro v1.1）
/**
 * 本地合成的运行时层：模型在哪、加载、合成、出错怎么分类。
 * 上层（lib/index.js）只管"读配置 / 切段 / 入队"，不碰原生库细节。
 *
 * 运行方式：`sherpa-onnx-node`（N-API 原生模块）在 Host 进程内直接合成，
 * 不起子进程、不装 Python、不监听端口，dsh 退出即随进程释放。
 *
 * 锁 1.13.8：2.x 起不再用 espeak 回退，英文词典外的词与数字会被静默跳过；
 * 1.x 带 espeak，数字（number-zh.fst 等规则）与词典外词都能读。
 *
 * 模型：`kokoro-multi-lang-v1_1`（fp32，压缩包 348MB、解包后 407MB，中英混读，103 个数字音色）。
 * int8 包也能跑（只是本机实测慢约 4 倍），文件名不同，两者都认。
 *
 * 模型目录解析顺序（先命中先用）：
 *   1. voice.tts.local.modelDir（配置覆盖；测试与高级用户用）
 *   2. $VOICE_LOCAL_MODEL_DIR（环境变量，同上）
 *   3. <DSH_HOME>/voice/models/kokoro-multi-lang-v1_1（用户目录，正式安装位置）
 *   4. <仓库>/local/models/kokoro-multi-lang-v1_1（开发机残留的老部署）
 */
import { statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 正式模型目录名（用户目录与仓库 local/models 下都用它）。 */
export const MODEL_DIR_NAME = 'kokoro-multi-lang-v1_1'
/** Kokoro 输出固定 24kHz 单声道 Float32（客户端只认 16bit 小端裸 PCM，由本层转）。 */
export const LOCAL_SAMPLE_RATE = 24000
/** 可选的模型文件名（fp32 优先；int8 兼容老包）。 */
const MODEL_FILE_NAMES = ['model.onnx', 'model.int8.onnx']
/** 规则文件（中文日期/数字/电话号码的正则化；缺失不致命，只是数字读法退化为逐字）。 */
const RULE_FILES = ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst']
/** 词典（中英；Kokoro 靠它们把词转音素）。 */
const LEXICON_FILES = ['lexicon-us-en.txt', 'lexicon-zh.txt']
/** 模型加载上限：SSD 上 fp32 约 2–4s，慢盘留足余量。 */
const LOAD_TIMEOUT_MS = 60000
/** 找不到模型时给用户看的动作指引（下载归第二块，这里只说去哪儿看）。 */
const MODEL_MISSING_HINT = '本地模型未安装：请把 kokoro-multi-lang-v1_1 解包到模型目录（见 docs/local-tts.md）'

/** 带分类的错误：kind ∈ model-missing | load-failed | synth-failed | timeout。
 *  客户端按 kind 选 toast 文案；上层据此区分"没装模型"与"合成失败"。 */
export function speakError(kind, message) {
  const error = new Error(message)
  error.kind = kind
  return error
}

function isDir(p) {
  try {
    return !!p && statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return !!p && statSync(p).isFile()
  } catch {
    return false
  }
}

/** 仓库根：从插件真实路径上溯，找同时含 packages/ 与 package.json 的目录。
 *  走 realpathSync 是为了穿透 profile 里的 junction/symlink（link: 安装的常见形态）。 */
export function repoRootOf(pluginUrl) {
  let dir = ''
  try {
    dir = path.dirname(realpathSync(fileURLToPath(pluginUrl)))
  } catch {
    try { dir = path.dirname(fileURLToPath(pluginUrl)) } catch { return '' }
  }
  for (let i = 0; i < 6; i++) {
    if (isDir(path.join(dir, 'packages')) && isFile(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** 用户模型根：<DSH_HOME>/voice/models（第二块的下载器装到同一处）。 */
export function userModelRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'voice', 'models')
}

/** 若给的是模型目录本体（直接含模型文件）就用它，否则当作父目录拼上规范目录名。 */
function normalizeModelDir(candidate) {
  if (!candidate || !isDir(candidate)) return ''
  if (MODEL_FILE_NAMES.some((n) => isFile(path.join(candidate, n)))) return candidate
  const nested = path.join(candidate, MODEL_DIR_NAME)
  if (isDir(nested)) return nested
  return candidate // 空的/半截目录：原样返回，交给 missing 列表说清楚缺什么
}

/**
 * 解析模型目录。
 * @param options.override - voice.tts.local.modelDir（配置覆盖）
 * @param options.pluginUrl - 插件模块地址（据此找仓库根的开发模型）
 * @param options.envDir - 环境变量覆盖（默认读 VOICE_LOCAL_MODEL_DIR；测试可传空串模拟干净机器）
 * @returns {{ dir: string, source: string, exists: boolean }}
 *   source ∈ config | env | user | repo | ''（都没有 → dir 指向用户目录预期位置）
 *   显式指定（配置 > env）时以它为准：不静默回落到别的目录（否则用户设了目录却听到另一个模型）。
 */
export function resolveModelDir(options = {}) {
  const { override = '', pluginUrl = '', envDir = process.env.VOICE_LOCAL_MODEL_DIR || '' } = options
  const explicit = override || envDir
  if (explicit) {
    const dir = normalizeModelDir(explicit) || explicit
    return { dir, source: override ? 'config' : 'env', exists: MODEL_FILE_NAMES.some((n) => isFile(path.join(dir, n))) }
  }
  const userDir = path.join(userModelRoot(), MODEL_DIR_NAME)
  if (MODEL_FILE_NAMES.some((n) => isFile(path.join(userDir, n)))) return { dir: userDir, source: 'user', exists: true }
  const repoRoot = repoRootOf(pluginUrl)
  if (repoRoot) {
    const repoDir = normalizeModelDir(path.join(repoRoot, 'local', 'models', MODEL_DIR_NAME))
    if (MODEL_FILE_NAMES.some((n) => isFile(path.join(repoDir, n)))) return { dir: repoDir, source: 'repo', exists: true }
  }
  return { dir: userDir, source: '', exists: false }
}

/** 检查一个模型目录是否具备加载所需的文件；返回缺失清单与找到的关键路径。 */
export function inspectModelDir(dir) {
  const missing = []
  if (!isDir(dir)) return { ok: false, dir, model: '', missing: [MODEL_DIR_NAME + '/'] }
  const model = MODEL_FILE_NAMES.map((n) => path.join(dir, n)).find((p) => isFile(p)) || ''
  if (!model) missing.push(MODEL_FILE_NAMES.join(' 或 '))
  for (const name of ['tokens.txt', 'voices.bin']) if (!isFile(path.join(dir, name))) missing.push(name)
  if (!isDir(path.join(dir, 'espeak-ng-data'))) missing.push('espeak-ng-data/')
  for (const name of LEXICON_FILES) if (!isFile(path.join(dir, name))) missing.push(name)
  return { ok: missing.length === 0, dir, model, missing }
}

/** Float32 [-1,1] → 16bit 小端 PCM（客户端 buildAudioBufferFromPcm 只认这个格式）。 */
export function float32ToInt16Pcm(samples) {
  const out = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v
    out.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }
  return out
}

/** 16bit 小端 PCM → 44 字节头的 WAV（整段路径用：客户端音频元素直接能吃）。 */
export function pcmToWav(pcm, sampleRate = LOCAL_SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)          // fmt 块长度
  header.writeUInt16LE(1, 20)           // PCM
  header.writeUInt16LE(1, 22)           // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // 字节率 = 采样率 × 块对齐
  header.writeUInt16LE(2, 32)           // 块对齐（16bit 单声道）
  header.writeUInt16LE(16, 34)          // 位深
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 测试注入点：替换"怎么拿到 OfflineTts 实例"这一步。
 * 只有 scripts/test-host.mjs 用（它跑在无模型的机器上，不需要那 407MB 模型也能验证
 * 切段/PCM 转换/超时/错误分类）；生产路径永远走 sherpa-onnx-node。
 */
let engineLoaderForTest = null
export function setEngineLoaderForTest(fn) {
  engineLoaderForTest = fn
}

/**
 * 本地 TTS 运行时（懒加载单例语义：一个插件实例一个引擎）。
 * @param options.pluginUrl - 插件模块的 import.meta.url（用于定位仓库根的开发模型）
 * @param options.getConfig - 返回当前 voice 配置快照（每次现取，设置改了即时生效）
 * @param options.loadEngine - 仅供测试注入：async (config) => tts 实例
 */
export function createLocalRuntime(options = {}) {
  const { pluginUrl = '', getConfig = () => ({}), loadEngine = null } = options
  let instance = null      // 已加载的 OfflineTts
  let loading = null       // in-flight 加载（并发去重）
  let loadError = null     // 最近一次加载失败
  let loadErrorLogged = false // 失败只报一次（避免每次朗读都刷屏）
  let loadMs = 0
  let loadedDir = ''

  function localCfg() {
    const cfg = getConfig() || {}
    const v = (cfg.tts && cfg.tts.local) || {}
    return {
      sid: Number.isInteger(v.sid) ? v.sid : 48,
      speed: typeof v.speed === 'number' ? v.speed : 1,
      numThreads: Number.isInteger(v.numThreads) && v.numThreads > 0 ? v.numThreads : 4,
      modelDir: typeof v.modelDir === 'string' ? v.modelDir : '',
    }
  }

  /** 模型现状（只查文件，不加载）。 */
  function inspect() {
    const { dir, source } = resolveModelDir({ override: localCfg().modelDir, pluginUrl })
    const info = inspectModelDir(dir)
    return Object.assign({ source }, info)
  }

  /** 组装 sherpa 的 OfflineTts 配置（Kokoro 多语言包）。 */
  function engineConfig(info, v) {
    const lexicon = LEXICON_FILES.map((n) => path.join(info.dir, n)).filter((p) => isFile(p))
    const rules = RULE_FILES.map((n) => path.join(info.dir, n)).filter((p) => isFile(p))
    const config = {
      model: {
        kokoro: {
          model: info.model,
          voices: path.join(info.dir, 'voices.bin'),
          tokens: path.join(info.dir, 'tokens.txt'),
          dataDir: path.join(info.dir, 'espeak-ng-data'),
        },
        numThreads: v.numThreads,
        provider: 'cpu',
      },
      maxNumSentences: 1,
      numThreads: v.numThreads,
    }
    if (lexicon.length) config.model.kokoro.lexicon = lexicon.join(',')
    if (rules.length) config.ruleFsts = rules.join(',')
    return config
  }

  /**
   * 确保引擎已加载（懒加载，并发只加载一次）。
   * 失败分类：model-missing（没装）/ load-failed（原生模块或模型加载失败）。
   */
  async function ensureLoaded() {
    if (instance) {
      // 模型目录被改/被删：已加载的实例作废，按当前目录重新解析（否则设置页改了目录也不生效）
      const cur = inspect()
      if (cur.ok && cur.dir === loadedDir) return instance
      instance = null
      loadedDir = ''
    }
    const info = inspect()
    if (!info.ok) {
      throw speakError('model-missing', MODEL_MISSING_HINT + '；模型目录：' + info.dir
        + (info.missing && info.missing.length ? '（缺少 ' + info.missing.join('、') + '）' : ''))
    }
    const v = localCfg()
    const started = Date.now()
    if (!loading) {
      // 并发去重：同一时刻只有一个加载在飞（restart 后重新可试）
      const p = (async () => {
        try {
          let tts
          // 注入点按"加载那一刻"解析（测试可能在运行时创建之后才装替身）
          const loader = loadEngine || engineLoaderForTest
          if (loader) {
            tts = await loader(engineConfig(info, v))
          } else {
            let sherpa
            try {
              // sherpa-onnx-node 是 CJS：ESM 侧不一定能静态识别出命名导出，
              // 所以优先取 default（实测 Node 22 下 mod.OfflineTts 为 undefined）。
              const mod = await import('sherpa-onnx-node')
              sherpa = mod && mod.OfflineTts ? mod : (mod && mod.default) || {}
            } catch (error) {
              throw speakError('load-failed', '本地 TTS 运行时加载失败（sherpa-onnx-node 不可用）：'
                + String(error && error.message || error))
            }
            if (!sherpa.OfflineTts) {
              throw speakError('load-failed', '本地 TTS 运行时加载失败（sherpa-onnx-node 未导出 OfflineTts）')
            }
            tts = await sherpa.OfflineTts.createAsync(engineConfig(info, v))
          }
          instance = tts
          loadedDir = info.dir
          loadMs = Date.now() - started
          loadError = null
          loadErrorLogged = false
          console.log('[voice] local tts ready: ' + info.dir + '（' + loadMs + 'ms，' + (instance.numSpeakers || 0) + ' 音色）')
          return instance
        } catch (error) {
          loadError = error && error.kind ? error : speakError('load-failed', '本地 TTS 加载失败：' + String(error && error.message || error))
          if (!loadErrorLogged) { // 同一个加载失败只报一次，避免每次朗读都刷屏
            loadErrorLogged = true
            console.error('[voice] local tts load failed:', loadError.message)
          }
          throw loadError
        }
      })()
      loading = p
      p.then(() => { if (loading === p) loading = null }, () => { if (loading === p) loading = null })
    }
    const current = loading
    // 加载超时：createAsync 不能取消，超时后仍让它跑完（下次调用直接复用结果），本次先报错
    let timer = null
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), LOAD_TIMEOUT_MS) })
    try {
      const raced = await Promise.race([current.then(() => 'done', () => 'error'), timeout])
      if (raced === 'timeout') throw speakError('load-failed', '本地 TTS 模型加载超时（' + Math.round(LOAD_TIMEOUT_MS / 1000) + 's）：' + info.dir)
    } finally {
      clearTimeout(timer)
    }
    return current
  }

  /** 校验 sid 是否在本模型的音色范围内（超范围明确报错，不静默改音色）。 */
  function assertSid(sid, tts) {
    const max = (tts.numSpeakers || 1) - 1
    if (!Number.isInteger(sid) || sid < 0 || sid > max) {
      throw speakError('synth-failed', '音色 sid 超出范围（0–' + max + '）：' + JSON.stringify(sid))
    }
  }

  /**
   * 分块合成：yield 16bit 小端 PCM（每块是一段连续音频）。
   * 超时/停止都靠 onProgress 返回 0 让 sherpa 自己停下（它不接外部 AbortSignal）。
   * @param options.text - 要合成的一段文本
   * @param options.signal - 外部中止信号（停止播报）
   * @param options.timeoutMs - 单次合成超时
   */
  async function* streamPcm({ text, signal, timeoutMs = 30000 } = {}) {
    const tts = await ensureLoaded()
    const v = localCfg()
    assertSid(v.sid, tts)
    const input = String(text || '').trim()
    if (!input) return
    if (signal && signal.aborted) throw speakError('timeout', '本地播报已中止')

    let timedOut = false
    let aborted = false
    const pending = []
    let resolvePending = null
    const wake = () => { if (resolvePending) { const r = resolvePending; resolvePending = null; r() } }
    const timer = setTimeout(() => { timedOut = true; wake() }, timeoutMs)
    const onAbort = () => { aborted = true; wake() }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    // onProgress 是 sherpa 的唯一中断点：返回 0 = 停止生成（已生成的部分照常回调）
    const push = (info) => {
      if (timedOut || aborted) return 0
      pending.push(info.samples)
      wake()
      return 1
    }
    const run = tts.generateAsync({
      text: input,
      generationConfig: { sid: v.sid, speed: v.speed },
      onProgress: push,
    })
    let finished = false
    let failure = null
    let finalAudio = null
    let yielded = 0
    run.then((audio) => {
      finalAudio = audio
      finished = true
      if (resolvePending) resolvePending()
    }, (error) => {
      failure = error
      finished = true
      if (resolvePending) resolvePending()
    })
    try {
      for (;;) {
        while (!pending.length && !finished && !timedOut && !aborted) {
          await new Promise((resolve) => { resolvePending = resolve })
        }
        if (pending.length) {
          const samples = pending.shift()
          if (samples && samples.length) { yielded++; yield float32ToInt16Pcm(samples) }
          continue
        }
        break
      }
      // 极短文本可能一次回调都没有：退回用整体结果（保证"有声音"而不是静默空段）
      if (!yielded && !failure && finalAudio && finalAudio.samples && finalAudio.samples.length) {
        yield float32ToInt16Pcm(finalAudio.samples)
      }
      if (failure) throw failure
      if (timedOut) throw speakError('timeout', '本地合成超时（' + timeoutMs + 'ms）')
      if (aborted) throw speakError('timeout', '本地播报已中止')
    } catch (error) {
      if (error && error.kind) throw error
      if (timedOut) throw speakError('timeout', '本地合成超时（' + timeoutMs + 'ms）')
      if (aborted || (signal && signal.aborted)) throw speakError('timeout', '本地播报已中止')
      throw speakError('synth-failed', '本地合成失败：' + String(error && error.message || error))
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  /** 整段合成：返回完整 WAV Buffer（非流式路径）。 */
  async function synthesizeWav({ text, signal, timeoutMs = 30000 } = {}) {
    const parts = []
    for await (const pcm of streamPcm({ text, signal, timeoutMs })) parts.push(pcm)
    const pcm = Buffer.concat(parts)
    if (!pcm.length) throw speakError('synth-failed', '本地合成没有产出音频')
    return pcmToWav(pcm, LOCAL_SAMPLE_RATE)
  }

  /** 只读状态：设置页「运行时自检」与排障用；模型已装则顺手加载一次，把真实读数带回去。 */
  async function status() {
    const info = inspect()
    const v = localCfg()
    const base = {
      installed: info.ok,
      modelDir: info.dir,
      modelSource: info.source,
      modelFile: info.model ? path.basename(info.model) : '',
      missing: info.missing || [],
      configuredSid: v.sid,
      numThreads: v.numThreads,
      speed: v.speed,
      sampleRate: LOCAL_SAMPLE_RATE,
      loaded: !!instance,
      loading: !!loading,
      numSpeakers: instance ? instance.numSpeakers : null,
      loadMs: instance ? loadMs : null,
      error: info.ok ? '' : MODEL_MISSING_HINT,
    }
    if (!info.ok) return base
    try {
      const tts = await ensureLoaded()
      return Object.assign(base, {
        loaded: true, loading: false,
        numSpeakers: tts.numSpeakers,
        sampleRate: tts.sampleRate || LOCAL_SAMPLE_RATE,
        loadMs,
        error: '',
      })
    } catch (error) {
      return Object.assign(base, {
        loaded: false,
        error: String(error && error.message || error),
        errorKind: (error && error.kind) || 'load-failed',
      })
    }
  }

  /** 已加载时的模型目录（诊断用；未加载返回空串）。 */
  function loadedModelDir() {
    return instance ? loadedDir : ''
  }

  return { ensureLoaded, streamPcm, synthesizeWav, status, inspect, loadedModelDir }
}
//#endregion
