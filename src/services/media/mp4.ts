/**
 * ISO BMFF（MP4 / MOV / M4A）最小解析器。纯 DataView，无 Node API。
 *
 * 只走 `moov` 盒子读元数据，不碰 `mdat`，所以读取头 256 KiB（必要时尾部
 * 2 MiB 找非 faststart 的 moov）就够。覆盖前端 MediaInfo 需要的字段：
 *   stream:duration / format / formatLong / stream_<N>_<video|audio>_*
 *   music:title / artist / album / year（M4A 的 ilst）
 * 以及 music_cover 需要的内嵌封面字节（covr）。
 */

export interface Mp4Track {
  index: number;
  type: 'video' | 'audio' | 'other';
  codec: string;
  width?: number;
  height?: number;
  duration?: number;
  bitrate?: number;
}

export interface Mp4Result {
  duration?: number;
  tracks: Mp4Track[];
  tags: Record<string, string>;
  /** 内嵌封面（M4A covr），原样字节 + 从 data box type 推的扩展名 */
  cover?: { bytes: Uint8Array; ext: string };
}

interface Box {
  type: string;
  start: number; // payload 起点（跳过 8 字节头 / 16 字节 largesize 头）
  end: number; // payload 终点（不含）
  headerSize: number;
}

const td = new TextDecoder('utf-8', { fatal: false });
const td16le = new TextDecoder('utf-16le', { fatal: false });
const td16be = new TextDecoder('utf-16be', { fatal: false });

function ascii(v: DataView, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(start + i));
  return s;
}

/** 顺序遍历一段区间里的直接子 box。 */
function boxes(v: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = v.getUint32(p);
    const type = ascii(v, p + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      const hi = v.getUint32(p + 8);
      const lo = v.getUint32(p + 12);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < headerSize || p + size > to) break;
    out.push({ type, start: p + headerSize, end: p + size, headerSize });
    p += size;
  }
  return out;
}

function findBox(v: DataView, from: number, to: number, type: string): Box | undefined {
  return boxes(v, from, to).find((b) => b.type === type);
}

/** FullBox：payload 前 4 字节是 version+flags。 */
function fullPayload(b: Box): number {
  return b.start + 4;
}

function u32(v: DataView, off: number): number {
  return v.getUint32(off);
}

/** mvhd / mdhd 的 (timescale, duration) 秒数。 */
function movieDuration(v: DataView, b: Box): number | undefined {
  const p = fullPayload(b);
  const version = v.getUint8(b.start);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (p + 20 > b.end) return undefined;
    timescale = u32(v, p + 16);
    const hi = u32(v, p + 20);
    const lo = u32(v, p + 24);
    duration = hi * 0x100000000 + lo;
  } else {
    if (p + 12 > b.end) return undefined;
    timescale = u32(v, p + 8);
    duration = u32(v, p + 12);
  }
  return timescale > 0 && duration > 0 ? duration / timescale : undefined;
}

const CODEC_LONG: Record<string, string> = {
  avc1: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
  avc3: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
  hvc1: 'HEVC (High Efficiency Video Coding)',
  hev1: 'HEVC (High Efficiency Video Coding)',
  vp09: 'VP9',
  av01: 'AV1',
  mp4v: 'MPEG-4 Visual',
  mp4a: 'AAC (Advanced Audio Coding)',
  ac3: 'Audio Coding version 3',
  ec3: 'Enhanced AC-3',
  opus: 'Opus',
  alac: 'Apple Lossless Audio Codec',
};

/** hdlr 的 4 字符 handler 在 payload +8。 */
function trackType(v: DataView, hdlr: Box | undefined): Mp4Track['type'] {
  if (!hdlr || hdlr.start + 12 > hdlr.end) return 'other';
  const h = ascii(v, hdlr.start + 8, 4);
  if (h === 'vide') return 'video';
  if (h === 'soun') return 'audio';
  return 'other';
}

/** stsd 的第一个 sample entry：format@+4，video 的 width@+32 height@+34。 */
function sampleEntry(v: DataView, stsd: Box | undefined): { codec: string; width?: number; height?: number } {
  const p = fullPayload(stsd!);
  // FullBox(4) + entry_count(4) → 第一个 sample entry
  const e = p + 4;
  if (!stsd || e + 8 > stsd.end) return { codec: '' };
  const codec = ascii(v, e + 4, 4);
  let width: number | undefined;
  let height: number | undefined;
  if (e + 36 <= stsd.end) {
    width = v.getUint16(e + 32);
    height = v.getUint16(e + 34);
  }
  return { codec, width, height };
}

