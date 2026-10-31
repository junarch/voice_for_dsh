/**
 * voice-for-dsh — Host half (node).
 *
 * ⚠️ v1 实现直接手工编写在 `../../lib/index.js`（纯 JS，无构建步骤，见
 * docs/development.md §1）。本文件仅为结构占位/后续 TS 化时的家。
 * 运行时行为以 lib/index.js 为准。
 */

/**
 * Cordis plugin body.
 * @param ctx - host root context.
 */
export function apply(ctx) {
  // v1 实现在 `../../lib/index.js` 的 apply(ctx) 内：会话监听（assistant/message、turn/end）、
  // harness 方法（voice.speak / voice.stop / voice.streamNext 等）、settings 注册 voice 命名空间、
  // webServer 的 /voice/api 与 /voice/audio 路由。
  void ctx;
}

export const inject = [];
