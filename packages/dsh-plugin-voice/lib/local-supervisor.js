//#region dsh-plugin-voice — 本地 TTS 服务托管（探测 / 拉起 / 回收）
/**
 * 本地 TTS 服务的生命周期托管（docs/pipeline.md §4.3、docs/local-tts.md、
 * docs/local-tts-cosyvoice.md）。支持两个本地引擎：
 *   engine='local'            → Kokoro-82M（英文）：scripts/local-tts-server.py，venv，端口 8880
 *   engine='local-cosyvoice'  → Fun-CosyVoice3-0.5B（中文）：scripts/local-tts-server-cosyvoice.py，
 *                               venv-cosyvoice，端口 8882，加载慢（2GB+ 权重）→ 就绪时限更长
 *
 * 职责：播报前确保本地服务在跑——已在跑则复用（不重复拉起），未跑则由 dsh 经
 * `ctx.subprocess` 拉起，并作为受管子进程存活：插件卸载或 dsh 退出时被回收，
 * 不残留孤儿进程（dsh-subprocess-local 在正常卸载与宿主退出两个阶段都会终止自己托管的进程范围）。
 *
 * 设计要点：
 *  - 软依赖：`ctx.get('subprocess')` 缺失时不抛错，只报"子进程服务不可用"，手动启动仍是兜底路径；
 *  - 并发去重：同时多次播报只拉起一次（共享同一个 in-flight promise）；
 *  - 健康端点：`<baseUrl 的 origin>/health`（服务脚本固定提供；baseUrl 只声明合成端点路径）；
 *  - 解释器/脚本路径按插件真实位置推导（profile 里是 junction/symlink，故用 realpathSync），
 *    可用 voice.tts.<block>.pythonPath 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 引擎规格表：脚本 / venv 目录 / 默认合成端点 / 就绪等待时限（CosyVoice 首次加载 2GB+ 权重）。 */
const ENGINE_SPECS = {
  'local': {
    blockKey: 'local',
    script: 'local-tts-server.py',
    venvDir: 'venv',
    defaultBaseUrl: 'http://127.0.0.1:8880/v1/audio/speech',
    defaultPort: 8880,
    readyTimeoutMs: 30000,
    setupHint: 'pwsh scripts/setup-local-tts.ps1（部署见 docs/local-tts.md）',
  },
  'local-cosyvoice': {
    blockKey: 'localCosyvoice',
    script: 'local-tts-server-cosyvoice.py',
    venvDir: 'venv-cosyvoice',
    defaultBaseUrl: 'http://127.0.0.1:8882/v1/audio/speech',
    defaultPort: 8882,
    readyTimeoutMs: 180000, // 模型加载约 10-60s（CPU 冷启动更久），远超 Kokoro
    setupHint: 'pwsh scripts/setup-local-tts-cosyvoice.ps1（部署见 docs/local-tts-cosyvoice.md）',
  },
}

/** 快速探测（服务已在跑时用）与就绪等待（刚拉起时用）的超时。 */
const PROBE_TIMEOUT_MS = 1200
const READY_INTERVAL_MS = 250
/** 子进程输出保留上限（只用于失败诊断，不消费为数据）。 */
const OUTPUT_CAP_BYTES = 4096

function specOf(engine) {
  return ENGINE_SPECS[engine] || ENGINE_SPECS['local']
}

/** 从合成端点推导服务 origin；不可解析时回落到引擎默认端口。 */
export function originOf(baseUrl, engine = 'local') {
  const defaultPort = specOf(engine).defaultPort
  try {
    const u = new URL(baseUrl)
    return u.port ? u.origin : u.protocol + '//' + u.hostname + ':' + defaultPort
  } catch {
    return 'http://127.0.0.1:' + defaultPort
  }
}

/** 由合成端点推导健康检查地址（端口未显式给出时按引擎默认端口）。 */
export function healthUrlOf(baseUrl, engine = 'local') {
  return originOf(baseUrl, engine) + '/health'
}

/** 由合成端点推导监听端口（默认按引擎默认端口）。 */
export function portOf(baseUrl, engine = 'local') {
  const defaultPort = specOf(engine).defaultPort
  try {
    const u = new URL(baseUrl)
    return u.port ? Number(u.port) : defaultPort
  } catch {
    return defaultPort
  }
}

