// MAL System - Type Definitions v6.2

export type PrefectureCode =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10'
  | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '19' | '20'
  | '21' | '22' | '23' | '24' | '25' | '26' | '27' | '28' | '29' | '30'
  | '31' | '32' | '33' | '34' | '35' | '36' | '37' | '38' | '39' | '40'
  | '41' | '42' | '43' | '44' | '45' | '46' | '47';

export const PREFECTURES: Record<PrefectureCode, string> = {
  '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県',
  '06': '山形県', '07': '福島県', '08': '茨城県', '09': '栃木県', '10': '群馬県',
  '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県', '15': '新潟県',
  '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県',
  '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県',
  '26': '京都府', '27': '大阪府', '28': '兵庫県', '29': '奈良県', '30': '和歌山県',
  '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県',
  '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県',
  '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県', '45': '宮崎県',
  '46': '鹿児島県', '47': '沖縄県',
};

export type SiteId = 'suumo' | 'homes' | 'athome' | 'fudosan' | 'chintai' | 'smaity' | 'reins' | 'kenbiya' | 'rakumachi'
  | 'terass_reins' | 'terass_suumo' | 'terass_athome';

export interface SiteConfig {
  id: SiteId;
  name: string;
  url: string;
  logo: string;
  color: string;
  rateLimit: number;
}

export const SITES: Record<SiteId, SiteConfig> = {
  suumo:        { id: 'suumo',        name: 'SUUMO',         url: 'https://suumo.jp',                      logo: '🏠', color: '#00A960', rateLimit: 10 },
  homes:        { id: 'homes',        name: "HOME'S",        url: 'https://www.homes.co.jp',               logo: '🏡', color: '#FF6B35', rateLimit: 10 },
  athome:       { id: 'athome',       name: 'AtHome',        url: 'https://www.athome.co.jp',              logo: '🏘', color: '#0066CC', rateLimit: 10 },
  fudosan:      { id: 'fudosan',      name: '不動産Japan',    url: 'https://fudosan.jp',                    logo: '🏗', color: '#E74C3C', rateLimit: 8  },
  chintai:      { id: 'chintai',      name: 'CHINTAI',       url: 'https://chintai.net',                   logo: '🏢', color: '#9B59B6', rateLimit: 8  },
  smaity:       { id: 'smaity',       name: 'Smaity',        url: 'https://smaity.com',                    logo: '🏬', color: '#F39C12', rateLimit: 6  },
  reins:        { id: 'reins',        name: 'REINS',         url: 'https://www.reins.or.jp',               logo: '📋', color: '#2ECC71', rateLimit: 5  },
  kenbiya:      { id: 'kenbiya',      name: '健美家',         url: 'https://www.kenbiya.com',               logo: '💰', color: '#DC2626', rateLimit: 8  },
  rakumachi:    { id: 'rakumachi',    name: '楽待',           url: 'https://www.rakumachi.jp',              logo: '📈', color: '#7C3AED', rateLimit: 8  },
  terass_reins: { id: 'terass_reins', name: 'TERASS-REINS',  url: 'https://picks.terass-agents.com',       logo: '📋', color: '#10B981', rateLimit: 0  },
  terass_suumo: { id: 'terass_suumo', name: 'TERASS-SUUMO',  url: 'https://picks.terass-agents.com',       logo: '🏠', color: '#059669', rateLimit: 0  },
  terass_athome:{ id: 'terass_athome',name: 'TERASS-AtHome', url: 'https://picks.terass-agents.com',       logo: '🏘', color: '#0891B2', rateLimit: 0  },
};

export type PropertyType =
  | 'mansion'
  | 'kodate'
  | 'tochi'
  | 'chintai_mansion'
  | 'chintai_ikkodate'
  | 'jimusho'
  | 'investment'
  | 'other';

export type PropertyStatus = 'active' | 'sold' | 'delisted';

