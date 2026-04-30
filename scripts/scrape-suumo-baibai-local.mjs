#!/usr/bin/env node
/**
 * SUUMO 中古マンション売買 全47都道府県 → MAL D1 インポート (Playwright版)
 * /ms/chuko/{pref}/{city}/?page=N 形式の都市別リストページを使用
 * nc_XXXXXXXX 形式の実物件IDを取得し重複排除
 *
 * Usage:
 *   node scripts/scrape-suumo-baibai-local.mjs [--dry-run] [--pref=tokyo] [--max-pages=50]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DRY_RUN      = process.argv.includes('--dry-run');
const PREF_ARG     = process.argv.find(a => a.startsWith('--pref='))?.split('=')[1];
const MAX_PAGES    = parseInt(process.argv.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '200', 10);
const API_BASE     = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL   = `${API_BASE}/api/admin/import`;
const CURRENT_YEAR = new Date().getFullYear();

const SUUMO_BASE = 'https://suumo.jp';

// 47都道府県 → SUUMO URLスラグ + 都道府県コード
const PREFS = [
  { slug: 'hokkaido_', prefCode: '01', name: '北海道' },
  { slug: 'aomori',   prefCode: '02', name: '青森' },
  { slug: 'iwate',    prefCode: '03', name: '岩手' },
  { slug: 'miyagi',   prefCode: '04', name: '宮城' },
  { slug: 'akita',    prefCode: '05', name: '秋田' },
  { slug: 'yamagata', prefCode: '06', name: '山形' },
  { slug: 'fukushima',prefCode: '07', name: '福島' },
  { slug: 'ibaraki',  prefCode: '08', name: '茨城' },
  { slug: 'tochigi',  prefCode: '09', name: '栃木' },
  { slug: 'gumma',    prefCode: '10', name: '群馬' },
  { slug: 'saitama',  prefCode: '11', name: '埼玉' },
  { slug: 'chiba',    prefCode: '12', name: '千葉' },
  { slug: 'tokyo',    prefCode: '13', name: '東京' },
  { slug: 'kanagawa', prefCode: '14', name: '神奈川' },
  { slug: 'niigata',  prefCode: '15', name: '新潟' },
  { slug: 'toyama',   prefCode: '16', name: '富山' },
  { slug: 'ishikawa', prefCode: '17', name: '石川' },
  { slug: 'fukui',    prefCode: '18', name: '福井' },
  { slug: 'yamanashi',prefCode: '19', name: '山梨' },
  { slug: 'nagano',   prefCode: '20', name: '長野' },
  { slug: 'gifu',     prefCode: '21', name: '岐阜' },
  { slug: 'shizuoka', prefCode: '22', name: '静岡' },
  { slug: 'aichi',    prefCode: '23', name: '愛知' },
  { slug: 'mie',      prefCode: '24', name: '三重' },
  { slug: 'shiga',    prefCode: '25', name: '滋賀' },
  { slug: 'kyoto',    prefCode: '26', name: '京都' },
  { slug: 'osaka',    prefCode: '27', name: '大阪' },
  { slug: 'hyogo',    prefCode: '28', name: '兵庫' },
  { slug: 'nara',     prefCode: '29', name: '奈良' },
  { slug: 'wakayama', prefCode: '30', name: '和歌山' },
  { slug: 'tottori',  prefCode: '31', name: '鳥取' },
  { slug: 'shimane',  prefCode: '32', name: '島根' },
  { slug: 'okayama',  prefCode: '33', name: '岡山' },
  { slug: 'hiroshima',prefCode: '34', name: '広島' },
  { slug: 'yamaguchi',prefCode: '35', name: '山口' },
  { slug: 'tokushima',prefCode: '36', name: '徳島' },
  { slug: 'kagawa',   prefCode: '37', name: '香川' },
  { slug: 'ehime',    prefCode: '38', name: '愛媛' },
  { slug: 'kochi',    prefCode: '39', name: '高知' },
  { slug: 'fukuoka',  prefCode: '40', name: '福岡' },
  { slug: 'saga',     prefCode: '41', name: '佐賀' },
  { slug: 'nagasaki', prefCode: '42', name: '長崎' },
  { slug: 'kumamoto', prefCode: '43', name: '熊本' },
  { slug: 'oita',     prefCode: '44', name: '大分' },
  { slug: 'miyazaki', prefCode: '45', name: '宮崎' },
  { slug: 'kagoshima',prefCode: '46', name: '鹿児島' },
  { slug: 'okinawa',  prefCode: '47', name: '沖縄' },
];

function log(msg) { console.log(`[${new Date().toISOString()}] [suumo-baibai] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripTags(html) {
  return html
    .replace(/<sup[^>]*>2<\/sup>/gi, '²')   // m<sup>2</sup> → m²
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ').trim();
}

function extractCity(addr) {
  if (!addr) return '';
  // Match 市/区/町/村, but prefer the shortest (most local) match
  // "東京都港区白金３" → "港区"
  const all = [...addr.matchAll(/([^\s　都道府県]+[市区町村])/g)];
  return all.length > 0 ? all[all.length - 1][1] : '';
}

function parsePrice(text) {
  const clean = text.replace(/[,\s]/g, '');
  // 2億9500万円
  const okuMan = clean.match(/(\d+(?:\.\d+)?)億(\d+)万円/);
  if (okuMan) {
    const p = Math.round(parseFloat(okuMan[1]) * 10000) + parseInt(okuMan[2]);
    return { price: p, priceText: text.trim() };
  }
  // 2億円
  const oku = clean.match(/(\d+(?:\.\d+)?)億円/);
  if (oku) return { price: Math.round(parseFloat(oku[1]) * 10000), priceText: text.trim() };
  // ~8440万円 (range: take first number)
  const man = clean.match(/(\d+(?:\.\d+)?)万円/);
  if (man) return { price: Math.round(parseFloat(man[1])), priceText: text.trim() };
  return { price: null, priceText: '価格要相談' };
}

function parseArea(text) {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*m/i);
  return m ? parseFloat(m[1]) : null;
}

function parseAge(text) {
  if (/新築/.test(text)) return 0;
  // 築年月: "1975年8月"
  const yearMatch = text.match(/(\d{4})年/);
  if (yearMatch) return CURRENT_YEAR - parseInt(yearMatch[1]);
  // 築N年
  const ageMatch = text.match(/築(\d+)年/);
  if (ageMatch) return parseInt(ageMatch[1]);
  return null;
}

function parseStation(text) {
  // Match "駅" suffix: "新宿駅" OR bracket-enclosed name: 「下落合」
  const stMatch = text.match(/([^\s　「」]+駅)/) || text.match(/「([^」]+)」/);
  const minMatch = text.match(/徒歩(\d+)分/);
  return {
    station: stMatch ? stMatch[1] : null,
    stationMinutes: minMatch ? parseInt(minMatch[1]) : null,
  };
}

/**
 * Parse all property blocks from a /ms/chuko/ list page.
 * Each property is a <div class="dottable--cassette"> block.
 * The detail link (nc_XXXXXXXX) appears nearby in the surrounding container.
 */
