// MAL System - TERASS Image Discovery Service
// Enqueues search URL hints for TERASS rows that have no thumbnail/detail_url.
// Actual image extraction from search results is a TODO for a subsequent worker task.

import type { Bindings } from '../types';

interface TerassRow {
  id: string;
  address: string | null;
  city: string | null;
  prefecture: string | null;
  price: number | null;
  area: number | null;
  fingerprint: string | null;
}

/**
 * Build住所ベース search hint URLs for major real-estate portals.
 * Returns an array of candidate search URLs for a given address string.
 */
function buildSearchUrls(address: string): string[] {
  const encoded = encodeURIComponent(address);
  return [
    // SUUMO 住所フリーワード検索
    `https://suumo.jp/jj/bukken/ichiran/JJ010FJ001/?city=${encoded}`,
    // AtHome 住所フリーワード検索
    `https://www.athome.co.jp/kodate/search/?FULL_TEXT=${encoded}`,
    // REINS は会員制のためスキップ (TODO: dump CSV 代替)
  ];
}

/**
 * Find TERASS rows that have no image (thumbnail_url IS NULL) and no detail URL,
 * then enqueue住所ベース search URLs into download_queue as asset_type='mysoku_search'
 * for future processing.
 *
 * This function only ENQUEUES; actual HTTP fetching / image extraction is handled
 * by a subsequent worker task (TODO).
 *
 * @param env   - Worker bindings
 * @param limit - Max rows to process per call (default 100, max 500)
 */
export async function discoverTerassImages(
  env: Bindings,
  limit = 100,
): Promise<{ scanned: number; enqueued: number; skipped: number }> {
  // TERASS rows: site_id starts with 'terass_', no thumbnail, no detail_url
  const rows = await env.MAL_DB.prepare(`
    SELECT id, address, city, prefecture, price, area, fingerprint
    FROM properties
    WHERE site_id LIKE 'terass_%'
      AND (thumbnail_url IS NULL OR thumbnail_url = '')
      AND (detail_url   IS NULL OR detail_url   = '')
      AND (address IS NOT NULL AND address != '')
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(limit).all<TerassRow>();

  const items = rows.results ?? [];
  let enqueued = 0;
  let skipped  = 0;

  for (const row of items) {
    const addressStr = [row.address, row.city].filter(Boolean).join(' ');
    if (!addressStr.trim()) { skipped++; continue; }

    const searchUrls = buildSearchUrls(addressStr);

    for (const url of searchUrls) {
      try {
        await env.MAL_DB.prepare(`
          INSERT OR IGNORE INTO download_queue
            (id, asset_type, property_id, source_url, r2_key, status, retry_count, created_at)
          VALUES
            (?, 'mysoku_search', ?, ?, NULL, 'pending', 0, datetime('now'))
        `).bind(crypto.randomUUID(), row.id, url).run();
        enqueued++;
      } catch {
        skipped++;
      }
    }
  }

  return { scanned: items.length, enqueued, skipped };
}
