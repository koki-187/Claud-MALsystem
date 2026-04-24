import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
  extractJsonLd,
  findJsonLdByType,
} from '../parsers/html-parser';

/** Map prefecture code → CHINTAI prefecture slug */
const CHINTAI_PREF_SLUG: Partial<Record<PrefectureCode, string>> = {
  '01': 'hokkaido',   '02': 'aomori',    '03': 'iwate',    '04': 'miyagi',
  '05': 'akita',      '06': 'yamagata',  '07': 'fukushima','08': 'ibaraki',
  '09': 'tochigi',    '10': 'gunma',     '11': 'saitama',  '12': 'chiba',
  '13': 'tokyo',      '14': 'kanagawa',  '15': 'niigata',  '16': 'toyama',
  '17': 'ishikawa',   '18': 'fukui',     '19': 'yamanashi','20': 'nagano',
  '21': 'gifu',       '22': 'shizuoka',  '23': 'aichi',    '24': 'mie',
  '25': 'shiga',      '26': 'kyoto',     '27': 'osaka',    '28': 'hyogo',
  '29': 'nara',       '30': 'wakayama',  '31': 'tottori',  '32': 'shimane',
  '33': 'okayama',    '34': 'hiroshima', '35': 'yamaguchi','36': 'tokushima',
  '37': 'kagawa',     '38': 'ehime',     '39': 'kochi',    '40': 'fukuoka',
  '41': 'saga',       '42': 'nagasaki',  '43': 'kumamoto', '44': 'oita',
  '45': 'miyazaki',   '46': 'kagoshima', '47': 'okinawa',
};

