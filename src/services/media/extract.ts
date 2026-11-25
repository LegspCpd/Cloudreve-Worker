/**
 * 媒体元数据提取编排（纯 JS，Workers 可用）。
 *
 * 上游靠 ffprobe/exiftool 等本机程序；Workers 里没有，这里用最小字节解析
 * 覆盖前端 MediaInfo 实际消费的字段。目标不是复刻 ffprobe 全部输出，而是
 * 「打开视频/音乐/图片时侧栏有信息、封面能显示」。
 *
 * 读取策略（见 indexer.ts）：头 256 KiB + 尾 2 MiB，避开整文件下载。
 */
import { parseMp4, mp4Metadata } from './mp4';
import { parseId3 } from './id3';
import { parseExif } from './exif';

export interface ExtractInput {
  name: string;
  /** 文件头字节（0-256KiB） */
  head: Uint8Array;
  /** 文件尾字节（最后 2MiB），用于 ID3v1 与非 faststart 的 MP4 moov */
  tail: Uint8Array | null;
  /** 文件总大小，用于估算码率 */
  totalSize: number;
  /** 各开关，默认全关；由 settings 的 media_meta_* 决定 */
  enabled: { exif?: boolean; music?: boolean; ffprobe?: boolean };
}

export interface ExtractOutput {
  metadata: Record<string, string>;
  cover?: { bytes: Uint8Array; ext: string };
}

const MP4_EXT = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2']);
const M4A_EXT = new Set(['m4a', 'mp4', 'aac', 'alac']);
const MP3_EXT = new Set(['mp3']);
const EXIF_EXT = new Set(['jpg', 'jpeg']);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/** 头+尾拼成一块连续字节供 MP4 解析器遍历（moov 在尾部的场景）。 */
function concat(head: Uint8Array, tail: Uint8Array | null): Uint8Array {
  if (!tail || tail.byteLength === 0) return head;
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
}

export function extractMediaMeta(input: ExtractInput): ExtractOutput | null {
  const ext = extOf(input.name);
  const metadata: Record<string, string> = {};
  let cover: ExtractOutput['cover'];

  // MP4/MOV：时长、分辨率、编码、多流（ffprobe 开关）
  if (input.enabled.ffprobe && MP4_EXT.has(ext)) {
    const buf = concat(input.head, input.tail);
    const parsed = parseMp4(buf, input.totalSize);
    if (parsed) Object.assign(metadata, mp4Metadata(parsed, input.totalSize));
  }

  // M4A/M4B：ilst 标签 + covr 封面（music 开关；与 ffprobe 独立，避免重复写 stream:*）
  if (input.enabled.music && M4A_EXT.has(ext)) {
    const buf = concat(input.head, input.tail);
    const parsed = parseMp4(buf, input.totalSize);
    if (parsed) {
      Object.assign(metadata, parsed.tags);
      if (parsed.cover) cover = parsed.cover;
    }
  }

  // MP3：ID3v2/v1 标签 + APIC 封面
  if (input.enabled.music && MP3_EXT.has(ext)) {
    const parsed = parseId3(input.head, input.tail);
    if (parsed) {
      Object.assign(metadata, parsed.tags);
      if (parsed.cover) cover = parsed.cover;
    }
  }

  // JPEG EXIF
  if (input.enabled.exif && EXIF_EXT.has(ext)) {
    const parsed = parseExif(input.head);
    if (parsed) Object.assign(metadata, parsed.tags);
  }

  return Object.keys(metadata).length || cover ? { metadata, cover } : null;
}
