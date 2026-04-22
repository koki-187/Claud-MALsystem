import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';
import type { Bindings, AppVariables } from './types';
import { searchProperties, getPropertyById, getStats, logSearch, searchMasters } from './db/queries';
import { aggregateSearch, runScheduledScrape } from './scrapers/aggregator';
import { PREFECTURES, SITES } from './types';
import { admin as adminRoutes } from './routes/admin';
import { processQueue } from './services/image-pipeline';
import { archiveOldestCold } from './services/archive';
import { buildMasters } from './services/master-builder';

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

// =====================
// Middleware
// =====================
app.use('*', logger());
app.use('*', timing());
app.use('*', secureHeaders());
app.use('/api/*', cors({
  origin: (origin) => {
    // 本番Worker domain と localhost (開発) のみ許可
    const allowed = [
      'https://mal-search-system.navigator-187.workers.dev',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
    ];
    return allowed.includes(origin) ? origin : allowed[0];
  },
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// =====================
// Rate Limiting (KV-based)
// =====================
async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxRequests: number,
  windowSec: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSec);
  const kvKey = `rl:${key}:${bucket}`;
  const raw = await kv.get(kvKey).catch(() => null);
  const count = raw ? parseInt(raw) : 0;
  if (count >= maxRequests) return false;
  await kv.put(kvKey, String(count + 1), { expirationTtl: windowSec * 2 }).catch(() => {});
  return true;
}

// 60 req/min per IP on /api/search
app.use('/api/search', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env.MAL_CACHE, `search:${ip}`, 60, 60);
  if (!allowed) return c.json({ error: 'Too Many Requests' }, 429);
  await next();
});

// 5 req/min per IP on /api/scrape/run
app.use('/api/scrape/run', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env.MAL_CACHE, `scrape:${ip}`, 5, 60);
  if (!allowed) return c.json({ error: 'Too Many Requests' }, 429);
  await next();
});

// =====================
// API Routes
// =====================

app.get('/api/search', async (c) => {
  const q = c.req.query();
  const startTime = Date.now();
  const params = {
    query: q.q,
    prefecture: q.prefecture as any,
    city: q.city,
    propertyType: q.type as any,
    status: (q.status as any) ?? 'active',
    priceMin: q.price_min ? parseInt(q.price_min) : undefined,
    priceMax: q.price_max ? parseInt(q.price_max) : undefined,
    areaMin: q.area_min ? parseFloat(q.area_min) : undefined,
    areaMax: q.area_max ? parseFloat(q.area_max) : undefined,
    rooms: q.rooms,
    ageMax: q.age_max ? parseInt(q.age_max) : undefined,
    stationMinutes: q.station_min ? parseInt(q.station_min) : undefined,
    yieldMin: q.yield_min ? parseFloat(q.yield_min) : undefined,
    sites: q.sites ? (q.sites.split(',') as any) : undefined,
    hideDuplicates: q.hide_duplicates === '1' ? true : (q.hide_duplicates === '0' ? false : undefined),
    sortBy: q.sort as any,
    page: q.page ? parseInt(q.page) : 1,
    limit: q.limit ? parseInt(q.limit) : 18,
  };

  try {
    const cacheKey = `search:${new URLSearchParams(q).toString()}`;
    const cached = await c.env.MAL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) return c.json({ ...(cached as object), cacheHit: true });

    const dbResult = await searchProperties(c.env.MAL_DB, params).catch(() => null);
    if (dbResult && dbResult.total > 0) {
      await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(dbResult), { expirationTtl: 3600 }).catch(() => {});
      logSearch(c.env.MAL_DB, params, dbResult.total, Date.now() - startTime).catch(() => {});
      return c.json(dbResult);
    }

    const { properties, siteResults } = await aggregateSearch(params, c.env);
    const page = params.page, limit = params.limit;
    const result = {
      properties: properties.slice((page - 1) * limit, page * limit),
      total: properties.length,
      page, limit,
      totalPages: Math.ceil(properties.length / limit),
      sites: siteResults,
      executionTimeMs: Date.now() - startTime,
      cacheHit: false,
    };
    await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }).catch(() => {});
    logSearch(c.env.MAL_DB, params, result.total, result.executionTimeMs).catch(() => {});
    return c.json(result);
  } catch (error) {
    console.error('[/api/search] error:', error);
    return c.json({ error: 'Search failed' }, 500);
  }
});

app.get('/api/properties/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const property = await getPropertyById(c.env.MAL_DB, id);
    if (!property) return c.json({ error: 'Property not found' }, 404);
    return c.json(property);
  } catch (error) {
    console.error('[/api/properties/:id] error:', error);
    return c.json({ error: 'Failed to fetch property' }, 500);
  }
});

app.get('/api/stats', async (c) => {
  try {
    const stats = await getStats(c.env.MAL_DB);
    return c.json(stats);
  } catch {
    return c.json({ totalProperties: 0, activeProperties: 0, soldProperties: 0, bysite: [], byPrefecture: [], recentJobs: [] });
  }
});

app.get('/api/search/master', async (c) => {
  const q = c.req.query();
  const startTime = Date.now();
  const params = {
    query: q.q,
    prefecture: q.prefecture as any,
    city: q.city,
    propertyType: q.type as any,
    priceMin: q.price_min ? parseInt(q.price_min) : undefined,
    priceMax: q.price_max ? parseInt(q.price_max) : undefined,
    areaMin: q.area_min ? parseFloat(q.area_min) : undefined,
    areaMax: q.area_max ? parseFloat(q.area_max) : undefined,
    rooms: q.rooms,
    ageMax: q.age_max ? parseInt(q.age_max) : undefined,
    stationMinutes: q.station_min ? parseInt(q.station_min) : undefined,
    yieldMin: q.yield_min ? parseFloat(q.yield_min) : undefined,
    sortBy: q.sort as any,
    page: q.page ? parseInt(q.page) : 1,
    limit: q.limit ? parseInt(q.limit) : 18,
  };

  try {
    const cacheKey = `master:${new URLSearchParams(q).toString()}`;
    const cached = await c.env.MAL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) return c.json({ ...(cached as object), cacheHit: true });

    const result = await searchMasters(c.env.MAL_DB, params);
    result.executionTimeMs = Date.now() - startTime;
    await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 1800 }).catch(() => {});
    return c.json(result);
  } catch (error) {
    console.error('[/api/search/master] error:', error);
    return c.json({ error: 'Master search failed' }, 500);
  }
});

app.get('/api/health', (c) => c.json({
  status: 'ok',
  version: c.env.APP_VERSION ?? '6.2.0',
  timestamp: new Date().toISOString(),
  sites: Object.keys(SITES).length,
}));

app.get('/api/scrape/status', async (c) => {
  try {
    const jobs = await c.env.MAL_DB
      .prepare('SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT 20')
      .all();
    return c.json({ jobs: jobs.results ?? [] });
  } catch {
    return c.json({ jobs: [] });
  }
});

