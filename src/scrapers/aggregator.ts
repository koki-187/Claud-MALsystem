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

const SCRAPER_TIMEOUT_MS = 20000;

export async function aggregateSearch(
  params: SearchParams,
  env: Bindings
): Promise<{ properties: Property[]; siteResults: SiteSearchResult[] }> {
  const siteIds: SiteId[] = params.sites ?? ['suumo', 'homes', 'athome', 'fudosan', 'chintai', 'smaity', 'reins'];
  const prefecture: PrefectureCode = params.prefecture ?? '13';

  const scrapers: Record<SiteId, BaseScraper> = {
    suumo:   new SuumoScraper(),
    homes:   new HomesScraper(),
    athome:  new AthomeScraper(),
    fudosan: new FudosanScraper(),
    chintai: new ChintaiScraper(),
    smaity:  new SmaityScraper(),
    reins:   new ReinsScraper(),
  };

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

      const scrapePromise = scraper.scrapeListings({ prefecture, maxResults });

      const properties = await Promise.race([scrapePromise, timeoutPromise]);
      const executionTimeMs = Date.now() - startTime;

      return {
        siteId,
        properties,
        result: { siteId, count: properties.length, status: 'success', executionTimeMs },
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const status = errorMessage === 'Scraper timeout' ? 'timeout' : 'error';
      return {
        siteId,
        properties: [],
        result: { siteId, count: 0, status, errorMessage, executionTimeMs },
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
      // Promise.allSettled rejection is extremely rare (inner try/catch handles most cases)
      // siteId cannot be determined from a rejected promise at this level
      siteResults.push({
        siteId: siteIds[siteResults.length] ?? ('suumo' as SiteId),
        count: 0,
        status: 'error',
        errorMessage: result.reason?.message ?? 'Unknown error',
        executionTimeMs: 0,
      });
    }
  }

  const filtered = filterProperties(allProperties, params);
  const sorted = sortProperties(filtered, params.sortBy ?? 'newest');

  return { properties: sorted, siteResults };
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
    if (params.query) {
      const q = params.query.toLowerCase();
      const haystack = `${p.title} ${p.address ?? ''} ${p.description ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (params.propertyType && p.propertyType !== params.propertyType) return false;
    return true;
  });
}

function sortProperties(props: Property[], sortBy: string): Property[] {
  return [...props].sort((a, b) => {
    switch (sortBy) {
      case 'price_asc':  return (a.price ?? Infinity) - (b.price ?? Infinity);
      case 'price_desc': return (b.price ?? -Infinity) - (a.price ?? -Infinity);
      case 'area_asc':   return (a.area ?? Infinity) - (b.area ?? Infinity);
      case 'area_desc':  return (b.area ?? -Infinity) - (a.area ?? -Infinity);
      case 'newest':     return b.scrapedAt.localeCompare(a.scrapedAt);
      default:           return 0;
    }
  });
}