export interface Property {
  id: string;
  siteId: SiteId;
  sitePropertyId: string;
  fingerprint: string | null;       // クロスサイト重複検知ハッシュ
  title: string;
  propertyType: PropertyType;
  status: PropertyStatus;
  prefecture: PrefectureCode;
  city: string;
  address: string | null;
  price: number | null;
  priceText: string;
  area: number | null;
  buildingArea: number | null;
  landArea: number | null;
  rooms: string | null;
  age: number | null;
  floor: number | null;
  totalFloors: number | null;
  station: string | null;
  stationMinutes: number | null;
  managementFee: number | null;     // 管理費 (円/月)
  repairFund: number | null;        // 修繕積立金 (円/月)
  direction: string | null;         // 向き (南向き等)
  structure: string | null;         // 構造 (RC造等)
  images: string[];
  imageKeys: string[];              // R2 keys for /api/images/* delivery
  thumbnailUrl: string | null;
  floorPlanUrl: string | null;      // 間取り図URL
  exteriorUrl: string | null;       // 外観画像URL
  detailUrl: string | null;         // null when empty (e.g. TERASS data)
  description: string | null;
  features: string[];
  yieldRate: number | null;         // 表面利回り % (投資物件)
  latitude: number | null;
  longitude: number | null;
  priceHistory: PriceHistoryEntry[];
  listedAt: string | null;          // 掲載開始日
  soldAt: string | null;            // 売却日
  lastSeenAt: string | null;        // 最後にスクレイプ確認された日時
  createdAt: string;
  updatedAt: string;
  scrapedAt: string;
}

export interface PriceHistoryEntry {
  date: string;
  price: number;
}

export interface SearchParams {
  query?: string;
  prefecture?: PrefectureCode;
  city?: string;
  propertyType?: PropertyType;
  status?: PropertyStatus | 'all';
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
  rooms?: string;
  ageMax?: number;
  stationMinutes?: number;
  yieldMin?: number;                // 利回り下限
  managementFeeMax?: number;        // 管理費上限
  sites?: SiteId[];
  hideDuplicates?: boolean;         // クロスサイト重複を非表示
  sortBy?: 'price_asc' | 'price_desc' | 'area_asc' | 'area_desc' | 'newest' | 'relevance' | 'yield_desc';
  page?: number;
  limit?: number;
}

export interface SearchResult {
  properties: Property[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  sites: SiteSearchResult[];
  executionTimeMs: number;
  cacheHit: boolean;
}

export interface SiteSearchResult {
  siteId: SiteId;
  count: number;
  status: 'success' | 'error' | 'timeout' | 'cached';
  errorMessage?: string;
  executionTimeMs: number;
}

export interface ScrapeJob {
  id: string;
  siteId: SiteId;
  prefecture: PrefectureCode;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped_mock';
  propertiesFound: number;
  propertiesNew: number;
  propertiesUpdated: number;
  propertiesSold: number;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface DownloadQueueItem {
  id: string;
  assetType: 'image' | 'mysoku';
  propertyId: string;
  sourceUrl: string;
  r2Key: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'skipped';
  retryCount: number;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface CsvImport {
  id: string;
  filename: string;
  source: 'manual' | 'scheduled';
  totalRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  errorRows: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorLog: string | null;
  importedAt: string;
  completedAt: string | null;
}

export interface AdminStats {
  totalProperties: number;
  activeProperties: number;
  soldProperties: number;
  delistedProperties: number;
  duplicateGroups: number;
  totalImages: number;
  downloadedImages: number;
  pendingDownloads: number;
  totalMysoku: number;
  totalTransactions: number;
  r2StorageEstimatedMb: number;
  dbSizeEstimatedMb: number;
  siteBreakdown: { siteId: SiteId; count: number; sold: number }[];
  prefectureBreakdown: { prefecture: PrefectureCode; count: number }[];
  lastScrapeAt: string | null;
  lastCsvImportAt: string | null;
}

export interface Bindings {
  MAL_DB: D1Database;
  MAL_CACHE: KVNamespace;
  MAL_STORAGE: R2Bucket;
  ENVIRONMENT: string;
  APP_VERSION: string;
  MAX_RESULTS_PER_SITE: string;
  CACHE_TTL_SECONDS: string;
  RATE_LIMIT_PER_MINUTE: string;
  /** Comma-separated prefecture codes to override PREFECTURE_ROTATION. Optional. */
  SCRAPE_PREFECTURES?: string;
  /** Worker self-call URL for scheduled image download queue. Optional. */
  WORKER_URL?: string;
  /** Admin API bearer token. Optional. */
  ADMIN_SECRET?: string;
}

export interface AppVariables {
  userId?: string;
  requestId: string;
}
