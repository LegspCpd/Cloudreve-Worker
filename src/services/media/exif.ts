/**
 * JPEG APP1 / EXIF 最小解析器。纯 DataView。
 * 覆盖前端 MediaInfo 的相机/光圈/快门/ISO/焦距/时间/GPS 字段。
 * 不支持 HEIC/TIFF（Workers 里逐个格式手写不划算），那类文件走空结果。
 */

export interface ExifResult {
  tags: Record<string, string>;
}

const td = new TextDecoder('utf-8', { fatal: false });

class TiffReader {
  private le = false;
  constructor(private v: DataView, readonly base: number) {
    const b0 = v.getUint8(base);
    const b1 = v.getUint8(base + 1);
    if (b0 === 0x49 && b1 === 0x49) this.le = true;
    else if (b0 !== 0x4d || b1 !== 0x4d) throw new Error('bad TIFF header');
  }

  u16(off: number): number {
    return this.v.getUint16(off, this.le);
  }
  u32(off: number): number {
    return this.v.getUint32(off, this.le);
  }
  i32(off: number): number {
    return this.v.getInt32(off, this.le);
  }

  rational(off: number): number {
    const num = this.u32(off);
    const den = this.u32(off + 4);
    return den === 0 ? 0 : num / den;
  }

  private srational(off: number): number {
    const num = this.i32(off);
    const den = this.i32(off + 4);
    return den === 0 ? 0 : num / den;
  }

  /** 读一个 IFD，返回 tag→{type,count,valueOffset}。 */
  ifd(off: number): Map<number, { type: number; count: number; valueOff: number }> {
    const out = new Map<number, { type: number; count: number; valueOff: number }>();
    if (off < 0 || off + 2 > this.v.byteLength - this.base) return out;
    const n = this.u16(this.base + off);
    for (let i = 0; i < n; i++) {
      const e = this.base + off + 2 + i * 12;
      if (e + 12 > this.v.byteLength) break;
      out.set(this.u16(e), {
        type: this.u16(e + 2),
        count: this.u32(e + 4),
        valueOff: e + 8,
      });
    }
    return out;
  }

  nextIfd(off: number): number {
    const n = this.u16(this.base + off);
    return this.u32(this.base + off + 2 + n * 12);
  }

  private inlineBytes(entry: { type: number; count: number; valueOff: number }): number {
    const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    return (sizes[entry.type] ?? 1) * entry.count;
  }

  /** field 里的 4 字节是「相对 TIFF base 的偏移」（非内联）或值本身（内联）。 */
  private dataOffset(entry: { type: number; count: number; valueOff: number }): number {
    if (this.inlineBytes(entry) <= 4) return entry.valueOff;
    return this.base + this.u32(entry.valueOff);
  }

  string(entry: { type: number; count: number; valueOff: number }): string {
    if (!entry) return '';
    const len = this.inlineBytes(entry);
    const off = this.dataOffset(entry);
    if (off < 0 || off + len > this.v.byteLength) return '';
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = this.v.getUint8(off + i);
    return td.decode(bytes).replace(/\0+$/, '').trim();
  }

  num(entry: { type: number; count: number; valueOff: number }): number {
    if (!entry) return 0;
    const off = this.dataOffset(entry);
    if (off + 8 > this.v.byteLength) return 0;
    switch (entry.type) {
      case 3:
        return this.u16(off);
      case 4:
        return this.u32(off);
      case 9:
        return this.i32(off);
      case 5:
        return this.rational(off);
      case 10:
        return this.srational(off);
      default:
        return this.u16(off);
    }
  }
}

function rationalTriplet(r: TiffReader, entry: { valueOff: number }): number[] {
  // count=3 的 RATIONAL 一定非内联：field 存相对 base 的偏移
  const off = r.base + r.u32(entry.valueOff);
  return [r.rational(off), r.rational(off + 8), r.rational(off + 16)];
}

function gpsToDecimal(parts: number[], ref: string): number {
  if (parts.length < 3) return 0;
  const v = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return ref === 'S' || ref === 'W' ? -v : v;
}

function exifDate(s: string): string {
  // "2024:03:15 10:20:30" → "2024-03-15T10:20:30Z"
  const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : s;
}

function exposureTime(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1) return String(n);
  const d = Math.round(1 / n);
  return Number.isFinite(d) && d > 0 ? `1/${d}` : n.toFixed(6);
}

