import type { D1Database } from '@cloudflare/workers-types';
import type { Property, SearchParams, SearchResult, ScrapeJob, SiteId, MasterProperty, MasterSearchResult, SourceListing, Bindings } from '../types';

// ─── マルチ DB Federation ────────────────────────────────────────────────────
// DB1 (MAL_DB) は 500MB 満杯。新規書き込みは DB2 (MAL_DB2) へ。
// 検索は全 DB を並列クエリしてマージ。

/** DB リストを Bindings から取得 (null/undefined を除外) */
export function getReadDBs(env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>): D1Database[] {
  return [env.MAL_DB, env.MAL_DB2].filter(Boolean) as D1Database[];
}

/** 新規書き込み先: DB2 が優先、なければ DB1 */
export function getWriteDB(env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>): D1Database {
  return env.MAL_DB2 ?? env.MAL_DB;
}

/** インメモリで Property 配列をソート (マージ後に使用) */
function sortProperties(props: Property[], sortBy?: string): Property[] {
  const sorters: Record<string, (a: Property, b: Property) => number> = {
    price_asc:  (a, b) => (a.price ?? 1e15) - (b.price ?? 1e15),
    price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    area_asc:   (a, b) => (a.area ?? 1e15) - (b.area ?? 1e15),
    area_desc:  (a, b) => (b.area ?? -1) - (a.area ?? -1),
    yield_desc: (a, b) => (b.yieldRate ?? -1) - (a.yieldRate ?? -1),
    newest:     (a, b) => b.scrapedAt.localeCompare(a.scrapedAt),
    relevance:  (a, b) => b.scrapedAt.localeCompare(a.scrapedAt),
  };
  const fn = sorters[sortBy ?? 'newest'] ?? sorters.newest;
  return [...props].sort(fn);
}

/**
 * 全 DB を並列検索してマージ。
 * ページネーション: 各 DB から page*limit 件ずつ取得 → マージ → slice。
 */
