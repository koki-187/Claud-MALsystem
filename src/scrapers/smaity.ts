import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import { parseDocument } from '../parsers/html-parser';

const SMAITY_PREF_SLUGS: Record<string, string> = {
  '01':'hokkaido','02':'aomori','03':'iwate','04':'miyagi','05':'akita',
  '06':'yamagata','07':'fukushima','08':'ibaraki','09':'tochigi','10':'gunma',
  '11':'saitama','12':'chiba','13':'tokyo','14':'kanagawa','15':'niigata',
  '16':'toyama','17':'ishikawa','18':'fukui','19':'yamanashi','20':'nagano',
  '21':'gifu','22':'shizuoka','23':'aichi','24':'mie','25':'shiga',
  '26':'kyoto','27':'osaka','28':'hyogo','29':'nara','30':'wakayama',
  '31':'tottori','32':'shimane','33':'okayama','34':'hiroshima','35':'yamaguchi',
  '36':'tokushima','37':'kagawa','38':'ehime','39':'kochi','40':'fukuoka',
  '41':'saga','42':'nagasaki','43':'kumamoto','44':'oita','45':'miyazaki',
  '46':'kagoshima','47':'okinawa',
};

export class SmaityScraper extends BaseScraper {
  constructor() {
    super('smaity');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const slug = SMAITY_PREF_SLUGS[ctx.prefecture];
    if (!slug) return [];
    const page = ctx.page ?? 1;

    // スマイティ 中古マンション一覧 (SSR Next.js)
    const url = page === 1
      ? `https://sumaity.com/mansion/used/${slug}/`
      : `https://sumaity.com/mansion/used/${slug}/?page=${page}`;

    const html = await this.fetchHtml(url);
    if (!html) return [];

    // Pass 1: __NEXT_DATA__ JSON (メインデータ)
    const nextData = this.parseFromNextData(html, ctx.prefecture);
    if (nextData.length > 0) return nextData;

    // Pass 2: JSON-LD fallback
    const jsonLd = this.parseFromJsonLd(html, ctx.prefecture);
    if (jsonLd.length > 0) return jsonLd;

    // Pass 3: DOM selector fallback (複数セレクタ試行)
    return this.parseFromDom(html, ctx.prefecture);
  }

