import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class FudosanScraper extends BaseScraper {
  constructor() {
    super('fudosan');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const url = `https://fudosan.jp/property/?pref=${ctx.prefecture}&page=${ctx.page ?? 1}`;

    const html = await this.fetchHtml(url);
    if (html) {
      const parsed = this.parseListings(html, ctx.prefecture);
      if (parsed.length > 0) return parsed;
    }
    return this.getMockData(ctx.prefecture);
  }

  async scrapeDetail(url: string): Promise<Partial<Property>> {
    const html = await this.fetchHtml(url);
    if (!html) return {};

    const result: Partial<Property> = {};

    result.address = this.extractAddress(html);
    result.age = this.extractAge(html);
    const { floor, totalFloors } = this.extractFloor(html);
    if (floor !== null) result.floor = floor;
    if (totalFloors !== null) result.totalFloors = totalFloors;
    result.direction = this.extractDirection(html);
    result.structure = this.extractStructure(html);

    const buildMatch = html.match(/(?:専有面積|建物面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (buildMatch) result.buildingArea = parseFloat(buildMatch[1]);
    const landMatch = html.match(/(?:土地面積|敷地面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (landMatch) result.landArea = parseFloat(landMatch[1]);

    const { latitude, longitude } = this.extractCoordinates(html);
    if (latitude !== null) result.latitude = latitude;
    if (longitude !== null) result.longitude = longitude;

    const images = this.extractImages(html, 'https://fudosan.jp');
    if (images.length > 0) result.images = images;

    result.floorPlanUrl = this.extractFloorPlanUrl(html);
    result.exteriorUrl = this.extractExteriorUrl(html);

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<div[^>]+class="[^"]*bukken-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/li>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/);
        const priceMatch = card.match(/(\d[,\d]*万円)/);
        const areaMatch  = card.match(/(\d+(?:\.\d+)?)\s*㎡/);
        const roomsMatch = card.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://fudosan.jp${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(priceMatch?.[1] ?? '');
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const { floor, totalFloors } = this.extractFloor(card);
        const sitePropertyId = `fudosan_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(card);

        // Dynamic property type detection
        const propertyType = this.detectPropertyType(title + ' ' + card);

        const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms: roomsMatch?.[1] ?? null });

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title,
          propertyType,
          prefecture,
          city,
          address,
          detailUrl,
          price,
          priceText,
          area,
          rooms: roomsMatch?.[1] ?? null,
          station,
          stationMinutes,
          age,
          floor,
          totalFloors,
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
      { title: '仙台市青葉区 分譲マンション 3LDK 駅近',   price: 3800, area:  80.0, rooms: '3LDK', age: 10, city: '仙台市青葉区', station: '仙台', stationMinutes:  8, lat: 38.2682, lng: 140.8694 },
      { title: '広島市南区宇品 マンション 2LDK 海望',     price: 2900, area:  55.5, rooms: '2LDK', age: 22, city: '広島市南区',   station: '宇品', stationMinutes: 10, lat: 34.3721, lng: 132.4740 },
      { title: '岡山市北区 新築分譲 3LDK 駐車場付',       price: 3500, area:  90.2, rooms: '3LDK', age:  0, city: '岡山市北区',   station: '岡山', stationMinutes: 20, lat: 34.6618, lng: 133.9345 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_fudosan_${i}`,
        title: m.title,
        propertyType: 'mansion',
        prefecture,
        city: m.city,
        detailUrl: `https://fudosan.jp/property/?pref=${prefecture}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        floor: 3 + i * 3,
        totalFloors: 15,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `不動産Japan掲載。${m.city}の${m.rooms}。${m.age === 0 ? '新築分譲' : `築${m.age}年、管理良好`}。`,
        features: ['駐車場', '管理人常駐', '地震対応設計'],
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
