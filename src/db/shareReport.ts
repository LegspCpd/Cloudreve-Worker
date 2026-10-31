/**
 * 分享举报数据访问（edge 自建 Pro 功能：分享举报处理）。
 * 表结构见 migrations/0015_share_report.sql。所有写路径过滤 deleted_at。
 */
import { getSql, toDate, toNum, toNumOrNull, type Sql } from './index';

export type ShareReportStatus = 'pending' | 'resolved' | 'ignored';
export type ShareReportReason =
  | 'illegal'
  | 'porn'
  | 'violence'
  | 'fraud'
  | 'copyright'
  | 'other';

export interface ShareReportRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  share_id: number;
  reporter_id: number | null;
  reason: string;
  detail: string | null;
  status: ShareReportStatus;
  handled_by: number | null;
  handled_at: Date | null;
}

function normalize(r: Record<string, unknown>): ShareReportRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    share_id: toNum(r.share_id),
    reporter_id: toNumOrNull(r.reporter_id),
    reason: String(r.reason ?? 'other'),
    detail: (r.detail as string) ?? null,
    status: (String(r.status ?? 'pending') as ShareReportStatus),
    handled_by: toNumOrNull(r.handled_by),
    handled_at: toDate(r.handled_at),
  };
}

export class ShareReportRepo {
  private sql: Sql;
  constructor(env: import('../env').Env) {
    this.sql = getSql(env);
  }

  async create(args: {
    shareId: number;
    reporterId: number | null;
    reason: string;
    detail?: string | null;
  }): Promise<ShareReportRow> {
    const rows = (await this.sql`
      INSERT INTO share_reports (share_id, reporter_id, reason, detail)
      VALUES (${args.shareId}, ${args.reporterId}, ${args.reason}, ${args.detail ?? null})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalize(rows[0]!);
  }

  /** 同一用户对同一分享的待处理举报：用于防刷（一分享一待处理举报）。 */
  async pendingByUser(shareId: number, reporterId: number): Promise<ShareReportRow | null> {
    const rows = (await this.sql`
      SELECT * FROM share_reports
      WHERE share_id = ${shareId} AND reporter_id = ${reporterId} AND status = 'pending'
        AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalize(rows[0]) : null;
  }

  async list(
    page: number,
    pageSize: number,
    status?: ShareReportStatus,
  ): Promise<{ items: ShareReportRow[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const rows = status
      ? ((await this.sql`
          SELECT * FROM share_reports
          WHERE deleted_at IS NULL AND status = ${status}
          ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}
        `) as Record<string, unknown>[])
      : ((await this.sql`
          SELECT * FROM share_reports
          WHERE deleted_at IS NULL
          ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}
        `) as Record<string, unknown>[]);
    const cnt = status
      ? ((await this.sql`
          SELECT COUNT(*)::int AS c FROM share_reports
          WHERE deleted_at IS NULL AND status = ${status}
        `) as { c: number }[])
      : ((await this.sql`
          SELECT COUNT(*)::int AS c FROM share_reports
          WHERE deleted_at IS NULL
        `) as { c: number }[]);
    return { items: rows.map(normalize), total: Number(cnt[0]?.c ?? 0) };
  }

  async byId(id: number): Promise<ShareReportRow | null> {
    const rows = (await this.sql`
      SELECT * FROM share_reports WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalize(rows[0]) : null;
  }

  async resolve(id: number, status: ShareReportStatus, handledBy: number): Promise<void> {
    await this.sql`
      UPDATE share_reports
      SET status = ${status}, handled_by = ${handledBy}, handled_at = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
    `;
  }
}
