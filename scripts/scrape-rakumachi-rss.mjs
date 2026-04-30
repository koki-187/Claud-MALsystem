#!/usr/bin/env node
/**
 * 楽待 RSS → MAL D1 インポート
 * 楽待の RSS フィード (最新収益物件) を取得してD1にインポート
 * Windows Task Scheduler で毎日 04:30 に実行
 *
 * Usage: node scripts/scrape-rakumachi-rss.mjs [--dry-run]
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, '..', '.env');

// .env 読み込み
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;

// Top prefectures to scrape (prefNum → prefCode)
const TARGET_PREFS = [
  { prefNum: 13, prefCode: '13' }, // 東京
  { prefNum: 27, prefCode: '27' }, // 大阪
  { prefNum: 14, prefCode: '14' }, // 神奈川
  { prefNum: 23, prefCode: '23' }, // 愛知
  { prefNum: 11, prefCode: '11' }, // 埼玉
  { prefNum: 28, prefCode: '28' }, // 兵庫
  { prefNum: 40, prefCode: '40' }, // 福岡
  { prefNum: 12, prefCode: '12' }, // 千葉
  { prefNum: 26, prefCode: '26' }, // 京都
  { prefNum: 34, prefCode: '34' }, // 広島
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[${new Date().toISOString()}] [rakumachi-rss] ${msg}`); }

function extractPrice(text) {
  const cleaned = text.replace(/[,\s]/g, '');
  const oku = cleaned.match(/(\d+(?:\.\d+)?)億(?:(\d+)万)?円/);
  if (oku) {
    const price = Math.round(parseFloat(oku[1]) * 10000) + (oku[2] ? parseInt(oku[2]) : 0);
    return { price, priceText: text.trim() };
  }
  const man = cleaned.match(/(\d+(?:\.\d+)?)万円/);
  if (man) return { price: Math.round(parseFloat(man[1])), priceText: text.trim() };
  return { price: null, priceText: '価格要相談' };
}

function extractYield(text) {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[%％]/);
  if (m) { const v = parseFloat(m[1]); return (v > 0 && v < 50) ? v : null; }
  return null;
}

function parseListingHtml(html, prefCode) {
  // Structure: <p class="propertyBlock__name">TITLE</p> followed within ~2000 chars
  //            by <a href="/syuuekibukken/.../ID/show.html" ...>...price/yield...</a>
  const properties = [];
  const seen = new Set();
  const nameRe = /<p class="propertyBlock__name">([^<]+)<\/p>/g;

  for (const nm of html.matchAll(nameRe)) {
    const title = nm[1].trim();
    if (!title) continue;

    // Look ahead up to 2000 chars for the nearby show.html anchor
    const afterTitle = html.indexOf(nm[0]) + nm[0].length;
    const chunk = html.slice(afterTitle, afterTitle + 2500);

    const urlM = chunk.match(/href="(\/syuuekibukken\/[^"]+\/(\d+)\/show\.html)"/);
    if (!urlM) continue;
    const path = urlM[1];
    const sitePropertyId = urlM[2];
    if (seen.has(sitePropertyId)) continue;
    seen.add(sitePropertyId);

    const detailUrl = `https://www.rakumachi.jp${path}`;

    // Get content of that <a> tag for price/yield/address
    const aStart = chunk.indexOf(`href="${path}"`);
    const aEnd = chunk.indexOf('</a>', aStart);
    const aText = aEnd > aStart
      ? chunk.slice(aStart, aEnd).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      : chunk.slice(aStart, aStart + 500).replace(/<[^>]+>/g, ' ');

    // Price: look for <b class="price">VALUE</b> or fallback plain text
    const bPriceM = chunk.slice(aStart, aEnd > 0 ? aEnd : aStart + 800)
      .match(/<b class="price">([^<]+)<\/b>/);
    const priceRaw = bPriceM ? bPriceM[1] : (aText.match(/[0-9,]+万円|[0-9.]+億[^万\n]*円/)?.[0] ?? '');
    const { price, priceText } = extractPrice(priceRaw);

    // Yield: <b class="gross">VALUE</b>
    const bYieldM = chunk.slice(aStart, aEnd > 0 ? aEnd : aStart + 800)
      .match(/<b class="gross">([^<]+)<\/b>/);
    const yieldRate = bYieldM ? extractYield(bYieldM[1]) : extractYield(aText);

    // Address: <span class="propertyBlock__address">VALUE</span>
    const addrM = chunk.slice(aStart, aEnd > 0 ? aEnd : aStart + 1000)
      .match(/<span class="propertyBlock__address">([^<]+)<\/span>/);
    const address = addrM ? addrM[1].trim() : null;
    const cityM = (address ?? aText).match(/([^\s　]+[市区町村])/);
    const city = cityM ? cityM[1] : '';

    // Station: <span class="propertyBlock__access">VALUE</span>
    const stM = chunk.slice(aStart, aEnd > 0 ? aEnd : aStart + 1000)
      .match(/<span class="propertyBlock__access">([^<]+)<\/span>/);
    const stText = stM ? stM[1] : '';
    const stWalkM = stText.match(/(\S+駅?)\s*(?:徒歩)?(\d+)分/);
    const station = stWalkM ? stWalkM[1].replace(/駅$/, '') : null;
    const stationMinutes = stWalkM ? parseInt(stWalkM[2]) : null;

    properties.push({
      id: `rakumachi_${sitePropertyId}`,
      siteId: 'rakumachi', sitePropertyId, title,
      propertyType: 'investment', status: 'active',
      prefecture: prefCode, city, address,
      price, priceText,
      area: null, buildingArea: null, landArea: null,
      rooms: null, age: null, floor: null, totalFloors: null,
      station, stationMinutes,
      thumbnailUrl: null, detailUrl,
      description: null, yieldRate,
      latitude: null, longitude: null, fingerprint: null, listedAt: null,
    });
  }
  return properties;
}

async function fetchListingPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.text();
}

// プロパティ配列をCSVテキストに変換 (camelCase → snake_case)
function propertiesToCsv(properties) {
  const CSV_COLS = ['site_id','site_property_id','title','property_type','status',
    'prefecture','city','address','price','price_text','area','rooms','age','floor',
    'station','station_minutes','management_fee','repair_fund','direction','structure',
    'yield_rate','thumbnail_url','detail_url','description','fingerprint',
    'latitude','longitude','listed_at','sold_at'];
  const esc = v => {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const getField = (p, col) => {
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return p[col] !== undefined ? p[col] : p[camel];
  };
  const rows = properties.map(p => CSV_COLS.map(col => esc(getField(p, col))).join(','));
  return CSV_COLS.join(',') + '\n' + rows.join('\n');
}

async function importBatch(properties, batchIdx) {
  const csvText = propertiesToCsv(properties);
  try {
    const form = new FormData();
    form.append('file', new File([csvText], 'rakumachi.csv', { type: 'text/csv' }));
    const resp = await fetch(IMPORT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
      body: form,
      signal: AbortSignal.timeout(55000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log(`WARNING: batch ${batchIdx} import failed HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return { imported: 0, skipped: 0 };
    }
    const result = await resp.json();
    const imported = result.imported ?? result.imported_rows ?? result.importedRows ?? 0;
    const skipped = result.skipped ?? result.skipped_rows ?? result.skippedRows ?? 0;
    return { imported, skipped };
  } catch (e) {
    log(`ERROR: batch ${batchIdx}: ${e.message}`);
    return { imported: 0, skipped: 0 };
  }
}

async function importToWorker(properties) {
  if (properties.length === 0) return { imported: 0, skipped: 0 };
  if (DRY_RUN) {
    log(`[DRY-RUN] would import ${properties.length} properties`);
    return { imported: properties.length, skipped: 0 };
  }

  // バッチサイズ100件に分割して送信 (Workerの60秒タイムアウト対策)
  const BATCH_SIZE = 100;
  let totalImported = 0, totalSkipped = 0;
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(properties.length / BATCH_SIZE);
    log(`  バッチ ${batchIdx}/${total}: ${batch.length}件送信中...`);
    const { imported, skipped } = await importBatch(batch, batchIdx);
    totalImported += imported;
    totalSkipped += skipped;
    log(`  バッチ ${batchIdx}/${total}: imported=${imported} skipped=${skipped}`);
    if (i + BATCH_SIZE < properties.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { imported: totalImported, skipped: totalSkipped };
}

async function main() {
  log('楽待 物件一覧スクレイプ開始 (10県 × 2ページ)');
  const seen = new Set();
  const allProperties = [];

  for (const { prefNum, prefCode } of TARGET_PREFS) {
    for (let page = 1; page <= 2; page++) {
      const url = `https://www.rakumachi.jp/syuuekibukken/area/prefecture/dimAll/?pref=${prefNum}&limit=50&page=${page}`;
      try {
        log(`取得: pref=${prefNum} page=${page}`);
        const html = await fetchListingPage(url);
        const props = parseListingHtml(html, prefCode);
        let added = 0;
        for (const p of props) {
          if (seen.has(p.sitePropertyId)) continue;
          seen.add(p.sitePropertyId);
          allProperties.push(p);
          added++;
        }
        log(`  → ${props.length}件取得, ${added}件追加 (累計: ${allProperties.length}件)`);
        if (props.length < 5) break;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        log(`WARNING: pref=${prefNum} page=${page} → ${e.message}`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  log(`合計 ${allProperties.length} 件 (重複除去後)`);
  const { imported, skipped } = await importToWorker(allProperties);
  log(`インポート完了: imported=${imported} skipped=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