export async function searchPropertiesFederated(
  env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>,
  params: SearchParams,
): Promise<SearchResult> {
  const dbs = getReadDBs(env);
  const startTime = Date.now();
  const page   = params.page  ?? 1;
  const limit  = Math.min(params.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  if (dbs.length === 1) {
    // シングル DB のときはそのまま (高速パス)
    return searchProperties(dbs[0], params);
  }

  // 各 DB から先頭 page*limit 件ずつ取得 (マージ後に正確なスライスが可能)
  const fetchParams: SearchParams = { ...params, page: 1, limit: page * limit };
  const allResults = await Promise.all(
    dbs.map(db => searchProperties(db, fetchParams).catch(() => null))
  );
  const valid = allResults.filter(Boolean) as SearchResult[];
  if (valid.length === 0) throw new Error('All DBs failed');

  // 合計件数は各 DB の total を合算
  const total = valid.reduce((sum, r) => sum + r.total, 0);

  // サイト別件数をマージ
  const siteMap = new Map<SiteId, number>();
  for (const r of valid) {
    for (const s of r.sites) {
      siteMap.set(s.siteId, (siteMap.get(s.siteId) ?? 0) + s.count);
    }
  }
  const sites = Array.from(siteMap.entries()).map(([siteId, count]) => ({
    siteId, count, status: 'success' as const, executionTimeMs: Date.now() - startTime,
  }));

  // 全件マージ → ソート → ページスライス
  const merged = sortProperties(valid.flatMap(r => r.properties), params.sortBy);
  const properties = merged.slice(offset, offset + limit);

  return {
    properties,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    sites,
    executionTimeMs: Date.now() - startTime,
    cacheHit: false,
  };
}

/**
 * 全 DB から ID で物件を検索 (どの DB にあるか不明なため全 DB を並列チェック)
 */
export async function getPropertyByIdFederated(
  env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>,
  id: string,
): Promise<Property | null> {
  const dbs = getReadDBs(env);
  const results = await Promise.all(dbs.map(db => getPropertyById(db, id).catch(() => null)));
  return results.find(Boolean) ?? null;
}

/**
 * CSV エクスポート用: 全 DB を並列検索して最大 maxRows 件を返す (ページネーションなし)。
 * searchProperties の 100 件上限を回避するため専用関数として実装。
 */
export async function searchPropertiesForExport(
  env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>,
  params: SearchParams,
  maxRows = 10000,
): Promise<Property[]> {
  const dbs = getReadDBs(env);
  const allResults = await Promise.all(
    dbs.map(db => searchPropertiesLarge(db, params, maxRows).catch(() => [] as Property[]))
  );
  const merged = sortProperties(allResults.flat(), params.sortBy);
  return merged.slice(0, maxRows);
}

/** searchProperties と同ロジックだが limit を maxRows まで許容する内部関数 */
async function searchPropertiesLarge(
  db: D1Database,
  params: SearchParams,
  maxRows: number,
): Promise<Property[]> {
  const limit = Math.min(params.limit ?? maxRows, maxRows);
  const whereClauses: string[] = [];
  const bindings: (string | number)[] = [];

  const statusFilter = params.status === 'all' ? undefined : (params.status ?? 'active');
  if (statusFilter) { whereClauses.push('p.status = ?'); bindings.push(statusFilter); }
  if (params.prefecture) { whereClauses.push('p.prefecture = ?'); bindings.push(params.prefecture); }
  if (params.city) { whereClauses.push('p.city LIKE ?'); bindings.push(`%${params.city}%`); }
  if (params.propertyType) { whereClauses.push('p.property_type = ?'); bindings.push(params.propertyType); }
  if (params.priceMin !== undefined) { whereClauses.push('p.price >= ?'); bindings.push(params.priceMin); }
  if (params.priceMax !== undefined) { whereClauses.push('p.price <= ?'); bindings.push(params.priceMax); }
  if (params.areaMin !== undefined) { whereClauses.push('p.area >= ?'); bindings.push(params.areaMin); }
  if (params.areaMax !== undefined) { whereClauses.push('p.area <= ?'); bindings.push(params.areaMax); }
  if (params.rooms) {
    const roomList = params.rooms.split(',').map(r => r.trim()).filter(Boolean);
    if (roomList.length === 1) { whereClauses.push('p.rooms = ?'); bindings.push(roomList[0]); }
    else if (roomList.length > 1) {
      whereClauses.push(`p.rooms IN (${roomList.map(() => '?').join(',')})`);
      bindings.push(...roomList);
    }
  }
  if (params.ageMax !== undefined) { whereClauses.push('(p.age IS NULL OR p.age <= ?)'); bindings.push(params.ageMax); }
  if (params.stationMinutes !== undefined) { whereClauses.push('(p.station_minutes IS NULL OR p.station_minutes <= ?)'); bindings.push(params.stationMinutes); }
  if (params.managementFeeMax !== undefined) { whereClauses.push('(p.management_fee IS NULL OR p.management_fee <= ?)'); bindings.push(params.managementFeeMax); }
  if (params.repairFundMax !== undefined) { whereClauses.push('(p.repair_fund IS NULL OR p.repair_fund <= ?)'); bindings.push(params.repairFundMax); }
  if (params.direction) { whereClauses.push('p.direction LIKE ?'); bindings.push(`%${params.direction}%`); }
  if (params.structure) { whereClauses.push('p.structure LIKE ?'); bindings.push(`%${params.structure}%`); }
  if (params.yieldMin !== undefined) { whereClauses.push('p.yield_rate >= ?'); bindings.push(params.yieldMin); }
  if (params.sites && params.sites.length > 0) {
    whereClauses.push(`p.site_id IN (${params.sites.map(() => '?').join(', ')})`);
    bindings.push(...params.sites);
  }
  if (params.query) {
    const ftsTokens = params.query.trim().replace(/["\(\)\[\]{}^*?]/g, ' ').split(/[\s　]+/).filter(Boolean);
    if (ftsTokens.length > 0) {
      whereClauses.push(`p.rowid IN (SELECT rowid FROM properties_fts WHERE properties_fts MATCH ? LIMIT 50000)`);
      bindings.push(ftsTokens.map(t => `"${t}"`).join(' '));
    }
  }
  const hideDups = params.hideDuplicates ?? true;
  if (hideDups) whereClauses.push('p.is_dedup_primary = 1');

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const sortMap: Record<string, string> = {
    price_asc: 'p.price ASC NULLS LAST', price_desc: 'p.price DESC NULLS LAST',
    area_asc: 'p.area ASC NULLS LAST', area_desc: 'p.area DESC NULLS LAST',
    yield_desc: 'p.yield_rate DESC NULLS LAST', newest: 'p.scraped_at DESC', relevance: 'p.scraped_at DESC',
  };
  const orderSQL = sortMap[params.sortBy ?? 'newest'] ?? 'p.scraped_at DESC';

  try {
    const rows = await db
      .prepare(`SELECT p.* FROM properties p ${whereSQL} ORDER BY ${orderSQL} LIMIT ?`)
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(rowToProperty);
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err);
    if (params.query && (msg.includes('no such table') || msg.includes('properties_fts'))) {
      // FTS5 フォールバック
      const fallbackClauses = whereClauses.filter(c => !c.includes('properties_fts'));
      const ftsIdx = whereClauses.findIndex(c => c.includes('properties_fts'));
      const fallbackBindings = bindings.filter((_, i) => ftsIdx < 0 || i !== ftsIdx);
      const likeTokens = params.query.trim().split(/[\s　]+/).filter(Boolean);
      const likeConditions = likeTokens.map(() => '(p.title LIKE ? OR p.address LIKE ? OR p.description LIKE ?)').join(' AND ');
      if (likeConditions) {
        fallbackClauses.push(`(${likeConditions})`);
        for (const t of likeTokens) fallbackBindings.push(`%${t}%`, `%${t}%`, `%${t}%`);
      }
      const fallbackWhereSQL = fallbackClauses.length > 0 ? `WHERE ${fallbackClauses.join(' AND ')}` : '';
      const rows = await db
        .prepare(`SELECT p.* FROM properties p ${fallbackWhereSQL} ORDER BY ${orderSQL} LIMIT ?`)
        .bind(...fallbackBindings, limit)
        .all<Record<string, unknown>>();
      return (rows.results ?? []).map(rowToProperty);
    }
    throw err;
  }
}

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
    const roomList = params.rooms.split(',').map(r => r.trim()).filter(Boolean);
    if (roomList.length === 1) {
      whereClauses.push('p.rooms = ?');
      bindings.push(roomList[0]);
    } else if (roomList.length > 1) {
      whereClauses.push(`p.rooms IN (${roomList.map(() => '?').join(',')})`);
      bindings.push(...roomList);
    }
  }
  if (params.ageMax !== undefined) {
    whereClauses.push('(p.age IS NULL OR p.age <= ?)');
    bindings.push(params.ageMax);
  }
  if (params.stationMinutes !== undefined) {
    // Include properties where station_minutes is unknown (NULL) — same behaviour as searchMasters
    whereClauses.push('(p.station_minutes IS NULL OR p.station_minutes <= ?)');
    bindings.push(params.stationMinutes);
  }
  if (params.managementFeeMax !== undefined) {
    whereClauses.push('(p.management_fee IS NULL OR p.management_fee <= ?)');
    bindings.push(params.managementFeeMax);
  }
  if (params.repairFundMax !== undefined) {
    whereClauses.push('(p.repair_fund IS NULL OR p.repair_fund <= ?)');
    bindings.push(params.repairFundMax);
  }
  if (params.direction) {
    whereClauses.push('p.direction LIKE ?');
    bindings.push(`%${params.direction}%`);
  }
  if (params.structure) {
    whereClauses.push('p.structure LIKE ?');
    bindings.push(`%${params.structure}%`);
  }
  if (params.yieldMin !== undefined) {
    whereClauses.push('p.yield_rate >= ?');
    bindings.push(params.yieldMin);
  }
  if (params.sites && params.sites.length > 0) {
    const placeholders = params.sites.map(() => '?').join(', ');
    whereClauses.push(`p.site_id IN (${placeholders})`);
    bindings.push(...params.sites);
  }
  if (params.query) {
    // FTS5全文検索 (1M件対応) — LIKE '%xxx%' フルスキャンを廃止
    // FTS5テーブルが存在しない場合 (migration未適用) は LIKE にフォールバック
    const ftsTokens = params.query.trim()
      .replace(/["\(\)\[\]{}^*?]/g, ' ')   // FTS5特殊文字を除去
      .split(/[\s　]+/).filter(Boolean);
    if (ftsTokens.length > 0) {
      // 複数ワードは AND 検索 (全ワード含む物件のみ)
      const ftsQuery = ftsTokens.map(t => `"${t}"`).join(' ');
      whereClauses.push(
        `p.rowid IN (SELECT rowid FROM properties_fts WHERE properties_fts MATCH ? LIMIT 50000)`
      );
      bindings.push(ftsQuery);
    }
  }
  // hideDuplicates: default true — use is_dedup_primary index (fast, no subquery)
  // false: show all rows including duplicates
  const hideDups = params.hideDuplicates ?? true;
  if (hideDups) {
    whereClauses.push('p.is_dedup_primary = 1');
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sortMap: Record<string, string> = {
    price_asc:   'p.price ASC NULLS LAST',
    price_desc:  'p.price DESC NULLS LAST',
    area_asc:    'p.area ASC NULLS LAST',
    area_desc:   'p.area DESC NULLS LAST',
    yield_desc:  'p.yield_rate DESC NULLS LAST',
    newest:      'p.scraped_at DESC',
    relevance:   'p.scraped_at DESC',
  };
  const orderSQL = sortMap[params.sortBy ?? 'newest'] ?? 'p.scraped_at DESC';

  // 1クエリで物件リストとサイト別件数を並列取得 (COUNT(*)クエリを排除)
  // FTS5テーブルが存在しない場合は LIKE にフォールバック
  async function runSearchQueries(wSQL: string, binds: (string | number)[]) {
    return Promise.all([
      db
        .prepare(`SELECT p.* FROM properties p ${wSQL} ORDER BY ${orderSQL} LIMIT ? OFFSET ?`)
        .bind(...binds, limit, offset)
        .all<Record<string, unknown>>(),
      db
        .prepare(`SELECT site_id, COUNT(*) as cnt FROM properties p ${wSQL} GROUP BY site_id`)
        .bind(...binds)
        .all<{ site_id: SiteId; cnt: number }>(),
    ]);
  }

  type _RunResult = Awaited<ReturnType<typeof runSearchQueries>>;
  let rows: _RunResult[0];
  let siteCountRows: _RunResult[1];
  try {
    [rows, siteCountRows] = await runSearchQueries(whereSQL, bindings);
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err);
    // FTS5テーブルが存在しない場合 → LIKE フォールバック
    if (params.query && (msg.includes('no such table') || msg.includes('properties_fts'))) {
      console.warn('[searchProperties] FTS5 not available, falling back to LIKE search');
      // FTS5 条件を除いた WHERE を再構築
      const fallbackClauses = whereClauses.filter(c => !c.includes('properties_fts'));
      const fallbackBindings = bindings.filter((_, i) => {
        // FTS5クエリのbinding (最後にpushされた ftsQuery) を除外するため、インデックスで判定
        const ftsIdx = whereClauses.findIndex(c => c.includes('properties_fts'));
        return ftsIdx < 0 || i !== ftsIdx;
      });
      // LIKE フォールバック条件を追加
      const likeTokens = params.query.trim().split(/[\s　]+/).filter(Boolean);
      const likeConditions = likeTokens.map(() => '(p.title LIKE ? OR p.address LIKE ? OR p.description LIKE ?)').join(' AND ');
      if (likeConditions) {
        fallbackClauses.push(`(${likeConditions})`);
        for (const t of likeTokens) { fallbackBindings.push(`%${t}%`, `%${t}%`, `%${t}%`); }
      }
      const fallbackWhereSQL = fallbackClauses.length > 0 ? `WHERE ${fallbackClauses.join(' AND ')}` : '';
      [rows, siteCountRows] = await runSearchQueries(fallbackWhereSQL, fallbackBindings);
    } else {
      throw err;
    }
  }

  const properties: Property[] = (rows.results ?? []).map(rowToProperty);

  // ローカルスクレイパー収集分 (suumo_chintai/baibai) + terass集計分 + 直接スクレイパー分
  const allSites: SiteId[] = [
    'terass_suumo', 'terass_reins', 'terass_athome',
    'suumo_baibai', 'suumo_chintai',
    'kenbiya', 'rakumachi', 'chintai',
    'homes', 'fudosan', 'smaity',
  ];
  const siteCounts = new Map((siteCountRows.results ?? []).map(r => [r.site_id, r.cnt]));
  // サイト件数の合計を total として使用 (別途 COUNT(*) クエリ不要)
  const total = Array.from(siteCounts.values()).reduce((a, b) => a + b, 0);
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
        GROUP_CONCAT(DISTINCT pi.r2_key) as image_keys_concat,
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
      title          = excluded.title,
      price          = excluded.price,
      price_text     = excluded.price_text,
      description    = excluded.description,
      fingerprint    = excluded.fingerprint,
      management_fee = excluded.management_fee,
      repair_fund    = excluded.repair_fund,
      direction      = excluded.direction,
      structure      = excluded.structure,
      floor_plan_url = excluded.floor_plan_url,
      exterior_url   = excluded.exterior_url,
      last_seen_at   = excluded.last_seen_at,
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
    db.prepare("SELECT * FROM scrape_jobs WHERE started_at > datetime('now', '-7 days') ORDER BY started_at DESC LIMIT 10").all<ScrapeJob>(),
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

/** DB1+DB2 の stats を並列集計してマージする */
export async function getStatsFederated(env: Pick<Bindings, 'MAL_DB' | 'MAL_DB2'>) {
  const dbs = getReadDBs(env);
  const results = await Promise.all(dbs.map(db => getStats(db).catch(() => null)));
  const valid = results.filter(Boolean) as Awaited<ReturnType<typeof getStats>>[];
  if (valid.length === 0) return {
    totalProperties: 0, activeProperties: 0, soldProperties: 0,
    bysite: [], byPrefecture: [], recentJobs: [],
  };
  if (valid.length === 1) return valid[0];
  // 合算: totalProperties / active / sold
  const totalProperties = valid.reduce((s, r) => s + r.totalProperties, 0);
  const activeProperties = valid.reduce((s, r) => s + r.activeProperties, 0);
  const soldProperties   = valid.reduce((s, r) => s + r.soldProperties, 0);
  // bysite: site_id ごとに合算
  const siteMap = new Map<string, number>();
  for (const r of valid) for (const s of r.bysite) siteMap.set(s.site_id, (siteMap.get(s.site_id) ?? 0) + s.cnt);
  const bysite = Array.from(siteMap.entries()).map(([site_id, cnt]) => ({ site_id, cnt }))
    .sort((a, b) => b.cnt - a.cnt);
  // byPrefecture: 合算 → 上位10件
  const prefMap = new Map<string, number>();
  for (const r of valid) for (const p of r.byPrefecture) prefMap.set(p.prefecture, (prefMap.get(p.prefecture) ?? 0) + p.cnt);
  const byPrefecture = Array.from(prefMap.entries()).map(([prefecture, cnt]) => ({ prefecture, cnt }))
    .sort((a, b) => b.cnt - a.cnt).slice(0, 10);
  // recentJobs: 全 DB のジョブを started_at 降順でマージ → 上位10件
  // (DB2 に scrape_jobs あり。aggregator が writeDb=DB2 に書くため DB2 が最新)
  const allJobs = valid.flatMap(r => r.recentJobs);
  const recentJobs = allJobs
    // D1 はスネークケースで返すため started_at で比較 (startedAt は undefined)
    .sort((a, b) => ((b as unknown as Record<string,string>).started_at ?? b.startedAt ?? '').localeCompare(
                    (a as unknown as Record<string,string>).started_at ?? a.startedAt ?? ''))
    .slice(0, 10);
  return { totalProperties, activeProperties, soldProperties, bysite, byPrefecture, recentJobs };
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

export async function searchMasters(
  db: D1Database,
  params: SearchParams,
): Promise<MasterSearchResult> {
  const startTime = Date.now();
  const page = params.page ?? 1;
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  const whereClauses: string[] = ['m.internal_status != \'sold\''];
  const bindings: (string | number)[] = [];

  if (params.prefecture) {
    whereClauses.push('m.prefecture = ?');
    bindings.push(params.prefecture);
  }
  if (params.city) {
    whereClauses.push('m.city LIKE ?');
    bindings.push(`%${params.city}%`);
  }
  if (params.propertyType) {
    whereClauses.push('m.property_type = ?');
    bindings.push(params.propertyType);
  }
  if (params.priceMin !== undefined) {
    whereClauses.push('m.price >= ?');
    bindings.push(params.priceMin);
  }
  if (params.priceMax !== undefined) {
    whereClauses.push('m.price <= ?');
    bindings.push(params.priceMax);
  }
  if (params.areaMin !== undefined) {
    whereClauses.push('m.area >= ?');
    bindings.push(params.areaMin);
  }
  if (params.areaMax !== undefined) {
    whereClauses.push('m.area <= ?');
    bindings.push(params.areaMax);
  }
  if (params.rooms) {
    const roomList = params.rooms.split(',').map(r => r.trim()).filter(Boolean);
    if (roomList.length === 1) {
      whereClauses.push('m.rooms = ?');
      bindings.push(roomList[0]);
    } else if (roomList.length > 1) {
      whereClauses.push(`m.rooms IN (${roomList.map(() => '?').join(',')})`);
      bindings.push(...roomList);
    }
  }
  if (params.ageMax !== undefined) {
    whereClauses.push('(m.age IS NULL OR m.age <= ?)');
    bindings.push(params.ageMax);
  }
  if (params.stationMinutes !== undefined) {
    whereClauses.push('(m.station_minutes IS NULL OR m.station_minutes <= ?)');
    bindings.push(params.stationMinutes);
  }
  if (params.managementFeeMax !== undefined) {
    whereClauses.push('(m.management_fee IS NULL OR m.management_fee <= ?)');
    bindings.push(params.managementFeeMax);
  }
  if (params.yieldMin !== undefined) {
    whereClauses.push('m.yield_rate >= ?');
    bindings.push(params.yieldMin);
  }
  if (params.query) {
    // FTS5全文検索 (properties_fts から master_id 経由でフィルタ)
    const ftsTokens = params.query.trim()
      .replace(/["\(\)\[\]{}^*?]/g, ' ')
      .split(/[\s　]+/).filter(Boolean);
    if (ftsTokens.length > 0) {
      const ftsQuery = ftsTokens.map(t => `"${t}"`).join(' ');
      // master_properties には直接FTS5がないため、properties経由でrowid取得
      whereClauses.push(
        `m.id IN (
          SELECT DISTINCT p.master_id FROM properties p
          WHERE p.master_id IS NOT NULL
            AND p.rowid IN (SELECT rowid FROM properties_fts WHERE properties_fts MATCH ? LIMIT 50000)
        )`
      );
      bindings.push(ftsQuery);
    }
  }

  const whereSQL = `WHERE ${whereClauses.join(' AND ')}`;

  const sortMap: Record<string, string> = {
    price_asc:   'm.price ASC NULLS LAST',
    price_desc:  'm.price DESC NULLS LAST',
    area_asc:    'm.area ASC NULLS LAST',
    area_desc:   'm.area DESC NULLS LAST',
    yield_desc:  'm.yield_rate DESC NULLS LAST',
    newest:      'm.last_seen_at DESC',
    relevance:   'm.last_seen_at DESC',
  };
  const orderSQL = sortMap[params.sortBy ?? 'newest'] ?? 'm.last_seen_at DESC';

  // Run COUNT and data query in parallel (same optimisation as searchProperties)
  const [countResult, masterRows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) as total FROM master_properties m ${whereSQL}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    db
      .prepare(`
        SELECT m.*
        FROM master_properties m
        ${whereSQL}
        ORDER BY ${orderSQL}
        LIMIT ? OFFSET ?
      `)
      .bind(...bindings, limit, offset)
      .all<Record<string, unknown>>(),
  ]);

  const total = countResult?.total ?? 0;

  const masterList = masterRows.results ?? [];
  const masterIds = masterList.map(r => r.id as string);

  // Fetch sources for all masters in one query
  let sourcesMap = new Map<string, SourceListing[]>();
  if (masterIds.length > 0) {
    const placeholders = masterIds.map(() => '?').join(', ');
    const sourceRows = await db
      .prepare(`
        SELECT p.master_id, p.site_id, p.site_property_id, p.detail_url,
               p.thumbnail_url, p.price, p.scraped_at
        FROM properties p
        WHERE p.master_id IN (${placeholders})
        ORDER BY p.scraped_at DESC
      `)
      .bind(...masterIds)
      .all<{
        master_id: string;
        site_id: string;
        site_property_id: string;
        detail_url: string | null;
        thumbnail_url: string | null;
        price: number | null;
        scraped_at: string;
      }>();

    for (const sr of (sourceRows.results ?? [])) {
      const list = sourcesMap.get(sr.master_id) ?? [];
      list.push({
        siteId: sr.site_id as SiteId,
        sitePropertyId: sr.site_property_id,
        detailUrl: sr.detail_url || null,
        thumbnailUrl: sr.thumbnail_url || null,
        price: sr.price ?? null,
        scrapedAt: sr.scraped_at,
      });
      sourcesMap.set(sr.master_id, list);
    }
  }

  const masters: MasterProperty[] = masterList.map(row => rowToMaster(row, sourcesMap));

  return {
    masters,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    executionTimeMs: Date.now() - startTime,
    cacheHit: false,
  };
}

function rowToMaster(row: Record<string, unknown>, sourcesMap: Map<string, SourceListing[]>): MasterProperty {
  const id = row.id as string;
  let sourceSites: SiteId[] = [];
  try {
    const parsed = JSON.parse((row.source_sites as string) ?? '[]');
    if (Array.isArray(parsed)) sourceSites = parsed as SiteId[];
  } catch { /* ignore */ }

  return {
    id,
    fingerprint: row.fingerprint as string,
    title: row.title as string,
    propertyType: row.property_type as MasterProperty['propertyType'],
    prefecture: row.prefecture as MasterProperty['prefecture'],
    city: row.city as string,
    address: (row.address as string) ?? null,
    price: (row.price as number) ?? null,
    area: (row.area as number) ?? null,
    buildingArea: (row.building_area as number) ?? null,
    landArea: (row.land_area as number) ?? null,
    rooms: (row.rooms as string) ?? null,
    age: (row.age as number) ?? null,
    floor: (row.floor as number) ?? null,
    totalFloors: (row.total_floors as number) ?? null,
    station: (row.station as string) ?? null,
    stationMinutes: (row.station_minutes as number) ?? null,
    managementFee: (row.management_fee as number) ?? null,
    repairFund: (row.repair_fund as number) ?? null,
    direction: (row.direction as string) ?? null,
    structure: (row.structure as string) ?? null,
    yieldRate: (row.yield_rate as number) ?? null,
    latitude: (row.latitude as number) ?? null,
    longitude: (row.longitude as number) ?? null,
    description: (row.description as string) ?? null,
    sourceCount: (row.source_count as number) ?? 1,
    sourceSites,
    primarySourceId: (row.primary_source_id as string) ?? null,
    primaryThumbnailUrl: (row.primary_thumbnail_url as string) ?? null,
    primaryR2Key: (row.primary_r2_key as string) ?? null,
    internalStatus: (row.internal_status as MasterProperty['internalStatus']) ?? 'available',
    agentId: (row.agent_id as string) ?? null,
    internalNotes: (row.internal_notes as string) ?? null,
    favorite: (row.favorite as number) === 1,
    viewCount: (row.view_count as number) ?? 0,
    firstListedAt: (row.first_listed_at as string) ?? null,
    lastSeenAt: (row.last_seen_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    sources: sourcesMap.get(id) ?? [],
  };
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
    images: row.images_concat ? (row.images_concat as string).split(',').filter(Boolean) : [],
    imageKeys: row.image_keys_concat ? (row.image_keys_concat as string).split(',').filter(Boolean) : [],
    thumbnailUrl: (row.thumbnail_url as string) ?? null,
    detailUrl: (row.detail_url as string) || null,
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
