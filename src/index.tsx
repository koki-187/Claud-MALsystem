import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';
import type { Bindings, AppVariables } from './types';
import { searchProperties, getPropertyById, getStats, getStatsFederated, logSearch, searchMasters, searchPropertiesFederated, getPropertyByIdFederated, getReadDBs, getWriteDB, searchPropertiesForExport } from './db/queries';
import { aggregateSearch, runScheduledScrape } from './scrapers/aggregator';
import { PREFECTURES, SITES } from './types';
import { admin as adminRoutes } from './routes/admin';
import { processQueue } from './services/image-pipeline';
import { archiveOldestCold, purgeStaleMetadata } from './services/archive';
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

// P2 #9: /api/search/master も同等の D1 負荷をかけるので 60 req/min レート制限を追加。
// 旧: 無制限で叩けたため abuse → D1 過負荷リスクあり。バケット分離 (search-master:) で /api/search と独立カウント。
app.use('/api/search/master', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env.MAL_CACHE, `search-master:${ip}`, 60, 60);
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
    managementFeeMax: q.management_fee_max ? parseInt(q.management_fee_max) : undefined,
    repairFundMax: q.repair_fund_max ? parseInt(q.repair_fund_max) : undefined,
    direction: q.direction || undefined,
    structure: q.structure || undefined,
    sites: q.sites ? (q.sites.split(',') as any) : undefined,
    hideDuplicates: q.hide_duplicates === '1' ? true : (q.hide_duplicates === '0' ? false : undefined),
    sortBy: q.sort as any,
    page: q.page ? parseInt(q.page) : 1,
    limit: q.limit ? parseInt(q.limit) : 18,
  };

  try {
    const sortedQ = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const cacheKey = `search:${new URLSearchParams(sortedQ as Record<string, string>).toString()}`;
    const cached = await c.env.MAL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) return c.json({ ...(cached as object), cacheHit: true });

    const dbResult = await searchPropertiesFederated(c.env, params).catch(() => null);
    if (dbResult && dbResult.total > 0) {
      await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(dbResult), { expirationTtl: 3600 }).catch(() => {});
      logSearch(c.env.MAL_DB, params, dbResult.total, Date.now() - startTime).catch(() => {});
      return c.json(dbResult);
    }

    // フォールバック判定: 対象県に物件データが存在しない場合のみライブスクレイプ。
    // 条件を絞りすぎた検索 (例: 築1年以内+利回り12%以上) でDBが0件を返しても、
    // 県データが存在するなら空結果をそのまま返す (不要なスクレイプを防ぐ)。
    if (params.prefecture) {
      const dbs = getReadDBs(c.env);
      const hasDataResults = await Promise.all(
        dbs.map(db => db
          .prepare("SELECT 1 FROM properties WHERE prefecture = ? AND status = 'active' LIMIT 1")
          .bind(params.prefecture)
          .first()
          .catch(() => null)
        )
      );
      const hasData = hasDataResults.some(Boolean);
      if (hasData) {
        // 県データはあるがフィルター条件に一致なし → 空結果を返す
        const emptyResult = {
          properties: [], total: 0, page: params.page ?? 1, limit: params.limit ?? 18,
          totalPages: 0, sites: [], executionTimeMs: Date.now() - startTime, cacheHit: false,
        };
        logSearch(c.env.MAL_DB, params, 0, Date.now() - startTime).catch(() => {});
        return c.json(emptyResult);
      }
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
    const property = await getPropertyByIdFederated(c.env, id);
    if (!property) return c.json({ error: 'Property not found' }, 404);
    return c.json(property);
  } catch (error) {
    console.error('[/api/properties/:id] error:', error);
    return c.json({ error: 'Failed to fetch property' }, 500);
  }
});

app.get('/api/stats', async (c) => {
  try {
    const stats = await getStatsFederated(c.env);
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
    // Sort params for stable cache key (same as /api/search)
    const sortedQ = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const cacheKey = `master:${new URLSearchParams(sortedQ as Record<string, string>).toString()}`;
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

// /api/scrape/status は admin ルートに移動済み (admin.ts で定義)


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
  if (!q || q.length < 2) return c.json({ suggestions: [] });
  try {
    const like = `%${q}%`;
    const dbs = getReadDBs(c.env);
    const suggestResults = await Promise.all(dbs.map(db => Promise.all([
      db.prepare("SELECT DISTINCT city as val FROM properties WHERE city LIKE ? AND status='active' LIMIT 7")
        .bind(like).all<{ val: string }>().catch(() => ({ results: [] as { val: string }[] })),
      db.prepare("SELECT DISTINCT station as val FROM properties WHERE station LIKE ? AND status='active' AND station IS NOT NULL LIMIT 5")
        .bind(like).all<{ val: string }>().catch(() => ({ results: [] as { val: string }[] })),
    ])));
    const suggestions = Array.from(new Set(
      suggestResults.flatMap(([cities, stations]) => [
        ...(cities.results ?? []).map(r => r.val),
        ...(stations.results ?? []).map(r => r.val),
      ])
    )).filter(Boolean).slice(0, 12);
    return c.json({ suggestions });
  } catch {
    return c.json({ suggestions: [] });
  }
});

// R2 image delivery
app.get('/api/images/*', async (c) => {
  const rawKey = c.req.path.replace('/api/images/', '');
  if (!rawKey) return c.notFound();
  // パストラバーサル防御: '..', 先頭スラッシュ, NUL, デコード後のパス分離を全て拒否
  // URL デコードしたうえで判定 (例: %2e%2e で .. を表現する攻撃をブロック)
  let key: string;
  try { key = decodeURIComponent(rawKey); } catch { return c.notFound(); }
  if (
    key.includes('..') ||
    key.startsWith('/') ||
    key.startsWith('\\') ||
    key.includes('\0') ||
    key.includes('://')
  ) return c.notFound();
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
// CSV Export
// =====================
app.get('/api/export/csv', async (c) => {
  const q = c.req.query();
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
    managementFeeMax: q.management_fee_max ? parseInt(q.management_fee_max) : undefined,
    repairFundMax: q.repair_fund_max ? parseInt(q.repair_fund_max) : undefined,
    direction: q.direction || undefined,
    structure: q.structure || undefined,
    sites: q.sites ? (q.sites.split(',') as any) : undefined,
    hideDuplicates: q.hide_duplicates === '1' ? true : (q.hide_duplicates === '0' ? false : undefined),
    sortBy: q.sort as any,
    limit: q.limit ? parseInt(q.limit) : 10000,
  };

  try {
    const properties = await searchPropertiesForExport(c.env, params);

    const CSV_COLUMNS = [
      'id', 'site_id', 'title', 'property_type', 'prefecture', 'city', 'address',
      'price', 'price_text', 'area', 'rooms', 'age', 'station', 'station_minutes',
      'detail_url', 'status', 'scraped_at',
    ] as const;

    const escapeCell = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // RFC 4180: フィールドにカンマ・ダブルクォート・改行が含まれる場合はダブルクォートで囲む
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header = CSV_COLUMNS.join(',');
    const rows = properties.map(p => [
      p.id, p.siteId, p.title, p.propertyType, p.prefecture, p.city, p.address,
      p.price, p.priceText, p.area, p.rooms, p.age, p.station, p.stationMinutes,
      p.detailUrl, p.status, p.scrapedAt,
    ].map(escapeCell).join(','));

    // BOM + header + rows
    const bom = '﻿';
    const csv = bom + [header, ...rows].join('\r\n');

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8-sig',
        'Content-Disposition': `attachment; filename="mal_export_${today}.csv"`,
      },
    });
  } catch (error) {
    console.error('[/api/export/csv] error:', error);
    return c.json({ error: 'Export failed' }, 500);
  }
});

// =====================
// Saved Searches (KV)
// =====================
app.post('/api/saved-searches', async (c) => {
  try {
    const body = await c.req.json<{ name: string; params: Record<string, unknown> }>();
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    const id = crypto.randomUUID();
    const entry = { id, name: body.name.trim(), params: body.params ?? {}, createdAt: new Date().toISOString() };

    // Save the entry
    await c.env.MAL_CACHE.put(`saved_search:${id}`, JSON.stringify(entry));

    // Update index
    const indexRaw = await c.env.MAL_CACHE.get('saved_searches:index', 'json').catch(() => null);
    const index: string[] = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
    index.push(id);
    await c.env.MAL_CACHE.put('saved_searches:index', JSON.stringify(index));

    return c.json(entry, 201);
  } catch (error) {
    console.error('[POST /api/saved-searches] error:', error);
    return c.json({ error: 'Failed to save search' }, 500);
  }
});

app.get('/api/saved-searches', async (c) => {
  try {
    const indexRaw = await c.env.MAL_CACHE.get('saved_searches:index', 'json').catch(() => null);
    const index: string[] = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];

    const entries = await Promise.all(
      index.map(id => c.env.MAL_CACHE.get(`saved_search:${id}`, 'json').catch(() => null))
    );
    const searches = entries.filter(Boolean);
    return c.json({ searches });
  } catch (error) {
    console.error('[GET /api/saved-searches] error:', error);
    return c.json({ error: 'Failed to list saved searches' }, 500);
  }
});

app.delete('/api/saved-searches/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await c.env.MAL_CACHE.delete(`saved_search:${id}`);

    // Remove from index
    const indexRaw = await c.env.MAL_CACHE.get('saved_searches:index', 'json').catch(() => null);
    const index: string[] = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
    const newIndex = index.filter(i => i !== id);
    await c.env.MAL_CACHE.put('saved_searches:index', JSON.stringify(newIndex));

    return c.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/saved-searches/:id] error:', error);
    return c.json({ error: 'Failed to delete saved search' }, 500);
  }
});

// =====================
// Admin Routes (Bearer token認証必須)
// =====================
// 定数時間比較 (Web Crypto ベース。Workers ランタイム互換)
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  // 異なる長さでも常に同じ計算量を払うため、両方を SHA-256 でハッシュしてから XOR 比較
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(ha), ub = new Uint8Array(hb);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

