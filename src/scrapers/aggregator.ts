import type { Property, SearchParams, SiteId, SiteSearchResult, PrefectureCode } from '../types';
import type { Bindings } from '../types';
import type { BaseScraper } from './base';
import { SuumoScraper } from './suumo';
import { HomesScraper } from './homes';
import { AthomeScraper } from './athome';
import { FudosanScraper } from './fudosan';
import { ChintaiScraper } from './chintai';
import { SmaityScraper } from './smaity';
import { ReinsScraper } from './reins';
import { KenbiyaScraper } from './kenbiya';
import { RakumachiScraper } from './rakumachi';

const SCRAPER_TIMEOUT_MS = 20000;

const ALL_SITE_IDS: SiteId[] = [
  'suumo', 'homes', 'athome', 'fudosan', 'chintai',
  'smaity', 'reins', 'kenbiya', 'rakumachi',
];

/**
 * Rotate prefectures by day-of-week to stay within Cloudflare CPU limits.
 * 2–3 prefectures × 9 sites per cron invocation.
 */
const PREFECTURE_ROTATION: PrefectureCode[][] = [
  ['13', '27'],       // 0 Mon  東京・大阪
  ['14', '23'],       // 1 Tue  神奈川・愛知
  ['11', '12'],       // 2 Wed  埼玉・千葉
  ['01', '40'],       // 3 Thu  北海道・福岡
  ['26', '28'],       // 4 Fri  京都・兵庫
  ['22', '08'],       // 5 Sat  静岡・茨城
  ['07', '04', '41'], // 6 Sun  福島・宮城・佐賀
];

function createScrapers(): Record<SiteId, BaseScraper> {
  return {
    suumo:     new SuumoScraper(),
    homes:     new HomesScraper(),
    athome:    new AthomeScraper(),
    fudosan:   new FudosanScraper(),
    chintai:   new ChintaiScraper(),
    smaity:    new SmaityScraper(),
    reins:     new ReinsScraper(),
    kenbiya:   new KenbiyaScraper(),
    rakumachi: new RakumachiScraper(),
  };
}

/**
 * Guard: returns true when ALL properties are mock data (every ID contains "mock_").
 * Empty arrays are treated as mock to avoid empty DB writes.
 * @deprecated Prefer isMockData() for per-site checks.
 */
function isAllMockData(properties: Property[]): boolean {
  if (properties.length === 0) return true;
  return properties.every(p => p.sitePropertyId.includes('mock_'));
}

/**
 * Per-site mock guard: returns true when this site's result is pure mock data.
 * Unlike isAllMockData, this evaluates a single site's slice rather than the
 * combined multi-site batch — allowing DB writes as soon as any one site returns
 * real data.
 */
function isMockData(properties: Property[]): boolean {
  if (properties.length === 0) return true;
  return properties.every(p => p.sitePropertyId.includes('mock_'));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function aggregateSearch(
  params: SearchParams,
  env: Bindings
): Promise<{ properties: Property[]; siteResults: SiteSearchResult[] }> {
  const siteIds: SiteId[] = params.sites ?? ALL_SITE_IDS;
  const prefecture: PrefectureCode = params.prefecture ?? '13';
  const scrapers = createScrapers();
  const maxResults = parseInt(env.MAX_RESULTS_PER_SITE ?? '15');

  const scrapePromises = siteIds.map(async (siteId): Promise<{
    siteId: SiteId;
    properties: Property[];
    result: SiteSearchResult;
  }> => {
    const startTime = Date.now();
    const scraper = scrapers[siteId];

    if (!scraper) {
      return {
        siteId,
        properties: [],
        result: { siteId, count: 0, status: 'error', errorMessage: 'Scraper not found', executionTimeMs: 0 },
      };
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Scraper timeout')), SCRAPER_TIMEOUT_MS)
      );
      const properties = await Promise.race([
        scraper.scrapeListings({ prefecture, maxResults }),
        timeoutPromise,
      ]);
      return {
        siteId,
        properties,
        result: { siteId, count: properties.length, status: 'success', executionTimeMs: Date.now() - startTime },
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        siteId,
        properties: [],
        result: {
          siteId, count: 0,
          status: errorMessage === 'Scraper timeout' ? 'timeout' : 'error',
          errorMessage, executionTimeMs,
        },
      };
    }
  });

  const results = await Promise.allSettled(scrapePromises);

  const allProperties: Property[] = [];
  const siteResults: SiteSearchResult[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allProperties.push(...result.value.properties);
      siteResults.push(result.value.result);
    } else {
      siteResults.push({
        siteId: siteIds[siteResults.length] ?? ('suumo' as SiteId),
        count: 0,
        status: 'error',
        errorMessage: result.reason?.message ?? 'Unknown error',
        executionTimeMs: 0,
      });
    }
  }

  return {
    properties: sortProperties(filterProperties(allProperties, params), params.sortBy ?? 'newest'),
    siteResults,
  };
}

