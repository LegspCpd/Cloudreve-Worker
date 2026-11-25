/**
 * 音乐封面实时提取（music_cover 生成器）。
 *
 * 上游用 tag.ReadFrom 读内嵌 APIC/covr；这里复用同一套纯 JS 解析器，
 * 从实体头部/尾部 Range 读到封面字节，交给 /thumbimg 端点回传。
 * 不写派生对象，避免各存储驱动 put 语义差异；靠边缘缓存抵消重复回源。
 */
import type { AppContext } from '../context';
import type { EntityRow } from '../../db/types';
import { parseId3 } from './id3';
import { parseMp4 } from './mp4';

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

const MP3 = new Set(['mp3']);
const M4A = new Set(['m4a', 'mp4', 'aac', 'alac']);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

async function getRange(
  ctx: AppContext,
  entity: EntityRow,
  range: string,
): Promise<Uint8Array | null> {
  const policy = await ctx.policies.byId(entity.storage_policy_entities);
  if (!policy) return null;
  const content = await ctx.driverFor(policy).get(entity.source, range).catch(() => null);
  if (!content?.body) return null;
  try {
    return new Uint8Array(await new Response(content.body).arrayBuffer());
  } catch {
    return null;
  }
}

export interface CoverBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** 提取内嵌封面；不支持或没有封面时返回 null。 */
export async function extractCover(
  ctx: AppContext,
  entity: EntityRow,
  name: string,
): Promise<CoverBytes | null> {
  if (entity.enc_meta) return null;
  const ext = extOf(name);
  const isMp3 = MP3.has(ext);
  const isM4a = M4A.has(ext);
  if (!isMp3 && !isM4a) return null;

  const head = await getRange(ctx, entity, `bytes=0-${HEAD_BYTES - 1}`);
  if (!head) return null;

  if (isMp3) {
    const tail = await getRange(ctx, entity, `bytes=-${TAIL_BYTES}`);
    const parsed = parseId3(head, tail);
    if (!parsed?.cover) return null;
    return { bytes: parsed.cover.bytes, contentType: 'image/jpeg' };
  }

  const tail = await getRange(ctx, entity, `bytes=-${TAIL_BYTES}`);
  const buf = new Uint8Array(head.byteLength + (tail?.byteLength ?? 0));
  buf.set(head, 0);
  if (tail) buf.set(tail, head.byteLength);
  const parsed = parseMp4(buf, entity.size);
  if (!parsed?.cover) return null;
  return {
    bytes: parsed.cover.bytes,
    contentType: parsed.cover.ext === 'png' ? 'image/png' : 'image/jpeg',
  };
}
