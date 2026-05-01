import { Hono } from 'hono';
import type { Bindings } from '../types';
import type { AdminStats, SiteId, PrefectureCode } from '../types';
import { enqueueAll, processQueue } from '../services/image-pipeline';
import { runScheduledScrape } from '../scrapers/aggregator';
import { archiveOldestCold } from '../services/archive';
import { discoverTerassImages } from '../services/terass-image-fetch';
import { buildMasters, buildAllMasters } from '../services/master-builder';
import { getWriteDB } from '../db/queries';

const admin = new Hono<{ Bindings: Bindings }>();

/** Safely run a D1 query; returns null if the table doesn't exist yet (migration pending). */
async function safeFirst<T>(stmt: D1PreparedStatement): Promise<T | null> {
  try { return await stmt.first<T>(); } catch { return null; }
}
async function safeAll<T>(stmt: D1PreparedStatement): Promise<{ results: T[] }> {
  try {
    const r = await stmt.all<T>();
    return { results: r.results ?? [] };
  } catch { return { results: [] }; }
}

/** D1 実サイズ (MB) — PRAGMA page_count × page_size。失敗時は properties 行数 × 635B で概算。 */
async function getD1SizeMb(db: D1Database): Promise<number> {
  try {
    const pc = await db.prepare('PRAGMA page_count').first<{ page_count: number }>();
    const ps = await db.prepare('PRAGMA page_size').first<{ page_size: number }>();
    if (pc?.page_count && ps?.page_size) {
      return Math.round((pc.page_count * ps.page_size) / 1024 / 1024);
    }
  } catch { /* ignore */ }
  // フォールバック: properties 1行 ≈ 635 バイト (実測値、cron handler と同係数)
  try {
    const cap = await db.prepare('SELECT COUNT(*) AS n FROM properties').first<{ n: number }>();
    if (cap?.n) return Math.round((cap.n * 635) / 1024 / 1024);
  } catch { /* ignore */ }
  return 0;
}

/** R2 全オブジェクトサイズ合計 (MB)。KV キャッシュ 1h で list コストを抑制。
 *  最大 100,000 オブジェクト (= 100 list calls) で打ち切り、それ以降は推定値に切替。*/
