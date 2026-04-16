import type { D1Database } from '@cloudflare/workers-types';
import type { Property, SearchParams, SearchResult, ScrapeJob, SiteId } from '../types';

export async function searchProperties(
  db: D1Database,
  params: SearchParams
): Promise<SearchResult> {
  const startTime = Date.now();
  const page = params.page ?? 1;
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const whereClauses: string[] = [];
  const bindings: (string | number)[] = [];

  // By default, only show active properties
  const statusFilter = params.status === 'all' ? undefined : (params.status ?? 'active');
  if (statusFilter) {
    whereClauses.push('p.status = ?');
    bindings.push(statusFilter);
  }

  if (params.prefecture) {
    whereClauses.push('p.prefecture = ?');
    bindings.push(params.prefecture);
  }
  if (params.city) {
    whereClauses.push('p.city LIKE ?');
    bindings.push(`%${params.city}%`);
  }
  if (params.propertyType) {
    whereClauses.push('p.property_type = ?');
    bindings.push(params.propertyType);
  }
  if (params.priceMin !== undefined) {
    whereClauses.push('p.price >= ?');
    bindings.push(params.priceMin);
  }
  if (params.priceMax !== undefined) {
    whereClauses.push('p.price <= ?');
    bindings.push(params.priceMax);
  }
  if (params.areaMin !== undefined) {
    whereClauses.push('p.area >= ?');
    bindings.push(params.areaMin);
  }
  if (params.areaMax !== undefined) {
    whereClauses.push('p.area <= ?');
    bindings.push(params.areaMax);
  }
  if (params.rooms) {
    whereClauses.push('p.rooms = ?');
    bindings.push(params.rooms);
  }
  if (params.ageMax !== undefined) {
    whereClauses.push('(p.age IS NULL OR p.age <= ?)');
    bindings.push(params.ageMax);
  }
  if (params.stationMinutes !== undefined) {
    whereClauses.push('(p.station_minutes IS NULL OR p.station_minutes <= ?)');
    bindings.push(params.stationMinutes);
  }
  if (params.yieldMin !== undefined) {
    whereClauses.push('p.yield_rate >= ?');
    bindings.push(params.yieldMin);
  }
  if (params.floorMin !== undefined) {
    whereClauses.push('p.floor >= ?');
    bindings.push(params.floorMin);
  }
  if (params.landAreaMin !== undefined) {
    whereClauses.push('p.land_area >= ?');
    bindings.push(params.landAreaMin);
  }
  if (params.buildingAreaMin !== undefined) {
    whereClauses.push('p.building_area >= ?');
    bindings.push(params.buildingAreaMin);
  }
  if (params.structure) {
    whereClauses.push('p.structure LIKE ?');
    bindings.push(`%${params.structure}%`);
  }
  if (params.hasCoordinates) {
    whereClauses.push('p.latitude IS NOT NULL AND p.longitude IS NOT NULL');
  }
  if (params.sites && params.sites.length > 0) {
    const placeholders = params.sites.map(() => '?').join(', ');
    whereClauses.push(`p.site_id IN (${placeholders})`);
    bindings.push(...params.sites);
  }
  if (params.query) {
    whereClauses.push('(p.title LIKE ? OR p.address LIKE ? OR p.description LIKE ?)');
    const q = `%${params.query}%`;
    bindings.push(q, q, q);
  }
  if (params.hideDuplicates) {
    whereClauses.push(`p.id IN (
      SELECT MIN(id) FROM properties WHERE fingerprint IS NOT NULL
      GROUP BY fingerprint
      UNION ALL
      SELECT id FROM properties WHERE fingerprint IS NULL
    )`);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sortMap: Record<string, string> = {
    price_asc:   'p.price ASC NULLS LAST',
    price_desc:  'p.price DESC NULLS LAST',
    area_asc:    'p.area ASC NULLS LAST',
    area_desc:   'p.area DESC NULLS LAST',
    yield_desc:  'p.yield_rate DESC NULLS LAST',
    age_asc:     'p.age ASC NULLS LAST',
    age_desc:    'p.age DESC NULLS LAST',
    floor_desc:  'p.floor DESC NULLS LAST',
    newest:      'p.scraped_at DESC',
    relevance:   'p.scraped_at DESC',
  };
  const orderSQL = sortMap[params.sortBy ?? 'newest'] ?? 'p.scraped_at DESC';

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM properties p ${whereSQL}`)
    .bind(...bindings)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  const rows = await db
    .prepare(`
      SELECT p.*,
        GROUP_CONCAT(DISTINCT pi.image_url) as images_concat,
        GROUP_CONCAT(DISTINCT pf.feature) as features_concat
      FROM properties p
      LEFT JOIN property_images pi ON pi.property_id = p.id
      LEFT JOIN property_features pf ON pf.property_id = p.id
      ${whereSQL}
      GROUP BY p.id
      ORDER BY ${orderSQL}
      LIMIT ? OFFSET ?
    `)
    .bind(...bindings, limit, offset)
    .all<Record<string, unknown>>();

  const properties: Property[] = (rows.results ?? []).map(rowToProperty);

  const allSites: SiteId[] = ['suumo', 'homes', 'athome', 'fudosan', 'chintai', 'smaity', 'reins', 'kenbiya', 'rakumachi'];
  const siteCountRows = await db
    .prepare(`SELECT site_id, COUNT(*) as cnt FROM properties p ${whereSQL} GROUP BY site_id`)
    .bind(...bindings)
    .all<{ site_id: SiteId; cnt: number }>();

  const siteCounts = new Map((siteCountRows.results ?? []).map(r => [r.site_id, r.cnt]));
  const siteResults = allSites.map(siteId => ({
    siteId,
    count: siteCounts.get(siteId) ?? 0,
    status: 'success' as const,
    executionTimeMs: Date.now() - startTime,
  }));

  return {
    properties,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    sites: siteResults,
    executionTimeMs: Date.now() - startTime,
    cacheHit: false,
  };
}

export async function getPropertyById(db: D1Database, id: string): Promise<Property | null> {
  const row = await db
    .prepare(`
      SELECT p.*,
        GROUP_CONCAT(DISTINCT pi.image_url) as images_concat,
        GROUP_CONCAT(DISTINCT pf.feature) as features_concat
      FROM properties p
      LEFT JOIN property_images pi ON pi.property_id = p.id
      LEFT JOIN property_features pf ON pf.property_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
    `)
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) return null;
  const prop = rowToProperty(row);

  const histRows = await db.prepare(
    `SELECT recorded_at as date, price FROM price_history
     WHERE property_id = ? ORDER BY recorded_at ASC LIMIT 100`
  ).bind(prop.id).all<{ date: string; price: number }>();
  prop.priceHistory = histRows.results ?? [];

  return prop;
}

export async function upsertProperty(db: D1Database, prop: Omit<Property, 'id'>): Promise<string> {
  const id = `${prop.siteId}_${prop.sitePropertyId}`;
  await db.prepare(`
    INSERT INTO properties (
      id, site_id, site_property_id, title, property_type, status,
      prefecture, city, address, price, price_text, area, building_area, land_area,
      rooms, age, floor, total_floors, station, station_minutes,
      thumbnail_url, detail_url, description, yield_rate, latitude, longitude,
      fingerprint, management_fee, repair_fund, direction, structure,
      floor_plan_url, exterior_url, last_seen_at,
      created_at, updated_at, scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(site_id, site_property_id) DO UPDATE SET
      title          = COALESCE(excluded.title, properties.title),
      price          = COALESCE(excluded.price, properties.price),
      price_text     = COALESCE(excluded.price_text, properties.price_text),
      area           = COALESCE(excluded.area, properties.area),
      building_area  = COALESCE(excluded.building_area, properties.building_area),
      land_area      = COALESCE(excluded.land_area, properties.land_area),
      rooms          = COALESCE(excluded.rooms, properties.rooms),
      age            = COALESCE(excluded.age, properties.age),
      floor          = COALESCE(excluded.floor, properties.floor),
      total_floors   = COALESCE(excluded.total_floors, properties.total_floors),
      station        = COALESCE(excluded.station, properties.station),
      station_minutes = COALESCE(excluded.station_minutes, properties.station_minutes),
      address        = COALESCE(excluded.address, properties.address),
      latitude       = COALESCE(excluded.latitude, properties.latitude),
      longitude      = COALESCE(excluded.longitude, properties.longitude),
      description    = COALESCE(excluded.description, properties.description),
      fingerprint    = COALESCE(excluded.fingerprint, properties.fingerprint),
      management_fee = COALESCE(excluded.management_fee, properties.management_fee),
      repair_fund    = COALESCE(excluded.repair_fund, properties.repair_fund),
      direction      = COALESCE(excluded.direction, properties.direction),
      structure      = COALESCE(excluded.structure, properties.structure),
      yield_rate     = COALESCE(excluded.yield_rate, properties.yield_rate),
      thumbnail_url  = COALESCE(excluded.thumbnail_url, properties.thumbnail_url),
      floor_plan_url = COALESCE(excluded.floor_plan_url, properties.floor_plan_url),
      exterior_url   = COALESCE(excluded.exterior_url, properties.exterior_url),
      last_seen_at   = COALESCE(excluded.last_seen_at, properties.last_seen_at),
      status         = CASE WHEN properties.status = 'sold' THEN 'sold' ELSE 'active' END,
      updated_at     = datetime('now'),
      scraped_at     = datetime('now')
  `).bind(
    id, prop.siteId, prop.sitePropertyId, prop.title, prop.propertyType, prop.status ?? 'active',
    prop.prefecture, prop.city, prop.address ?? null,
    prop.price ?? null, prop.priceText, prop.area ?? null,
    prop.buildingArea ?? null, prop.landArea ?? null,
    prop.rooms ?? null, prop.age ?? null, prop.floor ?? null, prop.totalFloors ?? null,
    prop.station ?? null, prop.stationMinutes ?? null,
    prop.thumbnailUrl ?? null, prop.detailUrl, prop.description ?? null,
    prop.yieldRate ?? null, prop.latitude ?? null, prop.longitude ?? null,
    prop.fingerprint ?? null,
    prop.managementFee ?? null, prop.repairFund ?? null,
    prop.direction ?? null, prop.structure ?? null,
    prop.floorPlanUrl ?? null, prop.exteriorUrl ?? null,
    prop.lastSeenAt ?? null
  ).run();

  return id;
}

export async function markPropertySold(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    `UPDATE properties SET status = 'sold', sold_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
}

export async function getStats(db: D1Database) {
  const [totalProps, activeProps, soldProps, siteBreakdown, prefBreakdown, recentJobs] = await Promise.all([
    db.prepare('SELECT COUNT(*) as total FROM properties').first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) as total FROM properties WHERE status = 'active'").first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) as total FROM properties WHERE status = 'sold'").first<{ total: number }>(),
    db.prepare("SELECT site_id, COUNT(*) as cnt FROM properties WHERE status = 'active' GROUP BY site_id").all<{ site_id: string; cnt: number }>(),
    db.prepare("SELECT prefecture, COUNT(*) as cnt FROM properties WHERE status = 'active' GROUP BY prefecture ORDER BY cnt DESC LIMIT 10").all<{ prefecture: string; cnt: number }>(),
    db.prepare('SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT 10').all<ScrapeJob>(),
  ]);

  return {
    totalProperties: totalProps?.total ?? 0,
    activeProperties: activeProps?.total ?? 0,
    soldProperties: soldProps?.total ?? 0,
    bysite: siteBreakdown.results ?? [],
    byPrefecture: prefBreakdown.results ?? [],
    recentJobs: recentJobs.results ?? [],
  };
}