app.use('/api/admin/*', async (c, next) => {
  const expected = c.env.ADMIN_SECRET;
  if (!expected) {
    return c.json({ error: 'Admin API disabled: ADMIN_SECRET not configured' }, 503);
  }
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await timingSafeEqualStr(provided, expected))) {
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
  const scheduledDate = new Date(event.scheduledTime);
  const hour = scheduledDate.getUTCHours();

  // ── Daily cleanup: UTC 15:00 (JST 00:00) — 既存 cron に統合 (free tier 5 cron 上限) ─
  if (hour === 15) {
    ctx.waitUntil((async () => {
      try {
        // 1. Purge stale metadata rows (logs, queue, imports)
        const purged = await purgeStaleMetadata(env.MAL_DB);
        console.log('[daily-cleanup] purgeStaleMetadata:', JSON.stringify(purged));

        // 2. Archive cold properties older than 30 days
        const archived = await archiveOldestCold(env, 5, 2000, 30);
        console.log(`[daily-cleanup] archiveOldestCold: archived=${archived.archived} deleted=${archived.deleted} keys=${archived.r2Keys.length}`);

        // 3. 掲載落ち自動検知: last_seen_at が 30日以上前の active 物件を delisted に変更
        // DB1 は 500MB 超過で UPDATE 不可のため DB2 (writeDb) のみ対象
        try {
          const writeDb = getWriteDB(env);
          const staleResult = await writeDb.prepare(`
            UPDATE properties SET status = 'delisted', updated_at = datetime('now')
            WHERE status = 'active'
              AND last_seen_at IS NOT NULL
              AND last_seen_at < datetime('now', '-30 days')
          `).run();
          const staleCount = (staleResult.meta?.changes as number | undefined) ?? 0;
          if (staleCount > 0) {
            console.log(`[daily-cleanup] mark-delisted: ${staleCount}件を掲載落ちとしてマーク`);
          }
        } catch (staleErr) {
          console.warn('[daily-cleanup] mark-delisted error:', staleErr);
        }

        // 4. スタックしたscrape_jobs を自動クリーンアップ (30分以上 running のまま)
        try {
          const writeDb = getWriteDB(env);
          const stuckResult = await writeDb.prepare(`
            UPDATE scrape_jobs SET status = 'failed',
              error_message = 'timeout_cleanup: auto-failed by scheduler',
              completed_at = datetime('now')
            WHERE status = 'running'
              AND started_at < datetime('now', '-30 minutes')
          `).run();
          const stuckCount = (stuckResult.meta?.changes as number | undefined) ?? 0;
          if (stuckCount > 0) {
            console.log(`[daily-cleanup] stuck-jobs-cleanup: ${stuckCount}件をfailedに更新`);
          }
        } catch (stuckErr) {
          console.warn('[daily-cleanup] stuck-jobs-cleanup error:', stuckErr);
        }

        // 5. VACUUM on the 1st of each month (best-effort; may exceed 30s CPU limit)
        if (scheduledDate.getUTCDate() === 1) {
          try {
            await env.MAL_DB.exec('VACUUM');
            console.log('[daily-cleanup] VACUUM completed');
          } catch (vacuumErr) {
            console.warn('[daily-cleanup] VACUUM failed (CPU limit or unsupported):', vacuumErr);
          }
        }
      } catch (e) {
        console.error('[daily-cleanup] error:', e);
      }
    })());
    // Also run master-builder and capacity check on this hour (fall through below)
  }

  if (hour === 4) {
    // 画像ダウンロードキュー処理 (UTC 4時 = JST 13時) — 大バッチ
    // ADMIN_SECRET 未設定でも動くよう HTTP self-call をやめ直接関数呼び出しに変更
    ctx.waitUntil(processQueue(env, 500).catch(console.error));
  } else {
    ctx.waitUntil(runScheduledScrape(env));
    // 毎時 (UTC 4時以外): 画像キューを最大50件処理
    // hour===4 のとき同時走行すると download_queue で同一行を二重処理してR2書き込み競合するため除外
    ctx.waitUntil(processQueue(env, 50).catch(console.error));
  }
  // 毎時: 未リンク properties を master_properties に変換 (最大5000件)
  ctx.waitUntil(buildMasters(env, 5000).then(r => {
    if (r.created + r.updated > 0) {
      console.log(`[master-builder] created=${r.created} updated=${r.updated} linked=${r.linked}`);
    }
  }).catch(console.error));
  // D1容量監視: free tier 500MB の 80% (400MB) 超で自動アーカイブ
  // PRAGMA page_count × page_size で実サイズを取得。失敗時は行数 × 635B の概算にフォールバック。
  ctx.waitUntil((async () => {
    try {
      let mb = 0;
      let source = 'pragma';
      try {
        const pc = await env.MAL_DB.prepare('PRAGMA page_count').first<{ page_count: number }>();
        const ps = await env.MAL_DB.prepare('PRAGMA page_size').first<{ page_size: number }>();
        if (pc?.page_count && ps?.page_size) {
          mb = (pc.page_count * ps.page_size) / 1024 / 1024;
        }
      } catch (pragmaErr) {
        console.warn('[D1-CAPACITY] PRAGMA failed, falling back to row-count estimate:', pragmaErr);
      }
      if (mb === 0) {
        // フォールバック: 1行 ≈ 635 バイトの概算 (admin.ts と同じ係数)
        const cap = await env.MAL_DB.prepare('SELECT COUNT(*) AS n FROM properties').first<{ n: number }>();
        mb = ((cap?.n ?? 0) * 635) / 1024 / 1024;
        source = 'estimated';
      }
      if (mb >= 400) {
        console.error(`[D1-CAPACITY-ALERT] ${mb.toFixed(0)}MB >= 400MB (80% of 500MB free tier, source=${source}) — starting auto-archive`);
        const result = await archiveOldestCold(env, 5, 2000, 30);
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
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.min.css" crossorigin="anonymous">
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
@media(max-width:600px) { .prop-grid.list-1 .prop-card { flex-direction: column; } .prop-grid.list-1 .prop-img-wrap { width: 100%; min-height: 80px; max-height: 120px; } }

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

/* ==========================================
   v6.2 — UX 改善 (可読性 / ツールチップ / ウェルカム)
   ========================================== */

/* ── 可読性: ラベル類の底上げ (11px → 12-13px), uppercase 撤去 ── */
.field-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-text2);     /* 11px時より濃い色でコントラスト確保 */
  letter-spacing: 0;          /* uppercase 風の字間を撤去 */
  text-transform: none;       /* 日本語UIの可読性優先 */
  margin-bottom: 6px;
}
.sites-label {
  font-size: 13px;
  color: var(--c-text2);
  letter-spacing: 0;
  text-transform: none;
}
.sort-label,
.results-time,
.logo-sub,
.range-sep {
  font-size: 12px;
}
.results-time { color: var(--c-text2); }
.chip-label { font-size: 13px; }
.sites-toggle-btn { font-size: 12px; }

/* prefers-color-scheme で OS 設定に追従 (ユーザーが明示切替済なら data-theme 優先) */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {
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
}

/* ── ツールチップ (専門用語の説明) ── */
.term-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: var(--c-bg2);
  color: var(--c-text3);
  font-size: 11px;
  font-weight: 700;
  cursor: help;
  margin-left: 4px;
  border: 1px solid var(--c-border);
  position: relative;
  vertical-align: middle;
}
.term-help:hover, .term-help:focus {
  background: var(--c-primary);
  color: #fff;
  border-color: var(--c-primary);
}
.term-help[data-tip]:hover::after,
.term-help[data-tip]:focus::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 12px;
  background: var(--c-text);
  color: var(--c-bg);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  border-radius: 8px;
  white-space: pre-wrap;
  width: max-content;
  max-width: 280px;
  z-index: 1000;
  box-shadow: var(--shadow-md);
  pointer-events: none;
}
.term-help[data-tip]:hover::before,
.term-help[data-tip]:focus::before {
  content: '';
  position: absolute;
  bottom: calc(100% + 2px);
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: var(--c-text);
  z-index: 1000;
  pointer-events: none;
}

/* ── ウェルカムガイド モーダル ── */
.welcome-overlay {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, .55);
  backdrop-filter: blur(4px);
  z-index: 9999;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.welcome-overlay.active { display: flex; }
.welcome-card {
  background: var(--c-surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  max-width: 540px;
  width: 100%;
  padding: 28px 28px 22px;
  position: relative;
  animation: welcomeIn .25s ease-out;
}
@keyframes welcomeIn {
  from { opacity: 0; transform: translateY(12px) scale(.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.welcome-title {
  font-size: 22px;
  font-weight: 900;
  margin-bottom: 6px;
  background: linear-gradient(135deg, var(--c-primary), var(--c-accent));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.welcome-sub {
  font-size: 13px;
  color: var(--c-text3);
  margin-bottom: 18px;
}
.welcome-step {
  display: flex;
  gap: 14px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: var(--c-bg2);
  border-radius: var(--radius-sm);
  align-items: flex-start;
}
.welcome-step-num {
  flex-shrink: 0;
  width: 28px; height: 28px;
  border-radius: 50%;
  background: var(--c-primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 13px;
}
.welcome-step-body { flex: 1; }
.welcome-step-title { font-size: 14px; font-weight: 700; margin-bottom: 2px; }
.welcome-step-desc { font-size: 12px; color: var(--c-text2); line-height: 1.55; }
.welcome-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  align-items: center;
}
.welcome-actions .actions-spacer { flex: 1; }
.welcome-skip {
  font-size: 12px;
  color: var(--c-text3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.welcome-skip input { width: 14px; height: 14px; cursor: pointer; }
.welcome-cta {
  padding: 10px 22px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--c-primary), var(--c-accent));
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
  border: none;
}

/* ── Search Mode Tabs ── */
.mode-tabs {
  display: flex; gap: 0; margin-bottom: 20px;
  background: var(--c-bg2); border-radius: 12px; padding: 4px;
  border: 1px solid var(--c-border);
}
.mode-tab {
  flex: 1; padding: 10px 0; border-radius: 9px;
  font-size: 14px; font-weight: 700; color: var(--c-text3);
  background: none; border: none; cursor: pointer;
  transition: all var(--transition);
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.mode-tab.active {
  background: var(--c-surface); color: var(--c-primary);
  box-shadow: var(--shadow-sm); border: 1px solid var(--c-border);
}
.mode-tab:hover:not(.active) { color: var(--c-text2); }

/* ── Preset Quick Chips ── */
.preset-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.preset-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 13px; border-radius: 20px;
  background: var(--c-bg2); border: 1.5px solid var(--c-border);
  font-size: 12px; font-weight: 700; color: var(--c-text2);
  cursor: pointer; transition: all var(--transition); white-space: nowrap;
}
.preset-chip:hover { border-color: var(--c-primary); color: var(--c-primary); background: rgba(37,99,235,.07); }
.preset-chip.active { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }

/* ── Buy Type Chips ── */
.type-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.type-chip-lbl { display: inline-flex; align-items: center; }
.type-chip-lbl input[type="radio"] { display: none; }
.type-chip-lbl span {
  padding: 6px 14px; border-radius: 20px;
  border: 1.5px solid var(--c-border); background: var(--c-bg);
  font-size: 13px; font-weight: 600; color: var(--c-text2);
  cursor: pointer; transition: all var(--transition); user-select: none;
}
.type-chip-lbl input:checked + span { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }
.type-chip-lbl span:hover { border-color: var(--c-primary); color: var(--c-primary); }

/* ── Multi Rooms Dropdown ── */
.rooms-wrap { position: relative; }
.rooms-btn {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; text-align: left;
}
.rooms-chevron { font-size: 11px; color: var(--c-text4); transition: transform var(--transition); }
.rooms-popup {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  background: var(--c-surface); border: 1.5px solid var(--c-border);
  border-radius: var(--radius-sm); z-index: 50; padding: 10px;
  box-shadow: var(--shadow-md);
  display: grid; grid-template-columns: repeat(3,1fr); gap: 4px;
}
.rooms-popup label {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--c-text2);
  transition: background var(--transition);
}
.rooms-popup label:hover { background: var(--c-bg2); }
.rooms-popup input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--c-primary); }

/* ── Invest Type Chips ── */
.invest-type-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.invest-type-lbl { display: inline-flex; align-items: center; }
.invest-type-lbl input { display: none; }
.invest-type-lbl span {
  padding: 6px 14px; border-radius: 20px;
  border: 1.5px solid var(--c-border); background: var(--c-bg);
  font-size: 13px; font-weight: 600; color: var(--c-text2);
  cursor: pointer; transition: all var(--transition); user-select: none;
}
.invest-type-lbl input:checked + span { background: #dc2626; border-color: #dc2626; color: #fff; }
.invest-type-lbl span:hover { border-color: #dc2626; color: #dc2626; }

/* ── Sites Accordion ── */
.sites-accordion { margin-top: 16px; }
.sites-accordion summary {
  list-style: none; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: var(--radius-sm);
  background: var(--c-bg2); border: 1px solid var(--c-border);
  font-size: 13px; font-weight: 700; color: var(--c-text2);
  user-select: none; transition: all var(--transition);
}
.sites-accordion summary:hover { border-color: var(--c-primary); color: var(--c-primary); }
.sites-accordion summary::-webkit-details-marker { display: none; }
.sites-accordion[open] summary {
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border-bottom-color: transparent; background: var(--c-surface);
}
.sites-accordion-body {
  padding: 12px 14px; border: 1px solid var(--c-border);
  border-top: none; border-radius: 0 0 var(--radius-sm) var(--radius-sm);
}
.accordion-arrow { margin-left: auto; font-size: 11px; color: var(--c-text4); transition: transform var(--transition); }
details[open] .accordion-arrow { transform: rotate(180deg); }

/* ── Sort in Results Bar ── */
.results-sort { display: flex; align-items: center; gap: 6px; }
.results-sort-lbl { font-size: 12px; font-weight: 700; color: var(--c-text3); white-space: nowrap; }
.results-sort select {
  padding: 5px 10px; border-radius: 8px;
  border: 1.5px solid var(--c-border); background: var(--c-surface);
  font: inherit; font-size: 12px; color: var(--c-text);
}

/* ── Snackbar ── */
.snackbar {
  position: fixed; bottom: 24px; left: 50%;
  transform: translateX(-50%) translateY(120px);
  background: var(--c-text); color: var(--c-bg);
  padding: 12px 20px; border-radius: 10px;
  font-size: 13px; font-weight: 700;
  display: flex; align-items: center; gap: 12px;
  box-shadow: var(--shadow-lg); z-index: 9998;
  transition: transform .28s cubic-bezier(.34,1.56,.64,1);
  white-space: nowrap; pointer-events: none;
}
.snackbar.visible { transform: translateX(-50%) translateY(0); pointer-events: auto; }
.snackbar-undo { color: #60a5fa; cursor: pointer; font-weight: 800; padding: 0 4px; }

/* ── Field Error ── */
.field-input.has-error { border-color: var(--c-danger) !important; }
.field-error { font-size: 11px; color: var(--c-danger); margin-top: 3px; font-weight: 600; }

/* ── Map View ── */
.leaflet-popup-content-wrapper { border-radius: 10px !important; box-shadow: var(--shadow-md) !important; }
.map-popup-title { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
.map-popup-price { font-size: 15px; font-weight: 900; color: var(--c-primary); }
.map-popup-spec { font-size: 11px; color: #64748b; margin-top: 2px; }
.map-popup-link { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 700; color: var(--c-primary); }

/* ── Price History Mini Chart ── */
.price-history-chart {
  display: flex; align-items: flex-end; gap: 3px;
  height: 48px; margin: 8px 0 4px;
}
.price-bar {
  flex: 1; min-width: 6px;
  background: var(--c-primary);
  border-radius: 3px 3px 0 0;
  opacity: .75; cursor: pointer;
  transition: opacity var(--transition);
  position: relative;
}
.price-bar:hover { opacity: 1; }
.price-bar-tip {
  position: absolute; bottom: calc(100% + 4px); left: 50%;
  transform: translateX(-50%);
  background: var(--c-text); color: var(--c-bg);
  font-size: 10px; font-weight: 700;
  padding: 3px 6px; border-radius: 4px;
  white-space: nowrap; display: none; z-index: 10;
}
.price-bar:hover .price-bar-tip { display: block; }

/* ── Favorites ── */
.fav-btn {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--c-surface); border: 1.5px solid var(--c-border);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; cursor: pointer;
  transition: all var(--transition); flex-shrink: 0;
}
.fav-btn:hover { border-color: #e11d48; background: #fff0f3; }
.fav-btn.active { background: #e11d48; border-color: #e11d48; color: #fff; }

/* ── Scroll To Top ── */
.scroll-top-btn {
  position: fixed; bottom: 80px; right: 20px; z-index: 500;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--c-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; box-shadow: var(--shadow-md);
  opacity: 0; pointer-events: none;
  transition: opacity var(--transition), transform var(--transition);
}
.scroll-top-btn.visible { opacity: 1; pointer-events: auto; }
.scroll-top-btn:hover { transform: translateY(-3px); }

/* ==========================================
   v6.3 — Enhanced Property Detail Modal
   ========================================== */

/* ── Image Slider ── */
.img-slider-wrap {
  position: relative; margin-bottom: 20px;
  border-radius: var(--radius); overflow: hidden;
  background: var(--c-bg2);
}
.img-slider-track {
  display: flex; overflow-x: auto; scroll-snap-type: x mandatory;
  scrollbar-width: none; -ms-overflow-style: none;
  scroll-behavior: smooth;
}
.img-slider-track::-webkit-scrollbar { display: none; }
.img-slider-slide {
  flex: 0 0 100%; height: 320px; scroll-snap-align: start;
  position: relative;
}
.img-slider-slide img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.img-slider-placeholder {
  width: 100%; height: 320px; display: flex; align-items: center; justify-content: center;
  font-size: 80px; background: var(--c-bg2);
}
.img-slider-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(0,0,0,.5); color: #fff; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background .15s; z-index: 5;
  border: none;
}
.img-slider-nav:hover { background: rgba(0,0,0,.75); }
.img-slider-prev { left: 10px; }
.img-slider-next { right: 10px; }
.img-slider-dots {
  position: absolute; bottom: 10px; left: 0; right: 0;
  display: flex; justify-content: center; gap: 5px;
}
.img-slider-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(255,255,255,.5); cursor: pointer;
  transition: background .15s, transform .15s;
  border: none; padding: 0;
}
.img-slider-dot.active { background: #fff; transform: scale(1.3); }
.img-slider-count {
  position: absolute; top: 10px; right: 10px;
  background: rgba(0,0,0,.5); color: #fff;
  font-size: 11px; font-weight: 700;
  padding: 3px 8px; border-radius: 20px;
}
@media(max-width:600px) {
  .img-slider-slide { height: 220px; }
  .img-slider-placeholder { height: 220px; }
}

/* ── Spec Badge Row ── */
.spec-badges {
  display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px;
}
.spec-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: 20px;
  background: var(--c-bg2); border: 1.5px solid var(--c-border);
  font-size: 13px; font-weight: 700; color: var(--c-text2);
}
.spec-badge i { color: var(--c-primary); font-size: 12px; }
.spec-badge.highlight {
  background: rgba(37,99,235,.08); border-color: rgba(37,99,235,.3);
  color: var(--c-primary);
}

/* ── Payment Simulator ── */
.sim-section {
  background: var(--c-bg2); border: 1px solid var(--c-border);
  border-radius: var(--radius); padding: 16px; margin-bottom: 20px;
}
.sim-title {
  font-size: 13px; font-weight: 800; color: var(--c-text2);
  display: flex; align-items: center; gap: 6px; margin-bottom: 0;
  cursor: pointer; user-select: none;
}
.sim-title i { color: var(--c-primary); }
.sim-toggle-icon { margin-left: auto; color: var(--c-text4); font-size: 11px; transition: transform .18s; }
.sim-body { display: none; padding-top: 14px; }
.sim-body.open { display: block; }
.sim-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px;
}
@media(max-width:480px) { .sim-grid { grid-template-columns: 1fr; } }
.sim-field { display: flex; flex-direction: column; gap: 4px; }
.sim-label {
  font-size: 11px; font-weight: 700; color: var(--c-text3);
}
.sim-input {
  padding: 7px 10px; border-radius: 8px;
  border: 1.5px solid var(--c-border); background: var(--c-surface);
  color: var(--c-text); font-size: 13px;
  transition: border-color .15s;
}
.sim-input:focus { border-color: var(--c-primary); outline: none; }
.sim-result {
  background: var(--c-surface); border: 2px solid var(--c-primary);
  border-radius: var(--radius-sm); padding: 14px 16px;
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
}
.sim-result-left { flex: 1; }
.sim-result-label { font-size: 12px; font-weight: 700; color: var(--c-text3); }
.sim-result-value { font-size: 24px; font-weight: 900; color: var(--c-primary); }
.sim-result-detail { font-size: 11px; color: var(--c-text4); margin-top: 2px; }
.sim-note { font-size: 10px; color: var(--c-text4); margin-top: 8px; }

/* ── Detail Table ── */
.detail-table {
  width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px;
}
.detail-table tr { border-bottom: 1px solid var(--c-border); }
.detail-table tr:last-child { border-bottom: none; }
.detail-table th {
  width: 36%; padding: 8px 12px; background: var(--c-bg2);
  font-size: 11px; font-weight: 700; color: var(--c-text3);
  text-align: left; vertical-align: top;
}
.detail-table td {
  padding: 8px 12px; color: var(--c-text); vertical-align: top;
  word-break: break-all;
}

/* ── Modal Actions ── */
.modal-actions {
  display: flex; gap: 10px; margin-top: 4px; flex-wrap: wrap;
}
.btn-map {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 12px 18px; border-radius: 10px;
  background: var(--c-bg2); border: 1.5px solid var(--c-border);
  color: var(--c-text2); font-size: 14px; font-weight: 700;
  cursor: pointer; transition: all .18s; text-decoration: none;
  flex-shrink: 0;
}
.btn-map:hover { border-color: var(--c-primary); color: var(--c-primary); background: rgba(37,99,235,.06); }

/* ── Header favorites badge ── */
.fav-header-btn { position: relative; }
.fav-count-badge {
  position: absolute; top: -4px; right: -4px;
  background: #e11d48; color: #fff;
  font-size: 9px; font-weight: 800;
  min-width: 16px; height: 16px; border-radius: 8px;
  padding: 0 3px;
  display: none; align-items: center; justify-content: center;
  line-height: 1;
}
.fav-count-badge.visible { display: flex; }

  </style>
</head>
<body class="page-wrap">

<!-- =================== WELCOME GUIDE (初回訪問時のみ表示) =================== -->
<div class="welcome-overlay" id="welcomeOverlay" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle">
  <div class="welcome-card">
    <div class="welcome-title" id="welcomeTitle">🌎 MAL へようこそ</div>
    <div class="welcome-sub">47都道府県・9サイト横断の不動産検索ツールです。3 ステップで使い始められます。</div>

    <div class="welcome-step">
      <div class="welcome-step-num">1</div>
      <div class="welcome-step-body">
        <div class="welcome-step-title">価格 と 都道府県 だけ入れて検索</div>
        <div class="welcome-step-desc">最低限この 2 つでOK。他は空のままで大丈夫です。検索バーの「<kbd>/</kbd>」キーでフォーカスできます。</div>
      </div>
    </div>

    <div class="welcome-step">
      <div class="welcome-step-num">2</div>
      <div class="welcome-step-body">
        <div class="welcome-step-title">サイトを絞り込むと速い</div>
        <div class="welcome-step-desc">9サイト全部チェックすると重くなることがあります。3〜5 サイトに絞ると体感が速くなります。</div>
      </div>
    </div>

    <div class="welcome-step">
      <div class="welcome-step-num">3</div>
      <div class="welcome-step-body">
        <div class="welcome-step-title">専門用語は <span class="term-help" data-tip="このアイコン">?</span> マークでヘルプ</div>
        <div class="welcome-step-desc">「利回り」「成約事例」「マイソク」など、項目横の <strong>?</strong> をクリック/フォーカスすると意味が出ます。</div>
      </div>
    </div>

    <div class="welcome-actions">
      <label class="welcome-skip">
        <input type="checkbox" id="welcomeDontShow">
        次回から表示しない
      </label>
      <div class="actions-spacer"></div>
      <button class="welcome-cta" onclick="closeWelcome(document.getElementById('welcomeDontShow').checked)">はじめる</button>
    </div>
  </div>
</div>

<!-- =================== HEADER =================== -->
<header class="header">
  <div class="header-inner">
    <div class="logo">
      <span class="logo-icon">🌎</span>
      <div>
        <div class="logo-text">MAL</div>
        <div class="logo-sub">不動産一括検索 v6.3</div>
      </div>
    </div>
    <div class="header-spacer"></div>
    <div class="stats-pill" id="statsBar" style="display:none">
      <i class="fas fa-database" style="color:var(--c-primary)"></i>
      <span id="totalCount">--</span>件
    </div>
    <button class="header-btn" onclick="showWelcomeManually()" title="使い方ガイドを表示" aria-label="使い方ガイド">
      <i class="fas fa-question"></i>
    </button>
    <button class="header-btn fav-header-btn" onclick="showFavoritesPanel()" title="お気に入り一覧" aria-label="お気に入り" id="favHeaderBtn">
      <i class="fas fa-heart"></i>
      <span class="fav-count-badge" id="favCountBadge"></span>
    </button>
    <button class="header-btn" onclick="toggleTheme()" title="テーマ切替 (ダーク/ライト)" id="themeBtn" aria-label="テーマ切替">
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

    <!-- Mode Tabs: 購入 / 賃貸 / 投資 -->
    <div class="mode-tabs">
      <button class="mode-tab active" id="modeTabBuy"    onclick="setSearchMode('buy')">🏠 購入</button>
      <button class="mode-tab"        id="modeTabRent"   onclick="setSearchMode('rent')">🔑 賃貸</button>
      <button class="mode-tab"        id="modeTabInvest" onclick="setSearchMode('invest')">💰 投資</button>
    </div>

    <!-- Preset Chips (mode-specific) -->
    <div id="presetBuy" class="preset-row">
      <span style="font-size:12px;color:var(--c-text3);align-self:center;white-space:nowrap">クイック:</span>
      <button class="preset-chip" id="pc_buy_new"      onclick="applyPreset('buy_new',this)">🏗 新築</button>
      <button class="preset-chip" id="pc_buy_st5"      onclick="applyPreset('buy_st5',this)">🚆 駅5分</button>
      <button class="preset-chip" id="pc_buy_3000"     onclick="applyPreset('buy_3000',this)">💴 3000万以下</button>
      <button class="preset-chip" id="pc_buy_wide"     onclick="applyPreset('buy_wide',this)">📐 70m²以上</button>
    </div>
    <div id="presetRent" class="preset-row hidden">
      <span style="font-size:12px;color:var(--c-text3);align-self:center;white-space:nowrap">クイック:</span>
      <button class="preset-chip" id="pc_rent_st5"     onclick="applyPreset('rent_st5',this)">🚆 駅5分</button>
      <button class="preset-chip" id="pc_rent_new"     onclick="applyPreset('rent_new',this)">✨ 築5年以内</button>
      <button class="preset-chip" id="pc_rent_1ldk"    onclick="applyPreset('rent_1ldk',this)">🛏 1LDK</button>
      <button class="preset-chip" id="pc_rent_2ldk"    onclick="applyPreset('rent_2ldk',this)">🛏 2LDK</button>
    </div>
    <div id="presetInvest" class="preset-row hidden">
      <span style="font-size:12px;color:var(--c-text3);align-self:center;white-space:nowrap">クイック:</span>
      <button class="preset-chip" id="pc_inv_y8"       onclick="applyPreset('inv_y8',this)">📈 利回り8%+</button>
      <button class="preset-chip" id="pc_inv_apt"      onclick="applyPreset('inv_apt',this)">🏗 一棟アパート</button>
      <button class="preset-chip" id="pc_inv_munit"    onclick="applyPreset('inv_munit',this)">🏬 区分マンション</button>
      <button class="preset-chip" id="pc_inv_y10"      onclick="applyPreset('inv_y10',this)">🔥 利回り10%+</button>
    </div>

    <!-- Row 1: フリーワード + 都道府県 -->
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
        <div class="field-label">ステータス</div>
        <select id="status" class="field-input">
          <option value="active">販売中</option>
          <option value="all">すべて（売却済含む）</option>
          <option value="sold">売却済のみ</option>
        </select>
      </div>
      <div style="display:flex;align-items:flex-end">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--c-text2);cursor:pointer;padding-bottom:9px">
          <input type="checkbox" id="hideDuplicates" onchange="doSearch()" style="width:15px;height:15px;cursor:pointer;accent-color:var(--c-primary)">
          重複非表示
        </label>
      </div>
    </div>

    <!-- 購入フィールド -->
    <div id="buyFields" style="margin-top:14px">
      <div style="margin-bottom:12px">
        <div class="field-label">物件種別</div>
        <div class="type-chip-row">
          <label class="type-chip-lbl"><input type="radio" name="buyType" value="" checked><span>すべて</span></label>
          <label class="type-chip-lbl"><input type="radio" name="buyType" value="mansion"><span>🏢 マンション</span></label>
          <label class="type-chip-lbl"><input type="radio" name="buyType" value="kodate"><span>🏠 一戸建て</span></label>
          <label class="type-chip-lbl"><input type="radio" name="buyType" value="tochi"><span>🗾 土地</span></label>
          <label class="type-chip-lbl"><input type="radio" name="buyType" value="jimusho"><span>🏪 事務所</span></label>
        </div>
      </div>
      <div class="search-grid2">
        <div>
          <div class="field-label">価格 <span id="priceLabel" style="font-weight:400;color:var(--c-text3)">指定なし</span></div>
          <div class="range-row">
            <input type="number" id="priceMin" placeholder="下限(万円)" class="field-input" min="0" oninput="updatePriceLabel();clearPriceError()">
            <span class="range-sep">〜</span>
            <input type="number" id="priceMax" placeholder="上限(万円)" class="field-input" min="0" oninput="updatePriceLabel();clearPriceError()">
          </div>
          <div class="field-error hidden" id="priceError">上限は下限より大きい値を入力してください</div>
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
      </div>
      <div class="search-grid3" style="margin-top:14px">
        <div>
          <div class="field-label">間取り（複数選択可）</div>
          <div class="rooms-wrap" id="roomsWrap">
            <button type="button" class="rooms-btn field-input" onclick="toggleRoomsDropdown(event)">
              <span id="roomsDisplay">すべて</span>
              <i class="fas fa-chevron-down rooms-chevron" id="roomsChevron"></i>
            </button>
            <div class="rooms-popup hidden" id="roomsPopup">
              <label><input type="checkbox" class="rooms-cb" value="1R" onchange="updateRoomsDisplay()"> 1R</label>
              <label><input type="checkbox" class="rooms-cb" value="1K" onchange="updateRoomsDisplay()"> 1K</label>
              <label><input type="checkbox" class="rooms-cb" value="1DK" onchange="updateRoomsDisplay()"> 1DK</label>
              <label><input type="checkbox" class="rooms-cb" value="1LDK" onchange="updateRoomsDisplay()"> 1LDK</label>
              <label><input type="checkbox" class="rooms-cb" value="2K" onchange="updateRoomsDisplay()"> 2K</label>
              <label><input type="checkbox" class="rooms-cb" value="2DK" onchange="updateRoomsDisplay()"> 2DK</label>
              <label><input type="checkbox" class="rooms-cb" value="2LDK" onchange="updateRoomsDisplay()"> 2LDK</label>
              <label><input type="checkbox" class="rooms-cb" value="3LDK" onchange="updateRoomsDisplay()"> 3LDK</label>
              <label><input type="checkbox" class="rooms-cb" value="4LDK" onchange="updateRoomsDisplay()"> 4LDK</label>
              <label><input type="checkbox" class="rooms-cb" value="5LDK以上" onchange="updateRoomsDisplay()"> 5LDK+</label>
            </div>
          </div>
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
        <div>
          <div class="field-label">利回り下限<span class="term-help" tabindex="0" data-tip="(年間家賃収入 ÷ 物件価格) × 100。例: 1億で年700万家賃 → 7.0%。">?</span></div>
          <div class="range-row">
            <input type="number" id="yieldMin" placeholder="例: 7.5" class="field-input" min="0" step="0.1">
            <span class="range-sep">%以上</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 賃貸フィールド -->
    <div id="rentFields" class="hidden" style="margin-top:14px">
      <div class="search-grid2">
        <div>
          <div class="field-label">家賃 <span id="rentPriceLabel" style="font-weight:400;color:var(--c-text3)">指定なし</span></div>
          <div class="range-row">
            <input type="number" id="rentPriceMin" placeholder="下限(万円/月)" class="field-input" min="0" oninput="updateRentPriceLabel()">
            <span class="range-sep">〜</span>
            <input type="number" id="rentPriceMax" placeholder="上限(万円/月)" class="field-input" min="0" oninput="updateRentPriceLabel()">
          </div>
        </div>
        <div>
          <div class="field-label">間取り（複数選択可）</div>
          <div class="rooms-wrap" id="rentRoomsWrap">
            <button type="button" class="rooms-btn field-input" onclick="toggleRentRoomsDropdown(event)">
              <span id="rentRoomsDisplay">すべて</span>
              <i class="fas fa-chevron-down rooms-chevron" id="rentRoomsChevron"></i>
            </button>
            <div class="rooms-popup hidden" id="rentRoomsPopup">
              <label><input type="checkbox" class="rent-rooms-cb" value="1R" onchange="updateRentRoomsDisplay()"> 1R</label>
              <label><input type="checkbox" class="rent-rooms-cb" value="1K" onchange="updateRentRoomsDisplay()"> 1K</label>
              <label><input type="checkbox" class="rent-rooms-cb" value="1DK" onchange="updateRentRoomsDisplay()"> 1DK</label>
              <label><input type="checkbox" class="rent-rooms-cb" value="1LDK" onchange="updateRentRoomsDisplay()"> 1LDK</label>
              <label><input type="checkbox" class="rent-rooms-cb" value="2LDK" onchange="updateRentRoomsDisplay()"> 2LDK</label>
              <label><input type="checkbox" class="rent-rooms-cb" value="3LDK" onchange="updateRentRoomsDisplay()"> 3LDK</label>
            </div>
          </div>
        </div>
        <div>
          <div class="field-label">最寄駅 徒歩</div>
          <select id="rentStationMin" class="field-input">
            <option value="">制限なし</option>
            <option value="3">3分以内</option>
            <option value="5">5分以内</option>
            <option value="10">10分以内</option>
            <option value="15">15分以内</option>
          </select>
        </div>
      </div>
      <div class="search-grid3" style="margin-top:14px">
        <div>
          <div class="field-label">築年数</div>
          <select id="rentAgeMax" class="field-input">
            <option value="">制限なし</option>
            <option value="1">新築（1年以内）</option>
            <option value="5">5年以内</option>
            <option value="10">10年以内</option>
            <option value="20">20年以内</option>
          </select>
        </div>
        <div>
          <div class="field-label">面積 下限</div>
          <div class="range-row">
            <input type="number" id="rentAreaMin" placeholder="下限(m²)" class="field-input" min="0">
            <span class="range-sep">m²以上</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 投資フィールド -->
    <div id="investFields" class="hidden" style="margin-top:14px">
      <div style="margin-bottom:12px">
        <div class="field-label">建物種別（複数選択可）</div>
        <div class="invest-type-grid">
          <label class="invest-type-lbl"><input type="checkbox" class="invest-type-cb" value="一棟マンション"><span>🏢 一棟マンション</span></label>
          <label class="invest-type-lbl"><input type="checkbox" class="invest-type-cb" value="一棟アパート"><span>🏗 一棟アパート</span></label>
          <label class="invest-type-lbl"><input type="checkbox" class="invest-type-cb" value="区分マンション"><span>🏬 区分マンション</span></label>
          <label class="invest-type-lbl"><input type="checkbox" class="invest-type-cb" value="戸建賃貸"><span>🏠 戸建賃貸</span></label>
          <label class="invest-type-lbl"><input type="checkbox" class="invest-type-cb" value="土地"><span>🗾 土地</span></label>
        </div>
      </div>
      <div class="search-grid2">
        <div>
          <div class="field-label">価格 <span id="investPriceLabel" style="font-weight:400;color:var(--c-text3)">指定なし</span></div>
          <div class="range-row">
            <input type="number" id="investPriceMin" placeholder="下限(万円)" class="field-input" min="0" oninput="updateInvestPriceLabel()">
            <span class="range-sep">〜</span>
            <input type="number" id="investPriceMax" placeholder="上限(万円)" class="field-input" min="0" oninput="updateInvestPriceLabel()">
          </div>
        </div>
        <div>
          <div class="field-label">利回り下限 <span class="term-help" tabindex="0" data-tip="(年間家賃収入 ÷ 物件価格) × 100。例: 1億で年700万家賃 → 7.0%。">?</span></div>
          <div class="range-row">
            <input type="number" id="investYieldMin" placeholder="例: 8.0" class="field-input" min="0" step="0.5">
            <span class="range-sep">%以上</span>
          </div>
        </div>
        <div>
          <div class="field-label">築年数</div>
          <select id="investAgeMax" class="field-input">
            <option value="">制限なし</option>
            <option value="5">5年以内</option>
            <option value="10">10年以内</option>
            <option value="20">20年以内</option>
            <option value="30">30年以内</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 高度フィルター (購入モード・詳細条件) -->
    <div id="advancedFilters" style="margin-top:14px">
      <details style="background:var(--c-bg2);border:1px solid var(--c-border);border-radius:var(--radius-sm)">
        <summary style="list-style:none;cursor:pointer;padding:10px 14px;font-size:13px;font-weight:700;color:var(--c-text2);display:flex;align-items:center;gap:8px;user-select:none">
          <i class="fas fa-sliders-h" style="color:var(--c-primary)"></i>
          詳細条件
          <i class="fas fa-chevron-down accordion-arrow" style="margin-left:auto;font-size:11px;color:var(--c-text4)"></i>
        </summary>
        <div style="padding:14px;border-top:1px solid var(--c-border)">
          <div class="search-grid2">
            <div>
              <div class="field-label">管理費 上限
                <span class="term-help" tabindex="0" data-tip="マンション等で月々支払う共用部の維持費。管理費0円の場合は表示されないことがあります。">?</span>
              </div>
              <div class="range-row">
                <input type="number" id="managementFeeMax" placeholder="例: 20000" class="field-input" min="0" step="1000">
                <span class="range-sep">円以下/月</span>
              </div>
            </div>
            <div>
              <div class="field-label">修繕積立金 上限
                <span class="term-help" tabindex="0" data-tip="将来の大規模修繕に備えて毎月積み立てる費用。築年数が古いと高くなる傾向。">?</span>
              </div>
              <div class="range-row">
                <input type="number" id="repairFundMax" placeholder="例: 15000" class="field-input" min="0" step="1000">
                <span class="range-sep">円以下/月</span>
              </div>
            </div>
            <div>
              <div class="field-label">向き</div>
              <select id="directionFilter" class="field-input">
                <option value="">すべて</option>
                <option value="南">南向き</option>
                <option value="南東">南東向き</option>
                <option value="南西">南西向き</option>
                <option value="東">東向き</option>
                <option value="西">西向き</option>
                <option value="北">北向き</option>
              </select>
            </div>
            <div>
              <div class="field-label">構造</div>
              <select id="structureFilter" class="field-input">
                <option value="">すべて</option>
                <option value="RC">RC造（鉄筋コンクリート）</option>
                <option value="SRC">SRC造（鉄骨鉄筋コンクリート）</option>
                <option value="鉄骨">鉄骨造</option>
                <option value="木造">木造</option>
                <option value="軽量鉄骨">軽量鉄骨造</option>
              </select>
            </div>
          </div>
        </div>
      </details>
    </div>

    <!-- Sites Accordion -->
    <details class="sites-accordion" id="sitesAccordion">
      <summary>
        <i class="fas fa-globe" style="color:var(--c-primary)"></i>
        対象サイト: <span id="sitesAccordionLabel">全サイト (${Object.keys(SITES).length})</span>
        <i class="fas fa-chevron-down accordion-arrow"></i>
      </summary>
      <div class="sites-accordion-body">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span class="field-label" style="margin:0">サイト選択</span>
          <button class="sites-toggle-btn" onclick="toggleAllSites(true)">全選択</button>
          <button class="sites-toggle-btn" onclick="toggleAllSites(false)" style="color:var(--c-text3)">全解除</button>
        </div>
        <div class="sites-grid" id="siteCheckboxes">
          ${siteCheckboxes}
        </div>
      </div>
    </details>

    <!-- Actions -->
    <div class="actions-row" style="margin-top:16px">
      <div id="allSitesWarn" class="hidden" style="font-size:11px;color:var(--c-warning);display:none;align-items:center;gap:4px">
        <i class="fas fa-exclamation-triangle"></i>全サイト選択は重くなることがあります
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

  <!-- Export Bar (検索結果表示後のみ表示) -->
  <div class="export-bar hidden" id="exportBar">
    <button onclick="exportCSV()" class="btn-export">
      📥 CSV ダウンロード
    </button>
    <button onclick="showImportHistoryModal()" class="btn-admin">
      📋 取込履歴
    </button>
    <button onclick="window.location.href='/api/admin/stats'" class="btn-admin" style="margin-left:auto;font-size:11px;opacity:.6">
      DB統計
    </button>
  </div>

  <!-- Active Filters -->
  <div class="filter-chips" id="filterChips"></div>

  <!-- Tab Bar -->
  <div class="tab-bar">
    <button class="tab-btn active" id="tabProperties" onclick="switchTab('properties')">🏠 物件一覧</button>
    <button class="tab-btn" id="tabMap" onclick="switchTab('map')" title="検索結果を地図上に表示">🗺️ 地図</button>
    <button class="tab-btn" id="tabTransactions" onclick="switchTab('transactions')" title="成約事例 = 過去に売買が成立した物件の取引価格データ。相場感の参考に使えます。">📋 成約事例</button>
  </div>

  <!-- Results Bar -->
  <div class="results-bar" id="resultsBar">
    <span id="resultCount" class="results-count"></span>
    <span id="executionTime" class="results-time"></span>
    <span class="results-spacer"></span>
    <div class="results-sort">
      <span class="results-sort-lbl">並び順:</span>
      <select id="sortBy" onchange="doSearch()" style="padding:5px 10px;border-radius:8px;border:1.5px solid var(--c-border);background:var(--c-surface);font-size:12px;color:var(--c-text)">
        <option value="newest">新着順</option>
        <option value="price_asc">価格↑</option>
        <option value="price_desc">価格↓</option>
        <option value="area_desc">面積↓</option>
        <option value="area_asc">面積↑</option>
        <option value="yield_desc">利回り↓</option>
        <option value="relevance">関連度</option>
      </select>
    </div>
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

  <!-- Map Panel -->
  <div id="mapPanel" class="hidden">
    <div id="propertyMap" style="height:520px;border-radius:var(--radius);border:1px solid var(--c-border);overflow:hidden"></div>
    <div id="mapNoteBar" style="font-size:12px;color:var(--c-text3);margin-top:8px;text-align:center">地図は緯度経度情報がある物件のみ表示します（最大500件）</div>
  </div>

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

<!-- =================== SCROLL TO TOP =================== -->
<button class="scroll-top-btn" id="scrollTopBtn" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="トップへ戻る" aria-label="ページトップへ">
  <i class="fas fa-arrow-up"></i>
</button>

<!-- =================== SNACKBAR =================== -->
<div class="snackbar" id="snackbar">
  <span class="snackbar-msg"></span>
  <span class="snackbar-undo">元に戻す</span>
</div>

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

<!-- =================== IMPORT HISTORY MODAL =================== -->
<div id="importHistoryModal" class="modal-overlay hidden" onclick="if(event.target===this)closeImportHistoryModal()">
  <div class="modal-box" style="max-width:760px">
    <div style="padding:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <span style="font-size:16px;font-weight:800">📋 TERASS 取り込み履歴</span>
        <button class="modal-close" onclick="closeImportHistoryModal()">&times;</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <label style="font-size:12px;font-weight:700;color:var(--c-text3)">期間:</label>
        <select id="importHistoryDays" onchange="loadImportHistory()" style="padding:5px 10px;border-radius:8px;border:1.5px solid var(--c-border);background:var(--c-bg);color:var(--c-text);font-size:13px">
          <option value="7">7日</option>
          <option value="30" selected>30日</option>
          <option value="90">90日</option>
          <option value="180">180日</option>
        </select>
      </div>
      <div id="importHistoryContent">
        <div style="text-align:center;padding:40px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>
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
var currentSearchMode = 'buy'; // 'buy' | 'rent' | 'invest'
var _savedSearchState = null;  // for undo snackbar

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
      updateSitesAccordionLabel();
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

  // Favorites badge
  updateFavBadge();

  // Welcome ガイド (初回訪問時のみ)
  showWelcomeIfFirstVisit();

  // キーボードショートカット: / で検索フォーカス、Esc でモーダル閉じ
  document.addEventListener('keydown', function(e) {
    var tag = (e.target && e.target.tagName) || '';
    var inForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === '/' && !inForm) {
      e.preventDefault();
      var sq = document.getElementById('searchQuery');
      if (sq) sq.focus();
    }
    if (e.key === 'Escape') {
      var w = document.getElementById('welcomeOverlay');
      if (w && w.classList.contains('active')) closeWelcome(false);
      closeRoomsDropdown();
    }
  });

  // Click-outside: close rooms dropdowns
  document.addEventListener('click', function(e) {
    var wrap1 = document.getElementById('roomsWrap');
    var wrap2 = document.getElementById('rentRoomsWrap');
    if (wrap1 && !wrap1.contains(e.target)) closeRoomsDropdown();
    if (wrap2 && !wrap2.contains(e.target)) closeRentRoomsDropdown();
  });
})();

// ── Welcome ガイド ──
function showWelcomeIfFirstVisit() {
  try {
    if (localStorage.getItem('mal_welcome_seen_v1') === '1') return;
  } catch (e) { /* ignore */ }
  var ov = document.getElementById('welcomeOverlay');
  if (ov) ov.classList.add('active');
}
function closeWelcome(remember) {
  var ov = document.getElementById('welcomeOverlay');
  if (ov) ov.classList.remove('active');
  if (remember) {
    try { localStorage.setItem('mal_welcome_seen_v1', '1'); } catch (e) { /* ignore */ }
  }
}
function showWelcomeManually() {
  var ov = document.getElementById('welcomeOverlay');
  if (ov) ov.classList.add('active');
}

function toggleAllSites(checked) {
  document.querySelectorAll('.site-cb').forEach(function(cb) {
    cb.checked = checked;
    cb.dispatchEvent(new Event('change'));
  });
}

// ── Search Mode ──
function setSearchMode(mode) {
  currentSearchMode = mode;
  ['buy','rent','invest'].forEach(function(m) {
    var cap = m.charAt(0).toUpperCase() + m.slice(1);
    var tabEl = document.getElementById('modeTab' + cap);
    if (tabEl) tabEl.classList.toggle('active', m === mode);
    var preEl = document.getElementById('preset' + cap);
    if (preEl) preEl.classList.toggle('hidden', m !== mode);
    var fEl = document.getElementById(m + 'Fields');
    if (fEl) fEl.classList.toggle('hidden', m !== mode);
  });
  // Auto-select relevant sites per mode
  var investSites = ['kenbiya','rakumachi'];
  var rentSites = ['chintai','homes','smaity'];
  document.querySelectorAll('.site-cb').forEach(function(cb) {
    if (mode === 'invest') {
      cb.checked = investSites.indexOf(cb.value) >= 0;
    } else if (mode === 'rent') {
      cb.checked = rentSites.indexOf(cb.value) >= 0;
    } else {
      cb.checked = true;
    }
    cb.dispatchEvent(new Event('change'));
  });
}

// ── Preset Chips ──
var PRESETS = {
  buy_new:    { ageMax: '1' },
  buy_st5:    { stationMin: '5' },
  buy_3000:   { priceMax: '3000' },
  buy_wide:   { areaMin: '70' },
  rent_st5:   { rentStationMin: '5' },
  rent_new:   { rentAgeMax: '5' },
  rent_1ldk:  { rentRooms: ['1LDK'] },
  rent_2ldk:  { rentRooms: ['2LDK'] },
  inv_y8:     { investYieldMin: '8' },
  inv_apt:    { investTypes: ['一棟アパート'], query: '一棟アパート' },
  inv_munit:  { investTypes: ['区分マンション'], query: '区分マンション' },
  inv_y10:    { investYieldMin: '10' },
};
function applyPreset(name, btn) {
  var p = PRESETS[name];
  if (!p) return;
  var wasActive = btn.classList.contains('active');
  // Deactivate sibling chips in same row
  btn.closest('.preset-row').querySelectorAll('.preset-chip').forEach(function(c){ c.classList.remove('active'); });
  if (!wasActive) {
    btn.classList.add('active');
    if (p.ageMax !== undefined) document.getElementById('ageMax').value = p.ageMax;
    if (p.stationMin !== undefined) document.getElementById('stationMin').value = p.stationMin;
    if (p.priceMax !== undefined) document.getElementById('priceMax').value = p.priceMax; updatePriceLabel();
    if (p.areaMin !== undefined) document.getElementById('areaMin').value = p.areaMin; updateAreaLabel();
    if (p.rentStationMin !== undefined) document.getElementById('rentStationMin').value = p.rentStationMin;
    if (p.rentAgeMax !== undefined) document.getElementById('rentAgeMax').value = p.rentAgeMax;
    if (p.rentRooms) {
      document.querySelectorAll('.rent-rooms-cb').forEach(function(cb){ cb.checked = p.rentRooms.indexOf(cb.value) >= 0; });
      updateRentRoomsDisplay();
    }
    if (p.investYieldMin !== undefined) document.getElementById('investYieldMin').value = p.investYieldMin;
    if (p.investTypes) {
      document.querySelectorAll('.invest-type-cb').forEach(function(cb){ cb.checked = p.investTypes.indexOf(cb.value) >= 0; });
    }
    if (p.query !== undefined) document.getElementById('searchQuery').value = p.query;
  } else {
    // Toggle off: reset this preset's fields
    if (p.ageMax !== undefined) document.getElementById('ageMax').value = '';
    if (p.stationMin !== undefined) document.getElementById('stationMin').value = '';
    if (p.priceMax !== undefined) { document.getElementById('priceMax').value = ''; updatePriceLabel(); }
    if (p.areaMin !== undefined) { document.getElementById('areaMin').value = ''; updateAreaLabel(); }
    if (p.rentStationMin !== undefined) document.getElementById('rentStationMin').value = '';
    if (p.rentAgeMax !== undefined) document.getElementById('rentAgeMax').value = '';
    if (p.rentRooms) {
      document.querySelectorAll('.rent-rooms-cb').forEach(function(cb){ cb.checked = false; });
      updateRentRoomsDisplay();
    }
    if (p.investYieldMin !== undefined) document.getElementById('investYieldMin').value = '';
    if (p.investTypes) {
      document.querySelectorAll('.invest-type-cb').forEach(function(cb){ if (p.investTypes.indexOf(cb.value) >= 0) cb.checked = false; });
    }
    if (p.query !== undefined) document.getElementById('searchQuery').value = '';
  }
  doSearch();
}

// ── Rooms Multi-select ──
function toggleRoomsDropdown(e) {
  e.stopPropagation();
  var popup = document.getElementById('roomsPopup');
  popup.classList.toggle('hidden');
  document.getElementById('roomsChevron').style.transform = popup.classList.contains('hidden') ? '' : 'rotate(180deg)';
}
function closeRoomsDropdown() {
  var popup = document.getElementById('roomsPopup');
  if (popup) { popup.classList.add('hidden'); }
  var ch = document.getElementById('roomsChevron');
  if (ch) ch.style.transform = '';
}
function updateRoomsDisplay() {
  var sel = [].slice.call(document.querySelectorAll('.rooms-cb:checked')).map(function(c){ return c.value; });
  document.getElementById('roomsDisplay').textContent = sel.length ? sel.join(', ') : 'すべて';
}
function toggleRentRoomsDropdown(e) {
  e.stopPropagation();
  var popup = document.getElementById('rentRoomsPopup');
  popup.classList.toggle('hidden');
  document.getElementById('rentRoomsChevron').style.transform = popup.classList.contains('hidden') ? '' : 'rotate(180deg)';
}
function closeRentRoomsDropdown() {
  var popup = document.getElementById('rentRoomsPopup');
  if (popup) { popup.classList.add('hidden'); }
  var ch = document.getElementById('rentRoomsChevron');
  if (ch) ch.style.transform = '';
}
function updateRentRoomsDisplay() {
  var sel = [].slice.call(document.querySelectorAll('.rent-rooms-cb:checked')).map(function(c){ return c.value; });
  document.getElementById('rentRoomsDisplay').textContent = sel.length ? sel.join(', ') : 'すべて';
}

// ── Sites Accordion Label ──
function updateSitesAccordionLabel() {
  var total = document.querySelectorAll('.site-cb').length;
  var checked = document.querySelectorAll('.site-cb:checked').length;
  var el = document.getElementById('sitesAccordionLabel');
  if (el) el.textContent = checked === total ? '全サイト (' + total + ')' : checked + '/' + total + ' 選択中';
}

// ── Price Validation ──
function clearPriceError() {
  document.getElementById('priceMin').classList.remove('has-error');
  document.getElementById('priceMax').classList.remove('has-error');
  var el = document.getElementById('priceError');
  if (el) el.classList.add('hidden');
}
function showPriceError() {
  document.getElementById('priceMin').classList.add('has-error');
  document.getElementById('priceMax').classList.add('has-error');
  var el = document.getElementById('priceError');
  if (el) el.classList.remove('hidden');
}

// ── Snackbar ──
function showSnackbar(msg, undoFn) {
  var sb = document.getElementById('snackbar');
  sb.querySelector('.snackbar-msg').textContent = msg;
  sb.classList.add('visible');
  var undoBtn = sb.querySelector('.snackbar-undo');
  undoBtn.style.display = undoFn ? '' : 'none';
  undoBtn.onclick = function() { undoFn && undoFn(); sb.classList.remove('visible'); };
  clearTimeout(sb._t);
  sb._t = setTimeout(function(){ sb.classList.remove('visible'); }, 4000);
}
function captureSearchState() {
  var rooms = [].slice.call(document.querySelectorAll('.rooms-cb:checked')).map(function(c){ return c.value; });
  var rentRooms = [].slice.call(document.querySelectorAll('.rent-rooms-cb:checked')).map(function(c){ return c.value; });
  var investTypes = [].slice.call(document.querySelectorAll('.invest-type-cb:checked')).map(function(c){ return c.value; });
  var buyType = (document.querySelector('input[name="buyType"]:checked') || {}).value || '';
  return {
    mode: currentSearchMode,
    query: document.getElementById('searchQuery').value,
    prefecture: document.getElementById('prefecture').value,
    status: document.getElementById('status').value,
    priceMin: document.getElementById('priceMin').value,
    priceMax: document.getElementById('priceMax').value,
    areaMin: document.getElementById('areaMin').value,
    areaMax: document.getElementById('areaMax').value,
    stationMin: document.getElementById('stationMin').value,
    ageMax: document.getElementById('ageMax').value,
    yieldMin: document.getElementById('yieldMin').value,
    rooms: rooms, rentRooms: rentRooms, investTypes: investTypes, buyType: buyType,
    rentPriceMin: document.getElementById('rentPriceMin').value,
    rentPriceMax: document.getElementById('rentPriceMax').value,
    rentStationMin: document.getElementById('rentStationMin').value,
    rentAgeMax: document.getElementById('rentAgeMax').value,
    rentAreaMin: document.getElementById('rentAreaMin').value,
    investPriceMin: document.getElementById('investPriceMin').value,
    investPriceMax: document.getElementById('investPriceMax').value,
    investYieldMin: document.getElementById('investYieldMin').value,
    investAgeMax: document.getElementById('investAgeMax').value,
  };
}
function restoreSearchState(state) {
  if (!state) return;
  setSearchMode(state.mode);
  document.getElementById('searchQuery').value = state.query || '';
  document.getElementById('prefecture').value = state.prefecture || '';
  document.getElementById('status').value = state.status || 'active';
  document.getElementById('priceMin').value = state.priceMin || '';
  document.getElementById('priceMax').value = state.priceMax || '';
  document.getElementById('areaMin').value = state.areaMin || '';
  document.getElementById('areaMax').value = state.areaMax || '';
  document.getElementById('stationMin').value = state.stationMin || '';
  document.getElementById('ageMax').value = state.ageMax || '';
  document.getElementById('yieldMin').value = state.yieldMin || '';
  document.querySelectorAll('.rooms-cb').forEach(function(cb){ cb.checked = (state.rooms||[]).indexOf(cb.value) >= 0; });
  updateRoomsDisplay();
  document.querySelectorAll('.rent-rooms-cb').forEach(function(cb){ cb.checked = (state.rentRooms||[]).indexOf(cb.value) >= 0; });
  updateRentRoomsDisplay();
  document.querySelectorAll('.invest-type-cb').forEach(function(cb){ cb.checked = (state.investTypes||[]).indexOf(cb.value) >= 0; });
  document.querySelectorAll('input[name="buyType"]').forEach(function(r){ r.checked = r.value === (state.buyType||''); });
  document.getElementById('rentPriceMin').value = state.rentPriceMin || '';
  document.getElementById('rentPriceMax').value = state.rentPriceMax || '';
  document.getElementById('rentStationMin').value = state.rentStationMin || '';
  document.getElementById('rentAgeMax').value = state.rentAgeMax || '';
  document.getElementById('rentAreaMin').value = state.rentAreaMin || '';
  document.getElementById('investPriceMin').value = state.investPriceMin || '';
  document.getElementById('investPriceMax').value = state.investPriceMax || '';
  document.getElementById('investYieldMin').value = state.investYieldMin || '';
  document.getElementById('investAgeMax').value = state.investAgeMax || '';
  updatePriceLabel(); updateAreaLabel();
  doSearch();
}

// ── Search ──
async function doSearch(page) {
  page = page || 1;
  currentPage = page;

  var q = new URLSearchParams();
  var mode = currentSearchMode;
  var query = document.getElementById('searchQuery').value.trim();
  var pref = document.getElementById('prefecture').value;
  var status = document.getElementById('status').value;
  var sortBy = (document.getElementById('sortBy') || {}).value || 'newest';
  var sites = [].slice.call(document.querySelectorAll('.site-cb:checked')).map(function(cb) { return cb.value; });
  var hideDuplicates = !!(document.getElementById('hideDuplicates') && (document.getElementById('hideDuplicates') as HTMLInputElement).checked);

  // Mode-specific field extraction
  var type = '', priceMin = '', priceMax = '', areaMin = '', areaMax = '';
  var rooms = '', stationMin = '', ageMax = '', yieldMin = '';

  if (mode === 'buy') {
    var buyTypeEl = document.querySelector('input[name="buyType"]:checked') as HTMLInputElement;
    type = buyTypeEl ? buyTypeEl.value : '';
    priceMin = document.getElementById('priceMin').value;
    priceMax = document.getElementById('priceMax').value;
    areaMin = document.getElementById('areaMin').value;
    areaMax = document.getElementById('areaMax').value;
    stationMin = document.getElementById('stationMin').value;
    ageMax = document.getElementById('ageMax').value;
    yieldMin = document.getElementById('yieldMin').value;
    // Multi-select rooms
    var selRooms = [].slice.call(document.querySelectorAll('.rooms-cb:checked')).map(function(c){ return (c as HTMLInputElement).value; });
    rooms = selRooms.join(',');
    // Price validation
    if (priceMin && priceMax && parseInt(priceMin) > parseInt(priceMax)) {
      showPriceError(); return;
    }
    clearPriceError();
  } else if (mode === 'rent') {
    // Map rent to chintai property types
    var rentBuyTypeEl = document.querySelector('input[name="buyType"]') as HTMLInputElement;
    type = 'chintai_mansion'; // default; could pick ikkodate later
    priceMin = document.getElementById('rentPriceMin').value;
    priceMax = document.getElementById('rentPriceMax').value;
    areaMin = document.getElementById('rentAreaMin').value;
    stationMin = document.getElementById('rentStationMin').value;
    ageMax = document.getElementById('rentAgeMax').value;
    var selRentRooms = [].slice.call(document.querySelectorAll('.rent-rooms-cb:checked')).map(function(c){ return (c as HTMLInputElement).value; });
    rooms = selRentRooms.join(',');
  } else if (mode === 'invest') {
    type = 'investment';
    priceMin = document.getElementById('investPriceMin').value;
    priceMax = document.getElementById('investPriceMax').value;
    yieldMin = document.getElementById('investYieldMin').value;
    ageMax = document.getElementById('investAgeMax').value;
    // Append invest building type as keyword
    var investTypes = [].slice.call(document.querySelectorAll('.invest-type-cb:checked')).map(function(c){ return (c as HTMLInputElement).value; });
    if (investTypes.length > 0 && !query) {
      query = investTypes.join(' ');
    } else if (investTypes.length > 0) {
      query = query + ' ' + investTypes.join(' ');
    }
    // Always sort by yield for invest mode unless user changed it
    if (sortBy === 'newest') sortBy = 'yield_desc';
  }

  // 詳細条件フィルター
  var managementFeeMax = (document.getElementById('managementFeeMax') as HTMLInputElement)?.value || '';
  var repairFundMax    = (document.getElementById('repairFundMax') as HTMLInputElement)?.value || '';
  var direction        = (document.getElementById('directionFilter') as HTMLSelectElement)?.value || '';
  var structure        = (document.getElementById('structureFilter') as HTMLSelectElement)?.value || '';

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
  if (managementFeeMax) q.set('management_fee_max', managementFeeMax);
  if (repairFundMax) q.set('repair_fund_max', repairFundMax);
  if (direction) q.set('direction', direction);
  if (structure) q.set('structure', structure);
  if (hideDuplicates) q.set('hide_duplicates', '1');
  var totalSites = Object.keys(SITES_DATA).length;
  if (sites.length > 0 && sites.length < totalSites) q.set('sites', sites.join(','));
  q.set('sort', sortBy);
  var warn = document.getElementById('allSitesWarn');
  if (warn) warn.style.display = sites.length >= totalSites ? 'inline-flex' : 'none';
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
  document.getElementById('exportBar').classList.remove('hidden');
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
  var hasPrice = !!(p.price || (p.priceText && p.priceText !== '価格要相談'));
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
    + '<div class="prop-price" style="color:' + (isSold ? 'var(--c-text3)' : hasPrice ? color : 'var(--c-text4)') + (hasPrice ? '' : ';font-size:13px;font-style:italic;font-weight:600') + '">' + (isSold ? '<span style="font-size:14px;text-decoration:line-through">' : '') + escHtml(priceStr) + (isSold ? '</span>' : '') + '</div>'
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
  var limit = data.limit || 18;
  var cur = data.page || 1;
  var tot = data.totalPages || 1;
  var total = data.total || 0;
  var from = (cur - 1) * limit + 1;
  var to = Math.min(cur * limit, total);
  var rangeInfo = total > 0
    ? '<div style="width:100%;text-align:center;font-size:12px;color:var(--c-text3);margin-bottom:8px">'
      + from.toLocaleString() + '〜' + to.toLocaleString() + '件目 / 全' + total.toLocaleString() + '件</div>'
    : '';
  if (!data.totalPages || data.totalPages <= 1) { el.innerHTML = rangeInfo; return; }
  var html = rangeInfo;
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

  // ── 画像スライダー（R2 keys優先 → images配列 → thumbnailUrl → プレースホルダー）──
  var galSrcs = [];
  if (p.imageKeys && p.imageKeys.length > 0) {
    galSrcs = p.imageKeys.slice(0, 10).map(function(k) { return '/api/images/' + encodeURIComponent(k); });
  } else if (p.images && p.images.length > 0) {
    galSrcs = p.images.slice(0, 10);
  } else if (p.thumbnailUrl) {
    galSrcs = [p.thumbnailUrl];
  }

  var sliderHtml;
  var sliderId = 'slider_' + (p.id || 'x').replace(/[^a-z0-9]/gi,'_');
  if (galSrcs.length === 0) {
    sliderHtml = '<div class="img-slider-wrap"><div class="img-slider-placeholder">' + (site.logo || '🏠') + '</div></div>';
  } else {
    var slides = galSrcs.map(function(src, i) {
      return '<div class="img-slider-slide">'
        + '<img src="' + escAttr(src) + '" alt="物件画像 ' + (i+1) + '" loading="' + (i===0?'eager':'lazy') + '" onclick="openImg(\'' + escAttr(src) + '\')" style="cursor:zoom-in" onerror="this.parentElement.style.display=\'none\'">'
        + '</div>';
    }).join('');
    var dots = galSrcs.length > 1
      ? '<div class="img-slider-dots" id="' + sliderId + '_dots">'
        + galSrcs.map(function(_,i){ return '<button class="img-slider-dot' + (i===0?' active':'') + '" onclick="sliderGo(\'' + sliderId + '\',' + i + ')" aria-label="画像 ' + (i+1) + '"></button>'; }).join('')
        + '</div>'
      : '';
    var navButtons = galSrcs.length > 1
      ? '<button class="img-slider-nav img-slider-prev" onclick="sliderGo(\'' + sliderId + '\',-1,true)" aria-label="前の画像"><i class="fas fa-chevron-left"></i></button>'
        + '<button class="img-slider-nav img-slider-next" onclick="sliderGo(\'' + sliderId + '\',1,true)" aria-label="次の画像"><i class="fas fa-chevron-right"></i></button>'
      : '';
    var countBadge = galSrcs.length > 1
      ? '<span class="img-slider-count" id="' + sliderId + '_count">1 / ' + galSrcs.length + '</span>'
      : '';
    sliderHtml = '<div class="img-slider-wrap">'
      + '<div class="img-slider-track" id="' + sliderId + '" onscroll="sliderOnScroll(\'' + sliderId + '\',' + galSrcs.length + ')">'
      + slides
      + '</div>'
      + navButtons + dots + countBadge
      + '</div>';
  }

  // ── 主要スペックバッジ ──
  var badges = [];
  if (p.rooms) badges.push('<span class="spec-badge highlight"><i class="fas fa-door-open"></i>' + escHtml(p.rooms) + '</span>');
  if (p.area) badges.push('<span class="spec-badge"><i class="fas fa-ruler-combined"></i>' + p.area + 'm²</span>');
  if (p.age !== null && p.age !== undefined) badges.push('<span class="spec-badge"><i class="fas fa-calendar-alt"></i>築' + p.age + '年</span>');
  if (p.stationMinutes) badges.push('<span class="spec-badge"><i class="fas fa-train"></i>徒歩' + p.stationMinutes + '分</span>');
  if (p.floor) badges.push('<span class="spec-badge"><i class="fas fa-layer-group"></i>' + p.floor + '階</span>');
  if (p.yieldRate) badges.push('<span class="spec-badge" style="background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.3);color:#dc2626"><i class="fas fa-chart-line" style="color:#dc2626"></i>' + p.yieldRate.toFixed(1) + '%</span>');
  var specBadgesHtml = badges.length > 0 ? '<div class="spec-badges">' + badges.join('') + '</div>' : '';

  // ── 価格ブロック ──
  var priceHistoryHtml = buildPriceHistoryChart(p.priceHistory);
  var priceBlockHtml = '<div class="modal-price-block" style="margin-bottom:8px">'
    + '<span class="modal-price-main" style="color:' + (isSold ? 'var(--c-text3)' : color) + '">' + (isSold ? '<span style="text-decoration:line-through">' : '') + escHtml(priceStr) + (isSold ? '</span>' : '') + '</span>'
    + (p.managementFee || p.repairFund ? '<span class="modal-price-sub">管理費 ' + (p.managementFee ? p.managementFee.toLocaleString() + '円' : '-') + ' + 修繕 ' + (p.repairFund ? p.repairFund.toLocaleString() + '円' : '-') + '/月</span>' : '')
    + '</div>'
    + priceHistoryHtml;

  // ── 月々支払いシミュレーター（価格がある場合のみ表示）──
  var simHtml = '';
  if (p.price && p.price > 0 && !isSold) {
    var simId = 'sim_' + (p.id || 'x').replace(/[^a-z0-9]/gi,'_');
    var defaultDown = 0;
    var defaultRate = 0.5;
    var defaultYears = 35;
    var mgmtFee = p.managementFee || 0;
    var repairFee = p.repairFund || 0;
    simHtml = '<div class="sim-section">'
      + '<div class="sim-title" onclick="toggleSim(\'' + simId + '\')">'
      + '<i class="fas fa-calculator"></i>月々支払いシミュレーター'
      + '<i class="fas fa-chevron-down sim-toggle-icon" id="' + simId + '_icon"></i>'
      + '</div>'
      + '<div class="sim-body" id="' + simId + '_body">'
      + '<div class="sim-grid">'
      + '<div class="sim-field"><label class="sim-label">頭金（万円）</label><input class="sim-input" id="' + simId + '_down" type="number" min="0" max="' + p.price + '" value="' + defaultDown + '" oninput="calcSim(\'' + simId + '\',' + p.price + ',' + mgmtFee + ',' + repairFee + ')"></div>'
      + '<div class="sim-field"><label class="sim-label">金利（%/年）</label><input class="sim-input" id="' + simId + '_rate" type="number" min="0" max="20" step="0.01" value="' + defaultRate + '" oninput="calcSim(\'' + simId + '\',' + p.price + ',' + mgmtFee + ',' + repairFee + ')"></div>'
      + '<div class="sim-field"><label class="sim-label">返済年数</label><input class="sim-input" id="' + simId + '_years" type="number" min="1" max="50" value="' + defaultYears + '" oninput="calcSim(\'' + simId + '\',' + p.price + ',' + mgmtFee + ',' + repairFee + ')"></div>'
      + '<div class="sim-field"><label class="sim-label">管理費（円/月）</label><input class="sim-input" id="' + simId + '_mgmt" type="number" min="0" value="' + mgmtFee + '" oninput="calcSim(\'' + simId + '\',' + p.price + ',' + mgmtFee + ',' + repairFee + ')"></div>'
      + '</div>'
      + '<div class="sim-result" id="' + simId + '_result"><div class="sim-result-left"><div class="sim-result-label">月々の支払い目安</div><div class="sim-result-value" id="' + simId + '_monthly">--</div><div class="sim-result-detail" id="' + simId + '_detail"></div></div></div>'
      + '<div class="sim-note">※元利均等返済。概算です。実際は金融機関にご確認ください。</div>'
      + '</div>'
      + '</div>';
  }

  // ── 間取り図 ──
  var floorPlanHtml = p.floorPlanUrl
    ? '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);margin-bottom:6px">間取り図</div><img src="' + escAttr(p.floorPlanUrl) + '" class="floor-plan" alt="間取り図" loading="lazy" onerror="this.style.display=\'none\'"></div>'
    : '';

  // ── 詳細情報テーブル ──
  var tableRows = [
    ['所在地', (prefName ? prefName + ' ' : '') + (p.city || '') + (p.address ? ' ' + p.address : '')],
    ['最寄駅', p.station ? escHtml(p.station) + (p.stationMinutes ? ' 徒歩' + p.stationMinutes + '分' : '') : null],
    ['専有面積', p.area ? p.area + 'm²' + (p.buildingArea && p.buildingArea !== p.area ? '（建物 ' + p.buildingArea + 'm²）' : '') : null],
    ['間取り', p.rooms || null],
    ['築年数', p.age !== null && p.age !== undefined ? '築' + p.age + '年' : null],
    ['階数', p.floor ? p.floor + '階' : null],
    ['構造', p.structure || null],
    ['向き', p.direction || null],
    ['管理費', p.managementFee ? p.managementFee.toLocaleString() + '円/月' : null],
    ['修繕積立金', p.repairFund ? p.repairFund.toLocaleString() + '円/月' : null],
    ['表面利回り', p.yieldRate ? p.yieldRate.toFixed(2) + '%' : null],
    ['ステータス', isSold ? '売却済' + (p.soldAt ? '（' + p.soldAt.slice(0,10) + '）' : '') : '販売中'],
    ['物件ID', p.sitePropertyId || p.id || null],
  ].filter(function(r){ return r[1]; });

  var detailTableHtml = '<table class="detail-table">'
    + tableRows.map(function(r){ return '<tr><th>' + escHtml(r[0]) + '</th><td>' + (typeof r[1] === 'string' && r[1].startsWith('<') ? r[1] : escHtml(r[1])) + '</td></tr>'; }).join('')
    + '</table>';

  // ── 設備タグ ──
  var features = '';
  if (p.features && p.features.length > 0) {
    features = '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);margin-bottom:8px">設備・特徴</div>'
      + '<div class="features-wrap">' + p.features.map(function(f) { return '<span class="feature-tag">' + escHtml(f) + '</span>'; }).join('') + '</div></div>';
  }

  // ── 物件説明 ──
  var desc = p.description ? '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);margin-bottom:6px">物件説明</div><p style="font-size:13px;color:var(--c-text2);line-height:1.7">' + escHtml(p.description) + '</p></div>' : '';

  // ── Google Maps リンク ──
  var addressForMap = [prefName, p.city, p.address].filter(Boolean).join(' ');
  var mapsHref = addressForMap
    ? 'https://www.google.com/maps/search/' + encodeURIComponent(addressForMap)
    : (p.latitude && p.longitude ? 'https://www.google.com/maps?q=' + p.latitude + ',' + p.longitude : null);

  var favActive = isFavorite(p.id);

  // ── CTAボタン群 ──
  var ctaHtml = '<div class="modal-actions">'
    + (p.detailUrl ? '<a href="' + escAttr(p.detailUrl) + '" target="_blank" rel="noopener noreferrer" class="modal-cta" style="flex:1"><i class="fas fa-external-link-alt"></i>' + escHtml(site.name || 'サイト') + 'で詳細を見る</a>' : '')
    + (mapsHref ? '<a href="' + escAttr(mapsHref) + '" target="_blank" rel="noopener noreferrer" class="btn-map"><i class="fas fa-map-marker-alt"></i>地図</a>' : '')
    + '<button onclick="window.print()" class="btn-ghost" style="flex-shrink:0;padding:12px 18px;font-size:14px;font-weight:800;border-radius:10px" title="マイソク印刷"><i class="fas fa-print"></i></button>'
    + '</div>';

  document.getElementById('modalContent').innerHTML =
    // ── ヘッダー行 ──
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">'
    + '<span class="prop-badge-site" style="position:static;background:' + color + ';font-size:12px">' + (site.logo||'') + ' ' + escHtml(site.name||p.siteId) + '</span>'
    + '<div style="display:flex;align-items:center;gap:8px">'
    + '<button class="fav-btn' + (favActive ? ' active' : '') + '" data-fav-id="' + escAttr(p.id) + '" onclick="toggleFavorite(\'' + escAttr(p.id) + '\',\'' + escAttr(p.title) + '\')" title="' + (favActive ? 'お気に入り解除' : 'お気に入り追加') + '">❤️</button>'
    + '<button class="modal-close" onclick="closeModal()" aria-label="閉じる">&times;</button>'
    + '</div></div>'
    // ── 売却バナー ──
    + (isSold ? '<div class="sold-banner"><i class="fas fa-lock"></i> この物件は売却済みです</div>' : '')
    // ── 画像スライダー ──
    + sliderHtml
    // ── タイトル ──
    + '<h2 style="font-size:18px;font-weight:800;margin-bottom:10px;line-height:1.4">' + escHtml(p.title) + '</h2>'
    // ── スペックバッジ ──
    + specBadgesHtml
    // ── 価格 + 履歴 ──
    + priceBlockHtml
    // ── シミュレーター ──
    + simHtml
    // ── 詳細テーブル ──
    + '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);margin-bottom:8px">物件詳細</div>'
    + detailTableHtml + '</div>'
    // ── 間取り図 ──
    + floorPlanHtml
    // ── 設備タグ ──
    + features
    // ── 説明文 ──
    + desc
    // ── 掲載媒体 ──
    + buildSourcesSection(p)
    // ── CTA ──
    + ctaHtml;

  // シミュレーター初期計算
  if (p.price && p.price > 0 && !isSold) {
    var simId2 = 'sim_' + (p.id || 'x').replace(/[^a-z0-9]/gi,'_');
    calcSim(simId2, p.price, p.managementFee || 0, p.repairFund || 0);
  }
}

function openImg(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function closeModal() { document.getElementById('propertyModal').classList.add('hidden'); }

// ── Image Slider ──
function sliderGo(sliderId, indexOrDelta, isDelta) {
  var track = document.getElementById(sliderId);
  if (!track) return;
  var slides = track.querySelectorAll('.img-slider-slide');
  if (!slides.length) return;
  var slideW = track.clientWidth;
  var cur = Math.round(track.scrollLeft / (slideW || 1));
  var next;
  if (isDelta) {
    next = (cur + indexOrDelta + slides.length) % slides.length;
  } else {
    next = Math.max(0, Math.min(indexOrDelta, slides.length - 1));
  }
  track.scrollTo({ left: next * slideW, behavior: 'smooth' });
  updateSliderUI(sliderId, next, slides.length);
}
function sliderOnScroll(sliderId, total) {
  var track = document.getElementById(sliderId);
  if (!track) return;
  var slideW = track.clientWidth;
  var idx = Math.round(track.scrollLeft / (slideW || 1));
  updateSliderUI(sliderId, idx, total);
}
function updateSliderUI(sliderId, idx, total) {
  // dots
  var dotsEl = document.getElementById(sliderId + '_dots');
  if (dotsEl) {
    dotsEl.querySelectorAll('.img-slider-dot').forEach(function(d, i) {
      d.classList.toggle('active', i === idx);
    });
  }
  // count badge
  var countEl = document.getElementById(sliderId + '_count');
  if (countEl) countEl.textContent = (idx + 1) + ' / ' + total;
}

// ── Payment Simulator ──
function toggleSim(simId) {
  var body = document.getElementById(simId + '_body');
  var icon = document.getElementById(simId + '_icon');
  if (!body) return;
  var open = body.classList.toggle('open');
  if (icon) icon.style.transform = open ? 'rotate(180deg)' : '';
}
function calcSim(simId, priceMan, mgmtFee, repairFee) {
  var downEl = document.getElementById(simId + '_down');
  var rateEl = document.getElementById(simId + '_rate');
  var yearsEl = document.getElementById(simId + '_years');
  var mgmtEl = document.getElementById(simId + '_mgmt');
  var monthlyEl = document.getElementById(simId + '_monthly');
  var detailEl = document.getElementById(simId + '_detail');
  if (!downEl || !monthlyEl) return;
  var down = parseFloat(downEl.value) || 0;
  var annualRate = parseFloat(rateEl.value) || 0;
  var years = parseInt(yearsEl.value) || 35;
  var mgmt = parseInt(mgmtEl ? mgmtEl.value : String(mgmtFee)) || 0;
  var loanMan = priceMan - down;
  if (loanMan <= 0) {
    monthlyEl.textContent = '0円';
    if (detailEl) detailEl.textContent = '頭金で全額支払い';
    return;
  }
  var loanYen = loanMan * 10000;
  var n = years * 12;
  var monthly;
  if (annualRate <= 0) {
    monthly = Math.ceil(loanYen / n);
  } else {
    var r = annualRate / 100 / 12;
    monthly = Math.ceil(loanYen * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  }
  var repair = parseInt((document.getElementById(simId + '_mgmt') ? '0' : '0')) || repairFee;
  var total = monthly + mgmt + repair;
  monthlyEl.textContent = total.toLocaleString() + '円';
  if (detailEl) {
    var parts = ['ローン返済 ' + monthly.toLocaleString() + '円'];
    if (mgmt > 0) parts.push('管理費 ' + mgmt.toLocaleString() + '円');
    if (repair > 0) parts.push('修繕 ' + repair.toLocaleString() + '円');
    detailEl.textContent = parts.join(' + ');
  }
}

// ── Favorites Panel (simple snackbar-based list) ──
function showFavoritesPanel() {
  var keys = Object.keys(_favorites);
  if (keys.length === 0) {
    showSnackbar('お気に入りはまだありません', null);
    return;
  }
  // Show in stats modal area for simplicity
  document.getElementById('statsModal').classList.remove('hidden');
  document.getElementById('statsContent').innerHTML =
    '<div style="font-size:14px;font-weight:800;margin-bottom:16px">❤️ お気に入り (' + keys.length + '件)</div>'
    + keys.map(function(id) {
        var f = _favorites[id];
        var saved = f.savedAt ? new Date(f.savedAt).toLocaleDateString('ja-JP') : '';
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--c-border)">'
          + '<div style="flex:1"><div style="font-size:13px;font-weight:600">' + escHtml(f.title || id) + '</div>'
          + '<div style="font-size:11px;color:var(--c-text4)">' + escHtml(saved) + '</div></div>'
          + '<button onclick="showDetail(\'' + escAttr(id) + '\');closeStatsModal()" class="btn-ghost" style="font-size:12px;padding:5px 10px">詳細</button>'
          + '<button onclick="toggleFavorite(\'' + escAttr(id) + '\',\'' + escAttr((f.title||'')) + '\');showFavoritesPanel()" style="color:#e11d48;font-size:18px;background:none;border:none;cursor:pointer" aria-label="削除">&#10005;</button>'
          + '</div>';
      }).join('');
}

// ── Update Favorites Badge ──
function updateFavBadge() {
  var count = Object.keys(_favorites).length;
  var badge = document.getElementById('favCountBadge');
  if (!badge) return;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.classList.toggle('visible', count > 0);
}

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
  _savedSearchState = captureSearchState();

  ['searchQuery','priceMin','priceMax','areaMin','areaMax','yieldMin',
   'rentPriceMin','rentPriceMax','rentAreaMin','investPriceMin','investPriceMax','investYieldMin'
  ].forEach(function(id){ var el = document.getElementById(id); if (el) (el as HTMLInputElement).value = ''; });
  document.querySelectorAll('select').forEach(function(s){ (s as HTMLSelectElement).selectedIndex = 0; });
  // Reset buy type to "すべて"
  var firstBuyType = document.querySelector('input[name="buyType"]') as HTMLInputElement;
  if (firstBuyType) firstBuyType.checked = true;
  // Clear multi-select rooms
  document.querySelectorAll('.rooms-cb,.rent-rooms-cb').forEach(function(cb){ (cb as HTMLInputElement).checked = false; });
  updateRoomsDisplay(); updateRentRoomsDisplay();
  // Clear invest type
  document.querySelectorAll('.invest-type-cb').forEach(function(cb){ (cb as HTMLInputElement).checked = false; });
  // Clear preset chips
  document.querySelectorAll('.preset-chip').forEach(function(c){ c.classList.remove('active'); });
  clearPriceError();
  toggleAllSites(true);
  updatePriceLabel(); updateAreaLabel();
  document.getElementById('resultsContainer').innerHTML = '';
  document.getElementById('pagination').innerHTML = '';
  document.getElementById('siteSummary').innerHTML = '';
  document.getElementById('filterChips').innerHTML = '';
  document.getElementById('resultsBar').classList.remove('visible');
  document.getElementById('exportBar').classList.add('hidden');
  document.getElementById('initialState').classList.remove('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  currentResults = null;

  showSnackbar('検索条件をクリアしました', function(){ restoreSearchState(_savedSearchState); });
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
function updateRentPriceLabel() {
  var mn = document.getElementById('rentPriceMin').value, mx = document.getElementById('rentPriceMax').value;
  document.getElementById('rentPriceLabel').textContent = (mn||mx) ? (mn||'-')+'〜'+(mx||'-')+'万円/月' : '指定なし';
}
function updateInvestPriceLabel() {
  var mn = document.getElementById('investPriceMin').value, mx = document.getElementById('investPriceMax').value;
  document.getElementById('investPriceLabel').textContent = (mn||mx) ? (mn||'-')+'〜'+(mx||'-')+'万円' : '指定なし';
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
  }, 200);  // v6.2: 300ms → 200ms (体感反応性向上)
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

// ── CSV Export (検索結果から生成) ──
function exportCSV() {
  var props = currentResults && currentResults.properties;
  if (!props || props.length === 0) {
    showSnackbar('先に検索を実行してください', null);
    return;
  }
  var BOM = '﻿'; // Excel対応BOM (UTF-8)
  var cols = ['id','siteId','title','propertyType','status','prefecture','city','address',
    'price','priceText','area','rooms','age','floor','station','stationMinutes',
    'managementFee','repairFund','direction','structure','yieldRate',
    'thumbnailUrl','detailUrl','latitude','longitude','scrapedAt'];
  var esc = function(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var rows = [cols.join(',')].concat(props.map(function(p) {
    return cols.map(function(c) { return esc(p[c]); }).join(',');
  }));
  var csv = BOM + rows.join('\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'mal_' + new Date().toISOString().slice(0,10) + '_' + props.length + '件.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 1000);
  showSnackbar(props.length + '件のCSVをダウンロードしました', null);
}

// ── Tab Switching ──
var currentTab = 'properties';
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabProperties').classList.toggle('active', tab === 'properties');
  document.getElementById('tabMap').classList.toggle('active', tab === 'map');
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

  var mapPanel = document.getElementById('mapPanel');
  mapPanel.classList.toggle('hidden', tab !== 'map');
  if (tab === 'map') {
    initMapView();
  }

  var txPanel = document.getElementById('transactionsPanel');
  txPanel.classList.toggle('hidden', tab !== 'transactions');

  if (tab === 'transactions') {
    var pref = document.getElementById('prefecture').value || '13';
    loadTransactions(pref);
  }
}

// ── Map View (Leaflet.js) ──
var _mapInstance = null;
var _mapScriptLoaded = false;
function initMapView() {
  if (!currentResults || !currentResults.properties) return;
  var props = currentResults.properties.filter(function(p) {
    return p.latitude && p.longitude;
  }).slice(0, 500); // 最大500件

  var noteBar = document.getElementById('mapNoteBar');
  if (noteBar) noteBar.textContent = '地図に表示: ' + props.length + '件 (緯度経度あり) / 全' + (currentResults.total || 0) + '件';

  function renderMap() {
    var L = (window as any).L;
    if (!L) return;
    var mapEl = document.getElementById('propertyMap');
    if (!mapEl) return;

    // 既存マップを破棄
    if (_mapInstance) {
      try { _mapInstance.remove(); } catch(e) {}
      _mapInstance = null;
    }

    if (props.length === 0) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--c-text3);font-size:14px">緯度経度情報がある物件がありません</div>';
      return;
    }

    // 中心座標を平均で計算
    var avgLat = props.reduce(function(s, p) { return s + p.latitude; }, 0) / props.length;
    var avgLng = props.reduce(function(s, p) { return s + p.longitude; }, 0) / props.length;

    _mapInstance = L.map('propertyMap').setView([avgLat, avgLng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_mapInstance);

    // マーカー追加
    props.forEach(function(p) {
      var site = SITES_DATA[p.siteId] || {};
      var priceStr = p.price ? p.price.toLocaleString() + '万円' : (p.priceText || '価格要相談');
      var popup = L.popup({ maxWidth: 260 }).setContent(
        '<div class="map-popup-title">' + escHtml(p.title) + '</div>'
        + '<div class="map-popup-price">' + escHtml(priceStr) + '</div>'
        + '<div class="map-popup-spec">'
        + (p.rooms ? p.rooms + ' / ' : '')
        + (p.area ? p.area + 'm² / ' : '')
        + (p.age !== null && p.age !== undefined ? '築' + p.age + '年' : '')
        + '</div>'
        + '<a class="map-popup-link" href="#" onclick="event.preventDefault();switchTab(\'properties\');showDetail(\'' + escAttr(p.id) + '\')">'
        + '詳細を見る →</a>'
      );
      var color = site.color || '#2563eb';
      var icon = L.divIcon({
        className: '',
        html: '<div style="background:' + color + ';width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      L.marker([p.latitude, p.longitude], { icon: icon }).bindPopup(popup).addTo(_mapInstance);
    });

    // フィット
    try {
      var bounds = L.latLngBounds(props.map(function(p) { return [p.latitude, p.longitude]; }));
      _mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } catch(e) {}
  }

  if (!_mapScriptLoaded) {
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function() { _mapScriptLoaded = true; renderMap(); };
    document.head.appendChild(s);
  } else {
    renderMap();
  }
}

// ── Favorites (localStorage) ──
var _favorites = (function() {
  try { return JSON.parse(localStorage.getItem('mal_favorites_v1') || '{}'); } catch(e) { return {}; }
})();
function saveFavorites() {
  try { localStorage.setItem('mal_favorites_v1', JSON.stringify(_favorites)); } catch(e) {}
}
function isFavorite(id) { return !!_favorites[id]; }
function toggleFavorite(id, title) {
  if (_favorites[id]) {
    delete _favorites[id];
    showSnackbar('お気に入りから削除しました', null);
  } else {
    _favorites[id] = { title: title, savedAt: Date.now() };
    showSnackbar('お気に入りに追加しました ❤️', null);
  }
  saveFavorites();
  updateFavBadge();
  // ボタン更新
  document.querySelectorAll('[data-fav-id="' + id + '"]').forEach(function(btn) {
    btn.classList.toggle('active', !!_favorites[id]);
    btn.title = _favorites[id] ? 'お気に入り解除' : 'お気に入り追加';
  });
}

// ── Price History Mini Chart ──
function buildPriceHistoryChart(history) {
  if (!history || history.length < 2) return '';
  var prices = history.map(function(h) { return h.price; });
  var min = Math.min.apply(null, prices);
  var max = Math.max.apply(null, prices);
  var range = max - min || 1;
  var bars = prices.map(function(p, i) {
    var pct = Math.round(((p - min) / range) * 80) + 20; // 20〜100%
    var date = history[i].date ? history[i].date.slice(0, 7) : '';
    var priceStr = p.toLocaleString() + '万円';
    return '<div class="price-bar" style="height:' + pct + '%">'
      + '<div class="price-bar-tip">' + escHtml(date) + '<br>' + escHtml(priceStr) + '</div>'
      + '</div>';
  }).join('');
  var oldPrice = prices[0];
  var newPrice = prices[prices.length - 1];
  var diff = newPrice - oldPrice;
  var diffStr = diff > 0 ? '+' + diff.toLocaleString() + '万円↑' : diff < 0 ? diff.toLocaleString() + '万円↓' : '変動なし';
  var diffColor = diff > 0 ? 'var(--c-danger)' : diff < 0 ? 'var(--c-success)' : 'var(--c-text3)';
  return '<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:700;color:var(--c-text3);margin-bottom:4px">価格履歴 <span style="color:' + diffColor + ';font-size:12px">' + escHtml(diffStr) + '</span></div>'
    + '<div class="price-history-chart">' + bars + '</div>'
    + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--c-text4)">'
    + '<span>' + escHtml(history[0].date ? history[0].date.slice(0,7) : '') + '</span>'
    + '<span>' + escHtml(history[history.length-1].date ? history[history.length-1].date.slice(0,7) : '') + '</span>'
    + '</div></div>';
}

// ── Scroll To Top ──
(function() {
  var btn = document.getElementById('scrollTopBtn');
  if (!btn) return;
  window.addEventListener('scroll', function() {
    btn.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });
})();

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

// ── Import History Modal ──
async function showImportHistoryModal() {
  document.getElementById('importHistoryModal').classList.remove('hidden');
  await loadImportHistory();
}
function closeImportHistoryModal() {
  document.getElementById('importHistoryModal').classList.add('hidden');
}

async function loadImportHistory() {
  var days = document.getElementById('importHistoryDays').value || '30';
  var secret = localStorage.getItem('mal_admin_secret') || '';
  if (!secret) {
    secret = window.prompt('ADMIN_SECRET を入力してください:') || '';
    if (secret) { try { localStorage.setItem('mal_admin_secret', secret); } catch(e) {} }
  }
  if (!secret) {
    document.getElementById('importHistoryContent').innerHTML =
      '<p style="text-align:center;color:var(--c-text3);padding:24px">認証情報が必要です</p>';
    return;
  }

  document.getElementById('importHistoryContent').innerHTML =
    '<div style="text-align:center;padding:40px 0"><i class="fas fa-spinner fa-spin" style="font-size:32px;color:var(--c-primary)"></i></div>';

  try {
    var headers = { 'Authorization': 'Bearer ' + secret };
    var [summaryRes, delistedRes] = await Promise.all([
      fetch('/api/admin/sessions/summary?days=' + days, { headers: headers }),
      fetch('/api/admin/stats/delisted?days=' + days, { headers: headers }),
    ]);

    if (summaryRes.status === 401 || delistedRes.status === 401) {
      try { localStorage.removeItem('mal_admin_secret'); } catch(e) {}
      document.getElementById('importHistoryContent').innerHTML =
        '<p style="text-align:center;color:var(--c-danger);padding:24px">認証エラー。ページを再読み込みして再入力してください。</p>';
      return;
    }

    var summaryData = summaryRes.ok ? await summaryRes.json() : { sessions: [] };
    var delistedData = delistedRes.ok ? await delistedRes.json() : { data: [] };
    renderImportHistory(summaryData.sessions || [], delistedData.data || []);
  } catch(e) {
    document.getElementById('importHistoryContent').innerHTML =
      '<p style="text-align:center;color:var(--c-text3);padding:24px">データを取得できませんでした</p>';
  }
}

function renderImportHistory(sessions, delistedData) {
  var html = '';

  // ── delisted 日次グラフ ──
  if (delistedData.length > 0) {
    var maxCount = Math.max.apply(null, delistedData.map(function(d) { return d.count; })) || 1;
    var bars = delistedData.map(function(d) {
      var pct = Math.max(2, Math.round((d.count / maxCount) * 100));
      var color = d.warning ? 'var(--c-danger)' : 'var(--c-primary)';
      var label = d.warning ? ' ⚠️' : '';
      var dateShort = String(d.date || '').slice(5); // MM-DD
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
        + '<span style="width:40px;font-size:10px;color:var(--c-text4);text-align:right;flex-shrink:0">' + escHtml(dateShort) + '</span>'
        + '<div style="flex:1;background:var(--c-border);border-radius:3px;height:16px;position:relative">'
        + '<div style="width:' + pct + '%;background:' + color + ';height:100%;border-radius:3px"></div>'
        + '</div>'
        + '<span style="width:60px;font-size:11px;font-weight:700;color:' + color + ';flex-shrink:0">' + d.count.toLocaleString() + label + '</span>'
        + '</div>';
    }).join('');

    html += '<div style="margin-bottom:20px">'
      + '<div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px">Delisted 日次件数</div>'
      + bars
      + '<div style="font-size:10px;color:var(--c-text4);margin-top:6px">⚠️ = 前日比 3倍超</div>'
      + '</div>';
  } else {
    html += '<div style="padding:16px;background:var(--c-bg2);border-radius:8px;margin-bottom:20px;color:var(--c-text3);font-size:13px;text-align:center">Delisted データなし</div>';
  }

  // ── セッション一覧テーブル ──
  html += '<div style="font-size:11px;font-weight:700;color:var(--c-text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:10px">セッション一覧</div>';

  if (!sessions.length) {
    html += '<div style="text-align:center;padding:24px;color:var(--c-text3)">セッションデータなし</div>';
  } else {
    var statusColor = { completed: 'var(--c-success)', aborted: 'var(--c-danger)', in_progress: 'var(--c-warning)', failed: 'var(--c-danger)' };
    var rows = sessions.map(function(s) {
      var sc = statusColor[s.status] || 'var(--c-text3)';
      var startedDate = String(s.started_at || '').slice(0, 16).replace('T', ' ');
      var completedDate = s.completed_at ? String(s.completed_at).slice(0, 16).replace('T', ' ') : '-';
      var delisted = (s.total_marked_delisted || 0).toLocaleString();
      var imported = (s.total_imported || 0).toLocaleString();
      var notesHtml = s.notes ? '<div style="font-size:10px;color:var(--c-text4);margin-top:2px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(s.notes) + '">' + escHtml(s.notes) + '</div>' : '';
      return '<tr>'
        + '<td style="font-size:11px;color:var(--c-text3)">' + escHtml(startedDate) + '</td>'
        + '<td style="font-size:11px;color:var(--c-text3)">' + escHtml(completedDate) + '</td>'
        + '<td><span style="font-size:11px;font-weight:700;color:' + sc + '">' + escHtml(s.status) + '</span></td>'
        + '<td style="text-align:right;font-weight:700">' + escHtml(imported) + '</td>'
        + '<td style="text-align:right;font-weight:700;color:var(--c-danger)">' + escHtml(delisted) + '</td>'
        + '<td style="font-size:11px">' + escHtml(s.source || '') + notesHtml + '</td>'
        + '</tr>';
    }).join('');

    html += '<div style="overflow-x:auto"><table class="txn-table" style="font-size:12px">'
      + '<thead><tr><th>開始</th><th>完了</th><th>状態</th><th style="text-align:right">取込件数</th><th style="text-align:right">Delisted</th><th>備考</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table></div>';
  }

  document.getElementById('importHistoryContent').innerHTML = html;
}

// ── Init ──
(function() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeModal(); closeStatsModal(); closeImportHistoryModal(); }
  });
})();
</script>
</body>
</html>`;
}
