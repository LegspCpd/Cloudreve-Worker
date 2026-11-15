/**
 * TAR 读取器（只读）。纯 tar 与 gzip 压缩的 tar 共用同一套头解析。
 *
 * 语义对齐 POSIX ustar / GNU tar：
 *   - 512 字节块，`size` 之后按 512 向上取整跳过数据
 *   - `prefix` + `name` 拼完整路径；GNU 长名（typeflag `L` / `K`）
 *   - pax 扩展头（typeflag `x`）里的 path / linkpath / size / mtime 覆盖
 *   - 连续两个全零块表示结束
 *
 * 两种数据来源：
 *   - `rangeByteSource`：纯 tar 走 Range 读，带滑动窗口，不会整包下载
 *   - `streamByteSource`：tar.gz 走解压流，顺序消费
 *
 * 与 zipread 一样，解析失败抛 `ZipError`（→ 40056），字节读取失败抛
 * `ZipIOError`（→ 50004），不要混。
 */

import { ZipError } from './zipread';
import type { ArchiveEntry, RangeReader } from './zipread';

/** tar 条目：比通用 ArchiveEntry 多一个数据偏移，纯 tar 可以按偏移随机读。 */
export interface TarEntry extends ArchiveEntry {
  /** 未压缩 tar 内的数据起始偏移；流式来源不可随机读，置 -1。 */
  dataOffset: number;
}

/** 顺序字节源。tar 解析只需要「读 n 字节 / 跳过 n 字节」。 */
export interface ByteSource {
  readExact(n: number): Promise<Uint8Array>;
  skip(n: number): Promise<void>;
}

const BLOCK = 512;
/** 单个 tar 头最多能带多长的名字（GNU / pax 长名上限）。 */
const MAX_LONG_NAME = 64 * 1024;

function isZeroBlock(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i += 1) if (b[i] !== 0) return false;
  return true;
}

/** 八进制字段。tar 允许前导空格、尾部 NUL/空格；也允许 base-256（首字节 0x80）。 */
function parseNumeric(field: Uint8Array): number {
  if (field.length === 0) return 0;
  if (field[0]! & 0x80) {
    // GNU base-256：大端，去掉最高位
    let v = 0;
    v = (field[0]! & 0x7f) * 0x1000000;
    for (let i = 1; i < field.length; i += 1) v = v * 256 + field[i]!;
    return v;
  }
  let i = 0;
  while (i < field.length && (field[i] === 0x20 || field[i] === 0)) i += 1;
  let v = 0;
  let seen = false;
  for (; i < field.length; i += 1) {
    const c = field[i]!;
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) break;
    v = v * 8 + (c - 0x30);
    seen = true;
  }
  return seen ? v : 0;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 取以 NUL 结尾的字符串字段。 */
function cstr(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decodeUtf8(end < 0 ? bytes : bytes.subarray(0, end));
}

/** 校验头和：把 chksum 字段当 8 个空格算。无符号与有符号两种历史实现都认。 */
function checksumOk(block: Uint8Array, expected: number): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return expected === unsigned || expected === signed;
}

function decodeOctalOrThrow(block: Uint8Array, label: string): number {
  const v = parseNumeric(block.subarray(148, 156));
  if (!checksumOk(block, v)) throw new ZipError(`Corrupt tar header (${label} checksum mismatch)`);
  return v;
}

function pad512(n: number): number {
  return Math.ceil(n / BLOCK) * BLOCK;
}

interface PaxAttrs {
  path?: string;
  linkpath?: string;
  size?: number;
  mtime?: number;
}

/** pax 记录格式：`<总长> <key>=<value>\n`，总长含自身。 */
function parsePax(data: Uint8Array): PaxAttrs {
  const out: PaxAttrs = {};
  const text = decodeUtf8(data);
  let pos = 0;
  while (pos < text.length) {
    const sp = text.indexOf(' ', pos);
    if (sp < 0) break;
    const len = Number.parseInt(text.slice(pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, pos + len - 1); // 去掉结尾 \n
    const eq = record.indexOf('=');
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === 'path') out.path = value;
      else if (key === 'linkpath') out.linkpath = value;
      else if (key === 'size') {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) out.size = n;
      } else if (key === 'mtime') {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) out.mtime = n;
      }
    }
    pos += len;
  }
  return out;
}

