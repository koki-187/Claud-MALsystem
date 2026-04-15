import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class RakumachiScraper extends BaseScraper {
  constructor() {
    super('rakumachi');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const { prefecture, maxResults = 15 } = ctx;
    const prefNum = parseInt(prefecture);
    const url = `https://www.rakumachi.jp/syuuekibukken/area/?pref_code=${prefNum}`;

    const html = await this.fetchHtml(url);
    if (html) {
      const properties = this.parseRakumachi(html, prefecture, maxResults);
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

    const images = this.extractImages(html, 'https://www.rakumachi.jp');
    if (images.length > 0) result.images = images;

    result.floorPlanUrl = this.extractFloorPlanUrl(html);

    return result;
  }

  private parseRakumachi(html: string, prefecture: PrefectureCode, maxResults: number): Property[] {
    const properties: Property[] = [];
    const itemPattern = /<li[^>]+class="[^"]*property[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    const titlePattern = /<a[^>]+class="[^"]*property-name[^"]*"[^>]*>([^<]+)<\/a>/i;
    const pricePattern = /([0-9,]+)\s*万円/;
    const areaPattern  = /([0-9.]+)\s*(?:m²|㎡)/;
    const linkPattern  = /href="(\/syuuekibukken\/[^"]+)"/i;
    const yieldPattern = /([0-9.]+)\s*%/;
    const annualIncomePattern = /([0-9,]+)万円\/年/;

    let match;
    while ((match = itemPattern.exec(html)) !== null && properties.length < maxResults) {
      try {
        const chunk  = match[1];
        const titleM = titlePattern.exec(chunk);
        const priceM = pricePattern.exec(chunk);
        const areaM  = areaPattern.exec(chunk);
        const linkM  = linkPattern.exec(chunk);
        const yieldM = yieldPattern.exec(chunk);
        const annualM = annualIncomePattern.exec(chunk);

        if (!titleM || !linkM) continue;

        const detailUrl = `https://www.rakumachi.jp${linkM[1]}`;
        const sitePropertyId = `rakumachi_${btoa(encodeURIComponent(detailUrl)).slice(0, 20)}`;
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
      { title: '【楽待】福岡市 一棟アパート 表面利回り10.1%', price: 4800,  area: 310, rooms: '10室', age: 15, city: '福岡市博多区', station: '博多',   stationMinutes: 12, lat: 33.591, lng: 130.421, yieldRate: 10.1 },
      { title: '【楽待】名古屋市 区分マンション 利回り8.8%',  price:  980,  area:  28, rooms: '1K',   age: 20, city: '名古屋市中区', station: '名古屋', stationMinutes: 10, lat: 35.171, lng: 136.882, yieldRate: 8.8  },
      { title: '【楽待】札幌市 一棟アパート 利回り11.5%',     price: 3200,  area: 280, rooms: '12室', age: 25, city: '札幌市中央区', station: '大通',   stationMinutes:  8, lat: 43.056, lng: 141.354, yieldRate: 11.5 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_rakumachi_${i}`,
        title: m.title,
        propertyType: 'investment',
        prefecture,
        city: m.city,
        detailUrl: `https://www.rakumachi.jp/syuuekibukken/area/?pref_code=${parseInt(prefecture)}`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        station: m.station,
        stationMinutes: m.stationMinutes,
        yieldRate: m.yieldRate,
        description: `楽待掲載の収益不動産。${m.city}エリア。表面利回り${m.yieldRate}%。安定した家賃収入が見込めます。`,
        features: ['収益物件', '楽待掲載', '安定収益', '入居中'],
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
