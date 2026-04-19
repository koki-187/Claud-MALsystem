import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
  extractJsonLd,
  findJsonLdByType,
} from '../parsers/html-parser';

/** Map prefecture code → AtHome prefecture slug (e.g. '13' → 'tokyo') */
const ATHOME_PREF_SLUG: Partial<Record<PrefectureCode, string>> = {
  '01': 'hokkaido',  '02': 'aomori',   '03': 'iwate',   '04': 'miyagi',
  '05': 'akita',     '06': 'yamagata', '07': 'fukushima','08': 'ibaraki',
  '09': 'tochigi',   '10': 'gunma',    '11': 'saitama',  '12': 'chiba',
  '13': 'tokyo',     '14': 'kanagawa', '15': 'niigata',  '16': 'toyama',
  '17': 'ishikawa',  '18': 'fukui',    '19': 'yamanashi','20': 'nagano',
  '21': 'gifu',      '22': 'shizuoka', '23': 'aichi',    '24': 'mie',
  '25': 'shiga',     '26': 'kyoto',    '27': 'osaka',    '28': 'hyogo',
  '29': 'nara',      '30': 'wakayama', '31': 'tottori',  '32': 'shimane',
  '33': 'okayama',   '34': 'hiroshima','35': 'yamaguchi','36': 'tokushima',
  '37': 'kagawa',    '38': 'ehime',    '39': 'kochi',    '40': 'fukuoka',
  '41': 'saga',      '42': 'nagasaki', '43': 'kumamoto', '44': 'oita',
  '45': 'miyazaki',  '46': 'kagoshima','47': 'okinawa',
};

