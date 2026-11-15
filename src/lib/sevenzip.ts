/**
 * 7z 只读目录解析。只为「浏览压缩包内容」服务，不负责解压数据。
 *
 * 为什么不能像 ZIP 那样直接跳中央目录：7z 的文件表（Header）本身通常是
 * 压缩的（kEncodedHeader，LZMA / LZMA2），必须先把这段解码出来才能读到
 * 文件名和大小。所以这里带了一个最小的 LZMA / LZMA2 解码器。
 *
 * 支持范围（覆盖 7-Zip 的默认产物）：
 *   - 未压缩 Header（kHeader）
 *   - 压缩 Header（kEncodedHeader）里的单 folder / 单 coder / 单 packed stream
 *   - 编解码器：Copy(00)、LZMA(030101)、LZMA2(21)
 *   - 文件名、大小、修改时间、目录位（kEmptyStream/kEmptyFile/kName/kMTime/kWinAttributes）
 *
 * 明确不支持（会抛 ZipError）：BCJ/BCJ2/Delta/PPMd 等滤镜链、外部名字/时间、
 * 多 folder 的编码头、AES 加密（7z 的加密连文件名都看不到）。
 *
 * 与 zipread.ts 一样，全部通过调用方给的 RangeReader 分段读取，绝不整包加载。
 */

import { ZipError, type ArchiveEntry, type RangeReader } from './zipread';

// ---------------------------------------------------------------------------
// 7z 常量（7zFormat.txt）
// ---------------------------------------------------------------------------

const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

const kEnd = 0x00;
const kHeader = 0x01;
const kArchiveProperties = 0x02;
const kAdditionalStreamsInfo = 0x03;
const kMainStreamsInfo = 0x04;
const kFilesInfo = 0x05;
const kPackInfo = 0x06;
const kUnpackInfo = 0x07;
const kSubStreamsInfo = 0x08;
const kSize = 0x09;
const kCRC = 0x0a;
const kFolder = 0x0b;
const kCodersUnpackSize = 0x0c;
const kNumUnpackStream = 0x0d;
const kEmptyStream = 0x0e;
const kEmptyFile = 0x0f;
const kName = 0x11;
const kMTime = 0x14;
const kWinAttributes = 0x15;
const kEncodedHeader = 0x17;

/** 解码后的文件表上限。真实 7z 的文件表远小于这个数（十万个文件也就几 MB）。 */
const MAX_HEADER_BYTES = 32 * 1024 * 1024;
/** 目录项数量上限，防构造文件把内存打满。 */
const MAX_ENTRIES = 200_000;

// ---------------------------------------------------------------------------
// 字节游标
// ---------------------------------------------------------------------------

class Cursor {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
  ) {}

  u8(): number {
    if (this.pos >= this.buf.length) throw new ZipError('Truncated 7z header');
    return this.buf[this.pos++]!;
  }

  u32(): number {
    const { buf, pos } = this;
    if (pos + 4 > buf.length) throw new ZipError('Truncated 7z header');
    this.pos = pos + 4;
    return (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;
  }

  /** 定长 u64（小端）。只有签名头里的偏移/长度用它。 */
  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    if (hi > 0x1f_ffff) throw new ZipError('7z value out of range');
    return hi * 0x1_0000_0000 + lo;
  }

  /**
   * 7z 的变长整数（spec 里的 NUMBER）：首字节高位是「后面还有几个字节」的
   * 标志，剩下的低位是数值的最高段。文件表里所有计数/尺寸/偏移都是这种编码，
   * 按定长 u64 读会直接把结构读串。
   */
  num(): number {
    const first = this.u8();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i += 1) {
      if ((first & mask) === 0) {
        return value + (first & (mask - 1)) * 2 ** (8 * i);
      }
      value += this.u8() * 2 ** (8 * i);
      mask >>= 1;
    }
    throw new ZipError('Corrupt 7z number');
  }

  /** 文件时间（FILETIME）必须精确到 100ns 量级，用 BigInt 读。 */
  u64big(): bigint {
    const lo = this.u32();
    const hi = this.u32();
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new ZipError('Truncated 7z header');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    if (this.pos + n > this.buf.length) throw new ZipError('Truncated 7z header');
    this.pos += n;
  }
}

