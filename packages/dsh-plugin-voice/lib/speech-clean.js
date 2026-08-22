//#region dsh-plugin-voice — 文本净化 / TTS 引擎归一（纯函数，便于单测）
/**
 * 口播文本净化：把可能被 TTS 照读的 Markdown 标记、装饰符号、表情符号剥成
 * 适合朗读的纯文本（docs/voice-pipeline.md §1.2）。
 * 顺序敏感：先整段结构（代码块/表格/链接）→ 再行内标记 → 再符号 → 空白整理。
 * 保留：CJK 全角标点（。，、；：！？…）与 ASCII 句读（. , ! ? ; : % + - /）。
 */
export function sanitizeForSpeech(text) {
  let t = String(text == null ? '' : text)
  // 1) 代码块整体跳过（不留占位词，避免占位文字也被读出来）
  t = t.replace(/```[\s\S]*?```/g, '')
  // 2) Markdown 表格行整行跳过（含分隔行）
  t = t.replace(/^\s*\|.*\|\s*$/gm, '')
  // 3) 链接 → "链接" + 域名（不逐字符读）
  t = t.replace(/https?:\/\/[^\s)\]】>]+/g, (u) => {
    try { return '链接' + String(new URL(u).hostname).replace(/^www\./, '') } catch { return '链接' }
  })
  // 4) 行内代码：去反引号保留内容（如文件名）
  t = t.replace(/`([^`]*)`/g, '$1')
  // 5) 行级标记：标题 / 列表 / 引用 / 分隔线
  t = t.replace(/^#{1,6}\s*/gm, '')
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
  t = t.replace(/^\s*>\s*/gm, '')
  t = t.replace(/^[ \t]*[-_*]{3,}[ \t]*$/gm, '')
  // 6) 强调 / 删除线 / 残留反引号
  t = t.replace(/[*_~`]/g, '')
  // 7) TTS 会照读的装饰符号 → 删除（引号并入）
  t = t.replace(/[\[\]{}()<>|\\=#^&@$]/g, '')
  t = t.replace(/["']/g, '')
  // 8) 表情符号与特殊符号区段（emoji/箭头/技术符号/变体选择符）
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '')
  // 9) 空白整理
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}
