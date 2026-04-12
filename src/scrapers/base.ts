import type { SiteId, Property, PrefectureCode } from '../types';
import { SITES } from '../types';

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
      userAgent: options.userAgent ?? 'Mozilla/5.0 (compatible; MAL-Bot/5.0; +https://mal-system.pages.dev)',
    };
  }

  abstract scrapeListings(ctx: ScrapeContext): Promise<Property[]>;
  abstract scrapeDetail(url: string): Promise<Partial<Property>>;

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

  protected generateId(sitePropertyId: string): string {
    return `${this.siteId}_${sitePropertyId}`;
  }

  protected buildBaseProperty(overrides: Partial<Property> & {
    sitePropertyId: string;
    title: string;
    propertyType: Property['propertyType'];
    prefecture: PrefectureCode;
    city: string;
    detailUrl: string;
  }): Property {
    return {
      id: this.generateId(overrides.sitePropertyId),
      siteId: this.siteId,
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
      images: [],
      thumbnailUrl: null,
      description: null,
      features: [],
      latitude: null,
      longitude: null,
      priceHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scrapedAt: new Date().toISOString(),
      ...overrides,
    };
  }
}