function parsePropertyList(html, prefCode, citySlug) {
  const properties = [];

  // Split by dottable--cassette occurrences
  const parts = html.split('dottable--cassette');
  if (parts.length < 2) return properties;

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    // Look back for the nc_ link in the preceding ~600 chars
    const lookback = parts[i - 1].slice(-600);
    const ncMatch = lookback.match(/href="(\/ms\/chuko\/[^"]*\/nc_(\d+)\/)"/);
    const ncId = ncMatch ? ncMatch[2] : null;
    const detailPath = ncMatch ? ncMatch[1] : null;
    const detailUrl = detailPath ? `${SUUMO_BASE}${detailPath}` : `${SUUMO_BASE}/ms/chuko/`;
    const sitePropertyId = ncId ? `nc_${ncId}` : null;
    if (!sitePropertyId) continue;  // skip if no real ID

    // Parse dl/dt/dd pairs
    const data = {};
    const dlRe = /<dt[^>]*>([\s\S]+?)<\/dt>\s*<dd[^>]*>([\s\S]+?)<\/dd>/g;
    let dm;
    while ((dm = dlRe.exec(block)) !== null) {
      const key = stripTags(dm[1]);
      const val = stripTags(dm[2]);
      if (key && val) data[key] = val;
    }

    const title      = data['物件名'] || '';
    const priceRaw   = data['販売価格'] || '';
    const { price, priceText } = parsePrice(priceRaw);
    const addressRaw = data['所在地'] || '';
    const city       = extractCity(addressRaw);
    const stationRaw = data['沿線・駅'] || '';
    const { station, stationMinutes } = parseStation(stationRaw);
    const areaRaw    = data['専有面積'] || data['面積'] || '';
    const area       = parseArea(areaRaw);
    const rooms      = data['間取り'] || null;
    const builtRaw   = data['築年月'] || data['築年'] || '';
    const age        = builtRaw ? parseAge(builtRaw) : null;

    if (!title && !addressRaw) continue;

    // Thumbnail
    const imgMatch = lookback.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i)
      || block.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const thumbnailUrl = imgMatch ? imgMatch[1] : null;

    properties.push({
      siteId: 'suumo_baibai',
      sitePropertyId,
      title: title || `中古マンション ${city}`,
      propertyType: 'mansion',
      status: 'active',
      prefecture: prefCode,
      city,
      address: addressRaw || null,
      price,
      priceText: priceText || '価格要相談',
      area,
      buildingArea: null,
      landArea: null,
      rooms,
      age,
      floor: null,
      totalFloors: null,
      station,
      stationMinutes,
      thumbnailUrl,
      detailUrl,
      description: null,
      yieldRate: null,
      latitude: null,
      longitude: null,
      fingerprint: null,
      listedAt: null,
    });
  }

  return properties;
}

