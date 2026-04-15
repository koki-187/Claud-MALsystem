import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class ChintaiScraper extends BaseScraper {
  constructor() {
    super('chintai');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const url = `https://chintai.net/rent/search/?prefecture_cd=${ctx.prefecture}&page=${ctx.page ?? 1}`;

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

    const { latitude, longitude } = this.extractCoordinates(html);
    if (latitude !== null) result.latitude = latitude;
    if (longitude !== null) result.longitude = longitude;

    const images = this.extractImages(html, 'https://chintai.net');
    if (images.length > 0) result.images = images;

    result.floorPlanUrl = this.extractFloorPlanUrl(html);

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<div[^>]+class="[^"]*property-cassette[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<h2[^>]*>([^<]+)<\/h2>/);
        const rentMatch  = card.match(/(\d+(?:\.\d+)?)\s*万円\/月/);
        const areaMatch  = card.match(/(\d+(?:\.\d+)?)\s*m²/);
        const roomsMatch = card.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://chintai.net${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const rent = rentMatch ? Math.round(parseFloat(rentMatch[1])) : null;
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const { floor, totalFloors } = this.extractFloor(card);
        const sitePropertyId = `chintai_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(card);

        // Detect rental type: apartment vs detached house
        const propertyType = /(?:一戸建|戸建|一軒家)/.test(title + card) ? 'chintai_ikkodate' as const : 'chintai_mansion' as const;

        const fingerprint = this.computeFingerprint({ prefecture, city, price: rent, area, rooms: roomsMatch?.[1] ?? null });

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title,
          propertyType,
          prefecture,
          city,
          address,
          detailUrl,
          price: rent,
          priceText: rent ? `家賃${rent}万円/月` : '要問合せ',
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
      { title: '東京都渋谷区 賃貸1LDK デザイナーズ',  price: 20, area: 42.5, rooms: '1LDK', age:  3, city: '渋谷区',      station: '渋谷',   stationMinutes:  6, lat: 35.6580, lng: 139.7016 },
      { title: '大阪市中央区心斎橋 賃貸2LDK',         price: 15, area: 58.0, rooms: '2LDK', age:  8, city: '大阪市中央区', station: '心斎橋', stationMinutes:  5, lat: 34.6726, lng: 135.5024 },
      { title: '名古屋市千種区 賃貸マンション 1K',    price:  7, area: 25.3, rooms: '1K',   age: 12, city: '名古屋市千種区', station: '本山',  stationMinutes:  9, lat: 35.1607, lng: 136.9375 },
      { title: '福岡市博多区 賃貸2DK ペット可',       price: 10, area: 48.0, rooms: '2DK',  age:  6, city: '福岡市博多区', station: '博多',   stationMinutes: 12, lat: 33.5898, lng: 130.4200 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_chintai_${i}`,
        title: m.title,
        propertyType: 'chintai_mansion',
        prefecture,
        city: m.city,
        detailUrl: `https://chintai.net/rent/search/?prefecture_cd=${prefecture}`,
        price: m.price,
        priceText: `家賃${m.price}万円/月`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        floor: 2 + i,
        totalFloors: 10,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `CHINTAI掲載。${m.city}の賃貸物件。初期費用も相談可能。`,
        features: ['インターネット無料', 'バストイレ別', 'エアコン付', 'フローリング'],
        latitude:  m.lat + (i - 1.5) * 0.005,
        longitude: m.lng + (i - 1.5) * 0.005,
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
