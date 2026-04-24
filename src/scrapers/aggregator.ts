import type { Property, SearchParams, SiteId, SiteSearchResult, PrefectureCode } from '../types';
import type { Bindings } from '../types';
import { enqueueAll } from '../services/image-pipeline';
import type { BaseScraper } from './base';
import { HomesScraper } from './homes';
import { FudosanScraper } from './fudosan';
import { ChintaiScraper } from './chintai';
import { SmaityScraper } from './smaity';
import { KenbiyaScraper } from './kenbiya';
import { RakumachiScraper } from './rakumachi';

const SCRAPER_TIMEOUT_MS = 20000;

// suumo / athome / reins は TERASS PICKS CSV 経由でインポート済み (site_id='terass_suumo' 等)。
// 直接スクレイパーは重複となるため削除。terass_* はライブスクレイパー不要。
const ALL_SITE_IDS: SiteId[] = [
  'homes', 'fudosan', 'chintai',
  'smaity', 'kenbiya', 'rakumachi',
];

/**
 * Rotate prefectures by day-of-week to stay within Cloudflare CPU limits.
 * 2–3 prefectures × 9 sites per cron invocation.
 */
const PREFECTURE_ROTATION: PrefectureCode[][] = [
  ['13', '14', '11', '12', '08', '09', '10'], // Mon  関東7県 (東京・神奈川・埼玉・千葉・茨城・栃木・群馬)
  ['27', '28', '26', '25', '29', '30', '24'], // Tue  近畿7県 (大阪・兵庫・京都・滋賀・奈良・和歌山・三重)
  ['23', '22', '21', '20', '19', '18', '17'], // Wed  東海・信越・北陸 (愛知・静岡・岐阜・長野・山梨・福井・石川)
  ['40', '43', '42', '44', '45', '46', '47'], // Thu  九州7県 (福岡・熊本・長崎・大分・宮崎・鹿児島・沖縄)
  ['34', '33', '32', '31', '38', '37', '36'], // Fri  中国・四国 (広島・岡山・島根・鳥取・愛媛・香川・徳島)
  ['01', '02', '03', '04', '05', '06', '07'], // Sat  北海道・東北 (北海道・青森・岩手・宮城・秋田・山形・福島)
  ['16', '15', '41', '35', '39'],             // Sun  残り5県 (富山・新潟・佐賀・山口・高知)
];

function createScrapers(): Partial<Record<SiteId, BaseScraper>> {
  return {
    homes:     new HomesScraper(),
    fudosan:   new FudosanScraper(),
    chintai:   new ChintaiScraper(),
    smaity:    new SmaityScraper(),
    kenbiya:   new KenbiyaScraper(),
    rakumachi: new RakumachiScraper(),
    // terass_* are DB-only (imported via CSV); no live scraper
    // suumo / athome / reins removed: covered by terass_suumo / terass_athome / terass_reins
  };
}

// isAllMockData は @deprecated だったため削除 (P2 #7 dead code 排除)。
// 用途は isMockData() (per-site 判定) に置き換え済み。

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

  // P2 #8: results と siteIds は同順なので index でペアリング。
  // 旧: rejected 時に siteIds[siteResults.length] を使うと、それまでに push 済みの
  // results 数とずれて誤った siteId が記録された (例: 0番目失敗→1番目成功→2番目失敗時に siteIds[1] を引く)。
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allProperties.push(...result.value.properties);
      siteResults.push(result.value.result);
    } else {
      siteResults.push({
        siteId: siteIds[i] ?? ('homes' as SiteId),
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
  const maxResults = parseInt(env.MAX_RESULTS_PER_SITE ?? '50');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let total = 0, newCount = 0, updatedCount = 0, soldCount = 0;
  const errors: string[] = [];

  for (const prefecture of targetPrefectures) {
    if (!prefecture) continue; // Sun rotation の空文字スキップ
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

        // ── Upsert scraped properties (P2 #11: バッチ化で N+1 解消) ──────────
        // 旧: 1 物件あたり 2 ラウンドトリップ × 最大 15 物件 × 9 サイト × 47 都道府県 = 12,690 順次クエリ
        // 新: 50 件ずつまとめて env.MAL_DB.batch() に投入 → ラウンドトリップ ~1/50
        const upsertSql = `
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
        `;
        const priceHistorySql = `INSERT OR IGNORE INTO price_history (property_id, price, recorded_at) VALUES (?, ?, ?)`;
        const stmts: D1PreparedStatement[] = [];
        for (const prop of properties) {
          const id = `${prop.siteId}_${prop.sitePropertyId}`;
          const isNew = !existingSet.has(prop.sitePropertyId);
          if (isNew) jobNew++; else jobUpdated++;

          stmts.push(env.MAL_DB.prepare(upsertSql).bind(
            id, prop.siteId, prop.sitePropertyId, prop.title, prop.propertyType,
            prop.prefecture, prop.city ?? '', prop.address ?? null,
            prop.price ?? null, prop.priceText ?? '', prop.area ?? null,
            prop.buildingArea ?? null, prop.landArea ?? null,
            prop.rooms ?? null, prop.age ?? null, prop.floor ?? null, prop.totalFloors ?? null,
            prop.station ?? null, prop.stationMinutes ?? null,
            prop.thumbnailUrl ?? null, prop.detailUrl, prop.description ?? null,
            prop.yieldRate ?? null, prop.latitude ?? null, prop.longitude ?? null,
            prop.fingerprint ?? null
          ));
          if (prop.price !== null) {
            stmts.push(env.MAL_DB.prepare(priceHistorySql).bind(id, prop.price, today));
          }
        }
        // 50 文ずつチャンク実行 (D1 batch のオーバーヘッドを抑えつつ単発失敗の影響を局所化)
        for (let i = 0; i < stmts.length; i += 50) {
          await env.MAL_DB.batch(stmts.slice(i, i + 50));
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

  // Enqueue pending images after scrape completes
  await enqueueAll(env).catch(() => { /* non-fatal */ });

  return { total, newCount, updatedCount, soldCount, errors };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterProperties(props: Property[], params: SearchParams): Property[] {
  return props.filter(p => {
    // P2 #12: 数値範囲フィルタ指定時は null を「不明=フィルタ対象外として除外」する仕様に統一。
    // 旧: `p.price !== null && p.price < min` は null だと条件 false→通過していたため、
    // 価格未取得の物件が「100万〜500万」の絞り込みでも結果に混入していた。
    if (params.priceMin !== undefined && (p.price === null || p.price < params.priceMin)) return false;
    if (params.priceMax !== undefined && (p.price === null || p.price > params.priceMax)) return false;
    if (params.areaMin  !== undefined && (p.area  === null || p.area  < params.areaMin))  return false;
    if (params.areaMax  !== undefined && (p.area  === null || p.area  > params.areaMax))  return false;
    if (params.rooms        && p.rooms        !== params.rooms)        return false;
    if (params.ageMax  !== undefined && (p.age   === null || p.age    > params.ageMax))   return false;
    if (params.stationMinutes !== undefined && (p.stationMinutes === null || p.stationMinutes > params.stationMinutes)) return false;
    if (params.yieldMin !== undefined && (p.yieldRate === null || p.yieldRate < params.yieldMin)) return false;
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
