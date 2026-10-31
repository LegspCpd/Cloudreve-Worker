/**
 * 任务流服务。对应 Cloudreve v4 的 `service/explorer/workflows.go` 与后台任务队列。
 *
 * ## 与原版最大的结构差异，先说清楚
 *
 * 原版把任务丢进后台 goroutine 池慢慢跑，前端轮询进度。Workers 是**请求作用域**的：
 * 响应一返回，这次执行的 CPU 预算就结束了，没有常驻进程能接着跑。
 *
 * 所以这里改成「**请求内同步跑完**」：
 *   - 打包（create_archive）：边打包边上传，跑完任务就是 completed；
 *   - 远程下载（remote_download）：边下边传，跑完就是 completed。
 *
 * 代价是单次能处理的体积受 Workers 的 CPU/内存上限约束，因此设了
 * `MAX_WORKFLOW_BYTES` 作为硬闸门 —— 超了就明确报「太大」，而不是
 * 建一个永远跑不完的任务给用户看。这比假装排队要诚实。
 *
 * 没有实现的部分（解压、从策略导入、重建全文索引）一律返回明确的「不支持」，
 * 不建空任务。
 */
import { AppContext } from './context';
import { FileSystemService } from './fs';
import { UploadService } from './upload';
import type { EncryptMetadata, EntityRow, FileRow, TaskRow } from '../db/types';
import { EntityType, FileType } from '../lib/boolset';
import { decryptStream, importCtrKey } from '../lib/encCrypto';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';
import { createZipStream, type ZipEntry } from '../lib/zip';
import {
  readCentralDirectory,
  readEntry,
  safeEntryPath,
  ZipError,
  type RangeReader,
} from '../lib/zipread';
import { URI } from './uri';
import { dispatchRemoteDownload, markDispatched } from './nodeTasks';
import { assertSafeRemoteUrl, safeFetch, UnsafeRemoteUrlError } from '../lib/ssrf';

/**
 * 单个任务允许处理的字节上限。
 *
 * 定在 200MB：Workers 请求内可用内存 128MB，打包是按分片流式处理的
 * （内存里最多同时存在一个分片），200MB 是 CPU 时间比内存先见底的量级。
 */
export const MAX_WORKFLOW_BYTES = 200 * 1024 * 1024;

/**
 * 解压任务的 ZIP 本体大小上限。解压需要把条目按段读入内存，
 * 这个值定在 80MB —— Workers 请求内 128MB 内存，扣除中央目录与
 * 单条目解压缓冲后的安全量级。
 */
export const MAX_EXTRACT_ZIP_BYTES = 80 * 1024 * 1024;

/** 单个条目解压后的上限（防 zip bomb 的硬闸门）。 */
const MAX_EXTRACT_ENTRY_BYTES = 100 * 1024 * 1024;

/** 解压 / 导入任务的条目数上限（条目录、目录创建都是逐条 DB 写）。 */
const MAX_WORKFLOW_ENTRIES = 1000;

/** 导入任务的对象总大小上限（导入只建引用不搬数据，可比解压宽松）。 */
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

/** 递归列举目录时的单页大小。 */
const LIST_PAGE_SIZE = 500;

interface ArchiveItem {
  /** 包内路径；目录以 `/` 结尾 */
  name: string;
  file: FileRow;
  isDir: boolean;
}

/** 把若干 Uint8Array 拼成一个。 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 把整个流读进内存（仅用于受上限约束的段读取）。导出给压缩包浏览路由复用。 */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  return concatBytes(parts);
}

/**
 * 条目名解码器：ZIP 未标 UTF-8 的名字按指定编码解（如 gbk）。
 * 编码不受支持或解码失败时回退 UTF-8，绝不让整个任务因编码崩掉。
 * 导出给 `/file/archive` 列表路由复用。
 */
