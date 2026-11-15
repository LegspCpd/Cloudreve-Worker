/**
 * RAR 目录读取器（只读，仅解析文件表）。
 *
 * 为什么只做列表、不做解压：RAR 的数据区是专有压缩算法（RAR3 的 PPMd/VM、
 * RAR5 的定制 LZ），没有可移植的解码器；把 unrar 的 C 代码搬进边缘包体
 * 不现实。但**文件头从不加密也不压缩**，所以「看清里面有什么」完全可以
 * 在边缘做，和 7z 的处理方式一致。
 *
 * 支持 RAR 4.x（签名 `Rar!\x1a\x07\x00`）与 RAR 5.x（`Rar!\x1a\x07\x01\x00`）。
 * 两种格式的头结构完全不同，分别解析。
 */

import { ZipError } from './zipread';
import type { ArchiveEntry, RangeReader } from './zipread';

const RAR4_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const RAR5_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

const MAX_ENTRIES = 100_000;
/** 单个头理论上可以带很长的名字；给个上限防止构造畸形文件拉爆内存。 */
const MAX_HEADER = 64 * 1024;
/**
 * Range 读取的滑动窗口。
 *
 * 每读一次 Range，存储驱动往往还要先查一次对象元信息（OneDrive 是 Graph
 * 的 fileInfo），所以「一个头一次读」在百来个条目的包上就是几百次请求，
 * 线上直接撞限流（实测 RAR 报上游不可用）。窗口把相邻头合并成一次读，
 * 小包通常一两次就能解完。
 */
const READ_WINDOW = 64 * 1024;

/** 带窗口缓存的 Range 读取器。顺序解析头部时几乎不重复发请求。 */
function windowedReader(
  read: RangeReader,
  fileSize: number,
): RangeReader {
  let start = 0;
  let buf: Uint8Array = new Uint8Array(0);
  return async (from, to) => {
    if (from >= start && to < start + buf.length) {
      return buf.subarray(from - start, to - start + 1);
    }
    const end = Math.min(fileSize, Math.max(to + 1, from + READ_WINDOW));
    const chunk = await read(from, end - 1);
    buf = chunk;
    start = from;
    const want = Math.min(to - from + 1, chunk.length);
    if (want <= 0) return chunk;
    return chunk.subarray(0, want);
  };
}

function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function u32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}
function u64(b: Uint8Array, off: number): number {
  const lo = u32(b, off);
  const hi = u32(b, off + 4);
  return hi * 0x1_0000_0000 + lo;
}

