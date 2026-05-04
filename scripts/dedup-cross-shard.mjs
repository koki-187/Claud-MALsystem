/**
 * dedup-cross-shard.mjs
 * DB2 に存在する kenbiya/rakumachi の site_property_id を DB1 で status='delisted' に更新する。
 * Cloudflare D1 REST API を直接呼び出す（wrangler CLI不要）。
 *
 * 必要な環境変数:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *
 * または .env ファイルから読み込む
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');

// .env 読み込み
const envPath = path.join(WORKER_DIR, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const DB1_ID     = '2a731ee6-d1c7-4f51-8bcc-f15f993ad870';
const DB2_ID     = 'e2de4581-6bd4-48ff-ab33-2414c901873e';
const SITES      = ['kenbiya', 'rakumachi'];
const PAGE_SIZE  = 500;   // DB2から取得するページサイズ
const BATCH_SIZE = 50;    // DB1へのIN句サイズ（/rawエンドポイントのSQL長制限〜800文字以内）

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を環境変数または .env に設定してください。');
  process.exit(1);
}

async function d1Query(dbId, sql, params = []) {
  // SELECT には /query、DML には /raw を使う（/query は容量上限エラーになる）
  const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
  const endpoint = isSelect ? 'query' : 'raw';
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${dbId}/${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result[0];
}

async function getDB2AllIds(siteId) {
  console.log(`  DB2から ${siteId} の全 site_property_id を取得中...`);
  const allIds = [];
  let offset = 0;

  while (true) {
    const result = await d1Query(
      DB2_ID,
      `SELECT site_property_id FROM properties WHERE site_id=? ORDER BY site_property_id LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      [siteId]
    );
    const rows = result.results || [];
    for (const row of rows) allIds.push(row.site_property_id);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stdout.write(`\r    取得済み: ${allIds.length} 件`);
  }

  console.log(`\r    取得完了: ${allIds.length} 件`);
  return allIds;
}

async function updateDB1Single(siteId, id) {
  const safeId = String(id).replace(/'/g, "''");
  const sql = `UPDATE properties SET status='delisted', updated_at=datetime('now') WHERE site_id='${siteId}' AND status='active' AND site_property_id='${safeId}'`;
  const result = await d1Query(DB1_ID, sql, []);
  return result.meta?.changes ?? 0;
}

async function updateDB1Batch(siteId, ids) {
  if (ids.length === 0) return 0;
  let changed = 0;
  for (const id of ids) {
    changed += await updateDB1Single(siteId, id);
  }
  return changed;
}

async function processSite(siteId) {
  console.log(`\n=== ${siteId} 処理開始 ===`);

  // DB1の現状確認
  const before = await d1Query(DB1_ID, `SELECT COUNT(*) as cnt FROM properties WHERE site_id=? AND status='active'`, [siteId]);
  const activeBefore = before.results[0]?.cnt ?? 0;
  console.log(`  DB1 active件数（処理前）: ${activeBefore}`);

  // DB2から全ID取得
  const db2Ids = await getDB2AllIds(siteId);
  if (db2Ids.length === 0) {
    console.log(`  DB2にデータなし。スキップ。`);
    return 0;
  }

  // DB1をバッチ更新
  console.log(`  DB1を更新中 (${db2Ids.length} IDを${BATCH_SIZE}件ずつ)...`);
  let totalChanged = 0;
  let processed = 0;

  for (let i = 0; i < db2Ids.length; i += BATCH_SIZE) {
    const batch = db2Ids.slice(i, i + BATCH_SIZE);
    const changed = await updateDB1Batch(siteId, batch);
    totalChanged += changed;
    processed += batch.length;
    process.stdout.write(`\r    処理中: ${processed}/${db2Ids.length} ID (delisted: ${totalChanged})`);
  }
  console.log('');

  // DB1の処理後確認
  const after = await d1Query(DB1_ID, `SELECT COUNT(*) as cnt FROM properties WHERE site_id=? AND status='active'`, [siteId]);
  const activeAfter = after.results[0]?.cnt ?? 0;
  const delistedRow = await d1Query(DB1_ID, `SELECT COUNT(*) as cnt FROM properties WHERE site_id=? AND status='delisted'`, [siteId]);
  const delistedCount = delistedRow.results[0]?.cnt ?? 0;

  console.log(`  DB1 active件数（処理後）: ${activeAfter}`);
  console.log(`  DB1 delisted件数: ${delistedCount}`);
  console.log(`  今回 delisted に変更した件数: ${totalChanged}`);

  return totalChanged;
}

async function main() {
  console.log('=== D1クロスシャード重複解消スクリプト ===');
  console.log(`Account ID: ${ACCOUNT_ID}`);
  console.log(`DB1: ${DB1_ID}`);
  console.log(`DB2: ${DB2_ID}`);
  console.log(`対象サイト: ${SITES.join(', ')}`);
  console.log('');

  let totalUpdated = 0;

  for (const siteId of SITES) {
    try {
      const updated = await processSite(siteId);
      totalUpdated += updated;
    } catch (err) {
      console.error(`\n${siteId} の処理中にエラー:`, err.message);
      process.exit(1);
    }
  }

  console.log('\n=== 処理完了 ===');
  console.log(`合計 delisted に変更した件数: ${totalUpdated}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
