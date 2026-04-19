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
 * @returns Total archived and deleted counts
 */
export async function archiveOldestCold(
  env: Bindings,
  batches = 5,
  batchSize = 2000,
): Promise<{ archived: number; deleted: number; r2Keys: string[] }> {
  let totalArchived = 0;
  let totalDeleted = 0;
  const r2Keys: string[] = [];

  for (let i = 0; i < batches; i++) {
    const rows = await env.MAL_DB.prepare(
      `SELECT * FROM properties
       WHERE status IN ('sold', 'delisted')
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
