import type { SiteId, Property, PrefectureCode } from '../types';
import { SITES } from '../types';
import {
  parseDocument as _parseDocument,
  extractJsonLd,
  findJsonLdByType,
  type ParsedDocument,
} from '../parsers/html-parser';

export interface ScraperOptions {
  maxRetries?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ScrapeContext {
  prefecture: PrefectureCode;
  page?: number;
  maxResults?: number;
}

export abstract class BaseScraper {
  protected siteId: SiteId;
  protected options: Required<ScraperOptions>;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(siteId: SiteId, options: ScraperOptions = {}) {
    this.siteId = siteId;
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 15000,
      userAgent: options.userAgent ?? 'Mozilla/5.0 (compatible; MAL-Bot/6.0; +https://mal-system.pages.dev)',
    };
  }

  abstract scrapeListings(ctx: ScrapeContext): Promise<Property[]>;

  // Default no-op — subclasses override when they support detail scraping
  async scrapeDetail(_url: string): Promise<Partial<Property>> {
    return {};
  }

  /**
   * Fetch URL and return HTML string. Returns null on any error (never throws).
   */
  protected async fetchHtml(url: string): Promise<string | null> {
    try {
      const resp = await this.fetchWithRetry(url);
      return await resp.text();
    } catch {
      return null;
    }
  }

