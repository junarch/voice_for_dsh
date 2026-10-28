//#region dsh-plugin-voice — 本地模型安装器（下载 / 校验 / 解包 / 删除）
/**
 * 把 Kokoro 模型装到 `<DSH_HOME>/voice/models/kokoro-multi-lang-v1_1`：
 * 下载 → 校验归档 sha256 → 系统 tar 解包到临时目录 → 复核关键文件 → 同盘改名 → 写装机标记。
 *
 * 几条硬规矩（都是踩过的坑）：
 *  - 流式写盘：348MB 不能先读进内存（Electron 主进程会卡住甚至 OOM）；
 *  - 断点续传：`Range: bytes=<n>-` + `If-Range: <ETag>`，服务器回 200 说明文件变了就从头来；
 *  - 解包交给系统 tar（Windows 10+ 自带 bsdtar，实测支持 bz2，20–25s）；
 *    纯 JS 解 bz2 会把 Host 主线程占住几十秒到几分钟，没有兜底实现，找不到 tar 就明确报错；
 *  - 先写 `.tmp-<rand>`，全部校验通过才同盘 rename，失败/取消都不留 `.tmp-*`；
 *  - 单任务：同一时刻只允许一个安装；取消要能立刻停（fetch abort + kill tar）。
 *
 * 可注入（测试用）：fetch、解包、磁盘剩余空间、清单、重试间隔——都从 options 进。
 * 默认值的取用放在每次调用时（不缓存），所以 scripts/test-host.mjs 可以在 apply 之后
 * 用 setInstallerHooksForTest() 换掉这几个外部依赖。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync, statfsSync,
} from 'node:fs'
import path from 'node:path'
import { MODEL_MANIFEST, formatBytes } from './model-manifest.js'
import { MODEL_DIR_NAME, inspectModelDir, userModelRoot } from './local-runtime.js'

/** 装机标记（有它才认为"这份是我们装的"，删除只删这一份）。 */
const MARKER_NAME = '.voice-install.json'
/** 下载中的归档放这里（不叫 `.tmp-*`：它是可续传的数据，失败时按错误类型决定去留）。 */
const PARTIAL_DIR = '.partial'
/** 解包临时目录前缀；启动与每次安装都会清扫残留。 */
const TMP_PREFIX = '.tmp-'
/** 预检门槛：归档 348MB + 解包 407MB 会同时存在，1.2GB 留出余量。 */
const MIN_FREE_BYTES = Math.round(1.2 * 1024 ** 3)
/** 网络失败自动重试的等待（指数退避，共重试 2 次）。 */
const RETRY_DELAYS_MS = [800, 2000]
const RUNNING = new Set(['downloading', 'verifying', 'extracting'])

/** 带分类的安装错误：kind ∈ network | checksum | disk | extract | cancel。 */
export function installError(kind, message, extra) {
  const error = new Error(message)
  error.kind = kind
  if (extra) Object.assign(error, extra)
  return error
}

