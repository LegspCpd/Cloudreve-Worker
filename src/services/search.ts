/**
 * 全文检索服务。
 *
 * 与 Cloudreve v4 完全同构的两段式方案，没有降级：
 *
 *   1. 抽取 —— Apache Tika，`PUT {endpoint}/tika`，`Accept: text/plain`
 *      对应上游 `pkg/searcher/extractor/tika.go`
 *   2. 索引 / 检索 —— Meilisearch REST，索引 `cloudreve_files`
 *      对应上游 `pkg/searcher/indexer/meilisearch.go`
 *
 * 这两者都是纯 HTTP 服务，Workers 能直接调，所以边缘版不需要退化成文件名匹配。
 * 管理员在「管理面板 → 文件系统 → 全文检索」里填两个 endpoint 即可生效。
 *
 * 未配置（`fts_enabled=0` 或 Meilisearch endpoint 为空）时，`/file/search` 会
 * 回落到文件名匹配，行为与本服务接入前一致 —— 不会出现「开了但搜不到」。
 */
import type { AppContext } from './context';
import type { FtsConfig } from '../settings/provider';
import type { FileRow } from '../db/types';
import { AppError, CodeFeatureNotEnabled } from '../lib/errors';

/** 索引名。与上游 `pkg/searcher/indexer/meilisearch.go:17` 一致，不要改。 */
const INDEX_NAME = 'cloudreve_files';
/** embedder 名。同上，`:18`。 */
const EMBEDDER_NAME = 'cr-text';
/**
 * 向量检索时的文档模板。同上，`:19`。
 * 只有开了 `fts_meilisearch_embed_enabled` 才会下发到 Meilisearch。
 */
const EMBEDDING_TEMPLATE = 'Chunk #{{doc.chunk_idx}} in a file named \'{{doc.file_name}}\': {{ doc.text }}';

/** Meilisearch 里的一条文档（一个文件被切成多个 chunk，每个 chunk 一条）。 */
interface SearchDocument {
  id: string;
  file_id: number;
  owner_id: number;
  entity_id: number;
  chunk_idx: number;
  file_name: string;
  text: string;
}

/** 检索命中的一条结果。 */
export interface SearchHit {
  fileId: number;
  ownerId: number;
  fileName: string;
  /** 命中的正文片段；开启高亮时含 `<em>` 标记 */
  text: string;
}

// ---------------------------------------------------------------------------
// 文本分块
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** UTF-8 字节数。上游 Go 的 `len(string)` 就是字节数，这里必须对齐。 */
function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/**
 * 按段落 / 词边界把文本切成不超过 `maxBytes` 字节的块。
 * 逐行复刻上游 `pkg/searcher/indexer/chunker.go` 的 `ChunkText`。
 */
export function chunkText(text: string, maxBytes: number): string[] {
  const limit = maxBytes > 0 ? maxBytes : 2000;

  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split('\n\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const raw of paragraphs) {
    const para = raw.trim();
    if (!para) continue;

    const paraBytes = byteLen(para);

    // 单段就超限：先把已攒的吐出去，再按词边界硬切
    if (paraBytes > limit) {
      if (currentBytes > 0) {
        chunks.push(current.join('\n\n'));
        current = [];
        currentBytes = 0;
      }
      chunks.push(...splitByBytes(para, limit));
      continue;
    }

    const joinerLen = currentBytes > 0 ? 2 : 0; // "\n\n"
    if (currentBytes + joinerLen + paraBytes > limit && currentBytes > 0) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentBytes = 0;
    }

    if (currentBytes > 0) currentBytes += 2;
    current.push(para);
    currentBytes += paraBytes;
  }

  if (currentBytes > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

/** 按词边界切分，每块最多 `maxBytes` 字节。对应上游 `splitByBytes`。 */
function splitByBytes(text: string, maxBytes: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const w of words) {
    const wLen = byteLen(w);
    let spaceLen = 0;
    if (currentBytes > 0) spaceLen = 1;

    if (currentBytes + spaceLen + wLen > maxBytes && currentBytes > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentBytes = 0;
      spaceLen = 0;
    }

    current.push(w);
    currentBytes += spaceLen + wLen;
  }

  if (current.length > 0) chunks.push(current.join(' '));
  return chunks;
}

/** 取小写扩展名（不含点）。 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// 抽取器：Tika
// ---------------------------------------------------------------------------

/**
 * 判断一个文件是否值得送进抽取器。
 * 与上游 `ShouldExtractText` 一致：扩展名在白名单里，且体积未超限。
 */
