import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';

export class SuumoScraper extends BaseScraper {
  constructor() {
    super('suumo');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const prefCode = ctx.prefecture.padStart(2, '0');
    const url = `https://suumo.jp/jj/bukken/ichiran/JJ010FJ001/?ar=0${prefCode}&bs=011&ta=${ctx.prefecture}&po=0&pg=${ctx.page ?? 1}`;

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

    // Full address
    result.address = this.extractAddress(html);

    // Age
    result.age = this.extractAge(html);

    // Floor info
    const { floor, totalFloors } = this.extractFloor(html);
    if (floor !== null) result.floor = floor;
    if (totalFloors !== null) result.totalFloors = totalFloors;

    // Direction, structure
    result.direction = this.extractDirection(html);
    result.structure = this.extractStructure(html);

    // Management fee / repair fund
    const mgmt = html.match(/管理費[^0-9]*([0-9,]+)\s*円/);
    if (mgmt) result.managementFee = parseInt(mgmt[1].replace(/,/g, ''));
    const repair = html.match(/修繕積立金[^0-9]*([0-9,]+)\s*円/);
    if (repair) result.repairFund = parseInt(repair[1].replace(/,/g, ''));

    // Building/land area
    const buildMatch = html.match(/(?:専有面積|建物面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (buildMatch) result.buildingArea = parseFloat(buildMatch[1]);
    const landMatch = html.match(/(?:土地面積|敷地面積)[^0-9]*(\d+(?:\.\d+)?)\s*m/);
    if (landMatch) result.landArea = parseFloat(landMatch[1]);

    // Coordinates
    const { latitude, longitude } = this.extractCoordinates(html);
    if (latitude !== null) result.latitude = latitude;
    if (longitude !== null) result.longitude = longitude;

    // Images
    const images = this.extractImages(html, 'https://suumo.jp');
    if (images.length > 0) result.images = images;

    // Floor plan / exterior
    result.floorPlanUrl = this.extractFloorPlanUrl(html);
    result.exteriorUrl = this.extractExteriorUrl(html);

    // Description
    const descMatch = html.match(/<p[^>]*class="[^"]*(?:detail|comment|description)[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (descMatch) result.description = descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 500);

    // Features
    const featureMatches = html.matchAll(/<li[^>]*class="[^"]*(?:point|tag|feature)[^"]*"[^>]*>([^<]+)<\/li>/gi);
    const features: string[] = [];
    for (const fm of featureMatches) {
      const f = fm[1].trim();
      if (f && features.length < 15) features.push(f);
    }
    if (features.length > 0) result.features = features;

    return result;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const properties: Property[] = [];
    const cardRegex = /<div[^>]+class="[^"]*cassette_inner[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
    let match;
    let count = 0;

    while ((match = cardRegex.exec(html)) !== null && count < 15) {
      try {
        const card = match[1];
        const titleMatch = card.match(/<dt[^>]*class="[^"]*cassette_title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*([^<]+)/);
        const priceMatch = card.match(/管理費：(\d[,\d]*)円/) ?? card.match(/(\d[,\d]*万円)/);
        const areaMatch  = card.match(/(\d+(?:\.\d+)?)\s*m²/);
        const roomsMatch = card.match(/(\d[LDKSR]+)/);
        const imgMatch   = card.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);

        if (!titleMatch) continue;

        const detailUrl = `https://suumo.jp${titleMatch[1]}`;
        const title = titleMatch[2].trim();
        const { price, priceText } = this.extractPrice(card.match(/(\d[,\d]*万円)/)?.[1] ?? '');
        const area = this.extractArea(areaMatch?.[0] ?? '');
        const { station, stationMinutes } = this.extractStation(card);
        const age = this.extractAge(card);
        const { floor, totalFloors } = this.extractFloor(card);
        const sitePropertyId = btoa(encodeURIComponent(detailUrl)).slice(0, 20);
        const city = card.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const address = this.extractAddress(card);

        // Dynamic property type detection
        const propertyType = this.detectPropertyType(title + ' ' + card);

        // Management fee / repair fund (SUUMO-specific patterns)
        const managementFeeMatch = card.match(/管理費：(\d[,\d]*)円/);
        const repairFundMatch = card.match(/修繕積立金：(\d[,\d]*)円/);
        const managementFee = managementFeeMatch ? parseInt(managementFeeMatch[1].replace(/,/g, '')) : null;
        const repairFund = repairFundMatch ? parseInt(repairFundMatch[1].replace(/,/g, '')) : null;

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
          age,
          floor,
          totalFloors,
          station,
          stationMinutes,
          thumbnailUrl: imgMatch?.[1] ?? null,
          images: imgMatch?.[1] ? [imgMatch[1]] : [],
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
      { title: '港区タワーマンション 3LDK',      price: 15800, area: 85.5, rooms: '3LDK', age:  3, city: '港区',   station: '六本木', stationMinutes: 5, lat: 35.6627, lng: 139.7320 },
      { title: '新宿区マンション 2LDK リノベ済',  price:  8500, area: 62.3, rooms: '2LDK', age:  8, city: '新宿区', station: '新宿',   stationMinutes: 8, lat: 35.6907, lng: 139.6994 },
      { title: '渋谷区デザイナーズ 1LDK',        price:  7200, area: 48.0, rooms: '1LDK', age:  5, city: '渋谷区', station: '渋谷',   stationMinutes: 7, lat: 35.6580, lng: 139.7016 },
    ];

    return mockProperties.map((m, i) => {
      const fingerprint = this.computeFingerprint({ prefecture, city: m.city, price: m.price, area: m.area, rooms: m.rooms });
      return this.buildBaseProperty({
        sitePropertyId: `mock_${prefecture}_suumo_${i}`,
        title: m.title,
        propertyType: 'mansion',
        prefecture,
        city: m.city,
        detailUrl: `https://suumo.jp/ms/mansion/tokyo/sc_${prefecture}/`,
        price: m.price,
        priceText: `${m.price.toLocaleString()}万円`,
        area: m.area,
        buildingArea: m.area,
        rooms: m.rooms,
        age: m.age,
        floor: 5 + i * 3,
        totalFloors: 25,
        station: m.station,
        stationMinutes: m.stationMinutes,
        description: `${m.city}の人気エリアに位置する${m.rooms}の物件です。`,
        features: ['オートロック', '宅配ボックス', 'エレベーター'],
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
