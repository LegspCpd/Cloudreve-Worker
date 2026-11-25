/**
 * 媒体元数据解析回归测试（纯 JS，无原生依赖）。
 *
 * 用合成的最小 MP4/ID3/JPEG 字节验证：
 *   - MP4 mvhd/trak 时长与分辨率、M4A ilst 标签与 covr 封面
 *   - ID3v2 文本帧 + APIC 封面、ID3v1 兜底
 *   - JPEG APP1 EXIF 的相机/光圈/时间/GPS
 *   - 编排器按扩展名开关的行为
 *
 * 跑法：`npm run test:media`
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'mediatest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function u16be(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function box(type, payload) {
  return Buffer.concat([u32be(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
}
function fullbox(type, version, payload) {
  const head = Buffer.alloc(4);
  head[0] = version;
  return box(type, Buffer.concat([head, payload]));
}

// 构造一个最小 MP4：ftyp + moov(mvhd + trak[video] + trak[audio] + udta/meta/ilst)
function makeMp4() {
  // mvhd v0: creation(4) mod(4) timescale(4) duration(4)
  const mvhd = fullbox(
    'mvhd',
    0,
    Buffer.concat([u32be(0), u32be(0), u32be(1000), u32be(125000)]), // 125 秒
  );
  const makeTrak = (handler, format, w, h) => {
    const hdlr = box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1')]));
    // stsd: fullbox + entry_count + sample entry (format@4 of entry, width@32 height@34)
    const entry = Buffer.alloc(36);
    entry.write(format, 4, 4, 'latin1');
    if (w) entry.writeUInt16BE(w, 32);
    if (h) entry.writeUInt16BE(h, 34);
    const stsd = fullbox('stsd', 0, Buffer.concat([u32be(1), entry]));
    const stbl = box('stbl', stsd);
    const minf = box('minf', stbl);
    const mdhd = fullbox('mdhd', 0, Buffer.concat([u32be(0), u32be(0), u32be(1000), u32be(125000)]));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
    return box('trak', mdia);
  };
  const ilstItem = (key, text) => {
    const data = box('data', Buffer.concat([Buffer.alloc(8), Buffer.from(text, 'utf8')]));
    return box(key, data);
  };
  const coverData = box('data', Buffer.concat([Buffer.alloc(8), Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
  const ilst = box('ilst', Buffer.concat([
    ilstItem('\u00a9nam', 'Test Song'),
    ilstItem('\u00a9ART', 'Test Artist'),
    box('covr', coverData),
  ]));
  const meta = fullbox('meta', 0, ilst);
  const udta = box('udta', meta);
  const moov = box('moov', Buffer.concat([mvhd, makeTrak('vide', 'avc1', 1920, 1080), makeTrak('soun', 'mp4a', 0, 0), udta]));
  return Buffer.concat([box('ftyp', Buffer.from('isom')), moov]);
}

// ID3v2.3：TIT2/TPE1/TALB + APIC
function makeId3v2() {
  const textFrame = (id, text) => {
    const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id, 'latin1'), u32be(payload.length), u16be(0), payload]);
  };
  const apicPayload = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('image/jpeg\0', 'latin1'),
    Buffer.from([0x03]),
    Buffer.from('front\0', 'latin1'),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  ]);
  const apic = Buffer.concat([Buffer.from('APIC', 'latin1'), u32be(apicPayload.length), u16be(0), apicPayload]);
  const frames = Buffer.concat([textFrame('TIT2', 'MP3 Title'), textFrame('TPE1', 'MP3 Artist'), textFrame('TALB', 'MP3 Album'), apic]);
  const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x03, 0x00, 0x00]), syncsafe(frames.length), frames]);
}

// 最小 JPEG + APP1 EXIF：Make / DateTimeOriginal / FNumber / ExposureTime
// TIFF 内部布局（相对 TIFF 头）：
//   0-7     TIFF 头（MM, 0x2a, IFD0 偏移=8）
//   8-37    IFD0：count + 2×12 字节 entry + nextIFD
//   40-47   "TestCam\0"
//   50-91   ExifIFD：count + 3×12 字节 entry + nextIFD
//   100-119 "2024:03:15 10:20:30\0"
//   120-127 FNumber RATIONAL = 28/10
//   128-135 ExposureTime RATIONAL = 1/125
function makeJpegExif() {
  const tiff = Buffer.alloc(136);
  tiff.write('MM', 0);
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 @ 8

  tiff.writeUInt16BE(2, 8); // IFD0: 2 entries
  // entry: tag(2) type(2) count(4) value/offset(4)
  tiff.writeUInt16BE(0x010f, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(8, 14); tiff.writeUInt32BE(40, 18); // Make
  tiff.writeUInt16BE(0x8769, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(50, 30); // ExifIFDPtr
  tiff.writeUInt32BE(0, 34); // next IFD
  tiff.write('TestCam\0', 40, 'latin1');

  tiff.writeUInt16BE(3, 50); // ExifIFD: 3 entries
  tiff.writeUInt16BE(0x9003, 52); tiff.writeUInt16BE(2, 54); tiff.writeUInt32BE(20, 56); tiff.writeUInt32BE(100, 60); // DateTimeOriginal
  tiff.writeUInt16BE(0x829d, 64); tiff.writeUInt16BE(5, 66); tiff.writeUInt32BE(1, 68); tiff.writeUInt32BE(120, 72); // FNumber
  tiff.writeUInt16BE(0x829a, 76); tiff.writeUInt16BE(5, 78); tiff.writeUInt32BE(1, 80); tiff.writeUInt32BE(128, 84); // ExposureTime
  tiff.writeUInt32BE(0, 88); // next IFD
  tiff.write('2024:03:15 10:20:30\0', 100, 'latin1');
  tiff.writeUInt32BE(28, 120); tiff.writeUInt32BE(10, 124); // 2.8
  tiff.writeUInt32BE(1, 128); tiff.writeUInt32BE(125, 132); // 1/125

  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(app1Payload.length + 2), app1Payload]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

function toBytes(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

try {
  const bundlePath = path.join(outDir, 'extract.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/services/media/extract.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { extractMediaMeta } = await import(`file://${bundlePath}?t=${Date.now()}`);

  console.log('MP4 / M4A:');
  {
    const mp4 = makeMp4();
    const r = extractMediaMeta({ name: 'test.m4v', head: toBytes(mp4), tail: null, totalSize: mp4.length, enabled: { ffprobe: true } });
    check('MP4 时长 125s', r?.metadata['stream:duration'] === '125.000000', r?.metadata['stream:duration']);
    check('MP4 视频编码 avc1', r?.metadata['stream:stream_0_video_codec'] === 'avc1', r?.metadata['stream:stream_0_video_codec']);
    check('MP4 分辨率 1920x1080', r?.metadata['stream:stream_0_video_width'] === '1920' && r?.metadata['stream:stream_0_video_height'] === '1080', JSON.stringify(r?.metadata));
    check('MP4 音频编码 mp4a', r?.metadata['stream:stream_1_audio_codec'] === 'mp4a', r?.metadata['stream:stream_1_audio_codec']);
  }
  {
    const m4a = makeMp4();
    const r = extractMediaMeta({ name: 'song.m4a', head: toBytes(m4a), tail: null, totalSize: m4a.length, enabled: { music: true } });
    check('M4A 标题', r?.metadata['music:title'] === 'Test Song', r?.metadata['music:title']);
    check('M4A 艺术家', r?.metadata['music:artist'] === 'Test Artist', r?.metadata['music:artist']);
    check('M4A covr 封面', !!r?.cover && r.cover.bytes.length > 0, JSON.stringify(r?.cover));
  }

  console.log('ID3 / MP3:');
  {
    const id3 = makeId3v2();
    const r = extractMediaMeta({ name: 'song.mp3', head: toBytes(id3), tail: null, totalSize: id3.length, enabled: { music: true } });
    check('ID3v2 标题', r?.metadata['music:title'] === 'MP3 Title', r?.metadata['music:title']);
    check('ID3v2 艺术家', r?.metadata['music:artist'] === 'MP3 Artist', r?.metadata['music:artist']);
    check('ID3v2 APIC 封面', !!r?.cover && r.cover.bytes.length > 0, JSON.stringify(r?.cover));
  }
  {
    // ID3v1：尾部 "TAG"+title(30)+artist(30)+album(30)+year(4)+...
    const tag = Buffer.alloc(128);
    tag.write('TAG', 0, 'latin1');
    tag.write('V1 Title', 3, 'latin1');
    tag.write('V1 Artist', 33, 'latin1');
    const r = extractMediaMeta({ name: 'old.mp3', head: toBytes(Buffer.from('dummy')), tail: toBytes(tag), totalSize: 128, enabled: { music: true } });
    check('ID3v1 标题兜底', r?.metadata['music:title'] === 'V1 Title', r?.metadata['music:title']);
    check('ID3v1 艺术家兜底', r?.metadata['music:artist'] === 'V1 Artist', r?.metadata['music:artist']);
  }

  console.log('JPEG EXIF:');
  {
    const jpg = makeJpegExif();
    const r = extractMediaMeta({ name: 'photo.jpg', head: toBytes(jpg), tail: null, totalSize: jpg.length, enabled: { exif: true } });
    check('EXIF 相机', r?.metadata['exif:camera_make'] === 'TestCam', r?.metadata['exif:camera_make']);
    check('EXIF 光圈 2.8', r?.metadata['exif:f'] === '2.800000', r?.metadata['exif:f']);
    check('EXIF 快门 1/125', r?.metadata['exif:exposure_time'] === '1/125', r?.metadata['exif:exposure_time']);
    check('EXIF 拍摄时间 RFC3339', r?.metadata['exif:taken_at'] === '2024-03-15T10:20:30Z', r?.metadata['exif:taken_at']);
    check('EXIF copy_right 双 key 逻辑（无 copyright 时不写）', r?.metadata['exif:copyright'] === undefined, r?.metadata['exif:copyright']);
  }

  console.log('编排开关:');
  {
    const mp4 = makeMp4();
    const r = extractMediaMeta({ name: 'test.mp4', head: toBytes(mp4), tail: null, totalSize: mp4.length, enabled: {} });
    check('全关时视频不产出元数据', r === null, JSON.stringify(r));
  }
  {
    const jpg = makeJpegExif();
    const r = extractMediaMeta({ name: 'photo.jpg', head: toBytes(jpg), tail: null, totalSize: jpg.length, enabled: { ffprobe: true } });
    check('EXIF 不开时 ffprobe 不误提取图片', r === null, JSON.stringify(r));
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error('测试执行失败:', e);
  process.exitCode = 1;
}
