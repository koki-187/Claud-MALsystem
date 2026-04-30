#!/usr/bin/env node
/**
 * 楽待 全47都道府県 × 全ページ → MAL D1 インポート
 * HTMLスクレイピングで全件取得 (RSSより大幅に多くの件数)
 *
 * Usage: node scripts/scrape-rakumachi-full-local.mjs [--dry-run] [--pref=13] [--max-pages=20]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const PREF_ARG = process.argv.find(a => a.startsWith('--pref='))?.split('=')[1];
const MAX_PAGES_ARG = parseInt(process.argv.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '20');
const MAX_PAGES = isNaN(MAX_PAGES_ARG) ? 20 : MAX_PAGES_ARG;

const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 47都道府県 (prefCode → { prefNum, name })
const PREF_INFO = {
  '01': { prefNum: 1,  name: '北海道' },
  '02': { prefNum: 2,  name: '青森' },
  '03': { prefNum: 3,  name: '岩手' },
  '04': { prefNum: 4,  name: '宮城' },
  '05': { prefNum: 5,  name: '秋田' },
  '06': { prefNum: 6,  name: '山形' },
  '07': { prefNum: 7,  name: '福島' },
  '08': { prefNum: 8,  name: '茨城' },
  '09': { prefNum: 9,  name: '栃木' },
  '10': { prefNum: 10, name: '群馬' },
  '11': { prefNum: 11, name: '埼玉' },
  '12': { prefNum: 12, name: '千葉' },
  '13': { prefNum: 13, name: '東京' },
  '14': { prefNum: 14, name: '神奈川' },
  '15': { prefNum: 15, name: '新潟' },
  '16': { prefNum: 16, name: '富山' },
  '17': { prefNum: 17, name: '石川' },
  '18': { prefNum: 18, name: '福井' },
  '19': { prefNum: 19, name: '山梨' },
  '20': { prefNum: 20, name: '長野' },
  '21': { prefNum: 21, name: '岐阜' },
  '22': { prefNum: 22, name: '静岡' },
  '23': { prefNum: 23, name: '愛知' },
  '24': { prefNum: 24, name: '三重' },
  '25': { prefNum: 25, name: '滋賀' },
  '26': { prefNum: 26, name: '京都' },
  '27': { prefNum: 27, name: '大阪' },
  '28': { prefNum: 28, name: '兵庫' },
  '29': { prefNum: 29, name: '奈良' },
  '30': { prefNum: 30, name: '和歌山' },
  '31': { prefNum: 31, name: '鳥取' },
  '32': { prefNum: 32, name: '島根' },
  '33': { prefNum: 33, name: '岡山' },
  '34': { prefNum: 34, name: '広島' },
  '35': { prefNum: 35, name: '山口' },
  '36': { prefNum: 36, name: '徳島' },
  '37': { prefNum: 37, name: '香川' },
  '38': { prefNum: 38, name: '愛媛' },
  '39': { prefNum: 39, name: '高知' },
  '40': { prefNum: 40, name: '福岡' },
  '41': { prefNum: 41, name: '佐賀' },
  '42': { prefNum: 42, name: '長崎' },
  '43': { prefNum: 43, name: '熊本' },
  '44': { prefNum: 44, name: '大分' },
  '45': { prefNum: 45, name: '宮崎' },
  '46': { prefNum: 46, name: '鹿児島' },
  '47': { prefNum: 47, name: '沖縄' },
};

function log(msg) { console.log(`[${new Date().toISOString()}] [rakumachi-full] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPrice(text) {
  const cleaned = (text ?? '').replace(/[,\s]/g, '');
  const oku = cleaned.match(/(\d+(?:\.\d+)?)億(?:(\d+)万)?円/);
  if (oku) {
    const price = Math.round(parseFloat(oku[1]) * 10000) + (oku[2] ? parseInt(oku[2]) : 0);
    return { price, priceText: text.trim() };
  }
  const man = cleaned.match(/(\d+(?:\.\d+)?)万円?/);
  if (man) return { price: Math.round(parseFloat(man[1])), priceText: text.trim() };
  return { price: null, priceText: '価格要相談' };
}

function extractYieldRate(text) {
  const m = (text ?? '').match(/([0-9]+(?:\.[0-9]+)?)\s*[%％]/);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 50) return v; }
  return null;
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
          'Referer': 'https://www.rakumachi.jp/',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      if (attempt < retries) {
        log(`  fetch失敗 (attempt ${attempt}/${retries}): ${e.message} — 2秒後リトライ`);
        await sleep(2000);
      } else {
        throw e;
      }
    }
  }
}

function parseRakumachiPage(html, prefCode) {
  const properties = [];
  const seen = new Set();

  // 物件名: <p class="propertyBlock__name">TITLE</p>
  const nameRe = /<p\s+class="propertyBlock__name">([^<]+)<\/p>/g;

  for (const nm of html.matchAll(nameRe)) {
    const title = nm[1].trim();
    if (!title) continue;

    // look ahead up to 3000 chars for the show.html link
    const afterTitle = html.indexOf(nm[0]) + nm[0].length;
    const chunk = html.slice(afterTitle, afterTitle + 3000);

    // 詳細URL: /syuuekibukken/TYPE/ID/show.html
    const urlM = chunk.match(/href="(\/syuuekibukken\/[^"]+\/(\d+)\/show\.html)"/);
    if (!urlM) continue;
    const path = urlM[1];
    const sitePropertyId = urlM[2];
    if (seen.has(sitePropertyId)) continue;
    seen.add(sitePropertyId);

    const detailUrl = `https://www.rakumachi.jp${path}`;

    // 価格: <b class="price">VALUE</b>
    const segEnd = chunk.indexOf('</a>', chunk.indexOf(`href="${path}"`));
    const seg = segEnd > 0
      ? chunk.slice(chunk.indexOf(`href="${path}"`), segEnd + 4)
      : chunk.slice(0, 1500);

    const bPriceM = seg.match(/<b\s+class="price">([^<]+)<\/b>/);
    const rawPriceText = bPriceM ? bPriceM[1] : (seg.replace(/<[^>]+>/g, ' ').match(/[0-9,]+万円?|[0-9.]+億[^万\n]*円/)?.[0] ?? '');
    const { price, priceText } = extractPrice(rawPriceText);

    // 利回り: <b class="gross">VALUE</b>
    const bYieldM = seg.match(/<b\s+class="gross">([^<]+)<\/b>/);
    const yieldRate = bYieldM ? extractYieldRate(bYieldM[1]) : null;

    // 住所: <p class="propertyBlock__address">VALUE</p> または <span class="propertyBlock__address">
    const addrM = chunk.slice(0, 2000).match(/<(?:p|span)\s+class="propertyBlock__address">([^<]+)<\/(?:p|span)>/);
    const address = addrM ? addrM[1].trim() : null;
    const city = (address ?? '').match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // 路線・アクセス: <span class="propertyBlock__access">
    const accessM = chunk.slice(0, 2000).match(/<span\s+class="propertyBlock__access">([^<]+)<\/span>/);
    const accessText = accessM ? accessM[1] : '';
    const stWalkM = accessText.match(/(\S+駅?)\s*(?:徒歩)?(\d+)分/);
    const station = stWalkM ? stWalkM[1].replace(/駅$/, '') : null;
    const stationMinutes = stWalkM ? parseInt(stWalkM[2]) : null;

    // 物件種別テキスト
    const dimM = chunk.slice(0, 2000).match(/<p\s+class="propertyBlock__dimension">([^<]+)<\/p>/);
    const dimensionText = dimM ? dimM[1].trim() : null;

    properties.push({
      id: `rakumachi_${sitePropertyId}`,
      siteId: 'rakumachi',
      sitePropertyId,
      title,
      propertyType: 'investment',
      status: 'active',
      prefecture: prefCode,
      city,
      address,
      price,
      priceText: priceText || '価格要相談',
      area: null,
      buildingArea: null,
      landArea: null,
      rooms: null,
      age: null,
      floor: null,
      totalFloors: null,
      station,
      stationMinutes,
      thumbnailUrl: null,
      detailUrl,
      description: dimensionText,
      yieldRate,
      latitude: null,
      longitude: null,
      fingerprint: null,
      listedAt: null,
    });
  }

  return properties;
}

function propertiesToCsv(properties) {
  const CSV_COLS = ['site_id', 'site_property_id', 'title', 'property_type', 'status',
    'prefecture', 'city', 'address', 'price', 'price_text', 'area', 'rooms', 'age', 'floor',
    'station', 'station_minutes', 'management_fee', 'repair_fund', 'direction', 'structure',
    'yield_rate', 'thumbnail_url', 'detail_url', 'description', 'fingerprint',
    'latitude', 'longitude', 'listed_at', 'sold_at'];
  const esc = v => {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).replace(/\r/g, '');  // strip CR to prevent column misalignment
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

async function importSingleBatch(properties, batchIdx) {
  const csvText = propertiesToCsv(properties);
  try {
    const form = new FormData();
    form.append('file', new File([csvText], 'import.csv', { type: 'text/csv' }));
    const resp = await fetch(IMPORT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
      body: form,
      signal: AbortSignal.timeout(55000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log(`WARNING: batch ${batchIdx} import failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return { imported: 0, skipped: 0 };
    }
    const result = await resp.json();
    return {
      imported: result.imported ?? result.imported_rows ?? result.importedRows ?? 0,
      skipped: result.skipped ?? result.skipped_rows ?? result.skippedRows ?? 0,
    };
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
  const BATCH_SIZE = 100;
  let totalImported = 0, totalSkipped = 0;
  const totalBatches = Math.ceil(properties.length / BATCH_SIZE);
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE) + 1;
    log(`  バッチ ${batchIdx}/${totalBatches}: ${batch.length}件送信中...`);
    const { imported, skipped } = await importSingleBatch(batch, batchIdx);
    totalImported += imported;
    totalSkipped += skipped;
    log(`  バッチ ${batchIdx}/${totalBatches}: imported=${imported} skipped=${skipped}`);
    if (i + BATCH_SIZE < properties.length) await sleep(1000);
  }
  return { imported: totalImported, skipped: totalSkipped };
}

async function scrapePref(prefCode) {
  const info = PREF_INFO[prefCode];
  if (!info) return [];
  const { prefNum, name } = info;
  const props = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.rakumachi.jp/syuuekibukken/area/?pref_code=${prefNum}&page=${page}&sort=property_created_at&sort_type=desc`;

    try {
      const html = await fetchWithRetry(url);
      const batch = parseRakumachiPage(html, prefCode);

      let added = 0;
      for (const p of batch) {
        if (seen.has(p.sitePropertyId)) continue;
        seen.add(p.sitePropertyId);
        props.push(p);
        added++;
      }

      log(`${name} (${prefCode}) page=${page}: ${added}件 (累計: ${props.length}件)`);

      if (batch.length === 0) break;
      if (page < MAX_PAGES) await sleep(1500);
    } catch (e) {
      log(`WARNING: ${name} (${prefCode}) page=${page}: ${e.message}`);
      break;
    }
  }

  return props;
}

async function main() {
  const prefCodes = PREF_ARG
    ? [PREF_ARG.padStart(2, '0')]
    : Object.keys(PREF_INFO);

  const invalidCodes = prefCodes.filter(c => !PREF_INFO[c]);
  if (invalidCodes.length > 0) {
    log(`ERROR: 無効な都道府県コード: ${invalidCodes.join(', ')}`);
    process.exit(1);
  }

  log(`楽待 全件スクレイパー開始 (${prefCodes.length}都道府県, 最大${MAX_PAGES}ページ/県)`);

  const allProps = [];
  const seen = new Set();
  let totalImported = 0, totalSkipped = 0;

  for (const prefCode of prefCodes) {
    try {
      const props = await scrapePref(prefCode);
      let added = 0;
      for (const p of props) {
        if (seen.has(p.sitePropertyId)) continue;
        seen.add(p.sitePropertyId);
        allProps.push(p);
        added++;
      }
      const name = PREF_INFO[prefCode]?.name ?? prefCode;
      log(`${name}: ${added}件追加 (累計 ${allProps.length}件)`);

      // 都道府県ごとにインポートしてメモリを節約
      if (allProps.length >= 500) {
        const batch = allProps.splice(0, allProps.length);
        log(`中間インポート: ${batch.length}件`);
        const { imported, skipped } = await importToWorker(batch);
        totalImported += imported;
        totalSkipped += skipped;
        log(`中間インポート完了: imported=${imported} skipped=${skipped}`);
      }
    } catch (e) {
      log(`ERROR: ${PREF_INFO[prefCode]?.name ?? prefCode}: ${e.message}`);
    }
    await sleep(2000);
  }

  // 残りをインポート
  if (allProps.length > 0) {
    const { imported, skipped } = await importToWorker(allProps);
    totalImported += imported;
    totalSkipped += skipped;
  }

  log(`✅ 完了: imported=${totalImported}, skipped=${totalSkipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
