#!/usr/bin/env node

// DSH Client 半的最小合约测试：不启动浏览器，只验证 ModuleLoader 导出的依赖与会话 Definition 注册。
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
  ]
  const hasExactSlots = expectedSlots.length === slots.length && expectedSlots.every((name, index) => slots[index] === name)
  if (!client.inject.includes('uiConversation') || client.inject.includes('conversationEvents')) {
    throw new Error('client inject must require uiConversation and not conversationEvents: ' + JSON.stringify(client.inject))
  }
  if (definitions.length !== 1 || definitions[0].kind !== 'voice') {
    throw new Error('voice Definition was not registered through uiConversation.events')
  }
  if (!hasExactSlots) throw new Error('unexpected injected slots: ' + JSON.stringify(slots))

  console.log('client contract: uiConversation.events + voice Definition + slots OK')
} finally {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
}