/** 7z 的位向量是 MSB 优先，每个 bit 对应一个条目。 */
function readBitVector(c: Cursor, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let mask = 0;
  let cur = 0;
  for (let i = 0; i < count; i += 1) {
    if (mask === 0) {
      cur = c.u8();
      mask = 0x80;
    }
    out[i] = cur & mask ? 1 : 0;
    mask >>= 1;
  }
  return out;
}

function countOnes(v: Uint8Array | null): number {
  if (!v) return 0;
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i]!;
  return n;
}

function utf16leToString(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i + 1 < end; i += 2) s += String.fromCharCode(b[i]! | (b[i + 1]! << 8));
  return s;
}

/** Windows FILETIME（1601-01-01 起的 100ns 数）转 Date。 */
function filetimeToDate(ft: bigint): Date {
  if (ft === 0n) return new Date(0);
  const ms = Number(ft / 10_000n) - 11_644_473_600_000;
  return Number.isFinite(ms) ? new Date(ms) : new Date(0);
}

// ---------------------------------------------------------------------------
// LZMA 区间解码器
// ---------------------------------------------------------------------------

const kNumStates = 12;
const kNumPosBitsMax = 4;
const kNumPosStatesMax = 1 << kNumPosBitsMax;
const kNumLenToPosStates = 4;
const kNumPosSlotBits = 6;
const kNumAlignBits = 4;
/** SpecPos 概率表长度：1 + kNumFullDistances - kEndPosModelIndex */
const kSpecPosSize = 115;

class RangeDecoder {
  private range = 0xffff_ffff;
  private code = 0;
  private pos: number;

  constructor(private readonly buf: Uint8Array) {
    if (buf.length < 5) throw new ZipError('Corrupt 7z LZMA stream');
    // 规范：首字节恒为 0，随后 4 字节是大端初始 code。
    this.code = ((buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!) >>> 0;
    this.pos = 5;
  }

  private next(): number {
    if (this.pos >= this.buf.length) throw new ZipError('Truncated 7z LZMA stream');
    return this.buf[this.pos++]!;
  }

  bit(probs: Uint16Array, i: number): number {
    const prob = probs[i]!;
    const bound = (this.range >>> 11) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = prob + ((2048 - prob) >>> 5);
      bit = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = prob - (prob >>> 5);
      bit = 1;
    }
    if (this.range < 0x100_0000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
    return bit;
  }

  directBits(n: number): number {
    let res = 0;
    for (let i = 0; i < n; i += 1) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code = (this.code - this.range) >>> 0;
        bit = 1;
      }
      res = res * 2 + bit;
      if (this.range < 0x100_0000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.next()) >>> 0;
      }
    }
    return res;
  }
}

/** 正向位树：索引从 1 开始，返回去掉高位 1 后的符号。 */
function decodeBitTree(rc: RangeDecoder, probs: Uint16Array, bits: number): number {
  let m = 1;
  for (let i = 0; i < bits; i += 1) m = (m << 1) + rc.bit(probs, m);
  return m - (1 << bits);
}

/** 反向位树：offset 用于 SpecPos 这类「共享一张表，按前缀偏移」的用法。 */
function decodeReverseBitTree(
  rc: RangeDecoder,
  probs: Uint16Array,
  bits: number,
  offset: number,
): number {
  let m = 1;
  let symbol = 0;
  for (let i = 0; i < bits; i += 1) {
    const bit = rc.bit(probs, offset + m);
    m = (m << 1) + bit;
    symbol |= bit << i;
  }
  return symbol;
}

interface LenProbs {
  choice: Uint16Array;
  low: Uint16Array[];
  mid: Uint16Array[];
  high: Uint16Array;
}

function newLenProbs(): LenProbs {
  const table = (): Uint16Array[] =>
    Array.from({ length: kNumPosStatesMax }, () => new Uint16Array(8).fill(1024));
  return {
    choice: new Uint16Array(2).fill(1024),
    low: table(),
    mid: table(),
    high: new Uint16Array(256).fill(1024),
  };
}

function decodeLen(rc: RangeDecoder, probs: LenProbs, posState: number): number {
  if (rc.bit(probs.choice, 0) === 0) return decodeBitTree(rc, probs.low[posState]!, 3);
  if (rc.bit(probs.choice, 1) === 0) return 8 + decodeBitTree(rc, probs.mid[posState]!, 3);
  return 16 + decodeBitTree(rc, probs.high, 8);
}

