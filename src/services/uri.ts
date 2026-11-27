/**
 * 文件系统 URI。对应 Cloudreve v4 的 `pkg/filemanager/fs/uri.go`。
 *
 * 格式（scheme 后的 host 段就是文件系统类型）：
 *   cloudreve://my/<path>                        本人空间
 *   cloudreve://<userHashid>@my/<path>           带所有者的本人空间
 *   cloudreve://<shareHashid>@share/<path>       分享空间
 *   cloudreve://<shareHashid>:<password>@share/<path>  带密码的分享
 *   cloudreve://trash/<name>                     回收站
 *   cloudreve://shared_with_me/<fileHashid>      「分享给我」
 *
 * 解析规则与原版逐条对齐：
 *   - 非 cloudreve scheme 直接报错；
 *   - 路径去掉末尾多余的 `/`，但保留根路径 `/`；
 *   - `Path()` 会补前导 `/` 并做一次路径规整；
 *   - `Elements()` 按 `/` 切分，根目录返回空数组。
 */

export const SCHEME = 'cloudreve';

export const FileSystemType = {
  My: 'my',
  Share: 'share',
  Trash: 'trash',
  SharedWithMe: 'shared_with_me',
  Unknown: 'unknown',
} as const;

export type FileSystemTypeValue = (typeof FileSystemType)[keyof typeof FileSystemType];

export class URI {
  constructor(
    /** 文件系统类型（原 URL 的 host 段） */
    readonly fsType: string,
    /** userinfo 的 username 部分：所有者 hashid 或分享 hashid */
    readonly id: string,
    /** userinfo 的 password 部分：分享密码 */
    readonly password: string,
    /** 规整后的路径，始终以 `/` 开头 */
    readonly path: string,
    /** 搜索 / 过滤用的原始 query 参数 */
    readonly query: URLSearchParams,
  ) {}

  static parse(raw: string): URI {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid URI: ${raw}`);
    }
    if (parsed.protocol !== `${SCHEME}:`) {
      throw new Error(`Unknown scheme: ${parsed.protocol}`);
    }

    const fsType = parsed.hostname.toLowerCase();
    const id = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';

    return new URI(fsType, id, password, normalizePath(parsed.pathname), new URLSearchParams(parsed.search));
  }

  /** 与 `parse` 相同，但解析失败时返回 `null` 而不抛错。 */
  static tryParse(raw: string): URI | null {
    try {
      return URI.parse(raw);
    } catch {
      return null;
    }
  }

  static my(path = '/'): URI {
    return new URI(FileSystemType.My, '', '', normalizePath(path), new URLSearchParams());
  }

  static trash(path = '/'): URI {
    return new URI(FileSystemType.Trash, '', '', normalizePath(path), new URLSearchParams());
  }

  /**
   * 「分享给我」的根：`cloudreve://shared_with_me`。
   * 注意：这个文件系统是一棵**扁平树**，只有根可访问；子项 URI 用
   * `sharedWithMeFile()` 生成，仅用于展示。
   */
  static sharedWithMe(): URI {
    return new URI(FileSystemType.SharedWithMe, '', '', '/', new URLSearchParams());
  }

  /**
   * 「分享给我」里某个符号文件的展示 URI。
   * 对应原版 `dbfs.newSharedWithMeUri(id)`：`cloudreve://shared_with_me/<fileHashid>`，
   * hashid 在**路径段**里，不是 userinfo。
   */
  static sharedWithMeFile(hashid: string): URI {
    return new URI(
      FileSystemType.SharedWithMe,
      '',
      '',
      normalizePath(`/${hashid}`),
      new URLSearchParams(),
    );
  }

  static share(id: string, password = '', path = '/'): URI {
    return new URI(FileSystemType.Share, id, password, normalizePath(path), new URLSearchParams());
  }

  /** 路径分段；根目录返回空数组。 */
  get elements(): string[] {
    if (this.path === '/') return [];
    return this.path
      .slice(1)
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => safeDecode(s));
  }

  get isRoot(): boolean {
    return this.path === '/';
  }

  /** 路径最后一段。根目录返回空串。对应原版 `fs.URI.Name()`。 */
  get name(): string {
    const els = this.elements;
    return els.length > 0 ? els[els.length - 1]! : '';
  }

