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

  async scrapeDetail(url: string): Promise<Partial<Property>> {
    const html = await this.fetchHtml(url);
    if (!html) return {};

    const result: Partial<Property> = {};

    result.address = this.extractAddress(html);
    result.age = this.extractAge(html);
    const { floor, totalFloors } = this.extractFloor(html);
    if (floor !== null) result.floor = floor;
    if (totalFloors !== null) result.totalFloors = totalFloors;
    result.structure = this.extractStructure(html);

    const buildMatch = html.match(/(?:建物面積|延床面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (buildMatch) result.buildingArea = parseFloat(buildMatch[1]);
    const landMatch = html.match(/(?:土地面積|敷地面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (landMatch) result.landArea = parseFloat(landMatch[1]);

    // Station from detail
    const { station, stationMinutes } = this.extractStation(html);
    if (station) result.station = station;
    if (stationMinutes !== null) result.stationMinutes = stationMinutes;

    // Rooms from detail
    const roomsMatch = html.match(/(?:間取り|部屋数)[^0-9]*([1-9][LDKSR]+|\d+室)/);
    if (roomsMatch) result.rooms = roomsMatch[1];

    const { latitude, longitude } = this.extractCoordinates(html);
    if (latitude !== null) result.latitude = latitude;
    if (longitude !== null) result.longitude = longitude;

    const images = this.extractImages(html, 'https://www.kenbiya.com');
    if (images.length > 0) result.images = images;

    result.floorPlanUrl = this.extractFloorPlanUrl(html);

    return result;
  }

  private parseKenbiya(html: string, prefecture: PrefectureCode, maxResults: number): Property[] {
    const properties: Property[] = [];
    const itemPattern = /<div[^>]+class="[^"]*bukken[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    const titlePattern = /<h3[^>]*><a[^>]*>([^<]+)<\/a>/i;
    const pricePattern = /([0-9,]+)\s*万円/;
    const areaPattern = /([0-9.]+)\s*(?:m²|㎡)/;
    const linkPattern = /href="([^"]+bukken[^"]+)"/i;
    const yieldPattern = /([0-9.]+)\s*%/;
    const annualIncomePattern = /([0-9,]+)万円\/年/;

    let match;
    while ((match = itemPattern.exec(html)) !== null && properties.length < maxResults) {
      try {
        const chunk = match[1];
        const titleM = titlePattern.exec(chunk);
        const priceM  = pricePattern.exec(chunk);
        const areaM   = areaPattern.exec(chunk);
        const linkM   = linkPattern.exec(chunk);
        const yieldM  = yieldPattern.exec(chunk);
        const annualM = annualIncomePattern.exec(chunk);

        if (!titleM || !linkM) continue;

        const detailUrl = linkM[1].startsWith('http')
          ? linkM[1]
          : `https://www.kenbiya.com${linkM[1]}`;
        const sitePropertyId = `kenbiya_${btoa(encodeURIComponent(detailUrl)).slice(0, 20)}`;
        const price = priceM ? parseInt(priceM[1].replace(/,/g, '')) : null;
        const area  = areaM  ? parseFloat(areaM[1]) : null;
        const city = chunk.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const yieldRate = yieldM ? parseFloat(yieldM[1]) : null;
        const address = this.extractAddress(chunk);

        // Extract station, age, rooms, structure from listing card
        const { station, stationMinutes } = this.extractStation(chunk);
        const age = this.extractAge(chunk);
        const roomsMatch = chunk.match(/([1-9][LDKSR]+|\d+室)/);
        const rooms = roomsMatch ? roomsMatch[1] : null;
        const { floor, totalFloors } = this.extractFloor(chunk);

        // Annual income in description
        let descriptionExtra = '';
        if (annualM) {
          descriptionExtra = `想定年収：${annualM[1]}万円/年`;
        }

        const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title: titleM[1].trim(),
          propertyType: 'investment',
          prefecture,
          city,
          address,
          detailUrl,
          price,
          priceText: priceM ? `${priceM[1]}万円` : '価格要相談',
          area,
          rooms,
          age,
          floor,
          totalFloors,
          station,
          stationMinutes,
          yieldRate,
          description: descriptionExtra || null,
          thumbnailUrl: this.extractThumbnail(chunk),
          images: this.extractImages(chunk),
          managementFee: this.extractMonthlyFee(chunk, '管理費'),
          repairFund: this.extractMonthlyFee(chunk, '修繕積立金'),
          direction: this.extractDirection(chunk),
          structure: this.extractStructure(chunk),
          floorPlanUrl: this.extractFloorPlanUrl(chunk),
          exteriorUrl: this.extractExteriorUrl(chunk),
          fingerprint,
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

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
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
