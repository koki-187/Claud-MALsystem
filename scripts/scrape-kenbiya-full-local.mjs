#!/usr/bin/env node
/**
 * 健美家 全47都道府県 × 全ページ → MAL D1 インポート
 * UA偽装でfetchが使えるため Playwright 不要
 *
 * Usage: node scripts/scrape-kenbiya-full-local.mjs [--dry-run] [--pref=13] [--max-pages=20]
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

// 健美家 都道府県コード → URL スラッグ (kenbiya.ts の KENBIYA_PREF_SLUGS から)
const KENBIYA_SLUGS = {
  '01': 'h/hokkaido',
  '02': 'm/aomori',
  '03': 'm/iwate',
  '04': 'm/miyagi',
  '05': 'm/akita',
  '06': 'm/yamagata',
  '07': 'm/fukushima',
  '08': 's/ibaraki',
  '09': 's/tochigi',
  '10': 's/gunma',
  '11': 's/saitama',
  '12': 's/chiba',
  '13': 's/tokyo',
  '14': 's/kanagawa',
  '15': 'z/niigata',
  '16': 'z/toyama',
  '17': 'z/ishikawa',
  '18': 'z/fukui',
  '19': 's/yamanashi',
  '20': 'z/nagano',
  '21': 't/gifu',
  '22': 't/shizuoka',
  '23': 't/aichi',
  '24': 't/mie',
  '25': 'k/shiga',
  '26': 'k/kyoto',
  '27': 'k/osaka',
  '28': 'k/hyogo',
  '29': 'k/nara',
  '30': 'k/wakayama',
  '31': 'o/tottori',
  '32': 'o/shimane',
  '33': 'o/okayama',
  '34': 'o/hiroshima',
  '35': 'o/yamaguchi',
  '36': 'o/tokushima',
  '37': 'o/kagawa',
  '38': 'o/ehime',
  '39': 'o/kochi',
  '40': 'f/fukuoka',
  '41': 'f/saga',
  '42': 'f/nagasaki',
  '43': 'f/kumamoto',
  '44': 'f/oita',
  '45': 'f/miyazaki',
  '46': 'f/kagoshima',
  '47': 'f/okinawa',
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

function log(msg) { console.log(`[${new Date().toISOString()}] [kenbiya-full] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCityFromAddress(addr) {
  return addr?.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
}

function extractPrice(text) {
  const cleaned = (text ?? '').replace(/[,\s]/g, '');
  const oku = cleaned.match(/(\d+(?:\.\d+)?)億(?:(\d+)万)?円/);
  if (oku) {
    const price = Math.round(parseFloat(oku[1]) * 10000) + (oku[2] ? parseInt(oku[2]) : 0);
    return { price, priceText: text.trim() };
  }
  const man = cleaned.match(/(\d+(?:\.\d+)?)万円/);
  if (man) return { price: Math.round(parseFloat(man[1])), priceText: text.trim() };
  return { price: null, priceText: '価格要相談' };
}

function extractYieldRate(text) {
  const m = (text ?? '').match(/([0-9]+(?:\.[0-9]+)?)\s*[%％]/);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 50) return v; }
  return null;
}

function idFromUrl(url) {
  // /re_ALPHANUM/ → stable ID
  const alphaNum = url.match(/\/re_([a-z0-9]+)\//i);
  if (alphaNum) return alphaNum[1];
  const num = url.match(/\/(\d{6,})\//);
  if (num) return num[1];
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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&sup2;/g, '²').replace(/&[a-z]+;/g, '').replace(/\s+/g, ' ').trim();
}

function parseKenbiyaPage(html, prefCode) {
  const properties = [];

  // 実際のHTML構造:
  // <a href="/pp1/..." or "/pp2/..."> <ul class="prop_block">
  //   <li class="main"><ul><li><h3>TITLE</h3></li><li>ADDRESS</li><li>STATION</li></ul></li>
  //   <li class="price"><ul><li><span>8,280</span>万円</li><li><span>7<span>.25</span></span>％</li></ul></li>
  //   <li><ul><li>建:284.28m²</li></ul></li>
  //   <li><ul><li>1970年4月</li><li>3階建/10戸</li></ul></li>
  // </ul></a>

  // <a href="/pp[12]/..."> ブロックを全部抽出
  const anchorRe = /<a\s[^>]*href="(\/pp[12]\/[^"]+)"[^>]*>([\s\S]{100,3000}?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const block = m[2];
    if (!block.includes('prop_block')) continue;

    const detailUrl = `https://www.kenbiya.com${href.replace(/\/$/, '').split('?')[0]}/`;
    const sitePropertyId = idFromUrl(detailUrl);

    // タイトル: <li class="main"> 内の <h3>
    const mainM = block.match(/<li[^>]*class="main"[^>]*>([\s\S]+?)<\/li>/);
    const mainHtml = mainM ? mainM[1] : block;
    const titleM = mainHtml.match(/<h3[^>]*>([\s\S]+?)<\/h3>/);
    const title = titleM ? stripTags(titleM[1]) : null;
    if (!title || title.length < 3) continue;

    // 住所・最寄り駅: main内の2番目・3番目の<li>
    const mainLis = [...mainHtml.matchAll(/<li[^>]*>([\s\S]+?)<\/li>/g)].map(l => stripTags(l[1]));
    const address = mainLis[1] ?? null;  // 2番目li=住所
    const stationText = mainLis[2] ?? '';  // 3番目li=駅
    const city = extractCityFromAddress(address ?? '');

    // 最寄り駅・徒歩分数: "JR総武線 小岩駅 歩15分"
    const stationM = stationText.match(/(.+?駅)\s+歩(\d+)分/);
    const station = stationM ? stationM[1].trim() : (stationText.slice(0, 30) || null);
    const stationMinutes = stationM ? parseInt(stationM[2]) : null;

    // 価格: <li class="price"> 内の最初の<li>テキスト "8,280万円"
    const priceBlockM = block.match(/<li[^>]*class="price"[^>]*>([\s\S]+?)<\/li>\s*<\/ul>/);
    const priceHtml = priceBlockM ? priceBlockM[1] : '';
    const priceLis = [...priceHtml.matchAll(/<li[^>]*>([\s\S]+?)<\/li>/g)].map(l => stripTags(l[1]));
    const rawPriceText = priceLis[0] ?? block.match(/([0-9,]+万円|[0-9.]+億[^<]{0,10}円)/)?.[0] ?? '';
    const { price, priceText } = extractPrice(rawPriceText);

    // 利回り: 2番目li "7.25％"
    const rawYieldText = priceLis[1] ?? '';
    const yieldRate = extractYieldRate(rawYieldText);

    // 面積: 3番目の<li>グループ "建:284.28m²" or "専:52.27m²"
    const areaM = block.match(/[建専]:([0-9.]+)m[²2]/);
    const area = areaM ? parseFloat(areaM[1]) : null;

    // 築年数・階数: 最後の<li>グループ "1970年4月" / "3階建/10戸"
    const yearM = block.match(/(\d{4})年\d+月/);
    const age = yearM ? (new Date().getFullYear() - parseInt(yearM[1])) : null;
    const floorM = block.match(/(\d+)階[建\/]/);
    const totalFloors = floorM ? parseInt(floorM[1]) : null;

    // 画像
    const imgM = block.match(/<img[^>]+src="(\/upload\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*>/i);
    const thumbnailUrl = imgM ? `https://www.kenbiya.com${imgM[1]}` : null;

    properties.push({
      id: `kenbiya_${sitePropertyId}`,
      siteId: 'kenbiya',
      sitePropertyId,
      title,
      propertyType: 'investment',
      status: 'active',
      prefecture: prefCode,
      city,
      address,
      price,
      priceText: priceText || '価格要相談',
      area,
      buildingArea: null,
      landArea: null,
      rooms: null,
      age,
      floor: null,
      totalFloors,
      station,
      stationMinutes,
      thumbnailUrl,
      detailUrl,
      description: null,
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
  const slug = KENBIYA_SLUGS[prefCode];
  if (!slug) return [];
  const name = PREF_NAMES[prefCode] ?? prefCode;
  const props = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? `https://www.kenbiya.com/pp0/${slug}/`
      : `https://www.kenbiya.com/pp0/${slug}/n-${page}/`;

    try {
      const html = await fetchWithRetry(url);
      const batch = parseKenbiyaPage(html, prefCode);

      let added = 0;
      for (const p of batch) {
        if (seen.has(p.sitePropertyId)) continue;
        seen.add(p.sitePropertyId);
        props.push(p);
        added++;
      }

      const cumulative = props.length;
      log(`${name} (${prefCode}) page=${page}: ${added}件 (累計: ${cumulative}件)`);

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
    : Object.keys(KENBIYA_SLUGS);

  const invalidCodes = prefCodes.filter(c => !KENBIYA_SLUGS[c]);
  if (invalidCodes.length > 0) {
    log(`ERROR: 無効な都道府県コード: ${invalidCodes.join(', ')}`);
    process.exit(1);
  }

  log(`健美家 全件スクレイパー開始 (${prefCodes.length}都道府県, 最大${MAX_PAGES}ページ/県)`);

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

  log(`完了: imported=${totalImported}, skipped=${totalSkipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
