import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
  extractJsonLd,
  findJsonLdByType,
} from '../parsers/html-parser';

/**
 * REINS (Real Estate Information Network System) scraper.
 *
 * REINS (東日本不動産流通機構 / 全宅連) is a closed MLS (Multiple Listing Service)
 * operated by the Ministry of Land, Infrastructure, Transport and Tourism.
 * - Public-facing site (reins.or.jp) is informational only — no public property search.
 * - Property search requires a real estate agent login.
 * - Public API endpoint exists but only for registered agents.
 *
 * As a result, this scraper always returns an empty array.
 * The aggregator will record this as `skipped_mock` which is the expected behavior.
 *
 * If public REINS data becomes available via an official API in the future,
 * update `scrapeListings` with the appropriate endpoint and auth flow.
 */
export class ReinsScraper extends BaseScraper {
  constructor() {
    super('reins');
  }

  async scrapeListings(_ctx: ScrapeContext): Promise<Property[]> {
    // REINS does not have a public property listing page accessible without login.
    // Return empty array so the aggregator marks this as skipped_mock (no data).
    return [];
  }

  // Kept for potential future use when/if public REINS data becomes available.
  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    const jsonLdResults = this.parseFromJsonLd(html, prefecture);
    if (jsonLdResults.length > 0) return jsonLdResults;
    return this.parseFromDom(html, prefecture);
  }

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
          propertyType: partial.propertyType ?? 'mansion',
          prefecture,
          city,
          detailUrl: partial.detailUrl,
          ...partial,
          fingerprint,
        }));
      } catch { continue; }
    }
    return properties;
  }

  private jsonLdNodeToPartial(node: Record<string, unknown>): Partial<Property> & { city?: string } {
    const partial: Partial<Property> & { city?: string } = {};

    if (typeof node['name'] === 'string') partial.title = node['name'].trim();
    if (typeof node['description'] === 'string') partial.description = node['description'].trim();
    if (typeof node['url'] === 'string') partial.detailUrl = node['url'];

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

    const floorSize = node['floorSize'];
    if (floorSize && typeof floorSize === 'object' && !Array.isArray(floorSize)) {
      const fs = floorSize as Record<string, unknown>;
      const val = parseFloat(String(fs['value'] ?? ''));
      if (!isNaN(val)) partial.area = val;
    }

    const geo = node['geo'];
    if (geo && typeof geo === 'object' && !Array.isArray(geo)) {
      const g = geo as Record<string, unknown>;
      if (typeof g['latitude'] === 'number') partial.latitude = g['latitude'];
      if (typeof g['longitude'] === 'number') partial.longitude = g['longitude'];
    }

    const img = node['image'];
    if (typeof img === 'string') {
      partial.thumbnailUrl = img;
      partial.images = [img];
    } else if (Array.isArray(img) && img.length > 0) {
      partial.thumbnailUrl = String(img[0]);
      partial.images = img.slice(0, 10).map(String);
    }

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

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
    const properties: Property[] = [];

    const cardSelectors = [
      '.bukken-row',
      'tr.bukken-row',
      '.property-item',
      '[data-property-id]',
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
    const linkEl =
      card.querySelector('.property-name a') ??
      card.querySelector('.bukken-name a') ??
      card.querySelector('td.name a') ??
      card.querySelector('h2 a') ??
      card.querySelector('h3 a') ??
      card.querySelector('a[href*="/bukken/"]') ??
      card.querySelector('a[href*="/property/"]') ??
      card.querySelector('a');

    const href = linkEl?.getAttribute('href') ?? '';
    const titleText = linkEl?.textContent?.trim() ?? '';
    if (!titleText) return null;

    const detailUrl = href.startsWith('http') ? href : `https://www.reins.or.jp${href}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    const priceText = this.firstText(card, ['.price', '[class*="price"]', 'td.price']) ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceText);

    const areaText = this.firstText(card, ['.area', '[class*="area"]', 'td.area']) ?? card.textContent ?? '';
    const area = this.extractArea(areaText);

    const cardText = card.textContent ?? '';
    const rooms = cardText.match(/([1-9][LDKSR]+)/)?.[1] ?? null;
    const { station, stationMinutes } = this.extractStation(cardText);
    const age = this.extractAge(cardText);

    const addrText = this.firstText(card, ['.address', '[class*="address"]', '[class*="location"]', 'td.address']) ?? '';
    const city = (addrText || cardText).match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    const imgSrcs = Array.from(card.querySelectorAll('img'))
      .map(img => img.getAttribute('src') ?? '')
      .filter(s => s.startsWith('http') && !s.match(/(?:logo|icon|sprite|blank|pixel)/i))
      .slice(0, 10);

    const thumbnailUrl = imgSrcs[0] ?? pageOgImage ?? null;
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