/** RAR 的 DOS 时间：日期在低 16 位、时间在高 16 位。 */
function dosTime(v: number): Date {
  const time = v & 0xffff;
  const date = (v >>> 16) & 0xffff;
  const sec = (time & 0x1f) * 2;
  const min = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = 1980 + ((date >> 9) & 0x7f);
  const d = new Date(Date.UTC(year, month, day, hour, min, sec));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * RAR3 的老式 unicode 文件名解码（unrar `EncodeFileName::Decode`）。
 *
 * 名字字段是「ANSI 段 + NUL + 编码段」：编码段每个字节是 4 位的标志，
 * 为 1 的位置后面跟两个字节的 UTF-16LE，为 0 的位置沿用 ANSI 段对应字符。
 * 只有 ANSI 段不是合法 UTF-8（典型是 GBK 打的包）时才走这里。
 */
function decodeRar3Unicode(bytes: Uint8Array): string | null {
  const zero = bytes.indexOf(0);
  if (zero <= 0 || zero + 1 >= bytes.length) return null;
  const ansi = bytes.subarray(0, zero);
  const enc = bytes.subarray(zero + 1);
  const out: number[] = [];
  for (const b of ansi) out.push(b);
  let decPos = ansi.length;
  let encPos = 0;
  while (encPos < enc.length) {
    const flags = enc[encPos]!;
    encPos += 1;
    for (let i = 0; i < 4 && encPos < enc.length; i += 1) {
      if (flags & (1 << i)) {
        if (encPos + 1 >= enc.length) return null;
        out.push(enc[encPos]! | (enc[encPos + 1]! << 8));
        encPos += 2;
      } else {
        out.push(ansi[decPos] ?? 0);
        decPos += 1;
      }
    }
  }
  if (!out.length) return null;
  return String.fromCharCode(...out);
}

/**
 * 文件名解码。
 *
 * RAR5 规定名字是 UTF-8；RAR4 视 `LHD_UNICODE(0x0200)` 标志可能带一段
 * unicode 编码后缀。策略：先按 UTF-8 解 ANSI 段，合法就用它（7-Zip 也是
 * 这个行为）；不合法再退回 RAR3 的 unicode 段；最后才 latin1 兜底。
 */
function decodeName(bytes: Uint8Array, unicodeFlag = false): string {
  let part = bytes;
  if (unicodeFlag) {
    const zero = bytes.indexOf(0);
    if (zero > 0) part = bytes.subarray(0, zero);
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(part);
  let text = utf8;
  if (utf8.includes('\uFFFD')) {
    if (unicodeFlag) {
      const alt = decodeRar3Unicode(bytes);
      if (alt && !alt.includes('\uFFFD')) text = alt;
    }
    if (text.includes('\uFFFD')) {
      text = Array.from(part, (b) => String.fromCharCode(b)).join('');
    }
  }
  return text.replace(/\\/g, '/');
}

/** 变长整数（RAR5）：每字节低 7 位是数据，最高位是续位。 */
function readVint(b: Uint8Array, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = off;
  for (;;) {
    if (pos >= b.length) throw new ZipError('Corrupt RAR5 header (truncated vint)');
    const byte = b[pos]!;
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new ZipError('Corrupt RAR5 header (vint too long)');
  }
  return { value, next: pos };
}

/**
 * 目录判定。
 *
 * RAR4 的 hostOs 取值：0=MS-DOS、1=OS/2、2=Win32、3=Unix；RAR5 只有 0=Windows、1=Unix。
 * Windows 系看 attr 的 FILE_ATTRIBUTE_DIRECTORY(0x10)，Unix 系看 mode 的 S_IFDIR(0x4000)。
 * 两边编号不同，不能混用 —— 曾因只判 0x10 导致 Unix 打的包目录全变成 0 字节文件。
 */
function isDirByAttr(
  hostOs: number,
  attr: number,
  name: string,
  unixHostOs: number,
): boolean {
  if (name.endsWith('/') || name.endsWith('\\')) return true;
  if (hostOs === unixHostOs) return (attr & 0xf000) === 0x4000;
  if (hostOs === 0 || hostOs === 2) return (attr & 0x10) !== 0;
  return false;
}

/** RAR 4.x 文件头解析。返回条目与「下一个块的位置」。 */
async function readRar4(
  read: RangeReader,
  fileSize: number,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let pos = RAR4_SIG.length;

  while (pos + 7 <= fileSize) {
    const short = await read(pos, pos + 6);
    if (short.length < 7) break;

    const type = short[2]!;
    const flags = u16(short, 3);
    const headSize = u16(short, 5);
    if (headSize < 7 || headSize > MAX_HEADER) break;
    if (pos + headSize > fileSize) break;

    // 主头 0x0080：头也加密了。文件名读不出来，别静默返回空列表。
    if (type === 0x73 && flags & 0x0080) {
      throw new ZipError('RAR headers are encrypted; a password is required');
    }

    // 0x8000：块带 ADD_SIZE，数据区长度由它给出（文件头里是完整 packed size）
    let addSize = 0;
    if (flags & 0x8000) {
      const tail = await read(pos + 7, pos + 10);
      if (tail.length < 4) break;
      addSize = u32(tail, 0);
    }

    if (type === 0x74) {
      const head = await read(pos, pos + headSize - 1);
      if (head.length < 32) break;
      const packSizeLow = u32(head, 7);
      const unpSizeLow = u32(head, 11);
      const hostOs = head[15]!;
      const ftime = u32(head, 20);
      const nameSize = u16(head, 26);
      const attr = u32(head, 28);

      let nameOff = 32;
      let packSize = packSizeLow;
      let unpSize = unpSizeLow;
      if (flags & 0x0100) {
        // LHD_LARGE：高 32 位存在
        if (head.length < 40) break;
        packSize = u32(head, 32) * 0x1_0000_0000 + packSizeLow;
        unpSize = u32(head, 36) * 0x1_0000_0000 + unpSizeLow;
        nameOff = 40;
      }
      if (nameOff + nameSize > head.length) break;

      const name = decodeName(head.subarray(nameOff, nameOff + nameSize), (flags & 0x0200) !== 0);
      const isDir = isDirByAttr(hostOs, attr, name, 3);
      if (entries.length >= MAX_ENTRIES) throw new ZipError('RAR has too many entries');
      entries.push({
        name,
        size: isDir ? 0 : unpSize,
        isDir,
        mtime: dosTime(ftime),
      });

      pos += headSize + (flags & 0x8000 ? addSize : packSize);
      continue;
    }

    // 其它块（主头、注释、恢复记录等）按声明的长度跳过
    pos += headSize + (flags & 0x8000 ? addSize : 0);
  }

  return entries;
}

/** RAR 5.x 文件头解析。 */
async function readRar5(read: RangeReader, fileSize: number): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let pos = RAR5_SIG.length;

  while (pos + 5 <= fileSize) {
    // 先取 4 字节 CRC + 足够解出 HEAD_SIZE 变长整数的窗口
    const window = await read(pos, Math.min(fileSize, pos + 40) - 1);
    if (window.length < 6) break;

    const headerSize = readVint(window, 4);
    const headerStart = pos + 4 + (headerSize.next - 4);
    const headerEnd = headerStart + headerSize.value;
    if (headerSize.value <= 0 || headerSize.value > MAX_HEADER || headerEnd > fileSize) break;

    const head = await read(headerStart, headerEnd - 1);
    let cursor = 0;
    const take = (): number => {
      const r = readVint(head, cursor);
      cursor = r.next;
      return r.value;
    };

    const type = take();
    const flags = take();
    if (flags & 0x0001) take(); // extra area size，用不上（直接按 headerEnd 跳过）
    const dataSize = flags & 0x0002 ? take() : 0;

    if (type === 5) break; // end of archive

    // type 4 是加密头：后面所有头都是密文，读不出文件名
    if (type === 4) {
      throw new ZipError('RAR headers are encrypted; a password is required');
    }

    if (type === 2) {
      const fileFlags = take();
      const unpSize = take();
      const attr = take();
      let mtime = new Date(0);
      if (fileFlags & 0x0002) {
        if (cursor + 4 > head.length) break;
        mtime = new Date(u32(head, cursor) * 1000);
        cursor += 4;
      }
      if (fileFlags & 0x0004) cursor += 4; // data CRC
      take(); // compression info
      const hostOs = take();
      const nameLen = take();
      if (cursor + nameLen > head.length) break;
      const name = decodeName(head.subarray(cursor, cursor + nameLen));
      const isDir = (fileFlags & 0x0001) !== 0 || isDirByAttr(hostOs, attr, name, 1);

      if (entries.length >= MAX_ENTRIES) throw new ZipError('RAR has too many entries');
      entries.push({
        name,
        size: isDir ? 0 : unpSize,
        isDir,
        mtime: Number.isNaN(mtime.getTime()) ? new Date(0) : mtime,
      });
    }

    pos = headerEnd + dataSize;
  }

  return entries;
}

/** 读 RAR 文件表。数据区一律跳过，不做解压。 */
export async function readRarDirectory(
  readIn: RangeReader,
  fileSize: number,
): Promise<ArchiveEntry[]> {
  if (fileSize < 8) throw new ZipError('File is too small to be a rar archive');
  const read = windowedReader(readIn, fileSize);
  const head = await read(0, Math.min(fileSize, 8) - 1);

  const isRar4 = RAR4_SIG.every((b, i) => head[i] === b);
  const isRar5 = RAR5_SIG.every((b, i) => head[i] === b);
  if (!isRar4 && !isRar5) throw new ZipError('Not a RAR archive (bad signature)');

  return isRar5 ? readRar5(read, fileSize) : readRar4(read, fileSize);
}