/**
 * LZMA 解码状态机。一个实例对应一段连续的概率/状态上下文；
 * LZMA2 的 chunk 之间若没有 state reset 就要复用同一个实例。
 */
class LzmaDecoder {
  private readonly isMatch = new Uint16Array(kNumStates << kNumPosBitsMax).fill(1024);
  private readonly isRep = new Uint16Array(kNumStates).fill(1024);
  private readonly isRepG0 = new Uint16Array(kNumStates).fill(1024);
  private readonly isRepG1 = new Uint16Array(kNumStates).fill(1024);
  private readonly isRepG2 = new Uint16Array(kNumStates).fill(1024);
  private readonly isRep0Long = new Uint16Array(kNumStates << kNumPosBitsMax).fill(1024);
  private readonly posSlot = Array.from({ length: kNumLenToPosStates }, () =>
    new Uint16Array(1 << kNumPosSlotBits).fill(1024),
  );
  private readonly specPos = new Uint16Array(kSpecPosSize).fill(1024);
  private readonly align = new Uint16Array(1 << kNumAlignBits).fill(1024);
  private readonly lenProbs = newLenProbs();
  private readonly repLenProbs = newLenProbs();
  private readonly literal: Uint16Array;

  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;

  constructor(
    private readonly lc: number,
    private readonly lp: number,
    private readonly pb: number,
  ) {
    this.literal = new Uint16Array(0x300 << (lc + lp)).fill(1024);
  }