  /** 当前目录的完整字符串表示。 */
  toString(): string {
    const userinfo = this.id ? `${encodeURIComponent(this.id)}${this.password ? `:${this.password}` : ''}@` : '';
    const qs = this.query.toString();
    return `${SCHEME}://${userinfo}${this.fsType}${this.path}${qs ? `?${qs}` : ''}`;
  }

  /** 取根 URI（路径归为 `/`，清空 query）。 */
  root(): URI {
    return new URI(this.fsType, this.id, this.password, '/', new URLSearchParams());
  }

  /** 与其它路径段拼接。 */
  join(...segments: string[]): URI {
    const parts = [this.path === '/' ? '' : this.path, ...segments.map((s) => encodeURIComponent(s))];
    return new URI(
      this.fsType,
      this.id,
      this.password,
      normalizePath(parts.join('/')),
      this.query,
    );
  }

  /** 在当前目录下取子节点 URI。 */
  child(name: string): URI {
    return this.join(name);
  }

  /** 把路径替换成另一条（用于把「用户视角路径」换成「所有者视角路径」）。 */
  withPath(path: string): URI {
    return new URI(this.fsType, this.id, this.password, normalizePath(path), this.query);
  }

  /** 带查询串的新 URI。 */
  withQuery(query: URLSearchParams): URI {
    return new URI(this.fsType, this.id, this.password, this.path, query);
  }

  /** 父目录 URI；已在根目录时返回自身。 */
  parent(): URI {
    if (this.isRoot) return this;
    const idx = this.path.lastIndexOf('/');
    const parentPath = idx <= 0 ? '/' : this.path.slice(0, idx);
    return this.withPath(parentPath);
  }
}

/**
 * 把外部可控的路径段拼到 base 下，并断言归一化后仍在 base 内。
 *
 * 归档条目名等外部输入先过 safeEntryPath 拒绝 `..`/绝对路径；这是第二道：
 * 即便将来某个调用点漏了过滤，normalizePath 的 `..` pop 也不会把文件写到
 * 兄弟目录。对应上游 remoteDownloadDestination 的 EqualOrIsDescendantOf。
 */
export function joinUnder(base: URI, segments: string[]): URI | null {
  if (!segments.length) return null;
  const target = base.join(...segments);
  const root = base.path.endsWith('/') ? base.path : `${base.path}/`;
  if (!target.path.startsWith(root)) return null;
  return target;
}

/** 补前导斜杠并规整，同时保留根路径为 `/`。 */
function normalizePath(raw: string): string {
  let p = raw || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  // 去掉末尾多余斜杠，但保留根
  p = p.replace(/\/+$/, '');
  if (p === '') p = '/';
  // 折叠重复斜杠
  p = p.replace(/\/{2,}/g, '/');
  // 解析 . 与 ..
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** URI 上的搜索参数名。取自原版 `uri.go` 的常量表。 */
export const SearchQueryKeys = {
  name: 'name',
  nameOpOr: 'name_op_or',
  useOr: 'use_or',
  caseFolding: 'case_folding',
  type: 'type',
  category: 'category',
  sizeGte: 'size_gte',
  sizeLte: 'size_lte',
  createdGte: 'created_gte',
  createdLte: 'created_lte',
  updatedGte: 'updated_gte',
  updatedLte: 'updated_lte',
  metaPrefix: 'meta_',
  exactMetaPrefix: 'exact_meta_',
} as const;

/**
 * 文件名合法性校验。规则取自原版 `dbfs/validator.go`：
 * 长度 1–255（原版 MaxFileNameLength = 256，即最长 255 个字符），
 * 禁止 `\ / : * ? " < > |`，禁止单纯是 `.` 或 `..`。
 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;
export const MAX_FILE_NAME_LENGTH = 255;

export function validateName(name: string): string | null {
  if (!name) return 'File name cannot be empty';
  if (name.includes('\0')) return 'File name cannot contain NUL';
  if (name.length > MAX_FILE_NAME_LENGTH) {
    return `File name is too long, maximum length is ${MAX_FILE_NAME_LENGTH}`;
  }
  if (INVALID_NAME_CHARS.test(name)) {
    return `File name contains illegal characters: \\ / : * ? " < > |`;
  }
  if (name === '.' || name === '..') {
    return 'File name cannot be "." or ".."';
  }
  return null;
}
