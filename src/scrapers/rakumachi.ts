import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
} from '../parsers/html-parser';

export class RakumachiScraper extends BaseScraper {
  constructor() {
    super('rakumachi');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const page = ctx.page ?? 1;
    const prefNum = parseInt(ctx.prefecture);
    // 楽待 収益物件一覧 URL
    const url = `https://www.rakumachi.jp/syuuekibukken/area/?pref_code=${prefNum}&page=${page}&sort=property_created_at&sort_type=desc`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    return this.parseListings(html, ctx.prefecture);
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    return this.parseFromDom(html, prefecture);
  }

  // ── CSS selector DOM pass ─────────────────────────────────────────────────

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const properties: Property[] = [];

    // 楽待: <div class="propertyBlock"> が各物件カード
    const cards = Array.from(doc.querySelectorAll('.propertyBlock'));
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
    // Detail URL: <a href="/syuuekibukken/.../XXXXXXX/show.html" class="propertyBlock__content">
    // or ad items use onclick (skip those)
    const linkEl =
      card.querySelector('a.propertyBlock__content[href*="/syuuekibukken/"]') ??
      card.querySelector('a[href*="/syuuekibukken/"]');

    const href = linkEl?.getAttribute('href') ?? '';
    if (!href) return null; // skip ad cards without real links

    const detailUrl = href.startsWith('http') ? href : `https://www.rakumachi.jp${href}`;
    const sitePropertyId = this.idFromUrl(detailUrl);

    // Title: .propertyBlock__name
    const titleText = card.querySelector('.propertyBlock__name')?.textContent?.trim() ?? '';
    if (!titleText) return null;

    // Property type dimension: .propertyBlock__dimension → "1棟マンション" etc.
    // (informational only, not stored separately)

    // Price: <b class="price">1億2000万円</b>
    const priceRaw = card.querySelector('b.price')?.textContent?.trim() ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceRaw);

    // Yield rate: <b class="gross">6.48%</b>
    const grossText = card.querySelector('b.gross')?.textContent?.trim() ?? '';
    const yieldRate = this.extractYieldRate(grossText);

    // Address: <span class="propertyBlock__address">
    const addrText = card.querySelector('.propertyBlock__address')?.textContent?.trim() ?? '';
    const city = addrText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';

    // Station/access: <span class="propertyBlock__access">
    const accessText = card.querySelector('.propertyBlock__access')?.textContent?.trim() ?? '';
    const { station, stationMinutes } = this.extractStation(accessText);

    // Full content text for age/structure extraction
    const cardText = card.textContent ?? '';
    const age = this.extractAge(cardText);
    const structure = this.extractStructure(cardText);

    // Area: "建物141.38㎡ / 土地 149.75㎡" or "建物312.63㎡"
    const areaMatch = cardText.match(/建物\s*([0-9.]+)\s*(?:m²|㎡|m&sup2;)/);
    const area = areaMatch ? parseFloat(areaMatch[1]) : this.extractArea(cardText);

    // Land area
    const landMatch = cardText.match(/土地\s*([0-9.]+)\s*(?:m²|㎡|m&sup2;)/);
    const landArea = landMatch ? parseFloat(landMatch[1]) : null;

    // Image: data-original attribute on lazy-loaded img
    const imgEl = card.querySelector('img[data-original]') ?? card.querySelector('img');
    const thumbnailUrl = imgEl?.getAttribute('data-original') ?? imgEl?.getAttribute('src') ?? null;
    // Filter out placeholder loading.gif
    const cleanThumbnail = thumbnailUrl && !thumbnailUrl.includes('loading.gif') ? thumbnailUrl : null;
    const images = cleanThumbnail ? [cleanThumbnail] : [];

    const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms: null });

    return this.buildBaseProperty({
      sitePropertyId,
      title: titleText,
      propertyType: 'investment',
      prefecture,
      city,
      address: addrText || null,
      detailUrl,
      price,
      priceText: priceLabel || priceRaw || '価格要相談',
      area,
      landArea,
      rooms: null,
      age,
      station,
      stationMinutes,
      yieldRate,
      thumbnailUrl: cleanThumbnail,
      images,
      structure,
      fingerprint,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** 利回り抽出: "6.48%" / "10.1%" patterns from b.gross */
  protected extractYieldRate(text: string): number | null {
    const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[%％]/) ??
              text.match(/利回り[\s:：]*([0-9]+(?:\.[0-9]+)?)/);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val) && val > 0 && val < 50) return val;
    }
    return null;
  }

  /** Build a stable site_property_id from a detail URL. */
  private idFromUrl(url: string): string {
    // /syuuekibukken/kanto/chiba/dim1003/3601042/show.html → 3601042
    const m = url.match(/\/(\d{5,})\/show\.html/) ??
              url.match(/\/(\d{5,})\//);
    if (m) return m[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }
}
