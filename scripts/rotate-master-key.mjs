#!/usr/bin/env node
/**
 * 轮换文件加密主密钥（ENCRYPTION_MASTER_KEY）。
 *
 * 把 entities.enc_meta 里所有用旧主密钥信封加密的文件密钥，改用新主密钥重加密。
 * 与上游 Go 版 `cmd/masterkey.go` 同义：本移植原先只有「别换密钥」的警告注释，
 * 没有这个工具，换 ENCRYPTION_MASTER_KEY 后历史加密文件会全部解不开。
 *
 * 零停机做法（推荐）：
 *   1. 部署同时持有 ENCRYPTION_MASTER_KEY=新 + ENCRYPTION_MASTER_KEY_PREVIOUS=旧
 *      （app 端 importCtrKey 已支持用上一把密钥解旧信封）；
 *   2. 跑本脚本把存量 enc_meta 重加密到新密钥；
 *   3. 验证无误后去掉 ENCRYPTION_MASTER_KEY_PREVIOUS，再部署一次。
 *
 * 带停机做法：停写 → 跑脚本 → 切 ENCRYPTION_MASTER_KEY=新 并部署 → 恢复。
 *
 * 用法：
 *   # 干跑：只统计影响多少行，不写库
 *   node scripts/rotate-master-key.mjs --old-key "$OLD" --new-key "$NEW" --dry-run
 *
 *   # 正式轮换（建议先 --dry-run，再 --verify）
 *   node scripts/rotate-master-key.mjs --old-key "$OLD" --new-key "$NEW"
 *
 *   # 旧密钥没配 ENCRYPTION_MASTER_KEY、走 settings.secret_key 兜底时
 *   node scripts/rotate-master-key.mjs --old-from-db --new-key "$NEW"
 *
 *   # 只验证：所有 enc_meta 都能用新密钥解封（轮换后跑，应 100% 通过）
 *   node scripts/rotate-master-key.mjs --new-key "$NEW" --verify
 *
 * 密钥材料必须与线上 deriveFileMasterKey 用的「完全一致」：
 *   - 部署配了 ENCRYPTION_MASTER_KEY → old/new 就是这个变量的值；
 *   - 没配则回落 JWT_SECRET 或 settings.secret_key：
 *       · --old-from-db 读 settings.secret_key；
 *       · 若实际回落的是 JWT_SECRET，需 --old-key "$JWT_SECRET"。
 *
 * 依赖：DATABASE_URL（或 edge/.dev.vars 里的 DATABASE_URL）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const subtle = webcrypto.subtle;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) {
        out[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (
        argv[i + 1] !== undefined &&
        !argv[i + 1].startsWith('--')
      ) {
        out[key] = argv[i + 1];
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`用法：node scripts/rotate-master-key.mjs [选项]

  --old-key <k>       旧主密钥材料（当前 enc_meta 信封用的）
  --new-key <k>       新主密钥材料（重加密目标）
  --old-from-db       从 settings.secret_key 读旧密钥（未配 ENCRYPTION_MASTER_KEY 的兜底情形）
  --dry-run           只统计，不写库
  --verify            只验证所有 enc_meta 能否用新密钥解封
  --id <n>            只处理指定实体 id（调试用）
  --limit <n>         本批最多处理多少行（默认全量）
  --db-url <url>      覆盖 DATABASE_URL
  -h, --help          显示本帮助
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// DB 连接（与 migrate.mjs 同构：显式 DB_PROVIDER > 连接串域名）
// ---------------------------------------------------------------------------
function loadDevVars() {
  const out = {};
  const devVars = join(root, '.dev.vars');
  if (!existsSync(devVars)) return out;
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDatabaseUrl() {
  return (
    args['db-url'] ||
    process.env.DATABASE_URL ||
    loadDevVars().DATABASE_URL ||
    null
  );
}

function loadProvider(url) {
  const explicit = (
    process.env.DB_PROVIDER ||
    loadDevVars().DB_PROVIDER ||
    ''
  )
    .trim()
    .toLowerCase();
  if (explicit === 'neon' || explicit === 'postgres') return explicit;
  return /neon\.tech|neon\.build/i.test(url) ? 'neon' : 'postgres';
}

function makeExecutor(url, provider) {
  if (provider === 'neon') {
    const sql = neon(url);
    return (text, params = []) => sql(text, params);
  }
  const pg = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
  });
  return (text, params = []) => pg.unsafe(text, params);
}

// ---------------------------------------------------------------------------
// 与主密钥派生完全一致（src/lib/encCrypto.ts masterKeyFromMaterial）
// ---------------------------------------------------------------------------
async function masterKeyFromMaterial(material) {
  if (!material) throw new Error('主密钥材料为空');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode('cloudreve-edge/file-key/v1:' + material),
  );
  return subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function wrapMetadata(meta, masterKey) {
  if (meta.key_wrapped) return meta; // 已经是信封形态
  if (!meta.key_plain_text) throw new Error('缺少文件加密密钥');
  const wrapIv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrapped = await subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv },
    masterKey,
    Buffer.from(meta.key_plain_text, 'base64'),
  );
  return {
    algorithm: meta.algorithm,
    iv: meta.iv,
    key_wrapped: Buffer.from(wrapped).toString('base64'),
    wrap_iv: Buffer.from(wrapIv).toString('base64'),
    wrap_version: 1,
  };
}

async function unwrapMetadata(meta, masterKey) {
  if (!meta.key_wrapped || !meta.wrap_iv) {
    throw new Error('损坏的加密元数据（无 key_wrapped）');
  }
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(meta.wrap_iv, 'base64') },
    masterKey,
    Buffer.from(meta.key_wrapped, 'base64'),
  );
  return {
    algorithm: meta.algorithm,
    iv: meta.iv,
    key_plain_text: Buffer.from(plain).toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error(
      'ERROR: DATABASE_URL 未设置。请在环境变量或 edge/.dev.vars 中配置。',
    );
    process.exit(1);
  }

  const provider = loadProvider(databaseUrl);
  const exec = makeExecutor(databaseUrl, provider);
  console.log(`驱动：${provider}`);

  // 旧密钥材料
  let oldMaterial = args['old-key'];
  if (args['old-from-db']) {
    const rows = await exec(
      "SELECT value FROM settings WHERE name = 'secret_key' LIMIT 1",
    );
    oldMaterial = rows[0]?.value ?? null;
    if (!oldMaterial) {
      console.error('ERROR: --old-from-db 但 settings.secret_key 为空。');
      process.exit(1);
    }
    console.log('旧密钥：从 settings.secret_key 读取');
  } else if (!args.verify && !oldMaterial) {
    console.error(
      'ERROR: 需要 --old-key <k> 或 --old-from-db（--verify 模式除外）。',
    );
    process.exit(1);
  }

  const newMaterial = args['new-key'];
  if (!newMaterial) {
    console.error('ERROR: 需要 --new-key <k>（重加密目标）。');
    process.exit(1);
  }

  let oldKey = null;
  if (oldMaterial) {
    try {
      oldKey = await masterKeyFromMaterial(oldMaterial);
    } catch (e) {
      console.error('ERROR: 旧密钥派生失败：', e.message);
      process.exit(1);
    }
  }
  let newKey;
  try {
    newKey = await masterKeyFromMaterial(newMaterial);
  } catch (e) {
    console.error('ERROR: 新密钥派生失败：', e.message);
    process.exit(1);
  }

  const limit = args.limit ? Number(args.limit) : null;
  const singleId = args.id ? Number(args.id) : null;

  let where = "WHERE enc_meta IS NOT NULL AND enc_meta <> ''";
  const params = [];
  if (singleId !== null) {
    where += ` AND id = $${params.length + 1}`;
    params.push(singleId);
  }
  if (limit !== null) {
    where += ` ORDER BY id LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  const rows = await exec(
    `SELECT id, enc_meta FROM entities ${where}`,
    params,
  );
  console.log(`命中 enc_meta 记录：${rows.length} 行`);

  if (rows.length === 0) {
    console.log('没有需要处理的加密记录。');
    process.exit(0);
  }

  // --verify：只确认所有记录都能用新密钥解封
  if (args.verify) {
    let ok = 0;
    let bad = 0;
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.enc_meta);
        if (meta.key_wrapped) {
          await unwrapMetadata(meta, newKey);
        }
        ok += 1;
      } catch {
        bad += 1;
        console.error(`  ✗ id=${r.id} 新密钥解封失败`);
      }
    }
    console.log(`验证结果：成功 ${ok}，失败 ${bad}`);
    process.exit(bad === 0 ? 0 : 1);
  }

  if (args['dry-run']) {
    console.log('[dry-run] 不写库。下列记录将被重加密：');
    for (const r of rows.slice(0, 20)) console.log(`  enc_meta id=${r.id}`);
    if (rows.length > 20) console.log(`  …（共 ${rows.length} 行）`);
    process.exit(0);
  }

  let rotated = 0;
  let skipped = 0; // 已用新密钥封好（可重入）
  let legacy = 0; // 历史明文密钥，直接用新密钥封
  let errors = 0;

  for (const r of rows) {
    let meta;
    try {
      meta = JSON.parse(r.enc_meta);
    } catch {
      console.error(`  ✗ id=${r.id} enc_meta 不是合法 JSON，跳过`);
      errors += 1;
      continue;
    }
    if (meta.key_wrapped) {
      // 已经信封加密：先用旧密钥解；解不开再试新密钥（已轮换过则跳过）。
      let plain;
      try {
        plain = await unwrapMetadata(meta, oldKey);
      } catch {
        try {
          await unwrapMetadata(meta, newKey);
          skipped += 1; // 已经是新密钥封的
          continue;
        } catch {
          console.error(`  ✗ id=${r.id} 旧/新密钥都解不开，疑似损坏，跳过`);
          errors += 1;
          continue;
        }
      }
      const rewrapped = await wrapMetadata(plain, newKey);
      await exec('UPDATE entities SET enc_meta = $1 WHERE id = $2', [
        JSON.stringify(rewrapped),
        r.id,
      ]);
      rotated += 1;
    } else if (meta.key_plain_text) {
      // 历史明文密钥：直接用新密钥封（重入时上一轮已变成 key_wrapped）。
      const rewrapped = await wrapMetadata(meta, newKey);
      await exec('UPDATE entities SET enc_meta = $1 WHERE id = $2', [
        JSON.stringify(rewrapped),
        r.id,
      ]);
      legacy += 1;
    } else {
      console.error(`  ✗ id=${r.id} 既无 key_wrapped 也无 key_plain_text，跳过`);
      errors += 1;
    }
  }

  console.log(
    `\n完成：重加密 ${rotated} 行，历史明文重封 ${legacy} 行，已跳过(已轮换) ${skipped} 行，失败 ${errors} 行。`,
  );
  if (errors > 0) {
    console.error('存在失败记录，请检查上方 ✗ 行后再跑（脚本可重入）。');
    process.exit(1);
  }
  console.log(
    '下一步：① 跑 --verify 确认全部用新密钥可读；② 把部署的 ENCRYPTION_MASTER_KEY 切到新值并部署（或过渡期保留 ENCRYPTION_MASTER_KEY_PREVIOUS=旧）。',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
