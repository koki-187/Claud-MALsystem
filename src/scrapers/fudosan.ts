import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import { parseDocument } from '../parsers/html-parser';

/** 都道府県コード → realestate.co.jp の URL 数値コード (1〜47) */
const REALESTATE_PREF_CODE: Record<string, string> = {
  '01':'1','02':'2','03':'3','04':'4','05':'5','06':'6','07':'7','08':'8','09':'9',
  '10':'10','11':'11','12':'12','13':'13','14':'14','15':'15','16':'16','17':'17',
  '18':'18','19':'19','20':'20','21':'21','22':'22','23':'23','24':'24','25':'25',
  '26':'26','27':'27','28':'28','29':'29','30':'30','31':'31','32':'32','33':'33',
  '34':'34','35':'35','36':'36','37':'37','38':'38','39':'39','40':'40','41':'41',
  '42':'42','43':'43','44':'44','45':'45','46':'46','47':'47',
};

export class FudosanScraper extends BaseScraper {
  constructor() {
    super('fudosan');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const prefCode = REALESTATE_PREF_CODE[ctx.prefecture];
    if (!prefCode) return [];
    const page = ctx.page ?? 1;

    // 不動産ジャパン 中古マンション一覧
    const url = page === 1
      ? `https://www.realestate.co.jp/mansion/prefecture/${prefCode}/buy/list/`
      : `https://www.realestate.co.jp/mansion/prefecture/${prefCode}/buy/list/?p=${page}`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    return this.parseListings(html, ctx.prefecture);
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    // Pass 1: __NEXT_DATA__ JSON (Next.js SSR)
    const nextData = this.parseFromNextData(html, prefecture);
    if (nextData.length > 0) return nextData;

    // Pass 2: DOM selector fallback
    return this.parseFromDom(html, prefecture);
  }

  private parseFromNextData(html: string, prefecture: PrefectureCode): Property[] {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
    if (!m) return [];
    try {
      const json = JSON.parse(m[1]);
      const items: unknown[] =
        json?.props?.pageProps?.properties ??
        json?.props?.pageProps?.mansions ??
        json?.props?.pageProps?.bukkenList ??
        json?.props?.pageProps?.list ?? [];
      if (!Array.isArray(items) || items.length === 0) return [];

      return items.slice(0, 50).flatMap(item => {
        try { return [this.nextItemToProperty(item as Record<string, unknown>, prefecture)]; }
        catch { return []; }
      }).filter((p): p is Property => p !== null);
    } catch { return []; }
  }

  private nextItemToProperty(item: Record<string, unknown>, prefecture: PrefectureCode): Property | null {
    const title = String(item['name'] ?? item['title'] ?? item['bukkenName'] ?? '').trim();
    const detailUrl = String(item['url'] ?? item['detailUrl'] ?? item['link'] ?? '');
    if (!title || !detailUrl) return null;

    const sitePropertyId = this.idFromUrl(detailUrl);
    const rawPrice = item['price'] ?? (item['offers'] as Record<string,unknown>)?.['price'];
    const { price, priceText } = this.extractPrice(String(rawPrice ?? ''));
    const area = parseFloat(String(item['area'] ?? item['floorSize'] ?? '')) || null;
    const rooms = String(item['madori'] ?? item['rooms'] ?? '').match(/[1-9][LDKS][DKSR]*/)?.[0] ?? null;
    const addrRaw = String(item['address'] ?? item['location'] ?? '');
    const city = addrRaw.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
    const img = String(item['image'] ?? item['thumbnail'] ?? item['mainImg'] ?? '');
    const thumbnailUrl = img.startsWith('http') ? img : null;
    const age = this.extractAge(String(item['age'] ?? item['築年数'] ?? ''));
    const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

    return this.buildBaseProperty({
      sitePropertyId, title, propertyType: 'mansion', prefecture, city,
      detailUrl: detailUrl.startsWith('http') ? detailUrl : `https://www.realestate.co.jp${detailUrl}`,
      price, priceText, area, rooms, age, thumbnailUrl,
      images: thumbnailUrl ? [thumbnailUrl] : [], fingerprint,
    });
  }

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];
    const properties: Property[] = [];

    // realestate.co.jp の物件カードセレクタ候補
    const cardSelectors = [
      '.bukken-cassette',
      '.property-card',
      '.property-item',
      '[class*="PropertyCard"]',
      '[class*="BukkenCard"]',
      'article[data-id]',
      '.search-result-item',
      'li.cassette',
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }
    if (cards.length === 0) return [];

    for (const card of cards.slice(0, 50)) {
      try {
        const linkEl = card.querySelector('a[href*="/mansion/"]') ?? card.querySelector('a');
        const href = linkEl?.getAttribute('href') ?? '';
        if (!href) continue;
        const detailUrl = href.startsWith('http') ? href : `https://www.realestate.co.jp${href}`;
        const titleText = linkEl?.textContent?.trim() ??
          card.querySelector('h2,h3,[class*="title"],[class*="name"]')?.textContent?.trim() ?? '';
        if (!titleText) continue;

        const sitePropertyId = this.idFromUrl(detailUrl);
        const cardText = card.textContent ?? '';
        const priceRaw = card.querySelector('[class*="price"],[class*="Price"]')?.textContent?.trim() ?? '';
        const { price, priceText } = this.extractPrice(priceRaw || cardText);
        const area = this.extractArea(cardText);
        const rooms = cardText.match(/([1-9][LDKS][DKSR]*)/)?.[1] ?? null;
        const { station, stationMinutes } = this.extractStation(cardText);
        const age = this.extractAge(cardText);
        const city = cardText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const imgEl = card.querySelector('img');
        const thumbnailUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? null;
        const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

        properties.push(this.buildBaseProperty({
          sitePropertyId, title: titleText, propertyType: 'mansion', prefecture, city, detailUrl,
          price, priceText, area, rooms, age, station, stationMinutes,
          thumbnailUrl, images: thumbnailUrl ? [thumbnailUrl] : [], fingerprint,
        }));
      } catch { continue; }
    }
    return properties;
  }

  private idFromUrl(url: string): string {
    const m = url.match(/\/(\d{6,})\//);
    if (m) return m[1];
    const slug = url.replace(/https?:\/\/[^/]+/, '').replace(/[^a-z0-9]/gi, '-').slice(-24);
    return slug || btoa(encodeURIComponent(url)).slice(0, 24);
  }
}
