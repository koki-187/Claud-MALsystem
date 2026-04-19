import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
  extractJsonLd,
  findJsonLdByType,
} from '../parsers/html-parser';

export class HomesScraper extends BaseScraper {
  constructor() {
    super('homes');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const page = ctx.page ?? 1;
    // HOME'S 中古マンション一覧 URL
    const url =
      `https://www.homes.co.jp/mansion/chuko/list/?pref=${ctx.prefecture}&page=${page}`;

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

    // Images — og:image takes priority if present in the node directly
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

    // og:image for thumbnail fallback (page-level)
    const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;

    const properties: Property[] = [];

    // HOME'S 一覧ページの物件カードセレクタ候補
    const cardSelectors = [
      '.mod-mergeBuilding--sale',   // 売買マンションカード
      '.mod-mergeBuilding',         // 汎用マージビルカード
      '.bukken-cassette',           // 旧スタイル
      '[data-building-id]',         // data属性ベース
      '.iListing__item',            // リストアイテム
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }

    if (cards.length === 0) return [];

    for (const card of cards.slice(0, 20)) {
      try {
        const prop = this.cardToProperty(card, ogImage, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private cardToProperty(
    card: Element,
    pageOgImage: string | null,
    prefecture: PrefectureCode,
  ): Property | null {
    // Title & detail URL
    const linkEl =
      card.querySelector('.bukkenName a') ??
      card.querySelector('.mod-mergeBuilding__name a') ??
      card.querySelector('h2 a') ??
      card.querySelector('h3 a') ??
      card.querySelector('a[href*="/mansion/"]') ??
      card.querySelector('a');

    const href = linkEl?.getAttribute('href') ?? '';
    const titleText =
      linkEl?.textContent?.trim() ??
      card.querySelector('.bukkenName')?.textContent?.trim() ??
      card.querySelector('[class*="name"]')?.textContent?.trim() ?? '';
    if (!titleText) return null;

    const detailUrl = href.startsWith('http') ? href : `https://www.homes.co.jp${href}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price
    const priceText = this.firstText(card, [
      '.priceLabel',
      '.mod-mergeBuilding__price',
      '[class*="price"]',
      '.bukken-price',
    ]) ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceText);

    // Area
    const areaText = this.firstText(card, [
      '.specArea',
      '[class*="area"]',
      '.bukken-spec',
    ]) ?? '';
    const area = this.extractArea(areaText);

    // Rooms
    const roomsText = this.firstText(card, [
      '.specMadori',
      '[class*="madori"]',
      '[class*="rooms"]',
      '[class*="layout"]',
    ]) ?? '';
    const rooms = roomsText.match(/(\d[LDKS1-9][DKSR]*)/)?.[1] ?? null;

    // Station
    const stationText = this.firstText(card, [
      '.specStation',
      '[class*="station"]',
      '[class*="route"]',
      '[class*="traffic"]',
    ]) ?? card.textContent ?? '';
    const { station, stationMinutes } = this.extractStation(stationText);

    // Age
    const ageText = card.textContent ?? '';
    const age = this.extractAge(ageText);

    // City / address
    const addrText = this.firstText(card, [
      '.specAddress',
      '[class*="address"]',
      '[class*="location"]',
    ]) ?? '';
    const city = addrText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // Images — collect img[src] within card, fall back to og:image
    const imgSrcs = Array.from(card.querySelectorAll('img'))
      .map(img => img.getAttribute('src') ?? '')
      .filter(s => s.startsWith('http') && !s.match(/(?:logo|icon|sprite|blank|pixel)/i))
      .slice(0, 10);

    const thumbnailUrl = imgSrcs[0] ?? pageOgImage ?? null;

    // Optional fields
    const cardText = card.textContent ?? '';
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
      priceText: priceLabel || priceText,
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

  /** Return text content of the first matching selector in a card element. */
  private firstText(card: Element, selectors: string[]): string | null {
    for (const sel of selectors) {
      const text = card.querySelector(sel)?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  /** Build a stable site_property_id from a detail URL. */
  private idFromUrl(url: string): string {
    const m = url.match(/\/(\d{6,})\//);
    if (m) return m[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }

  /** Best-effort city extraction from a Japanese address string. */
  private cityFromAddress(addr: string): string | null {
    return addr.match(/([^\s　]+[市区町村])/)?.[1] ?? null;
  }
}
