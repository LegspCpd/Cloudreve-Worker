/**
 * 支付体系数据访问（orders / gift_codes，migrations/0005_payment.sql）。
 *
 * 对应上游闭源 Pro 的 order/giftcode inventory——上游结构不可得，
 * 这里按前端消费的形状自建。所有读路径都过滤 deleted_at。
 */
import { getSql, toDate, toJson, toNum, toNumOrNull, type Sql } from './index';
import type { GiftCodeRow, OrderRow, OrderStatus, VasProductType } from './types';

function normalizeOrder(r: Record<string, unknown>): OrderRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    user_id: toNum(r.user_id),
    order_no: String(r.order_no ?? ''),
    product_type: String(r.product_type ?? 'storage') as VasProductType,
    product_snapshot: toJson<Record<string, unknown>>(r.product_snapshot, {}),
    amount: toNum(r.amount),
    status: String(r.status ?? 'pending') as OrderStatus,
    provider: String(r.provider ?? ''),
    provider_trade_no: (r.provider_trade_no as string) ?? null,
    paid_at: toDate(r.paid_at),
    fulfilled_at: toDate(r.fulfilled_at),
    error: (r.error as string) ?? null,
  };
}

function normalizeGiftCode(r: Record<string, unknown>): GiftCodeRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    code: String(r.code ?? ''),
    product_type: String(r.product_type ?? 'storage') as VasProductType,
    product_payload: toJson<Record<string, unknown>>(r.product_payload, {}),
    batch: (r.batch as string) ?? null,
    used_by: toNumOrNull(r.used_by),
    used_at: toDate(r.used_at),
  };
}

export class OrderRepo {
  private sql: Sql;
  constructor(env: import('../env').Env) {
    this.sql = getSql(env);
  }

  async create(args: {
    user_id: number;
    order_no: string;
    product_type: VasProductType;
    product_snapshot: Record<string, unknown>;
    amount: number;
    provider: string;
  }): Promise<OrderRow> {
    const rows = (await this.sql`
      INSERT INTO orders (user_id, order_no, product_type, product_snapshot, amount, provider)
      VALUES (${args.user_id}, ${args.order_no}, ${args.product_type},
              ${JSON.stringify(args.product_snapshot)}::jsonb, ${args.amount}, ${args.provider})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeOrder(rows[0]!);
  }

  async byOrderNo(orderNo: string): Promise<OrderRow | null> {
    const rows = (await this.sql`
      SELECT * FROM orders WHERE order_no = ${orderNo} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeOrder(rows[0]) : null;
  }

  async byId(id: number): Promise<OrderRow | null> {
    const rows = (await this.sql`
      SELECT * FROM orders WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeOrder(rows[0]) : null;
  }

  /** 某用户的订单（分页，倒序）。 */
  async listByUser(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<{ items: OrderRow[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const rows = (await this.sql`
      SELECT * FROM orders WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}
    `) as Record<string, unknown>[];
    const cnt = (await this.sql`
      SELECT COUNT(*)::int AS c FROM orders WHERE user_id = ${userId} AND deleted_at IS NULL
    `) as { c: number }[];
    return { items: rows.map(normalizeOrder), total: Number(cnt[0]?.c ?? 0) };
  }

  /** 管理端订单列表（分页）。 */
  async list(page: number, pageSize: number): Promise<{ items: OrderRow[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const rows = (await this.sql`
      SELECT * FROM orders WHERE deleted_at IS NULL
      ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}
    `) as Record<string, unknown>[];
    const cnt = (await this.sql`
      SELECT COUNT(*)::int AS c FROM orders WHERE deleted_at IS NULL
    `) as { c: number }[];
    return { items: rows.map(normalizeOrder), total: Number(cnt[0]?.c ?? 0) };
  }

  /**
   * 原子地把订单从 pending 标成 paid。返回是否成功——并发回调（notify 与
   * return 同时到达）只有一个能赢，输的那个拿到 false 直接跳过履行。
   */
  async markPaid(orderNo: string, providerTradeNo: string | null): Promise<OrderRow | null> {
    const rows = (await this.sql`
      UPDATE orders
      SET status = 'paid', provider_trade_no = ${providerTradeNo},
          paid_at = now(), updated_at = now()
      WHERE order_no = ${orderNo} AND status = 'pending' AND deleted_at IS NULL
      RETURNING *
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeOrder(rows[0]) : null;
  }

  async markFulfilled(id: number): Promise<void> {
    await this.sql`
      UPDATE orders SET status = 'fulfilled', fulfilled_at = now(), updated_at = now()
      WHERE id = ${id}
    `;
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.sql`
      UPDATE orders SET status = 'failed', error = ${String(error ?? '').slice(0, 500)}, updated_at = now()
      WHERE id = ${id} AND status = 'pending'
    `;
  }
}

export class GiftCodeRepo {
  private sql: Sql;
  constructor(env: import('../env').Env) {
    this.sql = getSql(env);
  }

  async create(args: {
    code: string;
    product_type: VasProductType;
    product_payload: Record<string, unknown>;
    batch?: string | null;
  }): Promise<GiftCodeRow> {
    const rows = (await this.sql`
      INSERT INTO gift_codes (code, product_type, product_payload, batch)
      VALUES (${args.code}, ${args.product_type},
              ${JSON.stringify(args.product_payload)}::jsonb, ${args.batch ?? null})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeGiftCode(rows[0]!);
  }

  /**
   * 兑换：原子地把未使用的卡标上使用人。并发兑换同一张卡只有一个赢。
   * 返回 null 表示卡不存在/已用/已删。
   */
  async redeem(code: string, userId: number): Promise<GiftCodeRow | null> {
    const rows = (await this.sql`
      UPDATE gift_codes SET used_by = ${userId}, used_at = now(), updated_at = now()
      WHERE code = ${code} AND used_by IS NULL AND deleted_at IS NULL
      RETURNING *
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeGiftCode(rows[0]) : null;
  }

  async byCode(code: string): Promise<GiftCodeRow | null> {
    const rows = (await this.sql`
      SELECT * FROM gift_codes WHERE code = ${code} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeGiftCode(rows[0]) : null;
  }

  async list(page: number, pageSize: number): Promise<{ items: GiftCodeRow[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const rows = (await this.sql`
      SELECT * FROM gift_codes WHERE deleted_at IS NULL
      ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}
    `) as Record<string, unknown>[];
    const cnt = (await this.sql`
      SELECT COUNT(*)::int AS c FROM gift_codes WHERE deleted_at IS NULL
    `) as { c: number }[];
    return { items: rows.map(normalizeGiftCode), total: Number(cnt[0]?.c ?? 0) };
  }

  async remove(id: number): Promise<void> {
    // 已使用的卡保留数据；未使用的软删
    await this.sql`
      UPDATE gift_codes SET deleted_at = now(), updated_at = now()
      WHERE id = ${id} AND used_by IS NULL
    `;
  }

  /**
   * 履行失败时把卡退回可用状态。
   *
   * 不能走 `remove()` + `create()`：`remove` 只删「未使用」的卡（此刻卡已被
   * 标成使用，删不掉），而 `create` 会撞 `gift_codes_code` 唯一索引 ——
   * 两步都静默失败，用户的卡就没了。直接清使用人即可。
   */
  async revert(id: number): Promise<void> {
    await this.sql`
      UPDATE gift_codes SET used_by = NULL, used_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
  }
}
