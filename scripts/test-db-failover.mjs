import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'shard-'));
const out = path.join(dir, 'shard.mjs');
const outIdx = path.join(dir, 'index.mjs');
// 全量打包（含 @neondatabase/serverless）：driver 在 import 时不发网络请求，
// 只做模块初始化，所以这里把它一起 bundle 进来是安全的，且避免临时目录
// 解析不到 node_modules 的问题。
await esbuild.build({
  entryPoints: [path.resolve('src/db/shard.ts')],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node',
  target: 'node20',
});
// index.ts 里的 databaseUrls / failoverEnabled 也要单独测
await esbuild.build({
  entryPoints: [path.resolve('src/db/index.ts')],
  outfile: outIdx,
  format: 'esm',
  bundle: true,
  platform: 'node',
  target: 'node20',
});

const U1 = 'postgresql://u:p@ep-one.aws.neon.tech/db?sslmode=require';
const U2 = 'postgresql://u:p@ep-two.aws.neon.tech/db?sslmode=require';
const U3 = 'postgresql://u:p@ep-three.aws.neon.tech/db?sslmode=require';
const U4b = 'postgresql://u:p@ep-four.aws.neon.tech/db?sslmode=require';

console.log('── db/shard.ts 路由 ──');

// node 的 ESM 缓存按 URL 去重，用递增 query 拿干净实例
let n = 0;
const fresh = async () => import('file://' + out + '?n=' + n++);
const setPrimaryDownUntil = async (v) => {
  // shard.ts 没导出设置器，用 noteDbFailure 达到同样效果后再断言
  void v;
};

// 1. 无备库 → 永远主库
{
  const shard = await fresh();
  const env = { DATABASE_URL: U1 };
  const h = shard.resolveDb(env);
  assert.equal(h.index, 0);
  assert.equal(h.source, 'DATABASE_URL');
  assert.equal(h.degraded, false);
  console.log('  ✓ 无备库：恒主库，index=0');
}

// 2. 有备库但未开 failover → 仍走主库
{
  const shard = await fresh();
  const env = { DATABASE_URL: U1, DATABASE_URL_4: U4b };
  shard.resetPrimaryHealth();
  const h = shard.resolveDb(env);
  assert.equal(h.index, 0, '未开 DB_FAILOVER 时不该降级');
  console.log('  ✓ 有备库但 DB_FAILOVER 未开：仍走主库');
}

// 3. 主库失败 + 开了 failover → 切备库
{
  const shard = await fresh();
  const env = { DATABASE_URL: U1, DATABASE_URL_2: U2, DATABASE_URL_3: U3, DB_FAILOVER: '1' };
  shard.resetPrimaryHealth();
  assert.equal(shard.isDegraded(), false, '初始不该是降级态');
  shard.noteDbFailure(0);
  assert.equal(shard.isDegraded(), true, '主库失败后应进入降级窗口');
  const h = shard.resolveDb(env);
  assert.equal(h.index, 1, '应切到备库，实际 index=' + h.index);
  assert.equal(h.source, 'DATABASE_URL_2');
  assert.equal(h.degraded, true);
  console.log('  ✓ 主库失败 + DB_FAILOVER=1：切到 DATABASE_URL_2（最后一个 _3 只做备份不参与）');
}

// 3b. 只配了一个备库 → 它就是「最后一个」，只做备份，不参与切换
{
  const shard = await fresh();
  const env = { DATABASE_URL: U1, DATABASE_URL_2: U2, DB_FAILOVER: '1' };
  shard.resetPrimaryHealth();
  shard.noteDbFailure(0);
  const h = shard.resolveDb(env);
  assert.equal(h.index, 0, '唯一的备库按语义是「最后一个」，不该被切');
  assert.equal(h.degraded, false);
  console.log('  ✓ 唯一备库 = 最后一个 = 只做备份：不切换');
}

// 4. 备库失败不触发降级
{
  const shard = await fresh();
  shard.resetPrimaryHealth();
  shard.noteDbFailure(1);
  assert.equal(shard.isDegraded(), false, '备库失败不该影响主库健康判定');
  console.log('  ✓ 备库失败不触发降级窗口');
}

// 5. 主库恢复 → 立刻取消降级
{
  const shard = await fresh();
  const env = { DATABASE_URL: U1, DATABASE_URL_2: U2, DATABASE_URL_3: U3, DB_FAILOVER: '1' };
  shard.resetPrimaryHealth();
  shard.noteDbFailure(0);
  assert.equal(shard.isDegraded(), true);
  shard.noteDbSuccess(0);
  assert.equal(shard.isDegraded(), false, '主库成功后应立即恢复');
  const h = shard.resolveDb(env);
  assert.equal(h.index, 0, '恢复后应回主库');
  console.log('  ✓ 主库恢复：立即回到主库');
}

// 6. 连接串去重 + 空值过滤
{
  const dbi = await import('file://' + outIdx + '?n=' + n++);
  const env = { DATABASE_URL: U1, DATABASE_URL_2: U1, DATABASE_URL_3: '', DATABASE_URL_4: U3 };
  const urls = dbi.databaseUrls(env);
  // DATABASE_URL_2 与主库重复 → 只保留一次；DATABASE_URL_3 为空 → 跳过；
  // DATABASE_URL_4 是另一个库 → 作为备库保留。故结果是 [U1, U3]。
  assert.deepEqual(urls, [U1, U3], '去重失败：' + JSON.stringify(urls));
  assert.deepEqual(dbi.backupDatabaseUrls({ DATABASE_URL: U1, DATABASE_URL_2: U2, DATABASE_URL_3: U3 }), [
    { url: U2, name: 'DATABASE_URL_2' },
    { url: U3, name: 'DATABASE_URL_3' },
  ]);
  // 全部备库都在列表里（最后一个是否参与 failover 由 shard 决定）
  assert.deepEqual(
    dbi.backupDatabaseUrls({ DATABASE_URL: U1, DATABASE_URL_2: U2, DATABASE_URL_4: U4b }),
    [
      { url: U2, name: 'DATABASE_URL_2' },
      { url: U4b, name: 'DATABASE_URL_4' },
    ],
  );
  assert.equal(dbi.primaryDatabaseUrl({ DATABASE_URL: U1, DATABASE_URL_2: U2 }), U1);
  console.log('  ✓ 连接串去重 + 空值过滤 + 备库列表');
}

// 7. 无 DATABASE_URL → 明确报错
{
  const shard = await fresh();
  let threw = false;
  try {
    shard.resolveDb({});
  } catch (e) {
    threw = true;
    assert.match(String(e.message), /DATABASE_URL/);
  }
  assert.ok(threw, '缺主库应抛错');
  console.log('  ✓ 缺 DATABASE_URL：抛明确错误');
}

// 8. DB_FAILOVER 各种真值写法
{
  const dbi = await import('file://' + outIdx + '?n=' + n++);
  const cases = [
    ['1', true], ['true', true], ['TRUE', true], ['yes', true], ['Yes', true],
    ['0', false], ['false', false], ['', false], [undefined, false], ['no', false],
  ];
  for (const [v, want] of cases) {
    assert.equal(
      dbi.failoverEnabled({ DATABASE_URL: U1, DB_FAILOVER: v }),
      want,
      'DB_FAILOVER=' + JSON.stringify(v) + ' 判定错误',
    );
  }
  console.log('  ✓ DB_FAILOVER 真值识别（1/true/yes vs 其他）');
}

console.log('\n✅ shard 路由 8 项全部通过');