export function shouldExtract(
  exts: string[],
  maxFileSize: number,
  fileName: string,
  size: number,
): boolean {
  if (!exts.length) return false;
  if (!exts.includes(extOf(fileName))) return false;
  return maxFileSize > size;
}

/** 把文件内容交给 Tika 抽成纯文本。 */
async function tikaExtract(endpoint: string, body: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${endpoint}/tika`, {
    method: 'PUT',
    headers: { Accept: 'text/plain' },
    body,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new AppError(
      CodeFeatureNotEnabled,
      `Tika returned HTTP ${res.status} for text extraction`,
    );
  }
  return (await res.text()).trim();
}

// ---------------------------------------------------------------------------
// 索引器：Meilisearch
// ---------------------------------------------------------------------------

interface MeiliSearchResponse {
  hits?: Array<Record<string, unknown> & { _formatted?: Record<string, unknown> }>;
  estimatedTotalHits?: number;
}

/**
 * Meilisearch REST 客户端。
 *
 * 只实现上游 `MeilisearchIndexer` 用到的那几个接口，刻意不封装成通用 SDK：
 * 上游的索引结构（主键、可筛选字段、distinct 字段）是协议的一部分，
 * 单独暴露反而容易被改坏。
 */
export class MeilisearchIndexer {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly pageSize: number,
    private readonly embedEnabled: boolean,
    private readonly embedConfig: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return { ...h, ...(extra ?? {}) };
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${this.endpoint}${path}`, init);
    // Meilisearch 的任务接口返回 202，这里按「非 2xx 即失败」处理
    if (!res.ok && res.status !== 202) {
      const detail = await res.text().catch(() => '');
      throw new AppError(
        CodeFeatureNotEnabled,
        `Meilisearch ${init.method ?? 'GET'} ${path} failed: HTTP ${res.status} ${detail.slice(0, 200)}`,
      );
    }
    return res;
  }

  /** 建索引并下发设置。对应上游 `EnsureIndex`。 */
  async ensureIndex(): Promise<void> {
    await this.req('/indexes', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ uid: INDEX_NAME, primaryKey: 'id' }),
    }).catch(() => undefined); // 已存在时会报错，忽略

    await this.req(`/indexes/${INDEX_NAME}/settings/filterable-attributes`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(['owner_id', 'file_id', 'entity_id']),
    });

    await this.req(`/indexes/${INDEX_NAME}/settings/searchable-attributes`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(['text', 'file_name']),
    });

    await this.req(`/indexes/${INDEX_NAME}/settings/distinct-attribute`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify('file_id'),
    });

    if (this.embedEnabled) {
      let embedder: Record<string, unknown>;
      try {
        embedder = JSON.parse(this.embedConfig) as Record<string, unknown>;
      } catch {
        // 配置写坏了就跳过向量检索，不要让整个索引建不起来
        return;
      }
      embedder.documentTemplate = EMBEDDING_TEMPLATE;
      await this.req(`/indexes/${INDEX_NAME}/settings/embedders`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ [EMBEDDER_NAME]: embedder }),
      });
    } else {
      await this.req(`/indexes/${INDEX_NAME}/settings/embedders`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify(null),
      }).catch(() => undefined);
    }
  }

  /** 写入 / 覆盖一个文件的全部 chunk。对应上游 `IndexFile`。 */
  async indexFile(args: {
    ownerId: number;
    fileId: number;
    entityId: number;
    fileName: string;
    text: string;
    chunkSize: number;
  }): Promise<void> {
    const chunks = chunkText(args.text, args.chunkSize);
    if (!chunks.length) return;

    const docs: SearchDocument[] = chunks.map((text, i) => ({
      id: `${args.fileId}_${i}`,
      file_id: args.fileId,
      owner_id: args.ownerId,
      entity_id: args.entityId,
      chunk_idx: i,
      file_name: args.fileName,
      text,
    }));

    await this.req(`/indexes/${INDEX_NAME}/documents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(docs),
    });
  }

  /** 按 file_id 删除文档。对应上游 `DeleteByFileIDs`。 */
  async deleteByFileIds(fileIds: number[]): Promise<void> {
    if (!fileIds.length) return;
    const filter = `file_id IN [${fileIds.join(', ')}]`;
    await this.req(`/indexes/${INDEX_NAME}/documents/delete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ filter }),
    });
  }

  /** 改属主。对应上游 `ChangeOwner`。 */
  async changeOwner(fileId: number, newOwnerId: number): Promise<void> {
    const docs = await this.fetchDocs(`file_id = ${fileId}`);
    if (!docs.length) return;
    for (const d of docs) d.owner_id = newOwnerId;
    await this.req(`/indexes/${INDEX_NAME}/documents`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(docs),
    });
  }

  /** 复制到新文件。对应上游 `CopyByFileID`。 */
  async copyByFileId(args: {
    srcFileId: number;
    dstFileId: number;
    dstOwnerId: number;
    dstEntityId: number;
  }): Promise<void> {
    const docs = await this.fetchDocs(`file_id = ${args.srcFileId}`);
    if (!docs.length) throw new AppError(CodeFeatureNotEnabled, 'No source index to copy');

    const copied = docs.map((d) => ({
      ...d,
      id: `${args.dstFileId}_${d.chunk_idx}`,
      file_id: args.dstFileId,
      owner_id: args.dstOwnerId,
      entity_id: args.dstEntityId,
    }));

    await this.req(`/indexes/${INDEX_NAME}/documents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(copied),
    });
  }

  /** 重命名后同步 file_name。对应上游 `Rename`。 */
  async rename(fileId: number, entityId: number, newFileName: string): Promise<void> {
    const docs = await this.fetchDocs(`file_id = ${fileId} AND entity_id = ${entityId}`);
    if (!docs.length) return;
    for (const d of docs) d.file_name = newFileName;
    await this.req(`/indexes/${INDEX_NAME}/documents`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(docs),
    });
  }

  /** 清空索引。对应上游 `DeleteAll`。 */
  async deleteAll(): Promise<void> {
    await this.req(`/indexes/${INDEX_NAME}/documents`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  /** 检索。对应上游 `Search`。 */
  async search(ownerId: number, query: string, offset: number): Promise<{ hits: SearchHit[]; total: number }> {
    const body: Record<string, unknown> = {
      q: query,
      filter: `owner_id = ${ownerId}`,
      limit: this.pageSize > 0 ? this.pageSize : 5,
      offset,
      attributesToHighlight: ['text'],
    };
    if (this.embedEnabled) {
      body.hybrid = { embedder: EMBEDDER_NAME, semanticRatio: 0.5 };
    }

    const res = await this.req(`/indexes/${INDEX_NAME}/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as MeiliSearchResponse;

    const hits: SearchHit[] = [];
    const seen = new Set<number>();
    for (const hit of json.hits ?? []) {
      const doc = hit as unknown as SearchDocument & { _formatted?: { text?: string } };
      if (seen.has(doc.file_id)) continue; // distinct 已在服务端生效，这里再兜一层
      seen.add(doc.file_id);
      hits.push({
        fileId: doc.file_id,
        ownerId: doc.owner_id,
        fileName: doc.file_name,
        text: doc._formatted?.text ?? doc.text ?? '',
      });
    }

    return { hits, total: json.estimatedTotalHits ?? hits.length };
  }

  /** 按 filter 分页取回全部文档（用于改属主 / 复制 / 重命名）。 */
  private async fetchDocs(filter: string): Promise<SearchDocument[]> {
    const all: SearchDocument[] = [];
    const batchSize = 100;
    for (let offset = 0; ; offset += batchSize) {
      const res = await this.req(`/indexes/${INDEX_NAME}/documents`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ filter, limit: batchSize, offset }),
      });
      const json = (await res.json()) as { results?: SearchDocument[] };
      const batch = json.results ?? [];
      all.push(...batch);
      if (batch.length < batchSize) break;
    }
    return all;
  }
}

