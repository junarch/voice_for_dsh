#!/usr/bin/env node
/**
 * 从 DSH 桌面版 app.asar 里**只读**导出指定 @deepseek-ai 包的源码/类型，
 * 供"inspect first"核对上游真实 API（upstream 代码只读，绝不修改安装目录）。
 *
 * 用法（仓库根目录）：
 *   node scripts/dsh-inspect-extract.mjs <输出目录> [包名…]
 *   # 不给包名 = 导出全部 @deepseek-ai 包（约 40MB，慢）
 *   node scripts/dsh-inspect-extract.mjs .tmp-dsh-ref dsh-settings dsh-config-editor
 *
 * 默认导出到 .tmp-dsh-ref/（见 .gitignore，不入库）。找不到安装目录时用 DSH_INSTALL_DIR 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

const installDir = process.env.DSH_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const asarPath = process.env.DSH_ASAR || path.join(installDir, 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.error('[dsh-inspect-extract] 找不到 app.asar：' + asarPath + '（可用 DSH_ASAR 指定完整路径）');
  process.exit(1);
}
const outRoot = process.argv[2] || '.tmp-dsh-ref';
const wanted = process.argv.slice(3);

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerJsonSize = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerJsonSize);
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const dataOffset = 16 + headerJsonSize;

function walk(node, prefix, cb) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, cb);
    else cb(p, entry);
  }
}

let count = 0;
let bytes = 0;
walk(header, '', (p, entry) => {
  if (!p.startsWith('dsh/node_modules/@deepseek-ai/')) return;
  const rel = p.slice('dsh/node_modules/'.length);
  const pkg = rel.split('/')[1];
  if (wanted.length && !wanted.includes(pkg)) return;
  const dest = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(entry.size);
  if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
  fs.writeFileSync(dest, buf);
  count += 1;
  bytes += entry.size;
});
fs.closeSync(fd);
console.log(`extracted ${count} files, ${(bytes / 1048576).toFixed(1)} MiB -> ${outRoot}`);