/** 测试注入点：替换默认 fetch / 解包 / 磁盘查询 / 清单（生产恒为 null）。 */
let testHooks = null
export function setInstallerHooksForTest(hooks) {
  testHooks = hooks || null
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}
function statSafe(p) {
  try { return statSync(p) } catch { return null }
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function waitDrain(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => { stream.removeListener('error', onError); resolve() }
    const onError = (error) => { stream.removeListener('drain', onDrain); reject(error) }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

/** 目录占用（递归求和；417 个文件，毫秒级）。 */
function dirBytes(dir) {
  let total = 0
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(p)
    else {
      const st = statSafe(p)
      if (st && st.isFile()) total += st.size
    }
  }
  return total
}

/** 某个目录所在卷的可用字节（目录还没建就往上看最近的存在祖先）。 */
function freeBytesOf(dir) {
  let probe = path.resolve(dir || '.')
  for (;;) {
    if (existsSync(probe)) {
      try {
        const st = statfsSync(probe)
        return st.bavail * st.bsize
      } catch { return null }
    }
    const up = path.dirname(probe)
    if (up === probe) return null
    probe = up
  }
}

/** 归档 sha256（流式，348MB 约 1s，不占内存）。 */
async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 找不到 tar 时的等价命令（用户可照着在终端里手动跑）。 */
function manualExtractCommand(archive, dest) {
  return 'tar -xjf "' + archive + '" -C "' + dest + '"'
}

/**
 * 默认解包：系统 tar（bsdtar）。找不到就报 extract 错并给等价命令——不做纯 JS 兜底。
 * job 传入时记录子进程，取消时可 kill。
 */
export function extractWithSystemTar(archive, dest, job) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('tar', ['-xjf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(installError('extract', '启动 tar 失败：' + String(error && error.message || error)
        + '。可以手动解包：' + manualExtractCommand(archive, dest)))
      return
    }
    if (job) job.child = child
    let stderr = ''
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
        if (stderr.length > 4000) stderr = stderr.slice(-4000)
      })
    }
    child.once('error', (error) => {
      if (job) job.child = null
      if (error && error.code === 'ENOENT') {
        reject(installError('extract', '系统里找不到 tar 命令，无法解包（bz2 压缩包需要它）。'
          + 'Windows 10+ 自带 tar，先确认终端里 `tar --version` 能跑；'
          + '或手动解包：' + manualExtractCommand(archive, dest), { code: 'ENOENT' }))
        return
      }
      reject(installError('extract', '解包进程失败：' + String(error && error.message || error)))
    })
    child.once('close', (code, signal) => {
      if (job) job.child = null
      if (code === 0) { resolve(); return }
      const tail = stderr.trim().split('\n').slice(-2).join(' ')
      reject(installError('extract', '解包失败（tar 退出码 ' + (code === null ? 'signal ' + signal : code) + '）'
        + (tail ? '：' + tail : '') + '。可以手动解包：' + manualExtractCommand(archive, dest)))
    })
  })
}

