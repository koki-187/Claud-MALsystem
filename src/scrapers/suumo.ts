import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
  extractJsonLd,
  findJsonLdByType,
} from '../parsers/html-parser';

export class SuumoScraper extends BaseScraper {
  constructor() {
    super('suumo', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const page = ctx.page ?? 1;
    // SUUMO売買マンション一覧 URL
    const url =
      `https://suumo.jp/jj/bukken/ichiran/JJ010FJ001/?ar=0${ctx.prefecture}&bs=011` +
      `&ta=${ctx.prefecture}&po=0&pg=${page}`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    const properties = this.parseListings(html, ctx.prefecture);
    return properties;
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

    // SUUMO一覧ページの物件カードセレクタ候補
    // 実HTML構造に応じて順番に試みる
    const cardSelectors = [
      '.cassette_inner',          // 旧スタイル
      '.property_unit',           // 新スタイル
      '[data-object-id]',         // data属性ベース
      '.js-bukken-unit',          // JS管理型
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }

    if (cards.length === 0) return [];

    for (const card of cards.slice(0, 20)) {
      try {
        const prop = this.cardToProperty(card, html, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private cardToProperty(card: Element, _fullHtml: string, prefecture: PrefectureCode): Property | null {
    // Title & detail URL — SUUMO uses .property_unit-title a
    const linkEl =
      card.querySelector('.property_unit-title a') ??
      card.querySelector('.cassette_title a') ??
      card.querySelector('h2 a') ??
      card.querySelector('h3 a') ??
      card.querySelector('a[href*="/ms/"]') ??
      card.querySelector('a[href*="/jj/bukken/"]') ??
      card.querySelector('a');

    const href = linkEl?.getAttribute('href') ?? '';
    const titleText = linkEl?.textContent?.trim() ?? card.querySelector('.property_unit-title')?.textContent?.trim() ?? '';
    if (!titleText) return null;

    const detailUrl = href.startsWith('http') ? href : `https://suumo.jp${href}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price — SUUMO uses .dottable-value span for price
    const priceText = this.firstText(card, [
      '.dottable-value',
      '.cassette_price',
      '.property_unit-price',
    ]) ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceText);

    // Area — in .dottable-fix table (㎡ text)
    const cardText = card.textContent ?? '';
    const areaText = cardText;
    const area = this.extractArea(areaText);

    // Rooms — look for LDK pattern in card text
    const rooms = cardText.match(/(\d[LDKS][DKSR]*)/)?.[1] ?? null;

    // Station — "駅 徒歩X分" pattern
    const stationText = this.firstText(card, [
      '.dottable-line',
    ]) ?? cardText;
    const { station, stationMinutes } = this.extractStation(stationText);

    // City / address — dottable-line contains address
    const addrText = this.firstText(card, [
      '.dottable-line',
    ]) ?? '';
    const city = addrText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // Images — SUUMO uses lazy loading: real URL in `rel` attribute or `data-src`
    const imgSrcs = Array.from(card.querySelectorAll('img'))
      .map(img =>
        img.getAttribute('rel') ??
        img.getAttribute('data-src') ??
        img.getAttribute('data-original') ??
        img.getAttribute('src') ??
        ''
      )
      .map(s => {
        // SUUMO image URLs in rel may be relative paths like "gazo/bukken/..."
        if (s.startsWith('http')) return s;
        if (s.startsWith('//')) return 'https:' + s;
        if (s.startsWith('/')) return 'https://suumo.jp' + s;
        if (s.startsWith('gazo/') || s.startsWith('img/')) return 'https://img01.suumo.com/jj/resizeImage?src=' + s;
        return '';
      })
      .filter(s => s.startsWith('http') && !s.match(/(?:logo|icon|sprite|blank|pixel|data:)/i))
      .slice(0, 10);

    const thumbnailUrl = imgSrcs[0] ?? null;

    // Optional fields
    const managementFee = this.extractMonthlyFee(card.textContent ?? '', '管理費');
    const repairFund = this.extractMonthlyFee(card.textContent ?? '', '修繕積立金');
    const direction = this.extractDirection(card.textContent ?? '');
    const structure = this.extractStructure(card.textContent ?? '');

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
    // Extract numeric ID from URL path if present, else hash the URL
    const m = url.match(/\/(\d{6,})\//);
    if (m) return m[1];
    // Fallback: safe base64-ish encoding capped at 24 chars
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }

  /** Best-effort city extraction from a Japanese address string. */
  private cityFromAddress(addr: string): string | null {
    return addr.match(/([^\s　]+[市区町村])/)?.[1] ?? null;
  }
}