export function parseExif(head: Uint8Array): ExifResult | null {
  if (head.byteLength < 20) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getUint8(0) !== 0xff || v.getUint8(1) !== 0xd8) return null;

  let tiffOff = -1;
  let p = 2;
  // 跳过 SOI，逐段找 APP1 "Exif\0\0"
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) break;
    const marker = v.getUint8(p + 1);
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
    const len = v.getUint16(p + 2);
    if (len < 2 || p + 2 + len > v.byteLength) break;
    if (marker === 0xe1 && len >= 8) {
      let ok = true;
      const magic = 'Exif\0\0';
      for (let i = 0; i < 6; i++) if (v.getUint8(p + 4 + i) !== magic.charCodeAt(i)) ok = false;
      if (ok) {
        tiffOff = p + 10;
        break;
      }
    }
    p += 2 + len;
  }
  if (tiffOff < 0 || tiffOff + 8 > v.byteLength) return null;

  try {
    const r = new TiffReader(v, tiffOff);
    const ifd0Off = r.u32(tiffOff + 4);
    const tags: Record<string, string> = {};
    const ifd0 = r.ifd(ifd0Off);
    const put = (t: string, val: string | number | undefined) => {
      if (val === undefined || val === null || val === '') return;
      if (typeof val === 'number' && !Number.isFinite(val)) return;
      tags[t] = String(val);
    };

    put('exif:camera_make', r.string(ifd0.get(0x010f)!));
    put('exif:camera_model', r.string(ifd0.get(0x0110)!));
    put('exif:software', r.string(ifd0.get(0x0131)!));
    put('exif:artist', r.string(ifd0.get(0x013b)!));
    const copyright = r.string(ifd0.get(0x8298)!);
    put('exif:copy_right', copyright); // 前端侧栏用这个 key
    put('exif:copyright', copyright); // 与上游 Go / 搜索兼容
    put('exif:orientation', r.num(ifd0.get(0x0112)!) || '1');

    const exifPtr = ifd0.get(0x8769);
    if (exifPtr) {
      const sub = r.ifd(r.u32(exifPtr.valueOff));
      const exposure = sub.get(0x829a);
      if (exposure) put('exif:exposure_time', exposureTime(r.num(exposure)));
      const fnum = sub.get(0x829d);
      if (fnum) put('exif:f', r.num(fnum).toFixed(6));
      put('exif:iso', r.num(sub.get(0x8827)!));
      const focal35 = sub.get(0xa405);
      const focal = sub.get(0x920a);
      put('exif:focal_length', focal35 ? Math.round(r.num(focal35)) : focal ? Math.round(r.num(focal)) : undefined);
      const bias = sub.get(0x9204);
      if (bias) put('exif:exposure_bias', r.num(bias).toFixed(1));
      put('exif:x', r.num(sub.get(0xa002)!) || undefined);
      put('exif:y', r.num(sub.get(0xa003)!) || undefined);
      put('exif:lens_make', r.string(sub.get(0xa433)!));
      put('exif:lens_model', r.string(sub.get(0xa434)!));
      const flash = sub.get(0x9209);
      if (flash) put('exif:flash', (r.num(flash) & 1) === 1 ? '1' : '0');
      const dt =
        r.string(sub.get(0x9003)!) || r.string(sub.get(0x9004)!) || r.string(sub.get(0x0132)!);
      if (dt) put('exif:taken_at', exifDate(dt));
    }

    const gpsPtr = ifd0.get(0x8825);
    if (gpsPtr) {
      const gps = r.ifd(r.u32(gpsPtr.valueOff));
      const latEntry = gps.get(0x0002);
      const latRef = gps.get(0x0001);
      const lngEntry = gps.get(0x0004);
      const lngRef = gps.get(0x0003);
      if (latEntry && latRef) put('exif:latitude', gpsToDecimal(rationalTriplet(r, latEntry), r.string(latRef)).toFixed(6));
      if (lngEntry && lngRef) put('exif:longitude', gpsToDecimal(rationalTriplet(r, lngEntry), r.string(lngRef)).toFixed(6));
    }

    // 分辨率兜底：EXIF 没给尺寸时读 SOF0/SOF2
    if (!tags['exif:x'] || !tags['exif:y']) {
      let q = 2;
      while (q + 9 <= v.byteLength) {
        if (v.getUint8(q) !== 0xff) break;
        const marker = v.getUint8(q + 1);
        if (marker === 0xda || marker === 0xd9) break;
        const len = v.getUint16(q + 2);
        if ((marker === 0xc0 || marker === 0xc2) && len >= 7) {
          tags['exif:y'] = String(v.getUint16(q + 5));
          tags['exif:x'] = String(v.getUint16(q + 7));
          break;
        }
        q += 2 + len;
      }
    }

    return Object.keys(tags).length ? { tags } : null;
  } catch {
    return null;
  }
}
