//#region dsh-plugin-voice — 本地模型清单（版本 / 来源 / 体积 / 校验）
/**
 * 本地 Kokoro 模型的唯一清单：下载地址、归档字节数与 sha256、解包后关键文件大小。
 *
 * 为什么清单自带、而不是下载时读官方 checksum.txt：
 * 上游 2026-10-26 重传过这批包，官方 checksum.txt 没跟着更新（写的是 a3f4c73d…，
 * 实际全部字节是 b78e1ac4…）。运行时读它，会把"上游换了文件"误报成"我下载坏了"，
 * 反过来也会把真的换了文件当成正常。清单钉在本文件里，升级 = 改这一处。
 *
 * 文件大小是解包后的真实字节数（`tar -tvjf` 逐个量的），用于复核"解包完整"：
 * 归档 sha256 对上以后它几乎不会变，是第二道网（防止解包中途失败留下半截文件）。
 */
export const MODEL_MANIFEST = {
  /** 模型目录名（同时是解包后 tar 里的顶层目录名）。 */
  version: 'kokoro-multi-lang-v1_1',
  /** 界面上显示的版本号。 */
  displayVersion: 'v1.1',
  /** 界面上显示的来源（说人话，不带 URL 细节）。 */
  sourceLabel: 'GitHub · k2-fsa/sherpa-onnx 发布页',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
  /** 归档（tar.bz2）字节数：348MB。 */
  archiveBytes: 364855331,
  /** 归档 sha256（实测值，不是官方 checksum.txt 里那个）。 */
  archiveSha256: 'b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed',
  /** 解包后总字节数（406.8MB，界面上写 407MB）。 */
  extractedBytes: 426584734,
  /** 解包后必须存在、且字节数对得上的关键文件。 */
  keyFiles: [
    { name: 'model.onnx', bytes: 325561476, note: '声学模型' },
    { name: 'voices.bin', bytes: 53790720, note: '103 个音色' },
    { name: 'tokens.txt', bytes: 1111, note: '音素表' },
    { name: 'lexicon-us-en.txt', bytes: 5956885, note: '英文词典' },
    { name: 'lexicon-zh.txt', bytes: 2120131, note: '中文词典' },
    { name: 'date-zh.fst', bytes: 59154, note: '中文日期规则' },
    { name: 'number-zh.fst', bytes: 64482, note: '中文数字规则' },
    { name: 'phone-zh.fst', bytes: 88630, note: '中文电话号码规则' },
    { name: 'espeak-ng-data', dir: true, note: 'espeak 回退数据' },
  ],
}

/** 人类可读的体积（按 MiB/GiB 算，界面上不再出现裸字节数）。 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0MB'
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + 'GB'
  const mib = n / 1024 ** 2
  if (mib >= 100) return Math.round(mib) + 'MB'
  if (mib >= 1) return mib.toFixed(1).replace(/\.0$/, '') + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}
//#endregion