  /**
   * 把 [start, end) 区间解出来写进 `out`。
   *
   * `out` 是整块输出缓冲，`start` 是这一段的绝对起点：LZMA2 的后续 chunk
   * 要靠「绝对位置」才能正确回引前面 chunk 写下的字节。
   */
  decode(rc: RangeDecoder, out: Uint8Array, start: number, end: number): void {
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    let pos = start;

    while (pos < end) {
      const posState = pos & pbMask;
      if (rc.bit(this.isMatch, (this.state << kNumPosBitsMax) + posState) === 0) {
        // 字面量
        const prev = pos > 0 ? out[pos - 1]! : 0;
        const base = 0x300 * (((pos & lpMask) << this.lc) + (prev >>> (8 - this.lc)));
        if (this.state < 7) {
          let symbol = 1;
          while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literal, base + symbol);
          out[pos++] = symbol & 0xff;
        } else {
          // 匹配之后的字面量：用 matchByte 的前缀位做上下文，压缩率更高
          let matchByte = out[pos - this.rep0 - 1]!;
          let symbol = 1;
          for (;;) {
            const matchBit = (matchByte >> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const bit = rc.bit(this.literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) {
              while (symbol < 0x100) {
                symbol = (symbol << 1) | rc.bit(this.literal, base + symbol);
              }
              break;
            }
            if (symbol >= 0x100) break;
          }
          out[pos++] = symbol & 0xff;
        }
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }

      let len: number;
      if (rc.bit(this.isRep, this.state) === 1) {
        if (pos === 0) throw new ZipError('Corrupt 7z LZMA stream');
        if (rc.bit(this.isRepG0, this.state) === 0) {
          if (rc.bit(this.isRep0Long, (this.state << kNumPosBitsMax) + posState) === 0) {
            // 单字节重复
            this.state = this.state < 7 ? 9 : 11;
            out[pos] = out[pos - this.rep0 - 1]!;
            pos += 1;
            continue;
          }
        } else {
          let distance: number;
          if (rc.bit(this.isRepG1, this.state) === 0) {
            distance = this.rep1;
          } else {
            if (rc.bit(this.isRepG2, this.state) === 0) {
              distance = this.rep2;
            } else {
              distance = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = distance;
        }
        len = decodeLen(rc, this.repLenProbs, posState) + 2;
        this.state = this.state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = decodeLen(rc, this.lenProbs, posState) + 2;
        this.state = this.state < 7 ? 7 : 10;

        // 距离：短距离直接编码，长距离拆成「高位 + 低位反向树」
        const lenState = len - 2 < kNumLenToPosStates - 1 ? len - 2 : kNumLenToPosStates - 1;
        const posSlot = decodeBitTree(rc, this.posSlot[lenState]!, kNumPosSlotBits);
        let dist: number;
        if (posSlot >= 4) {
          const numDirect = (posSlot >> 1) - 1;
          dist = (2 | (posSlot & 1)) * 2 ** numDirect;
          if (posSlot < 14) {
            dist += decodeReverseBitTree(rc, this.specPos, numDirect, dist - posSlot);
          } else {
            dist += rc.directBits(numDirect - kNumAlignBits) * (1 << kNumAlignBits);
            dist += decodeReverseBitTree(rc, this.align, kNumAlignBits, 0);
          }
        } else {
          dist = posSlot;
        }
        this.rep0 = dist;
      }

      if (this.rep0 >= pos || this.rep0 < 0) throw new ZipError('Corrupt 7z LZMA stream');
      if (pos + len > end) throw new ZipError('Corrupt 7z LZMA stream');
      const from = pos - this.rep0 - 1;
      for (let i = 0; i < len; i += 1) out[pos + i] = out[from + i]!;
      pos += len;
    }
  }
}

interface LzmaProps {
  lc: number;
  lp: number;
  pb: number;
}

function parseLzmaProps(p: Uint8Array): LzmaProps {
  if (p.length < 5) throw new ZipError('Corrupt 7z LZMA properties');
  const d = p[0]!;
  if (d >= 225) throw new ZipError('Corrupt 7z LZMA properties');
  const lc = d % 9;
  const rest = Math.floor(d / 9);
  const lp = rest % 5;
  const pb = Math.floor(rest / 5);
  if (lc + lp > 12) throw new ZipError('Unsupported 7z LZMA properties');
  return { lc, lp, pb };
}

function lzmaDecode(props: LzmaProps, input: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  new LzmaDecoder(props.lc, props.lp, props.pb).decode(new RangeDecoder(input), out, 0, outSize);
  return out;
}

/** LZMA2 = 带 chunk 分帧的 LZMA，允许 chunk 内混未压缩块。 */
function lzma2Decode(props: Uint8Array, input: Uint8Array, outSize: number): Uint8Array {
  if (props.length < 1) throw new ZipError('Corrupt 7z LZMA2 properties');
  const d = props[0]!;
  if (d >= 225) throw new ZipError('Corrupt 7z LZMA2 properties');
  const defLc = d % 9;
  const r0 = Math.floor(d / 9);
  const defLp = r0 % 5;
  const defPb = Math.floor(r0 / 5);
  if (defLc + defLp > 12) throw new ZipError('Unsupported 7z LZMA2 properties');

  const out = new Uint8Array(outSize);
  let inPos = 0;
  let outPos = 0;
  let dec: LzmaDecoder | null = null;

  for (;;) {
    if (inPos >= input.length) throw new ZipError('Truncated 7z LZMA2 stream');
    const control = input[inPos++]!;
    if (control === 0) break;

    if (control === 1 || control === 2) {
      if (inPos + 2 > input.length) throw new ZipError('Truncated 7z LZMA2 stream');
      const size = ((input[inPos]! << 8) | input[inPos + 1]!) + 1;
      inPos += 2;
      if (inPos + size > input.length || outPos + size > outSize) {
        throw new ZipError('Corrupt 7z LZMA2 stream');
      }
      out.set(input.subarray(inPos, inPos + size), outPos);
      inPos += size;
      outPos += size;
      continue;
    }

    if (control < 0x80) throw new ZipError('Corrupt 7z LZMA2 stream');
    if (inPos + 4 > input.length) throw new ZipError('Truncated 7z LZMA2 stream');
    const unpackSize = ((control & 0x1f) << 16) + ((input[inPos]! << 8) | input[inPos + 1]!) + 1;
    const packSize = ((input[inPos + 2]! << 8) | input[inPos + 3]!) + 1;
    inPos += 4;

    if (control & 0x20) {
      // state reset：新 chunk 带自己的 lc/lp/pb
      if (inPos >= input.length) throw new ZipError('Truncated 7z LZMA2 stream');
      const p = input[inPos++]!;
      if (p >= 225) throw new ZipError('Corrupt 7z LZMA2 properties');
      const lc = p % 9;
      const r = Math.floor(p / 9);
      const lp = r % 5;
      const pb = Math.floor(r / 5);
      if (lc + lp > 12) throw new ZipError('Unsupported 7z LZMA2 properties');
      dec = new LzmaDecoder(lc, lp, pb);
    } else if (!dec) {
      dec = new LzmaDecoder(defLc, defLp, defPb);
    }

    if (inPos + packSize > input.length || outPos + unpackSize > outSize) {
      throw new ZipError('Corrupt 7z LZMA2 stream');
    }
    dec.decode(new RangeDecoder(input.subarray(inPos, inPos + packSize)), out, outPos, outPos + unpackSize);
    inPos += packSize;
    outPos += unpackSize;
  }

  if (outPos !== outSize) throw new ZipError('Corrupt 7z LZMA2 stream (size mismatch)');
  return out;
}

// ---------------------------------------------------------------------------
// 7z 结构
// ---------------------------------------------------------------------------

interface Coder {
  /** 编码器 ID 的十六进制串，如 `030101` / `21` / `00` */
  id: string;
  props: Uint8Array;
  numIn: number;
  numOut: number;
}

interface Folder {
  coders: Coder[];
  bindPairs: Array<{ inIndex: number; outIndex: number }>;
  packedStreams: number[];
  /** 每个输出流的解压后大小（kCodersUnpackSize） */
  unpackSizes: number[];
  /** 该 folder 是否有 CRC（用于推算子流 CRC 个数） */
  crcDefined: boolean;
}

interface StreamsInfo {
  packPos: number;
  packSizes: number[];
  folders: Folder[];
  /** 每个 folder 的子流大小 */
  subSizes: number[][];
  numUnpackStreams: number[];
}

/** folder 的最终输出流下标：没有被任何 coder 输入绑定的那个输出。 */
function folderMainOut(f: Folder): number {
  const bound = new Set(f.bindPairs.map((p) => p.outIndex));
  for (let i = 0; i < f.unpackSizes.length; i += 1) if (!bound.has(i)) return i;
  throw new ZipError('Corrupt 7z folder');
}

function folderMainSize(f: Folder): number {
  const idx = folderMainOut(f);
  const size = f.unpackSizes[idx];
  if (size === undefined) throw new ZipError('Corrupt 7z folder');
  return size;
}

function readFolder(c: Cursor): Folder {
  const numCoders = c.num();
  if (numCoders === 0 || numCoders > 32) throw new ZipError('Corrupt 7z folder');
  const coders: Coder[] = [];
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i += 1) {
    const flags = c.u8();
    const idSize = flags & 0x0f;
    const idBytes = c.take(idSize);
    let id = '';
    for (const b of idBytes) id += b.toString(16).padStart(2, '0');
    let numIn = 1;
    let numOut = 1;
    if (flags & 0x10) {
      numIn = c.num();
      numOut = c.num();
    }
    let props = new Uint8Array(0);
    if (flags & 0x20) {
      const n = c.num();
      props = c.take(n).slice();
    }
    totalIn += numIn;
    totalOut += numOut;
    coders.push({ id, props, numIn, numOut });
  }
  if (totalOut === 0) throw new ZipError('Corrupt 7z folder');

  const bindPairs: Array<{ inIndex: number; outIndex: number }> = [];
  for (let i = 0; i < totalOut - 1; i += 1) {
    bindPairs.push({ inIndex: c.num(), outIndex: c.num() });
  }

  const numPacked = totalIn - bindPairs.length;
  if (numPacked < 1) throw new ZipError('Corrupt 7z folder');
  let packedStreams: number[];
  if (numPacked === 1) {
    const bound = new Set(bindPairs.map((p) => p.inIndex));
    let found = -1;
    for (let i = 0; i < totalIn; i += 1) {
      if (!bound.has(i)) {
        found = i;
        break;
      }
    }
    if (found < 0) throw new ZipError('Corrupt 7z folder');
    packedStreams = [found];
  } else {
    packedStreams = [];
    for (let i = 0; i < numPacked; i += 1) packedStreams.push(c.num());
  }

  return { coders, bindPairs, packedStreams, unpackSizes: [], crcDefined: false };
}

/** kCRC 块：allDefined 字节 + 可选位向量 + 每项 u32。返回是否有定义的位向量。 */
function readCrcFlags(c: Cursor, count: number): Uint8Array | null {
  const allDefined = c.u8();
  if (allDefined) {
    c.skip(4 * count);
    return null;
  }
  const flags = readBitVector(c, count);
  let defined = 0;
  for (let i = 0; i < count; i += 1) defined += flags[i]!;
  c.skip(4 * defined);
  return flags;
}

function readStreamsInfo(c: Cursor): StreamsInfo {
  const info: StreamsInfo = {
    packPos: 0,
    packSizes: [],
    folders: [],
    subSizes: [],
    numUnpackStreams: [],
  };

  for (;;) {
    const id = c.u8();
    if (id === kEnd) break;

    if (id === kPackInfo) {
      info.packPos = c.num();
      const n = c.num();
      if (n > 1_000_000) throw new ZipError('Corrupt 7z pack info');
      info.packSizes = new Array<number>(n).fill(0);
      for (;;) {
        const t = c.u8();
        if (t === kEnd) break;
        if (t === kSize) {
          for (let i = 0; i < n; i += 1) info.packSizes[i] = c.num();
        } else if (t === kCRC) {
          readCrcFlags(c, n);
        } else {
          throw new ZipError(`Unknown 7z pack property ${t}`);
        }
      }
      continue;
    }

    if (id === kUnpackInfo) {
      if (c.u8() !== kFolder) throw new ZipError('Corrupt 7z unpack info');
      const n = c.num();
      if (n > MAX_ENTRIES) throw new ZipError('Too many 7z folders');
      if (c.u8() !== 0) throw new ZipError('External 7z folders are not supported');
      for (let i = 0; i < n; i += 1) info.folders.push(readFolder(c));

      for (;;) {
        const t = c.u8();
        if (t === kEnd) break;
        if (t === kCodersUnpackSize) {
          for (const f of info.folders) {
            let outs = 0;
            for (const cd of f.coders) outs += cd.numOut;
            f.unpackSizes = new Array<number>(outs);
            for (let i = 0; i < outs; i += 1) f.unpackSizes[i] = c.num();
          }
        } else if (t === kCRC) {
          const flags = readCrcFlags(c, n);
          info.folders.forEach((f, i) => {
            f.crcDefined = flags === null || flags[i] === 1;
          });
        } else {
          throw new ZipError(`Unknown 7z unpack property ${t}`);
        }
      }
      continue;
    }

    if (id === kSubStreamsInfo) {
      readSubStreamsInfo(c, info);
      continue;
    }

    throw new ZipError(`Unknown 7z streams property ${id}`);
  }

  if (info.numUnpackStreams.length === 0) {
    info.numUnpackStreams = info.folders.map(() => 1);
  }
  if (info.subSizes.length === 0) {
    info.subSizes = info.folders.map((f) => [folderMainSize(f)]);
  }
  return info;
}

function readSubStreamsInfo(c: Cursor, info: StreamsInfo): void {
  const n = info.folders.length;
  let nums: number[] | null = null;
  const sizes: number[][] = [];

  for (;;) {
    const id = c.u8();
    if (id === kEnd) break;

    if (id === kNumUnpackStream) {
      nums = [];
      for (let i = 0; i < n; i += 1) nums.push(c.num());
      continue;
    }

    if (id === kSize) {
      sizes.length = 0;
      for (let i = 0; i < n; i += 1) {
        const count = nums?.[i] ?? 1;
        const arr = new Array<number>(count).fill(-1);
        for (let j = 0; j < count - 1; j += 1) arr[j] = c.num();
        sizes.push(arr);
      }
      continue;
    }

    if (id === kCRC) {
      // 子流 CRC 的个数 = 所有子流数 - 「只有一个子流且 folder CRC 已定义」的 folder 数
      let digests = 0;
      for (let i = 0; i < n; i += 1) {
        const count = nums?.[i] ?? 1;
        if (count !== 1 || !info.folders[i]!.crcDefined) digests += count;
      }
      readCrcFlags(c, digests);
      continue;
    }

    throw new ZipError(`Unknown 7z substreams property ${id}`);
  }

  info.numUnpackStreams = nums ?? info.folders.map(() => 1);
  if (sizes.length > 0) {
    // 每个 folder 的最后一个子流大小由「folder 总大小 - 前面子流之和」倒推
    for (let i = 0; i < n; i += 1) {
      const arr = sizes[i];
      if (!arr) throw new ZipError('Corrupt 7z substreams');
      let sum = 0;
      for (let j = 0; j < arr.length - 1; j += 1) sum += arr[j]!;
      arr[arr.length - 1] = folderMainSize(info.folders[i]!) - sum;
    }
    info.subSizes = sizes;
  }
}

interface FileInfo {
  name: string;
  size: number;
  isDir: boolean;
  mtime: Date | null;
  /** 是否有数据流。空文件（0 字节）和目录都没有，二者都不占用子流尺寸。 */
  hasStream: boolean;
}

function readNames(data: Uint8Array, count: number): string[] {
  if (data.length < 1) throw new ZipError('Corrupt 7z file names');
  if (data[0] !== 0) throw new ZipError('External 7z file names are not supported');
  const names: string[] = [];
  let start = 1;
  let i = 1;
  while (names.length < count) {
    let end = -1;
    while (i + 1 < data.length) {
      if (data[i] === 0 && data[i + 1] === 0) {
        end = i;
        break;
      }
      i += 2;
    }
    if (end < 0) throw new ZipError('Corrupt 7z file names');
    names.push(utf16leToString(data, start, end));
    i = end + 2;
    start = i;
  }
  return names;
}

/** kMTime / kCTime / kATime 共用布局：allDefined + external + 可选位向量 + u64。 */
function readTimes(data: Uint8Array, count: number): Array<Date | null> {
  const c = new Cursor(data);
  const allDefined = c.u8();
  if (c.u8() !== 0) throw new ZipError('External 7z times are not supported');
  const defined = allDefined ? null : readBitVector(c, count);
  const out = new Array<Date | null>(count).fill(null);
  for (let i = 0; i < count; i += 1) {
    if (defined && defined[i] === 0) continue;
    out[i] = filetimeToDate(c.u64big());
  }
  return out;
}

/** kWinAttributes：allDefined + external + 可选位向量 + u32（0x10 是目录位）。 */
function readAttributes(data: Uint8Array, count: number): Array<number | null> {
  const c = new Cursor(data);
  const allDefined = c.u8();
  if (c.u8() !== 0) throw new ZipError('External 7z attributes are not supported');
  const defined = allDefined ? null : readBitVector(c, count);
  const out = new Array<number | null>(count).fill(null);
  for (let i = 0; i < count; i += 1) {
    if (defined && defined[i] === 0) continue;
    out[i] = c.u32();
  }
  return out;
}

function readFilesInfo(c: Cursor): FileInfo[] {
  const numFiles = c.num();
  if (numFiles > MAX_ENTRIES) throw new ZipError('Too many 7z entries');
  const files: FileInfo[] = Array.from({ length: numFiles }, () => ({
    name: '',
    size: 0,
    isDir: false,
    mtime: null,
    hasStream: true,
  }));

  let emptyStream: Uint8Array | null = null;
  let emptyFile: Uint8Array | null = null;
  let names: string[] | null = null;
  let mtimes: Array<Date | null> | null = null;
  let attrs: Array<number | null> | null = null;

  for (;;) {
    const propType = c.u8();
    if (propType === kEnd) break;
    const size = c.num();
    const start = c.pos;
    const data = c.take(size);

    if (propType === kEmptyStream) {
      emptyStream = readBitVector(new Cursor(data), numFiles);
    } else if (propType === kEmptyFile) {
      emptyFile = readBitVector(new Cursor(data), countOnes(emptyStream));
    } else if (propType === kName) {
      names = readNames(data, numFiles);
    } else if (propType === kMTime) {
      mtimes = readTimes(data, numFiles);
    } else if (propType === kWinAttributes) {
      attrs = readAttributes(data, numFiles);
    }
    // 其余属性（CTime/ATime/Comment/StartPos/Dummy/Anti）用不到，按 size 跳过
    c.pos = start + size;
  }

  let emptyIdx = 0;
  for (let i = 0; i < numFiles; i += 1) {
    const f = files[i]!;
    if (emptyStream && emptyStream[i] === 1) {
      // 无数据流的条目：kEmptyFile 标为 1 的是空文件，否则是目录
      f.hasStream = false;
      f.isDir = emptyFile ? emptyFile[emptyIdx] !== 1 : true;
      emptyIdx += 1;
    }
    if (names) f.name = (names[i] ?? '').replace(/\\/g, '/');
    if (mtimes?.[i]) f.mtime = mtimes[i]!;
    if (attrs?.[i] != null && (attrs[i]! & 0x10) !== 0) f.isDir = true;
  }

  return files;
}

/** 按 coder 解码一段数据。目前只覆盖 7z 文件表会用到的三种。 */
function decodeWithCoder(coder: Coder, input: Uint8Array, outSize: number): Uint8Array {
  if (outSize > MAX_HEADER_BYTES) throw new ZipError('7z header is too large');
  if (coder.id === '00') {
    if (input.length < outSize) throw new ZipError('Truncated 7z copy stream');
    return input.subarray(0, outSize);
  }
  if (coder.id === '030101') return lzmaDecode(parseLzmaProps(coder.props), input, outSize);
  if (coder.id === '21') return lzma2Decode(coder.props, input, outSize);
  throw new ZipError(`Unsupported 7z codec ${coder.id}`);
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 读 7z 的文件表。`fileSize` 是归档的总字节数，用来定位尾部的 Header。
 *
 * 与 `readCentralDirectory` 返回同形状的条目，路由层不需要区分格式。
 */
export async function readSevenZipDirectory(
  read: RangeReader,
  fileSize: number,
): Promise<ArchiveEntry[]> {
  // 签名头固定 32 字节
  const SIG_HEADER = 32;
  if (fileSize < SIG_HEADER) throw new ZipError('File is too small to be a 7z archive');

  const sig = await read(0, SIG_HEADER - 1);
  if (sig.length < SIG_HEADER) throw new ZipError('Truncated 7z signature header');
  for (let i = 0; i < SEVEN_ZIP_MAGIC.length; i += 1) {
    if (sig[i] !== SEVEN_ZIP_MAGIC[i]) throw new ZipError('Not a 7z archive');
  }

  const c0 = new Cursor(sig, 12);
  const nextOffset = c0.u64();
  const nextSize = c0.u64();
  if (nextSize === 0) return [];
  if (nextSize > MAX_HEADER_BYTES) throw new ZipError('7z header is too large');
  const headerStart = SIG_HEADER + nextOffset;
  if (headerStart + nextSize > fileSize) throw new ZipError('Corrupt 7z header offset');

  const raw = await read(headerStart, headerStart + nextSize - 1);
  if (raw.length < nextSize) throw new ZipError('Truncated 7z header');

  let cursor = new Cursor(raw);
  let kind = cursor.u8();

  if (kind === kEncodedHeader) {
    // 文件表本身是压缩的：先解 StreamsInfo，再把那段 packed 数据解出来
    const streams = readStreamsInfo(cursor);
    const folder = streams.folders[0];
    if (streams.folders.length !== 1 || !folder) {
      throw new ZipError('Unsupported 7z encoded header (multiple folders)');
    }
    if (folder.coders.length !== 1 || folder.packedStreams.length !== 1) {
      throw new ZipError('Unsupported 7z encoded header (coder chain)');
    }
    const coder = folder.coders[0]!;
    const packIdx = folder.packedStreams[0]!;
    const packSize = streams.packSizes[packIdx];
    if (!packSize) throw new ZipError('Corrupt 7z encoded header');

    let base = SIG_HEADER + streams.packPos;
    for (let i = 0; i < packIdx; i += 1) base += streams.packSizes[i] ?? 0;
    if (base + packSize > fileSize) throw new ZipError('Corrupt 7z encoded header');

    const packed = await read(base, base + packSize - 1);
    const decoded = decodeWithCoder(coder, packed, folderMainSize(folder));
    cursor = new Cursor(decoded);
    kind = cursor.u8();
  }

  if (kind !== kHeader) throw new ZipError(`Unsupported 7z header id ${kind}`);

  let files: FileInfo[] = [];
  let substreamSizes: number[] = [];

  for (;;) {
    const t = cursor.u8();
    if (t === kEnd) break;

    if (t === kMainStreamsInfo) {
      const streams = readStreamsInfo(cursor);
      substreamSizes = [];
      for (const arr of streams.subSizes) for (const s of arr) substreamSizes.push(s);
    } else if (t === kFilesInfo) {
      files = readFilesInfo(cursor);
    } else if (t === kArchiveProperties) {
      for (;;) {
        const at = cursor.u8();
        if (at === kEnd) break;
        cursor.skip(cursor.num());
      }
    } else if (t === kAdditionalStreamsInfo) {
      // 只影响恢复记录，浏览用不到
      readStreamsInfo(cursor);
    } else {
      throw new ZipError(`Unknown 7z header property ${t}`);
    }
  }

  let streamIdx = 0;
  return files.map((f) => {
    let size = 0;
    if (f.hasStream) {
      size = substreamSizes[streamIdx] ?? 0;
      streamIdx += 1;
    }
    return {
      name: f.name,
      size,
      isDir: f.isDir,
      mtime: f.mtime ?? new Date(0),
    };
  });
}
