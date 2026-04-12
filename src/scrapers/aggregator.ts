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

const ALL_SITE_IDS: SiteId[] = ['suumo', 'homes', 'athome', 'fudosan', 'chintai', 'smaity', 'reins', 'kenbiya', 'rakumachi'];

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
        result: { siteId, count: 0, status: errorMessage === 'Scraper timeout' ? 'timeout' : 'error', errorMessage, executionTimeMs },
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
 * Run scheduled full scrape: scrape all sites for major prefectures,
 * upsert to DB, and mark sold properties.
 */
export async function runScheduledScrape(env: Bindings): Promise<{
  total: number;
  newCount: number;
  updatedCount: number;
  soldCount: number;
  errors: string[];
}> {
  // Scrape major prefectures by default (top 13 by population)
  const targetPrefectures: PrefectureCode[] = ['13', '27', '14', '23', '11', '12', '01', '26', '28', '40', '22', '08', '07'];
  const scrapers = createScrapers();
  const maxResults = parseInt(env.MAX_RESULTS_PER_SITE ?? '15');

  let total = 0, newCount = 0, updatedCount = 0, soldCount = 0;
  const errors: string[] = [];

  for (const prefecture of targetPrefectures) {
    for (const siteId of ALL_SITE_IDS) {
      const scraper = scrapers[siteId];
      if (!scraper) continue;

      try {
        const jobId = `${siteId}_${prefecture}_${Date.now()}`;
        await env.MAL_DB.prepare(
          `INSERT INTO scrape_jobs (id, site_id, prefecture, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))`
        ).bind(jobId, siteId, prefecture).run();

        const properties = await Promise.race([
          scraper.scrapeListings({ prefecture, maxResults }),
          new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), SCRAPER_TIMEOUT_MS)),
        ]);

        let jobNew = 0, jobUpdated = 0, jobSold = 0;

        // Get existing active property IDs for this site+prefecture
        const existingRows = await env.MAL_DB
          .prepare(`SELECT id, site_property_id FROM properties WHERE site_id = ? AND prefecture = ? AND status = 'active'`)
          .bind(siteId, prefecture)
          .all<{ id: string; site_property_id: string }>();

        const existingIds = new Set((existingRows.results ?? []).map(r => r.site_property_id));
        const foundIds = new Set(properties.map(p => p.sitePropertyId));

        // Upsert scraped properties
        for (const prop of properties) {
          const id = `${prop.siteId}_${prop.sitePropertyId}`;
          const isNew = !existingIds.has(prop.sitePropertyId);
          if (isNew) jobNew++; else jobUpdated++;

          await env.MAL_DB.prepare(`
            INSERT INTO properties (
              id, site_id, site_property_id, title, property_type, status,
              prefecture, city, address, price, price_text, area, building_area, land_area,
              rooms, age, floor, total_floors, station, station_minutes,
              thumbnail_url, detail_url, description, yield_rate, latitude, longitude,
              created_at, updated_at, scraped_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, datetime('now'), datetime('now'), datetime('now'))
            ON CONFLICT(site_id, site_property_id) DO UPDATE SET
              title = excluded.title,
              price = excluded.price,
              price_text = excluded.price_text,
              description = excluded.description,
              status = 'active',
              updated_at = datetime('now'),
              scraped_at = datetime('now')
          `).bind(
            id, prop.siteId, prop.sitePropertyId, prop.title, prop.propertyType,
            prop.prefecture, prop.city, prop.address ?? null,
            prop.price ?? null, prop.priceText, prop.area ?? null,
            prop.buildingArea ?? null, prop.landArea ?? null,
            prop.rooms ?? null, prop.age ?? null, prop.floor ?? null, prop.totalFloors ?? null,
            prop.station ?? null, prop.stationMinutes ?? null,
            prop.thumbnailUrl ?? null, prop.detailUrl, prop.description ?? null,
            prop.yieldRate ?? null, prop.latitude ?? null, prop.longitude ?? null
          ).run();
        }

        // Mark as sold: properties that were active but not found in this scrape
        for (const existing of (existingRows.results ?? [])) {
          if (!foundIds.has(existing.site_property_id)) {
            await env.MAL_DB.prepare(
              `UPDATE properties SET status = 'sold', sold_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
            ).bind(existing.id).run();
            jobSold++;
          }
        }

        await env.MAL_DB.prepare(
          `UPDATE scrape_jobs SET status = 'completed', properties_found = ?, properties_new = ?, properties_updated = ?, properties_sold = ?, completed_at = datetime('now') WHERE id = ?`
        ).bind(properties.length, jobNew, jobUpdated, jobSold, jobId).run();

        total += properties.length;
        newCount += jobNew;
        updatedCount += jobUpdated;
        soldCount += jobSold;

      } catch (err) {
        errors.push(`${siteId}/${prefecture}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Invalidate search caches after scrape
  try {
    await env.MAL_CACHE.list().then(async (list) => {
      for (const key of list.keys) {
        if (key.name.startsWith('search:')) {
          await env.MAL_CACHE.delete(key.name).catch(() => {});
        }
      }
    });
  } catch {}

  return { total, newCount, updatedCount, soldCount, errors };
}

function filterProperties(props: Property[], params: SearchParams): Property[] {
  return props.filter(p => {
    if (params.priceMin !== undefined && p.price !== null && p.price < params.priceMin) return false;
    if (params.priceMax !== undefined && p.price !== null && p.price > params.priceMax) return false;
    if (params.areaMin !== undefined && p.area !== null && p.area < params.areaMin) return false;
    if (params.areaMax !== undefined && p.area !== null && p.area > params.areaMax) return false;
    if (params.rooms && p.rooms !== params.rooms) return false;
    if (params.ageMax !== undefined && p.age !== null && p.age > params.ageMax) return false;
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
      case 'price_asc':   return (a.price ?? Infinity) - (b.price ?? Infinity);
      case 'price_desc':  return (b.price ?? -Infinity) - (a.price ?? -Infinity);
      case 'area_asc':    return (a.area ?? Infinity) - (b.area ?? Infinity);
      case 'area_desc':   return (b.area ?? -Infinity) - (a.area ?? -Infinity);
      case 'yield_desc':  return (b.yieldRate ?? -Infinity) - (a.yieldRate ?? -Infinity);
      case 'newest':      return b.scrapedAt.localeCompare(a.scrapedAt);
      default:            return 0;
    }
  });
}