async function getR2SizeMb(env: Bindings): Promise<{ mb: number; objectCount: number; truncated: boolean; cached: boolean }> {
  const CACHE_KEY = 'admin:r2-size-v1';
  const TTL_SEC = 3600;
  try {
    const cached = await env.MAL_CACHE.get(CACHE_KEY, { type: 'json' }) as
      | { mb: number; objectCount: number; truncated: boolean; ts: number }
      | null;
    if (cached && Date.now() - cached.ts < TTL_SEC * 1000) {
      return { mb: cached.mb, objectCount: cached.objectCount, truncated: cached.truncated, cached: true };
    }
  } catch { /* fallthrough */ }

  let totalBytes = 0;
  let count = 0;
  let cursor: string | undefined = undefined;
  let truncated = false;
  const MAX_LIST_CALLS = 100;
  for (let i = 0; i < MAX_LIST_CALLS; i++) {
    const r: R2Objects = await env.MAL_STORAGE.list({ limit: 1000, cursor });
    for (const obj of r.objects) {
      totalBytes += obj.size;
      count++;
    }
    if (!r.truncated) { cursor = undefined; break; }
    cursor = (r as R2Objects & { cursor?: string }).cursor;
    if (!cursor) break;
    if (i === MAX_LIST_CALLS - 1) truncated = true;
  }
  const mb = Math.round(totalBytes / 1024 / 1024);
  // best-effort cache write (failures don't break stats)
  try {
    await env.MAL_CACHE.put(
      CACHE_KEY,
      JSON.stringify({ mb, objectCount: count, truncated, ts: Date.now() }),
      { expirationTtl: TTL_SEC },
    );
  } catch { /* ignore */ }
  return { mb, objectCount: count, truncated, cached: false };
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
admin.get('/stats', async (c) => {
  const db = c.env.MAL_DB;

  const [
    activeRow, soldRow, delistedRow, totalRow, dupRow,
    totalImgRow, dlImgRow, pendingDlRow, mysokuRow, txnRow,
    siteRows, prefRows, lastScrapeRow, lastCsvRow,
    dbSizeMb, r2Size,
  ] = await Promise.all([
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM properties WHERE status='active'`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM properties WHERE status='sold'`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM properties WHERE status='delisted'`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM properties`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(DISTINCT fingerprint) as cnt FROM properties WHERE fingerprint IS NOT NULL`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM property_images`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM property_images WHERE download_status='downloaded'`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM download_queue WHERE status='pending'`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM property_mysoku`)),
    safeFirst<{ cnt: number }>(db.prepare(`SELECT COUNT(*) as cnt FROM transaction_records`)),
    safeAll<{ site_id: SiteId; cnt: number; sold_cnt: number }>(db.prepare(`SELECT site_id, COUNT(*) as cnt, COUNT(CASE WHEN status='sold' THEN 1 END) as sold_cnt FROM properties GROUP BY site_id`)),
    safeAll<{ prefecture: PrefectureCode; cnt: number }>(db.prepare(`SELECT prefecture, COUNT(*) as cnt FROM properties WHERE status='active' GROUP BY prefecture ORDER BY cnt DESC LIMIT 20`)),
    safeFirst<{ val: string | null }>(db.prepare(`SELECT MAX(completed_at) as val FROM scrape_jobs WHERE status='completed'`)),
    safeFirst<{ val: string | null }>(db.prepare(`SELECT MAX(completed_at) as val FROM csv_imports WHERE status='completed'`)),
    getD1SizeMb(db),
    getR2SizeMb(c.env),
  ]);

  const stats: AdminStats = {
    activeProperties:    activeRow?.cnt ?? 0,
    soldProperties:      soldRow?.cnt ?? 0,
    delistedProperties:  delistedRow?.cnt ?? 0,
    totalProperties:     totalRow?.cnt ?? 0,
    duplicateGroups:     dupRow?.cnt ?? 0,
    totalImages:         totalImgRow?.cnt ?? 0,
    downloadedImages:    dlImgRow?.cnt ?? 0,
    pendingDownloads:    pendingDlRow?.cnt ?? 0,
    totalMysoku:         mysokuRow?.cnt ?? 0,
    totalTransactions:   txnRow?.cnt ?? 0,
    r2StorageEstimatedMb: r2Size.mb,
    dbSizeEstimatedMb:    dbSizeMb,
    siteBreakdown: (siteRows.results ?? []).map(r => ({
      siteId: r.site_id,
      count:  r.cnt,
      sold:   r.sold_cnt,
    })),
    prefectureBreakdown: (prefRows.results ?? []).map(r => ({
      prefecture: r.prefecture,
      count:      r.cnt,
    })),
    lastScrapeAt:    lastScrapeRow?.val ?? null,
    lastCsvImportAt: lastCsvRow?.val ?? null,
  };

  return c.json(stats);
});

// ─── GET /api/admin/export.csv ────────────────────────────────────────────────
admin.get('/export.csv', async (c) => {
  const env = c.env;
  const q = c.req.query();

  const whereParts: string[] = [];
  const bindings: (string | number)[] = [];

  const status = q.status ?? 'active';
  whereParts.push('status = ?');
  bindings.push(status);

  if (q.prefecture) { whereParts.push('prefecture = ?'); bindings.push(q.prefecture); }
  if (q.siteId)     { whereParts.push('site_id = ?');    bindings.push(q.siteId); }
  if (q.propertyType) { whereParts.push('property_type = ?'); bindings.push(q.propertyType); }

  const whereClause = whereParts.join(' AND ');

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const headers = new Headers({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="mal_properties_${dateStr}.csv"`,
  });

  const HEADER = 'id,site_id,title,property_type,status,prefecture,city,address,price,price_text,area,rooms,age,floor,station,station_minutes,management_fee,repair_fund,direction,structure,yield_rate,thumbnail_url,detail_url,description,fingerprint,latitude,longitude,listed_at,sold_at,last_seen_at,created_at,updated_at';

  function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function rowToCsv(row: Record<string, unknown>): string {
    return [
      row.id, row.site_id, row.title, row.property_type, row.status,
      row.prefecture, row.city, row.address, row.price, row.price_text,
      row.area, row.rooms, row.age, row.floor, row.station, row.station_minutes,
      row.management_fee, row.repair_fund, row.direction, row.structure,
      row.yield_rate, row.thumbnail_url, row.detail_url, row.description,
      row.fingerprint, row.latitude, row.longitude,
      row.listed_at, row.sold_at, row.last_seen_at, row.created_at, row.updated_at,
    ].map(escapeCsv).join(',');
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  // CPU/メモリ暴走防御: ?max_rows= で上限指定 (デフォルト 100,000、最大 500,000)
  // properties は 60 万件超のため上限なしだと Worker の 30s CPU 制限を超過する
  const maxRows = Math.min(Number(c.req.query('max_rows') ?? 100000) || 100000, 500000);

  c.executionCtx.waitUntil((async () => {
    try {
      await writer.write(enc.encode(HEADER + '\n'));
      let offset = 0;
      let written = 0;
      while (written < maxRows) {
        const remaining = maxRows - written;
        const pageLimit = Math.min(1000, remaining);
        const rows = await env.MAL_DB.prepare(
          `SELECT * FROM properties WHERE ${whereClause} LIMIT ? OFFSET ?`
        ).bind(...bindings, pageLimit, offset).all<Record<string, unknown>>();
        if (!rows.results?.length) break;
        for (const row of rows.results) {
          await writer.write(enc.encode(rowToCsv(row) + '\n'));
          written++;
        }
        offset += pageLimit;
        if (rows.results.length < pageLimit) break;
      }
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, { headers });
});

// ─── POST /api/admin/import-properties ───────────────────────────────────────
// スクレイパーからのJSONプロパティ直接インポート (camelCase対応)
admin.post('/import-properties', async (c) => {
  const env = c.env;

  type PropInput = {
    siteId?: string; site_id?: string;
    sitePropertyId?: string; site_property_id?: string;
    title?: string;
    propertyType?: string; property_type?: string;
    status?: string;
    prefecture?: string;
    city?: string;
    address?: string;
    price?: number | string | null;
    priceText?: string; price_text?: string;
    area?: number | string | null;
    rooms?: string | null;
    age?: number | string | null;
    floor?: number | string | null;
    station?: string | null;
    stationMinutes?: number | string | null; station_minutes?: number | string | null;
    managementFee?: number | string | null; management_fee?: number | string | null;
    repairFund?: number | string | null; repair_fund?: number | string | null;
    direction?: string | null;
    structure?: string | null;
    yieldRate?: number | string | null; yield_rate?: number | string | null;
    thumbnailUrl?: string | null; thumbnail_url?: string | null;
    detailUrl?: string; detail_url?: string;
    description?: string | null;
    fingerprint?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
    listedAt?: string | null; listed_at?: string | null;
    soldAt?: string | null; sold_at?: string | null;
  };

  let properties: PropInput[];
  try {
    const body = await c.req.json<{ properties: PropInput[] }>();
    properties = body.properties;
    if (!Array.isArray(properties)) throw new Error('properties must be array');
  } catch {
    return c.json({ error: 'JSON body with {properties: [...]} required' }, 400);
  }

  const db = getWriteDB(env);
  let imported = 0, skipped = 0, errors = 0;

  for (const p of properties) {
    const siteId = p.siteId ?? p.site_id ?? '';
    const sitePropertyId = p.sitePropertyId ?? p.site_property_id ?? '';
    if (!siteId || !sitePropertyId) { skipped++; continue; }

    const id = `${siteId}_${sitePropertyId}`;
    const num = (v: unknown) => (v !== null && v !== undefined && v !== '') ? Number(v) : null;
    const str = (v: unknown) => (v !== null && v !== undefined) ? String(v) : null;

    try {
      await db.prepare(`
        INSERT INTO properties (
          id, site_id, site_property_id, title, property_type, status,
          prefecture, city, address, price, price_text, area,
          rooms, age, floor, station, station_minutes,
          management_fee, repair_fund, direction, structure,
          yield_rate, thumbnail_url, detail_url, description,
          fingerprint, latitude, longitude,
          listed_at, sold_at, last_seen_at, import_session_id,
          created_at, updated_at, scraped_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, datetime('now'), null,
          datetime('now'), datetime('now'), datetime('now')
        )
        ON CONFLICT(site_id, site_property_id) DO UPDATE SET
          title          = excluded.title,
          price          = excluded.price,
          price_text     = excluded.price_text,
          status         = excluded.status,
          description    = excluded.description,
          fingerprint    = excluded.fingerprint,
          yield_rate     = excluded.yield_rate,
          thumbnail_url  = excluded.thumbnail_url,
          last_seen_at   = datetime('now'),
          updated_at     = datetime('now')
      `).bind(
        id, siteId, sitePropertyId,
        str(p.title) ?? '', str(p.propertyType ?? p.property_type) ?? 'other', str(p.status) ?? 'active',
        str(p.prefecture) ?? '13', str(p.city) ?? '', str(p.address),
        num(p.price), str(p.priceText ?? p.price_text) ?? '',
        num(p.area),
        str(p.rooms),
        num(p.age), num(p.floor),
        str(p.station), num(p.stationMinutes ?? p.station_minutes),
        num(p.managementFee ?? p.management_fee), num(p.repairFund ?? p.repair_fund),
        str(p.direction), str(p.structure),
        num(p.yieldRate ?? p.yield_rate),
        str(p.thumbnailUrl ?? p.thumbnail_url), str(p.detailUrl ?? p.detail_url) ?? '',
        str(p.description),
        str(p.fingerprint),
        num(p.latitude), num(p.longitude),
        str(p.listedAt ?? p.listed_at), str(p.soldAt ?? p.sold_at),
      ).run();
      imported++;
    } catch (e) {
      errors++;
      console.error(`[import-properties] error on ${id}:`, e);
    }
  }

  return c.json({ imported, skipped, errors });
});

// ─── POST /api/admin/import/session/start ────────────────────────────────────
// TERASS フルインポート1回分のセッションを作成 (delisted 検知の基準点)
admin.post('/import/session/start', async (c) => {
  let body: { source?: string };
  try {
    body = await c.req.json<{ source?: string }>();
  } catch {
    body = {};
  }
  const source = body.source || 'terass';
  const sessionId = crypto.randomUUID();
  await c.env.MAL_DB.prepare(`
    INSERT INTO import_sessions (id, source, started_at, status, categories_json, total_imported)
    VALUES (?, ?, datetime('now'), 'in_progress', '{}', 0)
  `).bind(sessionId, source).run();
  return c.json({ sessionId });
});

// ─── POST /api/admin/import/session/complete ─────────────────────────────────
// session で touch されなかった active 物件を delisted にマーク。
// hit_export_limit=true のカテゴリは TERASS 10000 行打ち切り発生のため除外。
admin.post('/import/session/complete', async (c) => {
  const sessionId = c.req.query('session');
  if (!sessionId) return c.json({ error: 'session query parameter required' }, 400);
  const dryRun = c.req.query('dry_run') === '1' || c.req.query('dry_run') === 'true';
  const abortThreshold = Math.max(0, Math.min(1, Number(c.req.query('abort_threshold') ?? '0.30') || 0.30));

  const db = c.env.MAL_DB;
  const sessionRow = await safeFirst<{
    id: string; source: string; status: string;
    categories_json: string | null; total_imported: number;
  }>(db.prepare(`SELECT id, source, status, categories_json, total_imported FROM import_sessions WHERE id=?`).bind(sessionId));
  if (!sessionRow) return c.json({ error: 'session not found' }, 404);

  let categories: Record<string, { rowCount?: number; hitLimit?: boolean }> = {};
  try { categories = JSON.parse(sessionRow.categories_json || '{}'); } catch { categories = {}; }

  // インポート 0 件のセッションは自動 abort (TERASS 全失敗を保護)
  // ただし「処理行数 > 0 だが全件重複スキップ」は健全な状態として通す。
  // 旧仕様だと毎回バックフィル時に誤 ABORT で delisted 検知が永久停止していた。
  const totalProcessed = Object.values(categories).reduce<number>(
    (sum, c) => sum + (typeof c.rowCount === 'number' ? c.rowCount : 0),
    0
  );
  if ((sessionRow.total_imported ?? 0) === 0 && totalProcessed === 0) {
    await db.prepare(`
      UPDATE import_sessions
      SET status='aborted', completed_at=datetime('now'),
          notes='auto-aborted: zero imports and zero processed'
      WHERE id=?
    `).bind(sessionId).run();
    return c.json({ sessionId, dryRun, aborted: true, reason: 'zero_imports', byCategory: {}, totalMarkedDelisted: 0, ratio: 0 });
  }

  // カテゴリキー → (property_type, status) フィルタ
  const CAT_MAP: Record<string, { property_type: string; status: string }> = {
    mansion_active: { property_type: 'mansion', status: 'active' },
    mansion_sold:   { property_type: 'mansion', status: 'sold'   },
    house_active:   { property_type: 'kodate',  status: 'active' },
    house_sold:     { property_type: 'kodate',  status: 'sold'   },
    land_active:    { property_type: 'tochi',   status: 'active' },
    land_sold:      { property_type: 'tochi',   status: 'sold'   },
  };

  // delisted 検知は active 物件のみが対象 (sold 物件は触らない)
  const targetCats = Object.entries(categories)
    .filter(([key, info]) => {
      const m = CAT_MAP[key];
      return m && m.status === 'active' && !info.hitLimit;
    })
    .map(([key]) => key);

  const byCategory: Record<string, { candidates: number; activeTotal: number; ratio: number; marked: number; skipped?: string }> = {};
  // hitLimit カテゴリも記録 (skipped)
  for (const [key, info] of Object.entries(categories)) {
    const m = CAT_MAP[key];
    if (!m) continue;
    if (m.status === 'active' && info.hitLimit) {
      byCategory[key] = { candidates: 0, activeTotal: 0, ratio: 0, marked: 0, skipped: 'hit_export_limit' };
    }
  }

  let aggregateCandidates = 0;
  let aggregateActiveTotal = 0;

  for (const key of targetCats) {
    const m = CAT_MAP[key]!;
    const candRow = await safeFirst<{ cnt: number }>(db.prepare(`
      SELECT COUNT(*) as cnt FROM properties
      WHERE site_id IN ('terass_reins', 'terass_suumo', 'terass_athome')
        AND property_type = ?
        AND status = 'active'
        AND (import_session_id IS NULL OR import_session_id != ?)
    `).bind(m.property_type, sessionId));
    const totalRow = await safeFirst<{ cnt: number }>(db.prepare(`
      SELECT COUNT(*) as cnt FROM properties
      WHERE site_id IN ('terass_reins', 'terass_suumo', 'terass_athome')
        AND property_type = ?
        AND status = 'active'
    `).bind(m.property_type));
    const candidates = candRow?.cnt ?? 0;
    const activeTotal = totalRow?.cnt ?? 0;
    const ratio = activeTotal > 0 ? candidates / activeTotal : 0;
    byCategory[key] = { candidates, activeTotal, ratio, marked: 0 };
    aggregateCandidates += candidates;
    aggregateActiveTotal += activeTotal;
  }

  const overallRatio = aggregateActiveTotal > 0 ? aggregateCandidates / aggregateActiveTotal : 0;

  // 閾値超え → abort (DB 書き換えなし)
  if (overallRatio > abortThreshold) {
    await db.prepare(`
      UPDATE import_sessions
      SET status='aborted', completed_at=datetime('now'),
          notes=?
      WHERE id=?
    `).bind(`threshold_exceeded ratio=${overallRatio.toFixed(4)} threshold=${abortThreshold}`, sessionId).run();
    return c.json({
      sessionId, dryRun, aborted: true, reason: 'threshold_exceeded',
      ratio: overallRatio, threshold: abortThreshold, byCategory,
      totalMarkedDelisted: 0,
    });
  }

  if (dryRun) {
    return c.json({
      sessionId, dryRun: true, aborted: false,
      ratio: overallRatio, byCategory, totalMarkedDelisted: 0,
    });
  }

  // 本番: UPDATE で delisted マーク
  let totalMarked = 0;
  for (const key of targetCats) {
    const m = CAT_MAP[key]!;
    // 注: properties に delisted_at 列は存在しない (schema 0001-0006 確認済み)。
    // sold_at を「ステータス変更日」として流用 (aggregator も sold マーク時に sold_at を使用)。
    const r = await db.prepare(`
      UPDATE properties
      SET status='delisted', sold_at=datetime('now'), updated_at=datetime('now')
      WHERE site_id IN ('terass_reins', 'terass_suumo', 'terass_athome')
        AND property_type = ?
        AND status = 'active'
        AND (import_session_id IS NULL OR import_session_id != ?)
    `).bind(m.property_type, sessionId).run();
    const marked = (r.meta?.changes as number | undefined) ?? 0;
    byCategory[key].marked = marked;
    totalMarked += marked;
  }

  await db.prepare(`
    UPDATE import_sessions
    SET status='completed', completed_at=datetime('now'),
        total_marked_delisted=?
    WHERE id=?
  `).bind(totalMarked, sessionId).run();

  return c.json({
    sessionId, dryRun: false, aborted: false,
    ratio: overallRatio, byCategory, totalMarkedDelisted: totalMarked,
  });
});

// ─── POST /api/admin/mark-delisted ───────────────────────────────────────────
// 最終確認日時が古い物件を delisted に一括変更 (掲載落ち自動検知)
// Body: { days?: number } — デフォルト 30日
admin.post('/mark-delisted', async (c) => {
  const db = c.env.MAL_DB;
  const body = await c.req.json<{ days?: number }>().catch(() => ({ days: 30 })) as { days?: number };
  const days = Math.max(1, Math.min(Number(body?.days ?? 30), 365));

  const result = await db.prepare(`
    UPDATE properties
    SET status = 'delisted', updated_at = datetime('now')
    WHERE status = 'active'
      AND last_seen_at IS NOT NULL
      AND last_seen_at < datetime('now', '-' || ? || ' days')
  `).bind(days).run();

  const changes = (result.meta?.changes as number | undefined) ?? 0;
  return c.json({ delisted: changes, days, message: `${changes}件を掲載落ちとしてマークしました` });
});

// ─── POST /api/admin/rebuild-fts ─────────────────────────────────────────────
// FTS5仮想テーブルを既存 properties から再構築 (migration 0008 適用後に1回実行)
// 大量データは batchSize 単位で分割処理 (30s CPU制限対策)
admin.post('/rebuild-fts', async (c) => {
  const db = c.env.MAL_DB;
  const body = await c.req.json<{ batchSize?: number; offset?: number }>().catch(() => ({ batchSize: 5000, offset: 0 })) as { batchSize?: number; offset?: number };
  const batchSize = Math.min(Number(body?.batchSize ?? 5000), 10000);
  const startOffset = Math.max(0, Number(body?.offset ?? 0));

  // 既存FTSインデックスを削除してから再挿入 (offset=0のときのみ)
  if (startOffset === 0) {
    try {
      await db.prepare(`DELETE FROM properties_fts`).run();
    } catch { /* table may not exist yet */ }
  }

  const rows = await db.prepare(`
    SELECT rowid, title, address, city, station, description
    FROM properties
    ORDER BY rowid
    LIMIT ? OFFSET ?
  `).bind(batchSize, startOffset).all<{
    rowid: number; title: string; address: string | null;
    city: string | null; station: string | null; description: string | null;
  }>();

  const items = rows.results ?? [];
  let inserted = 0;
  for (const row of items) {
    try {
      await db.prepare(`
        INSERT INTO properties_fts(rowid, title, address, city, station, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        row.rowid,
        row.title ?? '',
        row.address ?? '',
        row.city ?? '',
        row.station ?? '',
        row.description ?? ''
      ).run();
      inserted++;
    } catch { /* skip duplicate rowid */ }
  }

  const nextOffset = startOffset + items.length;
  const hasMore = items.length === batchSize;

  return c.json({
    inserted, batchSize, offset: startOffset, nextOffset,
    hasMore,
    message: hasMore
      ? `${inserted}件挿入。次のバッチ: POST /api/admin/rebuild-fts { "offset": ${nextOffset} }`
      : `FTS5再構築完了 (total offset: ${nextOffset})`,
  });
});

// ─── GET /api/admin/suggest-extended ─────────────────────────────────────────
// city + station 両方を対象としたサジェスト (公開/api/suggest の拡張版)
admin.get('/suggest-extended', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q || q.length < 2) return c.json({ suggestions: [] });
  const db = c.env.MAL_DB;
  const [cities, stations] = await Promise.all([
    db.prepare(`SELECT DISTINCT city as val FROM properties WHERE city LIKE ? AND status='active' LIMIT 8`)
      .bind(`%${q}%`).all<{ val: string }>(),
    db.prepare(`SELECT DISTINCT station as val FROM properties WHERE station LIKE ? AND status='active' AND station IS NOT NULL LIMIT 6`)
      .bind(`%${q}%`).all<{ val: string }>(),
  ]);
  const suggestions = [
    ...(cities.results ?? []).map(r => r.val),
    ...(stations.results ?? []).map(r => r.val),
  ].filter(Boolean);
  return c.json({ suggestions });
});

// ─── POST /api/admin/import ───────────────────────────────────────────────────
admin.post('/import', async (c) => {
  const env = c.env;
  const importId = crypto.randomUUID();
  const sessionId = c.req.query('session') || null;
  const category = c.req.query('category') || null;
  const hitExportLimit = c.req.query('hit_export_limit') === '1' || c.req.query('hit_export_limit') === 'true';

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'multipart/form-data required' }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }

  const text = await file.text();
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    return c.json({ error: 'CSV must have header + at least one data row' }, 400);
  }

  const headerLine = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const colIdx = (name: string) => headerLine.indexOf(name);

  // Proper CSV field splitter — handles empty fields (,,) and quoted strings with commas/newlines
  function splitCsvFields(line: string): string[] {
    const fields: string[] = [];
    let inQuote = false;
    let current = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { current += '"'; i++; } // escaped quote ""
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim()); // last field
    return fields;
  }

  function parseRow(line: string): Record<string, string> {
    const result: Record<string, string> = {};
    const fields = splitCsvFields(line);
    headerLine.forEach((col, i) => {
      result[col] = fields[i] ?? '';
    });
    return result;
  }

  let importedRows = 0, skippedRows = 0, errorRows = 0;
  const errors: string[] = [];
  // 新規 properties 書き込みは DB2 (MAL_DB2) へ。csv_imports メタデータは MAL_DB のまま。
  const writeDb = getWriteDB(env);

  await env.MAL_DB.prepare(`
    INSERT OR IGNORE INTO csv_imports (id, filename, source, status, imported_at)
    VALUES (?, ?, 'manual', 'processing', datetime('now'))
  `).bind(importId, file.name).run();

  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    const siteId = row['site_id'];
    const sitePropertyId = row['id']?.split('_').slice(1).join('_') || row['site_property_id'];

    if (!siteId || !sitePropertyId) {
      skippedRows++;
      continue;
    }

    const id = `${siteId}_${sitePropertyId}`;

    try {
      // session 指定時は last_seen_at と import_session_id を datetime('now') / sessionId で上書き。
      // ON CONFLICT 句でも更新して「途中失敗 = 一部だけ古い」リスクを軽減。
      const effectiveLastSeen = sessionId ? null /* SQL 側で datetime('now') を使う */ : (row['last_seen_at'] || null);
      await writeDb.prepare(`
        INSERT INTO properties (
          id, site_id, site_property_id, title, property_type, status,
          prefecture, city, address, price, price_text, area,
          rooms, age, floor, station, station_minutes,
          management_fee, repair_fund, direction, structure,
          yield_rate, thumbnail_url, detail_url, description,
          fingerprint, latitude, longitude,
          listed_at, sold_at, last_seen_at, import_session_id,
          created_at, updated_at, scraped_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ${sessionId ? `datetime('now')` : `?`}, ?,
          datetime('now'), datetime('now'), datetime('now')
        )
        ON CONFLICT(site_id, site_property_id) DO UPDATE SET
          title             = excluded.title,
          price             = excluded.price,
          price_text        = excluded.price_text,
          status            = excluded.status,
          description       = excluded.description,
          fingerprint       = excluded.fingerprint,
          management_fee    = excluded.management_fee,
          repair_fund       = excluded.repair_fund,
          direction         = excluded.direction,
          structure         = excluded.structure,
          last_seen_at      = excluded.last_seen_at,
          import_session_id = excluded.import_session_id,
          updated_at        = datetime('now')
      `).bind(
        ...(sessionId ? [
          id, siteId, sitePropertyId,
          row['title'] || '', row['property_type'] || 'other', row['status'] || 'active',
          row['prefecture'] || '13', row['city'] || '', row['address'] || null,
          row['price'] ? parseInt(row['price']) : null,
          row['price_text'] || '',
          row['area'] ? parseFloat(row['area']) : null,
          row['rooms'] || null,
          row['age'] ? parseInt(row['age']) : null,
          row['floor'] ? parseInt(row['floor']) : null,
          row['station'] || null,
          row['station_minutes'] ? parseInt(row['station_minutes']) : null,
          row['management_fee'] ? parseInt(row['management_fee']) : null,
          row['repair_fund'] ? parseInt(row['repair_fund']) : null,
          row['direction'] || null,
          row['structure'] || null,
          row['yield_rate'] ? parseFloat(row['yield_rate']) : null,
          row['thumbnail_url'] || null,
          row['detail_url'] || '',
          row['description'] || null,
          row['fingerprint'] || null,
          row['latitude'] ? parseFloat(row['latitude']) : null,
          row['longitude'] ? parseFloat(row['longitude']) : null,
          row['listed_at'] || null,
          row['sold_at'] || null,
          // last_seen_at は SQL 側で datetime('now') 固定 → bind から除外
          sessionId,
        ] : [
          id, siteId, sitePropertyId,
          row['title'] || '', row['property_type'] || 'other', row['status'] || 'active',
          row['prefecture'] || '13', row['city'] || '', row['address'] || null,
          row['price'] ? parseInt(row['price']) : null,
          row['price_text'] || '',
          row['area'] ? parseFloat(row['area']) : null,
          row['rooms'] || null,
          row['age'] ? parseInt(row['age']) : null,
          row['floor'] ? parseInt(row['floor']) : null,
          row['station'] || null,
          row['station_minutes'] ? parseInt(row['station_minutes']) : null,
          row['management_fee'] ? parseInt(row['management_fee']) : null,
          row['repair_fund'] ? parseInt(row['repair_fund']) : null,
          row['direction'] || null,
          row['structure'] || null,
          row['yield_rate'] ? parseFloat(row['yield_rate']) : null,
          row['thumbnail_url'] || null,
          row['detail_url'] || '',
          row['description'] || null,
          row['fingerprint'] || null,
          row['latitude'] ? parseFloat(row['latitude']) : null,
          row['longitude'] ? parseFloat(row['longitude']) : null,
          row['listed_at'] || null,
          row['sold_at'] || null,
          effectiveLastSeen,
          null, // import_session_id
        ])
      ).run();
      importedRows++;
    } catch (e) {
      errorRows++;
      console.error(`[admin/import] row ${i} error:`, e);
      errors.push(`row ${i}: import failed`);
    }
  }

  const totalRows = lines.length - 1;
  const errorLog = errors.length > 0 ? errors.slice(0, 20).join('\n') : null;

  await env.MAL_DB.prepare(`
    UPDATE csv_imports
    SET status='completed', total_rows=?, imported_rows=?, skipped_rows=?, error_rows=?,
        error_log=?, completed_at=datetime('now')
    WHERE id=?
  `).bind(totalRows, importedRows, skippedRows, errorRows, errorLog, importId).run();

  // session 連携: categories_json に当該カテゴリの結果をマージ + total_imported を加算
  if (sessionId) {
    try {
      const sess = await safeFirst<{ categories_json: string | null; total_imported: number }>(
        env.MAL_DB.prepare(`SELECT categories_json, total_imported FROM import_sessions WHERE id=?`).bind(sessionId)
      );
      if (sess) {
        let cats: Record<string, { rowCount: number; inserted?: number; skipped?: number; hitLimit: boolean }> = {};
        try { cats = JSON.parse(sess.categories_json || '{}'); } catch { cats = {}; }
        const key = category || `unknown_${importId.slice(0, 6)}`;
        // rowCount = 処理した総行数 (重複含む)、inserted = 新規挿入、skipped = 重複スキップ
        cats[key] = {
          rowCount: totalRows,
          inserted: importedRows,
          skipped: skippedRows,
          hitLimit: hitExportLimit,
        };
        const newTotal = (sess.total_imported ?? 0) + importedRows;
        await env.MAL_DB.prepare(`
          UPDATE import_sessions SET categories_json=?, total_imported=? WHERE id=?
        `).bind(JSON.stringify(cats), newTotal, sessionId).run();
      }
    } catch (e) {
      console.error('[admin/import] session update failed:', e);
    }
  }

  return c.json({
    importId,
    sessionId,
    category,
    hitExportLimit,
    totalRows,
    importedRows,
    skippedRows,
    errorRows,
    status: 'completed',
  });
});

// ─── GET /api/admin/duplicates ────────────────────────────────────────────────
admin.get('/duplicates', async (c) => {
  const rows = await c.env.MAL_DB.prepare(`
    SELECT fingerprint, GROUP_CONCAT(id) as ids, GROUP_CONCAT(site_id) as sites,
           COUNT(*) as count, MAX(title) as title, MAX(price) as price
    FROM properties
    WHERE fingerprint IS NOT NULL
    GROUP BY fingerprint
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 100
  `).all<{ fingerprint: string; ids: string; sites: string; count: number; title: string; price: number | null }>();

  return c.json({ duplicates: rows.results ?? [] });
});

// ─── POST /api/admin/download-queue/process ───────────────────────────────────
// SSRF 防御を備えた共通実装 (image-pipeline.processQueue) に統一。
// 旧コードの processDownloadItem は isUrlSafeToFetch を呼ばずに任意 URL を fetch していたため
// 攻撃者が download_queue.source_url に内部 IP を仕込めば SSRF 可能だった。
admin.post('/download-queue/process', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500);
  const result = await processQueue(c.env, limit);
  return c.json(result);
});

// ─── POST /api/admin/images/enqueue-all ──────────────────────────────────────
admin.post('/images/enqueue-all', async (c) => {
  try {
    const count = await enqueueAll(c.env);
    return c.json({ enqueued: count });
  } catch (e) {
    console.error('[admin/images/enqueue-all] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── POST /api/admin/images/process ──────────────────────────────────────────
admin.post('/images/process', async (c) => {
  const batchSize = Math.min(parseInt(c.req.query('batch') ?? '10'), 50);
  try {
    const result = await processQueue(c.env, batchSize);
    return c.json(result);
  } catch (e) {
    console.error('[admin/images/process] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── GET /api/admin/images/queue-status ──────────────────────────────────────
admin.get('/images/queue-status', async (c) => {
  const rows = await safeAll<{ status: string; cnt: number }>(
    c.env.MAL_DB.prepare(`
      SELECT status, COUNT(*) as cnt
      FROM download_queue
      WHERE asset_type = 'image'
      GROUP BY status
    `)
  );
  const counts: Record<string, number> = {};
  for (const r of rows.results ?? []) {
    counts[r.status] = r.cnt;
  }
  return c.json({ counts });
});

// ─── POST /api/admin/scrape ──────────────────────────────────────────────────
// Manually trigger the scheduled scrape (same logic as cron, but on-demand).
admin.post('/scrape', async (c) => {
  try {
    const result = await runScheduledScrape(c.env);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/scrape] error:', e);
    return c.json({ ok: false, error: 'Internal error' }, 500);
  }
});

// ─── DELETE /api/admin/sold-cleanup ──────────────────────────────────────────
admin.delete('/sold-cleanup', async (c) => {
  const result = await c.env.MAL_DB.prepare(`
    UPDATE properties
    SET status = 'delisted', updated_at = datetime('now')
    WHERE status = 'sold' AND sold_at < datetime('now', '-90 days')
  `).run();

  const affected = (result.meta?.changes as number | undefined) ?? 0;
  return c.json({ delistedCount: affected });
});

// ─── POST /api/admin/backfill-images ─────────────────────────────────────────
// fingerprintが一致するスクレイプ済み行からTERASS行へ thumbnail_url をコピー
admin.post('/backfill-images', async (c) => {
  const r = await c.env.MAL_DB.prepare(`
    UPDATE properties AS t
    SET thumbnail_url = (
      SELECT thumbnail_url FROM properties
      WHERE fingerprint = t.fingerprint
        AND thumbnail_url IS NOT NULL AND thumbnail_url != ''
      LIMIT 1
    )
    WHERE (t.thumbnail_url IS NULL OR t.thumbnail_url = '')
      AND t.fingerprint IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM properties WHERE fingerprint = t.fingerprint
          AND thumbnail_url IS NOT NULL AND thumbnail_url != ''
      )
  `).run();
  return c.json({ updated: r.meta?.changes ?? 0 });
});

// ─── POST /api/admin/backfill-detail-urls ────────────────────────────────────
// fingerprintが一致する行から detail_url を補完 (donor が実際に存在する行のみ更新)
admin.post('/backfill-detail-urls', async (c) => {
  const r = await c.env.MAL_DB.prepare(`
    UPDATE properties AS t
    SET detail_url = (
      SELECT detail_url FROM properties
      WHERE fingerprint = t.fingerprint
        AND detail_url IS NOT NULL AND detail_url != ''
      LIMIT 1)
    WHERE (t.detail_url IS NULL OR t.detail_url = '')
      AND t.fingerprint IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM properties
        WHERE fingerprint = t.fingerprint
          AND detail_url IS NOT NULL AND detail_url != ''
      )
  `).run();
  return c.json({ updated: r.meta?.changes ?? 0 });
});

// ─── GET /api/admin/d1-capacity ──────────────────────────────────────────────
// D1 free tier 上限: 5GB (5120MB) — 2024/3 改定。警告閾値は 80% (4096MB)
admin.get('/d1-capacity', async (c) => {
  const total = await safeFirst<{ n: number }>(
    c.env.MAL_DB.prepare('SELECT COUNT(*) AS n FROM properties')
  );
  const sites = await safeAll<{ site_id: string; n: number }>(
    c.env.MAL_DB.prepare('SELECT site_id, COUNT(*) AS n FROM properties GROUP BY site_id')
  );
  const sold = await safeFirst<{ n: number }>(
    c.env.MAL_DB.prepare("SELECT COUNT(*) AS n FROM properties WHERE status='sold' OR status='delisted'")
  );
  // SQLite PRAGMA で実サイズ取得 (page_count × page_size)
  let actualMb = 0;
  try {
    const pc = await c.env.MAL_DB.prepare('PRAGMA page_count').first<{ page_count: number }>();
    const ps = await c.env.MAL_DB.prepare('PRAGMA page_size').first<{ page_size: number }>();
    if (pc && ps) {
      actualMb = Math.round((pc.page_count * ps.page_size) / 1024 / 1024);
    }
  } catch (e) {
    console.warn('[d1-capacity] PRAGMA failed:', e);
  }
  const totalN = total?.n ?? 0;
  const estimatedMb = Math.round((totalN * 635) / 1024 / 1024);
  const reportedMb = actualMb || estimatedMb;
  const CAPACITY_MB = 5120; // D1 free tier 5GB
  const WARN_MB = 4096;     // 80%
  return c.json({
    totalProperties: totalN,
    soldOrDelisted: sold?.n ?? 0,
    sites: sites.results,
    actualDbMb: actualMb || null,
    estimatedDbMb: estimatedMb,
    capacityMb: CAPACITY_MB,
    usagePercent: Math.round((reportedMb / CAPACITY_MB) * 100),
    warning: reportedMb > WARN_MB ? `D1 80%超過 (${reportedMb}MB / ${CAPACITY_MB}MB)` : null,
  });
});

// ─── POST /api/admin/archive-cold ────────────────────────────────────────────
// status='sold'/'delisted' 行を R2 へ JSONL ダンプし D1 から削除
// ?age_days=30 で「30日超の行のみ」に絞り込み可 (0=全件, default=0)
admin.post('/archive-cold', async (c) => {
  const batches   = Number(c.req.query('batches')    ?? '1');
  const batchSize = Number(c.req.query('batch_size') ?? '1000');
  const ageDays   = Number(c.req.query('age_days')   ?? '0');
  try {
    const result = await archiveOldestCold(c.env, batches, batchSize, ageDays);
    return c.json(result);
  } catch (e) {
    console.error('[admin/archive-cold] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── GET /api/admin/archive/list ─────────────────────────────────────────────
admin.get('/archive/list', async (c) => {
  const prefix = c.req.query('prefix') ?? 'archive/properties/';
  // P2 #10: prefix を archive/ 配下に制限。Bearer 認証越えていても、
  // ?prefix=images/ で全画像を列挙されるのを防ぐ (R2 列挙コスト + 個人情報漏洩防御)。
  if (!prefix.startsWith('archive/')) {
    return c.json({ error: 'prefix must start with "archive/"' }, 400);
  }
  try {
    const listed = await c.env.MAL_STORAGE.list({ prefix });
    const objects = (listed.objects ?? []).map(o => ({
      key:          o.key,
      size:         o.size,
      uploaded:     o.uploaded?.toISOString() ?? null,
      etag:         o.etag,
    }));
    return c.json({ objects, truncated: listed.truncated });
  } catch (e) {
    console.error('[admin/archive/list] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── POST /api/admin/archive/restore ─────────────────────────────────────────
// body: { r2Key: string } → JSONL読み込み → D1 に INSERT OR IGNORE で復元
admin.post('/archive/restore', async (c) => {
  let body: { r2Key?: string };
  try {
    body = await c.req.json<{ r2Key?: string }>();
  } catch {
    return c.json({ error: 'JSON body required: { r2Key: string }' }, 400);
  }
  const r2Key = body.r2Key;
  if (!r2Key) return c.json({ error: 'r2Key is required' }, 400);

  const obj = await c.env.MAL_STORAGE.get(r2Key);
  if (!obj) return c.json({ error: `R2 object not found: ${r2Key}` }, 404);

  const text = await obj.text();
  const lines = text.split('\n').filter(l => l.trim());
  let restored = 0, skipped = 0, errors = 0;

  for (const line of lines) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { errors++; continue; }

    try {
      await c.env.MAL_DB.prepare(`
        INSERT OR IGNORE INTO properties (
          id, site_id, site_property_id, title, property_type, status,
          prefecture, city, address, price, price_text, area,
          rooms, age, floor, station, station_minutes,
          management_fee, repair_fund, direction, structure,
          yield_rate, thumbnail_url, detail_url, description,
          fingerprint, latitude, longitude,
          listed_at, sold_at, last_seen_at,
          created_at, updated_at, scraped_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `).bind(
        row.id ?? null, row.site_id ?? null, row.site_property_id ?? null,
        row.title ?? '', row.property_type ?? 'other', row.status ?? 'active',
        row.prefecture ?? '13', row.city ?? '', row.address ?? null,
        row.price ?? null, row.price_text ?? '',
        row.area ?? null, row.rooms ?? null, row.age ?? null, row.floor ?? null,
        row.station ?? null, row.station_minutes ?? null,
        row.management_fee ?? null, row.repair_fund ?? null,
        row.direction ?? null, row.structure ?? null,
        row.yield_rate ?? null, row.thumbnail_url ?? null,
        row.detail_url ?? '', row.description ?? null,
        row.fingerprint ?? null, row.latitude ?? null, row.longitude ?? null,
        row.listed_at ?? null, row.sold_at ?? null, row.last_seen_at ?? null,
        row.created_at ?? null, row.updated_at ?? null, row.scraped_at ?? null,
      ).run();
      restored++;
    } catch {
      skipped++;
    }
  }

  return c.json({ r2Key, total: lines.length, restored, skipped, errors });
});

// ─── POST /api/admin/terass-image-discover ───────────────────────────────────
admin.post('/terass-image-discover', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '100'), 500);
  try {
    const result = await discoverTerassImages(c.env, limit);
    return c.json(result);
  } catch (e) {
    console.error('[admin/terass-image-discover] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── POST /api/admin/master/build ────────────────────────────────────────────
admin.post('/master/build', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '5000'), 5000);
  try {
    const result = await buildMasters(c.env, limit);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/master/build] error:', e);
    return c.json({ ok: false, error: 'Internal error' }, 500);
  }
});

// ─── POST /api/admin/master/build-all ────────────────────────────────────────
admin.post('/master/build-all', async (c) => {
  const maxChunks = Math.min(Number(c.req.query('max_chunks') ?? '20'), 50);
  const chunkSize = Math.min(Number(c.req.query('chunk_size') ?? '5000'), 5000);
  try {
    const result = await buildAllMasters(c.env, maxChunks, chunkSize);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error('[admin/master/build-all] error:', e);
    return c.json({ ok: false, error: 'Internal error' }, 500);
  }
});

// ─── POST /api/admin/archive/monthly ─────────────────────────────────────────
// ?year=2026&month=04&dry_run=1
// 指定月に成約済 (status_flag='closed' 相当: status='sold' かつ contract_date が当該月) の行を
// R2 に JSONL で書き出し、書き出し後 D1 から DELETE する。
// properties に contract_date 列が無い場合は sold_at で代替。
admin.post('/archive/monthly', async (c) => {
  const yearStr  = c.req.query('year');
  const monthStr = c.req.query('month');
  const dryRun   = c.req.query('dry_run') === '1' || c.req.query('dry_run') === 'true';

  if (!yearStr || !monthStr) {
    return c.json({ error: 'year and month query parameters are required' }, 400);
  }
  const year  = parseInt(yearStr,  10);
  const month = parseInt(monthStr, 10);
  if (isNaN(year) || year < 2000 || year > 2100) {
    return c.json({ error: 'year must be a 4-digit number (2000–2100)' }, 400);
  }
  if (isNaN(month) || month < 1 || month > 12) {
    return c.json({ error: 'month must be between 1 and 12' }, 400);
  }

  // YYYY-MM prefix for date range matching (sold_at LIKE 'YYYY-MM-%')
  const monthPad  = String(month).padStart(2, '0');
  const yearMonth = `${year}-${monthPad}`;     // e.g. "2026-04"
  const r2Key     = `archives/closed/${yearMonth}.jsonl`;

  const db = c.env.MAL_DB;

  // Count rows that match criteria
  const countRow = await safeFirst<{ cnt: number }>(db.prepare(`
    SELECT COUNT(*) as cnt FROM properties
    WHERE status = 'sold'
      AND sold_at LIKE ?
  `).bind(`${yearMonth}-%`));

  const count = countRow?.cnt ?? 0;
  // Rough size estimate: ~635 bytes per row as JSONL (matches D1 capacity estimate)
  const estimatedBytes = count * 800;

  if (dryRun) {
    return c.json({
      dryRun: true,
      yearMonth,
      r2Key,
      rowCount: count,
      estimatedBytes,
      estimatedKb: Math.round(estimatedBytes / 1024),
    });
  }

  if (count === 0) {
    return c.json({
      dryRun: false,
      yearMonth,
      r2Key,
      rowCount: 0,
      archived: 0,
      deleted: 0,
      message: 'No rows matched; nothing written to R2.',
    });
  }

  // Fetch all matching rows in pages, build JSONL
  const enc    = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let   offset = 0;
  const PAGE   = 500;
  let   fetched = 0;

  while (true) {
    const rows = await db.prepare(`
      SELECT * FROM properties
      WHERE status = 'sold'
        AND sold_at LIKE ?
      LIMIT ? OFFSET ?
    `).bind(`${yearMonth}-%`, PAGE, offset).all<Record<string, unknown>>();

    if (!rows.results?.length) break;
    for (const row of rows.results) {
      chunks.push(enc.encode(JSON.stringify(row) + '\n'));
      fetched++;
    }
    offset += PAGE;
    if (rows.results.length < PAGE) break;
  }

  // Concatenate all chunks into a single Uint8Array
  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  const body = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    body.set(chunk, pos);
    pos += chunk.byteLength;
  }

  // Write to R2
  await c.env.MAL_STORAGE.put(r2Key, body, {
    httpMetadata: { contentType: 'application/x-ndjson' },
  });

  // Delete from D1 (batch by rowid ranges to avoid single large DELETE)
  const delResult = await db.prepare(`
    DELETE FROM properties
    WHERE status = 'sold'
      AND sold_at LIKE ?
  `).bind(`${yearMonth}-%`).run();

  const deleted = (delResult.meta?.changes as number | undefined) ?? 0;

  return c.json({
    dryRun: false,
    yearMonth,
    r2Key,
    rowCount: count,
    archived: fetched,
    deleted,
    writtenBytes: totalLen,
  });
});

// ─── GET /api/admin/sessions/summary ─────────────────────────────────────────
// 過去 N 日の import_sessions を一覧化 (最新順)
admin.get('/sessions/summary', async (c) => {
  const days = Math.max(1, Math.min(365, Number(c.req.query('days') ?? '30') || 30));
  const rows = await safeAll<{
    id: string;
    source: string;
    started_at: string;
    completed_at: string | null;
    status: string;
    total_imported: number;
    total_marked_delisted: number;
    categories_json: string | null;
    notes: string | null;
  }>(c.env.MAL_DB.prepare(`
    SELECT id, source, started_at, completed_at, status,
           total_imported, total_marked_delisted, categories_json, notes
    FROM import_sessions
    WHERE started_at >= datetime('now', ?)
    ORDER BY started_at DESC
    LIMIT 200
  `).bind(`-${days} days`));
  return c.json({ days, sessions: rows.results });
});

// ─── GET /api/admin/stats/delisted ────────────────────────────────────────────
// properties.status='delisted' を last_seen_at で日別集計。前日比 +200% で warning フラグ。
admin.get('/stats/delisted', async (c) => {
  const days = Math.max(1, Math.min(365, Number(c.req.query('days') ?? '30') || 30));
  const rows = await safeAll<{ date: string; count: number }>(
    c.env.MAL_DB.prepare(`
      SELECT date(last_seen_at) as date, COUNT(*) as count
      FROM properties
      WHERE status = 'delisted'
        AND last_seen_at >= datetime('now', ?)
        AND last_seen_at IS NOT NULL
      GROUP BY date(last_seen_at)
      ORDER BY date ASC
    `).bind(`-${days} days`)
  );

  const entries = rows.results;
  // 前日比 +200% (= 3倍超) で warning フラグ
  const result = entries.map((row, i) => {
    const prev = i > 0 ? entries[i - 1].count : null;
    const warning = prev !== null && prev > 0 && row.count > prev * 3;
    return { date: row.date, count: row.count, warning };
  });

  return c.json({ days, data: result });
});

// ─── GET /api/admin/master/stats ─────────────────────────────────────────────
admin.get('/master/stats', async (c) => {
  const [masterCount, unlinkedCount, statusBreakdown, siteBreakdown] = await Promise.all([
    safeFirst<{ cnt: number }>(c.env.MAL_DB.prepare(`SELECT COUNT(*) as cnt FROM master_properties`)),
    safeFirst<{ cnt: number }>(c.env.MAL_DB.prepare(
      `SELECT COUNT(*) as cnt FROM properties WHERE fingerprint IS NOT NULL AND (master_id IS NULL OR master_id = '')`
    )),
    safeAll<{ internal_status: string; cnt: number }>(c.env.MAL_DB.prepare(
      `SELECT internal_status, COUNT(*) as cnt FROM master_properties GROUP BY internal_status`
    )),
    safeAll<{ source_count: number; cnt: number }>(c.env.MAL_DB.prepare(
      `SELECT source_count, COUNT(*) as cnt FROM master_properties GROUP BY source_count ORDER BY source_count`
    )),
  ]);

  return c.json({
    totalMasters: masterCount?.cnt ?? 0,
    unlinkedProperties: unlinkedCount?.cnt ?? 0,
    byInternalStatus: statusBreakdown.results,
    bySourceCount: siteBreakdown.results,
  });
});

// ─── POST /api/admin/master/:id/status ───────────────────────────────────────
admin.post('/master/:id/status', async (c) => {
  const id = c.req.param('id');
  let body: { status?: string; agentId?: string; notes?: string };
  try {
    body = await c.req.json<{ status?: string; agentId?: string; notes?: string }>();
  } catch {
    return c.json({ error: 'JSON body required' }, 400);
  }

  const validStatuses = ['available', 'showing', 'contracted', 'sold'];
  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const result = await c.env.MAL_DB.prepare(`
    UPDATE master_properties
    SET internal_status = ?, agent_id = ?, internal_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(body.status, body.agentId ?? null, body.notes ?? null, id).run();

  if ((result.meta?.changes as number | undefined) === 0) {
    return c.json({ error: 'Master property not found' }, 404);
  }

  return c.json({ ok: true, id, status: body.status });
});

// ─── POST /api/admin/master/:id/favorite ─────────────────────────────────────
admin.post('/master/:id/favorite', async (c) => {
  const id = c.req.param('id');
  let body: { favorite?: boolean };
  try {
    body = await c.req.json<{ favorite?: boolean }>();
  } catch {
    return c.json({ error: 'JSON body required' }, 400);
  }

  if (typeof body.favorite !== 'boolean') {
    return c.json({ error: 'favorite must be a boolean' }, 400);
  }

  const result = await c.env.MAL_DB.prepare(`
    UPDATE master_properties
    SET favorite = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(body.favorite ? 1 : 0, id).run();

  if ((result.meta?.changes as number | undefined) === 0) {
    return c.json({ error: 'Master property not found' }, 404);
  }

  return c.json({ ok: true, id, favorite: body.favorite });
});

// スクレイプ実行状況 (admin 認証必須)
admin.get('/scrape/status', async (c) => {
  const env = c.env;
  try {
    const jobs = await env.MAL_DB
      .prepare('SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT 20')
      .all();
    return c.json({ jobs: jobs.results ?? [] });
  } catch {
    return c.json({ jobs: [] });
  }
});

export { admin };
