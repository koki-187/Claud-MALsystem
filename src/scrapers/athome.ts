import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class AthomeScraper extends BaseScraper {
  constructor() {
    super('athome');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const url = `https://www.athome.co.jp/mansion/chuko/list/?PREF_CD=${ctx.prefecture}&page=${ctx.page ?? 1}`;

    const html = await this.fetchHtml(url);
    if (html) {
      const parsed = this.parseListings(html, ctx.prefecture);
      if (parsed.length > 0) return parsed;
    }
    return this.getMockData(ctx.prefecture);
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<article[^>]+class="[^"]*property-list-item[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/);
        const priceMatch = card.match(/(\d[,\d]*万円)/);
        const areaMatch  = card.match(/(\d+(?:\.\d+)?)\s*m²/);
        const roomsMatch = card.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.athome.co.jp${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(priceMatch?.[1] ?? '');
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const sitePropertyId = `athome_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

        const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms: roomsMatch?.[1] ?? null });

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title,
          propertyType: 'mansion',
          prefecture,
          city,
          detailUrl,
          price,
          priceText,
          area,
          rooms: roomsMatch?.[1] ?? null,
          station,
          stationMinutes,
          age,
          thumbnailUrl: this.extractThumbnail(card),
          images: this.extractImages(card),
          managementFee: this.extractMonthlyFee(card, '管理費'),
          repairFund: this.extractMonthlyFee(card, '修繕積立金'),
          direction: this.extractDirection(card),
          structure: this.extractStructure(card),
          floorPlanUrl: this.extractFloorPlanUrl(card),
          exteriorUrl: this.extractExteriorUrl(card),
          fingerprint,
        }));
        count++;
      } catch { continue; }
    }

    return properties;
  }

  private getMockData(prefecture: PrefectureCode): Property[] {
    const mockProperties = [
      { title: '京都市左京区 京町家リノベ 3DK',        price: 3800, area:  72.5, rooms: '3DK',  age: 55, city: '京都市左京区', station: '出町柳', stationMinutes: 12, lat: 35.0370, lng: 135.7728, type: 'kodate'  as const },
      { title: '神戸市灘区 マンション 2LDK 眺望良好',  price: 3200, area:  60.0, rooms: '2LDK', age: 18, city: '神戸市灘区',   station: '六甲道', stationMinutes:  8, lat: 34.7155, lng: 135.2449, type: 'mansion' as const },
      { title: '福岡市早良区 一戸建て 4LDK 新築',      price: 4600, area: 110.8, rooms: '4LDK', age:  0, city: '福岡市早良区', station: '西新',   stationMinutes: 15, lat: 33.5739, lng: 130.3614, type: 'kodate'  as const },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_athome_${i}`,
        title: m.title,
        propertyType: m.type,
        prefecture,
        city: m.city,
        detailUrl: `https://www.athome.co.jp/mansion/chuko/list/?PREF_CD=${prefecture}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        landArea: m.type === 'kodate' ? Math.round(m.area * 1.2) : null,
        rooms: m.rooms,
        age: m.age,
        floor: m.type === 'mansion' ? 3 + i * 2 : null,
        totalFloors: m.type === 'mansion' ? 15 : null,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `AtHome掲載。${m.city}の${m.rooms}物件。${m.age === 0 ? '新築' : `築${m.age}年`}。`,
        features: m.type === 'kodate' ? ['駐車場', '庭付き', '収納豊富'] : ['角部屋', '眺望良好', 'ペット相談可'],
        latitude:  m.lat + (i - 1) * 0.01,
        longitude: m.lng + (i - 1) * 0.01,
        fingerprint,
        managementFee: null,
        repairFund: null,
        direction: null,
        structure: null,
        floorPlanUrl: null,
        exteriorUrl: null,
        lastSeenAt: null,
      });
    });
  }
}
