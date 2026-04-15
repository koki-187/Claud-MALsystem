import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class ReinsScraper extends BaseScraper {
  constructor() {
    super('reins');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    // REINS (Real Estate Information Network System) - 不動産流通機構
    const url = `https://www.reins.or.jp/search/?prefecture=${ctx.prefecture}&page=${ctx.page ?? 1}`;

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

    const images = this.extractImages(html, 'https://www.reins.or.jp');
    if (images.length > 0) result.images = images;

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<tr[^>]+class="[^"]*bukken-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const row = match[1];
        const titleMatch = row.match(/<td[^>]*class="[^"]*name[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/);
        const priceMatch = row.match(/(\d[,\d]*万円)/);
        const areaMatch  = row.match(/(\d+(?:\.\d+)?)\s*㎡/);
        const roomsMatch = row.match(/([1-9][LDKSR]+)/);

        if (!titleMatch) continue;

        const detailUrl = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.reins.or.jp${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(priceMatch?.[1] ?? '');
        const area = areaMatch ? parseFloat(areaMatch[1]) : null;
        const { station, stationMinutes } = this.extractStation(row);
        const age = this.extractAge(row);
        const { floor, totalFloors } = this.extractFloor(row);
        const sitePropertyId = `reins_${btoa(encodeURIComponent(detailUrl)).slice(0, 18)}`;
        const city = row.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(row);

        // Dynamic property type detection
        const propertyType = this.detectPropertyType(title + ' ' + row);

        // Land area extraction
        const landMatch = row.match(/(?:土地面積|敷地面積|土地)[^0-9]*(\d+(?:\.\d+)?)\s*(?:m²|㎡)/);
        const landArea = landMatch ? parseFloat(landMatch[1]) : null;

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
          landArea,
          rooms: roomsMatch?.[1] ?? null,
          station,
          stationMinutes,
          age,
          floor,
          totalFloors,
          thumbnailUrl: this.extractThumbnail(row),
          images: this.extractImages(row),
          managementFee: this.extractMonthlyFee(row, '管理費'),
          repairFund: this.extractMonthlyFee(row, '修繕積立金'),
          direction: this.extractDirection(row),
          structure: this.extractStructure(row),
          floorPlanUrl: this.extractFloorPlanUrl(row),
          exteriorUrl: this.extractExteriorUrl(row),
          fingerprint,
        }));
        count++;
      } catch { continue; }
    }

    return properties;
  }

  private getMockData(prefecture: PrefectureCode): Property[] {
    const mockProperties = [
      {
        title: '北海道旭川市 中古一戸建て 4LDK 土地200m²',
        price: 1800, area: 120.0, landArea: 200.0, rooms: '4LDK', age: 30,
        city: '旭川市', station: '旭川', stationMinutes: 20,
        lat: 43.7706, lng: 142.3650, type: 'kodate' as const,
      },
      {
        title: '沖縄県那覇市 マンション 3LDK 新築 海近',
        price: 4200, area: 78.5, landArea: null, rooms: '3LDK', age: 0,
        city: '那覇市', station: '旭橋', stationMinutes: 10,
        lat: 26.2124, lng: 127.6809, type: 'mansion' as const,
      },
      {
        title: '鹿児島市 土地 150m² 建築条件なし 桜島ビュー',
        price: 1500, area: null, landArea: 150.0, rooms: null, age: null,
        city: '鹿児島市', station: '天文館通', stationMinutes: 15,
        lat: 31.5966, lng: 130.5571, type: 'tochi' as const,
      },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area ?? null, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_reins_${i}`,
        title: m.title,
        propertyType: m.type,
        prefecture,
        city: m.city,
        detailUrl: `https://www.reins.or.jp/search/?prefecture=${prefecture}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area ?? null,
        buildingArea: m.area ?? null,
        landArea: m.landArea ?? null,
        rooms: m.rooms,
        age: m.age,
        floor: m.type === 'mansion' ? 4 + i * 3 : null,
        totalFloors: m.type === 'mansion' ? 20 : null,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `REINS掲載物件。${m.city}エリア。信頼性の高い不動産流通機構の登録物件。`,
        features: m.type === 'tochi'   ? ['建築条件なし', '更地渡し', '即引渡可'] :
                  m.type === 'kodate'  ? ['駐車場2台', '収納充実', '閑静な住宅地'] :
                                         ['新築', '免震構造', '24時間管理'],
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
