#!/usr/bin/env node
/**
 * 重启后自检（零成本）：一次性核对"朗读插件在运行中的 dsh 里真的装好了"。
 *
 * 为什么需要：安装/升级带 Client 半的插件后 **Host 半会热加载、Client 半只有整个应用重启才进
 * boot 图**（docs/development.md §2）。重启后想确认"到底进没进"，跑这一个脚本就够，
 * 不用开 DevTools 翻 console。
 *
 * 用法（重启桌面端后）：
 *   1. 从应用启动日志里拿带 token 的地址（形如 http://127.0.0.1:19387/?token=xxxx）
 *   2. node scripts/verify-installed.mjs --url "http://127.0.0.1:19387/?token=xxxx"
 *   3. 想同时验真实合成：加 --speak-paid（豆包会花几分钱；本地引擎免费）
 *
 * 退出码：0 = 全部通过；1 = 有项目没通过；2 = 用法错误。每项都打印证据。
 */
const args = process.argv.slice(2)
function opt(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}
const urlArg = opt('url')
const paid = args.includes('--speak-paid')

if (urlArg === undefined) {
  console.error('用法：node scripts/verify-installed.mjs --url "http://127.0.0.1:19387/?token=<token>" [--speak-paid]')
  process.exit(2)
}

const parsed = new URL(urlArg)
const token = parsed.searchParams.get('token')
const query = token ? `?token=${encodeURIComponent(token)}` : ''
const origin = parsed.origin
const base = origin + '/voice/api/'

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + label + (detail ? '  ' + detail : '')) }
  else { fail += 1; console.log('  FAIL ' + label + (detail ? '  ' + detail : '')) }
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 就留 null */ }
  return { status: res.status, json, text }
}

console.log('自检目标：' + origin + '\n')

// 首页鉴权：带 token 访问会 303 并下发 dsh-auth-* cookie，之后再请求 "./" 才给 HTML。
// 所以必须手动跟一次跳转并把 cookie 带上（fetch 默认自动跟随会丢掉 cookie，落到 401/400）。
async function fetchIndexAuthenticated() {
  const first = await fetch(origin + '/' + query, { redirect: 'manual' })
  if (first.status !== 303 && first.status !== 302) {
    const html = await first.text()
    return { status: first.status, html }
  }
  const setCookie = first.headers.get('set-cookie')
  if (!setCookie) return { status: first.status, html: '', note: '令牌响应没有下发 cookie' }
  const cookie = setCookie.split(';')[0]
  const location = first.headers.get('location') || './'
  const second = await fetch(new URL(location, origin + '/').href, { headers: { cookie } })
  return { status: second.status, html: await second.text() }
}

// 1) Host 半：路由活着
let ping
try {
  ping = await post('ping', {})
} catch (error) {
  check('Host 半已加载（/voice/api/ping）', false, String(error.message))
  console.log('\n结果：0 通过 / 1 未通过（Host 半没起来：先看应用日志里 [voice] 那几行）')
  process.exit(1)
}
check('Host 半已加载（/voice/api/ping）', ping.status === 200 && ping.json && ping.json.ok === true, 'HTTP ' + ping.status)