/** 解包出来的模型目录：优先 `<dest>/kokoro-multi-lang-v1_1`，也认平铺顶层。 */
function locateModelRoot(dest, manifest) {
  const hasModel = (dir) => existsSync(path.join(dir, 'model.onnx')) || existsSync(path.join(dir, 'model.int8.onnx'))
  if (hasModel(dest)) return dest
  const nested = path.join(dest, manifest.version)
  if (hasModel(nested)) return nested
  let entries = []
  try { entries = readdirSync(dest, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(dest, entry.name)
    if (hasModel(dir)) return dir
  }
  return ''
}

/** 复核关键文件：在且字节数完全一致（sha256 对上以后这是第二道网）。 */
function verifyKeyFiles(dir, manifest) {
  const bad = []
  for (const file of manifest.keyFiles) {
    const p = path.join(dir, file.name)
    if (file.dir) {
      if (!isDir(p)) bad.push(file.name + '/')
      continue
    }
    const st = statSafe(p)
    if (!st || !st.isFile()) { bad.push(file.name + '（没有）'); continue }
    if (typeof file.bytes === 'number' && st.size !== file.bytes) {
      bad.push(file.name + '（' + st.size + ' 字节，应为 ' + file.bytes + '）')
    }
  }
  return { ok: bad.length === 0, detail: bad.join('、') }
}

/**
 * 创建安装器（一个插件实例一个：单任务状态就存这里）。
 * @param options.rootDir - 返回模型根目录（默认 <DSH_HOME>/voice/models）
 * @param options.getActive - 返回当前生效的模型来源 {source,dir}（判定能不能删）
 * @param options.manifest - 清单（默认 model-manifest.js 里那份）
 * @param options.fetchImpl / extractImpl / freeBytes / retryDelaysMs / minFreeBytes - 测试注入
 */
export function createModelInstaller(options = {}) {
  let job = null // 当前任务（同一时刻只有一个）

  function cfg() {
    return Object.assign({
      manifest: MODEL_MANIFEST,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      extractImpl: extractWithSystemTar,
      freeBytes: freeBytesOf,
      retryDelaysMs: RETRY_DELAYS_MS,
      minFreeBytes: MIN_FREE_BYTES,
      rootDir: () => userModelRoot(),
      getActive: () => ({ source: '', dir: '' }),
    }, options, testHooks || {})
  }

  function dirs(c) {
    const root = c.rootDir()
    return {
      root,
      final: path.join(root, MODEL_DIR_NAME),
      marker: path.join(root, MODEL_DIR_NAME, MARKER_NAME),
      partial: path.join(root, PARTIAL_DIR),
    }
  }

  function installedInfo(c) {
    const { final, marker } = dirs(c)
    const info = inspectModelDir(final)
    const mark = readJson(marker)
    return {
      installed: info.ok,
      dir: final,
      marker: mark,
      missing: info.missing || [],
      bytes: mark && typeof mark.bytes === 'number' ? mark.bytes : (info.ok ? dirBytes(final) : 0),
      version: mark && mark.version ? String(mark.version) : '',
      installedAt: mark && mark.installedAt ? String(mark.installedAt) : '',
    }
  }

  /** 删除范围：只删"有装机标记 + 当前没被别处占用"的那一份。 */
  function removeScope(active, info) {
    if (!info.installed) return { deletable: false, reason: '' }
    if (!info.marker) return { deletable: false, reason: '这份模型不是从设置页装的（没有安装标记），不在可删范围' }
    if (active.source === 'config') {
      return { deletable: false, reason: '当前模型来自自定义目录（' + active.dir + '），不在可删范围' }
    }
    if (active.source === 'env') {
      return { deletable: false, reason: '当前模型来自环境变量 VOICE_LOCAL_MODEL_DIR（' + active.dir + '），不在可删范围' }
    }
    if (active.source === 'repo') {
      return { deletable: false, reason: '当前模型来自仓库 local/models，不在可删范围' }
    }
    return { deletable: true, reason: '' }
  }

  function status() {
    const c = cfg()
    const active = c.getActive() || {}
    const info = installedInfo(c)
    const scope = removeScope(active, info)
    const j = job
    const manifest = c.manifest
    return {
      ok: true,
      phase: j ? j.phase : 'idle',
      received: j ? j.received : 0,
      total: j ? j.total : manifest.archiveBytes,
      percent: j ? j.percent : 0,
      attempt: j ? j.attempt : 0,
      error: j ? j.error : '',
      errorKind: j ? j.errorKind : '',
      installed: info.installed,
      installDir: info.dir,
      installedVersion: info.version,
      installedBytes: info.bytes,
      installedAt: info.installedAt,
      deletable: scope.deletable,
      deleteBlockedReason: scope.reason,
      activeSource: active.source || '',
      activeDir: active.dir || '',
      manifest: {
        version: manifest.version,
        displayVersion: manifest.displayVersion,
        sourceLabel: manifest.sourceLabel,
        url: manifest.url,
        archiveBytes: manifest.archiveBytes,
        archiveLabel: formatBytes(manifest.archiveBytes),
        extractedBytes: manifest.extractedBytes,
        extractedLabel: formatBytes(manifest.extractedBytes),
        sha256: manifest.archiveSha256,
      },
    }
  }

  /** 清扫上次留下的解包临时目录（启动时与每次安装开始时都调）。 */
  function sweep() {
    const c = cfg()
    const { root } = dirs(c)
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return 0 }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue
      try { rmSync(path.join(root, entry.name), { recursive: true, force: true }); removed++ } catch { /* 占用中就下次再清 */ }
    }
    return removed
  }

  function clearJob() {
    job = null
  }

  /** 失败/取消后的清理：`.tmp-*` 一律删；`.partial` 只在"这份数据已经没用"时删。 */
  function cleanup(c, j, dropPartial) {
    const { root, partial } = dirs(c)
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { /* 根目录没建 */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue
      try { rmSync(path.join(root, entry.name), { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    if (dropPartial) {
      try { rmSync(partial, { recursive: true, force: true }) } catch { /* 忽略 */ }
    } else {
      // 网络失败要留断点数据，但如果一个字节都没写成（空目录），不必留个空壳
      try { if (readdirSync(partial).length === 0) rmSync(partial, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    if (j && j.tmpDir) {
      try { rmSync(j.tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  function checkCancel(j) {
    if (j.cancelRequested) throw installError('cancel', '已取消安装')
  }

  /** 下载一次（可续传）；网络层失败抛 network，交给上面重试。 */
  async function downloadOnce(j, c, archive, metaPath) {
    const total = c.manifest.archiveBytes
    const meta = readJson(metaPath)
    let start = 0
    const st = statSafe(archive)
    if (st && st.isFile()) start = st.size
    if (start >= total) { // 上次已经下完整（例如解包失败后重试）：不再请求，直接进校验
      j.received = total
      j.percent = 100
      return
    }
    const headers = {}
    if (start > 0 && meta && meta.etag && meta.url === c.manifest.url && meta.version === c.manifest.version) {
      headers.Range = 'bytes=' + start + '-'
      headers['If-Range'] = String(meta.etag)
    } else if (start > 0) {
      // 没有 ETag 就无法确认文件没变（Range 可能凑出坏文件）：从头来
      rmSync(archive, { force: true })
      start = 0
    }
    j.received = start
    j.percent = Math.min(99, Math.floor((start / total) * 100))

    let res
    try {
      res = await c.fetchImpl(c.manifest.url, { headers, signal: j.abort.signal, redirect: 'follow' })
    } catch (error) {
      if (j.cancelRequested || (error && error.name === 'AbortError')) throw installError('cancel', '已取消安装')
      throw installError('network', '连不上服务器（网络不通，或代理没配好）：' + String(error && error.message || error))
    }
    checkCancel(j)
    if (res.status === 416) { // 断点位置服务器不认（文件变了/临时数据坏了）：清掉重来
      rmSync(archive, { force: true })
      throw installError('network', '断点续传的位置服务器不认了，重新下载')
    }
    if (!res.ok) {
      throw installError('network', '服务器返回 HTTP ' + res.status + (res.status === 404 ? '（发布页上找不到了，可能上游换地址）' : ''))
    }
    if (!res.body) throw installError('network', '服务器没有返回内容')
    const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : ''
    if (etag) {
      try {
        writeFileSync(metaPath, JSON.stringify({
          url: c.manifest.url, version: c.manifest.version, etag: String(etag), savedAt: new Date().toISOString(),
        }, null, 2))
      } catch { /* 标记写不下不影响下载，只是下次不能续传 */ }
    }
    // 请求了续传但服务器回 200（If-Range 不匹配 = 文件变了）：丢弃已有字节，从头写；
    // 回 206 时再核一次 Content-Range 起点，服务器给错位置就重新下（否则会拼出坏文件）
    const resuming = start > 0 && res.status === 206
    if (resuming) {
      const contentRange = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-range') || '') : ''
      const matched = /^bytes\s+(\d+)-/.exec(contentRange)
      if (matched && Number(matched[1]) !== start) {
        rmSync(archive, { force: true })
        throw installError('network', '服务器返回的续传位置不对，重新下载')
      }
    }
    if (start > 0 && !resuming) {
      start = 0
      rmSync(archive, { force: true })
    }

    const stream = createWriteStream(archive, { flags: resuming ? 'a' : 'w' })
    let got = start
    try {
      for await (const chunk of res.body) {
        if (j.cancelRequested) {
          try { j.abort.abort() } catch { /* 已 abort */ }
          throw installError('cancel', '已取消安装')
        }
        got += chunk.length
        j.received = got
        j.percent = Math.min(99, Math.floor((got / total) * 100))
        if (!stream.write(chunk)) await waitDrain(stream)
      }
      await new Promise((resolve, reject) => {
        stream.end((error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      try { stream.destroy() } catch { /* 忽略 */ }
      if (j.cancelRequested || (error && error.kind === 'cancel')) throw installError('cancel', '已取消安装')
      if (error && error.name === 'AbortError') throw installError('cancel', '已取消安装')
      if (error && error.kind === 'network') throw error
      throw installError('network', '下载中断：' + String(error && error.message || error))
    }
    j.received = statSafe(archive) ? statSync(archive).size : got
    if (j.received < total) {
      throw installError('network', '下载没下完（' + j.received + ' / ' + total + ' 字节）')
    }
    j.percent = 100
  }

  /** 网络失败自动重试 2 次（退避）；其它错误直接抛。 */
  async function downloadWithRetry(j, c, archive, metaPath) {
    for (let attempt = 0; ; attempt++) {
      try {
        await downloadOnce(j, c, archive, metaPath)
        return
      } catch (error) {
        const kind = error && error.kind ? error.kind : 'network'
        if (kind !== 'network') throw error
        if (attempt >= c.retryDelaysMs.length) {
          throw installError('network', String(error.message) + '（已自动重试 ' + c.retryDelaysMs.length + ' 次）')
        }
        j.attempt = attempt + 1
        console.warn('[voice] model download retry ' + j.attempt + '/' + c.retryDelaysMs.length + '：' + String(error.message))
        await sleep(c.retryDelaysMs[attempt])
        checkCancel(j)
      }
    }
  }

  async function run(j, c) {
    const { root, final, marker: markerPath, partial } = dirs(c)
    try {
      mkdirSync(root, { recursive: true })
      sweep() // 上次崩溃留下的 .tmp-*
      mkdirSync(partial, { recursive: true })
      const archive = path.join(partial, c.manifest.version + '.tar.bz2')
      const metaPath = archive + '.meta.json'

      j.phase = 'downloading'
      await downloadWithRetry(j, c, archive, metaPath)
      checkCancel(j)

      j.phase = 'verifying'
      j.percent = 100
      const size = statSafe(archive) ? statSync(archive).size : 0
      if (size !== c.manifest.archiveBytes) {
        throw installError('checksum', '下载到的文件大小不对（' + size + ' 字节，清单是 '
          + c.manifest.archiveBytes + '）：上游文件已更新，请升级插件')
      }
      const sha = await sha256File(archive)
      if (sha !== c.manifest.archiveSha256) {
        throw installError('checksum', '文件校验没通过（sha256 对不上）：上游文件已更新，请升级插件')
      }
      checkCancel(j)

      j.phase = 'extracting'
      const tmpDir = path.join(root, TMP_PREFIX + Math.random().toString(16).slice(2, 10))
      j.tmpDir = tmpDir
      mkdirSync(tmpDir, { recursive: true })
      await c.extractImpl(archive, tmpDir, j)
      checkCancel(j)
      const srcDir = locateModelRoot(tmpDir, c.manifest)
      if (!srcDir) throw installError('extract', '解包后没找到 model.onnx（压缩包结构变了？）')
      const verified = verifyKeyFiles(srcDir, c.manifest)
      if (!verified.ok) throw installError('extract', '解包不完整：' + verified.detail)
      const bytes = dirBytes(srcDir)
      writeFileSync(path.join(srcDir, MARKER_NAME), JSON.stringify({
        version: c.manifest.version,
        sha256: c.manifest.archiveSha256,
        extractedBytes: c.manifest.extractedBytes,
        installedAt: new Date().toISOString(),
        bytes,
        source: c.manifest.url,
      }, null, 2))
      checkCancel(j)
      if (existsSync(final)) rmSync(final, { recursive: true, force: true })
      renameSync(srcDir, final)
      if (j.tmpDir) { try { rmSync(j.tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
      j.tmpDir = ''
      try { rmSync(partial, { recursive: true, force: true }) } catch { /* 348MB 归档用完就删 */ }
      j.phase = 'done'
      j.received = c.manifest.archiveBytes
      j.percent = 100
      j.installedBytes = bytes
      console.log('[voice] model installed: ' + final + '（' + formatBytes(bytes) + '，标记 ' + markerPath + '）')
    } catch (error) {
      const err = j.cancelRequested
        ? installError('cancel', '已取消安装')
        : (error && error.kind ? error : installError('extract', String(error && error.message || error)))
      // 解包失败时归档还是好的：留着，下次重试不用再下 348MB；
      // 取消/校验失败/磁盘不足时断点数据已经没用，一起清掉
      cleanup(c, j, err.kind === 'cancel' || err.kind === 'checksum' || err.kind === 'disk')
      if (err.kind === 'cancel') {
        clearJob()
        console.log('[voice] model install cancelled; 临时目录与断点数据已清理')
        return
      }
      j.phase = 'failed'
      j.error = String(err.message || err)
      j.errorKind = err.kind
      j.received = 0
      j.percent = 0
      j.child = null
      console.error('[voice] model install failed (' + j.errorKind + '): ' + j.error)
    }
  }

  /** 开始安装（单任务）。 */
  async function start() {
    const c = cfg()
    if (job && RUNNING.has(job.phase)) {
      return { ok: true, started: false, reason: 'busy', state: status() }
    }
    const info = installedInfo(c)
    if (info.installed) {
      return { ok: true, started: false, reason: 'already-installed', state: status() }
    }
    const free = c.freeBytes(dirs(c).root)
    if (typeof free === 'number' && free < c.minFreeBytes) {
      const need = c.minFreeBytes - free
      const message = '磁盘空间不够：安装至少需要 ' + formatBytes(c.minFreeBytes)
        + '，当前只剩 ' + formatBytes(free) + '，还差 ' + formatBytes(need) + '。清理一些文件后再试。'
      job = {
        phase: 'failed', received: 0, total: c.manifest.archiveBytes, percent: 0, attempt: 0,
        error: message, errorKind: 'disk', cancelRequested: false, abort: new AbortController(), tmpDir: '',
      }
      return { ok: false, errorKind: 'disk', error: message, needBytes: need, freeBytes: free, state: status() }
    }
    const j = {
      phase: 'downloading', received: 0, total: c.manifest.archiveBytes, percent: 0, attempt: 0,
      error: '', errorKind: '', startedAt: Date.now(), cancelRequested: false,
      abort: new AbortController(), child: null, tmpDir: '',
    }
    job = j
    j.promise = run(j, c)
    return { ok: true, started: true, state: status() }
  }

  /** 取消：立刻停下载/解包，清临时目录与断点数据，回到未装态。 */
  async function cancel() {
    const j = job
    if (!j || !RUNNING.has(j.phase)) return { ok: true, cancelled: false, state: status() }
    j.cancelRequested = true
    try { j.abort.abort() } catch { /* 已 abort */ }
    if (j.child) { try { j.child.kill() } catch { /* 已退出 */ } }
    if (j.promise) await j.promise
    return { ok: true, cancelled: true, state: status() }
  }

  /** 删除我们装的那一份（必须带装机标记，且当前没被自定义目录/仓库模型占用）。 */
  async function remove() {
    const c = cfg()
    if (job && RUNNING.has(job.phase)) {
      return { ok: false, errorKind: 'busy', error: '正在安装，先取消再删除', state: status() }
    }
    const active = c.getActive() || {}
    const info = installedInfo(c)
    if (!info.installed) {
      return { ok: false, errorKind: 'not-installed', error: '本地模型没装，没有可删除的目录', state: status() }
    }
    const scope = removeScope(active, info)
    if (!scope.deletable) {
      return { ok: false, errorKind: 'not-removable', error: scope.reason || '不在可删范围', state: status() }
    }
    rmSync(info.dir, { recursive: true, force: true })
    clearJob()
    return { ok: true, removed: true, state: status() }
  }

  return { start, status, cancel, remove, sweep }
}
//#endregion
