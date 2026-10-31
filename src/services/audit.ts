/**
 * 审计日志（edge 自建 Pro 功能）。
 *
 * 前端管理「事件」页（Admin/Settings/Event/Events.tsx）按
 * `api/explorer.ts` 的 AuditLogType（0-61）渲染事件清单；本文件是同一份
 * 枚举的后端镜像 —— **两边的名字和数值必须一致**，前端靠数值反查名字
 * （getEventName）。上游闭源 Pro 的枚举顺序即以此为准。
 *
 * 写入：logAudit() 经 ctx.waitUntil 异步落库，不阻塞请求路径；
 * 开关：设置键 `audit_log_events`（JSON map 事件名 → bool，缺省视为开启）。
 */
import { AuditRepo } from '../db/audit';
import type { AppContext } from './context';
/** 与前端 `AuditLogType` 完全一致（数值不能变，改了历史日志就废了）。 */
export const AUDIT_LOG_TYPES = {
  server_start: 0,
  user_signup: 1,
  email_sent: 2,
  user_activated: 3,
  user_login_failed: 4,
  user_login: 5,
  user_token_refresh: 6,
  file_create: 7,
  file_rename: 8,
  set_file_permission: 9,
  entity_uploaded: 10,
  entity_downloaded: 11,
  copy_from: 12,
  copy_to: 13,
  move_to: 14,
  delete_file: 15,
  move_to_trash: 16,
  share: 17,
  share_link_viewed: 18,
  set_current_version: 19,
  delete_version: 20,
  thumb_generated: 21,
  live_photo_uploaded: 22,
  update_metadata: 23,
  edit_share: 24,
  delete_share: 25,
  mount: 26,
  relocate: 27,
  create_archive: 28,
  extract_archive: 29,
  webdav_login_failed: 30,
  webdav_account_create: 31,
  webdav_account_update: 32,
  webdav_account_delete: 33,
  payment_created: 34,
  points_change: 35,
  payment_paid: 36,
  payment_fulfilled: 37,
  payment_fulfill_failed: 38,
  storage_added: 39,
  group_changed: 40,
  user_exceed_quota_notified: 41,
  user_changed: 42,
  get_direct_link: 43,
  link_account: 44,
  unlink_account: 45,
  change_nick: 46,
  change_avatar: 47,
  membership_unsubscribe: 48,
  change_password: 49,
  enable_2fa: 50,
  disable_2fa: 51,
  add_passkey: 52,
  remove_passkey: 53,
  redeem_gift_code: 54,
  file_imported: 55,
  update_view: 56,
  delete_direct_link: 57,
  report_abuse: 58,
  oauth_grant_create: 59,
  oauth_token_exchange: 60,
  oauth_grant_revoke: 61,
  file_transfer: 62,
} as const;

export type AuditLogTypeName = keyof typeof AUDIT_LOG_TYPES;

/** 事件名 → 数值，用于把 logAudit('user_login') 落成 type=5。 */
const TYPE_IDS: Record<string, number> = AUDIT_LOG_TYPES;

/**
 * 读取事件开关。设置值是 JSON map（事件名 → bool），缺省/解析失败一律视为开启 ——
 * 与官方默认「全量记录」的语义一致；页面上的「全部勾选/取消」会显式写全量 map。
 */
export function auditEnabled(ctx: AppContext, name: AuditLogTypeName): boolean {
  try {
    const raw = ctx.settings.get('audit_log_events', '{}');
    const map = JSON.parse(raw) as Record<string, boolean>;
    if (map && typeof map === 'object' && name in map) return map[name] !== false;
  } catch {
    // 解析失败按全开处理，宁可多记不可漏记
  }
  return true;
}

/**
 * 记录一条审计事件。fire-and-forget：
 * - 开关关闭 → 直接返回（不查库）；
 * - 开关开启 → waitUntil 里插入，失败只打日志，不影响业务请求。
 *
 * @param name   事件名（AUDIT_LOG_TYPES 的键）
 * @param userId 操作者（未知传 null，如登录失败）
 * @param meta   附加信息（对象，落 JSONB；别放敏感值）
 */
export function logAudit(
  ctx: AppContext,
  name: AuditLogTypeName,
  userId: number | null,
  meta: Record<string, unknown> = {},
): void {
  if (!auditEnabled(ctx, name)) return;
  const type = TYPE_IDS[name];
  const repo = new AuditRepo(ctx.env);
  const p = repo.create({ user_id: userId, type, meta }).catch((e) => {
    console.error(`audit log ${name} failed:`, e);
  });
  ctx.waitUntil?.(p);
}
