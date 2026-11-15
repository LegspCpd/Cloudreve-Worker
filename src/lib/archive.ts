/**
 * 归档格式总入口：按扩展名判定格式，再分派给对应的解析器。
 *
 * 各格式的能力边界（浏览 / 解压）：
 *
 *   格式         浏览   解压   说明
 *   zip           ✅     ✅    中央目录随机读
 *   7z            ✅     ❌    文件表压缩，需 LZMA 解；数据区编码器太多
 *   rar (4/5)     ✅     ❌    文件头明文，数据区是专有算法
 *   tar           ✅     ✅    512 字节头，Range 随机读
 *   tar.gz/tgz    ✅     ✅    边解压边解析，不整包进内存
 *   gz            ✅     ✅    单文件
 *   tar.bz2/tbz2  ❌     ❌    bzip2 解码器未实现
 *   tar.xz/txz    ❌     ❌    xz 容器 + 多过滤器，未实现
 *   bz2 / xz      ❌     ❌    同上
 *
 * 「不支持」必须抛 `ZipError`（→ 40056），不能是裸 Error —— 否则会被
 * `fail()` 判成数据库错误，前端显示「数据库操作失败 (xxx)」。
 */

import { ZipError, readCentralDirectory } from './zipread';
import type { ArchiveEntry, RangeReader } from './zipread';
import { readSevenZipDirectory } from './sevenzip';
import { readRarDirectory } from './rar';
import { parseTar, rangeByteSource, streamByteSource } from './tar';

export type { ArchiveEntry } from './zipread';
export {
  parseTar,
  walkTar,
  readTarEntry,
  rangeByteSource,
  streamByteSource,
} from './tar';
export type { TarEntry } from './tar';

export type ArchiveFormat =
  | 'zip'
  | '7z'
  | 'rar'
  | 'tar'
  | 'tar.gz'
  | 'gz'
  | 'tar.bz2'
  | 'bz2'
  | 'tar.xz'
  | 'xz';

/** 前端认的扩展名集合（决定「解压」菜单是否出现），这里保持一致并多认几个别名。 */
export function detectArchiveFormat(name: string): ArchiveFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') || lower.endsWith('.tbz')) {
    return 'tar.bz2';
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.bz2')) return 'bz2';
  if (lower.endsWith('.xz')) return 'xz';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.rar')) return 'rar';
  // 兜底按 ZIP 处理：.zip / .docx / .jar / .cbz / .apk 都是 zip 容器
  return 'zip';
}

/** 能随机读条目内容（解压）的格式。 */
export function canExtractFormat(fmt: ArchiveFormat): boolean {
  return fmt === 'zip' || fmt === 'tar' || fmt === 'tar.gz' || fmt === 'gz';
}

/** 浏览 / 解压都做不到时用这个文案，明确告诉用户下一步怎么做。 */
export function unsupportedMessage(fmt: ArchiveFormat): string {
  switch (fmt) {
    case '7z':
      return 'Browsing 7z is supported, but extracting it is not (missing BCJ/PPMd decoders in the edge runtime)';
    case 'rar':
      return 'Browsing RAR is supported, but extracting it is not (RAR uses a proprietary codec)';
    case 'tar.bz2':
    case 'bz2':
      return 'bzip2 compression is not supported on the edge runtime; download the file and extract locally';
    case 'tar.xz':
    case 'xz':
      return 'xz compression is not supported on the edge runtime; download the file and extract locally';
    default:
      return 'Unsupported archive format';
  }
}

/** 归档来源：既能按区间随机读，也能取整段流（gzip 家族顺序解压要用）。 */
export interface ArchiveSource {
  read: RangeReader;
  size: number;
  /** 整段字节流。加密策略下返回已解密的明文。 */
  openFull(): Promise<ReadableStream<Uint8Array>>;
}

function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function u32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

/** 去掉一层压缩后缀，作为单文件 gzip 的显示名。 */
function stripSuffix(name: string, suffix: string): string {
  return name.slice(0, name.length - suffix.length) || name;
}

/**
 * 读 gzip 头（可选 FNAME 原文件名、MTIME）与尾（ISIZE）。
 *
 * `.gz` 是单文件格式，没有目录结构，浏览时只能列出一条。原名优先取头里的
 * FNAME —— 压缩时保留了原始扩展名，比 `a.txt.gz` 去掉后缀更准。
 */
export async function readGzipEntry(
  src: ArchiveSource,
  displayName: string,
): Promise<ArchiveEntry> {
  if (src.size < 18) throw new ZipError('File is too small to be a gzip archive');
  const head = await src.read(0, Math.min(src.size, 4096) - 1);
  if (head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 8) {
    throw new ZipError('Not a gzip archive (bad magic or unsupported method)');
  }
  const flags = head[3]!;
  const mtime = u32(head, 4);

  let name: string | null = null;
  let pos = 10;
  if (flags & 0x04) {
    if (pos + 2 > head.length) pos = head.length;
    else pos += 2 + u16(head, pos);
  }
  if (flags & 0x08 && pos < head.length) {
    const end = head.indexOf(0, pos);
    if (end > pos) name = new TextDecoder('utf-8').decode(head.subarray(pos, end));
  }

  const tail = await src.read(src.size - 4, src.size - 1);
  const isize = tail.length >= 4 ? u32(tail, 0) : 0;
  return {
    name: name ?? stripSuffix(displayName, '.gz'),
    size: isize,
    isDir: false,
    mtime: mtime ? new Date(mtime * 1000) : new Date(0),
  };
}

/** gzip 解压流（Workers / EdgeOne 都提供 DecompressionStream）。 */
export function gunzip(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('gzip decompression is not available in this runtime');
  }
  return stream.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

/** 列出归档内容。`displayName` 只用于单文件 gzip 的显示名。 */
export async function listArchive(
  fmt: ArchiveFormat,
  src: ArchiveSource,
  opts: { displayName?: string; decodeName?: (b: Uint8Array) => string } = {},
): Promise<ArchiveEntry[]> {
  switch (fmt) {
    case 'zip':
      return readCentralDirectory(src.read, src.size, opts.decodeName);
    case '7z':
      return readSevenZipDirectory(src.read, src.size);
    case 'rar':
      return readRarDirectory(src.read, src.size);
    case 'tar':
      return parseTar(rangeByteSource(src.read, src.size));
    case 'tar.gz': {
      const stream = gunzip(await src.openFull());
      return parseTar(streamByteSource(stream));
    }
    case 'gz':
      return [await readGzipEntry(src, opts.displayName ?? 'archive.gz')];
    default:
      throw new ZipError(unsupportedMessage(fmt));
  }
}
