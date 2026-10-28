#!/usr/bin/env node
/**
 * 把 DSH 0.1.x 时代 `~/.dsh/settings.yaml` 的 `voice:` 节搬进目标 profile 的
 * `cordis.patch.yml`（0.2.0 起插件配置只从 profile patch 的条目 config 读取）。
 *
 * 为什么需要：0.2.0 首次启动会把 settings.yaml 改名成 settings.yaml.imported，
 * 里面的 voice 节不再被任何插件读取——不搬就等于用户配置静默丢失
 * （转写路由、音色、语速、豆包开关、apiKey 全都会掉回默认值）。
 *
 * 行为：
 *  - 读 legacy YAML 的 voice 节，原样作为 voice 条目的 config 追加到 profile patch 末尾
 *    （整块搬运，不做默认值裁剪：新 schema 里后来新增的字段由 schema 默认值补，
 *      老值一个不丢）；
 *  - 幂等：patch 里已经有 voice 行且带 config 时拒绝写入，除非加 --force；
 *  - 写前备份成 cordis.patch.yml.bak-<时间戳>；
 *  - 默认只打印结果，加 --write 才落盘。
 *
 * 已知落差（存储不丢、听感会变）：老配置里的 `tts.volcengine.pitchLevel`（五档）搬过去也不影响发声——
 * 新 schema 的 `pitch`（连续半音）默认 0 恒存在且优先，见 docs/pipeline.md §6.0。
 *
 * 用法（仓库根目录）：
 *   node scripts/migrate-voice-config.mjs                       # 预览（桌面版 profile）
 *   node scripts/migrate-voice-config.mjs --write               # 落盘
 *   node scripts/migrate-voice-config.mjs --profile-dir <目录>  # 换 profile
 *   node scripts/migrate-voice-config.mjs --legacy <文件>       # 换 legacy 来源
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
function flag(name) { return args.includes('--' + name) }
function opt(name, fallback) {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.resolve(opt('profile-dir', path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')))
const legacyPath = path.resolve(opt('legacy', path.join(DSH_HOME, 'settings.yaml.imported')))
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const write = flag('write')
const force = flag('force')

function die(msg) { console.error('[migrate-voice-config] ' + msg); process.exit(1) }

if (!existsSync(legacyPath)) die('找不到 legacy 配置：' + legacyPath)
if (!existsSync(profileDir)) die('找不到 profile 目录：' + profileDir)

/** 从 legacy 文本里切出 `voice:` 节的原始 YAML 行（缩进不动，零解析依赖）。 */
function voiceSection(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^voice:\s*$/.test(line))
  if (start < 0) die('legacy 配置里没有顶层 voice: 节（无需迁移）')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.startsWith('#')) continue
    if (!/^\s/.test(line)) { end = i; break } // 下一个顶层键
  }
  return lines.slice(start + 1, end).filter((line) => line.trim() !== '')
}

const section = voiceSection(readFileSync(legacyPath, 'utf8'))
if (section.length === 0) die('legacy 的 voice: 节是空的，没有可搬的配置')

const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]\n'
const existing = before.split(/\r?\n/)
const voiceLine = existing.findIndex((line) => /^-\s*id:\s*voice\s*$/.test(line))
if (voiceLine >= 0 && !force) {
  // 该行之后到下一个顶层 `- ` 之前若出现 config:，说明已经搬过了
  let hasConfig = false
  for (let i = voiceLine + 1; i < existing.length; i++) {
    if (/^-\s/.test(existing[i])) break
    if (/^\s+config:\s*$/.test(existing[i])) { hasConfig = true; break }
  }
  if (hasConfig) die('profile patch 里的 voice 条目已经带 config（可能已迁移）。要覆盖请加 --force')
}

const injected = ['', '# ── 语音插件配置（自 settings.yaml 迁移，' + new Date().toISOString().slice(0, 10) + '）──', '- id: voice', '  config:']
  .concat(section.map((line) => '    ' + line))
  .join('\n')

const after = before.replace(/\s*$/, '') + '\n' + injected + '\n'

if (!write) {
  console.log('— 预览：将追加到 ' + patchPath + ' —')
  console.log(injected.trimStart())
  console.log('\n（未落盘；加 --write 生效）')
  process.exit(0)
}

mkdirSync(profileDir, { recursive: true })
if (existsSync(patchPath)) {
  const backup = patchPath + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  copyFileSync(patchPath, backup)
  console.log('[migrate-voice-config] 已备份：' + backup)
}
writeFileSync(patchPath, after, 'utf8')
console.log('[migrate-voice-config] 已写入 ' + patchPath + '（' + section.length + ' 行 voice 配置）')
