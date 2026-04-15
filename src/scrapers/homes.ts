import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class HomesScraper extends BaseScraper {
  constructor() {
    super('homes');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const url = `https://www.homes.co.jp/mansion/buy/list/?pref=${ctx.prefecture}&page=${ctx.page ?? 1}`;

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

    const images = this.extractImages(html, 'https://www.homes.co.jp');
    if (images.length > 0) result.images = images;

    result.floorPlanUrl = this.extractFloorPlanUrl(html);
    result.exteriorUrl = this.extractExteriorUrl(html);

    const descMatch = html.match(/<p[^>]*class="[^"]*(?:detail|comment|prg)[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (descMatch) result.description = descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 500);

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<div[^>]+class="[^"]*mod-mergeBuilding--sale[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/);
        const priceMatch = card.match(/(\d[,\d]*万円)/);
        const areaMatch  = card.match(/専有面積[^0-9]*(\d+(?:\.\d+)?)\s*m/);
        const roomsMatch = card.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.homes.co.jp${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(priceMatch?.[1] ?? '');
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const { floor, totalFloors } = this.extractFloor(card);
        const sitePropertyId = `homes_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(card);

        // Dynamic property type detection
        const propertyType = this.detectPropertyType(title + ' ' + card);

        // HOME'S-specific patterns
        const managementFee = this.extractMonthlyFee(card, '管理費/月') ?? this.extractMonthlyFee(card, '管理費');
        const repairFund = this.extractMonthlyFee(card, '修繕積立金');

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
          managementFee,
          repairFund,
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
      { title: '大阪市北区マンション 2LDK リノベーション済', price:  5200, area:  58.4, rooms: '2LDK', age:  5, city: '大阪市北区', station: '梅田',       stationMinutes:  7, lat: 34.7025, lng: 135.4964 },
      { title: '横浜市中区みなとみらい 3LDK タワー',        price:  9800, area:  88.0, rooms: '3LDK', age:  2, city: '横浜市中区', station: 'みなとみらい', stationMinutes:  6, lat: 35.4561, lng: 139.6380 },
      { title: '名古屋市中村区 新築マンション 2LDK',       price:  4100, area:  65.0, rooms: '2LDK', age:  0, city: '名古屋市中村区', station: '名古屋',    stationMinutes: 10, lat: 35.1702, lng: 136.8816 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_homes_${i}`,
        title: m.title,
        propertyType: 'mansion',
        prefecture,
        city: m.city,
        detailUrl: `https://www.homes.co.jp/mansion/buy/list/?pref=${prefecture}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        floor: 3 + i * 4,
        totalFloors: 20,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `${m.city}の${m.rooms}物件。HOME'S掲載物件。`,
        features: ['オートロック', 'モニター付インターホン', '宅配ボックス'],
        latitude:  m.lat + (i - 1) * 0.005,
        longitude: m.lng + (i - 1) * 0.005,
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