export function nameDecoder(encoding?: string): ((bytes: Uint8Array) => string) | undefined {
  if (!encoding || encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8') {
    return undefined;
  }
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return (bytes) => decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export class WorkflowService {
  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  // -------------------------------------------------------------------------
  // 打包
  // -------------------------------------------------------------------------

  /**
   * 把一组来源 URI 展开成 zip 条目（目录递归展开，内容惰性打开）。
   * 导出给 `/file/archive/:sessionID/archive.zip` 流式打包下载复用。
   */
  async archiveEntries(sources: string[]): Promise<ZipEntry[]> {
    const items = await this.collect(sources);
    return items.map((item) => ({
      name: item.name,
      modifiedAt: item.file.updated_at,
      data: item.isDir ? null : () => this.openFileStream(item.file),
    }));
  }

  /**
   * 把 `src` 打成 zip 写到 `dst`。
   *
   * 对应上游 `explorer.ArchiveWorkflowService` + `controllers.CreateArchive`。
   * 上游是建任务后台跑；这里同步跑完，返回时任务已经是 completed（或 error）。
   */
  async createArchive(args: { src: string[]; dst: string }): Promise<TaskRow> {
    const user = this.ctx.requireUser();
    if (!args.src.length) throw Err.param('src is required');
    if (!args.dst) throw Err.param('dst is required');

    const task = await this.ctx.tasks.create({
      type: 'create_archive',
      userId: user.id,
      publicState: { summary: { props: { src_multiple: args.src, dst: args.dst } } },
    });

    try {
      const items = await this.collect(args.src);
      const encoder = new TextEncoder();

      // store 模式下 zip 的最终大小可以精确算出来，上传会话一开始就要知道总长度
      let zipSize = 22;
      for (const item of items) {
        const nameLen = encoder.encode(item.name).length;
        zipSize += 30 + nameLen + (item.isDir ? 0 : item.file.size) + 16; // local + data + descriptor
        zipSize += 46 + nameLen; // central directory entry
      }
      if (zipSize > MAX_WORKFLOW_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Archive would be ${zipSize} bytes, which exceeds the ${MAX_WORKFLOW_BYTES} byte limit of a single edge request`,
        );
      }

      const entries: ZipEntry[] = items.map((item) => ({
        name: item.name,
        modifiedAt: item.file.updated_at,
        data: item.isDir ? null : () => this.openFileStream(item.file),
      }));

      await this.writeToUri(args.dst, zipSize, createZipStream(entries), 'application/zip');
      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: { props: { src_multiple: args.src, dst: args.dst, total: items.length } },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 远程下载
  // -------------------------------------------------------------------------

  /**
   * 把一个 HTTP(S) 地址的内容存到 `dst`。
   *
   * 对应上游 `explorer.DownloadWorkflowService` + `controllers.CreateRemoteDownload`。
   * 上游支持种子/磁力（走 aria2 从节点），边缘版只支持**直链** HTTP(S)。
   */
  async createRemoteDownload(args: { url: string; dst: string }): Promise<TaskRow> {
    const user = this.ctx.requireUser();
    if (!args.url) throw Err.param('url is required');
    if (!args.dst) throw Err.param('dst is required');

    // 服务端替用户去抓 URL，必须挡住内网/回环/云元数据（SSRF）。
    // 这里用的是带 CVE-2026-79913 修复的版本：会先拆开 NAT64 / 6to4 /
    // Teredo / IPv4-compatible 这些「IPv4 藏在 IPv6 里」的封装再判断。
    let parsed: URL;
    try {
      parsed = assertSafeRemoteUrl(args.url);
    } catch (e) {
      if (e instanceof UnsafeRemoteUrlError) {
        // magner/torrent 之类不是「不安全」，单独给一条更贴切的文案
        if (e.message === 'Only HTTP(S) links are supported') {
          throw new AppError(
            CodeFeatureNotEnabled,
            'Only HTTP(S) links are supported; torrents and magnet links need a slave node',
          );
        }
        throw Err.param(e.message);
      }
      throw Err.param('Invalid URL');
    }
    void parsed;

    const task = await this.ctx.tasks.create({
      type: 'remote_download',
      userId: user.id,
      publicState: { summary: { props: { src: args.url, dst: args.dst } } },
    });

    // 有具备 remoteDownload 能力的从节点就分派过去：文件大小不受
    // MAX_WORKFLOW_BYTES 限制，也不占 Worker 的 CPU 预算。
    // 分派失败（节点不可达等）不阻断任务 —— 回落到请求内执行。
    try {
      const dispatch = await dispatchRemoteDownload(this.ctx.env, {
        taskId: task.id,
        userId: user.id,
        url: args.url,
        dst: args.dst,
      });
      if (dispatch) {
        try {
          await markDispatched(this.ctx, task.id, dispatch);
          return (await this.ctx.tasks.byId(task.id))!;
        } catch (e) {
          // 节点已经在跑了，但主站没记下分派信息 → cron 永远不会同步它，
          // 任务会永远停在 queued。这种情况必须显式置错，让用户能看到原因，
          // 而不是看着一个永远不结束的任务。
          const message = e instanceof Error ? e.message : String(e);
          await this.ctx.tasks.updateStatus(task.id, 'error', {
            summary: {
              props: { src: args.url, dst: args.dst },
              error: `Dispatched to node ${dispatch.nodeId} but failed to record it: ${message}`,
            },
          });
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      console.error(
        `remote download dispatch failed, falling back to in-request execution: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }

    try {
      // 先 HEAD 拿长度；拿不到就按流式未知长度处理（上传会话必须要一个确定长度，
      // 所以这里退化为「先取到内存上限内」——超过上限直接报太大）
      const head = await safeFetch(args.url, { method: 'HEAD' }).catch(() => null);
      let declared = Number(head?.headers.get('content-length') ?? 0);
      // HEAD 拿不到长度时（常见，尤其 CDN/对象存储不回 content-length）再用一次
      // Range 探测 GET 取总大小；仍拿不到就明确报错 —— Worker 上传需要明确大小，
      // 不能默默以 0 字节落地成空文件，也绝不能绕过 MAX_WORKFLOW_BYTES 上限拉取超大文件。
      if (!declared) {
        const probe = await safeFetch(args.url, { method: 'GET', headers: { Range: 'bytes=0-0' } }).catch(() => null);
        const rangeTotal = probe?.headers.get('Content-Range')?.split('/')[1];
        declared = Number(rangeTotal ?? probe?.headers.get('content-length') ?? 0);
      }
      if (!declared || Number.isNaN(declared)) {
        throw new AppError(
          CodeFeatureNotEnabled,
          'Remote file size is unknown and cannot be downloaded',
        );
      }
      if (declared > MAX_WORKFLOW_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Remote file is ${declared} bytes, which exceeds the ${MAX_WORKFLOW_BYTES} byte limit`,
        );
      }

      const res = await safeFetch(args.url);
      if (!res.ok || !res.body) {
        throw new AppError(CodeFeatureNotEnabled, `Failed to fetch remote file: HTTP ${res.status}`);
      }

      await this.writeToUri(
        args.dst,
        declared,
        res.body as ReadableStream<Uint8Array>,
        res.headers.get('content-type') ?? undefined,
      );
      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: { props: { src: args.url, dst: args.dst, total: declared } },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 解压
  // -------------------------------------------------------------------------

  /**
   * 把一个 ZIP 解到 `dst` 目录。
   *
   * 对应上游 `ArchiveWorkflowService.CreateExtractTask`。ZIP 通过驱动 Range
   * 分段读取（EOCD / 中央目录 / 逐条目），不整包载内存；解压用运行时原生
   * `DecompressionStream('deflate-raw')`，store/deflate 之外的压缩方法、
   * 加密条目、ZIP64 明确报错。同步跑完，返回时任务已是 completed（或 error）。
   */
  async extractArchive(args: {
    src: string[];
    dst: string;
    encoding?: string;
    password?: string;
  }): Promise<TaskRow> {
    const user = this.ctx.requireUser();
    if (!args.src?.length) throw Err.param('src is required');
    if (!args.dst) throw Err.param('dst is required');
    if (args.password) {
      throw new AppError(
        CodeFeatureNotEnabled,
        'Password-protected archives are not supported',
      );
    }

    const task = await this.ctx.tasks.create({
      type: 'extract_archive',
      userId: user.id,
      publicState: { summary: { props: { src: args.src[0], dst: args.dst } } },
    });

    try {
      const srcUri = URI.parse(args.src[0]!);
      const file = await this.fs.mustResolve(srcUri);
      if (file.type === FileType.Folder) throw Err.param('Cannot extract a folder');
      if (!file.primary_entity) {
        throw new AppError(CodeFeatureNotEnabled, `File "${file.name}" has no entity`);
      }
      const entity = await this.ctx.entities.byId(file.primary_entity);
      if (!entity) throw new AppError(CodeFeatureNotEnabled, 'Entity is missing');
      const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
      if (!policy) throw Err.policyNotAllowed();
      if (entity.size > MAX_EXTRACT_ZIP_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Archive is ${entity.size} bytes, which exceeds the ${MAX_EXTRACT_ZIP_BYTES} byte limit of a single edge request`,
        );
      }

      const driver = this.ctx.driverFor(policy);
      const read: RangeReader = async (start, end) => {
        const content = await driver.get(entity.source, `bytes=${start}-${end}`);
        if (!content) throw new ZipError(`Failed to read range ${start}-${end}`);
        return drain(content.body as ReadableStream<Uint8Array>);
      };

      const entries = await readCentralDirectory(read, entity.size, nameDecoder(args.encoding));

      const fileEntries = entries.filter((e) => !e.isDir);
      const dirEntries = entries.filter((e) => e.isDir);
      const total = fileEntries.length + dirEntries.length;
      if (total > MAX_WORKFLOW_ENTRIES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Archive has ${total} entries, which exceeds the ${MAX_WORKFLOW_ENTRIES} entry limit`,
        );
      }
      const totalBytes = fileEntries.reduce((n, e) => n + e.size, 0);
      if (totalBytes > MAX_WORKFLOW_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Archive expands to ${totalBytes} bytes, which exceeds the ${MAX_WORKFLOW_BYTES} byte limit`,
        );
      }

      const dstUri = URI.parse(args.dst);
      const madeDirs = new Set<string>();
      const ensureDir = async (segs: string[]): Promise<void> => {
        for (let i = 1; i <= segs.length; i += 1) {
          const partial = segs.slice(0, i);
          const key = partial.join('/');
          if (madeDirs.has(key)) continue;
          await this.fs.create(dstUri.join(...partial), 'folder');
          madeDirs.add(key);
        }
      };

      // 目录条目先建，保证空目录也不丢
      for (const entry of dirEntries) {
        const segs = safeEntryPath(entry.name);
        if (!segs) continue; // 非法路径（穿越/绝对路径），跳过
        await ensureDir(segs);
      }

      let extracted = 0;
      let skipped = 0;
      for (const entry of fileEntries) {
        const segs = safeEntryPath(entry.name);
        if (!segs) {
          skipped += 1;
          continue;
        }
        if (entry.size > MAX_EXTRACT_ENTRY_BYTES) {
          throw new AppError(
            CodeFeatureNotEnabled,
            `Entry "${entry.name}" is ${entry.size} bytes, exceeding the ${MAX_EXTRACT_ENTRY_BYTES} byte per-entry limit`,
          );
        }
        await ensureDir(segs.slice(0, -1));
        const data = entry.size === 0 ? new Uint8Array(0) : await readEntry(read, entry);
        await this.writeToUri(dstUri.join(...segs).toString(), entry.size, bytesToStream(data));
        extracted += 1;
      }

      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: {
          props: { src: args.src[0], dst: args.dst, total, extracted, skipped },
        },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 导入
  // -------------------------------------------------------------------------

  /**
   * 从存储策略批量导入已有对象：只建文件/实体引用，**不搬数据**，
   * 对象留在原位继续由同一策略服务。
   *
   * 对应上游 `ImportWorkflowService`（管理后台的「导入文件」）。要求驱动
   * 支持 ListObjectsV2（S3 兼容家族）；`recursive=false` 时只导前缀下
   * 第一层对象。管理员可用 `targetUserId` 导入到任意用户盘，普通用户
   * 只能导给自己。
   */
  async createImport(args: {
    src: string;
    dst: string;
    policyId: number;
    targetUserId?: number | null;
    recursive?: boolean;
  }): Promise<TaskRow> {
    const actor = this.ctx.requireUser();
    if (!args.src) throw Err.param('src is required');
    if (!args.dst) throw Err.param('dst is required');

    const targetId =
      this.ctx.isAdmin && args.targetUserId ? args.targetUserId : actor.id;
    const target = await this.ctx.users.byIdWithGroup(targetId);
    if (!target) throw new AppError(404, 'Target user not found');

    const policy = await this.ctx.policies.byId(args.policyId);
    if (!policy) throw Err.policyNotAllowed();
    const driver = this.ctx.driverFor(policy);
    if (typeof driver.list !== 'function') {
      throw new AppError(
        CodeFeatureNotEnabled,
        `Storage policy type "${policy.type}" does not support listing objects`,
      );
    }

    const task = await this.ctx.tasks.create({
      type: 'import',
      userId: actor.id,
      publicState: {
        summary: { props: { src: args.src, dst: args.dst, policy_id: policy.id } },
      },
    });

    try {
      // 列举对象（分页拉全量，受条目数 / 总大小双重上限约束）
      const effectivePrefix = args.src.endsWith('/') || args.src === '' ? args.src : `${args.src}/`;
      const objects: { key: string; size: number }[] = [];
      let continuation: string | null = null;
      let truncated = false;
      do {
        const page = await driver.list(effectivePrefix, {
          continuation: continuation ?? undefined,
          limit: 1000,
        });
        for (const obj of page.keys) {
          if (obj.key.endsWith('/')) continue; // 目录占位对象
          let rel = effectivePrefix ? obj.key.slice(effectivePrefix.length) : obj.key;
          if (!rel || rel.startsWith('/')) continue;
          if (!args.recursive && rel.includes('/')) continue;
          objects.push({ key: obj.key, size: obj.size });
          if (objects.length >= MAX_WORKFLOW_ENTRIES) {
            truncated = true;
            break;
          }
        }
        continuation = truncated ? null : page.continuation;
      } while (continuation);
      if (!objects.length) {
        throw new AppError(CodeFeatureNotEnabled, 'No objects found under the given path');
      }

      const totalBytes = objects.reduce((n, o) => n + o.size, 0);
      if (totalBytes > MAX_IMPORT_BYTES) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Import totals ${totalBytes} bytes, exceeding the ${MAX_IMPORT_BYTES} byte limit`,
        );
      }

      // 容量预检（与上传同一语义：max_storage 0 = 不限）
      const maxStorage = target.group?.max_storage ?? 0;
      if (maxStorage > 0 && target.storage + totalBytes > maxStorage) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Import needs ${totalBytes} bytes but only ${Math.max(0, maxStorage - target.storage)} are available`,
        );
      }

      // 逐条建目录 + 文件 + 实体引用
      const dstUri = URI.parse(args.dst);
      const base = await this.ctx.files.resolvePath(target.id, dstUri.elements);
      if (!base) throw new AppError(40016, 'Destination folder does not exist');

      const dirIds = new Map<string, number>();
      const ensureDir = async (segs: string[]): Promise<number> => {
        let parent = base;
        let key = '';
        for (let i = 0; i < segs.length; i += 1) {
          const seg = segs[i]!;
          key = key ? `${key}/${seg}` : seg;
          const cached = dirIds.get(key);
          if (cached) {
            parent = (await this.ctx.files.byId(cached)) ?? parent;
            continue;
          }
          const existing = await this.ctx.files.resolvePath(target.id, [
            ...dstUri.elements,
            ...segs.slice(0, i + 1),
          ]);
          const row =
            existing ??
            (await this.ctx.files.create({
              type: FileType.Folder,
              name: seg,
              ownerId: target.id,
              parentId: parent.id,
              policyId: policy.id,
            }));
          dirIds.set(key, row.id);
          parent = row;
        }
        return parent.id;
      };

      let imported = 0;
      for (const obj of objects) {
        const segs = safeEntryPath(obj.key.slice(effectivePrefix.length)) ?? [];
        if (!segs.length) continue;
        const parentId = segs.length > 1 ? await ensureDir(segs.slice(0, -1)) : base.id;
        const entity = await this.ctx.entities.create({
          type: EntityType.Version,
          source: obj.key,
          size: obj.size,
          policyId: policy.id,
          createdBy: target.id,
        });
        const file = await this.ctx.files.create({
          type: FileType.File,
          name: segs[segs.length - 1]!,
          ownerId: target.id,
          parentId,
          size: obj.size,
          policyId: policy.id,
          primaryEntity: entity.id,
        });
        await this.ctx.entities.linkFile(file.id, entity.id);
        imported += 1;
      }

      // 容量记账：导入的对象同样占用目标用户配额。
      // 走数据库原子预占 —— 导入是批量写，先查后记在并发导入下会一起突破上限。
      const quotaLimit = target.group?.max_storage ?? 0;
      const reserved = await this.ctx.users.reserveStorage(
        target.id,
        totalBytes,
        quotaLimit > 0 ? quotaLimit : null,
      );
      if (!reserved) {
        throw new AppError(
          CodeFeatureNotEnabled,
          `Import needs ${totalBytes} bytes but the destination quota is insufficient`,
        );
      }

      await this.ctx.tasks.updateStatus(task.id, 'completed', {
        summary: {
          props: {
            src: args.src,
            dst: args.dst,
            policy_id: policy.id,
            imported,
            total: objects.length,
            truncated,
          },
        },
      });
      return (await this.ctx.tasks.byId(task.id))!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.ctx.tasks.updateStatus(task.id, 'error', {
        error: message,
        error_history: [message],
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 把来源 URI 展开成扁平的条目列表（目录递归展开）。 */
  private async collect(sources: string[]): Promise<ArchiveItem[]> {
    const items: ArchiveItem[] = [];
    for (const raw of sources) {
      const uri = URI.parse(raw);
      const file = await this.fs.mustResolve(uri);
      if (file.type === FileType.Folder) {
        items.push({ name: `${file.name}/`, file, isDir: true });
        await this.walk(file.id, file.name, items);
      } else {
        items.push({ name: file.name, file, isDir: false });
      }
    }
    return items;
  }

  private async walk(folderId: number, prefix: string, out: ArchiveItem[]): Promise<void> {
    const ownerId = this.ctx.requireUser().id;
    let page = 0;
    for (;;) {
      const { files, total } = await this.ctx.files.list({
        parentId: folderId,
        ownerId,
        page,
        pageSize: LIST_PAGE_SIZE,
        orderBy: 'name',
        orderDirection: 'asc',
      });
      for (const file of files) {
        const childPath = `${prefix}/${file.name}`;
        if (file.type === FileType.Folder) {
          out.push({ name: `${childPath}/`, file, isDir: true });
          await this.walk(file.id, childPath, out);
        } else {
          out.push({ name: childPath, file, isDir: false });
        }
      }
      if ((page + 1) * LIST_PAGE_SIZE >= total) break;
      page += 1;
    }
  }

  /** 打开文件的实体内容流。惰性调用 —— 只有轮到这个条目时才真的去对象存储取。 */
  private async openFileStream(file: FileRow): Promise<ReadableStream<Uint8Array>> {
    if (!file.primary_entity) {
      throw new AppError(CodeFeatureNotEnabled, `File "${file.name}" has no entity`);
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeFeatureNotEnabled, `Entity of "${file.name}" is missing`);
    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const content = await this.ctx.driverFor(policy).get(entity.source, null);
    if (!content) {
      throw new AppError(CodeFeatureNotEnabled, `Object of "${file.name}" is missing in storage`);
    }
    // 加密实体：打包/压缩进 zip 前先还原明文，否则用户拿到的是密文。
    if (entity.enc_meta) {
      let meta: EncryptMetadata;
      try {
        meta = JSON.parse(entity.enc_meta) as EncryptMetadata;
      } catch {
        throw new AppError(50002, 'Corrupted encryption metadata');
      }
      const { key, iv } = await importCtrKey(meta, 'decrypt');
      return decryptStream(content.body as ReadableStream<Uint8Array>, key, iv);
    }
    return content.body as ReadableStream<Uint8Array>;
  }

  /**
   * 把一段已知长度的字节流写进用户的文件系统。
   *
   * 走的是正规上传链路（`UploadService`），所以容量校验、策略约束、实体转正、
   * 版本保留这些都和客户端上传完全一致 —— 不做绕过这些检查的「直写」。
   *
   * 分片大小必须和上传会话声明的一致（`expectedChunkLength` 会严格校验），
   * 所以这里按会话给的 `chunk_size` 切分后再逐片提交。
   */
  private async writeToUri(
    uri: string,
    size: number,
    source: ReadableStream<Uint8Array>,
    mimeType?: string,
  ): Promise<void> {
    const upload = new UploadService(this.ctx, this.fs);
    const session = await upload.createSession({ uri, size, mimeType });

    const chunkSize = session.chunk_size > 0 ? session.chunk_size : size;
    const totalChunks = chunkSize > 0 ? Math.max(1, Math.ceil(size / chunkSize)) : 1;
    const expectedFor = (index: number): number =>
      chunkSize > 0 ? (index === totalChunks - 1 ? size - index * chunkSize : chunkSize) : size;

    const reader = source.getReader();
    // 跨分片边界的剩余字节
    let carry: Uint8Array[] = [];
    let carryLen = 0;

    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const want = expectedFor(index);

        while (carryLen < want) {
          const { done, value } = await reader.read();
          if (done) {
            throw new AppError(
              CodeFeatureNotEnabled,
              `Source stream ended early: expected ${size} bytes, got ${carryLen}`,
            );
          }
          carry.push(value as Uint8Array);
          carryLen += (value as Uint8Array).length;
        }

        // 精确取 want 个字节，多出来的留到下一片
        const parts: Uint8Array[] = [];
        let taken = 0;
        while (taken < want) {
          const first = carry[0]!;
          if (first.length <= want - taken) {
            parts.push(carry.shift()!);
            taken += first.length;
          } else {
            const need = want - taken;
            parts.push(first.subarray(0, need));
            carry[0] = first.subarray(need);
            taken = want;
          }
        }
        carryLen -= want;

        await upload.uploadChunk(
          session.session_id,
          index,
          bytesToStream(concatBytes(parts)) as ReadableStream,
          want,
        );
      }
    } catch (e) {
      // 失败要把占位实体清掉，否则用户目录里会留下一个 0 字节的幽灵文件
      await upload.deleteSession(session.session_id, uri).catch(() => undefined);
      throw e;
    }
  }
}