function readTagString(v: DataView, dataBox: Box): string | undefined {
  // data box: version(1)+flags(3)+locale(4) → 8 字节头
  const p = dataBox.start + 8;
  if (p >= dataBox.end) return undefined;
  const encoding = v.getUint8(dataBox.start); // 0=utf8 1=utf16
  const bytes = new Uint8Array(dataBox.end - p);
  for (let i = 0; i < bytes.length; i++) bytes[i] = v.getUint8(p + i);
  if (encoding === 1) return td16be.decode(bytes).replace(/\0+$/, '');
  return td.decode(bytes).replace(/\0+$/, '');
}

const ILST_KEYS: Record<string, string> = {
  '\u00a9nam': 'music:title',
  '\u00a9ART': 'music:artist',
  '\u00a9aART': 'music:album_artists',
  '\u00a9alb': 'music:album',
  '\u00a9day': 'music:year',
  '\u00a9gen': 'music:genre',
  '\u00a9wrt': 'music:composer',
};

/**
 * 解析一段字节（可以是头片段，也可以是「头+尾」拼接后的副本）。
 * `totalSize` 只用于 bitrate 估算，不参与字节定位。
 */
export function parseMp4(bytes: Uint8Array, totalSize = 0): Mp4Result | null {
  if (bytes.byteLength < 16) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(v, 0, bytes.byteLength, 'moov');
  if (!moov) return null;

  const result: Mp4Result = { tracks: [], tags: {} };

  const mvhd = findBox(v, moov.start, moov.end, 'mvhd');
  if (mvhd) result.duration = movieDuration(v, mvhd);

  let idx = 0;
  for (const trak of boxes(v, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = findBox(v, trak.start, trak.end, 'mdia');
    if (!mdia) continue;
    const type = trackType(v, findBox(v, mdia.start, mdia.end, 'hdlr'));
    const mdhd = findBox(v, mdia.start, mdia.end, 'mdhd');
    const minf = findBox(v, mdia.start, mdia.end, 'minf');
    const stbl = minf ? findBox(v, minf.start, minf.end, 'stbl') : undefined;
    const stsd = stbl ? findBox(v, stbl.start, stbl.end, 'stsd') : undefined;
    const entry = sampleEntry(v, stsd);
    const dur = mdhd ? movieDuration(v, mdhd) : undefined;
    const track: Mp4Track = {
      index: idx,
      type,
      codec: entry.codec,
      duration: dur,
      width: type === 'video' ? entry.width : undefined,
      height: type === 'video' ? entry.height : undefined,
    };
    result.tracks.push(track);
    idx++;
  }

  // udta/meta/ilst
  const udta = findBox(v, moov.start, moov.end, 'udta');
  const meta = udta ? findBox(v, udta.start, udta.end, 'meta') : undefined;
  const ilst = meta ? findBox(v, meta.start + 4, meta.end, 'ilst') : undefined;
  if (ilst) {
    for (const item of boxes(v, ilst.start, ilst.end)) {
      const key = ILST_KEYS[item.type];
      const data = findBox(v, item.start, item.end, 'data');
      if (!data) continue;
      if (key) {
        const val = readTagString(v, data);
        if (val) result.tags[key] = val;
      } else if (item.type === 'covr') {
        const p = data.start + 8;
        const bytesOut = new Uint8Array(data.end - p);
        for (let i = 0; i < bytesOut.length; i++) bytesOut[i] = v.getUint8(p + i);
        const code = v.getUint32(data.start);
        // data type: 13=JPEG 14=PNG（含 0xNN000000 的 flags 高位）
        const dataType = code & 0xff;
        result.cover = { bytes: bytesOut, ext: dataType === 14 ? 'png' : 'jpg' };
      }
    }
  }

  return result;
}

/** 把解析结果转成前端 MediaInfo 读的 metadata 键值。 */
export function mp4Metadata(r: Mp4Result, totalSize = 0): Record<string, string> {
  const out: Record<string, string> = {
    'stream:format': 'mov,mp4,m4a,3gp,3g2,mj2',
    'stream:formatLong': 'QuickTime / MOV',
  };
  if (r.duration && Number.isFinite(r.duration)) {
    out['stream:duration'] = r.duration.toFixed(6);
  }
  if (totalSize > 0 && r.duration && r.duration > 0) {
    out['stream:bitrate'] = String(Math.round((totalSize * 8) / r.duration));
  }
  for (const t of r.tracks) {
    if (t.type === 'other') continue;
    const prefix = `stream:stream_${t.index}_${t.type}`;
    if (t.codec) {
      out[`${prefix}_codec`] = t.codec;
      const long = CODEC_LONG[t.codec.toLowerCase()];
      if (long) out[`${prefix}_codec_long_name`] = long;
    }
    if (t.width) out[`${prefix}_width`] = String(t.width);
    if (t.height) out[`${prefix}_height`] = String(t.height);
    if (t.bitrate && t.bitrate > 0) out[`${prefix}_bitrate`] = String(t.bitrate);
  }
  Object.assign(out, r.tags);
  return out;
}
