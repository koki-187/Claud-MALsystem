import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
} from '../parsers/html-parser';

// Smaity prefecture code → URL slug mapping
const SMAITY_PREF_SLUGS: Record<string, string> = {
  '01': 'hokkaido',
  '02': 'aomori',
  '03': 'iwate',
  '04': 'miyagi',
  '05': 'akita',
  '06': 'yamagata',
  '07': 'fukushima',
  '08': 'ibaraki',
  '09': 'tochigi',
  '10': 'gunma',
  '11': 'saitama',
  '12': 'chiba',
  '13': 'tokyo',
  '14': 'kanagawa',
  '15': 'niigata',
  '16': 'toyama',
  '17': 'ishikawa',
  '18': 'fukui',
  '19': 'yamanashi',
  '20': 'nagano',
  '21': 'gifu',
  '22': 'shizuoka',
  '23': 'aichi',
  '24': 'mie',
  '25': 'shiga',
  '26': 'kyoto',
  '27': 'osaka',
  '28': 'hyogo',
  '29': 'nara',
  '30': 'wakayama',
  '31': 'tottori',
  '32': 'shimane',
  '33': 'okayama',
  '34': 'hiroshima',
  '35': 'yamaguchi',
  '36': 'tokushima',
  '37': 'kagawa',
  '38': 'ehime',
  '39': 'kochi',
  '40': 'fukuoka',
  '41': 'saga',
  '42': 'nagasaki',
  '43': 'kumamoto',
  '44': 'oita',
  '45': 'miyazaki',
  '46': 'kagoshima',
  '47': 'okinawa',
};

// 都道府県スラッグ → {slug}_prop (物件詳細URL生成用)
const SMAITY_PROP_PREFIX: Record<string, string> = {
  'tokyo': 'tokyo',
  'kanagawa': 'kanagawa',
  'osaka': 'osaka',
  'aichi': 'aichi',
  'saitama': 'saitama',
  'chiba': 'chiba',
  'hyogo': 'hyogo',
  'fukuoka': 'fukuoka',
};

export class SmaityScraper extends BaseScraper {
  constructor() {
    super('smaity');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const slug = SMAITY_PREF_SLUGS[ctx.prefecture];
    if (!slug) return [];

    // Smaity 中古マンション一覧 URL (投資用に限定されないが実用的なデータが取れる)
    // メインコンテンツはJS動的生成のため、サイドバーの「新着物件」と
    // テーマリンクから物件を収集する
    const url = `https://sumaity.com/mansion/used/${slug}/`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    return this.parseListings(html, ctx.prefecture, slug);
  }

  private parseListings(html: string, prefecture: PrefectureCode, prefSlug: string): Property[] {
    return this.parseFromDom(html, prefecture, prefSlug);
  }

  // ── CSS selector DOM pass ─────────────────────────────────────────────────

  private parseFromDom(html: string, prefecture: PrefectureCode, prefSlug: string): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const properties: Property[] = [];

    // スマイティ: サイドバーの「新着物件」セクション
    // <li class="p-sidemenu-cassette__item"> 各物件カード
    const sidebarItems = Array.from(doc.querySelectorAll('.p-sidemenu-cassette__item'));

    for (const item of sidebarItems.slice(0, 20)) {
      try {
        const prop = this.sidebarItemToProperty(item, prefecture, prefSlug);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private sidebarItemToProperty(
    item: Element,
    prefecture: PrefectureCode,
    prefSlug: string,
  ): Property | null {
    // Detail URL: <a href="https://sumaity.com/mansion/used/{pref}_prop/prop_XXXXXXXX/">
    const linkEl = item.querySelector('a');
    const href = linkEl?.getAttribute('href') ?? '';
    if (!href) return null;

    const detailUrl = href.startsWith('http') ? href : `https://sumaity.com${href}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price: <span class="price">1,799</span>万円
    const priceText = item.querySelector('.p-sidemenu-cassette__cost')?.textContent?.trim() ?? '';
    const { price, priceLabel } = this.parseSmaityPrice(priceText);

    // Layout + area + age: <ul class="p-sidemenu-cassette__layout">
    // items: ["3LDK", "58.66m²", "築50年"]
    const layoutItems = Array.from(item.querySelectorAll('.p-sidemenu-cassette__layout li'));
    const rooms = layoutItems[0]?.textContent?.trim() ?? null;
    const areaText = layoutItems[1]?.textContent?.trim() ?? '';
    const area = this.extractArea(areaText);
    const ageText = layoutItems[2]?.textContent?.trim() ?? '';
    const ageMatch = ageText.match(/築(\d+)年/);
    const age = ageMatch ? parseInt(ageMatch[1]) : null;

    // Station: <ul class="p-sidemenu-cassette__station"> li
    const stationText = item.querySelector('.p-sidemenu-cassette__station li')?.textContent?.trim() ?? '';
    const { station, stationMinutes } = this.extractStation(stationText);

    // Management fee (管理費) and repair fund (修繕積立金)
    const specItems = Array.from(item.querySelectorAll('.p-sidemenu-cassette__estate-spec dd'));
    const managementFee = specItems[0] ? parseInt(specItems[0].textContent?.replace(/[^0-9]/g, '') ?? '0') || null : null;
    const repairFund = specItems[1] ? parseInt(specItems[1].textContent?.replace(/[^0-9]/g, '') ?? '0') || null : null;

    // Thumbnail: CSS background-image or data-original
    const imgDiv = item.querySelector('.p-sidemenu-cassette__image');
    const bgStyle = imgDiv?.getAttribute('style') ?? '';
    const bgMatch = bgStyle.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    const thumbnailUrl = bgMatch ? bgMatch[1] : null;
    const images = thumbnailUrl ? [thumbnailUrl] : [];

    // Build title from rooms + area (no explicit title in sidebar cards)
    const titleParts = [
      rooms,
      area ? `${area}m²` : null,
      stationText || null,
    ].filter(Boolean);
    const title = titleParts.join(' ') || `${prefecture}の中古マンション`;

    // Address/city — not directly shown in sidebar, use prefecture info
    const city = stationText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

    return this.buildBaseProperty({
      sitePropertyId,
      title,
      propertyType: 'mansion',
      prefecture,
      city,
      detailUrl,
      price,
      priceText: priceLabel || priceText,
      area,
      rooms,
      age,
      station,
      stationMinutes,
      managementFee,
      repairFund,
      thumbnailUrl,
      images,
      fingerprint,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Smaity price format: "1,799\n万円" or "1億\n5,000\n万円" */
  private parseSmaityPrice(text: string): { price: number | null; priceLabel: string } {
    const cleaned = text.replace(/[\s\n]/g, '');
    const { price, priceText } = this.extractPrice(cleaned);
    return { price, priceLabel: priceText };
  }

  /** Build a stable site_property_id from a detail URL. */
  private idFromUrl(url: string): string {
    // /mansion/used/tokyo_prop/prop_19687931/ → 19687931
    const propMatch = url.match(/prop_(\d+)/);
    if (propMatch) return propMatch[1];
    const numMatch = url.match(/\/(\d{6,})\//);
    if (numMatch) return numMatch[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }
}
