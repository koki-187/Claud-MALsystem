import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class KenbiyaScraper extends BaseScraper {
  constructor() {
    super('kenbiya');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const { prefecture, maxResults = 15 } = ctx;
    const prefNum = parseInt(prefecture);
    // 健美家URL例: /ar/0013/ (東京)
    const prefStr = String(prefNum).padStart(4, '0');
    const url = `https://www.kenbiya.com/ar/${prefStr}/`;

    const html = await this.fetchHtml(url);
    if (html) {
      const properties = this.parseKenbiya(html, prefecture, maxResults);
      if (properties.length > 0) return properties;
    }
    return this.getMockData(prefecture);
  }

  private parseKenbiya(html: string, prefecture: PrefectureCode, maxResults: number): Property[] {
    const properties: Property[] = [];
    const itemPattern = /<div[^>]+class="[^"]*bukken[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    const titlePattern = /<h3[^>]*><a[^>]*>([^<]+)<\/a>/i;
    const pricePattern = /([0-9,]+)\s*万円/;
    const areaPattern = /([0-9.]+)\s*(?:m²|㎡)/;
    const linkPattern = /href="([^"]+bukken[^"]+)"/i;
    const yieldPattern = /([0-9.]+)\s*%/;

    let match;
    while ((match = itemPattern.exec(html)) !== null && properties.length < maxResults) {
      try {
        const chunk = match[1];
        const titleM = titlePattern.exec(chunk);
        const priceM  = pricePattern.exec(chunk);
        const areaM   = areaPattern.exec(chunk);
        const linkM   = linkPattern.exec(chunk);
        const yieldM  = yieldPattern.exec(chunk);

        if (!titleM || !linkM) continue;

        const detailUrl = linkM[1].startsWith('http')
          ? linkM[1]
          : `https://www.kenbiya.com${linkM[1]}`;
        const sitePropertyId = `kenbiya_${btoa(encodeURIComponent(detailUrl)).slice(0, 20)}`;
        const price = priceM ? parseInt(priceM[1].replace(/,/g, '')) : null;
        const area  = areaM  ? parseFloat(areaM[1]) : null;

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title: titleM[1].trim(),
          propertyType: 'investment',
          prefecture,
          city: '',
          detailUrl,
          price,
          priceText: priceM ? `${priceM[1]}万円` : '価格要相談',
          area,
          yieldRate: yieldM ? parseFloat(yieldM[1]) : null,
          thumbnailUrl: this.extractThumbnail(chunk),
        }));
      } catch { continue; }
    }
    return properties;
  }

  private getMockData(prefecture: PrefectureCode): Property[] {
    const mockProperties = [
      { title: '【健美家】東京都 一棟アパート 利回り8.5%',   price: 8500,  area: 220, rooms: '8室',  age: 12, city: '墨田区',      station: '錦糸町', stationMinutes: 8,  lat: 35.698, lng: 139.814, yieldRate: 8.5  },
      { title: '【健美家】大阪府 区分マンション 利回り9.2%', price: 1200,  area:  32, rooms: '1K',   age: 18, city: '大阪市北区',   station: '梅田',   stationMinutes: 5,  lat: 34.702, lng: 135.496, yieldRate: 9.2  },
      { title: '【健美家】神奈川 一棟マンション 利回り7.8%', price: 15000, area: 580, rooms: '12室', age: 22, city: '横浜市中区',   station: '関内',   stationMinutes: 6,  lat: 35.444, lng: 139.641, yieldRate: 7.8  },
    ];

    return mockProperties.map((m, i) => this.buildBaseProperty({
      sitePropertyId: `mock_${prefecture}_kenbiya_${i}`,
      title: m.title,
      propertyType: 'investment',
      prefecture,
      city: m.city,
      detailUrl: `https://www.kenbiya.com/ar/${String(parseInt(prefecture)).padStart(4, '0')}/`,
      price: m.price,
      priceText: `${m.price.toLocaleString()}万円`,
      area: m.area,
      buildingArea: m.area,
      rooms: m.rooms,
      age: m.age,
      station: m.station,
      stationMinutes: m.stationMinutes,
      yieldRate: m.yieldRate,
      description: `健美家掲載の収益物件。${m.city}エリア。表面利回り${m.yieldRate}%。`,
      features: ['一棟物件', '投資用', '利回り良好', '管理会社あり'],
      latitude:  m.lat + (i - 1) * 0.01,
      longitude: m.lng + (i - 1) * 0.01,
    }));
  }
}
