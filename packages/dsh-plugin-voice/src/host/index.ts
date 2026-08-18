/**
 * dsh-plugin-voice — Host half (node).
 *
 * ⚠️ v1 实现直接手工编写在 `../../lib/index.js`（纯 JS，无构建步骤，见
 * docs/dev-playbook.md §1）。本文件仅为结构占位/后续 TS 化时的家。
 * 运行时行为以 lib/index.js 为准（已经创造模式 spike 验证，pkg-9）。
 */

/**
 * Cordis plugin body.
 * @param ctx - host root context.
 */
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    // TODO(phase 1): collect assistant/message text per turn; on turn/end
    // with reason.kind in {'completed','max-tokens'} and voice.autoSpeak,
    // run transcribe → speak.
    void session;
    void event;
  });

  // TODO(phase 1): harness.handle('voice.speak', async (args) => { ... })
  // TODO(phase 1): harness.handle('voice.stop', async () => { ... })
  // TODO(phase 1): ctx.settings.register('voice', schema, { base })
}

export const inject = [];