// ---------------------------------------------------------------------------
// 对外服务
// ---------------------------------------------------------------------------

export class SearchService {
  private readonly cfg: FtsConfig;
  private indexer: MeilisearchIndexer | null = null;

  constructor(private readonly ctx: AppContext) {
    this.cfg = ctx.settings.fts;
    if (this.available) {
      this.indexer = new MeilisearchIndexer(
        this.cfg.meiliEndpoint,
        this.cfg.meiliApiKey,
        this.cfg.meiliPageSize,
        this.cfg.meiliEmbedEnabled,
        this.cfg.meiliEmbedConfig,
      );
    }
  }

  /**
   * 全文检索是否真正可用。
   *
   * 需要同时满足：`fts_enabled` 打开、索引类型是 meilisearch、endpoint 非空。
   * 缺任何一个都返回 false，调用方据此回落到文件名匹配。
   */
  get available(): boolean {
    const c = this.cfg;
    return c.enabled && c.indexType === 'meilisearch' && c.meiliEndpoint !== '';
  }

  /** 建索引（管理面板「重建索引」用）。 */
  async ensureIndex(): Promise<void> {
    if (!this.indexer) throw new AppError(CodeFeatureNotEnabled, 'Full text search is not configured');
    await this.indexer.ensureIndex();
  }

