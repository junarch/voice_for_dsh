#!/usr/bin/env node

// DSH Client 半的最小合约测试：不启动浏览器，只验证 ModuleLoader 导出的依赖与会话 Definition 注册。
import { readFileSync } from 'node:fs'
const loaded = []
const originalWindow = globalThis.window

try {
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => loaded.push(entry),
    },
  }

  await import(new URL('../packages/dsh-plugin-voice/lib/client.js?client-contract', import.meta.url))

  if (loaded.length !== 1) throw new Error('expected one ModuleLoader entry, got ' + loaded.length)
  const client = loaded[0].factory((id) => {
    if (id === 'react') return {}
    throw new Error('unexpected client dependency: ' + id)
  })
  const definitions = []
  const slots = []
  client.apply({
    effect: () => {},
    slots: { inject: (name) => slots.push(name) },
    uiConversation: { events: { register: (definition) => definitions.push(definition) } },
  })

  const expectedSlots = [
    'conversation.chat.assistant-actions',
    'conversation.input.left',
    'conversation.chat.turnTail',
    'settings.section',
    'shell.overlay',
  ]
  const hasExactSlots = expectedSlots.length === slots.length && expectedSlots.every((name, index) => slots[index] === name)
  if (!client.inject.includes('uiConversation') || client.inject.includes('conversationEvents')) {
    throw new Error('client inject must require uiConversation and not conversationEvents: ' + JSON.stringify(client.inject))
  }
  if (definitions.length !== 1 || definitions[0].kind !== 'voice') {
    throw new Error('voice Definition was not registered through uiConversation.events')
  }
  if (!hasExactSlots) throw new Error('unexpected injected slots: ' + JSON.stringify(slots))

  // i18n 键对齐：zh / en 两套文案的 key 集合必须一致（漏配一边会显示成 key 本身）
  const source = readFileSync(new URL('../packages/dsh-plugin-voice/lib/client.js', import.meta.url), 'utf8')
  const blockOf = (name) => {
    const start = source.indexOf('var ' + name + ' = {')
    if (start < 0) throw new Error('i18n block not found: ' + name)
    const end = source.indexOf('\n    };', start)
    return source.slice(start, end < 0 ? source.length : end)
  }
  // 一行里可能并列多个键（zh 常见），故匹配任意位置的 "key":，不锚定行首
  const keysOf = (block) => [...block.matchAll(/"([^"]+)":/g)].map((m) => m[1]).sort()
  const zhKeys = keysOf(blockOf('zh'))
  const enKeys = keysOf(blockOf('en'))
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
  if (!zhKeys.length) throw new Error('i18n key extraction returned nothing: ' + JSON.stringify(zhKeys))
  if (onlyZh.length || onlyEn.length) {
    throw new Error('i18n keys mismatch — only zh: ' + JSON.stringify(onlyZh) + ' ; only en: ' + JSON.stringify(onlyEn))
  }
  // 播报失败分类文案（Host 的 ttsErrorKind 依赖这三条 + 兜底）
  for (const k of ['toast.fallback', 'toast.ttsUnavailable', 'toast.ttsTimeout', 'toast.ttsHttp']) {
    if (!zhKeys.includes(k)) throw new Error('missing toast key: ' + k)
  }

  console.log('client contract: uiConversation.events + voice Definition + slots + i18n(' + zhKeys.length + ' keys) OK')
} finally {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
}
