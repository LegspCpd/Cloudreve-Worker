/**
 * ID3v1 / ID3v2（MP3）最小解析器。纯 DataView，无 Node API。
 * 只覆盖前端 MediaInfo 需要的 title/artist/album/year 与 music_cover 的 APIC。
 */

export interface Id3Result {
  tags: Record<string, string>;
  cover?: { bytes: Uint8Array; ext: string };
}

const td = new TextDecoder('utf-8', { fatal: false });
const td16le = new TextDecoder('utf-16le', { fatal: false });
const td16be = new TextDecoder('utf-16be', { fatal: false });

function decodeText(v: DataView, start: number, end: number, enc: number): string {
  if (end <= start) return '';
  const bytes = new Uint8Array(end - start);
  for (let i = 0; i < bytes.length; i++) bytes[i] = v.getUint8(start + i);
  // 去掉结尾的 \0（UTF-16 是两个字节）
  let s: string;
  if (enc === 1) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) s = td16le.decode(bytes.subarray(2));
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) s = td16be.decode(bytes.subarray(2));
    else s = td16le.decode(bytes);
  } else if (enc === 2) {
    s = td16be.decode(bytes);
  } else {
    s = td.decode(bytes);
  }
  return s.replace(/\0+$/, '').trim();
}

/** syncsafe：每字节只用低 7 位，拼成 28 位（ID3v2 帧大小与 tag 大小）。 */
function syncsafe(v: DataView, off: number): number {
  return (
    ((v.getUint8(off) & 0x7f) << 21) |
    ((v.getUint8(off + 1) & 0x7f) << 14) |
    ((v.getUint8(off + 2) & 0x7f) << 7) |
    (v.getUint8(off + 3) & 0x7f)
  );
}

const TEXT_FRAMES: Record<string, string> = {
  TIT2: 'music:title',
  TPE1: 'music:artist',
  TALB: 'music:album',
  TYER: 'music:year',
  TDRC: 'music:year', // v2.4
  TCON: 'music:genre',
  TCOM: 'music:composer',
};

function parseV2(v: DataView, tagEnd: number): Id3Result | null {
  if (tagEnd < 10) return null;
  const version = v.getUint8(3);
  const flags = v.getUint8(5);
  const out: Id3Result = { tags: {} };
  let p = 10;
  // 扩展头：跳过其 syncsafe size（本身含 4 字节 size 字段）
  if (flags & 0x40 && p + 4 <= tagEnd) {
    const extSize = syncsafe(v, p);
    p += extSize > 0 ? extSize : 4;
  }
  while (p + 10 <= tagEnd) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    if (id === '\0\0\0\0') break;
    const frameSize = version === 4 ? syncsafe(v, p + 4) : v.getUint32(p + 4);
    if (frameSize <= 0 || p + 10 + frameSize > tagEnd) break;
    const dataStart = p + 10;
    const dataEnd = dataStart + frameSize;
    if (id in TEXT_FRAMES) {
      const enc = v.getUint8(dataStart);
      const val = decodeText(v, dataStart + 1, dataEnd, enc);
      if (val) out.tags[TEXT_FRAMES[id]] = val;
    } else if (id === 'APIC') {
      // encoding(1) + MIME(\0) + pictureType(1) + description(\0 或双 \0) + data
      const enc = v.getUint8(dataStart);
      let q = dataStart + 1;
      while (q < dataEnd && v.getUint8(q) !== 0) q++;
      q++; // MIME 结尾
      if (q < dataEnd) q++; // picture type
      // description 按编码结尾
      if (enc === 1 || enc === 2) {
        while (q + 1 < dataEnd && !(v.getUint8(q) === 0 && v.getUint8(q + 1) === 0)) q += 2;
        q += 2;
      } else {
        while (q < dataEnd && v.getUint8(q) !== 0) q++;
        q++;
      }
      if (q < dataEnd) {
        const bytes = new Uint8Array(dataEnd - q);
        for (let i = 0; i < bytes.length; i++) bytes[i] = v.getUint8(q + i);
        out.cover = { bytes, ext: 'jpg' };
      }
    }
    p = dataEnd;
  }
  return out;
}

function parseV1(v: DataView, from: number): Id3Result | null {
  if (from + 128 > v.byteLength) return null;
  if (String.fromCharCode(v.getUint8(from), v.getUint8(from + 1), v.getUint8(from + 2)) !== 'TAG') return null;
  const clean = (off: number, len: number) => decodeText(v, from + off, from + off + len, 0);
  const out: Id3Result = { tags: {} };
  const title = clean(3, 30);
  const artist = clean(33, 30);
  const album = clean(63, 30);
  const year = clean(93, 4);
  if (title) out.tags['music:title'] = title;
  if (artist) out.tags['music:artist'] = artist;
  if (album) out.tags['music:album'] = album;
  if (year) out.tags['music:year'] = year;
  return out;
}

/**
 * head 是文件头片段，tail 是结尾片段（可为 null）。ID3v1 在 tail 最后 128 字节。
 */
export function parseId3(head: Uint8Array, tail: Uint8Array | null): Id3Result | null {
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let result: Id3Result | null = null;
  if (head.byteLength >= 10 && String.fromCharCode(hv.getUint8(0), hv.getUint8(1), hv.getUint8(2)) === 'ID3') {
    const tagSize = syncsafe(hv, 6);
    result = parseV2(hv, Math.min(10 + tagSize, head.byteLength));
  }
  if (tail && tail.byteLength >= 128) {
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const v1 = parseV1(tv, tv.byteLength - 128);
    if (v1) {
      result = result ?? { tags: {} };
      // v2 优先：只在缺键时用 v1 兜底
      for (const [k, val] of Object.entries(v1.tags)) if (!result.tags[k]) result.tags[k] = val;
      if (!result.cover && v1.cover) result.cover = v1.cover;
    }
  }
  return result;
}
