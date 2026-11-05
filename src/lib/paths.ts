/**
 * 路径解码工具。
 *
 * 为什么需要：URI.path 是 URL 编码形式（`URI.parse` 里 `new URL()` 会把
 * 空格等编码进 pathname）。这条编码形式若一路带进 `{path}` 魔法变量，
 * 物理路径就变成 `music/Windows%20XP%20OBE...`（%20 字面）——
 * OneDrive/Graph 这类按名字寻址的驱动，读写两侧的解码层数对不上，
 * 上传成功、打开 404（生产实测：音频文件打不开）。
 */

/**
 * 按段解码 URL 编码，失败保留原段。
 *
 * decode 一次不是幂等操作，策略是「能解就解、解不动保留」：
 *   - `music/Windows%20XP`      → `music/Windows XP`（还原真名）
 *   - `50%25off`                → `50%off`（真名本身含 % 的正确编码形式）
 *   - `50%off`（真名裸含百分号） → decode 抛错，保留原样
 */
export function safeDecodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (!seg.includes('%')) return seg;
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}