  private parseFromNextData(html: string, prefecture: PrefectureCode): Property[] {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!m) return [];
    try {
      const json = JSON.parse(m[1]);
      // sumaity.com の pageProps 構造を複数パス探索
      const pageProps = json?.props?.pageProps ?? {};
      const items: unknown[] =
        pageProps?.mansions ??
        pageProps?.properties ??
        pageProps?.bukkenList ??
        pageProps?.searchResult?.mansions ??
        pageProps?.searchResult?.items ??
        pageProps?.data?.mansions ?? [];

      if (!Array.isArray(items) || items.length === 0) return [];

      return items.slice(0, 50).flatMap(item => {
        try { return [this.nextItemToProperty(item as Record<string, unknown>, prefecture)]; }
        catch { return []; }
      }).filter((p): p is Property => p !== null);
    } catch { return []; }
  }

  private nextItemToProperty(item: Record<string, unknown>, prefecture: PrefectureCode): Property | null {
    // sumaity.com の物件オブジェクト構造
    const name = String(item['name'] ?? item['bukkenName'] ?? item['title'] ?? '').trim();
    const urlPath = String(item['url'] ?? item['detailUrl'] ?? item['path'] ?? '');
    if (!name && !urlPath) return null;

    const detailUrl = urlPath.startsWith('http') ? urlPath : `https://sumaity.com${urlPath}`;
    const sitePropertyId = this.idFromUrl(detailUrl);
    const title = name || `${prefecture}の中古マンション`;

    const rawPrice = item['price'] ?? item['kakaku'] ?? '';
    const { price, priceText } = this.extractPrice(String(rawPrice));
    const area = parseFloat(String(item['area'] ?? item['menseki'] ?? '')) || null;
    const rooms = String(item['madori'] ?? item['layout'] ?? '').match(/[1-9][LDKS][DKSR]*/)?.[0] ?? null;
    const age = typeof item['age'] === 'number' ? item['age'] as number
      : this.extractAge(String(item['chikunensuu'] ?? item['age'] ?? ''));
    const addrRaw = String(item['address'] ?? item['jusho'] ?? item['location'] ?? '');
    const city = addrRaw.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
    const img = String(item['image'] ?? item['mainImage'] ?? item['thumbnail'] ?? '');
    const thumbnailUrl = img.startsWith('http') ? img : null;
    const stationRaw = String(item['traffic'] ?? item['access'] ?? item['station'] ?? '');
    const { station, stationMinutes } = this.extractStation(stationRaw);
    const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });

    return this.buildBaseProperty({
      sitePropertyId, title, propertyType: 'mansion', prefecture, city,
      detailUrl, price, priceText, area, rooms, age, station, stationMinutes,
      thumbnailUrl, images: thumbnailUrl ? [thumbnailUrl] : [], fingerprint,
      address: addrRaw || null,
    });
  }

  private parseFromJsonLd(html: string, prefecture: PrefectureCode): Property[] {
    const matches = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
    const props: Property[] = [];
    for (const match of matches) {
      try {
        const json = JSON.parse(match[1]);
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item?.name || !item?.url) continue;
          const { price, priceText } = this.extractPrice(String(item?.offers?.price ?? ''));
          const area = parseFloat(String(item?.floorSize?.value ?? '')) || null;
          const sitePropertyId = this.idFromUrl(item.url);
          const city = String(item?.address?.addressLocality ?? '');
          const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms: null });
          props.push(this.buildBaseProperty({
            sitePropertyId, title: item.name, propertyType: 'mansion', prefecture, city,
            detailUrl: item.url, price, priceText, area, rooms: null,
            thumbnailUrl: typeof item.image === 'string' ? item.image : null, fingerprint,
          }));
        }
      } catch { continue; }
    }
    return props;
  }

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];
    const properties: Property[] = [];
    const cardSelectors = [
      '.p-cassette', '.cassette-item', '.property-cassette',
      '.p-sidemenu-cassette__item', '[class*="cassette"]',
      '.mansion-item', '[class*="MansionCard"]', 'article.item',
      'li.property', '.search-result li',
    ];
    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(doc.querySelectorAll(sel));
      if (found.length >= 3) { cards = found; break; }
    }
    if (cards.length === 0) return [];
    for (const card of cards.slice(0, 50)) {
      try {
        const linkEl = card.querySelector('a') as HTMLAnchorElement | null;
        const href = linkEl?.getAttribute('href') ?? '';
        if (!href) continue;
        const detailUrl = href.startsWith('http') ? href : `https://sumaity.com${href}`;
        const sitePropertyId = this.idFromUrl(detailUrl);
        const cardText = card.textContent ?? '';
        const title = card.querySelector('h2,h3,[class*="title"],[class*="name"]')?.textContent?.trim()
          ?? cardText.slice(0, 40).trim();
        if (!title) continue;
        const { price, priceText } = this.extractPrice(cardText);
        const area = this.extractArea(cardText);
        const rooms = cardText.match(/([1-9][LDKS][DKSR]*)/)?.[1] ?? null;
        const { station, stationMinutes } = this.extractStation(cardText);
        const age = this.extractAge(cardText);
        const city = cardText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
        const imgEl = card.querySelector('img');
        const thumbnailUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? null;
        const fingerprint = this.computeFingerprint({ prefecture, city, price, area, rooms });
        properties.push(this.buildBaseProperty({
          sitePropertyId, title, propertyType: 'mansion', prefecture, city,
          detailUrl, price, priceText, area, rooms, age, station, stationMinutes,
          thumbnailUrl, images: thumbnailUrl ? [thumbnailUrl] : [], fingerprint,
        }));
      } catch { continue; }
    }
    return properties;
  }

  private idFromUrl(url: string): string {
    const prop = url.match(/prop_(\d+)/);
    if (prop) return prop[1];
    const num = url.match(/\/(\d{6,})\//);
    if (num) return num[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }
}
