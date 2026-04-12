import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';

export class RakumachiScraper extends BaseScraper {
  constructor() {
    super('rakumachi');
  }

  async scrapeListings(ctx: { prefecture: PrefectureCode; maxResults?: number }): Promise<Property[]> {
    const { prefecture, maxResults = 15 } = ctx;
    const prefNum = parseInt(prefecture);
    // 楽待のURL例: ?pref_code=13 (東京)
    const url = `https://www.rakumachi.jp/syuuekibukken/area/?pref_code=${prefNum}`;

    try {
      const html = await this.fetchWithRetry(url);
      const properties = this.parseRakumachi(html, prefecture, maxResults);
      if (properties.length > 0) return properties;
    } catch {
      // fall through to mock
    }
    return this.getMockData(prefecture);
  }

  private parseRakumachi(html: string, prefecture: PrefectureCode, maxResults: number): Property[] {
    const properties: Property[] = [];
    const itemPattern = /<li[^>]+class="[^"]*property[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    const titlePattern = /<a[^>]+class="[^"]*property-name[^"]*"[^>]*>([^<]+)<\/a>/i;
    const pricePattern = /([0-9,]+)\s*万円/;
    const areaPattern = /([0-9.]+)\s*(?:m²|㎡)/;
    const linkPattern = /href="(\/syuuekibukken\/[^"]+)"/i;
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
      const detailUrl = `https://www.rakumachi.jp${linkM[1]}`;
      const sitePropertyId = `rakumachi_${btoa(encodeURIComponent(detailUrl)).slice(0, 20)}`;

      properties.push({
        id: `rakumachi_${sitePropertyId}`,
        siteId: 'rakumachi',
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
    const base = { status: 'active' as const, images: [], features: ['収益物件', '楽待掲載', '安定収益'], priceHistory: [], listedAt: null, soldAt: null, buildingArea: null, landArea: null, floor: null, totalFloors: null, address: null, description: '楽待掲載の収益不動産。安定した家賃収入が見込めます。', createdAt: now, updatedAt: now, scrapedAt: now };
    return [
      { ...base, id: `rakumachi_mock1_${prefecture}`, siteId: 'rakumachi', sitePropertyId: `mock1_${prefecture}`, title: '【楽待】福岡市 一棟アパート 表面利回り10.1%', propertyType: 'investment', prefecture: '40' as PrefectureCode, city: '福岡市博多区', price: 4800, priceText: '4,800万円', area: 310, rooms: '10室', age: 15, station: '博多', stationMinutes: 12, thumbnailUrl: null, detailUrl: 'https://www.rakumachi.jp/', yieldRate: 10.1, latitude: 33.591, longitude: 130.421 },
      { ...base, id: `rakumachi_mock2_${prefecture}`, siteId: 'rakumachi', sitePropertyId: `mock2_${prefecture}`, title: '【楽待】名古屋市 区分マンション 利回り8.8%', propertyType: 'investment', prefecture: '23' as PrefectureCode, city: '名古屋市中区', price: 980, priceText: '980万円', area: 28, rooms: '1K', age: 20, station: '名古屋', stationMinutes: 10, thumbnailUrl: null, detailUrl: 'https://www.rakumachi.jp/', yieldRate: 8.8, latitude: 35.171, longitude: 136.882 },
      { ...base, id: `rakumachi_mock3_${prefecture}`, siteId: 'rakumachi', sitePropertyId: `mock3_${prefecture}`, title: '【楽待】札幌市 一棟アパート 利回り11.5%', propertyType: 'investment', prefecture: '01' as PrefectureCode, city: '札幌市中央区', price: 3200, priceText: '3,200万円', area: 280, rooms: '12室', age: 25, station: '大通', stationMinutes: 8, thumbnailUrl: null, detailUrl: 'https://www.rakumachi.jp/', yieldRate: 11.5, latitude: 43.056, longitude: 141.354 },
    ];
  }
}