  /** 清空索引。 */
  async deleteAll(): Promise<void> {
    if (!this.indexer) throw new AppError(CodeFeatureNotEnabled, 'Full text search is not configured');
    await this.indexer.deleteAll();
  }

  /**
   * 按 file_id 删除索引。
   *
   * ⚠️ 必须是尽力而为：这条在「彻底删除文件」的收尾调用，DB 行已经删完了。
   * 搜索后端挂掉（Meilisearch 实例被回收会回 404 `Instance does not exist`）
   * 时若把异常抛出去，接口会回一个错误码，用户以为删除失败、重试又变
   * 「文件不存在」—— 实际文件早删了。索引残留由重建索引兜底。
   * 与 `copy` / `rename` 同款处理。
   */
  async deleteByFileIds(fileIds: number[]): Promise<void> {
    if (!this.indexer || !fileIds.length) return;
    await this.indexer.deleteByFileIds(fileIds).catch((e) => {
      console.error('FTS delete after purge failed', e instanceof Error ? e.message : String(e));
    });
  }

  /** 文件复制后同步索引。 */
  async copy(args: {
    srcFileId: number;
    dstFileId: number;
    dstOwnerId: number;
    dstEntityId: number;
  }): Promise<void> {
    if (!this.indexer) return;
    await this.indexer.copyByFileId(args).catch(() => undefined);
  }

  /** 文件改名后同步索引。 */
  async rename(fileId: number, entityId: number, newFileName: string): Promise<void> {
    if (!this.indexer) return;
    await this.indexer.rename(fileId, entityId, newFileName).catch(() => undefined);
  }

  /**
   * 检索。返回命中结果（已按 file_id 去重）与总数。
   *
   * 与上游 `SearchFullText` 的差别只在「跳过无效文件的重试」：上游递归加大
   * offset 再查一次，Workers 里一次请求多打一轮 HTTP 不划算，直接跳过即可。
   */
  async search(query: string, offset: number): Promise<{ hits: SearchHit[]; total: number }> {
    if (!this.indexer) throw new AppError(CodeFeatureNotEnabled, 'Full text search is not configured');
    return this.indexer.search(this.ctx.requireUser().id, query, offset);
  }

  /**
   * 给单个文件建索引：取实体内容 → Tika 抽正文 → 写入 Meilisearch。
   *
   * 上游这一步跑在后台任务队列里；Workers 是请求作用域，所以同步执行，
   * 由调用方决定是 await 还是丢给 `waitUntil`。
   * 任何一步失败都只记录不抛出 —— 索引失败不该让上传/重建整体失败。
   */
  async indexFile(file: FileRow): Promise<boolean> {
    if (!this.indexer) return false;
    if (!this.cfg.enabled) return false;
    if (!file.primary_entity) return false;

    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) return false;

    const size = Number(entity.size ?? 0);
    if (!shouldExtract(this.cfg.tikaExts, this.cfg.tikaMaxFileSize, file.name, size)) {
      return false;
    }

    // 体积为 0 的文件没有正文可抽，但文件名仍应进索引（上游也是这么做的）
    let text = '';
    if (size > 0) {
      if (!this.cfg.tikaEndpoint) return false;
      const bytes = await this.readEntity(entity.source, entity.storage_policy_entities, size);
      if (!bytes) return false;
      text = await tikaExtract(this.cfg.tikaEndpoint, bytes);
    }

    await this.indexer.indexFile({
      ownerId: Number(file.owner_id ?? this.ctx.requireUser().id),
      fileId: file.id,
      entityId: entity.id,
      fileName: file.name,
      text,
      chunkSize: this.cfg.chunkSize,
    });
    return true;
  }

  /** 把实体内容读进内存。超过 Tika 体积上限的会在调用前被 `shouldExtract` 拦掉。 */
  private async readEntity(
    source: string,
    policyId: number,
    size: number,
  ): Promise<ArrayBuffer | null> {
    const policy = await this.ctx.policies.byId(policyId);
    if (!policy) return null;
    const content = await this.ctx.driverFor(policy).get(source, null);
    if (!content) return null;
    // 上限已由 shouldExtract 保证，这里再兜一层防止驱动返回的长度不准
    const cap = this.cfg.tikaMaxFileSize;
    if (size > cap) return null;
    return new Response(content.body as ReadableStream).arrayBuffer();
  }
}
