/**
 * `customize:emoji` 元数据白名单。对应上游 manager/metadata.go 的
 * emojiIconMetadataKey 校验器。
 *
 * 上游 b0149124 修的是「包级可变 Map + 独立 hash 缓存」的 data race：
 * 两个 isolate / waitUntil 交错时会读到 hash 与新 map 不一致的中间态。
 * Workers 单 isolate 虽是单线程，但多 isolate + KV/colo 共享缓存下同样
 * 有失效与回填交错的问题，所以这里刻意不用模块级可变缓存：每次按请求
 * 从 settings 快照解析出**新的不可变 Set**。settings 本身已有 L1/colo/
 * KV/DB 四级缓存，解析成本可忽略，且永远不会暴露半更新状态。
 */

/** emojis 设置的形态是 `{ 分组: [emoji, ...] }`，展平成 set 供校验。 */
export function parseEmojiPresets(raw: string): Set<string> {
  const presets = new Set<string>();
  if (!raw) return presets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return presets;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return presets;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') presets.add(item);
    }
  }
  return presets;
}

/**
 * 校验一次 emoji patch。remove 总是允许（清掉图标）；设置值必须在预设里。
 * 返回 null 表示通过，否则返回错误文案。
 */
export function checkEmojiPatch(
  rawSettings: string,
  value: string | undefined,
  remove: boolean,
): string | null {
  if (remove) return null;
  if (!parseEmojiPresets(rawSettings).has(value ?? '')) return 'unsupported emoji';
  return null;
}
