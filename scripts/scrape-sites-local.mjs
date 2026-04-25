#!/usr/bin/env node
/**
 * ローカル深掘りスクレイパー: 健美家 + 不動産ジャパン
 * Windows Task Scheduler で毎日 04:45 に実行
 * CF Workers とは独立して動作 (bot検出回避・ページネーション対応)
 *
 * Usage: node scripts/scrape-sites-local.mjs [--site=kenbiya|realestate|all] [--dry-run]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const SITE_ARG = process.argv.find(a => a.startsWith('--site='))?.split('=')[1] ?? 'all';
const API_BASE = process.env.WORKER_URL ?? 'https://mal-search-system.navigator-187.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const IMPORT_URL = `${API_BASE}/api/admin/import`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[${new Date().toISOString()}] [local-scraper] ${msg}`); }

async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      else throw e;
    }
  }
}

function extractPrice(text) {
  const cleaned = text.replace(/[,\s]/g, '');
  const oku = cleaned.match(/(\d+(?:\.\d+)?)億(?:(\d+)万)?円/);
  if (oku) {
    const price = Math.round(parseFloat(oku[1]) * 10000) + (oku[2] ? parseInt(oku[2]) : 0);
    return { price, priceText: text.trim() };
  }
  const man = cleaned.match(/(\d+(?:\.\d+)?)万円/);
  if (man) return { price: Math.round(parseFloat(man[1])), priceText: text.trim() };
  return { price: null, priceText: text.trim() };
}

function extractArea(text) {
  const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:m²|㎡|平方)/);
  return m ? parseFloat(m[1]) : null;
}

function extractStation(text) {
  const m = text.match(/([^\s　]+駅?)\s*(?:徒歩)?(\d+)分/);
  return m ? { station: m[1].replace(/駅$/, ''), stationMinutes: parseInt(m[2]) } : { station: null, stationMinutes: null };
}

function extractYield(text) {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[%％]/);
  if (m) { const v = parseFloat(m[1]); return (v > 0 && v < 50) ? v : null; }
  return null;
}

// ─── 健美家スクレイパー ─────────────────────────────────────────────
const KENBIYA_PREFS = [
  { code: '13', slug: 's/tokyo' }, { code: '14', slug: 's/kanagawa' },
  { code: '27', slug: 'k/osaka' }, { code: '23', slug: 't/aichi' },
  { code: '11', slug: 's/saitama' }, { code: '12', slug: 's/chiba' },
  { code: '40', slug: 'f/fukuoka' }, { code: '01', slug: 'h/hokkaido' },
  { code: '26', slug: 'k/kyoto' }, { code: '28', slug: 'k/hyogo' },
  { code: '04', slug: 'm/miyagi' }, { code: '34', slug: 'o/hiroshima' },
  { code: '22', slug: 't/shizuoka' }, { code: '08', slug: 's/ibaraki' },
];

async function scrapeKenbiyaPref(code, slug) {
  const properties = [];
  for (let page = 1; page <= 5; page++) {
    const url = page === 1
      ? `https://www.kenbiya.com/pp0/${slug}/`
      : `https://www.kenbiya.com/pp0/${slug}/n-${page}/`;
    try {
      const html = await fetchHtml(url);
      // Find all property anchor tags: /pp1/, /pp2/, /pp5/, /pp8/ etc.
      const anchorMatches = [...html.matchAll(/<a\s[^>]*href="(\/pp[0-9]+\/[^"]*re_[a-z0-9]+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
      let found = 0;
      const seenIds = new Set();
      for (const aM of anchorMatches) {
        const path = aM[1];
        const aHtml = aM[2];
        const idM = path.match(/re_([a-z0-9]+)/i);
        if (!idM) continue;
        const sitePropertyId = idM[1];
        if (seenIds.has(sitePropertyId)) continue;
        seenIds.add(sitePropertyId);
        const detailUrl = `https://www.kenbiya.com${path}`;
        const titleM = aHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        if (!titleM) continue;
        const title = titleM[1].replace(/<[^>]+>/g, '').trim();
        if (!title) continue;
        const plainText = aHtml.replace(/<[^>]+>/g, ' ');
        const priceRaw = plainText.match(/([0-9,]+万円|[0-9.]+億[^<\n]*円)/)?.[0] ?? '';
        const { price, priceText } = extractPrice(priceRaw);
        const yieldRate = extractYield(plainText);
        const area = extractArea(plainText);
        const addrM = plainText.match(/([^\s　]+[市区町村][^\n]{0,20})/);
        const city = addrM ? (addrM[1].match(/([^\s　]+[市区町村])/)?.[1] ?? '') : '';
        const { station, stationMinutes } = extractStation(plainText);
        properties.push({
          id: `kenbiya_${sitePropertyId}`,
          siteId: 'kenbiya', sitePropertyId, title,
          propertyType: 'investment', status: 'active',
          prefecture: code, city, address: addrM?.[1] ?? null,
          price, priceText, area, yieldRate,
          station, stationMinutes,
          detailUrl, thumbnailUrl: null, fingerprint: null,
        });
        found++;
      }
      log(`  kenbiya ${slug} page ${page}: ${found} props`);
      if (found < 5) break;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      log(`  WARNING: kenbiya ${slug} p${page}: ${e.message}`);
      break;
    }
  }
  return properties;
}

// ─── 不動産ジャパン (realestate.co.jp/en) スクレイパー ───────────────
// URL: https://www.realestate.co.jp/en/forsale/{slug}?prefecture=JP-{num}&page={page}
// Property link: /en/forsale/view/{id}
// Price: "Price ¥{amount}" in JPY → convert to 万円
const REALESTATE_PREFS = [
  { code: '13', num: '13', slug: 'tokyo' },
  { code: '14', num: '14', slug: 'kanagawa' },
  { code: '27', num: '27', slug: 'osaka' },
  { code: '23', num: '23', slug: 'aichi' },
  { code: '11', num: '11', slug: 'saitama' },
  { code: '12', num: '12', slug: 'chiba' },
  { code: '40', num: '40', slug: 'fukuoka' },
  { code: '01', num: '01', slug: 'hokkaido' },
  { code: '26', num: '26', slug: 'kyoto' },
  { code: '28', num: '28', slug: 'hyogo' },
];

function parseRealestateJpyPrice(text) {
  // "Price ¥189,800,000" → convert JPY to 万円
  const m = text.match(/[¥￥]([0-9,]+)/);
  if (!m) return { price: null, priceText: '価格要相談' };
  const yen = parseInt(m[1].replace(/,/g, ''), 10);
  const man = Math.round(yen / 10000);
  const priceText = man >= 10000
    ? `${(man / 10000).toFixed(2).replace(/\.?0+$/, '')}億円`
    : `${man.toLocaleString()}万円`;
  return { price: man, priceText };
}

async function scrapeRealestatePref(code, num, slug) {
  const properties = [];
  for (let page = 1; page <= 3; page++) {
    const url = `https://www.realestate.co.jp/en/forsale/${slug}?prefecture=JP-${num}&page=${page}`;
    try {
      const html = await fetchHtml(url);
      let found = 0;
      const seen = new Set();

      // Property links: /en/forsale/view/{id}
      const linkRe = /href="(\/en\/forsale\/view\/(\d+)[^"]*)"/gi;
      for (const lm of html.matchAll(linkRe)) {
        const path = lm[1].split('?')[0]; // strip query params
        const sitePropertyId = lm[2];
        if (seen.has(sitePropertyId)) continue;
        seen.add(sitePropertyId);

        const detailUrl = `https://www.realestate.co.jp${path}`;

        // Find context around this link (500 chars before + 800 after)
        const idx = html.indexOf(lm[0]);
        const ctx = html.slice(Math.max(0, idx - 500), idx + 800);
        const plainCtx = ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        // Title: text in the anchor or nearby heading
        const titleM = ctx.match(/<(?:h[1-6]|strong|b)[^>]*>([^<]{5,80})<\/(?:h[1-6]|strong|b)>/i);
        const title = titleM ? titleM[1].trim() : `物件 ${sitePropertyId}`;

        // Price: "Price ¥..." pattern
        const { price, priceText } = parseRealestateJpyPrice(plainCtx);

        // Area: "NNN m²" or "NNN sqm"
        const areaM = plainCtx.match(/(\d+(?:\.\d+)?)\s*(?:m²|sqm|sq\.m)/i);
        const area = areaM ? parseFloat(areaM[1]) : null;

        // City from address context
        const cityM = plainCtx.match(/([^\s,]+(?:区|市|町|村))/);
        const city = cityM ? cityM[1] : '';

        properties.push({
          id: `fudosan_${sitePropertyId}`,
          siteId: 'fudosan', sitePropertyId, title,
          propertyType: 'mansion', status: 'active',
          prefecture: code, city, address: null,
          price, priceText, area,
          detailUrl, thumbnailUrl: null, fingerprint: null,
        });
        found++;
      }

      log(`  realestate ${slug} page ${page}: ${found} props`);
      if (found < 5) break;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      log(`  WARNING: realestate ${slug} p${page}: ${e.message}`);
      break;
    }
  }
  return properties;
}

// ─── インポート ────────────────────────────────────────────────────
async function importBatch(properties) {
  if (properties.length === 0) return { imported: 0, skipped: 0 };
  if (DRY_RUN) {
    log(`[DRY-RUN] would import ${properties.length} properties`);
    return { imported: properties.length, skipped: 0 };
  }
  let totalImported = 0, totalSkipped = 0;
  for (let i = 0; i < properties.length; i += 100) {
    const batch = properties.slice(i, i + 100);
    try {
      const resp = await fetch(IMPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}` },
        body: JSON.stringify({ properties: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) { log(`WARNING: HTTP ${resp.status} on import`); continue; }
      const r = await resp.json();
      totalImported += r.imported ?? batch.length;
      totalSkipped += r.skipped ?? 0;
    } catch (e) { log(`ERROR: import batch: ${e.message}`); }
  }
  return { imported: totalImported, skipped: totalSkipped };
}

// ─── メイン ───────────────────────────────────────────────────────
async function main() {
  log(`ローカル深掘りスクレイパー開始 (site=${SITE_ARG})`);
  const allProps = [];

  if (SITE_ARG === 'kenbiya' || SITE_ARG === 'all') {
    log('=== 健美家 ===');
    for (const { code, slug } of KENBIYA_PREFS) {
      log(`▶ ${slug}`);
      try {
        const props = await scrapeKenbiyaPref(code, slug);
        allProps.push(...props);
        log(`  完了: ${props.length}件`);
      } catch (e) { log(`  ERROR: ${e.message}`); }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (SITE_ARG === 'realestate' || SITE_ARG === 'all') {
    log('=== 不動産ジャパン ===');
    for (const { code, num, slug } of REALESTATE_PREFS) {
      log(`▶ 都道府県 ${num} (${slug})`);
      try {
        const props = await scrapeRealestatePref(code, num, slug);
        allProps.push(...props);
        log(`  完了: ${props.length}件`);
      } catch (e) { log(`  ERROR: ${e.message}`); }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  log(`合計 ${allProps.length}件 → インポート開始`);
  const { imported, skipped } = await importBatch(allProps);
  log(`完了: imported=${imported} skipped=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
