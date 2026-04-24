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

const RSS_FEEDS = [
  'https://www.rakumachi.jp/suikoubutsu/rss/',         // 新着 (全種別)
  'https://www.rakumachi.jp/suikoubutsu/rss/?type=1',  // マンション
  'https://www.rakumachi.jp/suikoubutsu/rss/?type=2',  // アパート
  'https://www.rakumachi.jp/suikoubutsu/rss/?type=4',  // 一棟ビル
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[${new Date().toISOString()}] [rakumachi-rss] ${msg}`); }

function parseRssItem(item) {
  const get = (tag) => item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))?.[1] ?? item.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))?.[1] ?? '';

  const title = get('title').trim();
  const link = get('link').trim() || item.match(/<link>(https?:[^<]+)<\/link>/i)?.[1]?.trim() ?? '';
  const description = get('description').trim();
  const pubDate = get('pubDate').trim();

  if (!title || !link) return null;

  // ID from URL: /syuuekibukken/.../XXXXXX/show.html
  const idMatch = link.match(/\/(\d{5,})\/show\.html/) ?? link.match(/\/(\d{5,})\//);
  const sitePropertyId = idMatch ? idMatch[1] : btoa(link).slice(0, 24);

  // Price from title/description
  const priceMatch = (title + description).match(/([0-9,]+)\s*万円/) ??
                     (title + description).match(/([0-9]+(?:\.[0-9]+)?)\s*億(?:([0-9,]+)\s*万)?円/);
  let price = null;
  let priceText = '価格要相談';
  if (priceMatch) {
    if (priceMatch[0].includes('億')) {
      const oku = parseFloat(priceMatch[1]) * 10000;
      const man = priceMatch[2] ? parseInt(priceMatch[2].replace(/,/g, '')) : 0;
      price = oku + man;
      priceText = priceMatch[0].trim();
    } else {
      price = parseInt(priceMatch[1].replace(/,/g, ''));
      priceText = `${price.toLocaleString()}万円`;
    }
  }

  // Prefecture from description
  const prefMap = {'東京':13,'神奈川':14,'大阪':27,'愛知':23,'福岡':40,'北海道':1,'京都':26,'兵庫':28,'埼玉':11,'千葉':12,'静岡':22,'広島':34,'宮城':4,'新潟':15,'長野':20,'岡山':33,'栃木':9,'群馬':10,'茨城':8,'岐阜':21,'三重':24,'滋賀':25,'奈良':29,'和歌山':30,'青森':2,'岩手':3,'秋田':5,'山形':6,'福島':7,'富山':16,'石川':17,'福井':18,'山梨':19,'鳥取':31,'島根':32,'山口':35,'徳島':36,'香川':37,'愛媛':38,'高知':39,'佐賀':41,'長崎':42,'熊本':43,'大分':44,'宮崎':45,'鹿児島':46,'沖縄':47};
  let prefecture = '13'; // fallback: Tokyo
  for (const [name, code] of Object.entries(prefMap)) {
    if ((title + description + link).includes(name)) {
      prefecture = String(code).padStart(2, '0');
      break;
    }
  }

  // Yield from title: "表面利回りX.X%"
  const yieldMatch = (title + description).match(/(?:表面)?利回り\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/);
  const yieldRate = yieldMatch ? parseFloat(yieldMatch[1]) : null;

  // City
  const cityMatch = (title + description).match(/([^\s　]+[市区町村])/);
  const city = cityMatch ? cityMatch[1] : '';

  return {
    id: `rakumachi_${sitePropertyId}`,
    siteId: 'rakumachi',
    sitePropertyId,
    title,
    propertyType: 'investment',
    status: 'active',
    prefecture,
    city,
    address: null,
    price,
    priceText,
    area: null,
    buildingArea: null,
    landArea: null,
    rooms: null,
    age: null,
    floor: null,
    totalFloors: null,
    station: null,
    stationMinutes: null,
    thumbnailUrl: null,
    detailUrl: link,
    description: description.slice(0, 500) || null,
    yieldRate,
    latitude: null,
    longitude: null,
    fingerprint: null,
    listedAt: pubDate ? new Date(pubDate).toISOString() : null,
  };
}

async function fetchRss(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.text();
}

async function importToWorker(properties) {
  if (properties.length === 0) return { imported: 0, skipped: 0 };
  if (DRY_RUN) {
    log(`[DRY-RUN] would import ${properties.length} properties`);
    return { imported: properties.length, skipped: 0 };
  }

  // バッチ100件ずつ送信
  let totalImported = 0, totalSkipped = 0;
  for (let i = 0; i < properties.length; i += 100) {
    const batch = properties.slice(i, i + 100);
    try {
      const resp = await fetch(IMPORT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ADMIN_SECRET}`,
        },
        body: JSON.stringify({ properties: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        log(`WARNING: import batch failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const result = await resp.json();
      totalImported += result.imported ?? batch.length;
      totalSkipped += result.skipped ?? 0;
    } catch (e) {
      log(`ERROR: import batch ${i}..${i+100}: ${e.message}`);
    }
  }
  return { imported: totalImported, skipped: totalSkipped };
}

async function main() {
  log('楽待 RSS スクレイプ開始');
  const seen = new Set();
  const allProperties = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      log(`RSS取得: ${feedUrl}`);
      const xml = await fetchRss(feedUrl);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
      log(`  ${items.length} items in feed`);

      for (const item of items) {
        const prop = parseRssItem(item);
        if (!prop || seen.has(prop.sitePropertyId)) continue;
        seen.add(prop.sitePropertyId);
        allProperties.push(prop);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      log(`WARNING: ${feedUrl} → ${e.message}`);
    }
  }

  log(`合計 ${allProperties.length} 件 (重複除去後)`);
  const { imported, skipped } = await importToWorker(allProperties);
  log(`インポート完了: imported=${imported} skipped=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