/**
 * Run scheduled full scrape.
 * - Rotates prefectures by day-of-week (override via env.SCRAPE_PREFECTURES)
 * - Skips DB writes when mock data is returned (isAllMockData guard)
 * - Marks previously-active properties as sold if absent from latest real scrape
 * - Records price history (one entry per property per day)
 * - Invalidates KV search cache after writes
 */
export async function runScheduledScrape(env: Bindings): Promise<{
  total: number;
  newCount: number;
  updatedCount: number;
  soldCount: number;
  errors: string[];
}> {
  // Determine which prefectures to scrape today
  let targetPrefectures: PrefectureCode[];
  if (env.SCRAPE_PREFECTURES) {
    targetPrefectures = env.SCRAPE_PREFECTURES.split(',').map(s => s.trim()) as PrefectureCode[];
  } else {
    const dow = new Date().getDay(); // 0=Sun … 6=Sat
    // Rotation index: getDay() returns 0 for Sunday; map Sun→6, Mon→0, …
    const idx = dow === 0 ? 6 : dow - 1;
    targetPrefectures = PREFECTURE_ROTATION[idx] ?? PREFECTURE_ROTATION[0];
  }

  const scrapers = createScrapers();
  const maxResults = parseInt(env.MAX_RESULTS_PER_SITE ?? '15');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let total = 0, newCount = 0, updatedCount = 0, soldCount = 0;
  const errors: string[] = [];

  for (const prefecture of targetPrefectures) {
    for (const siteId of ALL_SITE_IDS) {
      const scraper = scrapers[siteId];
      if (!scraper) continue;

      const jobId = `${siteId}_${prefecture}_${Date.now()}`;
      try {
        // INSERT OR IGNORE so duplicate jobs don't fail
        await env.MAL_DB.prepare(
          `INSERT OR IGNORE INTO scrape_jobs (id, site_id, prefecture, status, started_at)
           VALUES (?, ?, ?, 'running', datetime('now'))`
        ).bind(jobId, siteId, prefecture).run();

        const properties = await Promise.race([
          scraper.scrapeListings({ prefecture, maxResults }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), SCRAPER_TIMEOUT_MS)),
        ]);

        // ── Per-site mock guard ───────────────────────────────────────────────
        // Skip DB write only for THIS site's mock data; other sites proceed.
        if (isMockData(properties)) {
          await env.MAL_DB.prepare(
            `UPDATE scrape_jobs SET status = 'skipped_mock', completed_at = datetime('now') WHERE id = ?`
          ).bind(jobId).run();
          continue;
        }

        let jobNew = 0, jobUpdated = 0, jobSold = 0;

        // Get existing active property IDs for this site+prefecture (for new/updated counting)
        const existingRows = await env.MAL_DB
          .prepare(
            `SELECT site_property_id FROM properties
             WHERE site_id = ? AND prefecture = ? AND status = 'active'`
          )
          .bind(siteId, prefecture)
          .all<{ site_property_id: string }>();

        const existingSet = new Set(
          (existingRows.results ?? []).map(r => r.site_property_id)
        );

        // ── Upsert scraped properties ─────────────────────────────────────────
        for (const prop of properties) {
          const id = `${prop.siteId}_${prop.sitePropertyId}`;
          const isNew = !existingSet.has(prop.sitePropertyId);
          if (isNew) jobNew++; else jobUpdated++;

          await env.MAL_DB.prepare(`
            INSERT INTO properties (
              id, site_id, site_property_id, title, property_type, status,
              prefecture, city, address, price, price_text, area, building_area, land_area,
              rooms, age, floor, total_floors, station, station_minutes,
              thumbnail_url, detail_url, description, yield_rate, latitude, longitude,
              fingerprint, last_seen_at,
              created_at, updated_at, scraped_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
            ON CONFLICT(site_id, site_property_id) DO UPDATE SET
              title         = excluded.title,
              price         = excluded.price,
              price_text    = excluded.price_text,
              area          = COALESCE(excluded.area, area),
              thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
              description   = COALESCE(excluded.description, description),
              yield_rate    = COALESCE(excluded.yield_rate, yield_rate),
              fingerprint   = excluded.fingerprint,
              last_seen_at  = datetime('now'),
              status        = CASE WHEN status = 'sold' THEN 'sold' ELSE 'active' END,
              updated_at    = datetime('now'),
              scraped_at    = datetime('now')
          `).bind(
            id, prop.siteId, prop.sitePropertyId, prop.title, prop.propertyType,
            prop.prefecture, prop.city ?? '', prop.address ?? null,
            prop.price ?? null, prop.priceText ?? '', prop.area ?? null,
            prop.buildingArea ?? null, prop.landArea ?? null,
            prop.rooms ?? null, prop.age ?? null, prop.floor ?? null, prop.totalFloors ?? null,
            prop.station ?? null, prop.stationMinutes ?? null,
            prop.thumbnailUrl ?? null, prop.detailUrl, prop.description ?? null,
            prop.yieldRate ?? null, prop.latitude ?? null, prop.longitude ?? null,
            prop.fingerprint ?? null
          ).run();

          // ── Price history (one entry per property per day) ──────────────────
          if (prop.price !== null) {
            await env.MAL_DB.prepare(`
              INSERT OR IGNORE INTO price_history (property_id, price, recorded_at)
              VALUES (?, ?, ?)
            `).bind(id, prop.price, today).run();
          }
        }

        // ── Mark sold: active properties not seen in the last 48 hours ────────
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const soldResult = await env.MAL_DB.prepare(`
          UPDATE properties
          SET status = 'sold', sold_at = datetime('now'), updated_at = datetime('now')
          WHERE site_id = ? AND prefecture = ? AND status = 'active'
            AND (last_seen_at IS NULL OR last_seen_at < ?)
        `).bind(siteId, prefecture, cutoff).run();
        jobSold = (soldResult.meta?.changes as number | undefined) ?? 0;

        await env.MAL_DB.prepare(`
          UPDATE scrape_jobs
          SET status = 'completed',
              properties_found   = ?,
              properties_new     = ?,
              properties_updated = ?,
              properties_sold    = ?,
              completed_at = datetime('now')
          WHERE id = ?
        `).bind(properties.length, jobNew, jobUpdated, jobSold, jobId).run();

        total        += properties.length;
        newCount     += jobNew;
        updatedCount += jobUpdated;
        soldCount    += jobSold;

      } catch (err) {
        const msg = `${siteId}/${prefecture}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        try {
          await env.MAL_DB.prepare(
            `UPDATE scrape_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`
          ).bind(msg, jobId).run();
        } catch { /* ignore secondary failure */ }
      }
    }
  }

  return { total, newCount, updatedCount, soldCount, errors };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterProperties(props: Property[], params: SearchParams): Property[] {
  return props.filter(p => {
    if (params.priceMin !== undefined && p.price !== null && p.price < params.priceMin) return false;
    if (params.priceMax !== undefined && p.price !== null && p.price > params.priceMax) return false;
    if (params.areaMin  !== undefined && p.area  !== null && p.area  < params.areaMin)  return false;
    if (params.areaMax  !== undefined && p.area  !== null && p.area  > params.areaMax)  return false;
    if (params.rooms        && p.rooms        !== params.rooms)        return false;
    if (params.ageMax  !== undefined && p.age   !== null && p.age    > params.ageMax)   return false;
    if (params.stationMinutes !== undefined && p.stationMinutes !== null && p.stationMinutes > params.stationMinutes) return false;
    if (params.yieldMin !== undefined && p.yieldRate !== null && p.yieldRate < params.yieldMin) return false;
    if (params.query) {
      const q = params.query.toLowerCase();
      if (!`${p.title} ${p.address ?? ''} ${p.description ?? ''}`.toLowerCase().includes(q)) return false;
    }
    if (params.propertyType && p.propertyType !== params.propertyType) return false;
    return true;
  });
}

function sortProperties(props: Property[], sortBy: string): Property[] {
  return [...props].sort((a, b) => {
    switch (sortBy) {
      case 'price_asc':  return (a.price    ?? Infinity)  - (b.price    ?? Infinity);
      case 'price_desc': return (b.price    ?? -Infinity) - (a.price    ?? -Infinity);
      case 'area_asc':   return (a.area     ?? Infinity)  - (b.area     ?? Infinity);
      case 'area_desc':  return (b.area     ?? -Infinity) - (a.area     ?? -Infinity);
      case 'yield_desc': return (b.yieldRate ?? -Infinity) - (a.yieldRate ?? -Infinity);
      case 'newest':     return b.scrapedAt.localeCompare(a.scrapedAt);
      default:           return 0;
    }
  });
}
