// master-builder.ts — TERASS PICKS 流マスター物件ビルドサービス
// fingerprint 単位で properties を集計し master_properties に UPSERT する
// CPU 30秒制限を超えないよう 1 呼び出し最大 batchSize fingerprint に制限

import type { Bindings } from '../types';

export interface BuildMastersResult {
  created: number;
  updated: number;
  linked: number;
}

interface FingerprintGroup {
  fingerprint: string;
  ids: string;           // comma-separated property ids
  sites: string;         // comma-separated site_ids
  titles: string;        // comma-separated titles
  prices: string;        // comma-separated prices (may have nulls as empty)
  thumbnails: string;    // comma-separated thumbnail_urls
  descriptions: string;  // comma-separated descriptions
  property_type: string;
  prefecture: string;
  city: string;
  address: string | null;
  area: number | null;
  building_area: number | null;
  land_area: number | null;
  rooms: string | null;
  age: number | null;
  floor: number | null;
  total_floors: number | null;
  station: string | null;
  station_minutes: number | null;
  management_fee: number | null;
  repair_fund: number | null;
  direction: string | null;
  structure: string | null;
  yield_rate: number | null;
  latitude: number | null;
  longitude: number | null;
  first_listed_at: string | null;
  last_seen_at: string | null;
  cnt: number;
}

/** fingerprint から master_properties.id を生成 */
function makeMasterId(fingerprint: string): string {
  return 'mp_' + fingerprint.slice(0, 16);
}

/** カンマ区切り文字列から最長の非空文字列を選ぶ */
function longestOf(csv: string | null | undefined): string | null {
  if (!csv) return null;
  const parts = csv.split(',').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (b.length > a.length ? b : a), '');
}

