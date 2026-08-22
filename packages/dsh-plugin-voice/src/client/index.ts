/**
 * dsh-plugin-voice — Client half (browser).
 *
 * ⚠️ v1 实现直接手工编写在 `../../lib/client.js`（window.__ModuleLoader__.load
 * 格式，无构建步骤，见 docs/development.md §1）。本文件仅为结构占位/后续 TS 化时的家。
 * 运行时行为以 lib/client.js 为准。
 */

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  // TODO(phase 1): ctx.locale.register('voice', { zh, en })
  // TODO(phase 1): ctx.slots.inject('conversation.chat.assistant-actions', ...)
  // TODO(phase 1): ctx.slots.inject('conversation.input.left', ...)
  // TODO(phase 1): ctx.conversationEvents.register(definition)
}

export const inject = ['slots', 'locale', 'conversationEvents', 'connection'];
