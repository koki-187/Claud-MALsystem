// MAL System - Cold Archive Service
// Archives status='sold'|'delisted' properties from D1 to R2 as JSONL files.

import type { Bindings } from '../types';

/**
 * Archive the oldest cold (sold/delisted) properties from D1 to R2.
 * Each call writes one JSONL file per batch to R2 and removes those rows from D1.
 *
 * @param env       - Worker bindings
 * @param batches   - Number of batches to run (default 5)
 * @param batchSize - Rows per batch (default 2000)
 * @param ageDays   - Only archive rows where updated_at is older than this many days (default 0 = all)
 * @returns Total archived and deleted counts
 */
export async function archiveOldestCold(
  env: Bindings,
  batches = 5,
  batchSize = 2000,
  ageDays = 0,
): Promise<{ archived: number; deleted: number; r2Keys: string[] }> {
  let totalArchived = 0;
  let totalDeleted = 0;
  const r2Keys: string[] = [];

  const ageFilter = ageDays > 0
    ? `AND datetime(updated_at) <= datetime('now', '-${ageDays} days')`
    : '';

  for (let i = 0; i < batches; i++) {
    const rows = await env.MAL_DB.prepare(
      `SELECT * FROM properties
       WHERE status IN ('sold', 'delisted')
       ${ageFilter}
       ORDER BY updated_at ASC
       LIMIT ?`
    ).bind(batchSize).all<Record<string, unknown>>();

    const results = rows.results ?? [];
    if (results.length === 0) break;

    const jsonl = results.map(r => JSON.stringify(r)).join('\n');
    const key = `archive/properties/${new Date().toISOString().slice(0, 10)}_${Date.now()}_b${i}.jsonl`;

    await env.MAL_STORAGE.put(key, jsonl, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    r2Keys.push(key);

    // Delete in chunks to avoid "too many SQL variables" limit
    const chunkSize = 100;
    let deleted = 0;
    for (let j = 0; j < results.length; j += chunkSize) {
      const chunk = results.slice(j, j + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const ids = chunk.map(r => r.id as string);
      const del = await env.MAL_DB.prepare(
        `DELETE FROM properties WHERE id IN (${placeholders})`
      ).bind(...ids).run();
      deleted += (del.meta?.changes as number | undefined) ?? 0;
    }

    totalArchived += results.length;
    totalDeleted += deleted;
  }

  return { archived: totalArchived, deleted: totalDeleted, r2Keys };
}

/**
 * Purge stale metadata rows from log/queue tables to free D1 space.
 * Each table operation is wrapped in try-catch so a missing table is silently skipped.
 *
 * @param db - D1 database binding
 * @returns Map of table name → rows deleted
 */
export async function purgeStaleMetadata(
  db: D1Database,
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  const safeRun = async (table: string, sql: string): Promise<void> => {
    try {
      const r = await db.prepare(sql).run();
      results[table] = (r.meta?.changes as number | undefined) ?? 0;
    } catch (e) {
      // Table may not exist (migration pending) — skip silently
      console.warn(`[purgeStaleMetadata] skipping ${table}:`, e);
      results[table] = 0;
    }
  };

  // search_logs: keep 30 days
  await safeRun(
    'search_logs',
    `DELETE FROM search_logs WHERE datetime(created_at) <= datetime('now', '-30 days')`,
  );

  // scrape_jobs: keep 30 days (use created_at if available, else started_at)
  await safeRun(
    'scrape_jobs',
    `DELETE FROM scrape_jobs WHERE datetime(created_at) <= datetime('now', '-30 days')`,
  );

  // download_queue: delete done/failed immediately
  await safeRun(
    'download_queue',
    `DELETE FROM download_queue WHERE status IN ('done', 'failed')`,
  );

  // csv_imports: keep 90 days
  await safeRun(
    'csv_imports',
    `DELETE FROM csv_imports WHERE datetime(created_at) <= datetime('now', '-90 days')`,
  );

  return results;
}