/**
 * 单个条目的数据访问器。两种用法二选一：
 *   - `read()`：整体读进内存（≤ 条目大小上限）
 *   - `stream()`：有界流，边解压边落盘，不占内存
 *
 * 无论哪种，**调用方必须把 size 字节读完**（`stream()` 交给上传服务后会
 * 被读完）。遍历器按「已消费的字节」对齐到下一个块。
 */
export interface TarEntryData {
  size: number;
  read(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
}

/**
 * 顺序遍历 tar，逐条交给 `onEntry`，本身不收集条目。
 *
 * 解压用它（边读边写），浏览用 `parseTar`（收集成数组）。两者共用同一套
 * 头解析，避免出现「能列出但解不开」的分裂行为。
 */
export async function walkTar(
  src: ByteSource,
  onEntry: (entry: TarEntry, data: TarEntryData) => Promise<void>,
  opts: { maxEntries?: number } = {},
): Promise<number> {
  const maxEntries = opts.maxEntries ?? 100_000;
  let count = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: PaxAttrs | null = null;
  let offset = 0;

  for (;;) {
    let block: Uint8Array;
    try {
      block = await src.readExact(BLOCK);
    } catch {
      // 流的末尾正好在块边界上：按正常结束处理
      break;
    }
    if (isZeroBlock(block)) break;

    const typeByte = block[156] ?? 0;
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    decodeOctalOrThrow(block, `entry #${count}`);
    let size = parseNumeric(block.subarray(124, 136));
    const mtimeSec = parseNumeric(block.subarray(136, 148));

    // 头里的名字：ustar 的 prefix 在前
    const nameField = cstr(block.subarray(0, 100));
    const magic = decodeUtf8(block.subarray(257, 263));
    const prefix = magic.startsWith('ustar') ? cstr(block.subarray(345, 500)) : '';
    const rawName = prefix ? `${prefix}/${nameField}` : nameField;

    const dataOffset = offset + BLOCK;
    offset += BLOCK;

    // 元数据条目：读完内容再继续，本身不出现在结果里
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (size > MAX_LONG_NAME) throw new ZipError('Tar metadata block is too large');
      const data = size > 0 ? await src.readExact(size) : new Uint8Array(0);
      const skip = pad512(size) - size;
      if (skip > 0) await src.skip(skip);
      offset += pad512(size);
      if (type === 'L') longName = cstr(data);
      else if (type === 'K') longLink = cstr(data);
      else if (type === 'x') pax = parsePax(data);
      // 'g'（全局 pax）只跳过
      continue;
    }

    // 全局 pax 可能改了 size / path，对紧随其后的条目生效
    if (pax?.size !== undefined) size = pax.size;
    // 归档里实际有多少数据字节，按它对齐到下一个块（目录/链接是 0）
    const dataBytes = size;

    let name = pax?.path ?? longName ?? rawName;
    const linkName = pax?.linkpath ?? longLink ?? cstr(block.subarray(157, 257));

    name = name.replace(/\\/g, '/');
    const isDir = type === '5' || name.endsWith('/');
    // 目录名去掉尾斜杠：与 7z / 浏览接口的其它格式保持一致的显示形态
    if (isDir) name = name.replace(/\/+$/, '');
    const mtime = pax?.mtime !== undefined ? new Date(pax.mtime * 1000) : new Date(mtimeSec * 1000);

    // 卷标（'V'）没有数据区也没名字意义，直接跳过
    if (type !== 'V' && name.length > 0) {
      if (count >= maxEntries) {
        throw new ZipError(`Tar archive has more than ${maxEntries} entries`);
      }
      count += 1;
      // 硬链接的数据不在本条目里，展示成 0 字节
      const shownSize = isDir || (linkName && type === '1') ? 0 : dataBytes;
      const entry: TarEntry = {
        name,
        size: shownSize,
        isDir,
        mtime: Number.isNaN(mtime.getTime()) ? new Date(0) : mtime,
        dataOffset: isDir ? -1 : dataOffset,
      };

      let consumed = 0;
      const data: TarEntryData = {
        size: entry.size,
        read: async () => {
          const bytes = entry.size > 0 ? await src.readExact(entry.size) : new Uint8Array(0);
          consumed = entry.size;
          return bytes;
        },
        stream: () => {
          // 有界流消费多少由上传服务决定，但它会把 size 字节读完（读少了会抛）
          consumed = entry.size;
          return limitedStream(src, entry.size);
        },
      };
      await onEntry(entry, data);

      // 调用方没读的字节 + 512 对齐的填充，一起跳掉
      const pad = pad512(dataBytes) - dataBytes;
      const left = dataBytes - consumed + pad;
      if (left > 0) await src.skip(left);
      if (dataBytes > 0) offset += pad512(dataBytes);
    } else if (dataBytes > 0) {
      const padded = pad512(dataBytes);
      await src.skip(padded);
      offset += padded;
    }

    longName = null;
    longLink = null;
    pax = null;
  }

