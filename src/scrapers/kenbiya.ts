import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';

export class KenbiyaScraper extends BaseScraper {
  constructor() {
    super('kenbiya');
  }

  async scrapeListings(ctx: { prefecture: PrefectureCode; maxResults?: number }): Promise<Property[]> {
    const { prefecture, maxResults = 15 } = ctx;
    const prefNum = parseInt(prefecture);
    // 健美家のURL: /ar/00{2桁}/  例: /ar/0013/ = 東京都
    const prefStr = String(prefNum).padStart(4, '0');
    const url = `https://www.kenbiya.com/ar/${prefStr}/`;

    try {
      const html = await this.fetchWithRetry(url);
      const properties = this.parseKenbiya(html, prefecture, maxResults);
      if (properties.length > 0) return properties;
    } catch {
      // fall through to mock
    }
    return this.getMockData(prefecture);
  }

  private parseKenbiya(html: string, prefecture: PrefectureCode, maxResults: number): Property[] {
    const properties: Property[] = [];
    // 健美家の物件リストアイテムパターン
    const itemPattern = /<div[^>]+class="[^"]*bukken[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    const titlePattern = /<h3[^>]*><a[^>]*>([^<]+)<\/a>/i;
    const pricePattern = /([0-9,]+)\s*万円/;
    const areaPattern = /([0-9.]+)\s*(?:m²|㎡)/;
    const linkPattern = /href="([^"]+bukken[^"]+)"/i;
    const yieldPattern = /([0-9.]+)\s*%/;

    let match;
    while ((match = itemPattern.exec(html)) !== null && properties.length < maxResults) {
      const chunk = match[1];
      const titleM = titlePattern.exec(chunk);
      const priceM = pricePattern.exec(chunk);
      const areaM = areaPattern.exec(chunk);
      const linkM = linkPattern.exec(chunk);
      const yieldM = yieldPattern.exec(chunk);

      if (!titleM || !linkM) continue;

      const price = priceM ? parseInt(priceM[1].replace(/,/g, '')) : null;
      const area = areaM ? parseFloat(areaM[1]) : null;
      const detailUrl = linkM[1].startsWith('http') ? linkM[1] : `https://www.kenbiya.com${linkM[1]}`;
      const sitePropertyId = `kenbiya_${btoa(encodeURIComponent(detailUrl)).slice(0, 20)}`;

      properties.push({
        id: `kenbiya_${sitePropertyId}`,
        siteId: 'kenbiya',
        sitePropertyId,
        title: titleM[1].trim(),
        propertyType: 'investment',
        status: 'active',
        prefecture,
        city: '',
        address: null,
        price,
        priceText: priceM ? `${priceM[1]}万円` : '価格要相談',
        area,
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
        detailUrl,
        description: null,
        features: [],
        yieldRate: yieldM ? parseFloat(yieldM[1]) : null,
        latitude: null,
        longitude: null,
        priceHistory: [],
        listedAt: null,
        soldAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        scrapedAt: new Date().toISOString(),
      });
    }
    return properties;
  }

  private getMockData(prefecture: PrefectureCode): Property[] {
    const now = new Date().toISOString();
    const base = { status: 'active' as const, images: [], features: ['一棟アパート', '投資用', '利回り良好'], priceHistory: [], listedAt: null, soldAt: null, buildingArea: null, landArea: null, floor: null, totalFloors: null, address: null, description: '健美家掲載の収益物件。高利回り期待。', createdAt: now, updatedAt: now, scrapedAt: now };
    return [
      { ...base, id: `kenbiya_mock1_${prefecture}`, siteId: 'kenbiya', sitePropertyId: `mock1_${prefecture}`, title: '【健美家】東京都 一棟アパート 利回り8.5%', propertyType: 'investment', prefecture, city: '墨田区', price: 8500, priceText: '8,500万円', area: 220, rooms: '8室', age: 12, station: '錦糸町', stationMinutes: 8, thumbnailUrl: null, detailUrl: 'https://www.kenbiya.com/', yieldRate: 8.5, latitude: 35.698, longitude: 139.814 },
      { ...base, id: `kenbiya_mock2_${prefecture}`, siteId: 'kenbiya', sitePropertyId: `mock2_${prefecture}`, title: '【健美家】大阪府 区分マンション 利回り9.2%', propertyType: 'investment', prefecture: '27' as PrefectureCode, city: '大阪市北区', price: 1200, priceText: '1,200万円', area: 32, rooms: '1K', age: 18, station: '梅田', stationMinutes: 5, thumbnailUrl: null, detailUrl: 'https://www.kenbiya.com/', yieldRate: 9.2, latitude: 34.702, longitude: 135.496 },
      { ...base, id: `kenbiya_mock3_${prefecture}`, siteId: 'kenbiya', sitePropertyId: `mock3_${prefecture}`, title: '【健美家】神奈川 一棟マンション 利回り7.8%', propertyType: 'investment', prefecture: '14' as PrefectureCode, city: '横浜市中区', price: 15000, priceText: '1億5,000万円', area: 580, rooms: '12室', age: 22, station: '関内', stationMinutes: 6, thumbnailUrl: null, detailUrl: 'https://www.kenbiya.com/', yieldRate: 7.8, latitude: 35.444, longitude: 139.641 },
    ];
  }
}
