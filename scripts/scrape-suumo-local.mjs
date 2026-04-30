#!/usr/bin/env node
/**
 * SUUMO 賃貸マンション + 中古マンション売買 → MAL D1 インポート (Playwright版)
 * SUUMO はCloudflare WorkersのIPからブロックされるためローカル実行専用
 *
 * Usage:
 *   node scripts/scrape-suumo-local.mjs
 *   node scripts/scrape-suumo-local.mjs --pref=13 --max-pages=2 --dry-run
 *   node scripts/scrape-suumo-local.mjs --mode=chintai
 *   node scripts/scrape-suumo-local.mjs --mode=baibai --max-pages=5
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

const DRY_RUN    = process.argv.includes('--dry-run');
const PREF_ARG   = process.argv.find(a => a.startsWith('--pref='))?.split('=')[1];
const MODE_ARG   = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] ?? 'all';   // chintai / baibai / all
const MAX_PAGES  = parseInt(process.argv.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '10', 10);
const API_BASE   = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;
const CURRENT_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------------------
// 全47都道府県
// ---------------------------------------------------------------------------
const ALL_PREFS = [
  { prefNum:  1, prefCode: '01', name: '北海道', ar: '030' },
  { prefNum:  2, prefCode: '02', name: '青森',   ar: '030' },
  { prefNum:  3, prefCode: '03', name: '岩手',   ar: '030' },
  { prefNum:  4, prefCode: '04', name: '宮城',   ar: '030' },
  { prefNum:  5, prefCode: '05', name: '秋田',   ar: '030' },
  { prefNum:  6, prefCode: '06', name: '山形',   ar: '030' },
  { prefNum:  7, prefCode: '07', name: '福島',   ar: '030' },
  { prefNum:  8, prefCode: '08', name: '茨城',   ar: '030' },
  { prefNum:  9, prefCode: '09', name: '栃木',   ar: '030' },
  { prefNum: 10, prefCode: '10', name: '群馬',   ar: '030' },
  { prefNum: 11, prefCode: '11', name: '埼玉',   ar: '030' },
  { prefNum: 12, prefCode: '12', name: '千葉',   ar: '030' },
  { prefNum: 13, prefCode: '13', name: '東京',   ar: '030' },
  { prefNum: 14, prefCode: '14', name: '神奈川', ar: '030' },
  { prefNum: 15, prefCode: '15', name: '新潟',   ar: '030' },
  { prefNum: 16, prefCode: '16', name: '富山',   ar: '040' },
  { prefNum: 17, prefCode: '17', name: '石川',   ar: '040' },
  { prefNum: 18, prefCode: '18', name: '福井',   ar: '040' },
  { prefNum: 19, prefCode: '19', name: '山梨',   ar: '030' },
  { prefNum: 20, prefCode: '20', name: '長野',   ar: '030' },
  { prefNum: 21, prefCode: '21', name: '岐阜',   ar: '040' },
  { prefNum: 22, prefCode: '22', name: '静岡',   ar: '040' },
  { prefNum: 23, prefCode: '23', name: '愛知',   ar: '040' },
  { prefNum: 24, prefCode: '24', name: '三重',   ar: '040' },
  { prefNum: 25, prefCode: '25', name: '滋賀',   ar: '050' },
  { prefNum: 26, prefCode: '26', name: '京都',   ar: '050' },
  { prefNum: 27, prefCode: '27', name: '大阪',   ar: '050' },
  { prefNum: 28, prefCode: '28', name: '兵庫',   ar: '050' },
  { prefNum: 29, prefCode: '29', name: '奈良',   ar: '050' },
  { prefNum: 30, prefCode: '30', name: '和歌山', ar: '050' },
  { prefNum: 31, prefCode: '31', name: '鳥取',   ar: '060' },
  { prefNum: 32, prefCode: '32', name: '島根',   ar: '060' },
  { prefNum: 33, prefCode: '33', name: '岡山',   ar: '060' },
  { prefNum: 34, prefCode: '34', name: '広島',   ar: '060' },
  { prefNum: 35, prefCode: '35', name: '山口',   ar: '060' },
  { prefNum: 36, prefCode: '36', name: '徳島',   ar: '060' },
  { prefNum: 37, prefCode: '37', name: '香川',   ar: '060' },
  { prefNum: 38, prefCode: '38', name: '愛媛',   ar: '060' },
  { prefNum: 39, prefCode: '39', name: '高知',   ar: '060' },
  { prefNum: 40, prefCode: '40', name: '福岡',   ar: '070' },
  { prefNum: 41, prefCode: '41', name: '佐賀',   ar: '070' },
  { prefNum: 42, prefCode: '42', name: '長崎',   ar: '070' },
  { prefNum: 43, prefCode: '43', name: '熊本',   ar: '070' },
  { prefNum: 44, prefCode: '44', name: '大分',   ar: '070' },
  { prefNum: 45, prefCode: '45', name: '宮崎',   ar: '070' },
  { prefNum: 46, prefCode: '46', name: '鹿児島', ar: '070' },
  { prefNum: 47, prefCode: '47', name: '沖縄',   ar: '070' },
];

function log(msg) { console.log(`[${new Date().toISOString()}] [SUUMO] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Utility: HTML parsing helpers (no DOM, regex-based for Worker compatibility)
// ---------------------------------------------------------------------------

/** テキストノードからHTML tagを除去 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
             .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
             .trim();
}

/** 賃貸: "6.5万円" → 65000 (円整数) */
function parseChintaiPrice(text) {
  if (!text) return null;
  const clean = stripTags(text).replace(/,/g, '').trim();
  const m = clean.match(/([\d.]+)万円/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  const m2 = clean.match(/^([\d,]+)円/);
  if (m2) return parseInt(m2[1].replace(/,/g, ''), 10);
  return null;
}

/** 売買: "3,500万円" → 3500 (万円整数) */
function parseBaibaiPrice(text) {
  if (!text) return null;
  const clean = stripTags(text).replace(/,/g, '').trim();
  const m = clean.match(/([\d.]+)万円/);
  if (m) return Math.round(parseFloat(m[1]));
  return null;
}

/** "30.12m²" → 30.12 */
function parseArea(text) {
  if (!text) return null;
  const m = stripTags(text).match(/([\d.]+)\s*m/i);
  return m ? parseFloat(m[1]) : null;
}

/** "築5年" → 5  /  "新築" → 0  /  "2020年築" → CURRENT_YEAR - 2020 */
function parseAge(text) {
  if (!text) return null;
  const clean = stripTags(text);
  if (/新築/.test(clean)) return 0;
  const m1 = clean.match(/築(\d+)年/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = clean.match(/(\d{4})年築/);
  if (m2) return CURRENT_YEAR - parseInt(m2[1], 10);
  return null;
}

/** "JR山手線 新宿駅 歩10分" → { station: '新宿駅', stationMinutes: 10 } */
function parseStation(text) {
  if (!text) return { station: null, stationMinutes: null };
  const clean = stripTags(text);
  const mSt = clean.match(/([^\s　]+駅)/);
  const mMin = clean.match(/歩(\d+)分/);
  return {
    station: mSt ? mSt[1] : null,
    stationMinutes: mMin ? parseInt(mMin[1], 10) : null,
  };
}

/** "東京都新宿区西新宿..." → city="新宿区" */
function extractCity(addr) {
  return addr?.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
}

/** URL から sitePropertyId を抽出 */
function extractSuumoId(url) {
  // 賃貸: /chintai/jnc_XXXXXXXX/  または  /chintai/bc_XXXXXX/
  // 売買: /ms/chuko/tokyo/.../sc_XXXXX/  または パス末尾
  const patterns = [
    /\/(jnc_[A-Za-z0-9]+)\//,
    /\/(bc_[A-Za-z0-9]+)\//,
    /\/(sc_[A-Za-z0-9]+)\//,
    /\/([A-Za-z]{2}_[A-Za-z0-9]+)\//,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // フォールバック: URLパスをbase64
  const path = url.replace(/https?:\/\/[^/]+/, '').replace(/\/$/, '');
  return Buffer.from(path).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

/** detailUrl を絶対URLに正規化 */
function toAbsUrl(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return 'https://suumo.jp' + (href.startsWith('/') ? href : '/' + href);
}

// ---------------------------------------------------------------------------
// CSV 変換 (homes-local.mjs と同じカラム順)
// ---------------------------------------------------------------------------
function propertiesToCsv(properties) {
  const CSV_COLS = [
    'site_id', 'site_property_id', 'title', 'property_type', 'status',
    'prefecture', 'city', 'address', 'price', 'price_text', 'area', 'rooms', 'age', 'floor',
    'total_floors', 'station', 'station_minutes', 'management_fee',
    'repair_fund', 'direction', 'structure',
    'yield_rate', 'thumbnail_url', 'detail_url', 'description', 'fingerprint',
    'latitude', 'longitude', 'listed_at', 'sold_at',
  ];
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

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------
async function importSingleBatch(properties, batchIdx) {
  const csvText = propertiesToCsv(properties);
  try {
    const form = new FormData();
    form.append('file', new File([csvText], 'suumo.csv', { type: 'text/csv' }));
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
    totalSkipped  += skipped;
    log(`  バッチ ${batchIdx}/${totalBatches}: imported=${imported} skipped=${skipped}`);
    if (i + BATCH_SIZE < properties.length) await sleep(1000);
  }
  return { imported: totalImported, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// WAF 検出・待機 (SUUMO は比較的緩いが念のため)
// ---------------------------------------------------------------------------
async function waitForSuumo(pw_page, label, pageNum) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const html = await pw_page.content();
    // WAF challenge が解決されていない場合は待機
    if (html.includes('awsWafCoo') || html.includes('aws-waf') || html.length < 3000) {
      log(`  ${label} page=${pageNum}: WAF challenge, waiting 3s... (attempt ${attempt + 1}/6)`);
      await pw_page.waitForTimeout(3000);
      continue;
    }
    return html;
  }
  return await pw_page.content();
}

// ---------------------------------------------------------------------------
// 賃貸マンション HTML パース
// ---------------------------------------------------------------------------
/**
 * cassetteitem ブロックをパースして物件配列を返す。
 * 1建物に複数部屋 → 部屋ごとに1レコード。
 */
function parseChintaiHtml(html, prefCode) {
  const props = [];

  // cassetteitem ブロックを抽出
  const cassetteRe = /<div[^>]+class="[^"]*cassetteitem[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*cassetteitem[^"]*"|$)/g;
  let cassetteMatch;
  while ((cassetteMatch = cassetteRe.exec(html)) !== null) {
    const block = cassetteMatch[0];

    // 建物名・建物URL
    const titleM = block.match(/<div[^>]+class="[^"]*cassetteitem_content-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const buildingUrl  = titleM ? toAbsUrl(titleM[1]) : '';
    const buildingName = titleM ? stripTags(titleM[2]) : '';

    // 住所 (cassetteitem_detail-col1)
    const addrM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col1[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const address = addrM ? stripTags(addrM[1]) : '';
    const city = extractCity(address);

    // 最寄り駅 (cassetteitem_detail-col2)
    const stM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col2[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const stationText = stM ? stripTags(stM[1]) : '';
    const { station, stationMinutes } = parseStation(stationText);

    // 築年数 (cassetteitem_detail-col3)
    const ageM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col3[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const ageText = ageM ? stripTags(ageM[1]) : '';
    const age = parseAge(ageText);

    // 各部屋行 (js-cassette_link)
    const rowRe = /<tr[^>]+class="[^"]*js-cassette_link[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(block)) !== null) {
      const row = rowMatch[1];

      // 家賃
      const priceM = row.match(/<td[^>]+class="[^"]*cassetteitem_price--emphasis[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      // 代替: cassetteitem_price
      const priceM2 = !priceM ? row.match(/<td[^>]+class="[^"]*cassetteitem_price[^"]*"[^>]*>([\s\S]*?)<\/td>/) : null;
      const priceRaw = priceM ? stripTags(priceM[1]) : (priceM2 ? stripTags(priceM2[1]) : '');
      const price = parseChintaiPrice(priceRaw);
      const priceText = priceRaw || '価格要相談';

      // 専有面積
      const areaM = row.match(/<td[^>]+class="[^"]*cassetteitem_menseki[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const area = areaM ? parseArea(stripTags(areaM[1])) : null;

      // 間取り
      const roomsM = row.match(/<td[^>]+class="[^"]*cassetteitem_madori[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const rooms = roomsM ? stripTags(roomsM[1]) : null;

      // 管理費
      const mgmtM = row.match(/<td[^>]+class="[^"]*cassetteitem_other--managefee[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const managementFeeRaw = mgmtM ? stripTags(mgmtM[1]) : '';
      const managementFee = parseChintaiPrice(managementFeeRaw);

      // 階数
      const floorM = row.match(/<td[^>]+class="[^"]*cassetteitem_floor[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const floorText = floorM ? stripTags(floorM[1]) : '';
      const floorNum = floorText ? parseInt(floorText.replace(/[^0-9]/g, ''), 10) || null : null;

      // 部屋詳細URL
      const detailM = row.match(/<a[^>]+href="(\/chintai\/[^"]+)"[^>]*>/);
      // 代替セレクタ
      const detailM2 = !detailM ? row.match(/<a[^>]+href="([^"]+)"[^>]*>詳細/) : null;
      const detailHref = detailM ? detailM[1] : (detailM2 ? detailM2[1] : buildingUrl);
      const detailUrl = toAbsUrl(detailHref);
      const sitePropertyId = extractSuumoId(detailUrl) || extractSuumoId(buildingUrl) + '_' + (props.length);

      if (!buildingName && !detailUrl) continue;

      props.push({
        siteId: 'suumo_chintai',
        sitePropertyId,
        title: buildingName || '物件名不明',
        propertyType: 'chintai_mansion',
        status: 'active',
        prefecture: prefCode,
        city,
        address: address || null,
        price,
        priceText,
        area,
        rooms,
        age,
        floor: floorNum,
        totalFloors: null,
        station,
        stationMinutes,
        managementFee,
        repairFund: null,
        direction: null,
        structure: null,
        thumbnailUrl: null,
        detailUrl,
        description: null,
        yieldRate: null,
        fingerprint: null,
        latitude: null,
        longitude: null,
        listedAt: null,
        soldAt: null,
      });
    }
  }

  return props;
}

// ---------------------------------------------------------------------------
// 売買マンション HTML パース
// ---------------------------------------------------------------------------
/**
 * property_unit ブロックをパース。
 * 代替として ul.property_unit-list > li, div.cassette 等にもフォールバック。
 */
function parseBaibaiHtml(html, prefCode) {
  const props = [];

  // ---- 方法1: property_unit ブロック ----
  const unitRe = /<div[^>]+class="[^"]*property_unit[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*property_unit[^"]*"|<\/section>|$)/g;
  let unitMatch;
  let parsed = 0;
  while ((unitMatch = unitRe.exec(html)) !== null) {
    const block = unitMatch[0];

    // タイトル・URL
    const titleM = block.match(/<div[^>]+class="[^"]*property_unit-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    // 代替
    const titleM2 = !titleM ? block.match(/<a[^>]+class="[^"]*property_unit-name[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) : null;
    const href  = titleM ? titleM[1] : (titleM2 ? titleM2[1] : '');
    const title = titleM ? stripTags(titleM[2]) : (titleM2 ? stripTags(titleM2[2]) : '');

    const detailUrl = toAbsUrl(href);
    if (!detailUrl) continue;
    const sitePropertyId = extractSuumoId(detailUrl);

    // 面積・間取り (property_unit-info)
    const infoM = block.match(/<div[^>]+class="[^"]*property_unit-info[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const infoText = infoM ? stripTags(infoM[1]) : '';
    const area = parseArea(infoText);
    const roomsM = infoText.match(/([0-9SLDK]+LDK|[0-9SLDK]+K|ワンルーム|スタジオ)/i);
    const rooms = roomsM ? roomsM[1] : null;

    // 価格 (property_unit-price)
    const priceM = block.match(/<div[^>]+class="[^"]*property_unit-price[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const priceRaw = priceM ? stripTags(priceM[1]) : '';
    const price = parseBaibaiPrice(priceRaw);
    const priceText = priceRaw || '価格要相談';

    // 住所 (property_unit-detail-col)
    const addrM = block.match(/<div[^>]+class="[^"]*property_unit-detail-col[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const address = addrM ? stripTags(addrM[1]) : '';
    const city = extractCity(address);

    // 駅情報
    const stationM = block.match(/<div[^>]+class="[^"]*property_unit-station[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const { station, stationMinutes } = stationM ? parseStation(stripTags(stationM[1])) : { station: null, stationMinutes: null };

    // 築年数
    const ageM = block.match(/<div[^>]+class="[^"]*property_unit-age[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const age = ageM ? parseAge(stripTags(ageM[1])) : null;

    // サムネイル
    const imgM = block.match(/<img[^>]+src="([^"]+)"[^>]*>/);
    const thumbnailUrl = imgM ? imgM[1] : null;

    props.push({
      siteId: 'suumo_baibai',
      sitePropertyId,
      title: title || '物件名不明',
      propertyType: 'mansion',
      status: 'active',
      prefecture: prefCode,
      city,
      address: address || null,
      price,
      priceText,
      area,
      rooms,
      age,
      floor: null,
      totalFloors: null,
      station,
      stationMinutes,
      managementFee: null,
      repairFund: null,
      direction: null,
      structure: null,
      thumbnailUrl,
      detailUrl,
      description: null,
      yieldRate: null,
      fingerprint: null,
      latitude: null,
      longitude: null,
      listedAt: null,
      soldAt: null,
    });
    parsed++;
  }

  // ---- 方法2: 構造が変わっていた場合のフォールバック (cassetteitem流用) ----
  if (parsed === 0) {
    const cassetteRe2 = /<div[^>]+class="[^"]*cassetteitem[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*cassetteitem[^"]*"|$)/g;
    let cm;
    while ((cm = cassetteRe2.exec(html)) !== null) {
      const block = cm[0];
      const titleM = block.match(/<div[^>]+class="[^"]*cassetteitem_content-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleM) continue;
      const detailUrl = toAbsUrl(titleM[1]);
      const title = stripTags(titleM[2]);
      const sitePropertyId = extractSuumoId(detailUrl);

      const addrM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col1[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const address = addrM ? stripTags(addrM[1]) : '';
      const city = extractCity(address);

      const priceM = block.match(/<td[^>]+class="[^"]*cassetteitem_price--emphasis[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const priceRaw = priceM ? stripTags(priceM[1]) : '';
      const price = parseBaibaiPrice(priceRaw);
      const priceText = priceRaw || '価格要相談';

      const stM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col2[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const { station, stationMinutes } = stM ? parseStation(stripTags(stM[1])) : { station: null, stationMinutes: null };

      const ageM = block.match(/<td[^>]+class="[^"]*cassetteitem_detail-col3[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      const age = ageM ? parseAge(stripTags(ageM[1])) : null;

      props.push({
        siteId: 'suumo_baibai',
        sitePropertyId,
        title: title || '物件名不明',
        propertyType: 'mansion',
        status: 'active',
        prefecture: prefCode,
        city,
        address: address || null,
        price,
        priceText,
        area: null,
        rooms: null,
        age,
        floor: null,
        totalFloors: null,
        station,
        stationMinutes,
        managementFee: null,
        repairFund: null,
        direction: null,
        structure: null,
        thumbnailUrl: null,
        detailUrl,
        description: null,
        yieldRate: null,
        fingerprint: null,
        latitude: null,
        longitude: null,
        listedAt: null,
        soldAt: null,
      });
    }
  }

  return props;
}

// ---------------------------------------------------------------------------
// ページ終端判定
// ---------------------------------------------------------------------------
function isLastPage(props, prevCount) {
  if (props.length === 0) return true;
  if (props.length < 3) return true;
  // 前ページと同一件数かつ少ない場合は最終ページと判定
  if (prevCount !== null && props.length < prevCount * 0.5) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 都道府県単位スクレイピング (賃貸)
// ---------------------------------------------------------------------------
async function scrapeChintaiPref(browser, { prefCode, prefNum, name, ar }) {
  const props = [];
  const seen = new Set();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: { 'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8' },
  });
  const pw_page = await context.newPage();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=${ar}&bs=040&ta=${prefNum}&pn=${page}`;
      log(`${name} (${prefNum}) chintai page=${page}: ${url}`);

      try {
        await pw_page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pw_page.waitForTimeout(2000);

        const html = await waitForSuumo(pw_page, `${name} chintai`, page);
        const pageProps = parseChintaiHtml(html, prefCode);

        let added = 0;
        for (const p of pageProps) {
          if (seen.has(p.sitePropertyId)) continue;
          seen.add(p.sitePropertyId);
          props.push(p);
          added++;
        }

        const cumulative = props.length;
        log(`[SUUMO] ${name} (${prefNum}) chintai page=${page}: ${added}件取得 (累計: ${cumulative}件)`);

        if (isLastPage(pageProps, page > 1 ? pageProps.length : null)) {
          log(`  ${name} chintai page=${page}: 最終ページ判定, 終了`);
          break;
        }
        if (page < MAX_PAGES) await sleep(2000);
      } catch (e) {
        log(`  WARNING: ${name} chintai page=${page} error: ${e.message}`);
        break;
      }
    }
  } finally {
    await pw_page.close();
    await context.close();
  }

  return props;
}

// ---------------------------------------------------------------------------
// 都道府県単位スクレイピング (売買)
// ---------------------------------------------------------------------------
async function scrapeBaibaiPref(browser, { prefCode, prefNum, name, ar }) {
  const props = [];
  const seen = new Set();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    extraHTTPHeaders: { 'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8' },
  });
  const pw_page = await context.newPage();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://suumo.jp/jj/bukken/ichiran/JJ010FC001/?ar=${ar}&bs=021&ta=${prefNum}&pn=${page}`;
      log(`${name} (${prefNum}) baibai page=${page}: ${url}`);

      try {
        await pw_page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pw_page.waitForTimeout(2000);

        const html = await waitForSuumo(pw_page, `${name} baibai`, page);
        const pageProps = parseBaibaiHtml(html, prefCode);

        let added = 0;
        for (const p of pageProps) {
          if (seen.has(p.sitePropertyId)) continue;
          seen.add(p.sitePropertyId);
          props.push(p);
          added++;
        }

        const cumulative = props.length;
        log(`[SUUMO] ${name} (${prefNum}) baibai page=${page}: ${added}件取得 (累計: ${cumulative}件)`);

        if (isLastPage(pageProps, page > 1 ? pageProps.length : null)) {
          log(`  ${name} baibai page=${page}: 最終ページ判定, 終了`);
          break;
        }
        if (page < MAX_PAGES) await sleep(2000);
      } catch (e) {
        log(`  WARNING: ${name} baibai page=${page} error: ${e.message}`);
        break;
      }
    }
  } finally {
    await pw_page.close();
    await context.close();
  }

  return props;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  // 引数バリデーション
  if (!['chintai', 'baibai', 'all'].includes(MODE_ARG)) {
    log(`ERROR: --mode は chintai / baibai / all のいずれかを指定してください (received: ${MODE_ARG})`);
    process.exit(1);
  }

  // 対象都道府県フィルタ
  let targets = PREF_ARG
    ? ALL_PREFS.filter(p => String(p.prefNum) === PREF_ARG || p.prefCode === PREF_ARG.padStart(2, '0'))
    : ALL_PREFS;

  if (targets.length === 0) {
    log(`ERROR: --pref=${PREF_ARG} に対応する都道府県が見つかりません`);
    process.exit(1);
  }

  const modes = MODE_ARG === 'all' ? ['chintai', 'baibai'] : [MODE_ARG];
  log(`SUUMO ローカルスクレイパー開始 (Playwright版)`);
  log(`  mode=${MODE_ARG}, max-pages=${MAX_PAGES}, dry-run=${DRY_RUN}`);
  log(`  対象: ${targets.length}都道府県 × ${modes.join('+')}モード`);

  const { chromium } = require('playwright');

  log('Chrome ブラウザを起動中...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const allProps = [];
  const seen = new Set();

  let totalImported = 0;
  let totalSkipped  = 0;

  try {
    for (const mode of modes) {
      log(`\n--- モード: ${mode} ---`);
      for (const pref of targets) {
        try {
          const props = mode === 'chintai'
            ? await scrapeChintaiPref(browser, pref)
            : await scrapeBaibaiPref(browser, pref);

          for (const p of props) {
            // siteId+sitePropertyId でグローバル重複排除
            const key = `${p.siteId}::${p.sitePropertyId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            allProps.push(p);
          }
          log(`  ${pref.name} ${mode}: ${props.length}件 (累計 ${allProps.length}件)`);

          // バッチ単位でインポート (メモリを節約)
          if (allProps.length >= 500) {
            const batch = allProps.splice(0, allProps.length);
            log(`  ${batch.length}件 → インポート中...`);
            const res = await importToWorker(batch);
            totalImported += res.imported;
            totalSkipped  += res.skipped;
          }
        } catch (e) {
          log(`ERROR: ${pref.name} ${mode}: ${e.message}`);
        }
        await sleep(3000);
      }
    }
  } finally {
    await browser.close();
  }

  // 残り分をインポート
  if (allProps.length > 0) {
    log(`残り ${allProps.length}件 → インポート中...`);
    const res = await importToWorker(allProps);
    totalImported += res.imported;
    totalSkipped  += res.skipped;
  }

  const total = totalImported + totalSkipped;
  log(`\n[SUUMO] インポート完了: imported=${totalImported}, skipped=${totalSkipped}, total=${total}件`);
}

main().catch(e => { console.error(e); process.exit(1); });
