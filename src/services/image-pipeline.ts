// MAL System - Image Download Pipeline
// Handles enqueueing and processing property images into R2 storage.

import type { Bindings } from '../types';

/** Compute a short hash suffix from a URL string for R2 key uniqueness. */
async function urlHash(url: string): Promise<string> {
  const enc = new TextEncoder().encode(url);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

/** Build R2 key for an image: images/{propertyId}/{hash}.jpg */
async function buildR2Key(propertyId: string, imageUrl: string): Promise<string> {
  const hash = await urlHash(imageUrl);
  return `images/${propertyId}/${hash}.jpg`;
}

/**
 * SSRF defense: validate URL is HTTPS, on a known image-host allowlist,
 * and not pointing to a private/loopback address.
 * Returns true if the URL is safe to fetch.
 */
const ALLOWED_IMAGE_HOSTS = [
  'suumo.jp', 'img.suumo.jp', 'www.suumo.jp',
  'homes.co.jp', 'www.homes.co.jp', 'imgs.homes.co.jp',
  'athome.co.jp', 'www.athome.co.jp', 'image.athome.co.jp', 'image1.athome.co.jp', 'image2.athome.co.jp',
  'fudosan.co.jp', 'www.fudosan.co.jp',
  'chintai.net', 'www.chintai.net',
  'sumaity.com', 'img.sumaity.com',
  'reins.or.jp', 'www.reins.or.jp',
  'kenbiya.com', 'www.kenbiya.com', 'img.kenbiya.com',
  'rakumachi.jp', 'www.rakumachi.jp', 'img.rakumachi.jp',
];

function isUrlSafeToFetch(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  // Block private/loopback/link-local addresses (IPv4 + common cases)
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  if (host === '169.254.169.254') return false; // cloud metadata
  if (host.endsWith('.internal') || host.endsWith('.local')) return false;
  // Allowlist match (exact or subdomain)
  return ALLOWED_IMAGE_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
}

// ─── enqueueImage ─────────────────────────────────────────────────────────────

/**
 * Add a single image URL to the download_queue.
 * Uses INSERT OR IGNORE so calling twice is safe (idempotent).
 */
export async function enqueueImage(
  env: Bindings,
  propertyId: string,
  imageUrl: string,
): Promise<void> {
  const r2Key = await buildR2Key(propertyId, imageUrl);
  await env.MAL_DB.prepare(`
    INSERT OR IGNORE INTO download_queue
      (id, asset_type, property_id, source_url, r2_key, status, retry_count, created_at)
    VALUES
      (?, 'image', ?, ?, ?, 'pending', 0, datetime('now'))
  `).bind(crypto.randomUUID(), propertyId, imageUrl, r2Key).run();
}

// ─── processQueue ─────────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  property_id: string;
  source_url: string;
  r2_key: string | null;
  retry_count: number;
}

/**
 * Fetch up to `batchSize` pending image queue items, download each to R2,
 * then update property_images and the queue row.
 * Returns counts of processed and failed items.
 */
export async function processQueue(
  env: Bindings,
  batchSize = 10,
): Promise<{ processed: number; failed: number }> {
  const rows = await env.MAL_DB.prepare(`
    SELECT id, property_id, source_url, r2_key, retry_count
    FROM download_queue
    WHERE status = 'pending' AND asset_type = 'image' AND retry_count < 3
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(batchSize).all<QueueRow>();

  const items = rows.results ?? [];
  let processed = 0;
  let failed = 0;

  for (const item of items) {
    const r2Key = item.r2_key ?? await buildR2Key(item.property_id, item.source_url);
    try {
      // Mark processing
      await env.MAL_DB.prepare(`
        UPDATE download_queue SET status = 'processing' WHERE id = ?
      `).bind(item.id).run();

      // SSRF defense: validate URL before fetching
      if (!isUrlSafeToFetch(item.source_url)) {
        throw new Error(`Blocked unsafe URL (SSRF guard): ${item.source_url}`);
      }

      // Fetch image (10s timeout)
      const resp = await fetch(item.source_url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buf = await resp.arrayBuffer();
      const ct = resp.headers.get('content-type') ?? 'image/jpeg';

      // Upload to R2
      await env.MAL_STORAGE.put(r2Key, buf, { httpMetadata: { contentType: ct } });

      // Insert into property_images if not already present, then update status
      await env.MAL_DB.prepare(`
        INSERT OR IGNORE INTO property_images
          (property_id, image_url, r2_key, original_url, download_status, created_at)
        VALUES (?, ?, ?, ?, 'downloaded', datetime('now'))
      `).bind(item.property_id, item.source_url, r2Key, item.source_url).run();
      // Also update any existing row (different id, same url)
      await env.MAL_DB.prepare(`
        UPDATE property_images
        SET r2_key = ?, download_status = 'downloaded'
        WHERE property_id = ? AND image_url = ?
      `).bind(r2Key, item.property_id, item.source_url).run();

      // Mark done
      await env.MAL_DB.prepare(`
        UPDATE download_queue
        SET status = 'done', r2_key = ?, file_size_bytes = ?, content_type = ?,
            processed_at = datetime('now')
        WHERE id = ?
      `).bind(r2Key, buf.byteLength, ct, item.id).run();

      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // retry_count >= 2 means this is the 3rd attempt — mark failed
      await env.MAL_DB.prepare(`
        UPDATE download_queue
        SET status = CASE WHEN retry_count >= 2 THEN 'failed' ELSE 'pending' END,
            retry_count   = retry_count + 1,
            error_message = ?,
            processed_at  = datetime('now')
        WHERE id = ?
      `).bind(msg, item.id).run();
      failed++;
    }
  }

  return { processed, failed };
}

// ─── enqueueAll ──────────────────────────────────────────────────────────────

/**
 * Find all property_images whose download_status is still 'pending'
 * and insert them into download_queue (idempotent via INSERT OR IGNORE).
 * Returns the count of newly enqueued items.
 */
export async function enqueueAll(env: Bindings): Promise<number> {
  // Fetch undownloaded images that are not yet queued
  const rows = await env.MAL_DB.prepare(`
    SELECT pi.property_id, pi.image_url
    FROM property_images pi
    WHERE pi.download_status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM download_queue dq
        WHERE dq.property_id = pi.property_id
          AND dq.source_url   = pi.image_url
          AND dq.asset_type   = 'image'
          AND dq.status NOT IN ('failed')
      )
    LIMIT 1000
  `).all<{ property_id: string; image_url: string }>();

  const items = rows.results ?? [];
  for (const item of items) {
    await enqueueImage(env, item.property_id, item.image_url);
  }
  return items.length;
}
