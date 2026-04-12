import { Hono } from 'hono';
import type { Bindings, AppVariables, SearchParams, SiteId, PrefectureCode } from '../types';
import { searchProperties } from '../db/queries';
import { aggregateSearch } from '../scrapers/aggregator';

export const searchRouter = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

searchRouter.get('/', async (c) => {
  const query = c.req.query();
  const startTime = Date.now();

  const params: SearchParams = {
    query: query.q,
    prefecture: query.prefecture as PrefectureCode | undefined,
    city: query.city,
    propertyType: query.type as SearchParams['propertyType'],
    priceMin: query.price_min ? parseInt(query.price_min) : undefined,
    priceMax: query.price_max ? parseInt(query.price_max) : undefined,
    areaMin: query.area_min ? parseFloat(query.area_min) : undefined,
    areaMax: query.area_max ? parseFloat(query.area_max) : undefined,
    rooms: query.rooms,
    ageMax: query.age_max ? parseInt(query.age_max) : undefined,
    stationMinutes: query.station_min ? parseInt(query.station_min) : undefined,
    sites: query.sites ? (query.sites.split(',') as SiteId[]) : undefined,
    sortBy: query.sort as SearchParams['sortBy'],
    page: query.page ? parseInt(query.page) : 1,
    limit: query.limit ? parseInt(query.limit) : 20,
  };

  const cacheKey = `search:${new URLSearchParams(query).toString()}`;

  try {
    const cached = await c.env.MAL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) {
      return c.json({ ...(cached as object), cacheHit: true });
    }
  } catch {}

  try {
    const dbResult = await searchProperties(c.env.MAL_DB, params);

    if (dbResult.total > 0) {
      const ttl = parseInt(c.env.CACHE_TTL_SECONDS ?? '3600');
      await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(dbResult), { expirationTtl: ttl }).catch(() => {});
      return c.json(dbResult);
    }

    // Fallback to live scraping
    const { properties, siteResults } = await aggregateSearch(params, c.env);
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const start = (page - 1) * limit;

    const result = {
      properties: properties.slice(start, start + limit),
      total: properties.length,
      page,
      limit,
      totalPages: Math.ceil(properties.length / limit),
      sites: siteResults,
      executionTimeMs: Date.now() - startTime,
      cacheHit: false,
    };

    const ttl = parseInt(c.env.CACHE_TTL_SECONDS ?? '3600');
    await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl }).catch(() => {});
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Search failed', message: String(error) }, 500);
  }
});

searchRouter.get('/suggest', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q || q.length < 1) return c.json({ suggestions: [] });

  try {
    const rows = await c.env.MAL_DB
      .prepare('SELECT DISTINCT city FROM properties WHERE city LIKE ? LIMIT 10')
      .bind(`%${q}%`)
      .all<{ city: string }>();

    return c.json({ suggestions: rows.results?.map(r => r.city) ?? [] });
  } catch {
    return c.json({ suggestions: [] });
  }
});

searchRouter.get('/popular', async (c) => {
  try {
    const rows = await c.env.MAL_DB
      .prepare(`
        SELECT query, COUNT(*) as count
        FROM search_logs
        WHERE query IS NOT NULL AND searched_at > datetime('now', '-7 days')
        GROUP BY query
        ORDER BY count DESC
        LIMIT 10
      `)
      .all<{ query: string; count: number }>();

    return c.json({ popularSearches: rows.results ?? [] });
  } catch {
    return c.json({ popularSearches: [] });
  }
});
