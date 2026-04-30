#!/usr/bin/env node
/**
 * HOME'S 中古マンション → MAL D1 インポート (Playwright版)
 * HOME'S は AWS WAF bot challenge があるため Playwright の実ブラウザを使用
 * ※ Worker IP は 403 ブロック、Node fetch は 202 WAF challenge のためローカル実行が必要
 *
 * Usage: node scripts/scrape-homes-local.mjs [--dry-run] [--pref=13]
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
const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;
const CURRENT_YEAR = new Date().getFullYear();

// 主要都道府県 (prefNum = pref parameter for homes.co.jp)
const TARGET_PREFS = [
  { prefNum: 13, prefCode: '13', name: '東京' },
  { prefNum: 14, prefCode: '14', name: '神奈川' },
  { prefNum: 27, prefCode: '27', name: '大阪' },
  { prefNum: 23, prefCode: '23', name: '愛知' },
  { prefNum: 11, prefCode: '11', name: '埼玉' },
  { prefNum: 28, prefCode: '28', name: '兵庫' },
  { prefNum: 40, prefCode: '40', name: '福岡' },
  { prefNum: 12, prefCode: '12', name: '千葉' },
  { prefNum: 26, prefCode: '26', name: '京都' },
  { prefNum: 34, prefCode: '34', name: '広島' },
  { prefNum: 1,  prefCode: '01', name: '北海道' },
  { prefNum: 4,  prefCode: '04', name: '宮城' },
];

function log(msg) { console.log(`[${new Date().toISOString()}] [homes-local] ${msg}`); }
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

function itemToProperty(item, prefCode) {
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
    propertyType: 'mansion',
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

async function importSingleBatch(properties, batchIdx) {
  const csvText = propertiesToCsv(properties);
  try {
    const form = new FormData();
    form.append('file', new File([csvText], 'homes.csv', { type: 'text/csv' }));
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
    // If JSON-LD is present, the real page has loaded
    if (html.includes('application/ld+json') || html.includes('ItemList')) return html;
    // If it's not a WAF page and has some real content, return it
    if (!html.includes('awsWafCoo') && !html.includes('aws-waf') && html.length > 5000) return html;
    log(`  ${name} page=${pageNum}: WAF challenge, waiting 3s... (attempt ${attempt + 1}/6)`);
    await pw_page.waitForTimeout(3000);
  }
  const html = await pw_page.content();
  if (html.includes('application/ld+json') || html.includes('ItemList')) return html;
  return null; // still blocked
}

async function scrapePrefWithBrowser(browser, { prefNum, prefCode, name }) {
  const props = [];
  const seen = new Set();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: {
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
    },
  });

  // Reuse a single page to preserve WAF cookies across pagination
  const pw_page = await context.newPage();

  try {
    for (let page = 1; page <= 3; page++) {
      const url = `https://www.homes.co.jp/mansion/chuko/list/?pref=${prefNum}&page=${page}`;
      log(`  ${name} (pref=${prefNum}) page=${page}`);

      try {
        await pw_page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pw_page.waitForTimeout(4000);

        const html = await waitForHomes(pw_page, name, page);
        if (!html) {
          log(`  ${name} page=${page}: WAF challenge not resolved, stopping`);
          break;
        }

        const items = parseItemListFromHtml(html);

        if (items.length === 0) {
          log(`  ${name} page=${page}: 0件 (JSON-LD ItemList なし or 最終ページ)`);
          break;
        }

        let added = 0;
        for (const item of items) {
          const prop = itemToProperty(item, prefCode);
          if (!prop || seen.has(prop.sitePropertyId)) continue;
          seen.add(prop.sitePropertyId);
          props.push(prop);
          added++;
        }
        log(`  ${name} page=${page}: ${items.length}件取得, ${added}件追加`);

        if (items.length < 10) break; // 最終ページ
        if (page < 3) await sleep(2000);
      } catch (e) {
        log(`  WARNING: ${name} page=${page} error: ${e.message}`);
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
  const targets = PREF_ARG
    ? TARGET_PREFS.filter(p => String(p.prefNum) === PREF_ARG || p.prefCode === PREF_ARG)
    : TARGET_PREFS;

  if (targets.length === 0) {
    log(`ERROR: --pref=${PREF_ARG} に対応する都道府県が見つかりません`);
    process.exit(1);
  }

  log(`HOME'S ローカルスクレイパー開始 (Playwright版, ${targets.length}都道府県)`);

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
  const seen = new Set();

  try {
    for (const pref of targets) {
      try {
        const props = await scrapePrefWithBrowser(browser, pref);
        for (const p of props) {
          if (seen.has(p.sitePropertyId)) continue;
          seen.add(p.sitePropertyId);
          allProps.push(p);
        }
        log(`  ${pref.name}: ${props.length}件 (累計 ${allProps.length}件)`);
      } catch (e) {
        log(`ERROR: ${pref.name}: ${e.message}`);
      }
      await sleep(2000);
    }
  } finally {
    await browser.close();
  }

  log(`合計 ${allProps.length}件 → インポート開始`);
  const { imported, skipped } = await importToWorker(allProps);
  log(`完了: imported=${imported} skipped=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
