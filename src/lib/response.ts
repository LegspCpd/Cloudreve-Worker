/**
 * 统一响应封装。对应 Cloudreve v4 的 `pkg/serializer/response.go`。
 *
 * 关键行为（已回源码核对 `routers/controllers/main.go`）：
 *   - 业务错误一律以 **HTTP 200** 返回，错误信息放在正文的 `code` 字段里。
 *     只有 302 重定向、SSE 与文件流不走这个信封。
 *   - `msg` 字段始终存在（成功时为空串）。
 *   - `data` / `error` / `aggregated_error` / `correlation_id` 按 omitempty 省略。
 */
import type { Context } from 'hono';
import { AppError, CodeDBError, CodeNotSet, CodeParamErr } from './errors';
import { isUpstream5xxError, isRateLimitError } from '../db';

export interface Envelope<T = unknown> {
  code: number;
  data?: T;
  aggregated_error?: unknown;
  msg: string;
  error?: string;
  correlation_id?: string;
}

/** 成功响应：`{ code: 0, data, msg: "" }` */
export function ok<T>(c: Context, data?: T): Response {
  const body: Envelope<T> = { code: 0, msg: '' };
  if (data !== undefined) {
    body.data = data;
  }
  return jsonResponse(c, body);
}

/**
 * 显式带 code 的成功/部分成功响应（原版用 203 CodeNotFullySuccess 表示
 * 「注册成功但需要邮件激活」这类语义）。
 */
export function okWithCode<T>(c: Context, code: number, data?: T): Response {
  const body: Envelope<T> = { code, msg: '' };
  if (data !== undefined) {
    body.data = data;
  }
  return jsonResponse(c, body);
}

/**
 * 错误响应。镜像原版 `serializer.ErrWithDetails`：
 *   - 底层是 AppError 时，取其 code 与 msg；
 *   - 非生产模式下附加 `error` 明细；
 *   - status 仅在原版确实返回非 200 时使用（如 /f/ 直链不存在回 404）。
 *
 * 特例：数据库上游（Neon 网关）返回 5xx / 限流时，不再把驱动的英文原文塞进
 * `msg` —— 前端 `errors[50001]` 的渲染结果是「数据库操作失败 ({{message}})」，
 * 直接把 `Server error (HTTP status 520): ...` 拼进去，用户看到的是一句
 * 既看不懂、又误导（以为是数据库本身坏了）的话。这种情况改用可读文案，
 * 并把原始信息留在 `error` 里便于排查。
 */
export function fail(c: Context, err: unknown, status: 200 | 404 = 200): Response {
  let code = CodeNotSet;
  let msg = '';
  let raw: unknown = err;

  if (err instanceof AppError) {
    code = err.code;
    msg = err.msg;
    raw = err.raw;
  } else if (err instanceof Error) {
    code = CodeDBError;
    if (isRateLimitError(err) || isUpstream5xxError(err)) {
      // 上游瞬态抖动。fetch 层已重试过仍失败，说明这一波确实过不去。
      // 文案要能塞进前端的 `数据库操作失败 ({{message}})` 模板里读通顺，
      // 所以写成名词短语、不带句号，也不直译驱动的英文原文。
      msg = 'upstream temporarily unavailable, please retry';
    } else {
      msg = err.message;
    }
  } else if (typeof err === 'string') {
    msg = err;
  }

  const body: Envelope = { code, msg };
  if (raw !== undefined && raw !== null && !isProduction(c)) {
    // postgres.js 的错误带 detail（如 `Key (group_users)=(2) is not present in
    // table "groups"`），拼进来才能从一次报错里直接定位数据问题。
    const detail = (raw as { detail?: string })?.detail;
    const base = raw instanceof Error ? raw.message : String(raw);
    body.error = detail ? `${base} | ${detail}` : base;
  }
  const cid = c.get('correlationId');
  if (typeof cid === 'string' && cid) {
    body.correlation_id = cid;
  }
  return jsonResponse(c, body, status);
}

/** 参数错误快捷方式。 */
export function paramError(c: Context, msg = 'Invalid parameters.'): Response {
  return fail(c, new AppError(CodeParamErr, msg));
}

function isProduction(c: Context): boolean {
  // 默认按生产处理：只有显式声明 development / dev 才把内部错误原文回显。
  // 原来「非 production 就回显」，而三个平台的配置都没有 ENVIRONMENT，
  // 等于默认开着调试回显（DB 错误 detail、驱动原文、表名）。
  const mode = (c.env as { ENVIRONMENT?: string } | undefined)?.ENVIRONMENT;
  return mode !== 'development' && mode !== 'dev';
}

function jsonResponse(c: Context, body: Envelope, status: 200 | 404 = 200): Response {
  // 与原版一致：默认 HTTP 200 + 自定义业务码；仅个别路径（/f/ 404）用非 200
  const res = c.json(body as never, status);
  // 禁止任何层（浏览器、CF 边缘）缓存 API 信封：曾因缓存了修复前返回的
  // 字符串版 custom_nav_items，导致前端对字符串 .map 一直报错。
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res;
}