// 2) Client 半：必须在注入的 boot 图里（"界面看不看得见"的唯一硬证据）
if (!query) {
  check('Client 半进入 boot 图', false, '没给 token 取不到首页（--url 里要带 ?token=…）')
} else {
  let html = ''
  try {
    const page = await fetchIndexAuthenticated()
    html = page.html
    console.log('  --   首页：' + (page.note ? page.note : 'HTTP ' + page.status + ' / ' + html.length + ' bytes'))
  } catch (error) {
    console.log('  warn 取首页失败：' + String(error.message))
  }
  // 注入的是**相对**地址（形如 plugins/??a/client.js,b/client.js&rev=…）。
  // 不用正则：先从插件标识往前找组合包的起点，再往后取到引号/空白为止——字符串匹配比正则稳。
  const marker = 'dsh-plugin-voice/client.js'
  const at = html.indexOf(marker)
  let combo
  if (at >= 0) {
    const start = html.lastIndexOf('plugins/??', at)
    if (start >= 0) {
      let end = at + marker.length
      while (end < html.length && !/[\s"'<>]/.test(html[end])) end += 1
      combo = html.slice(start, end)
    }
  }
  check('Client 半进入 boot 图', combo !== undefined, combo === undefined ? '首页注入里没有它 —— 应用可能没真正重启' : ('…' + combo.slice(-58)))
  if (combo !== undefined) {
    // 注入在 HTML 属性里，`&` 会被转义成 `&amp;`——不还原会丢掉 &rev=… 而拿到 404
    const url = combo.replace(/&amp;/g, '&')
    const res = await fetch(origin + '/' + url)
    const body = await res.text()
    const idx = body.indexOf('dsh-plugin-voice')
    check('Client 半可服务（取回字节）', res.ok, res.status + ' / ' + body.length + ' bytes')
    check('取回的内容属于本插件', idx >= 0, idx >= 0 ? '插件标识在第 ' + idx + ' 字节' : '没找到插件标识')
  }
}

// 3) 配置：能读回，且迁移过来的关键项还在（不判断具体值——那是用户自己的选择）
const cfg = await post('getConfig', {})
const c = cfg.json && cfg.json.ok ? cfg.json.config : null
check('配置可读（/voice/api/getConfig）', c !== null, 'HTTP ' + cfg.status)
if (c) {
  check('引擎字段在', typeof c.tts?.provider === 'string', 'provider=' + c.tts?.provider)
  check('音色字段在', typeof c.tts?.volcengine?.speaker === 'string', 'speaker=' + c.tts?.volcengine?.speaker)
  check('转写字段在', typeof c.transcribe?.stylePreset === 'string', 'stylePreset=' + c.transcribe.stylePreset)
  const key = c.tts?.volcengine?.apiKey
  // 不是硬断言：全新 profile 本来就没有 key（引擎默认 browser 不需要）。有值=迁移没丢；
  // 没值但引擎是 volcengine 才是真问题。
  if (typeof key === 'string' && key.length > 0) {
    check('豆包 API Key 在配置里', true, '长度 ' + key.length)
  } else if (c.tts?.provider === 'volcengine') {
    check('豆包 API Key 在配置里', false, '引擎选了豆包但 key 为空 —— 去看 profile 的 cordis.patch.yml')
  } else {
    console.log('  --   豆包 API Key 为空（引擎当前是 ' + c.tts?.provider + '，不需要 key）')
  }
}

// 4) 本地引擎：进程内运行时自检（模型在哪、装没装、加载没加载）
const local = await post('localStatus', {})
check('local（Kokoro）运行时可用（接口在）', !!(local.json && local.json.ok),
  local.json && local.json.ok
    ? 'installed=' + local.json.installed + ' dir=' + local.json.modelDir + ' loaded=' + local.json.loaded
      + (local.json.installed ? '' : ' error=' + String(local.json.error || '').slice(0, 120))
    : String(local.json && local.json.error))
if (local.json && local.json.ok && local.json.installed === false) {
  console.log('  --   模型未安装：设置页 → 语音播报 → 引擎选「本地 Kokoro」→ 点「下载模型」（详见 docs/local-tts.md）')
}

// 4b) 模型安装器：状态口径（只查文件，不会触发下载/加载模型）
const deploy = await post('deployStatus', {})
const dj = (deploy.json && deploy.json.ok) ? deploy.json : null
check('模型安装接口在（/voice/api/deployStatus）', dj !== null, dj ? 'phase=' + dj.phase : 'HTTP ' + deploy.status)
if (dj) {
  check('安装状态可读（phase / installed / deletable）',
    typeof dj.phase === 'string' && typeof dj.installed === 'boolean' && typeof dj.deletable === 'boolean',
    'phase=' + dj.phase + ' installed=' + dj.installed + ' deletable=' + dj.deletable)
  check('安装清单口径在（来源 + 下载量 + 解包容积）',
    !!(dj.manifest && dj.manifest.sourceLabel && dj.manifest.archiveLabel && dj.manifest.extractedLabel),
    dj.manifest ? dj.manifest.archiveLabel + ' → ' + dj.manifest.extractedLabel + ' · ' + dj.manifest.sourceLabel : '')
  if (dj.installed) {
    console.log('  --   模型已装：' + dj.installDir + '（' + Math.round((dj.installedBytes || 0) / (1024 * 1024))
      + 'MB，版本 ' + (dj.installedVersion || '?') + '，可删=' + dj.deletable + '）')
  } else {
    console.log('  --   模型未安装：设置页点「下载模型」（348MB，装完不用重启）')
  }
}

// 5) 可选：真实合成（花几分钱）
if (paid) {
  const pv = await post('preview', {})
  check('试听成功（真实合成）', !!(pv.json && pv.json.ok === true && (pv.json.mode === 'browser' || pv.json.audioUrl)),
    pv.json ? JSON.stringify(pv.json).slice(0, 150) : 'HTTP ' + pv.status)
} else {
  console.log('  --   跳过真实合成（要验就加 --speak-paid；豆包花几分钱，本地引擎免费）')
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 未通过')
if (fail > 0) console.log('排查顺序：应用日志里 [voice] 那几行 → 插件页看条目是不是 active → 上面第 2 项（Client 半）')
process.exit(fail === 0 ? 0 : 1)
