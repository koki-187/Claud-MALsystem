/**
 * fetch-db2-ids.mjs
 * DB2 の kenbiya/rakumachi の全 site_property_id を取得してJSONに保存する
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');

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
const DB2_ID     = 'e2de4581-6bd4-48ff-ab33-2414c901873e';
const PAGE_SIZE  = 500;

async function d1Query(dbId, sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${dbId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.success) throw new Error(`Query failed: ${JSON.stringify(json.errors)}`);
  return json.result[0];
}

async function getAllIds(siteId) {
  const allIds = [];
  let offset = 0;
  while (true) {
    const result = await d1Query(DB2_ID,
      `SELECT site_property_id FROM properties WHERE site_id=? ORDER BY site_property_id LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      [siteId]);
    const rows = result.results || [];
    for (const row of rows) allIds.push(row.site_property_id);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stdout.write(`\r  ${siteId}: ${allIds.length} 件取得中...`);
  }
  console.log(`\r  ${siteId}: ${allIds.length} 件取得完了`);
  return allIds;
}

const ACCOUNT_ID_CHECK = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN_CHECK  = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT_ID_CHECK || !API_TOKEN_CHECK) {
  console.error('ERROR: 環境変数 CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN が必要です');
  process.exit(1);
}

const result = {};
for (const siteId of ['kenbiya', 'rakumachi']) {
  result[siteId] = await getAllIds(siteId);
}

const outPath = path.join(__dirname, 'db2-ids.json');
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\n保存先: ${outPath}`);
console.log(`kenbiya: ${result.kenbiya.length} 件`);
console.log(`rakumachi: ${result.rakumachi.length} 件`);
