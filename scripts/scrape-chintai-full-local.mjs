#!/usr/bin/env node
/**
 * CHINTAI 全47都道府県 × 全ページ → MAL D1 インポート
 * JSON-LD優先、フォールバックで正規表現解析
 *
 * Usage: node scripts/scrape-chintai-full-local.mjs [--dry-run] [--pref=13] [--max-pages=15]
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
const MAX_PAGES_ARG = parseInt(process.argv.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '15');
const MAX_PAGES = isNaN(MAX_PAGES_ARG) ? 15 : MAX_PAGES_ARG;

const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// CHINTAI 都道府県コード → URLスラッグ (chintai.ts の CHINTAI_PREF_SLUG から)
const CHINTAI_SLUGS = {
  '01': 'hokkaido',   '02': 'aomori',    '03': 'iwate',    '04': 'miyagi',
  '05': 'akita',      '06': 'yamagata',  '07': 'fukushima','08': 'ibaraki',
  '09': 'tochigi',    '10': 'gunma',     '11': 'saitama',  '12': 'chiba',
  '13': 'tokyo',      '14': 'kanagawa',  '15': 'niigata',  '16': 'toyama',
  '17': 'ishikawa',   '18': 'fukui',     '19': 'yamanashi','20': 'nagano',
  '21': 'gifu',       '22': 'shizuoka',  '23': 'aichi',    '24': 'mie',
  '25': 'shiga',      '26': 'kyoto',     '27': 'osaka',    '28': 'hyogo',
  '29': 'nara',       '30': 'wakayama',  '31': 'tottori',  '32': 'shimane',
  '33': 'okayama',    '34': 'hiroshima', '35': 'yamaguchi','36': 'tokushima',
  '37': 'kagawa',     '38': 'ehime',     '39': 'kochi',    '40': 'fukuoka',
  '41': 'saga',       '42': 'nagasaki',  '43': 'kumamoto', '44': 'oita',
  '45': 'miyazaki',   '46': 'kagoshima', '47': 'okinawa',
};

const PREF_NAMES = {
  '01': '北海道', '02': '青森', '03': '岩手', '04': '宮城', '05': '秋田',
  '06': '山形', '07': '福島', '08': '茨城', '09': '栃木', '10': '群馬',
  '11': '埼玉', '12': '千葉', '13': '東京', '14': '神奈川', '15': '新潟',
  '16': '富山', '17': '石川', '18': '福井', '19': '山梨', '20': '長野',
  '21': '岐阜', '22': '静岡', '23': '愛知', '24': '三重', '25': '滋賀',
  '26': '京都', '27': '大阪', '28': '兵庫', '29': '奈良', '30': '和歌山',
  '31': '鳥取', '32': '島根', '33': '岡山', '34': '広島', '35': '山口',
  '36': '徳島', '37': '香川', '38': '愛媛', '39': '高知', '40': '福岡',
  '41': '佐賀', '42': '長崎', '43': '熊本', '44': '大分', '45': '宮崎',
  '46': '鹿児島', '47': '沖縄',
};

function log(msg) { console.log(`[${new Date().toISOString()}] [chintai-full] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCityFromAddress(addr) {
  return addr?.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
}

function convertRentToManYen(rawPrice) {
  // 家賃: "6.5万円" → 65000円ではなく 6.5万円として price=6(切り捨て) で保存
  // 指示: 万円単位に変換 (6.5万円 → price=6)
  // ただし単純整数で保存するため Math.round
  if (!rawPrice) return { price: null, priceText: '要問合せ' };
  const cleaned = rawPrice.replace(/[,\s]/g, '');
  // JPYで格納されている場合 (10000以上): 万円に変換
  const jpy = cleaned.match(/^(\d+(?:\.\d+)?)$/);
  if (jpy) {
    const v = parseFloat(jpy[1]);
    if (v >= 10000) return { price: Math.round(v / 10000), priceText: `家賃${Math.round(v / 10000)}万円/月` };
    return { price: Math.round(v), priceText: `家賃${v}万円/月` };
  }
  // "X.X万円" パターン
  const manM = cleaned.match(/(\d+(?:\.\d+)?)万円/);
  if (manM) {
    const v = parseFloat(manM[1]);
    return { price: Math.round(v), priceText: `家賃${v}万円/月` };
  }
  return { price: null, priceText: rawPrice };
}

function idFromUrl(url) {
  // CHINTAI: /bk-ALPHANUM/
  const bk = url.match(/\/bk-([A-Za-z0-9]+)\//);
  if (bk) return bk[1].slice(-24);
  const m = url.match(/\/(\d{6,})\//);
  if (m) return m[1];
  return Buffer.from(url.replace(/https?:\/\/[^/]+/, '')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
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

function parseFromJsonLd(html, prefCode) {
  const properties = [];
  const seen = new Set();

  const jldRe = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g;
  for (const m of html.matchAll(jldRe)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }

    // ItemList
    if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
      for (const elem of data.itemListElement) {
        const item = elem.item ?? elem;
        if (!item) continue;
        const prop = jsonLdItemToProperty(item, prefCode, seen);
        if (prop) properties.push(prop);
      }
      continue;
    }

    // 単体物件
    const types = ['RealEstateListing', 'Apartment', 'Product', 'House'];
    if (types.includes(data['@type'])) {
      const prop = jsonLdItemToProperty(data, prefCode, seen);
      if (prop) properties.push(prop);
    }
  }

  return properties;
}

function jsonLdItemToProperty(item, prefCode, seen) {
  const url = String(item.url ?? '');
  if (!url) return null;
  const title = String(item.name ?? '').trim();
  if (!title) return null;

  const sitePropertyId = idFromUrl(url);
  if (seen.has(sitePropertyId)) return null;
  seen.add(sitePropertyId);

  // 家賃
  const offer = item.offers ?? {};
  let price = null;
  let priceText = '要問合せ';
  if (offer.price !== undefined) {
    const rawP = parseFloat(String(offer.price));
    if (!isNaN(rawP)) {
      const result = convertRentToManYen(String(rawP));
      price = result.price;
      priceText = result.priceText;
    }
  }

  // 面積
  const fs = item.floorSize;
  const area = fs && fs.value ? parseFloat(String(fs.value)) || null : null;

  // 住所
  const addr = item.address;
  let address = null;
  let city = '';
  if (typeof addr === 'string') {
    address = addr;
    city = extractCityFromAddress(addr);
  } else if (addr && typeof addr === 'object') {
    const locality = String(addr.addressLocality ?? '');
    const street = String(addr.streetAddress ?? '');
    address = [locality, street].filter(Boolean).join(' ') || null;
    city = locality || extractCityFromAddress(address ?? '');
  }

  // 座標
  const geo = item.geo ?? {};
  const latitude = typeof geo.latitude === 'number' ? geo.latitude : null;
  const longitude = typeof geo.longitude === 'number' ? geo.longitude : null;

  // 画像
  const img = item.image;
  const thumbnailUrl = typeof img === 'string' ? img
    : Array.isArray(img) && img.length > 0 ? String(img[0]) : null;

  return {
    id: `chintai_${sitePropertyId}`,
    siteId: 'chintai',
    sitePropertyId,
    title,
    propertyType: 'chintai_mansion',
    status: 'active',
    prefecture: prefCode,
    city,
    address,
    price,
    priceText,
    area,
    buildingArea: null,
    landArea: null,
    rooms: null,
    age: null,
    floor: null,
    totalFloors: null,
    station: null,
    stationMinutes: null,
    thumbnailUrl,
    detailUrl: url,
    description: typeof item.description === 'string' ? item.description.slice(0, 500) : null,
    yieldRate: null,
    latitude,
    longitude,
    fingerprint: null,
    listedAt: null,
  };
}

function parseFromRegex(html, prefCode) {
  const properties = [];
  const seen = new Set();

  // カード単位でブロック抽出: cassette_item または l_cassette
  // data-detailurl を持つ要素から詳細URLを取得
  const detailUrlRe = /data-detailurl="([^"]+)"/g;
  for (const m of html.matchAll(detailUrlRe)) {
    const detailPath = m[1];
    if (!detailPath.includes('/detail/') && !detailPath.includes('/bk-')) continue;
    const detailUrl = detailPath.startsWith('http') ? detailPath : `https://www.chintai.net${detailPath}`;
    const sitePropertyId = idFromUrl(detailUrl);
    if (seen.has(sitePropertyId)) continue;
    seen.add(sitePropertyId);

    // 前後のコンテキストでタイトルと家賃を探す
    const pos = html.indexOf(m[0]);
    const context = html.slice(Math.max(0, pos - 500), pos + 3000);

    // タイトル: <h2 ...>...</h2>
    const titleM = context.match(/<h2[^>]*>([\s\S]{1,200}?)<\/h2>/);
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;

    // 家賃: X.X万円 パターン
    const rentM = context.match(/([0-9]+(?:\.[0-9]+)?)\s*万円/);
    const { price, priceText } = rentM ? convertRentToManYen(`${rentM[1]}万円`) : { price: null, priceText: '要問合せ' };

    // 住所
    const addrM = context.match(/<p[^>]*class="[^"]*address[^"]*"[^>]*>([\s\S]{1,200}?)<\/p>/);
    const address = addrM ? addrM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
    const city = extractCityFromAddress(address ?? context);

    // 面積
    const areaM = context.match(/([0-9]+(?:\.[0-9]+)?)\s*[㎡m²]/);
    const area = areaM ? parseFloat(areaM[1]) : null;

    // 間取り
    const roomsM = context.match(/([1-9][LDKS][DKSR]*)/);
    const rooms = roomsM ? roomsM[1] : null;

    // 路線
    const stM = context.match(/(\S+駅?)\s*(?:徒歩)?(\d+)分/);
    const station = stM ? stM[1].replace(/駅$/, '') : null;
    const stationMinutes = stM ? parseInt(stM[2]) : null;

    // 画像
    const imgM = context.match(/<img[^>]*(?:data-original|data-src|src)="([^"]+)"[^>]*>/);
    let thumbnailUrl = null;
    if (imgM) {
      const src = imgM[1];
      thumbnailUrl = src.startsWith('//') ? 'https:' + src : src;
      if (!thumbnailUrl.startsWith('http')) thumbnailUrl = null;
    }

    properties.push({
      id: `chintai_${sitePropertyId}`,
      siteId: 'chintai',
      sitePropertyId,
      title,
      propertyType: 'chintai_mansion',
      status: 'active',
      prefecture: prefCode,
      city,
      address,
      price,
      priceText,
      area,
      buildingArea: null,
      landArea: null,
      rooms,
      age: null,
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

  // data-detailurl がない場合のフォールバック: href="/detail/bk-..." から取得
  if (properties.length === 0) {
    const hrefRe = /href="(https?:\/\/www\.chintai\.net\/[^"]*\/bk-[^"]+)"[^>]*>/g;
    for (const m of html.matchAll(hrefRe)) {
      const detailUrl = m[1];
      const sitePropertyId = idFromUrl(detailUrl);
      if (seen.has(sitePropertyId)) continue;
      seen.add(sitePropertyId);

      const pos = html.indexOf(m[0]);
      const context = html.slice(Math.max(0, pos - 1000), pos + 3000);

      const titleM = context.match(/<h2[^>]*>([\s\S]{1,200}?)<\/h2>/);
      const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
      if (!title) continue;

      const rentM = context.match(/([0-9]+(?:\.[0-9]+)?)\s*万円/);
      const { price, priceText } = rentM ? convertRentToManYen(`${rentM[1]}万円`) : { price: null, priceText: '要問合せ' };

      const addrM = context.match(/<p[^>]*class="[^"]*address[^"]*"[^>]*>([\s\S]{1,200}?)<\/p>/);
      const address = addrM ? addrM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
      const city = extractCityFromAddress(address ?? context);

      const areaM = context.match(/([0-9]+(?:\.[0-9]+)?)\s*[㎡m²]/);
      const area = areaM ? parseFloat(areaM[1]) : null;

      properties.push({
        id: `chintai_${sitePropertyId}`,
        siteId: 'chintai',
        sitePropertyId,
        title,
        propertyType: 'chintai_mansion',
        status: 'active',
        prefecture: prefCode,
        city,
        address,
        price,
        priceText,
        area,
        buildingArea: null,
        landArea: null,
        rooms: null,
        age: null,
        floor: null,
        totalFloors: null,
        station: null,
        stationMinutes: null,
        thumbnailUrl: null,
        detailUrl,
        description: null,
        yieldRate: null,
        latitude: null,
        longitude: null,
        fingerprint: null,
        listedAt: null,
      });
    }
  }

  return properties;
}

function parseChintaiPageNew(html, prefCode) {
  // 実際のHTML構造: <section class="... cassette_item ..."> ブロックごとに1物件
  // data-detailurl="/detail/bk-XXXX/?..." が詳細URLを持つ
  // テキストに「物件名 / 家賃XX万円 / 路線 駅名 徒歩N分 / 住所 / 間取り 面積m² N階/N階建 築N年」を含む
  const properties = [];
  const seen = new Set();

  let pos = 0;
  while (true) {
    const startIdx = html.indexOf('<section', pos);
    if (startIdx < 0) break;
    const endIdx = html.indexOf('</section>', startIdx);
    if (endIdx < 0) break;
    const section = html.slice(startIdx, endIdx + 10);
    pos = endIdx + 10;

    if (!section.includes('cassette_item')) continue;

    // 詳細URL: data-detailurl="/detail/bk-XXX/..."
    const duM = section.match(/data-detailurl="(\/detail\/bk-[^"?]+)/);
    if (!duM) continue;
    const detailUrl = `https://www.chintai.net${duM[1]}`;
    const sitePropertyId = idFromUrl(detailUrl);
    if (seen.has(sitePropertyId)) continue;
    seen.add(sitePropertyId);

    // テキスト全体でパース
    const text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // タイトル: data-detailurl直後の <a>タグのテキスト (ga_bukken_cassette)
    const titleLinkM = section.match(/class="[^"]*ga_bukken_cassette[^"]*"[^>]*>([^<]+)</);
    const title = titleLinkM ? titleLinkM[1].trim() : '';
    if (!title || title.length < 2) continue;

    // 家賃: "13 万円" or "6.5万円"
    const rentM = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万円/);
    const { price, priceText } = rentM ? convertRentToManYen(`${rentM[1]}万円`) : { price: null, priceText: '要問合せ' };

    // 最寄り駅: "日比谷線/秋葉原駅 徒歩5分" or "秋葉原駅 徒歩5分"
    const stM = text.match(/([^\s]+?駅)\s*(?:&nbsp;|　|\s)*(?:徒歩)?(\d+)分/);
    const station = stM ? stM[1] : null;
    const stationMinutes = stM ? parseInt(stM[2]) : null;

    // 住所: 都道府県名 + 区市町村
    const addrM = text.match(/(東京都|大阪府|京都府|北海道|[^\s]+?[県])[^\s]{0,20}?([市区町村][^\s　]{0,20})/);
    const address = addrM ? addrM[0].trim() : null;
    const city = extractCityFromAddress(address ?? text);

    // 面積: "28.44m²" or "30.12㎡"
    const areaM = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:m²|m2|㎡)/);
    const area = areaM ? parseFloat(areaM[1]) : null;

    // 間取り
    const roomsM = text.match(/\b([1-9][LDKS][DKSR]*)\b/);
    const rooms = roomsM ? roomsM[1] : null;

    // 階数: "9階/9階建" → floor=9, totalFloors=9
    const floorM = text.match(/(\d+)階\s*\/\s*(\d+)階建/);
    const floor = floorM ? parseInt(floorM[1]) : null;
    const totalFloors = floorM ? parseInt(floorM[2]) : null;

    // 築年数: "築25年" or 「築N年」
    const ageM = text.match(/築(\d+)年/);
    const age = ageM ? parseInt(ageM[1]) : null;

    // 画像
    const imgM = section.match(/<img[^>]+(?:data-original|src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*>/i);
    const thumbnailUrl = imgM ? imgM[1] : null;

    properties.push({
      id: `chintai_${sitePropertyId}`,
      siteId: 'chintai',
      sitePropertyId,
      title,
      propertyType: 'chintai_mansion',
      status: 'active',
      prefecture: prefCode,
      city,
      address,
      price,
      priceText,
      area,
      buildingArea: null,
      landArea: null,
      rooms,
      age,
      floor,
      totalFloors,
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

function parseChintaiPage(html, prefCode) {
  // セクションベースのパーサー (cassette_item 構造)
  const results = parseChintaiPageNew(html, prefCode);
  if (results.length > 0) return results;

  // フォールバック: JSON-LD
  const jldProps = parseFromJsonLd(html, prefCode);
  if (jldProps.length > 0) return jldProps;

  // 最終フォールバック: 正規表現
  return parseFromRegex(html, prefCode);
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
  const slug = CHINTAI_SLUGS[prefCode];
  if (!slug) return [];
  const name = PREF_NAMES[prefCode] ?? prefCode;
  // areaCode = prefCode + '101' (例: '13' → '13101')
  const areaCode = `${prefCode}101`;
  const props = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? `https://www.chintai.net/${slug}/area/${areaCode}/list/`
      : `https://www.chintai.net/${slug}/area/${areaCode}/list/?page=${page}`;

    try {
      const html = await fetchWithRetry(url);
      const batch = parseChintaiPage(html, prefCode);

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
    : Object.keys(CHINTAI_SLUGS);

  const invalidCodes = prefCodes.filter(c => !CHINTAI_SLUGS[c]);
  if (invalidCodes.length > 0) {
    log(`ERROR: 無効な都道府県コード: ${invalidCodes.join(', ')}`);
    process.exit(1);
  }

  log(`CHINTAI 全件スクレイパー開始 (${prefCodes.length}都道府県, 最大${MAX_PAGES}ページ/県)`);

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
      const name = PREF_NAMES[prefCode] ?? prefCode;
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
      log(`ERROR: ${PREF_NAMES[prefCode] ?? prefCode}: ${e.message}`);
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
