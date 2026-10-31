/**
 * voice-for-dsh — Client half (browser).
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
  // v1 实现在 `../../lib/client.js`：locale 注册、槽位注入（assistant-actions / input.left /
  // turnTail / settings.section / shell.overlay）、设置页与播放状态机。
  void ctx;
}

// 与 lib/client.js 的 inject 保持一致
export const inject = ['slots', 'locale', 'uiConversation'];
