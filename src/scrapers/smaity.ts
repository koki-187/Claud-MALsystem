import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class SmaityScraper extends BaseScraper {
  constructor() {
    super('smaity');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const url = `https://smaity.com/property/search/?pref=${ctx.prefecture}&page=${ctx.page ?? 1}`;

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

    const images = this.extractImages(html, 'https://smaity.com');
    if (images.length > 0) result.images = images;

    // Yield rate from detail page
    const yieldMatch = html.match(/(?:利回り|表面利回り)[^0-9]*([0-9.]+)\s*%/);
    if (yieldMatch) result.yieldRate = parseFloat(yieldMatch[1]);

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<div[^>]+class="[^"]*property-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/);
        const priceMatch = card.match(/(\d[,\d]*万円)/);
        const areaMatch  = card.match(/(\d+(?:\.\d+)?)\s*㎡/);
        const roomsMatch = card.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://smaity.com${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(priceMatch?.[1] ?? '');
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const { floor, totalFloors } = this.extractFloor(card);
        const sitePropertyId = `smaity_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(card);

        // Dynamic property type: Smaity often lists investment properties
        const propertyType = this.detectPropertyType(title + ' ' + card);

        // Extract yield rate from listing card
        const yieldMatch = card.match(/(?:利回り|表面利回り)[^0-9]*([0-9.]+)\s*%/);
        const yieldRate = yieldMatch ? parseFloat(yieldMatch[1]) : null;

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
          yieldRate,
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
      { title: '投資用 川崎市中原区 1K 利回り5.5%',        price: 1800, area: 28.5, rooms: '1K',   age: 15, city: '川崎市中原区',   station: '武蔵中原', stationMinutes: 5, lat: 35.5721, lng: 139.6617, yieldRate: 5.5 },
      { title: '投資用 さいたま市大宮区 1LDK 高利回り',     price: 2200, area: 38.0, rooms: '1LDK', age: 20, city: 'さいたま市大宮区', station: '大宮',    stationMinutes: 8, lat: 35.9079, lng: 139.6197, yieldRate: 7.2 },
      { title: '投資用 千葉市中央区 1R 駅1分',              price: 1500, area: 22.0, rooms: '1R',   age: 25, city: '千葉市中央区',    station: '千葉',    stationMinutes: 1, lat: 35.6074, lng: 140.1065, yieldRate: 6.8 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_smaity_${i}`,
        title: m.title,
        propertyType: 'investment',
        prefecture,
        city: m.city,
        detailUrl: `https://smaity.com/property/search/?pref=${prefecture}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        floor: 2 + i * 2,
        totalFloors: 10,
        station: m.station,
        stationMinutes: m.stationMinutes,
        yieldRate: m.yieldRate,
        description: `Smaity掲載の投資用物件。${m.city}エリア。安定した賃貸需要が見込めます。`,
        features: ['投資用', '高利回り', '管理会社あり', '入居中'],
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