/**
 * 插件模块真实路径 → 仓库根。
 * 判据两级：优先"含 local/ 且含 scripts/local-tts-server.py"（完整部署），
 * 否则退回第一个"含 local/"的祖先目录（用于生成更贴切的错误提示）。
 * 只认 local/ 会让上层的同名目录（如 AppData\Local 之外的 local）造成误判。
 */
function repoRootOf(pluginUrl) {
  let dir = ''
  try {
    dir = path.dirname(fs.realpathSync(fileURLToPath(pluginUrl)))
  } catch {
    dir = path.dirname(fileURLToPath(pluginUrl))
  }
  let fallback = ''
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'local'))) {
      if (fs.existsSync(path.join(dir, 'scripts', 'local-tts-server.py'))) return dir
      if (!fallback) fallback = dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return fallback
}

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 定位本地 TTS 部署：仓库根（含 local/）→ 解释器 → 服务脚本。
 * @param pluginUrl - 插件模块的 import.meta.url（据此解析真实路径，穿透 junction）
 * @param pythonPathOverride - voice.tts.<block>.pythonPath（空=自动推导）
 * @param engine - 'local'（Kokoro）| 'local-cosyvoice'（Fun-CosyVoice3）
 * @returns {{ root: string, python: string, script: string, venvDir: string, error: string }}
 */
export function resolveLaunch(pluginUrl, pythonPathOverride, engine = 'local') {
  const spec = specOf(engine)
  const root = repoRootOf(pluginUrl)
  const venvDir = root ? path.join(root, 'local', spec.venvDir) : ''
  const candidates = []
  if (pythonPathOverride) candidates.push(pythonPathOverride)
  if (venvDir) {
    candidates.push(path.join(venvDir, 'Scripts', 'python.exe')) // Windows
    candidates.push(path.join(venvDir, 'bin', 'python'))         // POSIX
  }
  const python = candidates.find((p) => isFile(p)) || ''
  const script = root ? path.join(root, 'scripts', spec.script) : ''
  let error = ''
  if (!python) {
    error = '未找到本地 TTS 运行环境（' + (venvDir || 'local/' + spec.venvDir)
      + '）；请先运行 ' + spec.setupHint
  } else if (!isFile(script)) {
    error = '未找到本地 TTS 服务脚本：' + script
  }
  return { root, python, script, venvDir, error }
}

/** 带 kind 的错误：kind ∈ unavailable | timeout | http（客户端按此选 toast 文案）。 */
export function speakError(kind, message) {
  const error = new Error(message)
  error.kind = kind
  return error
}

/**
 * 建立本地 TTS 服务托管器。
 * @param options.ctx - 插件 Context（用 ctx.get('subprocess') 取子进程服务）
 * @param options.getConfig - 返回当前 voice 配置（每次重新读，配置热改即时生效）
 * @param options.pluginUrl - 本模块的 import.meta.url
 * @param options.engine - 'local'（Kokoro）| 'local-cosyvoice'（Fun-CosyVoice3）
 */