  return count;
}

/**
 * 解析 tar 目录。
 *
 * `maxEntries` 防「一个 tar 里塞几十万条目」把内存打满；超了直接报错而不是
 * 静默截断（截断会让用户以为归档少了文件）。
 */
export async function parseTar(
  src: ByteSource,
  opts: { maxEntries?: number } = {},
): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  await walkTar(src, async (entry) => {
    entries.push(entry);
  }, opts);
  return entries;
}

/** 按偏移读纯 tar 的条目内容（调用方负责大小上限）。 */
export async function readTarEntry(
  read: RangeReader,
  entry: TarEntry,
): Promise<Uint8Array> {
  if (entry.size === 0) return new Uint8Array(0);
  if (entry.dataOffset < 0) throw new ZipError('Tar entry has no random access offset');
  return read(entry.dataOffset, entry.dataOffset + entry.size - 1);
}

/**
 * Range 字节源：按需开窗读取，窗口内多次解析不重复发请求。
 *
 * 纯 tar 的好处是「跳过大文件数据」只动游标，不发请求 —— 一个 1GB 的 tar
 * 里只有几十个条目时，读的仍然只是那几十个 512 字节头所在的窗口。
 */
export function rangeByteSource(
  read: RangeReader,
  fileSize: number,
  windowSize = 256 * 1024,
): ByteSource {
  let pos = 0;
  let winStart = 0;
  let win: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  const ensure = async (n: number): Promise<void> => {
    if (n <= 0) return;
    if (pos + n > fileSize) throw new ZipError('Unexpected end of tar archive');
    if (pos >= winStart && pos + n <= winStart + win.length) return;
    const end = Math.min(fileSize, pos + Math.max(windowSize, n));
    const chunk = await read(pos, end - 1);
    if (chunk.length < n) throw new ZipError('Unexpected end of tar archive (short read)');
    winStart = pos;
    win = chunk;
  };

  return {
    async readExact(n) {
      await ensure(n);
      const off = pos - winStart;
      const out = win.subarray(off, off + n);
      pos += n;
      return out;
    },
    async skip(n) {
      if (n <= 0) return;
      if (pos + n > fileSize) throw new ZipError('Unexpected end of tar archive');
      pos += n;
    },
  };
}

/** 流字节源：tar.gz 用，按需从解压流里取，不缓存整包。 */
export function streamByteSource(stream: ReadableStream<Uint8Array>): ByteSource {
  const reader = stream.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let pos = 0;

  const fill = async (n: number): Promise<void> => {
    while (pending.length - pos < n) {
      const { done, value } = await reader.read();
      if (done) {
        throw new ZipError('Unexpected end of gzip stream');
      }
      if (!value || value.length === 0) continue;
      const rest = pending.subarray(pos);
      const merged = new Uint8Array(rest.length + value.length);
      merged.set(rest, 0);
      merged.set(value, rest.length);
      pending = merged;
      pos = 0;
    }
  };

  return {
    async readExact(n) {
      if (n <= 0) return new Uint8Array(0);
      await fill(n);
      const out = pending.subarray(pos, pos + n);
      pos += n;
      return out;
    },
    async skip(n) {
      if (n <= 0) return;
      pos += n;
      if (pos > pending.length) {
        // 允许跨过已缓冲部分：把多余的从流里丢掉
        let left = pos - pending.length;
        pending = new Uint8Array(0);
        pos = 0;
        while (left > 0) {
          const { done, value } = await reader.read();
          if (done) throw new ZipError('Unexpected end of gzip stream');
          if (!value || value.length === 0) continue;
          if (value.length <= left) {
            left -= value.length;
          } else {
            pending = value.subarray(left);
            pos = 0;
            left = 0;
          }
        }
      }
    },
  };
}

/**
 * 把字节源的一段包成有界流，交给上传服务。
 *
 * 用于 tar.gz 边解压边落盘：条目数据不整体进内存，`writeToUri` 读多少我们
 * 就从解压流里拿多少。
 */
export function limitedStream(src: ByteSource, size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left <= 0) {
        controller.close();
        return;
      }
      try {
        const chunk = await src.readExact(Math.min(left, 64 * 1024));
        left -= chunk.length;
        controller.enqueue(chunk);
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
