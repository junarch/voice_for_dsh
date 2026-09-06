#!/usr/bin/env node
/**
 * dsh-read-session.mjs — 按 session ID 读取 DSH 本地会话历史（零依赖）。
 *
 * 为什么需要它：DSH 的会话日志是 zstd 压缩的拼接帧文件
 *   `~/.dsh/sessions/<工作区路径编码>/session-<id>/session.jsonl.zstd`，
 *   普通 `read`/`cat` 读到的是乱码，很多 agent 因此"解压失败"。
 *   本脚本用 Node 内置的 `node:zlib.zstdDecompressSync`（v22+ 自带，无需安装任何包）
 *   逐帧解压，再投影出可读的对话文本。
 *
 * 用法：
 *   node scripts/dsh-read-session.mjs <session-id> [--workspace <路径关键字>] [--format text|jsonl|events] [--limit N] [--dsh-home <路径>]
 *
 * 示例：
 *   node scripts/dsh-read-session.mjs session-04448e88-c4df-4daf-aa01-092df2d937de
 *   node scripts/dsh-read-session.mjs 04448e88 --format events --limit 20
 *
 * session-id 可带或不带 `session-` 前缀、`dsh-session:` / `dsh://session/` 包装。
 * 不带 --workspace 时会在所有工作区下全盘查找（通常只有唯一命中）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

function parseArgs(argv) {
  const args = { format: 'text', limit: Infinity, dshHome: join(homedir(), '.dsh') };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dsh-home') args.dshHome = argv[++i];
    else if (a === '--help' || a === '-h') { args.help = true; }
    else positional.push(a);
  }
  args.sessionId = positional[0];
  return args;
}

/** 归一化用户给的 id：剥掉 `dsh-session:` / `dsh://session/` / `.jsonl.zstd` 等包装。 */
function normalizeId(raw) {
  let id = String(raw).trim();
  id = id.replace(/^dsh-session:/i, '').replace(/^dsh:\/\/session\//i, '').replace(/^https?:\/\/[^/]+\/s\//i, '');
  id = id.replace(/^session-/, '');
  return id;
}

/** 在 ~/.dsh/sessions 下定位会话目录。返回完整目录路径或 null。 */
function locateSessionDir(sessionsRoot, id, workspaceKeyword) {
  if (!existsSync(sessionsRoot)) return null;
  const workspaces = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);

  for (const ws of workspaces) {
    if (workspaceKeyword && !ws.includes(workspaceKeyword)) continue;
    const wsDir = join(sessionsRoot, ws);
    for (const entry of readdirSync(wsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name; // 形如 session-<uuid> 或旧版裸 <uuid>
      const bare = name.replace(/^session-/, '');
      if (bare === id) return join(wsDir, name);
    }
  }
  return null;
}

/** 扫描拼接帧容器：返回每个完整帧的 [start,end) 区间。 */
function scanFrames(buf) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) break;
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`corrupt: bad zstd magic at byte ${off}`);
    const start = off; off += 4;
    const desc = buf.readUInt8(off); off += 1;
    const csFlag = desc >>> 6, single = (desc & 32) !== 0, checksum = (desc & 4) !== 0, dict = desc & 3;
    const dictBytes = dict === 3 ? 4 : dict;
    const csBytes = csFlag === 0 ? (single ? 1 : 0) : (1 << csFlag);
    off += (single ? 0 : 1) + dictBytes + csBytes;
    for (;;) {
      if (buf.length - off < 3) return frames;
      const bh = buf.readUIntLE(off, 3); off += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      const pay = bt === 1 ? 1 : bs;
      if (buf.length - off < pay) return frames;
      off += pay;
      if (last) break;
    }
    if (checksum) off += 4;
    frames.push([start, off]);
  }
  return frames;
}

