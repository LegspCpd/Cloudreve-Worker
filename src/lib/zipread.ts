/**
 * 极简 ZIP 读取器（只读）。为边缘版的解压 / 压缩包浏览实现。
 * 与 lib/zip.ts（打包器）配套。
 *
 * 设计约束（Cloudflare Workers）：
 *   - 内存 128MB 上限 → 绝不整包加载，通过调用方提供的 Range 读取器
 *     分段拉取 EOCD / 中央目录 / 条目数据；
 *   - 解压用运行时原生 `DecompressionStream('deflate-raw')`（store/deflate
 *     两种方法覆盖绝大多数 ZIP；加密条目直接报错，不支持传统 ZipCrypto）；
 *   - 不支持 ZIP64（>4GB / >65535 条目），遇到时抛明确错误。
 *
 * 结构与 PKWARE APPNOTE 6.3.x 对应：
 *   - EOCD      0x06054b50
 *   - 中央目录  0x02014b50
 *   - 本地头    0x04034b50
 */

import { AppError, CodeIOFailed, CodeUnsupportedArchiveType } from './errors';

/** 归档目录项的公共形状（zip / 7z 共用，浏览接口只依赖这四个字段）。 */
export interface ArchiveEntry {
  /** 完整相对路径 */
  name: string;
  /** 未压缩大小 */
  size: number;
  isDir: boolean;
  mtime: Date;
}

export interface ZipEntry extends ArchiveEntry {
  /** 原始文件名字节（供非 UTF-8 编码二次解码） */
  nameBytes: Uint8Array;
  compressedSize: number;
  /** 0=store 8=deflate */
  method: number;
  crc32: number;
  localHeaderOffset: number;
  /** 通用标志位（bit0 加密，bit11 UTF-8 名） */
  flags: number;
}

/**
 * 归档解析失败。
 *
 * 必须带 `CodeUnsupportedArchiveType` 交给上层：以前它是裸 `Error`，
 * `fail()` 把所有非 AppError 的异常一律当 `CodeDBError`，于是「这文件不是
 * zip」在前端渲染成「数据库操作失败 (End of central directory not found...)」
 * —— 用户看到的既不是真实原因，也误导排查方向。
 */
export class ZipError extends AppError {
  constructor(msg: string, raw?: unknown) {
    super(CodeUnsupportedArchiveType, msg, raw);
    this.name = 'ZipError';
  }
}

/** 读取归档字节时出的错（Range 读失败、存储后端异常）。走 50004 而不是格式错误。 */
export class ZipIOError extends AppError {
  constructor(msg: string, raw?: unknown) {
    super(CodeIOFailed, msg, raw);
    this.name = 'ZipIOError';
  }
}

/** 分段读取器：闭区间 [start, end] 字节。 */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function u32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

function dosDate(time: number, date: number): Date {
  const sec = (time & 0x1f) * 2;
  const min = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = 1980 + ((date >> 9) & 0x7f);
  const d = new Date(Date.UTC(year, month, day, hour, min, sec));
  return isNaN(d.getTime()) ? new Date(0) : d;
}

const EOCD_MIN = 22;
/** EOCD 最长尾部长度：注释最大 65535 + 固定 22 */
const EOCD_MAX_TAIL = EOCD_MIN + 65535;

/**
 * 定位并解析中央目录。`fileSize` 为整个 ZIP 的大小。
 * `decodeName` 可选：条目名未标 UTF-8 时用它解码（如 gbk）。
 */
export async function readCentralDirectory(
  read: RangeReader,
  fileSize: number,
  decodeName?: (bytes: Uint8Array) => string,
): Promise<ZipEntry[]> {
  if (fileSize < EOCD_MIN) throw new ZipError('File is too small to be a zip archive');

  const tailStart = Math.max(0, fileSize - EOCD_MAX_TAIL);
  const tail = await read(tailStart, fileSize - 1);

  // 从尾部向前扫 EOCD 魔数
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('End of central directory not found (not a zip file?)');

  const entryCount = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported');
  }

  if (cdOffset + cdSize > fileSize) {
    throw new ZipError('Corrupt central directory (offset out of range)');
  }

  const cd = await read(cdOffset, cdOffset + cdSize - 1);
  const entries: ZipEntry[] = [];
  let off = 0;
  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > cd.length || u32(cd, off) !== 0x02014b50) {
      throw new ZipError(`Corrupt central directory entry #${i}`);
    }
    const flags = u16(cd, off + 8);
    const method = u16(cd, off + 10);
    const mtime = dosDate(u16(cd, off + 12), u16(cd, off + 14));
    const crc32 = u32(cd, off + 16);
    const compressedSize = u32(cd, off + 20);
    const size = u32(cd, off + 24);
    const nameLen = u16(cd, off + 28);
    const extraLen = u16(cd, off + 30);
    const commentLen = u16(cd, off + 32);
    const localHeaderOffset = u32(cd, off + 42);
    const nameBytes = cd.slice(off + 46, off + 46 + nameLen);
    const utf8 = (flags & 0x800) !== 0;
    const name = utf8 || !decodeName
      ? new TextDecoder('utf-8').decode(nameBytes)
      : decodeName(nameBytes);
    const isDir = name.endsWith('/') || (flags & 0x10) !== 0;
    entries.push({
      name,
      nameBytes,
      isDir,
      size,
      compressedSize,
      method,
      crc32,
      localHeaderOffset,
      mtime,
      flags,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 读取并解压一个条目。调用方负责限制条目大小（防 zip bomb）。
 */
export async function readEntry(
  read: RangeReader,
  entry: ZipEntry,
): Promise<Uint8Array> {
  if (entry.flags & 0x1) {
    throw new ZipError(`Encrypted entry "${entry.name}" is not supported`);
  }

  // 本地文件头：30 字节固定 + 名字 + 额外字段。中央目录里的偏移指向它。
  const lfh = await read(entry.localHeaderOffset, entry.localHeaderOffset + 29);
  if (u32(lfh, 0) !== 0x04034b50) throw new ZipError('Bad local file header');
  const lfhNameLen = u16(lfh, 26);
  const lfhExtraLen = u16(lfh, 28);
  const dataStart = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;

  const raw = await read(dataStart, dataStart + entry.compressedSize - 1);

  if (entry.method === 0) {
    if (raw.length < entry.size) throw new ZipError('Stored entry truncated');
    return raw.length === entry.size ? raw : raw.slice(0, entry.size);
  }
  if (entry.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
    const out = new Uint8Array(entry.size);
    let filled = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.length > entry.size) {
        throw new ZipError('Inflated data exceeds declared size (possible zip bomb)');
      }
      out.set(value, filled);
      filled += value.length;
    }
    if (filled !== entry.size) throw new ZipError('Inflated size mismatch');
    return out;
  }
  throw new ZipError(`Unsupported compression method ${entry.method}`);
}

/**
 * 把 ZIP 条目名整理成安全路径段。拒绝绝对路径与 `..` 穿越；
 * 空段和 `.` 被去掉。非法返回 null。
 */
export function safeEntryPath(name: string): string[] | null {
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const segs: string[] = [];
  for (const seg of name.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    segs.push(seg);
  }
  if (!segs.length) return null;
  return segs;
}