/** カンマ区切り価格文字列から最初の非null正整数を選ぶ */
function firstPrice(csv: string | null | undefined): number | null {
  if (!csv) return null;
  for (const p of csv.split(',')) {
    const n = parseInt(p.trim(), 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

/** 未リンク fingerprint を batchSize 件ずつ処理
 *  NOTE: 各バッチは fingerprint の DISTINCT リストを取得してから
 *  プロパティを集計する 2-step アプローチにより D1 タイムアウトを回避
 */
export async function buildMasters(
  env: Bindings,
  batchSize = 2000,
): Promise<BuildMastersResult> {
  const db = env.MAL_DB;
  let created = 0;
  let updated = 0;
  let linked = 0;

  // Step 1: 未リンク fingerprint を batchSize 件取得 (軽いクエリ)
  const fpRows = await db.prepare(`
    SELECT DISTINCT fingerprint
    FROM properties
    WHERE fingerprint IS NOT NULL
      AND (master_id IS NULL OR master_id = '')
    LIMIT ?
  `).bind(batchSize).all<{ fingerprint: string }>();

  const fingerprints = (fpRows.results ?? []).map(r => r.fingerprint);
  if (fingerprints.length === 0) return { created: 0, updated: 0, linked: 0 };

  // Step 2: 取得した fingerprint 群を IN で集計 (スコープが限定されるので高速)
  const placeholders = fingerprints.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT
      p.fingerprint,
      GROUP_CONCAT(p.id) as ids,
      GROUP_CONCAT(p.site_id) as sites,
      GROUP_CONCAT(COALESCE(p.title,'')) as titles,
      GROUP_CONCAT(COALESCE(CAST(p.price AS TEXT),'')) as prices,
      GROUP_CONCAT(COALESCE(p.thumbnail_url,'')) as thumbnails,
      GROUP_CONCAT(COALESCE(p.description,'')) as descriptions,
      MAX(p.property_type) as property_type,
      MAX(p.prefecture) as prefecture,
      MAX(p.city) as city,
      MAX(p.address) as address,
      MAX(p.area) as area,
      MAX(p.building_area) as building_area,
      MAX(p.land_area) as land_area,
      MAX(p.rooms) as rooms,
      MAX(p.age) as age,
      MAX(p.floor) as floor,
      MAX(p.total_floors) as total_floors,
      MAX(p.station) as station,
      MAX(p.station_minutes) as station_minutes,
      MAX(p.management_fee) as management_fee,
      MAX(p.repair_fund) as repair_fund,
      MAX(p.direction) as direction,
      MAX(p.structure) as structure,
      MAX(p.yield_rate) as yield_rate,
      MAX(p.latitude) as latitude,
      MAX(p.longitude) as longitude,
      MIN(p.listed_at) as first_listed_at,
      MAX(p.last_seen_at) as last_seen_at,
      COUNT(*) as cnt
    FROM properties p
    WHERE p.fingerprint IN (${placeholders})
    GROUP BY p.fingerprint
  `).bind(...fingerprints).all<FingerprintGroup>();

  const groups = rows.results ?? [];
  if (groups.length === 0) return { created: 0, updated: 0, linked: 0 };

  for (const g of groups) {
    const masterId = makeMasterId(g.fingerprint);
    const idList = (g.ids ?? '').split(',').filter(Boolean);
    const siteList = (g.sites ?? '').split(',').filter(Boolean);
    const uniqueSites = [...new Set(siteList)];

    const title = longestOf(g.titles) ?? '';
    const price = firstPrice(g.prices);
    const thumbnail = longestOf(g.thumbnails);
    const description = longestOf(g.descriptions);
    const primarySourceId = idList[0] ?? null;
    const sourceSites = JSON.stringify(uniqueSites);

    // UPSERT master_properties
    const upsertResult = await db.prepare(`
      INSERT INTO master_properties (
        id, fingerprint,
        title, property_type, prefecture, city, address,
        price, area, building_area, land_area, rooms, age,
        floor, total_floors, station, station_minutes,
        management_fee, repair_fund, direction, structure,
        yield_rate, latitude, longitude, description,
        source_count, source_sites, primary_source_id,
        primary_thumbnail_url,
        first_listed_at, last_seen_at,
        created_at, updated_at
      ) VALUES (
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?,
        ?, ?,
        datetime('now'), datetime('now')
      )
      ON CONFLICT(fingerprint) DO UPDATE SET
        title               = CASE WHEN length(excluded.title) > length(master_properties.title) THEN excluded.title ELSE master_properties.title END,
        price               = COALESCE(excluded.price, master_properties.price),
        description         = CASE WHEN length(COALESCE(excluded.description,'')) > length(COALESCE(master_properties.description,'')) THEN excluded.description ELSE master_properties.description END,
        source_count        = excluded.source_count,
        source_sites        = excluded.source_sites,
        primary_source_id   = COALESCE(master_properties.primary_source_id, excluded.primary_source_id),
        primary_thumbnail_url = COALESCE(master_properties.primary_thumbnail_url, excluded.primary_thumbnail_url),
        last_seen_at        = excluded.last_seen_at,
        updated_at          = datetime('now')
    `).bind(
      masterId, g.fingerprint,
      title, g.property_type ?? 'other', g.prefecture ?? '13', g.city ?? '', g.address ?? null,
      price ?? null, g.area ?? null, g.building_area ?? null, g.land_area ?? null,
      g.rooms ?? null, g.age ?? null, g.floor ?? null, g.total_floors ?? null,
      g.station ?? null, g.station_minutes ?? null,
      g.management_fee ?? null, g.repair_fund ?? null,
      g.direction ?? null, g.structure ?? null,
      g.yield_rate ?? null, g.latitude ?? null, g.longitude ?? null,
      description ?? null,
      uniqueSites.length, sourceSites, primarySourceId,
      thumbnail ?? null,
      g.first_listed_at ?? null, g.last_seen_at ?? null,
    ).run();

    if ((upsertResult.meta?.changes as number | undefined) ?? 0 > 0) {
      created++;
    } else {
      updated++;
    }

    // Link all properties in this fingerprint group to the master
    if (idList.length > 0) {
      const idPlaceholders = idList.map(() => '?').join(', ');
      const linkResult = await db.prepare(
        `UPDATE properties SET master_id = ? WHERE id IN (${idPlaceholders})`
      ).bind(masterId, ...idList).run();
      linked += (linkResult.meta?.changes as number | undefined) ?? 0;
    }
  }

  return { created, updated, linked };
}

/** 全件処理: chunked で呼び出す (Worker CPU 制限対策として外側から複数回呼ぶ想定) */
export async function buildAllMasters(
  env: Bindings,
  maxChunks = 20,
  chunkSize = 2000,
): Promise<BuildMastersResult & { chunks: number }> {
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalLinked = 0;
  let chunks = 0;

  for (let i = 0; i < maxChunks; i++) {
    const result = await buildMasters(env, chunkSize);
    totalCreated += result.created;
    totalUpdated += result.updated;
    totalLinked += result.linked;
    chunks++;
    // Nothing processed → all done
    if (result.created + result.updated === 0) break;
  }

  return { created: totalCreated, updated: totalUpdated, linked: totalLinked, chunks };
}