export async function logSearch(
  db: D1Database,
  params: SearchParams,
  resultsCount: number,
  executionTimeMs: number
): Promise<void> {
  await db.prepare(`
    INSERT INTO search_logs (query, prefecture, property_type, price_min, price_max, results_count, execution_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    params.query ?? null,
    params.prefecture ?? null,
    params.propertyType ?? null,
    params.priceMin ?? null,
    params.priceMax ?? null,
    resultsCount,
    executionTimeMs
  ).run();
}

function rowToProperty(row: Record<string, unknown>): Property {
  return {
    id: row.id as string,
    siteId: row.site_id as SiteId,
    sitePropertyId: row.site_property_id as string,
    title: row.title as string,
    propertyType: row.property_type as Property['propertyType'],
    status: (row.status as Property['status']) ?? 'active',
    prefecture: row.prefecture as Property['prefecture'],
    city: row.city as string,
    address: (row.address as string) ?? null,
    price: (row.price as number) ?? null,
    priceText: (row.price_text as string) ?? '',
    area: (row.area as number) ?? null,
    buildingArea: (row.building_area as number) ?? null,
    landArea: (row.land_area as number) ?? null,
    rooms: (row.rooms as string) ?? null,
    age: (row.age as number) ?? null,
    floor: (row.floor as number) ?? null,
    totalFloors: (row.total_floors as number) ?? null,
    station: (row.station as string) ?? null,
    stationMinutes: (row.station_minutes as number) ?? null,
    images: row.images_concat ? (row.images_concat as string).split(',') : [],
    thumbnailUrl: (row.thumbnail_url as string) ?? null,
    detailUrl: row.detail_url as string,
    description: (row.description as string) ?? null,
    features: row.features_concat ? (row.features_concat as string).split(',').filter(Boolean) : [],
    yieldRate: (row.yield_rate as number) ?? null,
    latitude: (row.latitude as number) ?? null,
    longitude: (row.longitude as number) ?? null,
    priceHistory: [],
    listedAt: (row.listed_at as string) ?? null,
    soldAt: (row.sold_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    scrapedAt: row.scraped_at as string,
    fingerprint: (row.fingerprint as string) ?? null,
    managementFee: (row.management_fee as number) ?? null,
    repairFund: (row.repair_fund as number) ?? null,
    direction: (row.direction as string) ?? null,
    structure: (row.structure as string) ?? null,
    floorPlanUrl: (row.floor_plan_url as string) ?? null,
    exteriorUrl: (row.exterior_url as string) ?? null,
    lastSeenAt: (row.last_seen_at as string) ?? null,
  };
}
