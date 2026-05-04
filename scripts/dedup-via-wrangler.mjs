/**
 * dedup-via-wrangler.mjs
 * wrangler d1 execute を使って DB2 の ID を DB1 で status='delisted' に更新する。
 * 1件ずつ処理するため遅いが確実に動作する。
 * 処理済みIDをログファイルに記録し、再実行時にスキップできる。
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');
const IDS_FILE = path.join(__dirname, 'db2-ids.json');
const LOG_FILE = path.join(__dirname, 'dedup-progress.json');
const DB1 = 'mal-search-db';
const DB2 = 'mal-search-db-2';
const SITES = ['kenbiya', 'rakumachi'];

// 進捗ログの読み込み
let progress = { kenbiya: 0, rakumachi: 0, kenbiya_changed: 0, rakumachi_changed: 0 };
if (existsSync(LOG_FILE)) {
  progress = JSON.parse(readFileSync(LOG_FILE, 'utf8'));
  console.log('前回の進捗を読み込みました:', progress);
}

const allIds = JSON.parse(readFileSync(IDS_FILE, 'utf8'));

function runWranglerUpdate(siteId, id) {
  const safeId = String(id).replace(/'/g, "''");
  const sql = `UPDATE properties SET status='delisted', updated_at=datetime('now') WHERE site_id='${siteId}' AND status='active' AND site_property_id='${safeId}'`;
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${DB1} --remote --json --command "${escaped}"`;
  try {
    const output = execSync(cmd, {
      cwd: WORKER_DIR,
      encoding: 'utf8',
      maxBuffer: 1 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const jsonMatch = output.match(/(\[[\s\S]*\])\s*$/);
    if (!jsonMatch) return 0;
    const parsed = JSON.parse(jsonMatch[1]);
    return parsed[0]?.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

async function processSite(siteId) {
  const ids = allIds[siteId];
  const startOffset = progress[siteId] ?? 0;
  let changed = progress[`${siteId}_changed`] ?? 0;

  if (startOffset >= ids.length) {
    console.log(`${siteId}: 処理済み (${ids.length}件)`);
    return changed;
  }

  console.log(`\n=== ${siteId} 処理開始 (offset=${startOffset}/${ids.length}) ===`);
  const startTime = Date.now();

  for (let i = startOffset; i < ids.length; i++) {
    const result = runWranglerUpdate(siteId, ids[i]);
    changed += result;

    // 100件ごとに進捗を保存
    if ((i + 1) % 100 === 0) {
      progress[siteId] = i + 1;
      progress[`${siteId}_changed`] = changed;
      writeFileSync(LOG_FILE, JSON.stringify(progress, null, 2));
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = ((i - startOffset + 1) / elapsed).toFixed(1);
      const remaining = ((ids.length - i - 1) / rate / 60).toFixed(0);
      process.stdout.write(`\r  ${siteId}: ${i+1}/${ids.length} (delisted: ${changed}, ${rate}件/s, 残約${remaining}分)`);
    }
  }

  progress[siteId] = ids.length;
  progress[`${siteId}_changed`] = changed;
  writeFileSync(LOG_FILE, JSON.stringify(progress, null, 2));
  console.log(`\n  ${siteId}: 完了 (delisted: ${changed})`);
  return changed;
}

console.log('=== D1クロスシャード重複解消 (wrangler経由) ===');
console.log(`kenbiya: ${allIds.kenbiya.length} IDs`);
console.log(`rakumachi: ${allIds.rakumachi.length} IDs`);

let total = 0;
for (const siteId of SITES) {
  total += await processSite(siteId);
}

console.log(`\n=== 完了: 合計 ${total} 件を delisted に変更 ===`);
