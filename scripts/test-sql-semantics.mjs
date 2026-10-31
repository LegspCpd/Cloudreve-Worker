/**
 * 数据库语义回归（PGlite：编译成 WASM 的真 Postgres）。
 *
 * 为什么需要它：边缘版有一批「读-改-写」换成了单条 JSONB SQL
 * （`mergeSettings` / `patchSettings` / `applyGroupPack` / `clearGroupPack` /
 * `setCredit` / `tryDeductCredit` / `createFoldersIfAbsent`）。这些语句只在
 * Neon 上跑过，而 Neon 是 HTTP 代理，出问题时的报错很难定位。这里用真的
 * Postgres 内核跑一遍，把「语法对不对、语义对不对」变成 CI 能卡住的东西。
 *
 * 顺带验证：`migrations/*.sql` 在**标准 Postgres** 上能整体建库 ——
 * 这条是多数据库支持（Supabase / 自建 / Hyperdrive）的前提。
 *
 * 跑法：`npm run test:sql-semantics`
 */
import { PGlite } from '@electric-sql/pglite';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitStatements } from '../src/lib/sql-split.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'sqlsemantics');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

/**
 * 把 PGlite 包成 repo 需要的 `Sql`：既支持模板标签，也支持
 * `sql(text, params)` 两种调用形式（与 `src/db/index.ts` 的接口一致）。
 */
function makeSql(db) {
  const run = async (text, values) => {
    const res = await db.query(text, values ?? []);
    return res.rows;
  };
  const sql = async (first, ...rest) => {
    if (typeof first === 'string') {
      const values = Array.isArray(rest[0]) ? rest[0] : rest;
      return run(first, values);
    }
    let text = '';
    for (let i = 0; i < first.length; i += 1) {
      text += first[i];
      if (i < rest.length) text += `$${i + 1}`;
    }
    return run(text, rest);
  };
  return sql;
}

const db = new PGlite();

