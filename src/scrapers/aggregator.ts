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
const DETAIL_TIMEOUT_MS = 10000;
/** Max detail pages to fetch per site per scheduled scrape (CPU budget) */
const MAX_DETAIL_FETCHES_PER_SITE = 5;

const ALL_SITE_IDS: SiteId[] = [
  'suumo', 'homes', 'athome', 'fudosan', 'chintai',
  'smaity', 'reins', 'kenbiya', 'rakumachi',
];

/**
 * Rotate prefectures by day-of-week to stay within Cloudflare CPU limits.
 * Full 47-prefecture coverage over a 14-day cycle (2 weeks).
 * Major metro areas appear in Week 1 (Mon-Sun), remaining in Week 2.
 */
const PREFECTURE_ROTATION: PrefectureCode[][] = [
  // Week 1: Major metro areas (high property density)
  ['13', '27'],             // Mon  東京・大阪
  ['14', '23'],             // Tue  神奈川・愛知
  ['11', '12'],             // Wed  埼玉・千葉
  ['01', '40'],             // Thu  北海道・福岡
  ['26', '28'],             // Fri  京都・兵庫
  ['22', '34', '04'],       // Sat  静岡・広島・宮城
  ['08', '15', '20'],       // Sun  茨城・新潟・長野
  // Week 2: Remaining prefectures
  ['02', '03', '05', '06'], // Mon  青森・岩手・秋田・山形
  ['07', '09', '10'],       // Tue  福島・栃木・群馬
  ['16', '17', '18', '19'], // Wed  富山・石川・福井・山梨
  ['21', '24', '25'],       // Thu  岐阜・三重・滋賀
  ['29', '30', '31', '32', '33'], // Fri  奈良・和歌山・鳥取・島根・岡山
  ['35', '36', '37', '38', '39'], // Sat  山口・徳島・香川・愛媛・高知
  ['41', '42', '43', '44', '45', '46', '47'], // Sun  佐賀〜沖縄
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
 * Guard: if every property ID contains "mock_" this is pure mock data.
 * In that case we skip DB writes and sold-detection to avoid poisoning the DB.
 */
function isAllMockData(properties: Property[]): boolean {
  if (properties.length === 0) return true;
  return properties.every(p => p.sitePropertyId.includes('mock_'));
}

/**
 * Enrich properties with detail page data.
 * Fetches detail pages for properties missing critical fields.
 * Respects CPU budget by limiting concurrent fetches.
 */
async function enrichWithDetails(
  scraper: BaseScraper,
  properties: Property[],
  maxFetches: number
): Promise<Property[]> {
  // Prioritize properties missing the most fields
  const needsEnrichment = properties
    .map((p, idx) => {
      let score = 0;
      if (p.age === null) score += 2;
      if (p.floor === null && p.propertyType === 'mansion') score += 1;
      if (p.latitude === null) score += 2;
      if (p.address === null) score += 1;
      if (p.images.length <= 1) score += 1;
      if (p.buildingArea === null && p.landArea === null) score += 1;
      return { idx, score, url: p.detailUrl };
    })
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFetches);

  const enriched = [...properties];

  for (const item of needsEnrichment) {
    try {
      const detail = await Promise.race([
        scraper.scrapeDetail(item.url),
        new Promise<Partial<Property>>((_, r) => setTimeout(() => r(new Error('detail timeout')), DETAIL_TIMEOUT_MS)),
      ]);

      // Merge detail data into property (only fill nulls, don't overwrite existing data)
      const prop = enriched[item.idx];
      if (detail.address && !prop.address) prop.address = detail.address;
      if (detail.age !== undefined && prop.age === null) prop.age = detail.age;
      if (detail.floor !== undefined && prop.floor === null) prop.floor = detail.floor ?? null;
      if (detail.totalFloors !== undefined && prop.totalFloors === null) prop.totalFloors = detail.totalFloors ?? null;
      if (detail.direction && !prop.direction) prop.direction = detail.direction;
      if (detail.structure && !prop.structure) prop.structure = detail.structure;
      if (detail.buildingArea && !prop.buildingArea) prop.buildingArea = detail.buildingArea;
      if (detail.landArea && !prop.landArea) prop.landArea = detail.landArea;
      if (detail.latitude && !prop.latitude) prop.latitude = detail.latitude;
      if (detail.longitude && !prop.longitude) prop.longitude = detail.longitude;
      if (detail.managementFee && !prop.managementFee) prop.managementFee = detail.managementFee;
      if (detail.repairFund && !prop.repairFund) prop.repairFund = detail.repairFund;
      if (detail.images && detail.images.length > prop.images.length) prop.images = detail.images;
      if (detail.floorPlanUrl && !prop.floorPlanUrl) prop.floorPlanUrl = detail.floorPlanUrl;
      if (detail.exteriorUrl && !prop.exteriorUrl) prop.exteriorUrl = detail.exteriorUrl;
      if (detail.description && !prop.description) prop.description = detail.description;
      if (detail.features && detail.features.length > prop.features.length) prop.features = detail.features;
      if (detail.rooms && !prop.rooms) prop.rooms = detail.rooms;
      if (detail.station && !prop.station) prop.station = detail.station;
      if (detail.stationMinutes !== undefined && prop.stationMinutes === null) prop.stationMinutes = detail.stationMinutes ?? null;
      if (detail.yieldRate !== undefined && prop.yieldRate === null) prop.yieldRate = detail.yieldRate ?? null;
    } catch {
      // Detail fetch failed — keep list-level data
    }
  }

  return enriched;
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
 * - Rotates prefectures on a 14-day cycle covering all 47 prefectures
 * - Override via env.SCRAPE_PREFECTURES
 * - Tier 1: List scrape → Tier 2: Detail enrichment for top properties
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
  detailEnriched: number;
  errors: string[];
}> {
  // Determine which prefectures to scrape today
  let targetPrefectures: PrefectureCode[];
  if (env.SCRAPE_PREFECTURES) {
    targetPrefectures = env.SCRAPE_PREFECTURES.split(',').map(s => s.trim()) as PrefectureCode[];
  } else {
    // 14-day rotation: use day-of-year mod 14
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
    const idx = dayOfYear % PREFECTURE_ROTATION.length;
    targetPrefectures = PREFECTURE_ROTATION[idx] ?? PREFECTURE_ROTATION[0];
  }

  const scrapers = createScrapers();
  const maxResults = parseInt(env.MAX_RESULTS_PER_SITE ?? '15');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let total = 0, newCount = 0, updatedCount = 0, soldCount = 0, detailEnriched = 0;
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

        // ── Tier 1: List scrape ──────────────────────────────────────────────
        let properties = await Promise.race([
          scraper.scrapeListings({ prefecture, maxResults }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), SCRAPER_TIMEOUT_MS)),
        ]);

        // ── Mock guard ────────────────────────────────────────────────────────
        if (isAllMockData(properties)) {
          await env.MAL_DB.prepare(
            `UPDATE scrape_jobs SET status = 'skipped_mock', completed_at = datetime('now') WHERE id = ?`
          ).bind(jobId).run();
          continue;
        }

        // ── Tier 2: Detail enrichment for new/incomplete properties ──────────
        const enrichedCount = properties.filter(p =>
          p.age === null || p.latitude === null || (p.address === null && p.propertyType !== 'tochi')
        ).length;

        if (enrichedCount > 0) {
          try {
            properties = await enrichWithDetails(scraper, properties, MAX_DETAIL_FETCHES_PER_SITE);
            detailEnriched += Math.min(enrichedCount, MAX_DETAIL_FETCHES_PER_SITE);
          } catch {
            // Detail enrichment failure is non-fatal — use list-level data
          }
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
              building_area = COALESCE(excluded.building_area, building_area),
              land_area     = COALESCE(excluded.land_area, land_area),
              rooms         = COALESCE(excluded.rooms, rooms),
              age           = COALESCE(excluded.age, age),
              floor         = COALESCE(excluded.floor, floor),
              total_floors  = COALESCE(excluded.total_floors, total_floors),
              station       = COALESCE(excluded.station, station),
              station_minutes = COALESCE(excluded.station_minutes, station_minutes),
              thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
              description   = COALESCE(excluded.description, description),
              yield_rate    = COALESCE(excluded.yield_rate, yield_rate),
              latitude      = COALESCE(excluded.latitude, latitude),
              longitude     = COALESCE(excluded.longitude, longitude),
              address       = COALESCE(excluded.address, address),
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

  return { total, newCount, updatedCount, soldCount, detailEnriched, errors };
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
