import { Hono } from 'hono';
import type { Bindings } from '../types';
import type { AdminStats, SiteId, PrefectureCode } from '../types';
import { enqueueAll, processQueue } from '../services/image-pipeline';
import { runScheduledScrape } from '../scrapers/aggregator';
import { archiveOldestCold } from '../services/archive';
import { discoverTerassImages } from '../services/terass-image-fetch';
import { buildMasters, buildAllMasters } from '../services/master-builder';

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

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
admin.get('/stats', async (c) => {
  const db = c.env.MAL_DB;

  const [
    activeRow, soldRow, delistedRow, totalRow, dupRow,
    totalImgRow, dlImgRow, pendingDlRow, mysokuRow, txnRow,
    siteRows, prefRows, lastScrapeRow, lastCsvRow,
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
    r2StorageEstimatedMb: 0,
    dbSizeEstimatedMb:    0,
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

  c.executionCtx.waitUntil((async () => {
    try {
      await writer.write(enc.encode(HEADER + '\n'));
      let offset = 0;
      while (true) {
        const rows = await env.MAL_DB.prepare(
          `SELECT * FROM properties WHERE ${whereClause} LIMIT 1000 OFFSET ?`
        ).bind(...bindings, offset).all<Record<string, unknown>>();
        if (!rows.results?.length) break;
        for (const row of rows.results) {
          await writer.write(enc.encode(rowToCsv(row) + '\n'));
        }
        offset += 1000;
        if (rows.results.length < 1000) break;
      }
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, { headers });
});

// ─── POST /api/admin/import ───────────────────────────────────────────────────
admin.post('/import', async (c) => {
  const env = c.env;
  const importId = crypto.randomUUID();

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

  function parseRow(line: string): Record<string, string> {
    const result: Record<string, string> = {};
    const fields = line.match(/("(?:[^"]|"")*"|[^,]*)/g) ?? [];
    headerLine.forEach((col, i) => {
      const raw = (fields[i] ?? '').trim();
      result[col] = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    });
    return result;
  }

  let importedRows = 0, skippedRows = 0, errorRows = 0;
  const errors: string[] = [];

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
      await env.MAL_DB.prepare(`
        INSERT INTO properties (
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
          datetime('now'), datetime('now'), datetime('now')
        )
        ON CONFLICT(site_id, site_property_id) DO UPDATE SET
          title          = excluded.title,
          price          = excluded.price,
          price_text     = excluded.price_text,
          status         = excluded.status,
          description    = excluded.description,
          fingerprint    = excluded.fingerprint,
          management_fee = excluded.management_fee,
          repair_fund    = excluded.repair_fund,
          direction      = excluded.direction,
          structure      = excluded.structure,
          updated_at     = datetime('now')
      `).bind(
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
        row['last_seen_at'] || null,
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

  return c.json({
    importId,
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
admin.post('/download-queue/process', async (c) => {
  const env = c.env;
  const db = env.MAL_DB;

  const items = await db.prepare(`
    SELECT * FROM download_queue
    WHERE status = 'pending' AND retry_count < 3
    ORDER BY created_at ASC
    LIMIT 50
  `).all<Record<string, unknown>>();

  const results = items.results ?? [];
  let processed = 0, failed = 0;

  for (let i = 0; i < results.length; i += 5) {
    const batch = results.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map(item => processDownloadItem(item, env)));
    for (const r of settled) {
      if (r.status === 'fulfilled') processed++; else failed++;
    }
  }

  return c.json({ processed, failed, total: results.length });
});

async function processDownloadItem(item: Record<string, unknown>, env: Bindings): Promise<void> {
  const r2Key = `${item.asset_type}/${item.property_id}/${Date.now()}.jpg`;
  try {
    const resp = await fetch(item.source_url as string, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const ct = resp.headers.get('content-type') ?? 'application/octet-stream';
    await env.MAL_STORAGE.put(r2Key, buf, { httpMetadata: { contentType: ct } });
    await env.MAL_DB.prepare(`
      UPDATE download_queue SET status='done', r2_key=?, file_size_bytes=?, content_type=?, processed_at=datetime('now')
      WHERE id=?
    `).bind(r2Key, buf.byteLength, ct, item.id as string).run();
  } catch (e) {
    await env.MAL_DB.prepare(`
      UPDATE download_queue SET status=CASE WHEN retry_count>=2 THEN 'failed' ELSE 'pending' END,
        retry_count=retry_count+1, error_message=?, processed_at=datetime('now')
      WHERE id=?
    `).bind(String(e), item.id as string).run();
  }
}

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
  const totalN = total?.n ?? 0;
  const estimatedMb = Math.round(totalN * 635 / 1024 / 1024);
  return c.json({
    totalProperties: totalN,
    soldOrDelisted: sold?.n ?? 0,
    sites: sites.results,
    estimatedDbMb: estimatedMb,
    capacityMb: 500,
    warning: estimatedMb > 450 ? 'D1 80% 超過' : null,
  });
});

// ─── POST /api/admin/archive-cold ────────────────────────────────────────────
// status='sold'/'delisted' 行を R2 へ JSONL ダンプし D1 から削除
admin.post('/archive-cold', async (c) => {
  const batches   = Number(c.req.query('batches')    ?? '1');
  const batchSize = Number(c.req.query('batch_size') ?? '1000');
  try {
    const result = await archiveOldestCold(c.env, batches, batchSize);
    return c.json(result);
  } catch (e) {
    console.error('[admin/archive-cold] error:', e);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// ─── GET /api/admin/archive/list ─────────────────────────────────────────────
admin.get('/archive/list', async (c) => {
  const prefix = c.req.query('prefix') ?? 'archive/properties/';
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

export { admin };