app.post('/api/scrape/run', async (c) => {
  try {
    const result = await runScheduledScrape(c.env);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error('[/api/scrape/run] error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/manifest.json', (c) => c.json({
  name: 'MAL検索システム',
  short_name: 'MAL',
  description: '47都道府県・9サイト横断 不動産情報統合検索システム',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#2563eb',
  icons: [
    { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌎</text></svg>", sizes: '192x192', type: 'image/svg+xml' },
  ],
}));

app.get('/api/suggest', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q) return c.json({ suggestions: [] });
  try {
    const rows = await c.env.MAL_DB
      .prepare("SELECT DISTINCT city FROM properties WHERE city LIKE ? AND status = 'active' LIMIT 10")
      .bind(`%${q}%`)
      .all<{ city: string }>();
    return c.json({ suggestions: rows.results?.map(r => r.city) ?? [] });
  } catch {
    return c.json({ suggestions: [] });
  }
});

// R2 image delivery
app.get('/api/images/*', async (c) => {
  const key = c.req.path.replace('/api/images/', '');
  if (!key) return c.notFound();
  try {
    const obj = await c.env.MAL_STORAGE.get(key);
    if (!obj) return c.notFound();
    const ct = obj.httpMetadata?.contentType ?? 'image/jpeg';
    return new Response(obj.body, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return c.notFound();
  }
});

app.get('/api/transactions', async (c) => {
  const prefecture = c.req.query('prefecture') ?? '13';
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100);
  try {
    const rows = await c.env.MAL_DB.prepare(`
      SELECT * FROM transaction_records
      WHERE prefecture = ?
      ORDER BY sold_at DESC LIMIT ?
    `).bind(prefecture, limit).all();
    return c.json({ transactions: rows.results ?? [], total: rows.results?.length ?? 0 });
  } catch {
    return c.json({ transactions: [], total: 0 });
  }
});

// =====================
// Admin Routes (Bearer token認証必須)
// =====================
app.use('/api/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_SECRET;
  if (!expected) {
    return c.json({ error: 'Admin API disabled: ADMIN_SECRET not configured' }, 503);
  }
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // 定数時間比較 (timing attack 緩和)
  if (provided.length !== expected.length || provided !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
app.route('/api/admin', adminRoutes);

// =====================
// Frontend
// =====================
app.get('*', (c) => c.html(getHTML()));

// =====================
// Cloudflare Cron Handler
// =====================
const scheduled = async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
  const hour = new Date(event.scheduledTime).getUTCHours();
  if (hour === 4) {
    // 画像ダウンロードキュー処理 (UTC 4時 = JST 13時)
    ctx.waitUntil(
      fetch(`${env.WORKER_URL ?? 'http://localhost:8787'}/api/admin/download-queue/process`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.ADMIN_SECRET ?? ''}` },
      }).catch(console.error)
    );
  } else {
    ctx.waitUntil(runScheduledScrape(env));
  }
  // 毎時: 画像キューを最大50件処理
  ctx.waitUntil(processQueue(env, 50).catch(console.error));
  // 毎時: 未リンク properties を master_properties に変換 (最大5000件)
  ctx.waitUntil(buildMasters(env, 5000).then(r => {
    if (r.created + r.updated > 0) {
      console.log(`[master-builder] created=${r.created} updated=${r.updated} linked=${r.linked}`);
    }
  }).catch(console.error));
  // D1容量監視: free tier 5GB (5120MB) の 80% (4096MB) 超で自動アーカイブ
  // PRAGMA page_count × page_size で実サイズを取得 (行数概算より高精度)
  ctx.waitUntil((async () => {
    try {
      const pc = await env.MAL_DB.prepare('PRAGMA page_count').first<{ page_count: number }>();
      const ps = await env.MAL_DB.prepare('PRAGMA page_size').first<{ page_size: number }>();
      const mb = pc && ps ? (pc.page_count * ps.page_size) / 1024 / 1024 : 0;
      if (mb >= 4096) {
        console.error(`[D1-CAPACITY-ALERT] ${mb.toFixed(0)}MB >= 4096MB (80% of 5GB) — starting auto-archive`);
        const result = await archiveOldestCold(env, 5, 2000);
        console.log(`[D1-AUTO-ARCHIVE] archived=${result.archived} deleted=${result.deleted} keys=${result.r2Keys.length}`);
      }
    } catch (e) { console.error('[D1-CAPACITY-CHECK-ERROR]', e); }
  })());
};

export default { fetch: app.fetch, scheduled };

// =====================
// HTML Generation
// =====================
function getHTML(): string {
  const prefectureOptions = Object.entries(PREFECTURES)
    .map(([code, name]) => `<option value="${code}">${name}</option>`)
    .join('\n');

  const siteCheckboxes = Object.entries(SITES)
    .map(([id, site]) => `
      <label class="site-chip" data-site="${id}" data-color="${site.color}">
        <input type="checkbox" value="${id}" class="site-cb" checked>
        <span class="chip-label">${site.logo} ${site.name}</span>
      </label>`)
    .join('\n');

  const skeletonCards = Array(6).fill(0).map(() => `
    <div class="prop-card skeleton-card">
      <div class="prop-img-wrap skeleton-block" style="height:200px"></div>
      <div class="prop-body">
        <div class="skeleton-block" style="height:14px;width:80%;margin-bottom:8px"></div>
        <div class="skeleton-block" style="height:12px;width:60%;margin-bottom:12px"></div>
        <div class="skeleton-block" style="height:22px;width:40%"></div>
      </div>
    </div>`).join('');

  const sitesJson = JSON.stringify(
    Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { logo: v.logo, name: v.name, color: v.color }]))
  );
  const prefJson = JSON.stringify(PREFECTURES);

  return `<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>MAL - 不動産一括検索システム</title>
  <meta name="description" content="47都道府県・9サイト横断 不動産情報統合検索システム">
  <meta name="theme-color" content="#2563eb">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌎</text></svg>">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous">
  <style>
/* ==========================================
   MAL v6.0 — Design System
   ========================================== */
:root {
  --c-primary: #2563eb;
  --c-primary-light: #3b82f6;
  --c-primary-dark: #1d4ed8;
  --c-accent: #7c3aed;
  --c-success: #16a34a;
  --c-warning: #d97706;
  --c-danger: #dc2626;
  --c-sold: #64748b;

  --c-bg: #f8fafc;
  --c-bg2: #f1f5f9;
  --c-surface: #ffffff;
  --c-border: #e2e8f0;
  --c-border2: #cbd5e1;

  --c-text: #0f172a;
  --c-text2: #334155;
  --c-text3: #64748b;
  --c-text4: #94a3b8;

  --radius: 12px;
  --radius-lg: 16px;
  --radius-sm: 8px;
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --shadow-md: 0 4px 16px rgba(0,0,0,.10);
  --shadow-lg: 0 8px 32px rgba(0,0,0,.14);
  --transition: .18s ease;
}
[data-theme="dark"] {
  --c-bg: #0f172a;
  --c-bg2: #1e293b;
  --c-surface: #1e293b;
  --c-border: #334155;
  --c-border2: #475569;
  --c-text: #f1f5f9;
  --c-text2: #cbd5e1;
  --c-text3: #94a3b8;
  --c-text4: #64748b;
}
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', sans-serif;
  background: var(--c-bg);
  color: var(--c-text);
  font-size: 14px;
  line-height: 1.6;
  min-height: 100vh;
}
a { color: inherit; text-decoration: none; }
button { cursor: pointer; border: none; background: none; font: inherit; }
input, select { font: inherit; }
input:focus, select:focus, button:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; }
img { max-width: 100%; }

/* ── Layout ── */
.page-wrap { display: flex; flex-direction: column; min-height: 100vh; }
.main { flex: 1; max-width: 1280px; margin: 0 auto; width: 100%; padding: 0 16px 48px; }

/* ── Header ── */
.header {
  position: sticky; top: 0; z-index: 100;
  background: rgba(248,250,252,.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--c-border);
  transition: background var(--transition);
}
[data-theme="dark"] .header { background: rgba(15,23,42,.92); }
.header-inner {
  max-width: 1280px; margin: 0 auto;
  padding: 0 16px; height: 60px;
  display: flex; align-items: center; gap: 12px;
}
.logo { display: flex; align-items: center; gap: 10px; }
.logo-icon { font-size: 24px; }
.logo-text { font-size: 18px; font-weight: 800; background: linear-gradient(135deg,var(--c-primary),var(--c-accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.logo-sub { font-size: 11px; color: var(--c-text3); font-weight: 500; }
.header-spacer { flex: 1; }
.stats-pill {
  display: none;
  align-items: center; gap: 6px;
  padding: 4px 12px; border-radius: 20px;
  background: var(--c-bg2); border: 1px solid var(--c-border);
  font-size: 12px; color: var(--c-text3); font-weight: 600;
}
@media(min-width:768px) { .stats-pill { display: flex; } }
.header-btn {
  width: 36px; height: 36px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  background: var(--c-bg2); border: 1px solid var(--c-border);
  color: var(--c-text3); font-size: 15px;
  transition: all var(--transition);
}
.header-btn:hover { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }
.btn-primary {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 18px; border-radius: 10px;
  background: var(--c-primary); color: #fff;
  font-size: 13px; font-weight: 700;
  transition: all var(--transition);
}
.btn-primary:hover { background: var(--c-primary-dark); }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 10px;
  background: var(--c-bg2); border: 1px solid var(--c-border);
  color: var(--c-text2); font-size: 13px;
  transition: all var(--transition);
}
.btn-ghost:hover { border-color: var(--c-primary); color: var(--c-primary); }

/* ── Search Panel ── */
.search-panel {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin: 20px 0;
  box-shadow: var(--shadow-sm);
}
.search-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
@media(min-width:600px) { .search-grid { grid-template-columns: repeat(2,1fr); } }
@media(min-width:960px) { .search-grid { grid-template-columns: 2fr 1fr 1fr 1fr; } }
.field-label { font-size: 11px; font-weight: 700; color: var(--c-text3); letter-spacing: .04em; text-transform: uppercase; margin-bottom: 5px; }
.field-input {
  width: 100%; padding: 9px 12px; border-radius: var(--radius-sm);
  border: 1.5px solid var(--c-border); background: var(--c-bg);
  color: var(--c-text); font-size: 14px;
  transition: border-color var(--transition);
}
.field-input:focus { border-color: var(--c-primary); background: var(--c-surface); }
.input-icon-wrap { position: relative; }
.input-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--c-text4); font-size: 13px; pointer-events: none; }
.field-input.has-icon { padding-left: 32px; }
.range-row { display: flex; align-items: center; gap: 6px; }
.range-row .field-input { flex: 1; min-width: 0; }
.range-sep { color: var(--c-text4); font-size: 12px; white-space: nowrap; }

/* Grid row 2 */
.search-grid2 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top: 14px; }
@media(max-width:600px) { .search-grid2 { grid-template-columns: 1fr 1fr; } }

/* Grid row 3 */
.search-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top: 14px; }
@media(max-width:600px) { .search-grid3 { grid-template-columns: 1fr 1fr; } }

/* Site filters */
.sites-row { margin-top: 16px; }
.sites-label { font-size: 11px; font-weight: 700; color: var(--c-text3); letter-spacing:.04em; text-transform:uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.sites-toggle-btn { font-size: 11px; font-weight: 600; color: var(--c-primary); padding: 0; cursor: pointer; }
.sites-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.site-chip { display: inline-flex; align-items: center; }
.site-chip input { display: none; }
.chip-label {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 20px;
  border: 1.5px solid var(--c-border);
  background: var(--c-bg); color: var(--c-text2);
  font-size: 12px; font-weight: 600;
  cursor: pointer; transition: all var(--transition); user-select: none;
}
.site-chip.active .chip-label { color: #fff; }

/* Actions row */
.actions-row { margin-top: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.sort-row { display: flex; align-items: center; gap: 8px; }
.sort-label { font-size: 12px; font-weight: 700; color: var(--c-text3); white-space: nowrap; }
.actions-spacer { flex: 1; }
.search-btn {
  padding: 10px 28px; border-radius: 10px;
  background: linear-gradient(135deg,var(--c-primary) 0%,var(--c-accent) 100%);
  color: #fff; font-size: 14px; font-weight: 800;
  display: inline-flex; align-items: center; gap: 8px;
  transition: opacity var(--transition), transform var(--transition);
  border: none; cursor: pointer;
}
.search-btn:hover { opacity: .9; transform: translateY(-1px); }
.search-btn:active { transform: translateY(0); }
.search-btn:disabled { opacity: .6; cursor: not-allowed; transform: none; }

/* ── Active Filters ── */
.filter-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 20px;
  background: var(--c-primary); color: #fff;
  font-size: 11px; font-weight: 600;
}
.filter-chip-remove { cursor: pointer; opacity: .8; }
.filter-chip-remove:hover { opacity: 1; }

/* ── Results Header ── */
.results-bar {
  display: none; align-items: center; gap: 12px;
  margin-bottom: 14px; flex-wrap: wrap;
}
.results-bar.visible { display: flex; }
.results-count { font-size: 16px; font-weight: 800; }
.results-time { font-size: 12px; color: var(--c-text3); }
.results-spacer { flex: 1; }
.view-btns { display: flex; gap: 4px; }
.view-btn {
  width: 32px; height: 32px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--c-border); background: var(--c-surface);
  color: var(--c-text3); font-size: 13px;
  transition: all var(--transition);
}
.view-btn.active { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }

/* ── Site Summary ── */
.site-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.site-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-weight: 700;
}

/* ── Property Grid ── */
.prop-grid { display: grid; gap: 16px; }
.prop-grid.grid-3 { grid-template-columns: repeat(1,1fr); }
@media(min-width:600px) { .prop-grid.grid-3 { grid-template-columns: repeat(2,1fr); } }
@media(min-width:960px) { .prop-grid.grid-3 { grid-template-columns: repeat(3,1fr); } }
.prop-grid.list-1 { grid-template-columns: 1fr; }

/* ── Property Card ── */
.prop-card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition);
  cursor: pointer;
  position: relative;
}
.prop-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
  border-color: var(--c-border2);
}
.prop-card.sold { opacity: .7; }
.prop-img-wrap {
  position: relative;
  background: var(--c-bg2);
  overflow: hidden;
  height: 200px;
}
.prop-img-wrap img {
  width: 100%; height: 100%;
  object-fit: cover;
  transition: transform .4s ease;
}
.prop-card:hover .prop-img-wrap img { transform: scale(1.04); }
.prop-img-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 48px;
}
.prop-badge-site {
  position: absolute; top: 10px; left: 10px;
  padding: 3px 9px; border-radius: 20px;
  font-size: 11px; font-weight: 700;
  color: #fff;
}
.prop-badge-type {
  position: absolute; top: 10px; right: 10px;
  padding: 3px 9px; border-radius: 20px;
  font-size: 10px; font-weight: 700;
  background: rgba(0,0,0,.6); color: #fff;
}
.prop-badge-new {
  position: absolute; bottom: 10px; left: 10px;
  padding: 2px 8px; border-radius: 20px;
  font-size: 10px; font-weight: 800;
  background: #ef4444; color: #fff; letter-spacing: .04em;
}
.prop-badge-sold {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.45);
  font-size: 22px; font-weight: 900; color: #fff;
  letter-spacing: .1em;
}
.prop-yield-badge {
  position: absolute; bottom: 10px; right: 10px;
  padding: 3px 9px; border-radius: 20px;
  font-size: 11px; font-weight: 800;
  background: #dc2626; color: #fff;
}
.prop-multi-source {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 8px; border-radius: 20px;
  font-size: 10px; font-weight: 800;
  background: linear-gradient(135deg,#7c3aed,#2563eb); color: #fff;
  margin-left: 6px; vertical-align: middle;
}
.sources-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.sources-table th { font-size: 10px; font-weight: 700; color: var(--c-text3); text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--c-border); }
.sources-table td { padding: 6px 8px; border-bottom: 1px solid var(--c-border); vertical-align: middle; }
.sources-table tr:last-child td { border-bottom: none; }
.prop-body { padding: 14px 16px 16px; }
.prop-title {
  font-size: 14px; font-weight: 700; color: var(--c-text);
  line-height: 1.45; margin-bottom: 6px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.prop-location {
  font-size: 12px; color: var(--c-text3);
  display: flex; align-items: center; gap: 4px;
  margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.prop-price { font-size: 20px; font-weight: 900; margin-bottom: 2px; }
.prop-specs { font-size: 11px; color: var(--c-text3); display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.prop-spec-item { display: flex; align-items: center; gap: 3px; }
.prop-footer { display: flex; align-items: center; justify-content: space-between; }
.prop-ext-link {
  font-size: 11px; font-weight: 700;
  padding: 4px 10px; border-radius: 6px;
}

/* ── List View ── */
.prop-grid.list-1 .prop-card { display: flex; }
.prop-grid.list-1 .prop-img-wrap { width: 200px; min-width: 200px; height: auto; min-height: 140px; }
.prop-grid.list-1 .prop-body { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
@media(max-width:600px) { .prop-grid.list-1 .prop-card { flex-direction: column; } .prop-grid.list-1 .prop-img-wrap { width: 100%; min-height: 160px; } }

/* ── Loading Skeleton ── */
.skeleton-card { pointer-events: none; }
.skeleton-block {
  background: linear-gradient(90deg,var(--c-border) 25%,var(--c-bg) 50%,var(--c-border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: 6px;
}
@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* ── Pagination ── */
.pagination { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px; margin-top: 32px; }
.page-btn {
  min-width: 38px; height: 38px; padding: 0 10px; border-radius: 8px;
  border: 1.5px solid var(--c-border); background: var(--c-surface);
  color: var(--c-text2); font-size: 13px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
  transition: all var(--transition);
}
.page-btn:hover { border-color: var(--c-primary); color: var(--c-primary); }
.page-btn.active { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }
.page-btn:disabled { opacity: .4; cursor: not-allowed; }

/* ── Empty / Error States ── */
.state-center { text-align: center; padding: 64px 16px; }
.state-icon { font-size: 56px; margin-bottom: 16px; }
.state-title { font-size: 20px; font-weight: 800; margin-bottom: 8px; }
.state-sub { color: var(--c-text3); font-size: 14px; margin-bottom: 24px; }

/* ── Hero (Initial State) ── */
.hero { text-align: center; padding: 48px 16px 32px; }
.hero-icon { font-size: 64px; margin-bottom: 16px; animation: float 3s ease-in-out infinite; }
@keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
.hero-title { font-size: clamp(24px,5vw,40px); font-weight: 900; margin-bottom: 8px; background: linear-gradient(135deg,var(--c-primary),var(--c-accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hero-sub { color: var(--c-text3); font-size: 15px; margin-bottom: 24px; }
.hero-guide {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 24px; border-radius: 40px; margin-bottom: 32px;
  background: linear-gradient(135deg,rgba(37,99,235,.1),rgba(124,58,237,.1));
  border: 1px solid rgba(37,99,235,.2); color: var(--c-text); font-size: 14px; font-weight: 600;
}
.hero-features { display: grid; grid-template-columns: repeat(1,1fr); gap: 12px; max-width: 720px; margin: 0 auto 28px; }
@media(min-width:600px) { .hero-features { grid-template-columns: repeat(3,1fr); } }
.hero-feature {
  background: var(--c-surface); border: 1px solid var(--c-border);
  border-radius: var(--radius); padding: 16px; text-align: center;
}
.hero-feature-icon { font-size: 24px; margin-bottom: 8px; }
.hero-feature-title { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
.hero-feature-desc { font-size: 12px; color: var(--c-text3); }
.hero-sites { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 640px; margin: 0 auto; }
.hero-site-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: 20px;
  background: var(--c-surface); border: 1px solid var(--c-border);
  font-size: 12px; font-weight: 700;
}

/* ── Modal ── */
.modal-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.6);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: fadeIn .18s ease;
}
.modal-overlay.hidden { display: none; }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
.modal-box {
  background: var(--c-surface);
  border-radius: var(--radius-lg);
  max-width: 900px; width: 100%;
  max-height: 92vh; overflow-y: auto;
  animation: slideUp .22s ease;
  border: 1px solid var(--c-border);
  box-shadow: var(--shadow-lg);
}
@keyframes slideUp { from{transform:translateY(24px);opacity:0} to{transform:translateY(0);opacity:1} }
@media(max-width:600px) {
  .modal-overlay { align-items: flex-end; padding: 0; }
  .modal-box { border-radius: var(--radius-lg) var(--radius-lg) 0 0; max-height: 88vh; }
}
.modal-close {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--c-bg2); color: var(--c-text3); font-size: 16px;
  transition: all var(--transition); flex-shrink: 0;
}
.modal-close:hover { background: var(--c-danger); color: #fff; }

/* Modal detail */
.modal-gallery { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 16px; }
.modal-gallery img { width: 100%; height: 120px; object-fit: cover; border-radius: 8px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
@media(min-width:600px) { .detail-grid { grid-template-columns: repeat(4,1fr); } }
.detail-item { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px; padding: 10px 12px; }
.detail-item-label { font-size: 10px; color: var(--c-text3); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
.detail-item-value { font-size: 14px; font-weight: 700; }
.detail-item-sub { font-size: 11px; color: var(--c-text3); margin-top: 2px; }
.features-wrap { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.feature-tag { padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: var(--c-bg2); border: 1px solid var(--c-border); color: var(--c-text2); }
.modal-cta {
  display: block; width: 100%; text-align: center;
  padding: 14px; border-radius: 10px;
  background: linear-gradient(135deg,var(--c-primary),var(--c-accent));
  color: #fff; font-size: 15px; font-weight: 800;
  transition: opacity var(--transition);
}
.modal-cta:hover { opacity: .9; }
.sold-banner {
  background: var(--c-sold); color: #fff;
  text-align: center; padding: 10px;
  font-size: 14px; font-weight: 800;
  border-radius: 8px; margin-bottom: 16px;
}

/* ── Stats Modal ── */
.stats-number { font-size: 48px; font-weight: 900; color: var(--c-primary); text-align: center; }
.stats-label { font-size: 14px; color: var(--c-text3); text-align: center; margin-bottom: 24px; }
.stat-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--c-border); }
.stat-row:last-child { border-bottom: none; }

/* ── Scrape Panel ── */
.scrape-panel {
  background: var(--c-surface); border: 1px solid var(--c-border);
  border-radius: var(--radius); padding: 16px;
  margin-bottom: 12px;
}
.scrape-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.scrape-title { font-size: 14px; font-weight: 700; }
.job-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; border-bottom: 1px solid var(--c-border); }
.job-row:last-child { border-bottom: none; }
.job-status { padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; }
.job-status.completed { background: #dcfce7; color: #16a34a; }
.job-status.running { background: #dbeafe; color: #2563eb; }
.job-status.failed { background: #fee2e2; color: #dc2626; }
.job-status.pending { background: var(--c-bg2); color: var(--c-text3); }

/* ── Utility ── */
.hidden { display: none !important; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--c-bg); }
::-webkit-scrollbar-thumb { background: var(--c-border2); border-radius: 3px; }

/* ── Export Bar ── */
.export-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.btn-export {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 10px;
  background: var(--c-success); color: #fff;
  font-size: 13px; font-weight: 700;
  transition: opacity var(--transition);
  border: none; cursor: pointer;
}
.btn-export:hover { opacity: .85; }
.btn-admin {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 10px;
  background: var(--c-bg2); border: 1px solid var(--c-border);
  color: var(--c-text2); font-size: 13px; font-weight: 700;
  transition: all var(--transition); cursor: pointer;
}
.btn-admin:hover { border-color: var(--c-primary); color: var(--c-primary); }

/* ── Tabs ── */
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 2px solid var(--c-border); }
.tab-btn {
  padding: 8px 18px; border-radius: 8px 8px 0 0;
  font-size: 13px; font-weight: 700; color: var(--c-text3);
  border: none; background: none; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -2px;
  transition: all var(--transition);
}
.tab-btn.active { color: var(--c-primary); border-bottom-color: var(--c-primary); background: var(--c-bg2); }
.tab-btn:hover:not(.active) { color: var(--c-text2); background: var(--c-bg2); }

/* ── Transaction Table ── */
.txn-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.txn-table th { background: var(--c-bg2); font-size: 11px; font-weight: 700; color: var(--c-text3); text-transform: uppercase; letter-spacing: .04em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--c-border); }
.txn-table td { padding: 10px 12px; border-bottom: 1px solid var(--c-border); color: var(--c-text2); vertical-align: top; }
.txn-table tr:last-child td { border-bottom: none; }
.txn-table tr:hover td { background: var(--c-bg2); }

/* ── Floor Plan & Gallery ── */
.img-gallery { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 12px; padding-bottom: 4px; }
.gallery-img { width: 120px; height: 90px; object-fit: cover; border-radius: 8px; flex-shrink: 0; cursor: pointer; transition: opacity var(--transition); }
.gallery-img:hover { opacity: .85; }
.floor-plan { max-width: 200px; border-radius: 8px; border: 1px solid var(--c-border); }

/* ── Print (マイソク印刷) ── */
@page { size: A4; margin: 10mm; }
@media print {
  .header, .search-panel, .export-bar, .filter-chips,
  .tab-bar, .results-bar, .site-summary, .loadingState,
  #resultsContainer, #pagination, #emptyState, #initialState,
  #transactionsPanel, .modal-close, .btn-ghost,
  .modal-overlay ~ .modal-overlay { display: none !important; }
  .modal-overlay { position: static !important; background: none !important;
    padding: 0 !important; backdrop-filter: none !important; display: block !important; }
  .modal-box { position: static !important; box-shadow: none !important;
    max-width: 100% !important; max-height: none !important;
    border: none !important; overflow: visible !important; }
  .gallery-img { width: auto; max-width: 100%; height: auto; max-height: 200px; }
  .img-gallery { flex-wrap: wrap; overflow: visible; }
  a[class="modal-cta"] { display: none !important; }
  body { background: #fff !important; color: #000 !important; }
}
  </style>
</head>
<body class="page-wrap">

<!-- =================== HEADER =================== -->
<header class="header">
  <div class="header-inner">
    <div class="logo">
      <span class="logo-icon">🌎</span>
      <div>
        <div class="logo-text">MAL</div>
        <div class="logo-sub">不動産一括検索 v6.0</div>
      </div>
    </div>
    <div class="header-spacer"></div>
    <div class="stats-pill" id="statsBar" style="display:none">
      <i class="fas fa-database" style="color:var(--c-primary)"></i>
      <span id="totalCount">--</span>件
    </div>
    <button class="header-btn" onclick="toggleTheme()" title="テーマ切替" id="themeBtn">
      <i class="fas fa-moon" id="themeIcon"></i>
    </button>
    <button class="btn-primary" onclick="showStatsModal()">
      <i class="fas fa-chart-bar"></i><span class="hidden md:inline">統計</span>
    </button>
  </div>
</header>

<!-- =================== MAIN =================== -->
<main class="main">

  <!-- Search Panel -->
  <div class="search-panel">

    <!-- Row 1: query / prefecture / type / status -->
    <div class="search-grid">
      <div>
        <div class="field-label">フリーワード</div>
        <div class="input-icon-wrap">
          <i class="fas fa-search input-icon"></i>
          <input type="search" id="searchQuery" placeholder="物件名・住所・駅名で検索..."
            class="field-input has-icon" autocomplete="off" list="citySuggestions"
            oninput="onSearchInput()" onkeydown="if(event.key==='Enter')doSearch()">
          <datalist id="citySuggestions"></datalist>
        </div>
      </div>
      <div>
        <div class="field-label">都道府県</div>
        <select id="prefecture" class="field-input">
          <option value="">全国</option>
          ${prefectureOptions}
        </select>
      </div>
      <div>
        <div class="field-label">物件種別</div>
        <select id="propertyType" class="field-input">
          <option value="">すべて</option>
          <option value="mansion">マンション（分譲）</option>
          <option value="kodate">一戸建て</option>
          <option value="tochi">土地</option>
          <option value="chintai_mansion">賃貸マンション</option>
          <option value="chintai_ikkodate">賃貸一戸建て</option>
          <option value="jimusho">事務所・店舗</option>
          <option value="investment">投資用物件</option>
        </select>
      </div>
      <div>
        <div class="field-label">ステータス</div>
        <select id="status" class="field-input">
          <option value="active">販売中</option>
          <option value="all">すべて（売却済含む）</option>
          <option value="sold">売却済のみ</option>
        </select>
      </div>
    </div>

    <!-- Row 2: price / area / rooms+station+age -->
    <div class="search-grid2">
      <div>
        <div class="field-label">価格 <span id="priceLabel" style="font-weight:400;color:var(--c-text3)">指定なし</span></div>
        <div class="range-row">
          <input type="number" id="priceMin" placeholder="下限(万円)" class="field-input" min="0" oninput="updatePriceLabel()">
          <span class="range-sep">〜</span>
          <input type="number" id="priceMax" placeholder="上限(万円)" class="field-input" min="0" oninput="updatePriceLabel()">
        </div>
      </div>
      <div>
        <div class="field-label">面積 <span id="areaLabel" style="font-weight:400;color:var(--c-text3)">指定なし</span></div>
        <div class="range-row">
          <input type="number" id="areaMin" placeholder="下限(m²)" class="field-input" min="0" oninput="updateAreaLabel()">
          <span class="range-sep">〜</span>
          <input type="number" id="areaMax" placeholder="上限(m²)" class="field-input" min="0" oninput="updateAreaLabel()">
        </div>
      </div>
      <div>
        <div class="field-label">利回り下限（投資）</div>
        <div class="range-row">
          <input type="number" id="yieldMin" placeholder="例: 7.5" class="field-input" min="0" step="0.1">
          <span class="range-sep">%以上</span>
        </div>
      </div>
    </div>

    <!-- Row 3: rooms / station / age -->
    <div class="search-grid3">
      <div>
        <div class="field-label">間取り</div>
        <select id="rooms" class="field-input">
          <option value="">すべて</option>
          <option value="1R">1R</option>
          <option value="1K">1K</option>
          <option value="1DK">1DK</option>
          <option value="1LDK">1LDK</option>
          <option value="2K">2K</option>
          <option value="2DK">2DK</option>
          <option value="2LDK">2LDK</option>
          <option value="3LDK">3LDK</option>
          <option value="4LDK">4LDK</option>
          <option value="5LDK以上">5LDK以上</option>
        </select>
      </div>
      <div>
        <div class="field-label">最寄駅 徒歩</div>
        <select id="stationMin" class="field-input">
          <option value="">制限なし</option>
          <option value="3">3分以内</option>
          <option value="5">5分以内</option>
          <option value="10">10分以内</option>
          <option value="15">15分以内</option>
          <option value="20">20分以内</option>
        </select>
      </div>
      <div>
        <div class="field-label">築年数</div>
        <select id="ageMax" class="field-input">
          <option value="">制限なし</option>
          <option value="1">新築（1年以内）</option>
          <option value="3">3年以内</option>
          <option value="5">5年以内</option>
          <option value="10">10年以内</option>
          <option value="15">15年以内</option>
          <option value="20">20年以内</option>
          <option value="30">30年以内</option>
        </select>
      </div>
    </div>

    <!-- Sites -->
    <div class="sites-row">
      <div class="sites-label">
        対象サイト（12サイト）
        <button class="sites-toggle-btn" onclick="toggleAllSites(true)">全選択</button>
        <button class="sites-toggle-btn" onclick="toggleAllSites(false)" style="color:var(--c-text3)">全解除</button>
      </div>
      <div class="sites-grid" id="siteCheckboxes">
        ${siteCheckboxes}
      </div>
    </div>

    <!-- Actions -->
    <div class="actions-row">
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--c-text2);cursor:pointer">
        <input type="checkbox" id="hideDuplicates" onchange="doSearch()" style="width:15px;height:15px;cursor:pointer">
        重複非表示
      </label>
      <div class="sort-row">
        <span class="sort-label">並び順:</span>
        <select id="sortBy" class="field-input" style="width:auto">
          <option value="newest">新着順</option>
          <option value="price_asc">価格安い順</option>
          <option value="price_desc">価格高い順</option>
          <option value="area_desc">面積広い順</option>
          <option value="area_asc">面積狭い順</option>
          <option value="yield_desc">利回り高い順</option>
          <option value="relevance">関連度順</option>
        </select>
      </div>
      <div class="actions-spacer"></div>
      <button onclick="clearSearch()" class="btn-ghost">
        <i class="fas fa-times"></i>クリア
      </button>
      <button onclick="doSearch()" id="searchBtn" class="search-btn">
        <i class="fas fa-search"></i>検索する
      </button>
    </div>
  </div>

  <!-- Export Bar -->
  <div class="export-bar">
    <button onclick="exportCSV()" class="btn-export">
      📥 CSV ダウンロード
    </button>
    <button onclick="window.location.href='/api/admin/stats'" class="btn-admin">
      📊 DB統計
    </button>
  </div>

  <!-- Active Filters -->
  <div class="filter-chips" id="filterChips"></div>

  <!-- Tab Bar -->
  <div class="tab-bar">
    <button class="tab-btn active" id="tabProperties" onclick="switchTab('properties')">🏠 物件一覧</button>
    <button class="tab-btn" id="tabTransactions" onclick="switchTab('transactions')">📋 成約事例</button>
  </div>

  <!-- Results Bar -->
  <div class="results-bar" id="resultsBar">
    <span id="resultCount" class="results-count"></span>
    <span id="executionTime" class="results-time"></span>
    <span class="results-spacer"></span>
    <div class="view-btns">
      <button class="view-btn active" id="gridBtn" onclick="setView('grid')" title="グリッド">
        <i class="fas fa-th-large"></i>
      </button>
      <button class="view-btn" id="listBtn" onclick="setView('list')" title="リスト">
        <i class="fas fa-list"></i>
      </button>
    </div>
  </div>

  <!-- Site Summary -->
  <div class="site-summary" id="siteSummary"></div>

  <!-- Loading -->
  <div id="loadingState" class="hidden">
    <div class="prop-grid grid-3">${skeletonCards}</div>
  </div>

  <!-- Results -->
  <div id="resultsContainer" class="prop-grid grid-3"></div>

  <!-- Pagination -->
  <div id="pagination" class="pagination"></div>

  <!-- Transactions Panel -->
  <div id="transactionsPanel" class="hidden">
    <div id="transactionsContent">
      <div style="text-align:center;padding:48px 0;color:var(--c-text3)">都道府県を選択して成約事例を表示します</div>
    </div>
  </div>

  <!-- Empty State -->
  <div id="emptyState" class="hidden state-center">
    <div class="state-icon">🔍</div>
    <div class="state-title">物件が見つかりませんでした</div>
    <div class="state-sub">検索条件を変えてお試しください</div>
    <button onclick="clearSearch()" class="search-btn">
      <i class="fas fa-redo"></i>条件をリセット
    </button>
  </div>

  <!-- Initial State -->
  <div id="initialState" class="hero">
    <div class="hero-icon">🌎</div>
    <h1 class="hero-title">MAL 不動産一括検索</h1>
    <p class="hero-sub">47都道府県 · 9サイト横断 · DB-First 高速検索</p>
    <div class="hero-guide">
      <span>📍</span>
      <span><strong>都道府県</strong>を選んで<strong>検索する</strong>を押してください</span>
      <i class="fas fa-arrow-up" style="color:var(--c-primary)"></i>
    </div>
    <div class="hero-features">
      <div class="hero-feature">
        <div class="hero-feature-icon">🔍</div>
        <div class="hero-feature-title">9サイト一括</div>
        <div class="hero-feature-desc">SUUMO・HOME'S・AtHome・REINS・健美家・楽待 など</div>
      </div>
      <div class="hero-feature">
        <div class="hero-feature-icon">🗾</div>
        <div class="hero-feature-title">47都道府県対応</div>
        <div class="hero-feature-desc">全国の物件情報をDBに集約して高速検索</div>
      </div>
      <div class="hero-feature">
        <div class="hero-feature-icon">📈</div>
        <div class="hero-feature-title">投資物件対応</div>
        <div class="hero-feature-desc">健美家・楽待から収益物件を利回り付きで検索</div>
      </div>
    </div>
    <div class="hero-sites" id="heroSites"></div>
  </div>

</main>

<!-- =================== PROPERTY MODAL =================== -->
<div id="propertyModal" class="modal-overlay hidden" onclick="if(event.target===this)closeModal()">
  <div class="modal-box">
    <div id="modalContent" style="padding:24px">
      <div style="text-align:center;padding:40px 0">
        <i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i>
      </div>
    </div>
  </div>
</div>

<!-- =================== STATS MODAL =================== -->
<div id="statsModal" class="modal-overlay hidden" onclick="if(event.target===this)closeStatsModal()">
  <div class="modal-box" style="max-width:580px">
    <div style="padding:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <span style="font-size:16px;font-weight:800">📊 システム統計</span>
        <button class="modal-close" onclick="closeStatsModal()">&times;</button>
      </div>
      <div id="statsContent">
        <div style="text-align:center;padding:40px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>
      </div>
    </div>
  </div>
</div>

<script>
// ==========================================
// MAL v6.0 — Frontend JavaScript
// ==========================================
var SITES_DATA = ${sitesJson};
var PREF_DATA = ${prefJson};

// ── State ──
var currentPage = 1;
var currentResults = null;
var viewMode = 'grid';

// ── Theme ──
function toggleTheme() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.getElementById('themeIcon').className = next === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  localStorage.setItem('mal_theme', next);
}
(function() {
  var t = localStorage.getItem('mal_theme') || 'light';
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeIcon').className = t === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
})();

// ── Site Chips Init ──
(function() {
  var chips = document.querySelectorAll('.site-chip');
  chips.forEach(function(chip) {
    var cb = chip.querySelector('input');
    var site = SITES_DATA[chip.dataset.site] || {};
    var color = site.color || '#64748b';
    function update() {
      if (cb.checked) {
        chip.classList.add('active');
        chip.querySelector('.chip-label').style.background = color;
        chip.querySelector('.chip-label').style.borderColor = color;
      } else {
        chip.classList.remove('active');
        chip.querySelector('.chip-label').style.background = '';
        chip.querySelector('.chip-label').style.borderColor = '';
        chip.querySelector('.chip-label').style.color = '';
      }
    }
    update();
    cb.addEventListener('change', update);
  });

  // Hero sites
  var heroSites = document.getElementById('heroSites');
  Object.entries(SITES_DATA).forEach(function(entry) {
    var id = entry[0], s = entry[1];
    var el = document.createElement('span');
    el.className = 'hero-site-badge';
    el.innerHTML = s.logo + ' <span style="color:' + s.color + '">' + escHtml(s.name) + '</span>';
    heroSites.appendChild(el);
  });

  // Stats bar
  loadHeaderStats();
})();

function toggleAllSites(checked) {
  document.querySelectorAll('.site-cb').forEach(function(cb) {
    cb.checked = checked;
    cb.dispatchEvent(new Event('change'));
  });
}

// ── Search ──
async function doSearch(page) {
  page = page || 1;
  currentPage = page;

  var q = new URLSearchParams();
  var query = document.getElementById('searchQuery').value.trim();
  var pref = document.getElementById('prefecture').value;
  var type = document.getElementById('propertyType').value;
  var status = document.getElementById('status').value;
  var priceMin = document.getElementById('priceMin').value;
  var priceMax = document.getElementById('priceMax').value;
  var areaMin = document.getElementById('areaMin').value;
  var areaMax = document.getElementById('areaMax').value;
  var yieldMin = document.getElementById('yieldMin').value;
  var rooms = document.getElementById('rooms').value;
  var stationMin = document.getElementById('stationMin').value;
  var ageMax = document.getElementById('ageMax').value;
  var sortBy = document.getElementById('sortBy').value;
  var sites = [].slice.call(document.querySelectorAll('.site-cb:checked')).map(function(cb) { return cb.value; });
  var hideDuplicates = document.getElementById('hideDuplicates') && (document.getElementById('hideDuplicates') as HTMLInputElement).checked;

  if (query) q.set('q', query);
  if (pref) q.set('prefecture', pref);
  if (type) q.set('type', type);
  if (status) q.set('status', status);
  if (priceMin) q.set('price_min', priceMin);
  if (priceMax) q.set('price_max', priceMax);
  if (areaMin) q.set('area_min', areaMin);
  if (areaMax) q.set('area_max', areaMax);
  if (yieldMin) q.set('yield_min', yieldMin);
  if (rooms) q.set('rooms', rooms);
  if (stationMin) q.set('station_min', stationMin);
  if (ageMax) q.set('age_max', ageMax);
  if (hideDuplicates) q.set('hide_duplicates', '1');
  var totalSites = Object.keys(SITES_DATA).length;
  if (sites.length > 0 && sites.length < totalSites) q.set('sites', sites.join(','));
  q.set('sort', sortBy);
  q.set('page', String(page));
  q.set('limit', '18');

  renderFilterChips(query, pref, type, priceMin, priceMax, areaMin, areaMax, rooms, stationMin, ageMax, yieldMin, status);
  setLoading(true);

  try {
    var res = await fetch('/api/search?' + q.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    currentResults = await res.json();
    renderResults(currentResults);
  } catch(err) {
    showError(escHtml(err.message || '検索に失敗しました'));
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  document.getElementById('loadingState').classList.toggle('hidden', !on);
  document.getElementById('resultsContainer').classList.toggle('hidden', on);
  if (on) {
    document.getElementById('initialState').classList.add('hidden');
    document.getElementById('emptyState').classList.add('hidden');
  }
  var btn = document.getElementById('searchBtn');
  btn.disabled = on;
  btn.innerHTML = on
    ? '<i class="fas fa-spinner fa-spin"></i>検索中...'
    : '<i class="fas fa-search"></i>検索する';
}

function renderResults(data) {
  var bar = document.getElementById('resultsBar');
  bar.classList.add('visible');
  document.getElementById('resultCount').textContent = (data.total || 0).toLocaleString() + '件の物件';
  var cacheStr = data.cacheHit ? ' · キャッシュ' : '';
  document.getElementById('executionTime').textContent = (data.executionTimeMs || 0) + 'ms' + cacheStr;

  // Site summary
  var ss = document.getElementById('siteSummary');
  ss.innerHTML = (data.sites || []).filter(function(s){ return s.count > 0; }).map(function(s) {
    var site = SITES_DATA[s.siteId] || {};
    var color = site.color || '#64748b';
    var errIcon = s.status === 'error' ? ' ⚠️' : '';
    return '<span class="site-badge" style="background:' + color + '18;color:' + color + ';border:1.5px solid ' + color + '30">'
      + (site.logo || '') + ' ' + escHtml(site.name || s.siteId) + ': ' + s.count + errIcon + '</span>';
  }).join('');

  var container = document.getElementById('resultsContainer');
  container.className = 'prop-grid ' + (viewMode === 'grid' ? 'grid-3' : 'list-1');

  if (!data.properties || data.properties.length === 0) {
    document.getElementById('emptyState').classList.remove('hidden');
    container.innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  document.getElementById('emptyState').classList.add('hidden');
  container.innerHTML = data.properties.map(renderCard).join('');
  renderPagination(data);
}

function renderCard(p) {
  var site = SITES_DATA[p.siteId] || {};
  var color = site.color || '#64748b';
  var isSold = p.status === 'sold' || p.status === 'delisted';
  var priceStr = p.price ? p.price.toLocaleString() + '万円' : (p.priceText || '価格要相談');
  var prefName = PREF_DATA[p.prefecture] || '';

  // Detect "new" (scraped within last 3 days)
  var isNew = !isSold && p.scrapedAt && (Date.now() - new Date(p.scrapedAt).getTime()) < 3 * 86400000;

  var firstImgSrc = (p.imageKeys && p.imageKeys.length > 0)
    ? '/api/images/' + encodeURIComponent(p.imageKeys[0])
    : (p.thumbnailUrl || null);
  var imgContent = firstImgSrc
    ? '<img src="' + escAttr(firstImgSrc) + '" alt="' + escHtml(p.title) + '" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=prop-img-placeholder>\'+\'' + (site.logo || '🏠') + '\'+'\'</div>\'">'
    : '<div class="prop-img-placeholder">' + (site.logo || '🏠') + '</div>';

  var soldOverlay = isSold ? '<div class="prop-badge-sold">売却済</div>' : '';
  var newBadge = isNew ? '<div class="prop-badge-new">NEW</div>' : '';
  var yieldBadge = p.yieldRate ? '<div class="prop-yield-badge">' + p.yieldRate.toFixed(1) + '%</div>' : '';

  var stationStr = p.station ? '<i class="fas fa-train"></i>' + escHtml(p.station) + (p.stationMinutes ? ' 徒歩' + p.stationMinutes + '分' : '') : '';
  var typeLabel = formatType(p.propertyType);

  var specs = [];
  if (p.rooms) specs.push('<span class="prop-spec-item"><i class="fas fa-door-open"></i>' + escHtml(p.rooms) + '</span>');
  if (p.area) specs.push('<span class="prop-spec-item"><i class="fas fa-ruler-combined"></i>' + p.area + 'm²</span>');
  if (p.age !== null && p.age !== undefined) specs.push('<span class="prop-spec-item"><i class="fas fa-calendar-alt"></i>築' + p.age + '年</span>');
  if (p.floor) specs.push('<span class="prop-spec-item"><i class="fas fa-layer-group"></i>' + p.floor + '階</span>');

  return '<div class="prop-card' + (isSold ? ' sold' : '') + '" onclick="showDetail(\'' + escAttr(p.id) + '\')">'
    + '<div class="prop-img-wrap">' + imgContent
    + '<div class="prop-badge-site" style="background:' + color + '">' + (site.logo || '') + ' ' + escHtml(site.name || p.siteId) + '</div>'
    + (typeLabel ? '<div class="prop-badge-type">' + typeLabel + '</div>' : '')
    + newBadge + yieldBadge + soldOverlay
    + '</div>'
    + '<div class="prop-body">'
    + '<div class="prop-title">' + escHtml(p.title) + '</div>'
    + '<div class="prop-location"><i class="fas fa-map-marker-alt"></i>' + escHtml(prefName + ' ' + (p.city || '')) + (stationStr ? '<span style="margin-left:8px">' + stationStr + '</span>' : '') + '</div>'
    + '<div class="prop-price" style="color:' + (isSold ? 'var(--c-text3)' : color) + '">' + (isSold ? '<span style="font-size:14px;text-decoration:line-through">' : '') + escHtml(priceStr) + (isSold ? '</span>' : '') + '</div>'
    + '<div class="prop-specs">' + specs.join('') + '</div>'
    + '<div class="prop-footer">'
    + '<span style="font-size:11px;color:var(--c-text4)">' + formatDate(p.scrapedAt)
    + (p.sourceCount && p.sourceCount > 1 ? '<span class="prop-multi-source">📚 ' + p.sourceCount + '媒体</span>' : '')
    + '</span>'
    + (p.detailUrl ? '<a href="' + escAttr(p.detailUrl) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="prop-ext-link" style="background:' + color + '18;color:' + color + '">詳細 <i class="fas fa-external-link-alt"></i></a>' : '')
    + '</div>'
    + '</div>'
    + '</div>';
}

function formatType(t) {
  return { mansion:'マンション', kodate:'一戸建', tochi:'土地', chintai_mansion:'賃貸', chintai_ikkodate:'賃貸一戸建', jimusho:'事務所', investment:'投資', other:'その他' }[t] || '';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    return (d.getMonth()+1) + '/' + d.getDate() + ' 取得';
  } catch(e) { return ''; }
}

function renderPagination(data) {
  var el = document.getElementById('pagination');
  if (!data.totalPages || data.totalPages <= 1) { el.innerHTML = ''; return; }
  var cur = data.page, tot = data.totalPages;
  var html = '';
  if (cur > 1) html += '<button class="page-btn" onclick="doSearch(' + (cur-1) + ')"><i class="fas fa-chevron-left"></i></button>';
  for (var i = Math.max(1,cur-2); i <= Math.min(tot,cur+2); i++) {
    html += '<button class="page-btn' + (i===cur?' active':'') + '" onclick="doSearch(' + i + ')">' + i + '</button>';
  }
  if (cur < tot) html += '<button class="page-btn" onclick="doSearch(' + (cur+1) + ')"><i class="fas fa-chevron-right"></i></button>';
  el.innerHTML = html;
}

// ── Filter Chips ──
function renderFilterChips(query, pref, type, priceMin, priceMax, areaMin, areaMax, rooms, stationMin, ageMax, yieldMin, status) {
  var chips = [];
  if (query) chips.push({ label: '検索: ' + query });
  if (pref) chips.push({ label: PREF_DATA[pref] || pref });
  if (type) chips.push({ label: formatType(type) || type });
  if (priceMin || priceMax) chips.push({ label: '価格: ' + (priceMin||'-') + '〜' + (priceMax||'-') + '万円' });
  if (areaMin || areaMax) chips.push({ label: '面積: ' + (areaMin||'-') + '〜' + (areaMax||'-') + 'm²' });
  if (rooms) chips.push({ label: rooms });
  if (stationMin) chips.push({ label: '駅徒歩' + stationMin + '分以内' });
  if (ageMax) chips.push({ label: '築' + ageMax + '年以内' });
  if (yieldMin) chips.push({ label: '利回り' + yieldMin + '%以上' });
  if (status && status !== 'active') chips.push({ label: status === 'sold' ? '売却済' : '全ステータス' });
  document.getElementById('filterChips').innerHTML = chips.map(function(c) {
    return '<span class="filter-chip">' + escHtml(c.label) + '</span>';
  }).join('');
}

// ── Property Detail Modal ──
async function showDetail(id) {
  document.getElementById('propertyModal').classList.remove('hidden');
  document.getElementById('modalContent').innerHTML =
    '<div style="text-align:center;padding:40px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>';

  var prop = null;
  try {
    var r = await fetch('/api/properties/' + encodeURIComponent(id));
    if (r.ok) prop = await r.json();
  } catch(e) {}
  if (!prop && currentResults) {
    prop = (currentResults.properties || []).find(function(p) { return p.id === id; });
  }

  if (prop) renderModal(prop);
  else document.getElementById('modalContent').innerHTML =
    '<div style="padding:24px;text-align:center"><p>物件情報の取得に失敗しました</p><button onclick="closeModal()" class="search-btn" style="margin-top:16px">閉じる</button></div>';
}

function renderModal(p) {
  var site = SITES_DATA[p.siteId] || {};
  var color = site.color || '#64748b';
  var isSold = p.status === 'sold' || p.status === 'delisted';
  var priceStr = p.price ? p.price.toLocaleString() + '万円' : (p.priceText || '価格要相談');
  var prefName = PREF_DATA[p.prefecture] || '';

  // 画像ギャラリー（最大5枚）— R2 keys優先、fallback to images/thumbnailUrl
  var gallery = '';
  var galSrcs = [];
  if (p.imageKeys && p.imageKeys.length > 0) {
    galSrcs = p.imageKeys.slice(0, 5).map(function(k) { return '/api/images/' + encodeURIComponent(k); });
  } else if (p.images && p.images.length > 0) {
    galSrcs = p.images.slice(0, 5);
  } else if (p.thumbnailUrl) {
    galSrcs = [p.thumbnailUrl];
  }
  if (galSrcs.length > 0) {
    gallery = '<div class="img-gallery">'
      + galSrcs.map(function(src) {
          return '<img src="' + escAttr(src) + '" class="gallery-img" alt="物件画像" loading="lazy" onclick="openImg(\'' + escAttr(src) + '\')" onerror="this.style.display=\'none\'">';
        }).join('') + '</div>';
  }

  // 間取り図
  var floorPlanHtml = p.floorPlanUrl
    ? '<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;margin-bottom:6px">間取り図</div><img src="' + escAttr(p.floorPlanUrl) + '" class="floor-plan" alt="間取り図" loading="lazy" onerror="this.style.display=\'none\'"></div>'
    : '';

  // 費用・仕様情報
  var feeItems = [];
  if (p.managementFee) feeItems.push('管理費: ' + p.managementFee.toLocaleString() + '円/月');
  if (p.repairFund) feeItems.push('修繕積立: ' + p.repairFund.toLocaleString() + '円/月');
  if (p.direction) feeItems.push('向き: ' + p.direction);
  if (p.structure) feeItems.push('構造: ' + p.structure);
  var feesHtml = feeItems.length > 0
    ? '<div style="margin-bottom:12px;font-size:12px;color:var(--c-text3)">' + feeItems.map(function(f){ return escHtml(f); }).join(' / ') + '</div>'
    : '';

  var features = '';
  if (p.features && p.features.length > 0) {
    features = '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">設備・特徴</div>'
      + '<div class="features-wrap">' + p.features.map(function(f) { return '<span class="feature-tag">' + escHtml(f) + '</span>'; }).join('') + '</div></div>';
  }

  var details = [
    { label: '所在地', value: prefName + ' ' + (p.city || ''), sub: p.address },
    { label: 'アクセス', value: p.station || '-', sub: p.stationMinutes ? '徒歩' + p.stationMinutes + '分' : null },
    p.area ? { label: '面積', value: p.area + 'm²', sub: p.buildingArea && p.buildingArea !== p.area ? '建物: ' + p.buildingArea + 'm²' : null } : null,
    { label: '間取り', value: p.rooms || '-', sub: (p.age !== null && p.age !== undefined ? '築' + p.age + '年' : '') + (p.floor ? ' ' + p.floor + '階' : '') || null },
    p.yieldRate ? { label: '表面利回り', value: p.yieldRate.toFixed(2) + '%', sub: '投資物件' } : null,
    { label: 'ステータス', value: isSold ? '売却済' : '販売中', sub: p.soldAt ? p.soldAt.slice(0,10) + ' 売却' : null },
  ].filter(Boolean);

  var detailGrid = '<div class="detail-grid">' + details.map(function(d) {
    return '<div class="detail-item"><div class="detail-item-label">' + d.label + '</div><div class="detail-item-value">' + escHtml(d.value) + '</div>' + (d.sub ? '<div class="detail-item-sub">' + escHtml(d.sub) + '</div>' : '') + '</div>';
  }).join('') + '</div>';

  var desc = p.description ? '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;margin-bottom:6px">物件説明</div><p style="font-size:13px;color:var(--c-text2);line-height:1.7">' + escHtml(p.description) + '</p></div>' : '';

  document.getElementById('modalContent').innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">'
    + '<span class="prop-badge-site" style="position:static;background:' + color + ';font-size:12px">' + (site.logo||'') + ' ' + escHtml(site.name||p.siteId) + '</span>'
    + '<button class="modal-close" onclick="closeModal()">&times;</button></div>'
    + (isSold ? '<div class="sold-banner"><i class="fas fa-lock mr-2"></i>この物件は売却済みです</div>' : '')
    + gallery
    + '<h2 style="font-size:18px;font-weight:800;margin-bottom:8px">' + escHtml(p.title) + '</h2>'
    + '<div style="font-size:26px;font-weight:900;margin-bottom:8px;color:' + (isSold ? 'var(--c-text3)' : color) + '">' + (isSold ? '<span style="text-decoration:line-through">' : '') + escHtml(priceStr) + (isSold ? '</span>' : '') + '</div>'
    + feesHtml
    + detailGrid
    + floorPlanHtml
    + features
    + desc
    + buildSourcesSection(p)
    + '<div style="display:flex;gap:10px;margin-top:4px">'
    + (p.detailUrl ? '<a href="' + escAttr(p.detailUrl) + '" target="_blank" rel="noopener noreferrer" class="modal-cta" style="flex:1"><i class="fas fa-external-link-alt mr-2"></i>' + escHtml(site.name || 'サイト') + 'で詳細を見る</a>' : '')
    + '<button onclick="window.print()" class="btn-ghost" style="flex-shrink:0;padding:14px 20px;font-size:15px;font-weight:800;border-radius:10px" title="マイソク印刷"><i class="fas fa-print"></i> 印刷</button>'
    + '</div>';
}

function openImg(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function closeModal() { document.getElementById('propertyModal').classList.add('hidden'); }

function buildSourcesSection(p) {
  // p may have .sources (master search) or just siteId (legacy)
  if (!p.sources || p.sources.length === 0) return '';
  var rows = p.sources.map(function(s) {
    var site = SITES_DATA[s.siteId] || {};
    var priceStr = s.price ? s.price.toLocaleString() + '万円' : '-';
    var linkCell = s.detailUrl
      ? '<a href="' + escAttr(s.detailUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--c-primary);font-weight:700;font-size:11px">詳細 <i class="fas fa-external-link-alt"></i></a>'
      : '<span style="color:var(--c-text4)">-</span>';
    return '<tr><td><span class="prop-badge-site" style="position:static;background:' + (site.color||'#64748b') + ';font-size:10px;padding:2px 7px">' + (site.logo||'') + ' ' + escHtml(site.name||s.siteId) + '</span></td>'
      + '<td style="font-weight:700">' + escHtml(priceStr) + '</td>'
      + '<td>' + linkCell + '</td></tr>';
  }).join('');
  return '<div style="margin-bottom:16px">'
    + '<div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">📚 掲載媒体一覧 (' + p.sources.length + '件)</div>'
    + '<table class="sources-table"><thead><tr><th>サイト</th><th>掲載価格</th><th>リンク</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── Stats Modal ──
async function showStatsModal() {
  document.getElementById('statsModal').classList.remove('hidden');
  document.getElementById('statsContent').innerHTML =
    '<div style="text-align:center;padding:40px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>';
  try {
    var r = await fetch('/api/stats');
    if (!r.ok) throw new Error('');
    renderStats(await r.json());
  } catch(e) {
    document.getElementById('statsContent').innerHTML =
      '<p style="text-align:center;color:var(--c-text3);padding:24px">統計情報を取得できませんでした</p>';
  }
}

function renderStats(s) {
  var total = s.totalProperties || 0;
  var active = s.activeProperties || 0;
  var sold = s.soldProperties || 0;

  var bySite = (s.bysite || []).map(function(row) {
    var site = SITES_DATA[row.site_id] || {};
    var color = site.color || '#64748b';
    return '<div class="stat-row"><span style="color:' + color + ';font-weight:700">' + (site.logo||'') + ' ' + escHtml(site.name||row.site_id) + '</span><span style="font-weight:800">' + (row.cnt||0).toLocaleString() + '件</span></div>';
  }).join('');

  var byPref = (s.byPrefecture || []).map(function(row) {
    return '<div class="stat-row"><span>' + escHtml(PREF_DATA[row.prefecture]||row.prefecture) + '</span><span style="font-weight:700">' + (row.cnt||0).toLocaleString() + '件</span></div>';
  }).join('');

  var jobsHtml = (s.recentJobs || []).length > 0
    ? '<div style="margin-top:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;margin-bottom:8px">最近のスクレイプジョブ</div>'
      + (s.recentJobs || []).slice(0,5).map(function(job) {
          var st = job.status || 'unknown';
          var siteName = (SITES_DATA[job.site_id] || {}).name || job.site_id;
          return '<div class="job-row"><span class="job-status ' + st + '">' + st + '</span><span>' + escHtml(siteName) + '</span><span style="color:var(--c-text3)">' + (PREF_DATA[job.prefecture]||job.prefecture||'') + '</span><span style="color:var(--c-text4);margin-left:auto">' + (job.properties_found||0) + '件</span></div>';
        }).join('') + '</div>'
    : '';

  document.getElementById('statsContent').innerHTML =
    '<div class="stats-number">' + active.toLocaleString() + '</div>'
    + '<div class="stats-label">販売中物件数（売却済 ' + sold.toLocaleString() + ' 件 · 合計 ' + total.toLocaleString() + ' 件）</div>'
    + (bySite ? '<div style="margin-bottom:12px">' + bySite + '</div>' : '')
    + (byPref ? '<div><div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;margin-bottom:8px">都道府県 TOP10</div>' + byPref + '</div>' : '')
    + jobsHtml;
}

function closeStatsModal() { document.getElementById('statsModal').classList.add('hidden'); }

// ── View Toggle ──
function setView(mode) {
  viewMode = mode;
  document.getElementById('gridBtn').classList.toggle('active', mode === 'grid');
  document.getElementById('listBtn').classList.toggle('active', mode === 'list');
  if (currentResults) renderResults(currentResults);
}

// ── Clear ──
function clearSearch() {
  ['searchQuery','priceMin','priceMax','areaMin','areaMax','yieldMin'].forEach(function(id){ document.getElementById(id).value=''; });
  document.querySelectorAll('select').forEach(function(s){ s.selectedIndex=0; });
  toggleAllSites(true);
  updatePriceLabel(); updateAreaLabel();
  document.getElementById('resultsContainer').innerHTML = '';
  document.getElementById('pagination').innerHTML = '';
  document.getElementById('siteSummary').innerHTML = '';
  document.getElementById('filterChips').innerHTML = '';
  document.getElementById('resultsBar').classList.remove('visible');
  document.getElementById('initialState').classList.remove('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  currentResults = null;
}

// ── Label Updaters ──
function updatePriceLabel() {
  var mn = document.getElementById('priceMin').value, mx = document.getElementById('priceMax').value;
  document.getElementById('priceLabel').textContent = (mn||mx) ? (mn||'-')+'〜'+(mx||'-')+'万円' : '指定なし';
}
function updateAreaLabel() {
  var mn = document.getElementById('areaMin').value, mx = document.getElementById('areaMax').value;
  document.getElementById('areaLabel').textContent = (mn||mx) ? (mn||'-')+'〜'+(mx||'-')+'m²' : '指定なし';
}

// ── Error ──
function showError(msg) {
  document.getElementById('resultsContainer').classList.remove('hidden');
  document.getElementById('resultsContainer').innerHTML =
    '<div class="state-center" style="grid-column:1/-1">'
    + '<div class="state-icon">⚠️</div><div class="state-title">エラーが発生しました</div>'
    + '<div class="state-sub">' + msg + '</div>'
    + '<button onclick="doSearch()" class="search-btn">再試行</button></div>';
  document.getElementById('resultsBar').classList.add('visible');
  document.getElementById('resultCount').textContent = 'エラー';
}

// ── Autocomplete ──
var suggestTimer = null;
function onSearchInput() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(function() {
    var q = document.getElementById('searchQuery').value.trim();
    if (q.length < 2) return;
    fetch('/api/suggest?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(d) {
        var dl = document.getElementById('citySuggestions');
        dl.innerHTML = (d.suggestions||[]).map(function(s){ return '<option value="' + escAttr(s) + '">'; }).join('');
      }).catch(function(){});
  }, 300);
}

// ── Header Stats ──
function loadHeaderStats() {
  var KEY = 'mal_stats_v6', TTL = 5 * 60 * 1000;
  try {
    var c = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (c.ts && Date.now() - c.ts < TTL) {
      showHeaderStats(c.active, c.total);
      return;
    }
  } catch(e) {}
  fetch('/api/stats').then(function(r){ return r.json(); }).then(function(s) {
    var active = s.activeProperties || s.totalProperties || 0;
    var total = s.totalProperties || 0;
    showHeaderStats(active, total);
    try { localStorage.setItem(KEY, JSON.stringify({active:active,total:total,ts:Date.now()})); } catch(e) {}
  }).catch(function(){});
}
function showHeaderStats(active, total) {
  document.getElementById('totalCount').textContent = active.toLocaleString();
  var bar = document.getElementById('statsBar');
  bar.style.display = 'flex';
}

// ── Security helpers ──
function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s) {
  if (!s) return '#';
  var safe = String(s).replace(/&/g,'&amp;').replace(/[<>"'\`]/g,function(c){return ({'"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;','\`':'&#96;'})[c]||c;});
  return (/^https?:\\/\\//i.test(safe) || safe.startsWith('/') || safe === '#') ? safe : '#';
}

// ── CSV Export ──
function exportCSV() {
  var params = new URLSearchParams(window.location.search);
  var pref = params.get('prefecture') || document.getElementById('prefecture').value || '13';
  var url = '/api/admin/export.csv?prefecture=' + encodeURIComponent(pref) + '&status=active';
  window.location.href = url;
}

// ── Tab Switching ──
var currentTab = 'properties';
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabProperties').classList.toggle('active', tab === 'properties');
  document.getElementById('tabTransactions').classList.toggle('active', tab === 'transactions');

  var propEls = ['resultsBar', 'siteSummary', 'loadingState', 'resultsContainer', 'pagination', 'emptyState', 'initialState'];
  propEls.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (tab === 'properties') {
      el.dataset.tabHidden = '';
    } else {
      el.dataset.tabHidden = '1';
    }
    if (tab !== 'properties') {
      if (!el.classList.contains('hidden')) el.setAttribute('data-tab-visible', '1');
      el.classList.add('hidden');
    } else {
      if (el.getAttribute('data-tab-visible') === '1') {
        el.classList.remove('hidden');
        el.removeAttribute('data-tab-visible');
      }
    }
  });

  var txPanel = document.getElementById('transactionsPanel');
  txPanel.classList.toggle('hidden', tab !== 'transactions');

  if (tab === 'transactions') {
    var pref = document.getElementById('prefecture').value || '13';
    loadTransactions(pref);
  }
}

async function loadTransactions(prefecture) {
  var content = document.getElementById('transactionsContent');
  content.innerHTML = '<div style="text-align:center;padding:48px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>';
  try {
    var r = await fetch('/api/transactions?prefecture=' + encodeURIComponent(prefecture) + '&limit=50');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    renderTransactions(data.transactions || [], prefecture);
  } catch(e) {
    content.innerHTML = '<div style="text-align:center;padding:48px 0;color:var(--c-text3)">成約事例データを取得できませんでした</div>';
  }
}

function renderTransactions(rows, prefecture) {
  var content = document.getElementById('transactionsContent');
  var prefName = PREF_DATA[prefecture] || prefecture;
  if (!rows.length) {
    content.innerHTML = '<div style="text-align:center;padding:48px 0;color:var(--c-text3)">' + escHtml(prefName) + 'の成約事例はまだありません</div>';
    return;
  }
  var html = '<div style="margin-bottom:12px;font-size:13px;font-weight:700">' + escHtml(prefName) + ' 成約事例 ' + rows.length + '件</div>'
    + '<div style="overflow-x:auto"><table class="txn-table"><thead><tr>'
    + '<th>成約日</th><th>物件名</th><th>種別</th><th>成約価格</th><th>面積</th><th>所在地</th>'
    + '</tr></thead><tbody>'
    + rows.map(function(t) {
        var soldAt = t.sold_at ? String(t.sold_at).slice(0, 10) : '-';
        var price = t.price ? Number(t.price).toLocaleString() + '万円' : (t.price_text || '-');
        var area = t.area ? t.area + 'm²' : '-';
        return '<tr>'
          + '<td>' + escHtml(soldAt) + '</td>'
          + '<td>' + escHtml(t.title || '') + '</td>'
          + '<td>' + escHtml(t.property_type || '') + '</td>'
          + '<td style="font-weight:700;color:var(--c-primary)">' + escHtml(price) + '</td>'
          + '<td>' + escHtml(area) + '</td>'
          + '<td>' + escHtml((t.city || '') + (t.address ? ' ' + t.address : '')) + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  content.innerHTML = html;
}

// ── Init ──
(function() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeModal(); closeStatsModal(); }
  });
})();
</script>
</body>
</html>`;
}