export class ChintaiScraper extends BaseScraper {
  constructor() {
    super('chintai', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const slug = CHINTAI_PREF_SLUG[ctx.prefecture];
    if (!slug) return [];
    const areaCode = `${ctx.prefecture}101`;
    const maxPages = 3;
    const all: Property[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = page > 1
        ? `https://www.chintai.net/${slug}/area/${areaCode}/list/?page=${page}`
        : `https://www.chintai.net/${slug}/area/${areaCode}/list/`;
      const html = await this.fetchHtml(url);
      if (!html) break;
      const batch = this.parseListings(html, ctx.prefecture);
      all.push(...batch);
      if (batch.length < 5) break;
      if (page < maxPages) await this.sleep(1500);
    }
    return all;
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
      'Apartment',
      'Product',
      'House',
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
          propertyType: 'chintai_mansion',
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

    // Offer / price — CHINTAI stores monthly rent
    const offer = node['offers'];
    if (offer && typeof offer === 'object' && !Array.isArray(offer)) {
      const o = offer as Record<string, unknown>;
      const rawPrice = o['price'];
      if (rawPrice !== undefined) {
        const p = parseFloat(String(rawPrice));
        if (!isNaN(p)) {
          // Monthly rent in JPY → 万円 if >= 10000, else treat as 万円 already
          partial.price = p >= 10000 ? Math.round(p / 10000) : Math.round(p);
          partial.priceText = `家賃${partial.price.toLocaleString()}万円/月`;
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

    // CHINTAI 一覧ページ: .cassette_item.build が各建物カード
    // DOM: <div class="cassette_item build"> → .cassette_ttl h2 / .cassette_inner / .cassette_detail
    const cardSelectors = [
      '.cassette_item',              // CHINTAI現行 (build / item_pr クラスが付く)
      '.l_cassette',                 // 別スタイルのカード包括
      '.property-cassette',          // フォールバック旧スタイル
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }

    if (cards.length === 0) return [];

    for (const card of cards.slice(0, 50)) {
      try {
        const prop = this.cardToProperty(card, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private cardToProperty(card: Element, prefecture: PrefectureCode): Property | null {
    // Title — .cassette_ttl h2 (inner span の型バッジを除いたテキスト)
    const titleH2 = card.querySelector('.cassette_ttl h2') ?? card.querySelector('h2');
    // Remove type badge spans and get text
    const titleText = titleH2
      ? (Array.from(titleH2.childNodes)
          .filter(n => n.nodeType === 3)  // text nodes only
          .map(n => n.textContent?.trim())
          .filter(Boolean)
          .join(' ')
          .trim()
        || (titleH2.textContent?.replace(/\s+/g, ' ').trim() ?? ''))
      : '';
    if (!titleText) return null;

    // Detail URL — from data-detailurl on tbody, or fallback to direct link
    const detailurlEl = card.querySelector('[data-detailurl]');
    const detailPath = detailurlEl?.getAttribute('data-detailurl') ??
      card.querySelector('a[href*="/detail/"]')?.getAttribute('href') ?? '';
    if (!detailPath) return null;
    const detailUrl = detailPath.startsWith('http') ? detailPath : `https://www.chintai.net${detailPath}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Rent — CHINTAI shows "27.2万円 18,000円" in td.price
    const priceTd = card.querySelector('td.price');
    const priceTdText = priceTd?.textContent?.trim() ?? '';
    // Extract first 万円 value (monthly rent)
    const rentManMatch = priceTdText.match(/(\d+(?:\.\d+)?)\s*万円/);
    const rent = rentManMatch ? Math.round(parseFloat(rentManMatch[1]) * 10) / 10 : null;
    const rentInt = rent !== null ? Math.round(rent) : null;
    const priceText = rentInt ? `家賃${rent}万円/月` : '要問合せ';

    // Area & Rooms — from td.layout "2DK / 35.82㎡"
    const layoutTd = card.querySelector('td.layout') ?? card.querySelector('.layout');
    const layoutText = layoutTd?.textContent?.trim() ?? card.textContent ?? '';
    const area = this.extractArea(layoutText);
    const rooms = layoutText.match(/([1-9][LDKS][DKSR]*)/)?.[1] ?? null;

    // Station
    const trafficEl = card.querySelector('td.traffic') ?? card.querySelector('.traffic');
    const { station, stationMinutes } = this.extractStation(trafficEl?.textContent ?? card.textContent ?? '');

    // Age
    const age = this.extractAge(card.textContent ?? '');

    // City / address
    const addressTd = card.querySelector('td');
    const city = (addressTd?.textContent ?? card.textContent ?? '').match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // Images — CHINTAI uses lazy loading: data-original="//img.chintai.net/..."
    const imgSrcs = Array.from(card.querySelectorAll('img'))
      .map(img =>
        img.getAttribute('data-original') ??
        img.getAttribute('data-src') ??
        img.getAttribute('src') ??
        ''
      )
      .map(s => s.startsWith('//') ? 'https:' + s : s)
      .filter(s => s.startsWith('http') && !s.match(/(?:logo|icon|sprite|blank|pixel|data:)/i))
      .slice(0, 10);

    const thumbnailUrl = imgSrcs[0] ?? null;

    const cardText = card.textContent ?? '';
    const managementFee = this.extractMonthlyFee(cardText, '管理費');
    const direction = this.extractDirection(cardText);
    const structure = this.extractStructure(cardText);

    const fingerprint = this.computeFingerprint({ prefecture, city, price: rentInt, area, rooms });

    return this.buildBaseProperty({
      sitePropertyId,
      title: titleText,
      propertyType: 'chintai_mansion',
      prefecture,
      city,
      detailUrl,
      price: rentInt,
      priceText,
      area,
      rooms,
      age,
      station,
      stationMinutes,
      thumbnailUrl,
      images: imgSrcs,
      managementFee,
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
    // CHINTAI detail URLs: /detail/bk-{alphanumeric}/
    const bk = url.match(/\/bk-([A-Za-z0-9]+)\//);
    if (bk) return bk[1].slice(-24); // up to 24 chars
    // Generic numeric ID fallback
    const m = url.match(/\/(\d{6,})\//);
    if (m) return m[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }

  private cityFromAddress(addr: string): string | null {
    return addr.match(/([^\s　]+[市区町村])/)?.[1] ?? null;
  }
}