  protected async fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
    await this.checkRateLimit();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.options.timeoutMs);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': this.options.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
            'Accept-Encoding': 'gzip, deflate, br',
            ...options?.headers,
          },
        });
        clearTimeout(timeoutId);

        if (!response.ok && response.status !== 429) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        if (response.status === 429) {
          await this.sleep(5000 * (attempt + 1));
          continue;
        }

        return response;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < this.options.maxRetries - 1) {
          await this.sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    throw lastError ?? new Error('Max retries exceeded');
  }

  protected async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 60000;
    const site = SITES[this.siteId];

    if (now - this.windowStart > windowMs) {
      this.requestCount = 0;
      this.windowStart = now;
    }

    if (this.requestCount >= site.rateLimit) {
      const waitMs = windowMs - (now - this.windowStart) + 100;
      await this.sleep(waitMs);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }

    this.requestCount++;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected extractPrice(text: string): { price: number | null; priceText: string } {
    const cleaned = text.replace(/[,\s]/g, '');
    // 億円
    const okuMatch = cleaned.match(/(\d+(?:\.\d+)?)億(?:(\d+)万)?円/);
    if (okuMatch) {
      const oku = parseFloat(okuMatch[1]) * 10000;
      const man = okuMatch[2] ? parseInt(okuMatch[2]) : 0;
      return { price: oku + man, priceText: text.trim() };
    }
    // 万円
    const manMatch = cleaned.match(/(\d+(?:\.\d+)?)万円/);
    if (manMatch) {
      return { price: Math.round(parseFloat(manMatch[1])), priceText: text.trim() };
    }
    return { price: null, priceText: text.trim() };
  }

  protected extractArea(text: string): number | null {
    const match = text.replace(/[,\s]/g, '').match(/(\d+(?:\.\d+)?)(?:m²|㎡|平方メートル)/);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract og:image or first meaningful <img> src as thumbnail.
   */
  protected extractThumbnail(html: string): string | null {
    // og:image (most reliable)
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
      ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (ogMatch?.[1]) return ogMatch[1];

    // First <img> with a plausible property photo src
    const imgMatch = html.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (imgMatch?.[1]) return imgMatch[1];

    return null;
  }

  /**
   * Extract up to 10 unique image URLs from HTML.
   */
  protected extractImages(html: string, baseUrl?: string): string[] {
    const images: string[] = [];
    const seen = new Set<string>();
    const imgRegex = /<img[^>]+src="([^"]+)"/gi;
    let m;
    while ((m = imgRegex.exec(html)) !== null && images.length < 10) {
      let src = m[1];
      if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/') && baseUrl) src = baseUrl + src;
      if (!src.startsWith('http')) continue;
      if (seen.has(src)) continue;
      // Skip tracking pixels, icons, logos
      if (src.match(/(?:pixel|beacon|logo|icon|sprite|blank|spacer)/i)) continue;
      seen.add(src);
      images.push(src);
    }
    return images;
  }

  /**
   * Parse "最寄り駅 徒歩X分" style text.
   */
  protected extractStation(text: string): { station: string | null; stationMinutes: number | null } {
    const m = text.match(/([^\s　]+駅?)\s*(?:徒歩|歩いて)?(\d+)分/);
    if (m) return { station: m[1].replace(/駅$/, ''), stationMinutes: parseInt(m[2]) };
    return { station: null, stationMinutes: null };
  }

  /**
   * Parse "築X年" → X, "新築" → 0, else null.
   */
  protected extractAge(text: string): number | null {
    if (/新築/.test(text)) return 0;
    const m = text.match(/築(\d+)年/);
    return m ? parseInt(m[1]) : null;
  }

  /**
   * Parse raw HTML into a linkedom Document.
   * Returns null on failure — never throws.
   */
  protected parseDocument(html: string): ParsedDocument | null {
    return _parseDocument(html);
  }

  /**
   * Extract Schema.org RealEstateListing / Product entries from JSON-LD blocks.
   * Returns partial Property objects derived from structured data.
   * Falls back to empty array when no JSON-LD is present.
   */
  protected extractFromJsonLd(html: string): Partial<Property>[] {
    const doc = _parseDocument(html);
    if (!doc) return [];
    const items = extractJsonLd(doc);
    const nodes = findJsonLdByType(
      items,
      'RealEstateListing',
      'Product',
      'Place',
      'Apartment',
      'House',
      'SingleFamilyResidence',
    );
    return nodes.map(node => this.jsonLdNodeToProperty(node));
  }

  private jsonLdNodeToProperty(node: Record<string, unknown>): Partial<Property> {
    const partial: Partial<Property> = {};

    // Name / title
    if (typeof node['name'] === 'string') partial.title = node['name'];

    // Description
    if (typeof node['description'] === 'string') partial.description = node['description'];

    // Price
    const offer = node['offers'];
    if (offer && typeof offer === 'object' && !Array.isArray(offer)) {
      const o = offer as Record<string, unknown>;
      const rawPrice = o['price'];
      if (rawPrice !== undefined) {
        const p = parseFloat(String(rawPrice));
        if (!isNaN(p)) {
          // JSON-LD prices are typically in JPY units; convert to 万円
          partial.price = p >= 100000 ? Math.round(p / 10000) : p;
          partial.priceText = `${partial.price.toLocaleString()}万円`;
        }
      }
    }

    // URL
    if (typeof node['url'] === 'string') partial.detailUrl = node['url'];

    // Geo
    const geo = node['geo'];
    if (geo && typeof geo === 'object' && !Array.isArray(geo)) {
      const g = geo as Record<string, unknown>;
      if (typeof g['latitude'] === 'number') partial.latitude = g['latitude'];
      if (typeof g['longitude'] === 'number') partial.longitude = g['longitude'];
    }

    // Floor size / area
    const floorSize = node['floorSize'];
    if (floorSize && typeof floorSize === 'object' && !Array.isArray(floorSize)) {
      const fs = floorSize as Record<string, unknown>;
      const val = parseFloat(String(fs['value']));
      if (!isNaN(val)) partial.area = val;
    }

    // Image
    const img = node['image'];
    if (typeof img === 'string') {
      partial.thumbnailUrl = img;
      partial.images = [img];
    } else if (Array.isArray(img) && img.length > 0) {
      partial.thumbnailUrl = String(img[0]);
      partial.images = img.slice(0, 10).map(String);
    }

    return partial;
  }

  protected generateId(sitePropertyId: string): string {
    return `${this.siteId}_${sitePropertyId}`;
  }

  /** クロスサイト重複検知フィンガープリント計算 */
  protected computeFingerprint(fields: {
    prefecture: string;
    city: string;
    price: number | null;
    area: number | null;
    rooms: string | null;
  }): string {
    // 正規化してハッシュ
    const norm = [
      fields.prefecture,
      fields.city.replace(/[市区町村]/g, '').slice(0, 4),  // 市区 → 4文字
      String(Math.round((fields.price ?? 0) / 100) * 100),   // 100万単位丸め
      String(Math.round((fields.area ?? 0) * 10) / 10),      // 小数1桁
      (fields.rooms ?? '').replace(/[・\s]/g, '').toUpperCase(),
    ].join('|');
    // 簡易ハッシュ (Workers環境でcryptoなしでも動く)
    let h = 0x811c9dc5;
    for (let i = 0; i < norm.length; i++) {
      h ^= norm.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** 管理費・修繕積立金パース: "管理費12,000円" → 12000 */
  protected extractMonthlyFee(text: string, keyword: string): number | null {
    const m = text.match(new RegExp(keyword + '[^0-9]*([0-9,]+)'));
    return m ? parseInt(m[1].replace(/,/g, '')) : null;
  }

  /** 向き抽出: "南向き" "南西" など */
  protected extractDirection(text: string): string | null {
    const m = text.match(/[南北東西][南北東西]?向き?/);
    return m ? m[0] : null;
  }

  /** 構造抽出: "RC造" "木造" "SRC造" "鉄骨造" など */
  protected extractStructure(text: string): string | null {
    const m = text.match(/(?:RC|SRC|鉄筋コンクリート|鉄骨鉄筋|鉄骨|木造|軽量鉄骨|ブロック)造?/);
    return m ? m[0] : null;
  }

  /** 間取り図URL抽出 */
  protected extractFloorPlanUrl(html: string): string | null {
    const m = html.match(/<img[^>]+src="([^"]*madori[^"]*\.(?:jpg|png)[^"]*)"/i);
    return m ? m[1] : null;
  }

  /** 外観URL抽出 */
  protected extractExteriorUrl(html: string): string | null {
    const m = html.match(/<img[^>]+(?:alt|src)="[^"]*(?:外観|external|building)[^"]*"[^>]*src="([^"]+)"|<img[^>]+src="([^"]*(?:外観|external|building)[^"]*)"/i);
    return m ? (m[1] ?? m[2]) : null;
  }

  protected buildBaseProperty(overrides: Partial<Property> & {
    sitePropertyId: string;
    title: string;
    propertyType: Property['propertyType'];
    prefecture: PrefectureCode;
    city: string;
    detailUrl: string | null;
  }): Property {
    return {
      id: this.generateId(overrides.sitePropertyId),
      siteId: this.siteId,
      status: 'active',
      address: null,
      price: null,
      priceText: '',
      area: null,
      buildingArea: null,
      landArea: null,
      rooms: null,
      age: null,
      floor: null,
      totalFloors: null,
      station: null,
      stationMinutes: null,
      fingerprint: null,
      managementFee: null,
      repairFund: null,
      direction: null,
      structure: null,
      images: [],
      imageKeys: [],
      thumbnailUrl: null,
      floorPlanUrl: null,
      exteriorUrl: null,
      description: null,
      features: [],
      latitude: null,
      longitude: null,
      priceHistory: [],
      yieldRate: null,
      listedAt: null,
      soldAt: null,
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scrapedAt: new Date().toISOString(),
      ...overrides,
    };
  }
}
