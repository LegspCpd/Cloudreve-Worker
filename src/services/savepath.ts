/**
 * 物理对象键生成。对应 Cloudreve v4 的 `util.ReplaceMagicVar`
 * （`pkg/util/common.go`）与 `dbfs.generateSavePath`。
 *
 * 支持的魔法变量（逐字对齐原版实现）：
 *   {randomkey16} {randomkey8} {timestamp} {timestamp_nano}
 *   {randomnum2} {randomnum3} {randomnum4} {randomnum8}
 *   {uid} {datetime} {date} {year} {month} {day} {hour} {minute} {second}
 *   {uuid} {ext} {originname} {originname_without_ext} {path}
 *
 * 默认规则（原版 `inventory/migration.go`）：
 *   dir_name_rule  = "uploads/{uid}/{path}"
 *   file_name_rule = "{uid}_{randomkey8}_{originname}"
 */
import { randomString } from '../lib/crypto';

export const DEFAULT_DIR_RULE = 'uploads/{uid}/{path}';
export const DEFAULT_NAME_RULE = '{uid}_{randomkey8}_{originname}';

export interface MagicVarContext {
  uid: number;
  originName: string;
  /** 文件在网盘中的目录路径，以 `/` 结尾（如 `/docs/`）；根目录为空串 */
  originPath: string;
  now?: Date;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function randomNum(max: number): string {
  return String(Math.floor(Math.random() * max));
}

/** 去掉扩展名。与原版 filepath.Ext 的语义一致：取最后一个 `.` 之后的部分。 */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx);
}

function withoutExt(name: string): string {
  const e = extOf(name);
  return e ? name.slice(0, -e.length) : name;
}

export function replaceMagicVar(rule: string, ctx: MagicVarContext, pathAvailable: boolean): string {
  const now = ctx.now ?? new Date();
  return rule.replace(/\{[^{}]+\}/g, (match) => {
    switch (match) {
      case '{randomkey16}':
        return randomString(16);
      case '{randomkey8}':
        return randomString(8);
      case '{timestamp}':
        return String(Math.floor(now.getTime() / 1000));
      case '{timestamp_nano}':
        return String(now.getTime() * 1_000_000);
      case '{randomnum2}':
        return randomNum(2);
      case '{randomnum3}':
        return randomNum(3);
      case '{randomnum4}':
        return randomNum(4);
      case '{randomnum8}':
        return randomNum(8);
      case '{uid}':
        return String(ctx.uid);
      case '{datetime}':
        return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
      case '{date}':
        return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
      case '{year}':
        return String(now.getUTCFullYear());
      case '{month}':
        return pad(now.getUTCMonth() + 1);
      case '{day}':
        return pad(now.getUTCDate());
      case '{hour}':
        return pad(now.getUTCHours());
      case '{minute}':
        return pad(now.getUTCMinutes());
      case '{second}':
        return pad(now.getUTCSeconds());
      case '{uuid}':
        return crypto.randomUUID();
      case '{ext}':
        return extOf(ctx.originName);
      case '{originname}':
        return ctx.originName;
      case '{originname_without_ext}':
        return withoutExt(ctx.originName);
      case '{path}':
        return pathAvailable ? ctx.originPath : match;
      default:
        return match;
    }
  });
}

/**
 * 生成对象键。`dirRule` / `nameRule` 取自策略，为空时用原版默认值。
 */
export function generateSavePath(
  policy: { dir_name_rule: string | null; file_name_rule: string | null },
  ctx: MagicVarContext,
): string {
  const dirRule = normalizeSlashes(policy.dir_name_rule || DEFAULT_DIR_RULE);
  const nameRule = normalizeSlashes(policy.file_name_rule || DEFAULT_NAME_RULE);

  const dir = replaceMagicVar(dirRule, ctx, true);
  const name = replaceMagicVar(nameRule, ctx, false);

  return joinAndClean(dir, name);
}

/** 把 Windows 风格反斜杠统一成正斜杠（原版用 filepath.ToSlash）。 */
function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, '/');
}

// safeDecodePath 的实现与说明在 lib/paths.ts；这里 re-export 供 savepath
// 的既有调用方（上传链路）使用。
export { safeDecodePath } from '../lib/paths';

/** 等价于 Go 的 `path.Join(path.Clean(dir), name)`。 */
function joinAndClean(dir: string, name: string): string {
  const joined = `${dir.replace(/\/+$/, '')}/${name}`;
  const segments: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}