export function createLocalSupervisor({ ctx, getConfig, pluginUrl, engine = 'local' }) {
  const spec = specOf(engine)
  let handle = null   // 当前受管子进程句柄
  let starting = null // in-flight：并发调用共享，保证只拉起一次

  function localCfg() {
    const cfg = getConfig() || {}
    const v = (cfg.tts && cfg.tts[spec.blockKey]) || {}
    return {
      baseUrl: v.baseUrl || spec.defaultBaseUrl,
      autoStart: v.autoStart !== false,
      pythonPath: v.pythonPath || '',
    }
  }

  /** 单次健康探测：通=true。任何失败（连接被拒/超时/非 2xx）都算不通。 */
  async function probe(baseUrl, timeoutMs = PROBE_TIMEOUT_MS) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(healthUrlOf(baseUrl, engine), { method: 'GET', signal: ac.signal })
      return !!res && res.ok === true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** 子进程 stderr 尾部（失败诊断用；无则空串）。 */
  function stderrTail() {
    if (!handle || !handle.collected || !handle.collected.stderr) return ''
    try {
      const read = handle.collected.stderr.readFrom(0)
      return String(read && read.text || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)
    } catch {
      return ''
    }
  }

  /**
   * 确保本地服务可用：复用已在跑的服务；否则拉起并等待就绪。
   * @returns {Promise<{running:boolean, started:boolean, url:string, error:string, detail:string, kind:string}>}
   */
  async function ensure() {
    const v = localCfg()
    const url = healthUrlOf(v.baseUrl, engine)
    if (await probe(v.baseUrl)) return { running: true, started: false, url, error: '', detail: '', kind: '' }
    if (!v.autoStart) {
      const bat = engine === 'local-cosyvoice' ? 'scripts/start-local-tts-cosyvoice.bat' : 'scripts/start-local-tts.bat'
      return {
        running: false, started: false, url, kind: 'unavailable', detail: '',
        error: '本地 TTS 服务未运行，且「自动启动本地服务」已关闭；请启动服务（' + bat + '）或打开该开关（' + spec.setupHint + '）',
      }
    }
    if (starting) return starting
    starting = (async () => {
      try {
        return await start(v, url)
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /** 拉起服务并轮询等待就绪。 */
  async function start(v, url) {
    const subprocess = ctx.get('subprocess')
    if (!subprocess) {
      const bat = engine === 'local-cosyvoice' ? 'scripts/start-local-tts-cosyvoice.bat' : 'scripts/start-local-tts.bat'
      return {
        running: false, started: false, url, kind: 'unavailable', detail: '',
        error: 'dsh 子进程服务不可用（ctx.subprocess），无法自动启动本地 TTS；请手动运行 ' + bat + '（' + spec.setupHint + '）',
      }
    }
    const launch = resolveLaunch(pluginUrl, v.pythonPath, engine)
    if (launch.error) {
      return { running: false, started: false, url, kind: 'unavailable', detail: launch.venvDir, error: launch.error }
    }
    try {
      handle = subprocess.spawn({
        argv: [launch.python, launch.script, '--port', String(portOf(v.baseUrl, engine))],
        cwd: launch.root,
        // stdio 必须逐项显式（该接口无默认）：stdin 不用；stdout/stderr 有界保留，仅用于失败诊断
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: 5000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })
    } catch (error) {
      handle = null
      return { running: false, started: false, url, kind: 'unavailable', detail: '', error: '启动本地 TTS 失败：' + String(error && error.message || error) }
    }
    // 子进程提前退出：捕获退出事实，用于把 stderr 尾部带进错误文案（spawn 失败不应变成未处理拒绝）
    let outcome = null
    handle.done.then(
      (o) => { outcome = { code: o && o.exitCode, signal: o && o.signal } },
      (e) => { outcome = { error: String(e && e.message || e) } },
    )
    const readyTimeout = spec.readyTimeoutMs
    const deadline = Date.now() + readyTimeout
    for (;;) {
      if (await probe(v.baseUrl)) return { running: true, started: true, url, error: '', detail: '', kind: '' }
      if (outcome) {
        const tail = stderrTail()
        terminate()
        const why = outcome.error ? outcome.error : ('退出码 ' + outcome.code + (outcome.signal ? ' / 信号 ' + outcome.signal : ''))
        return {
          running: false, started: false, url, kind: 'unavailable', detail: tail,
          error: '本地 TTS 服务启动后立即退出（' + why + '）' + (tail ? '：' + tail : ''),
        }
      }
      if (Date.now() >= deadline) {
        const tail = stderrTail()
        terminate()
        return {
          running: false, started: false, url, kind: 'unavailable', detail: tail,
          error: '本地 TTS 服务启动超时（' + Math.round(readyTimeout / 1000) + 's）' + (tail ? '：' + tail : ''),
        }
      }
      await new Promise((r) => setTimeout(r, READY_INTERVAL_MS))
    }
  }

  /** 只读状态：不拉起、不产生副作用（设置页自检 / UI 提示用）。 */
  async function status() {
    const v = localCfg()
    const launch = resolveLaunch(pluginUrl, v.pythonPath, engine)
    const running = await probe(v.baseUrl)
    return {
      running,
      url: healthUrlOf(v.baseUrl, engine),
      autoStart: v.autoStart,
      subprocessAvailable: !!ctx.get('subprocess'),
      pythonPath: launch.python,
      venvFound: !launch.error && !!launch.python,
      detail: launch.error || '',
    }
  }

  /** 终止并释放托管的子进程（幂等；插件卸载与 dsh 退出时被调用）。 */
  function terminate() {
    const h = handle
    handle = null
    if (!h) return
    try {
      h.terminate()
    } catch { /* 已退出/已回收：忽略 */ }
  }

  return { probe, ensure, status, terminate }
}
//#endregion
