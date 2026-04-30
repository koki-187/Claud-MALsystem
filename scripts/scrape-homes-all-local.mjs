#!/usr/bin/env node
/**
 * HOME'S 全カテゴリ全47都道府県 → MAL D1 インポート (Playwright版)
 * 6カテゴリ × 47都道府県で目標+50,000件を収集
 *
 * Usage:
 *   node scripts/scrape-homes-all-local.mjs [options]
 *   --dry-run              : インポートせず件数のみ表示
 *   --pref=13              : 特定都道府県のみ (prefNum指定)
 *   --category=chintai_mansion : 特定カテゴリのみ
 *   --max-pages=5          : 最大ページ数 (デフォルト: 5)
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
const CATEGORY_ARG = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
const MAX_PAGES_ARG = parseInt(process.argv.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '5', 10);
const MAX_PAGES = isNaN(MAX_PAGES_ARG) ? 5 : MAX_PAGES_ARG;

const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;
const CURRENT_YEAR = new Date().getFullYear();

// 対象カテゴリ
const CATEGORIES = [
  { key: 'chintai_mansion',  path: 'mansion/chintai/list',  siteId: 'homes', propertyType: 'chintai_mansion' },
  { key: 'chintai_ikkodate', path: 'ikkodate/chintai/list', siteId: 'homes', propertyType: 'chintai_ikkodate' },
  { key: 'baibai_mansion',   path: 'mansion/chuko/list',    siteId: 'homes', propertyType: 'mansion' },
  { key: 'baibai_kodate',    path: 'kodate/list',           siteId: 'homes', propertyType: 'kodate' },
  { key: 'baibai_tochi',     path: 'tochi/list',            siteId: 'homes', propertyType: 'tochi' },
  { key: 'shinchiku',        path: 'mansion/shinchiku/list', siteId: 'homes', propertyType: 'mansion' },
];

// 全47都道府県
const ALL_PREFS = [
  { prefNum:  1, prefCode: '01', name: '北海道' },
  { prefNum:  2, prefCode: '02', name: '青森' },
  { prefNum:  3, prefCode: '03', name: '岩手' },
  { prefNum:  4, prefCode: '04', name: '宮城' },
  { prefNum:  5, prefCode: '05', name: '秋田' },
  { prefNum:  6, prefCode: '06', name: '山形' },
  { prefNum:  7, prefCode: '07', name: '福島' },
  { prefNum:  8, prefCode: '08', name: '茨城' },
  { prefNum:  9, prefCode: '09', name: '栃木' },
  { prefNum: 10, prefCode: '10', name: '群馬' },
  { prefNum: 11, prefCode: '11', name: '埼玉' },
  { prefNum: 12, prefCode: '12', name: '千葉' },
  { prefNum: 13, prefCode: '13', name: '東京' },
  { prefNum: 14, prefCode: '14', name: '神奈川' },
  { prefNum: 15, prefCode: '15', name: '新潟' },
  { prefNum: 16, prefCode: '16', name: '富山' },
  { prefNum: 17, prefCode: '17', name: '石川' },
  { prefNum: 18, prefCode: '18', name: '福井' },
  { prefNum: 19, prefCode: '19', name: '山梨' },
  { prefNum: 20, prefCode: '20', name: '長野' },
  { prefNum: 21, prefCode: '21', name: '岐阜' },
  { prefNum: 22, prefCode: '22', name: '静岡' },
  { prefNum: 23, prefCode: '23', name: '愛知' },
  { prefNum: 24, prefCode: '24', name: '三重' },
  { prefNum: 25, prefCode: '25', name: '滋賀' },
  { prefNum: 26, prefCode: '26', name: '京都' },
  { prefNum: 27, prefCode: '27', name: '大阪' },
  { prefNum: 28, prefCode: '28', name: '兵庫' },
  { prefNum: 29, prefCode: '29', name: '奈良' },
  { prefNum: 30, prefCode: '30', name: '和歌山' },
  { prefNum: 31, prefCode: '31', name: '鳥取' },
  { prefNum: 32, prefCode: '32', name: '島根' },
  { prefNum: 33, prefCode: '33', name: '岡山' },
  { prefNum: 34, prefCode: '34', name: '広島' },
  { prefNum: 35, prefCode: '35', name: '山口' },
  { prefNum: 36, prefCode: '36', name: '徳島' },
  { prefNum: 37, prefCode: '37', name: '香川' },
  { prefNum: 38, prefCode: '38', name: '愛媛' },
  { prefNum: 39, prefCode: '39', name: '高知' },
  { prefNum: 40, prefCode: '40', name: '福岡' },
  { prefNum: 41, prefCode: '41', name: '佐賀' },
  { prefNum: 42, prefCode: '42', name: '長崎' },
  { prefNum: 43, prefCode: '43', name: '熊本' },
  { prefNum: 44, prefCode: '44', name: '大分' },
  { prefNum: 45, prefCode: '45', name: '宮崎' },
  { prefNum: 46, prefCode: '46', name: '鹿児島' },
  { prefNum: 47, prefCode: '47', name: '沖縄' },
];

function log(msg) { console.log(`[${new Date().toISOString()}] [homes-all] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractIdFromUrl(url) {
  const m = url.match(/\/b-(\d+)\//);
  if (m) return m[1];
  const path = url.replace(/https?:\/\/[^/]+/, '').replace(/\/$/, '');
  return Buffer.from(path).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

function extractCityFromAddress(addr) {
  return addr?.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
}

// homes-local.mjs から完全コピー
function parseItemListFromHtml(html) {
  const jldMatches = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
  for (const m of jldMatches) {
    try {
      const j = JSON.parse(m[1]);
      if (j['@type'] === 'ItemList' && Array.isArray(j.itemListElement) && j.itemListElement.length > 0) {
        return j.itemListElement.map(e => e.item ?? e).filter(Boolean);
      }
    } catch { continue; }
  }
  return [];
}

function itemToProperty(item, prefCode, propertyType) {
  const url = String(item.url ?? '');
  if (!url) return null;

  const sitePropertyId = extractIdFromUrl(url);
  const title = String(item.name ?? '').trim();
  if (!title) return null;

  const offer = item.offers ?? {};
  const offered = offer.itemOffered ?? {};

  // Price: in JPY → 万円
  const rawPrice = parseFloat(String(offer.price ?? ''));
  const price = isNaN(rawPrice) ? null : Math.round(rawPrice / 10000);
  const priceText = price ? `${price.toLocaleString()}万円` : '価格要相談';

  // Area
  const area = parseFloat(String(offered.floorSize?.value ?? '')) || null;

  // Age (from yearBuilt)
  const yearBuilt = parseInt(String(offered.yearBuilt ?? '')) || null;
  const age = yearBuilt ? CURRENT_YEAR - yearBuilt : null;

  // Address & city
  const addrRaw = String(offered.address?.name ?? offered.address?.streetAddress ?? '');
  const city = extractCityFromAddress(addrRaw);

  // Thumbnail
  const img = item.image;
  const thumbnailUrl = typeof img === 'string' ? img
    : Array.isArray(img) && img.length > 0 ? String(img[0]) : null;

  // Geo
  const geo = item.geo ?? {};
  const latitude = typeof geo.latitude === 'number' ? geo.latitude : null;
  const longitude = typeof geo.longitude === 'number' ? geo.longitude : null;

  return {
    id: `homes_${sitePropertyId}`,
    siteId: 'homes',
    sitePropertyId,
    title,
    propertyType,
    status: 'active',
    prefecture: prefCode,
    city,
    address: addrRaw || null,
    price,
    priceText,
    area,
    buildingArea: null,
    landArea: null,
    rooms: null,
    age,
    floor: null,
    totalFloors: null,
    station: null,
    stationMinutes: null,
    thumbnailUrl,
    detailUrl: url,
    description: null,
    yieldRate: null,
    latitude,
    longitude,
    fingerprint: null,
    listedAt: null,
  };
}

// CSV変換
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
    form.append('file', new File([csvText], 'homes-all.csv', { type: 'text/csv' }));
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

async function waitForHomes(pw_page, name, pageNum) {
  // AWS WAF sets a cookie via JS challenge then redirects; wait until challenge resolves
  for (let attempt = 0; attempt < 6; attempt++) {
    const html = await pw_page.content();
    if (html.includes('application/ld+json') || html.includes('ItemList')) return html;
    if (!html.includes('awsWafCoo') && !html.includes('aws-waf') && html.length > 5000) return html;
    log(`  ${name}: WAF challenge, waiting 3s... (attempt ${attempt + 1}/6)`);
    await pw_page.waitForTimeout(3000);
  }
  const html = await pw_page.content();
  if (html.includes('application/ld+json') || html.includes('ItemList')) return html;
  return null; // still blocked
}

async function scrapePrefCategory(browser, pref, category, totalCount) {
  const { prefNum, prefCode, name } = pref;
  const { key: catKey, path: catPath, propertyType } = category;

  const props = [];
  const seen = new Set();

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: {
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
    },
  });

  // 1都道府県1ブラウザページを使い回す（Cookie維持）
  const pw_page = await context.newPage();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://www.homes.co.jp/${catPath}/?pref=${prefNum}&page=${page}`;

      try {
        await pw_page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pw_page.waitForTimeout(4000);

        const html = await waitForHomes(pw_page, `${name} ${catKey}`, page);
        if (!html) {
          log(`  ${name} (${prefNum}) ${catKey} page=${page}: WAF challenge not resolved, stopping`);
          break;
        }

        const items = parseItemListFromHtml(html);

        if (items.length === 0) {
          log(`  ${name} (${prefNum}) ${catKey} page=${page}: 0件 (JSON-LD ItemList なし or 最終ページ)`);
          break;
        }

        let added = 0;
        for (const item of items) {
          const prop = itemToProperty(item, prefCode, propertyType);
          if (!prop || seen.has(prop.sitePropertyId)) continue;
          seen.add(prop.sitePropertyId);
          props.push(prop);
          added++;
        }

        const cumTotal = totalCount + props.length;
        log(`[homes-all] ${name} (${String(prefNum).padStart(2, '0')}) ${catKey} page=${page}: ${items.length}件 (累計: ${cumTotal}件)`);

        if (items.length < 10) break; // 最終ページ
        if (page < MAX_PAGES) await sleep(2000);
      } catch (e) {
        log(`  WARNING: ${name} ${catKey} page=${page} error: ${e.message}`);
        break;
      }
    }
  } finally {
    await pw_page.close();
    await context.close();
  }

  return props;
}

async function main() {
  // 都道府県フィルタ
  const targetPrefs = PREF_ARG
    ? ALL_PREFS.filter(p => String(p.prefNum) === PREF_ARG || p.prefCode === PREF_ARG)
    : ALL_PREFS;

  if (targetPrefs.length === 0) {
    log(`ERROR: --pref=${PREF_ARG} に対応する都道府県が見つかりません`);
    process.exit(1);
  }

  // カテゴリフィルタ
  const targetCategories = CATEGORY_ARG
    ? CATEGORIES.filter(c => c.key === CATEGORY_ARG)
    : CATEGORIES;

  if (targetCategories.length === 0) {
    log(`ERROR: --category=${CATEGORY_ARG} に対応するカテゴリが見つかりません`);
    log(`利用可能カテゴリ: ${CATEGORIES.map(c => c.key).join(', ')}`);
    process.exit(1);
  }

  log(`HOME'S 全カテゴリスクレイパー開始 (Playwright版)`);
  log(`対象: ${targetPrefs.length}都道府県 × ${targetCategories.length}カテゴリ, 最大${MAX_PAGES}ページ/都道府県`);
  if (DRY_RUN) log('[DRY-RUN] モード: インポートは行いません');

  // Dynamic import of playwright from mal-worker's node_modules
  const { chromium } = require('playwright');

  log('Chrome ブラウザを起動中...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',           // System Chrome passes AWS WAF bot detection
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const allProps = [];
  const globalSeen = new Set();
  let totalImported = 0;
  let totalSkipped = 0;

  try {
    for (const category of targetCategories) {
      log(`\n--- カテゴリ: ${category.key} (${category.path}) ---`);

      for (const pref of targetPrefs) {
        try {
          const props = await scrapePrefCategory(browser, pref, category, allProps.length);

          let added = 0;
          for (const p of props) {
            if (globalSeen.has(p.sitePropertyId)) continue;
            globalSeen.add(p.sitePropertyId);
            allProps.push(p);
            added++;
          }

          if (added > 0) {
            // バッチインポート (100件ごと)
            const { imported, skipped } = await importToWorker(allProps.splice(0, allProps.length));
            totalImported += imported;
            totalSkipped += skipped;
          }
        } catch (e) {
          log(`ERROR: ${pref.name} ${category.key}: ${e.message}`);
        }
        await sleep(2000);
      }
    }
  } finally {
    // 残りをインポート
    if (allProps.length > 0) {
      const { imported, skipped } = await importToWorker(allProps);
      totalImported += imported;
      totalSkipped += skipped;
    }
    await browser.close();
  }

  log(`\n[homes-all] 完了: imported=${totalImported}, skipped=${totalSkipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