function propertiesToCsv(properties) {
  const CSV_COLS = [
    'site_id', 'site_property_id', 'title', 'property_type', 'status',
    'prefecture', 'city', 'address', 'price', 'price_text', 'area', 'rooms', 'age', 'floor',
    'station', 'station_minutes', 'management_fee', 'repair_fund', 'direction', 'structure',
    'yield_rate', 'thumbnail_url', 'detail_url', 'description', 'fingerprint',
    'latitude', 'longitude', 'listed_at', 'sold_at',
  ];
  const esc = v => {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).replace(/\r/g, '');
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
    form.append('file', new File([csvText], 'suumo-baibai.csv', { type: 'text/csv' }));
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
      skipped:  result.skipped  ?? result.skipped_rows  ?? result.skippedRows  ?? 0,
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
    if (properties.length > 0) log(`[DRY-RUN] sample: ${JSON.stringify(properties[0], null, 2)}`);
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
    if (i + BATCH_SIZE < properties.length) await sleep(800);
  }
  return { imported: totalImported, skipped: totalSkipped };
}

/**
 * Get all city slugs for a prefecture by scraping the prefecture overview page.
 */
async function getCitySlugs(page, prefSlug) {
  const url = `${SUUMO_BASE}/ms/chuko/${prefSlug}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const pattern = new RegExp(`href="(/ms/chuko/${prefSlug}/sc_[^/"]+/)"`, 'g');
    const slugs = [...new Set([...html.matchAll(pattern)].map(m => m[1]))];
    return slugs;
  } catch (e) {
    log(`WARNING: getCitySlugs(${prefSlug}) failed: ${e.message.slice(0, 100)}`);
    return [];
  }
}

/**
 * Scrape one city's listing pages.
 */
async function scrapeCity(page, prefCode, prefSlug, cityPath, globalSeen) {
  const props = [];
  const citySlug = cityPath.split('/').filter(Boolean).pop();

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = `${SUUMO_BASE}${cityPath}?page=${pageNum}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
      const html = await page.content();

      const batch = parsePropertyList(html, prefCode, citySlug);
      let added = 0;
      for (const p of batch) {
        if (globalSeen.has(p.sitePropertyId)) continue;
        globalSeen.add(p.sitePropertyId);
        props.push(p);
        added++;
      }

      if (batch.length === 0) break;  // no more pages

      // Check if there's a next page
      const hasNextPage = html.includes(`?page=${pageNum + 1}`);
      if (!hasNextPage) break;

      if (pageNum < MAX_PAGES) await sleep(800);
    } catch (e) {
      log(`  WARNING: ${cityPath} page=${pageNum}: ${e.message.slice(0, 80)}`);
      break;
    }
  }

  return props;
}

async function main() {
  const prefList = PREF_ARG
    ? PREFS.filter(p => p.slug === PREF_ARG || p.prefCode === PREF_ARG.padStart(2, '0'))
    : PREFS;

  if (prefList.length === 0) {
    log(`ERROR: 無効な都道府県指定: ${PREF_ARG}`);
    process.exit(1);
  }

  log(`SUUMO 中古マンション売買 スクレイパー開始 (/ms/chuko/ 方式)`);
  log(`  対象: ${prefList.length}都道府県, 最大${MAX_PAGES}ページ/市区, DRY_RUN=${DRY_RUN}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await ctx.newPage();

  const globalSeen = new Set();
  let totalImported = 0, totalSkipped = 0;
  const stagingBuf = [];   // buffer props before batch import

  try {
    for (const pref of prefList) {
      const { slug, prefCode, name } = pref;
      log(`\n--- ${name} (${slug}) ---`);

      // Step 1: discover city slugs
      const cityPaths = await getCitySlugs(page, slug);
      if (cityPaths.length === 0) {
        log(`  ${name}: 市区スラグ取得失敗 (スキップ)`);
        continue;
      }
      log(`  ${name}: ${cityPaths.length}市区を発見`);

      let prefTotal = 0;
      for (const cityPath of cityPaths) {
        const citySlug = cityPath.split('/').filter(Boolean).pop();
        const props = await scrapeCity(page, prefCode, slug, cityPath, globalSeen);
        prefTotal += props.length;
        stagingBuf.push(...props);
        if (props.length > 0) log(`  ${name}/${citySlug}: ${props.length}件`);

        // Batch import every 500 props
        if (stagingBuf.length >= 500) {
          const batch = stagingBuf.splice(0, stagingBuf.length);
          log(`  中間インポート: ${batch.length}件...`);
          const { imported, skipped } = await importToWorker(batch);
          totalImported += imported;
          totalSkipped += skipped;
          log(`  中間インポート完了: imported=${imported} skipped=${skipped}`);
        }

        await sleep(500);
      }
      log(`  ${name} 合計: ${prefTotal}件`);
      await sleep(1000);
    }

    // Final import of remaining
    if (stagingBuf.length > 0) {
      log(`最終インポート: ${stagingBuf.length}件...`);
      const { imported, skipped } = await importToWorker(stagingBuf);
      totalImported += imported;
      totalSkipped += skipped;
    }
  } finally {
    await browser.close();
  }

  log(`\n完了: imported=${totalImported}, skipped=${totalSkipped}, seen=${globalSeen.size}`);
}

main().catch(e => { console.error(e); process.exit(1); });