/** 解压会话文件（兼容 .jsonl.zstd 与明文 .jsonl），返回事件对象数组。 */
function loadEvents(sessionDir) {
  const zstd = join(sessionDir, 'session.jsonl.zstd');
  const plain = join(sessionDir, 'session.jsonl');
  let text;
  if (existsSync(zstd)) {
    const buf = readFileSync(zstd);
    const parts = scanFrames(buf).map(([s, e]) => zstdDecompressSync(buf.subarray(s, e)).toString('utf8'));
    text = parts.join('');
  } else if (existsSync(plain)) {
    text = readFileSync(plain, 'utf8');
  } else {
    throw new Error(`no session log found in ${sessionDir}`);
  }
  return text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** 事件的实际消息负载：assistant/tool-result 在 data.message，user 直接 data。 */
function eventPayload(e) {
  return e.data?.message ?? e.data ?? {};
}

/** 从消息 content 块数组提取纯文本（支持 text / tool-result 嵌套 / 字符串）。 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text;
    if (b.type === 'tool-result') return blocksToText(b.content);
    return '';
  });
  return parts.filter(Boolean).join('\n');
}

/** 投影为可读对话（user/message、assistant/message，tool 调用可选标注）。 */
function toTranscript(events, showTools) {
  const out = [];
  let title = '';
  for (const e of events) {
    if (e.type === 'session/title') { title = e.title || e.data?.title || ''; }
    const p = eventPayload(e);
    if (e.type === 'user/message') {
      const c = blocksToText(p.content);
      if (c) out.push({ role: 'user', text: c });
    } else if (e.type === 'assistant/message') {
      const content = Array.isArray(p.content) ? p.content : [];
      const c = blocksToText(content.filter((b) => b?.type !== 'tool-call'));
      const calls = content.filter((b) => b?.type === 'tool-call')
        .map((b) => `${b.name}(${String(b.arguments ?? '').slice(0, 80)})`);
      const callNotes = showTools && calls.length ? `\n[tool_calls] ${calls.join('; ')}` : '';
      if (c || callNotes) out.push({ role: 'assistant', text: c + callNotes });
    } else if (e.type === 'tool/call' && showTools) {
      out.push({ role: 'tool', text: `[tool:${e.data?.name}] ${String(e.data?.arguments ?? '').slice(0, 160)}` });
    } else if (e.type === 'tool/result' && showTools) {
      out.push({ role: 'tool-result', text: truncate(blocksToText(p.content), 200) });
    }
  }
  return { title, out };
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function printText(title, msgs, limit) {
  if (title) console.log(`# ${title}\n`);
  msgs.slice(0, limit).forEach((m) => {
    const label = m.role === 'user' ? '🧑 用户' : m.role === 'assistant' ? '🤖 助手' : `🛠 ${m.role}`;
    console.log(`--- ${label} ---\n${m.text}\n`);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sessionId) {
    console.log(`用法: node dsh-read-session.mjs <session-id> [--workspace <关键字>] [--format text|jsonl|events] [--limit N]`);
    process.exit(args.help ? 0 : 1);
  }
  const id = normalizeId(args.sessionId);
  const sessionsRoot = join(args.dshHome, 'sessions');
  const dir = locateSessionDir(sessionsRoot, id, args.workspace);
  if (!dir) {
    console.error(`未找到会话 "${args.sessionId}"（id=${id}）。已搜索 ${sessionsRoot} 下全部工作区。`);
    console.error('提示：可加 --workspace <路径关键字>（如 voice_for_dsh）缩小范围。');
    process.exit(2);
  }
  console.error(`会话目录: ${dir}\n`);
  const events = loadEvents(dir);
  if (args.format === 'jsonl') { events.forEach((e) => console.log(JSON.stringify(e))); return; }
  if (args.format === 'events') {
    events.slice(0, args.limit).forEach((e) => console.log(`${e.seq ?? '?'}\t${e.type}`));
    return;
  }
  const { title, out } = toTranscript(events, true);
  printText(title, out, args.limit);
}

main();
