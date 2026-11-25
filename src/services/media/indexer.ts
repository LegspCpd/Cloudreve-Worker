/**
 * 上传完成后抽取媒体元数据并写入 metadata 表。纯 JS，不依赖 ffprobe。
 *
 * 与全文索引一致走 `waitUntil`：响应不等待，失败只记日志，绝不影响上传。
 * upsert 是 ON CONFLICT DO UPDATE（幂等），重复执行安全。
 */
import type { AppContext } from '../context';
import type { FileRow } from '../../db/types';
import { extractMediaMeta } from './extract';

/** 头 256 KiB 覆盖 ID3v2 / JPEG APP1 / faststart MP4 的 moov。 */
const HEAD_BYTES = 256 * 1024;
/** 尾 2 MiB 覆盖 ID3v1（128B）与非 faststart MP4 的 moov。 */
const TAIL_BYTES = 2 * 1024 * 1024;
/** 单次提取的硬上限：文件大小超过它直接跳过，避免大视频反复拉取。 */
const MAX_PROBE_SIZE = 512 * 1024 * 1024;

const EXIF_EXTS = new Set(['jpg', 'jpeg']);
const MUSIC_EXTS = new Set(['mp3', 'm4a', 'aac', 'alac']);
const PROBE_EXTS = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2']);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

async function readBytes(body: ReadableStream | null): Promise<Uint8Array | null> {
  if (!body) return null;
  try {
    return new Uint8Array(await new Response(body).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 由路由层在 onUploadFinished 钩子里调用；本函数内部自行 ctx.waitUntil。
 */
export function hookMediaMeta(ctx: AppContext, file: FileRow): void {
  const s = ctx.settings;
  const exifOn = s.getBool('media_meta_exif', false);
  const musicOn = s.getBool('media_meta_music', false);
  const probeOn = s.getBool('media_meta_ffprobe', false);
  if (!exifOn && !musicOn && !probeOn) return;

  const ext = extOf(file.name);
  const wantsExif = exifOn && EXIF_EXTS.has(ext);
  const wantsMusic = musicOn && MUSIC_EXTS.has(ext);
  const wantsProbe = probeOn && PROBE_EXTS.has(ext);
  if (!wantsExif && !wantsMusic && !wantsProbe) return;
  if (!file.primary_entity || file.size > MAX_PROBE_SIZE) return;

  const task = (async () => {
    const entity = await ctx.entities.byId(file.primary_entity!);
    if (!entity || entity.enc_meta) return; // 密文解析不了
    const policy = await ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) return;
    const driver = ctx.driverFor(policy);

    const head = await readBytes(
      (await driver.get(entity.source, `bytes=0-${HEAD_BYTES - 1}`).catch(() => null))?.body ?? null,
    );
    if (!head || head.byteLength === 0) return;
    // 只有 ID3v1 / 非 faststart MP4 才需要尾部；图片、faststart 视频省下一次回源。
    let tail: Uint8Array | null = null;
    const needTail = (wantsMusic && ext === 'mp3') || (wantsProbe && PROBE_EXTS.has(ext));
    if (needTail && file.size > HEAD_BYTES) {
      tail = await readBytes(
        (
          await driver
            .get(entity.source, `bytes=-${Math.min(TAIL_BYTES, file.size)}`)
            .catch(() => null)
        )?.body ?? null,
      );
    }

    const result = extractMediaMeta({
      name: file.name,
      head,
      tail,
      totalSize: file.size,
      enabled: { exif: wantsExif, music: wantsMusic, ffprobe: wantsProbe },
    });
    if (!result) return;

    for (const [name, value] of Object.entries(result.metadata)) {
      await ctx.metadata.upsert(file.id, name, value, true);
    }
  })().catch((e) => console.error('media meta extract after upload failed', e));

  ctx.waitUntil?.(task);
}
