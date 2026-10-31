#!/usr/bin/env node

// 发版前的隐私与安全体检：零成本、不联网、不改任何文件。
// 查四件事——
//   1. 仓库里有没有密钥、令牌、本机绝对路径（工作树按行判失败；提交历史另做只读报告，历史改不掉）；
//   2. 发版物（npm pack 的内容）有没有夹带模型、测试或本机文件；
//   3. 忽略规则有没有漏掉密钥目录、模型目录、产物目录；
//   4. 本机 voice 目录的体积基线（模型/缓存/提示音素材），以及配置与密钥没被跟踪。
// 用法：node scripts/audit-release.mjs
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_DIR = path.join(ROOT, 'packages', 'voice-for-dsh')
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || '' })
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.message) || error) })
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean)
}

// 只扫文本文件：按扩展名排除二进制，再按体积兜底（截图、锁文件仍算文本之外的噪声）
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.bz2',
  '.onnx', '.bin', '.wav', '.mp3', '.ogg', '.woff', '.woff2', '.ttf', '.node', '.zst',
])
const MAX_SCAN_BYTES = 2 * 1024 * 1024

// 密钥形态：命中即失败。打印时只给文件与行号，不回显命中的内容。
const SECRET_RULES = [
  { id: 'openai-style sk-', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { id: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer token literal', re: /\bBearer\s+[A-Za-z0-9_.-]{20,}/ },
  { id: 'inline key assignment', re: /(?:api[_-]?key|app[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
]

// 本机绝对路径：不要把某台机器的用户名带进公开仓库（示例路径里的通用词放过）
const HOME_PATH_RULE = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)([^\\/\s"'`]+)/g
const GENERIC_NAMES = new Set(['path', 'to', 'you', 'yourname', 'user', 'username', 'name', 'example', 'me'])

const files = trackedFiles()

check('仓库里搜不到密钥形态（工作树）', () => {
  const hits = []
  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    let stat
    try { stat = statSync(abs) } catch { continue }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    const text = readFileSync(abs, 'utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      for (const rule of SECRET_RULES) {
        if (rule.re.test(lines[i])) hits.push(`${rel}:${i + 1}（${rule.id}）`)
      }
    }
  }
  if (hits.length) throw new Error(hits.slice(0, 8).join('；') + (hits.length > 8 ? ` …共 ${hits.length} 处` : ''))
  return `${files.length} 个跟踪文件`
})

check('仓库里搜不到本机用户名路径', () => {
  const hits = []
  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    let text
    try { text = readFileSync(path.join(ROOT, rel), 'utf8') } catch { continue }
    if (text.length > MAX_SCAN_BYTES) continue
    for (const match of text.matchAll(HOME_PATH_RULE)) {
      const name = String(match[1])
      // 省略号与占位符（`C:\Users\...`、`/home/<name>`）不是真实用户名
      if (GENERIC_NAMES.has(name.toLowerCase()) || /[<>]/.test(name) || /^[.…]+$/.test(name)) continue
      const line = text.slice(0, match.index).split(/\r?\n/).length
      hits.push(`${rel}:${line}（用户目录 ${name}）`)
    }
  }
  if (hits.length) throw new Error(hits.slice(0, 8).join('；'))
  return '无绝对路径'
})

check('密钥文件与用户配置没有被跟踪', () => {
  const forbidden = files.filter((rel) => /(^|\/)(\.env|\.env\..*|settings\.ya?ml|profiles\/|.*\.key|.*\.pem|credentials[^/]*)$/.test(rel)
    && !/\.env\.example$/.test(rel))
  if (forbidden.length) throw new Error(forbidden.join('；'))
  return 'profile / settings / 密钥均不在 git 里'
})

check('.gitignore 覆盖密钥、模型与产物目录', () => {
  const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  const needed = ['node_modules/', 'local/', 'out/', '*.key', '*.pem', '.env', 'tmp*/']
  const missing = needed.filter((entry) => !ignore.split(/\r?\n/).some((line) => line.trim() === entry))
  if (missing.length) throw new Error('缺：' + missing.join('、'))
  return needed.join('、')
})

check('仓库里没有模型、音频与临时目录', () => {
  const bad = files.filter((rel) => /^(local|out|node_modules|tmp[^/]*)\//.test(rel)
    || /\.(onnx|bin|wav|mp3|ogg|zst|tar\.bz2)$/i.test(rel))
  if (bad.length) throw new Error(bad.slice(0, 8).join('；'))
  return '模型/素材/产物均未入库'
})

check('对外文档不提内部项目名', () => {
  const bad = []
  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    let text
    try { text = readFileSync(path.join(ROOT, rel), 'utf8') } catch { continue }
    if (/\bJunos\b/i.test(text)) bad.push(rel)
  }
  if (bad.length) throw new Error(bad.join('；'))
  return '无内部项目名与页面名'
})

check('两处 package.json 版本一致', () => {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
  if (root.version !== plugin.version) throw new Error(`根 ${root.version} ≠ 插件 ${plugin.version}`)
  return `v${plugin.version}`
})

check('CHANGELOG 记录了当前版本', () => {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const log = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  if (!log.includes(`[${root.version}]`) && !log.includes('[Unreleased]')) {
    throw new Error(`CHANGELOG 顶部没有 [${root.version}] 或 [Unreleased]`)
  }
  return root.version
})

check('发版物只含源码与清单，不含模型', () => {
  let raw
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PLUGIN_DIR, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    throw new Error('npm pack --dry-run 跑不起来：' + String((error && error.message) || error))
  }
  const info = JSON.parse(raw)[0]
  const paths = (info.files || []).map((file) => file.path)
  const bad = paths.filter((rel) => /\.(onnx|bin|wav|mp3)$/i.test(rel)
    || /^(local|out|node_modules|scripts|docs)\//.test(rel))
  if (bad.length) throw new Error('夹带了：' + bad.join('、'))
  if (!paths.includes('lib/index.js') || !paths.includes('lib/client.js')) throw new Error('缺 lib 主文件')
  if (paths.length > 20) throw new Error(`文件数偏多：${paths.length}`)
  return `${paths.length} 个文件 / ${Math.round(info.size / 1024)}KB`
})

// 提交历史里的密钥形态：只报告、不判失败——历史改不掉，能守的是"以后别再进"。
// 命中条目不回显内容，只给 commit 与文件；看现场用 `git show <commit>`。
function historySecretHits() {
  const raw = execFileSync('git', ['log', '-p', '--all', '--unified=0', '--format=@@COMMIT@@%h'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const hits = []
  let commit = ''
  let file = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@COMMIT@@')) { commit = line.slice('@@COMMIT@@'.length); continue }
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) { hits.push(`${commit} ${file}（${rule.id}）`); break }
    }
  }
  return hits
}

// 本机体积基线：只报数，不判失败（换机器就会变）
function dirSize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(abs)
    else {
      try { total += statSync(abs).size } catch { /* 被占用的文件跳过 */ }
    }
  }
  return total
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const voiceHome = path.join(DSH_HOME, 'voice')
const cacheFile = path.join(DSH_HOME, 'voice-transcript-cache.json')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + 'MB'
const baseline = [
  ['本地模型', dirSize(path.join(voiceHome, 'models'))],
  ['提示音素材', dirSize(path.join(voiceHome, 'sounds'))],
  ['转写缓存', existsSync(cacheFile) ? statSync(cacheFile).size : 0],
]
let cacheEntries = 0
try { cacheEntries = JSON.parse(readFileSync(cacheFile, 'utf8')).length } catch { /* 没缓存 */ }

let failed = 0
for (const item of results) {
  if (!item.ok) failed++
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
}
console.log('\n本机体积基线（不判失败）：')
for (const [label, bytes] of baseline) console.log(`   ${label} ${mb(bytes)}`)
console.log(`   转写缓存条目 ${cacheEntries}`)

console.log('\n提交历史扫描（只报告，历史改不了）：')
try {
  const historyHits = historySecretHits()
  if (!historyHits.length) console.log('   0 处')
  else {
    console.log(`   ${historyHits.length} 处`)
    for (const hit of historyHits.slice(0, 5)) console.log('   - ' + hit)
  }
} catch (error) {
  console.log('   跳过：' + String((error && error.message) || error))
}

console.log(`\n结果: ${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
