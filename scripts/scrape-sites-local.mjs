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
      // Extract from table list
      const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)];
      let found = 0;
      for (const liM of liMatches) {
        const liHtml = liM[1];
        const linkM = liHtml.match(/href="(\/pp1\/[^"]+)"/);
        if (!linkM) continue;
        const detailUrl = `https://www.kenbiya.com${linkM[1]}`;
        const idM = detailUrl.match(/\/re_([a-z0-9]+)\//i) ?? detailUrl.match(/\/(\d{6,})\//);
        if (!idM) continue;
        const sitePropertyId = idM[1];
        const titleM = liHtml.match(/<h3[^>]*>([^<]+)<\/h3>/);
        if (!titleM) continue;
        const title = titleM[1].trim();
        const priceRaw = liHtml.match(/([0-9,]+万円|[0-9.]+億[^<]*円)/)?.[0] ?? '';
        const { price, priceText } = extractPrice(priceRaw);
        const yieldRate = extractYield(liHtml);
        const area = extractArea(liHtml);
        const addrM = liHtml.match(/([^\s　]+[市区町村][^<\n]{0,20})/);
        const city = addrM ? addrM[1].match(/([^\s　]+[市区町村])/)?.[1] ?? '' : '';
        const { station, stationMinutes } = extractStation(liHtml.replace(/<[^>]+>/g, ' '));
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

// ─── 不動産ジャパン スクレイパー ───────────────────────────────────
const REALESTATE_PREFS = [
  { code: '13', num: '13' }, { code: '14', num: '14' },
  { code: '27', num: '27' }, { code: '23', num: '23' },
  { code: '11', num: '11' }, { code: '12', num: '12' },
  { code: '40', num: '40' }, { code: '01', num: '1' },
  { code: '26', num: '26' }, { code: '28', num: '28' },
];

async function scrapeRealestatePref(code, num) {
  const properties = [];
  for (let page = 1; page <= 5; page++) {
    const url = page === 1
      ? `https://www.realestate.co.jp/mansion/prefecture/${num}/buy/list/`
      : `https://www.realestate.co.jp/mansion/prefecture/${num}/buy/list/?p=${page}`;
    try {
      const html = await fetchHtml(url);

      // Try __NEXT_DATA__ first
      const ndM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
      let found = 0;
      if (ndM) {
        try {
          const json = JSON.parse(ndM[1]);
          const pp = json?.props?.pageProps ?? {};
          const items = pp?.properties ?? pp?.mansions ?? pp?.bukkenList ?? pp?.list ?? [];
          for (const item of (Array.isArray(items) ? items : [])) {
            const title = String(item?.name ?? item?.title ?? '').trim();
            const urlPath = String(item?.url ?? item?.detailUrl ?? '');
            if (!title || !urlPath) continue;
            const detailUrl = urlPath.startsWith('http') ? urlPath : `https://www.realestate.co.jp${urlPath}`;
            const idM2 = detailUrl.match(/\/(\d{6,})\//);
            const sitePropertyId = idM2 ? idM2[1] : btoa(urlPath).slice(0, 24);
            const { price, priceText } = extractPrice(String(item?.price ?? ''));
            const area = parseFloat(String(item?.area ?? '')) || null;
            const city = String(item?.address ?? '').match(/([^\s　]+[市区町村])/)?.[1] ?? '';
            properties.push({
              id: `fudosan_${sitePropertyId}`,
              siteId: 'fudosan', sitePropertyId, title,
              propertyType: 'mansion', status: 'active',
              prefecture: code, city, address: String(item?.address ?? '') || null,
              price, priceText, area, detailUrl,
              thumbnailUrl: String(item?.image ?? '') || null, fingerprint: null,
            });
            found++;
          }
        } catch { /* fall through to DOM */ }
      }

      // DOM fallback: link-based extraction
      if (found === 0) {
        const links = [...html.matchAll(/href="(\/mansion\/[^"]+\/\d+\/[^"]+)"/g)];
        for (const [, path] of links.slice(0, 30)) {
          const idM2 = path.match(/\/(\d{6,})\//);
          if (!idM2) continue;
          const sitePropertyId = idM2[1];
          const detailUrl = `https://www.realestate.co.jp${path}`;
          properties.push({
            id: `fudosan_${sitePropertyId}`,
            siteId: 'fudosan', sitePropertyId,
            title: `不動産ジャパン物件 ${sitePropertyId}`,
            propertyType: 'mansion', status: 'active',
            prefecture: code, city: '', address: null,
            price: null, priceText: '価格要確認', area: null,
            detailUrl, thumbnailUrl: null, fingerprint: null,
          });
          found++;
        }
      }

      log(`  realestate ${num} page ${page}: ${found} props`);
      if (found < 5) break;
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      log(`  WARNING: realestate ${num} p${page}: ${e.message}`);
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
    for (const { code, num } of REALESTATE_PREFS) {
      log(`▶ 都道府県 ${num}`);
      try {
        const props = await scrapeRealestatePref(code, num);
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