try {
  // -------------------------------------------------------------------------
  // [1] 全部迁移在标准 Postgres 上可执行
  // -------------------------------------------------------------------------
  console.log('\n[1] migrations/*.sql 在标准 Postgres 上建库');
  const files = readdirSync(path.join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let applied = 0;
  for (const f of files) {
    const text = readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
    for (const stmt of splitStatements(text)) {
      if (!stmt.trim()) continue;
      await db.exec(stmt);
    }
    applied += 1;
  }
  check(`${applied} 个迁移全部执行成功`, applied === files.length, `${applied}/${files.length}`);

  const tables = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const names = tables.rows.map((r) => r.tablename);
  check('核心表都在', ['users', 'files', 'entities', 'shares', 'gift_codes', 'share_purchases'].every((t) => names.includes(t)), names.join(','));

  // -------------------------------------------------------------------------
  // 准备：打包 repo.ts，用 PGlite 驱动它
  // -------------------------------------------------------------------------
  const bundlePath = path.join(outDir, 'repo.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/db/repo.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { UserRepo, FileRepo, EntityRepo } = await import(`file://${bundlePath}`);
  const sql = makeSql(db);
  const users = new UserRepo(sql);
  const filesRepo = new FileRepo(sql);
  const entitiesRepo = new EntityRepo(sql);

  // 种子：一个组 + 一个用户
  await db.exec(`INSERT INTO groups (id, name, max_storage, permissions) VALUES (1, '默认', 1000, '\\x00') ON CONFLICT DO NOTHING`);
  await db.exec(`INSERT INTO groups (id, name, max_storage, permissions) VALUES (2, '高级', 2000, '\\x00') ON CONFLICT DO NOTHING`);
  const seeded = await db.query(
    `INSERT INTO users (email, nick, password, group_users, status, storage, settings)
     VALUES ('a@example.com', 'A', NULL, 1, 'active', 0, '{}'::jsonb) RETURNING id`,
  );
  const uid = seeded.rows[0].id;

  const settings = async () => {
    const r = await db.query(`SELECT settings FROM users WHERE id = $1`, [uid]);
    return r.rows[0].settings ?? {};
  };

  // -------------------------------------------------------------------------
  // [2] mergeSettings：只合并指定键
  // -------------------------------------------------------------------------
  console.log('\n[2] mergeSettings 不碰其他键');
  await users.addQuotaPack(uid, { size: 100, expire_at: null });
  await users.adjustCredit(uid, 50);
  await users.mergeSettings(uid, { preferred_theme: 'dark' });
  let s = await settings();
  check('写了 preferred_theme', s.preferred_theme === 'dark');
  check('容量包还在', Array.isArray(s.quota_packs) && s.quota_packs.length === 1);
  check('积分还在', Number(s.credit) === 50, String(s.credit));

  // -------------------------------------------------------------------------
  // [3] patchSettings：合并 patch + 删指定键
  // -------------------------------------------------------------------------
  console.log('\n[3] patchSettings 合并并删键');
  await users.patchSettings(uid, { email_language: 'zh-CN' }, ['preferred_theme']);
  s = await settings();
  check('写了 email_language', s.email_language === 'zh-CN');
  check('删掉了 preferred_theme', !('preferred_theme' in s));
  check('容量包仍在', Array.isArray(s.quota_packs) && s.quota_packs.length === 1);
  // 空 patch + 空删除：不应改变任何东西
  const before = JSON.stringify(s);
  await users.patchSettings(uid, {}, []);
  check('空操作不写库', JSON.stringify(await settings()) === before);

  // -------------------------------------------------------------------------
  // [4] applyGroupPack：一条语句同时写 group_pack 与 group_users
  // -------------------------------------------------------------------------
  console.log('\n[4] applyGroupPack 原子切组');
  await users.applyGroupPack(uid, 2, new Date(Date.now() + 86400000).toISOString());
  s = await settings();
  let row = (await db.query(`SELECT group_users FROM users WHERE id = $1`, [uid])).rows[0];
  check('切到组 2', Number(row.group_users) === 2, String(row.group_users));
  check('group_pack 记了 group_id=2', Number(s.group_pack?.group_id) === 2);
  check('prev_group_id 是原组 1', Number(s.group_pack?.prev_group_id) === 1, String(s.group_pack?.prev_group_id));
  check('容量包没被抹掉', Array.isArray(s.quota_packs) && s.quota_packs.length === 1);
  check('积分没被抹掉', Number(s.credit) === 50);

  // 续费：prev_group_id 必须还是最初的组 1，不能变成 2
  await users.applyGroupPack(uid, 2, null);
  s = await settings();
  check('续费保留最初的 prev_group_id', Number(s.group_pack?.prev_group_id) === 1, String(s.group_pack?.prev_group_id));
  check('expire_at 为 null 时落 JSON null', s.group_pack?.expire_at === null, JSON.stringify(s.group_pack?.expire_at));

  // -------------------------------------------------------------------------
  // [5] clearGroupPack：清记录 + 回退组
  // -------------------------------------------------------------------------
  console.log('\n[5] clearGroupPack 回退');
  await users.clearGroupPack(uid, 1);
  s = await settings();
  row = (await db.query(`SELECT group_users FROM users WHERE id = $1`, [uid])).rows[0];
  check('回退到组 1', Number(row.group_users) === 1);
  check('group_pack 为 null', s.group_pack === null);
  check('容量包仍在', Array.isArray(s.quota_packs) && s.quota_packs.length === 1);

  // -------------------------------------------------------------------------
  // [6] 积分：setCredit / tryDeductCredit 不会扣成负数
  // -------------------------------------------------------------------------
  console.log('\n[6] 积分原子操作');
  await users.setCredit(uid, 100);
  check('setCredit 设为 100', Number((await settings()).credit) === 100);
  const ok1 = await users.tryDeductCredit(uid, 60);
  check('扣 60 成功', ok1 === true);
  check('余额 40', Number((await settings()).credit) === 40);
  const ok2 = await users.tryDeductCredit(uid, 100);
  check('余额不足时返回 false', ok2 === false);
  check('余额没变负', Number((await settings()).credit) === 40, String((await settings()).credit));
  await users.setCredit(uid, 0);
  check('setCredit 可以归零', Number((await settings()).credit) === 0);

  // -------------------------------------------------------------------------
  // [7] 礼品卡：兑换 → 履行失败 → revert 后可再次兑换
  // -------------------------------------------------------------------------
  console.log('\n[7] 礼品卡 revert 后可重用');
  await db.exec(`INSERT INTO gift_codes (code, product_type, product_payload) VALUES ('GCTEST1', 'storage', '{"size":10}'::jsonb)`);
  const gift = (await db.query(`SELECT id FROM gift_codes WHERE code = 'GCTEST1'`)).rows[0];
  const claimed = await db.query(
    `UPDATE gift_codes SET used_by = $1, used_at = now() WHERE code = 'GCTEST1' AND used_by IS NULL RETURNING id`,
    [uid],
  );
  check('第一次兑换成功', claimed.rows.length === 1);
  const again = await db.query(
    `UPDATE gift_codes SET used_by = $1, used_at = now() WHERE code = 'GCTEST1' AND used_by IS NULL RETURNING id`,
    [uid],
  );
  check('已用的卡不能再兑换', again.rows.length === 0);
  // 履行失败 → 清 used_by（这就是 GiftCodeRepo.revert 做的事）
  await db.query(`UPDATE gift_codes SET used_by = NULL, used_at = NULL WHERE id = $1`, [gift.id]);
  const retry = await db.query(
    `UPDATE gift_codes SET used_by = $1, used_at = now() WHERE code = 'GCTEST1' AND used_by IS NULL RETURNING id`,
    [uid],
  );
  check('revert 后能再次兑换', retry.rows.length === 1);

  // -------------------------------------------------------------------------
  // [8] createFoldersIfAbsent：批量建、同名跳过
  // -------------------------------------------------------------------------
  console.log('\n[8] createFoldersIfAbsent');
  const root = await filesRepo.create({
    type: 1,
    name: '',
    ownerId: uid,
    parentId: null,
  });
  await filesRepo.createFoldersIfAbsent(root.id, uid, ['文档', '图片', '文档']);
  let kids = await db.query(`SELECT name FROM files WHERE file_children = $1 ORDER BY name`, [root.id]);
  check('建了 2 个子目录（去重前已过滤）', kids.rows.length === 2, JSON.stringify(kids.rows));
  // 再跑一次：同名跳过
  await filesRepo.createFoldersIfAbsent(root.id, uid, ['文档', '音乐']);
  kids = await db.query(`SELECT name FROM files WHERE file_children = $1 ORDER BY name`, [root.id]);
  check('重复调用不产生重复行', kids.rows.length === 3, JSON.stringify(kids.rows));
  check('新目录也建了', kids.rows.some((r) => r.name === '音乐'));

  // -------------------------------------------------------------------------
  // [9] 付费分享：唯一约束 + 余额条件
  // -------------------------------------------------------------------------
  console.log('\n[9] 分享购买记录幂等');
  await db.exec(`INSERT INTO shares (id, password, views, downloads, expires, remain_downloads, score, props, file_shares, user_shares)
                 VALUES (9001, NULL, 0, 0, NULL, NULL, 10, '{}'::jsonb, NULL, $1)`, [uid]).catch(async () => {
    // shares 表列可能不完全一致，退化为只插必要列
    await db.exec(`INSERT INTO shares (score, file_shares, user_shares) VALUES (10, NULL, ${uid})`);
  });
  const shareRow = (await db.query(`SELECT id FROM shares ORDER BY id DESC LIMIT 1`)).rows[0];
  const p1 = await sql(
    `INSERT INTO share_purchases (share_id, user_id, amount) VALUES ($1, $2, 10) ON CONFLICT (share_id, user_id) DO NOTHING RETURNING id`,
    [shareRow.id, uid],
  );
  check('首次插入成功', p1.length === 1);
  const p2 = await sql(
    `INSERT INTO share_purchases (share_id, user_id, amount) VALUES ($1, $2, 10) ON CONFLICT (share_id, user_id) DO NOTHING RETURNING id`,
    [shareRow.id, uid],
  );
  check('重复插入被唯一约束挡住', p2.length === 0);

  // -------------------------------------------------------------------------
  // [10] reserveStorage：并发预占不会超额
  // -------------------------------------------------------------------------
  console.log('\n[10] 容量预占不超额');
  await db.query(`UPDATE users SET storage = 0 WHERE id = $1`, [uid]);
  const LIMIT = 1000;
  const r1 = await users.reserveStorage(uid, 600, LIMIT);
  check('预占 600 成功', r1 === true);
  const r2 = await users.reserveStorage(uid, 600, LIMIT);
  check('再预占 600 失败（会超 1000）', r2 === false);
  let used = Number((await db.query(`SELECT storage FROM users WHERE id = $1`, [uid])).rows[0].storage);
  check('已用仍是 600，没被失败的预占污染', used === 600, String(used));
  const r3 = await users.reserveStorage(uid, 400, LIMIT);
  check('预占 400 刚好到上限', r3 === true);
  used = Number((await db.query(`SELECT storage FROM users WHERE id = $1`, [uid])).rows[0].storage);
  check('已用 1000', used === 1000, String(used));
  const r4 = await users.reserveStorage(uid, 1, LIMIT);
  check('上限处再预占 1 字节失败', r4 === false);
  // maxTotal 为 null（不限量）时一律成功
  const r5 = await users.reserveStorage(uid, 999999, null);
  check('不限量时预占成功', r5 === true);

  // -------------------------------------------------------------------------
  // [11] 实体引用计数：最后一个引用释放才允许删对象
  // -------------------------------------------------------------------------
  console.log('\n[11] 实体引用计数');
  await db.exec(`INSERT INTO storage_policies (id, name, type) VALUES (1, 'test', 'local') ON CONFLICT DO NOTHING`);
  const ent = await entitiesRepo.create({
    type: 0,
    source: 'objects/a.bin',
    size: 10,
    policyId: 1,
    createdBy: uid,
  });
  check('新建实体引用计数为 1', Number(ent.reference_count) === 1, String(ent.reference_count));
  // 复制：多一个文件共用同一实体
  await entitiesRepo.retain([ent.id]);
  let rc = Number(
    (await db.query(`SELECT reference_count FROM entities WHERE id = $1`, [ent.id])).rows[0]
      .reference_count,
  );
  check('retain 后为 2', rc === 2, String(rc));
  // 删掉一个引用
  let garbage = await entitiesRepo.release([ent.id]);
  check('还留着引用时不算垃圾', garbage.length === 0);
  // 删掉最后一个引用
  garbage = await entitiesRepo.release([ent.id]);
  check('最后一个引用释放后进入待删列表', garbage.length === 1);
  rc = Number(
    (await db.query(`SELECT reference_count FROM entities WHERE id = $1`, [ent.id])).rows[0]
      .reference_count,
  );
  check('计数归零（不会被减成负数）', rc === 0, String(rc));
  // 再释放一次：计数已 0，不该再产出「可删除」，否则并发 purge 会删两次对象
  garbage = await entitiesRepo.release([ent.id]);
  check('计数已 0 时再释放不产出垃圾（防重复删对象）', garbage.length === 0);
  rc = Number(
    (await db.query(`SELECT reference_count FROM entities WHERE id = $1`, [ent.id])).rows[0]
      .reference_count,
  );
  check('计数没有变成 -1', rc === 0, String(rc));

  // -------------------------------------------------------------------------
  // [12] 迁移可重放（幂等）
  //
  // `provision()` 的判据是 KV 里的「最后应用的文件名」。标记丢了（换 KV、
  // 手动清缓存）就会从 0001 重放一遍。任何一步不幂等都会直接把存量部署打挂。
  // 这里在建好库、已经有数据的情况下把 17 个迁移再跑一遍。
  // -------------------------------------------------------------------------
  console.log('\n[12] 迁移重放幂等');
  let replayError = null;
  for (const f of files) {
    const text = readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
    for (const stmt of splitStatements(text)) {
      if (!stmt.trim()) continue;
      try {
        await db.exec(stmt);
      } catch (e) {
        replayError = `${f}: ${e instanceof Error ? e.message : e}`;
        break;
      }
    }
    if (replayError) break;
  }
  check('全部迁移可重放', replayError === null, replayError ?? '');
  // 重放不该动业务数据
  const afterReplay = await settings();
  check('重放后积分没变', Number(afterReplay.credit) === 0, String(afterReplay.credit));
  check(
    '重放后容量包没变',
    Array.isArray(afterReplay.quota_packs) && afterReplay.quota_packs.length === 1,
  );
} catch (e) {
  failed += 1;
  console.error('\n  ERROR', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
} finally {
  await db.close().catch(() => undefined);
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