export class AthomeScraper extends BaseScraper {
  constructor() {
    super('athome', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const page = ctx.page ?? 1;
    // AtHome 中古マンション一覧 URL — uses prefecture slug
    const slug = ATHOME_PREF_SLUG[ctx.prefecture];
    if (!slug) return [];
    const url = page > 1
      ? `https://www.athome.co.jp/mansion/chuko/${slug}/list/?page=${page}`
      : `https://www.athome.co.jp/mansion/chuko/${slug}/list/`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    return this.parseListings(html, ctx.prefecture);
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    // --- Pass 1: JSON-LD structured data (most reliable when present) ---
    const jsonLdResults = this.parseFromJsonLd(html, prefecture);
    if (jsonLdResults.length > 0) return jsonLdResults;

    // --- Pass 2: CSS selector DOM parsing ---
    return this.parseFromDom(html, prefecture);
  }

  // ── JSON-LD pass ──────────────────────────────────────────────────────────

  private parseFromJsonLd(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const items = extractJsonLd(doc);
    const nodes = findJsonLdByType(
      items,
      'RealEstateListing',
      'Product',
      'Apartment',
      'House',
      'SingleFamilyResidence',
    );
    if (nodes.length === 0) return [];

    const properties: Property[] = [];
    for (const node of nodes) {
      try {
        const partial = this.jsonLdNodeToPartial(node);
        if (!partial.title || !partial.detailUrl) continue;

        const sitePropertyId = this.idFromUrl(partial.detailUrl);
        const city = partial.city ?? this.cityFromAddress(partial.address ?? '') ?? '';
        const fingerprint = this.computeFingerprint({
          prefecture,
          city,
          price: partial.price ?? null,
          area: partial.area ?? null,
          rooms: partial.rooms ?? null,
        });

        properties.push(this.buildBaseProperty({
          sitePropertyId,
          title: partial.title,
          propertyType: 'mansion',
          prefecture,
          city,
          detailUrl: partial.detailUrl ?? null,
          ...partial,
          fingerprint,
        }));
      } catch { continue; }
    }
    return properties;
  }

  /** Convert a JSON-LD node into a partial Property. */
  private jsonLdNodeToPartial(node: Record<string, unknown>): Partial<Property> & { city?: string } {
    const partial: Partial<Property> & { city?: string } = {};

    if (typeof node['name'] === 'string') partial.title = node['name'].trim();
    if (typeof node['description'] === 'string') partial.description = node['description'].trim();
    if (typeof node['url'] === 'string') partial.detailUrl = node['url'];

    // Offer / price
    const offer = node['offers'];
    if (offer && typeof offer === 'object' && !Array.isArray(offer)) {
      const o = offer as Record<string, unknown>;
      const rawPrice = o['price'];
      if (rawPrice !== undefined) {
        const p = parseFloat(String(rawPrice));
        if (!isNaN(p)) {
          partial.price = p >= 100000 ? Math.round(p / 10000) : p;
          partial.priceText = `${partial.price.toLocaleString()}万円`;
        }
      }
    }

    // Floor size
    const floorSize = node['floorSize'];
    if (floorSize && typeof floorSize === 'object' && !Array.isArray(floorSize)) {
      const fs = floorSize as Record<string, unknown>;
      const val = parseFloat(String(fs['value'] ?? ''));
      if (!isNaN(val)) partial.area = val;
    }

    // Geo
    const geo = node['geo'];
    if (geo && typeof geo === 'object' && !Array.isArray(geo)) {
      const g = geo as Record<string, unknown>;
      if (typeof g['latitude'] === 'number') partial.latitude = g['latitude'];
      if (typeof g['longitude'] === 'number') partial.longitude = g['longitude'];
    }

    // Images
    const img = node['image'];
    if (typeof img === 'string') {
      partial.thumbnailUrl = img;
      partial.images = [img];
    } else if (Array.isArray(img) && img.length > 0) {
      partial.thumbnailUrl = String(img[0]);
      partial.images = img.slice(0, 10).map(String);
    }

    // Address
    const addr = node['address'];
    if (addr && typeof addr === 'object' && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const streetAddress = typeof a['streetAddress'] === 'string' ? a['streetAddress'] : '';
      const locality = typeof a['addressLocality'] === 'string' ? a['addressLocality'] : '';
      partial.address = [locality, streetAddress].filter(Boolean).join(' ') || null;
      partial.city = locality || undefined;
    } else if (typeof addr === 'string') {
      partial.address = addr;
      partial.city = this.cityFromAddress(addr) ?? undefined;
    }

    return partial;
  }

  // ── CSS selector DOM pass ─────────────────────────────────────────────────

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const properties: Property[] = [];

    // AtHome 一覧ページ: Angular SSR 出力
    // カードは .card-box クラスを持つ <div>
    const cardSelectors = [
      '.card-box',                   // AtHome 現行スタイル (Angular SSR)
      '.property-list-item',         // 旧スタイル
      '[data-property-id]',          // data属性ベース
      '.bukken-cassette',            // 共通スタイル
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }

    if (cards.length === 0) return [];

    for (const card of cards.slice(0, 20)) {
      try {
        const prop = this.cardToProperty(card, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private cardToProperty(card: Element, prefecture: PrefectureCode): Property | null {
    // Title & detail URL — AtHome uses .title-wrap__title-text for title, direct <a> for link
    const linkEl =
      card.querySelector('a[href*="/mansion/"]') ??
      card.querySelector('a[href*="/chuko/"]') ??
      card.querySelector('a');

    const href = linkEl?.getAttribute('href') ?? '';
    // Strip query params for clean detail URL
    const cleanHref = href.split('?')[0];
    const titleEl =
      card.querySelector('.title-wrap__title-text') ??
      card.querySelector('.property-name') ??
      card.querySelector('h2') ??
      card.querySelector('h3');
    // title-wrap__title-text may contain a <p> with price — get first text node
    const titleText = (titleEl?.firstChild?.textContent?.trim()) ||
      titleEl?.textContent?.replace(/\d+万円.*/, '').trim() || '';
    if (!titleText || !cleanHref) return null;

    const detailUrl = cleanHref.startsWith('http') ? cleanHref : `https://www.athome.co.jp${cleanHref}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price — .property-price contains "120万円" style text
    const rawPriceText = card.querySelector('.property-price')?.textContent?.trim() ?? '';
    // Extract 万円 amount (digits before 万円 span)
    const priceNumMatch = rawPriceText.match(/(\d+(?:\.\d+)?)/);
    const priceManValue = priceNumMatch ? parseFloat(priceNumMatch[1]) : null;
    const priceText2 = rawPriceText || '';
    const { price, priceText: priceLabel } = priceManValue
      ? { price: Math.round(priceManValue), priceText: `${Math.round(priceManValue)}万円` }
      : this.extractPrice(priceText2);

    // Area & Rooms — from card text content
    const cardText = card.textContent ?? '';
    const area = this.extractArea(cardText);
    const rooms = (this.firstText(card, ['.property-madori', '[class*="madori"]'])
      ?.match(/(\d[LDKS][DKSR]*)/)?.[1]) ??
      cardText.match(/(\d[LDKS][DKSR]*)/)?.[1] ?? null;

    // Station
    const { station, stationMinutes } = this.extractStation(cardText);

    // Age
    const age = this.extractAge(cardText);

    // City / address
    const city = cardText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // Images — AtHome uses real src for SSR-rendered images
    const imgSrcs = Array.from(card.querySelectorAll('img'))
      .map(img => img.getAttribute('src') ?? '')
      .map(s => s.startsWith('//') ? 'https:' + s : s)
      .filter(s => s.startsWith('http') && !s.match(/(?:logo|icon|sprite|blank|pixel)/i))
      .slice(0, 10);

    const thumbnailUrl = imgSrcs[0] ?? null;
    const managementFee = this.extractMonthlyFee(cardText, '管理費');
    const repairFund = this.extractMonthlyFee(cardText, '修繕積立金');
    const direction = this.extractDirection(cardText);
    const structure = this.extractStructure(cardText);

    const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

    return this.buildBaseProperty({
      sitePropertyId,
      title: titleText,
      propertyType: 'mansion',
      prefecture,
      city,
      detailUrl,
      price,
      priceText: priceLabel,
      area,
      rooms,
      age,
      station,
      stationMinutes,
      thumbnailUrl,
      images: imgSrcs,
      managementFee,
      repairFund,
      direction,
      structure,
      fingerprint,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private firstText(card: Element, selectors: string[]): string | null {
    for (const sel of selectors) {
      const text = card.querySelector(sel)?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  private idFromUrl(url: string): string {
    const m = url.match(/\/(\d{6,})\//);
    if (m) return m[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }

  private cityFromAddress(addr: string): string | null {
    return addr.match(/([^\s　]+[市区町村])/)?.[1] ?? null;
  }
}
