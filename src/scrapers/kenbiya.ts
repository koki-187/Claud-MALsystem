import { BaseScraper } from './base';
import type { Property, PrefectureCode } from '../types';
import type { ScrapeContext } from './base';
import {
  parseDocument,
} from '../parsers/html-parser';

// 健美家 prefecture code → URL slug mapping
// Region prefix: s=首都圏, k=関西, t=東海, f=九州, m=東北, o=中国四国, z=信越北陸, h=北海道
const KENBIYA_PREF_SLUGS: Record<string, string> = {
  '01': 'h/hokkaido',
  '02': 'm/aomori',
  '03': 'm/iwate',
  '04': 'm/miyagi',
  '05': 'm/akita',
  '06': 'm/yamagata',
  '07': 'm/fukushima',
  '08': 's/ibaraki',
  '09': 's/tochigi',
  '10': 's/gunma',
  '11': 's/saitama',
  '12': 's/chiba',
  '13': 's/tokyo',
  '14': 's/kanagawa',
  '15': 'z/niigata',
  '16': 'z/toyama',
  '17': 'z/ishikawa',
  '18': 'z/fukui',
  '19': 's/yamanashi',
  '20': 'z/nagano',
  '21': 't/gifu',
  '22': 't/shizuoka',
  '23': 't/aichi',
  '24': 't/mie',
  '25': 'k/shiga',
  '26': 'k/kyoto',
  '27': 'k/osaka',
  '28': 'k/hyogo',
  '29': 'k/nara',
  '30': 'k/wakayama',
  '31': 'o/tottori',
  '32': 'o/shimane',
  '33': 'o/okayama',
  '34': 'o/hiroshima',
  '35': 'o/yamaguchi',
  '36': 'o/tokushima',
  '37': 'o/kagawa',
  '38': 'o/ehime',
  '39': 'o/kochi',
  '40': 'f/fukuoka',
  '41': 'f/saga',
  '42': 'f/nagasaki',
  '43': 'f/kumamoto',
  '44': 'f/oita',
  '45': 'f/miyazaki',
  '46': 'f/kagoshima',
  '47': 'f/okinawa',
};

export class KenbiyaScraper extends BaseScraper {
  constructor() {
    super('kenbiya');
  }

  async scrapeListings(ctx: ScrapeContext): Promise<Property[]> {
    const slug = KENBIYA_PREF_SLUGS[ctx.prefecture];
    if (!slug) return [];
    const maxPages = 3;
    const all: Property[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1
        ? `https://www.kenbiya.com/pp0/${slug}/`
        : `https://www.kenbiya.com/pp0/${slug}/n-${page}/`;
      const html = await this.fetchHtml(url);
      if (!html) break;
      const batch = this.parseListings(html, ctx.prefecture);
      all.push(...batch);
      if (batch.length < 3) break;
      if (page < maxPages) await this.sleep(1500);
    }
    return all;
  }

  private parseListings(html: string, prefecture: PrefectureCode): Property[] {
    return this.parseFromDom(html, prefecture);
  }

  // ── CSS selector DOM pass ─────────────────────────────────────────────────

  private parseFromDom(html: string, prefecture: PrefectureCode): Property[] {
    const doc = parseDocument(html);
    if (!doc) return [];

    const properties: Property[] = [];

    // 健美家 一覧ページ: <div class="box_table_main"> の中の <li><a href=...><ul class="prop_block">
    // 各物件は <li> で囲まれた <a> タグ内の <ul class="prop_block"> 構造
    const tableMain = doc.querySelector('.box_table_main');
    if (!tableMain) return [];

    // li要素のうち thead でないもの (物件行)
    const listItems = Array.from(tableMain.querySelectorAll('li:not(.thead)'));
    if (listItems.length === 0) return [];

    for (const li of listItems.slice(0, 50)) {
      try {
        const prop = this.liToProperty(li, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    // Also parse PR items from .md-propertyListPr
    const prItems = Array.from(doc.querySelectorAll('.md-propertyListPr .item'));
    for (const item of prItems.slice(0, 10)) {
      try {
        const prop = this.prItemToProperty(item, prefecture);
        if (prop) properties.push(prop);
      } catch { continue; }
    }

    return properties;
  }

  private liToProperty(li: Element, prefecture: PrefectureCode): Property | null {
    // The <li> contains an <a href="/pp1/..."> wrapping a <ul class="prop_block">
    const linkEl = li.querySelector('a[href*="/pp1/"]') ?? li.querySelector('a');
    if (!linkEl) return null;

    const href = linkEl.getAttribute('href') ?? '';
    const detailUrl = href.startsWith('http') ? href : `https://www.kenbiya.com${href}`;

    // Title: h3 inside .main li
    const titleEl = li.querySelector('.main h3') ?? li.querySelector('h3');
    const titleText = titleEl?.textContent?.trim() ?? '';
    if (!titleText) return null;

    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price: .price li span → "8,480万円" or "1億6,100万円"
    const priceRaw = li.querySelector('.price ul li:first-child')?.textContent?.trim() ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceRaw);

    // Yield rate: .price li:nth-child(2) → "2.69％"
    const yieldText = li.querySelector('.price ul li:nth-child(2)')?.textContent?.trim() ?? '';
    const yieldRate = this.extractYieldRate(yieldText);

    // Address + station: .main li:nth-child(2) and li:nth-child(3)
    const mainItems = Array.from(li.querySelectorAll('.main ul li'));
    const addrText = mainItems[1]?.textContent?.trim() ?? '';
    const stationText = mainItems[2]?.textContent?.trim() ?? '';

    const city = addrText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
    const { station, stationMinutes } = this.extractStation(stationText);

    // Area: 4th column li — "専:52.27m²" or "建:141.38m²"
    const areaText = li.querySelectorAll('li')[3]?.textContent?.trim() ?? '';
    const area = this.extractArea(areaText);

    // Age: 5th column li — "2003年7月"
    const ageColItems = Array.from(li.querySelectorAll('li:last-child ul li'));
    const dateText = ageColItems[0]?.textContent?.trim() ?? '';
    const yearMatch = dateText.match(/(\d{4})年/);
    const age = yearMatch ? new Date().getFullYear() - parseInt(yearMatch[1]) : null;

    // Floors: "3階/6階建"
    const floorText = ageColItems[1]?.textContent?.trim() ?? '';
    const floorMatch = floorText.match(/(\d+)階\/(\d+)階建/);
    const floor = floorMatch ? parseInt(floorMatch[1]) : null;
    const totalFloors = floorMatch ? parseInt(floorMatch[2]) : null;

    // Image
    const imgEl = li.querySelector('.photo img:last-child') ?? li.querySelector('img');
    const thumbnailUrl = imgEl?.getAttribute('src') ?? null;
    const images = thumbnailUrl ? [thumbnailUrl] : [];

    const cardText = li.textContent ?? '';
    const structure = this.extractStructure(cardText);

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
      priceText: priceLabel || priceRaw,
      area,
      rooms: null,
      age,
      floor,
      totalFloors,
      station,
      stationMinutes,
      yieldRate,
      thumbnailUrl,
      images,
      structure,
      fingerprint,
    });
  }

  /** Parse a PR item from .md-propertyListPr .item */
  private prItemToProperty(item: Element, prefecture: PrefectureCode): Property | null {
    const linkEl = item.querySelector('a.link');
    const href = linkEl?.getAttribute('href') ?? '';
    if (!href) return null;

    const detailUrl = href.startsWith('http') ? href : `https://www.kenbiya.com${href}`;

    // subTitle: "昭島市 1億6,100万円 5.63% 一棟アパート"
    const subTitle = item.querySelector('.subTitle')?.textContent?.trim() ?? '';
    if (!subTitle) return null;

    const sitePropertyId = this.idFromUrl(detailUrl);

    // Price from .pricingInfo .price
    const priceText = item.querySelector('.pricingInfo .price')?.textContent?.trim() ?? '';
    const { price, priceText: priceLabel } = this.extractPrice(priceText);

    // Yield rate from .pricingInfo .yield
    const yieldText = item.querySelector('.pricingInfo .yield')?.textContent?.trim() ?? '';
    const yieldRate = this.extractYieldRate(yieldText);

    // Address + station from .trafficInfo li
    const trafficItems = Array.from(item.querySelectorAll('.trafficInfo li'));
    const addrText = trafficItems[0]?.textContent?.trim() ?? '';
    const stationText = trafficItems[1]?.textContent?.trim() ?? '';

    const city = addrText.match(/([^\s　]+[市区町村])/)?.[1] ?? '';
    const { station, stationMinutes } = this.extractStation(stationText);

    // Image
    const imgEl = item.querySelector('.photo .image') ?? item.querySelector('img');
    const thumbnailUrl = imgEl?.getAttribute('src') ?? null;
    const images = thumbnailUrl ? [thumbnailUrl] : [];

    const fingerprint = this.computeFingerprint({ prefecture, city, price, area: null, rooms: null });

    return this.buildBaseProperty({
      sitePropertyId,
      title: subTitle,
      propertyType: 'investment',
      prefecture,
      city,
      address: addrText || null,
      detailUrl,
      price,
      priceText: priceLabel || priceText,
      area: null,
      rooms: null,
      station,
      stationMinutes,
      yieldRate,
      thumbnailUrl,
      images,
      fingerprint,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** 利回り抽出: "6.7%" / "2.69%" / "5.63%" */
  protected extractYieldRate(text: string): number | null {
    // Kenbiya shows yield as "X.XX％" directly in the price column
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
    // /pp1/s/tokyo/shibuya-ku/re_4440014nmd/ → 4440014nmd
    const alphaNum = url.match(/\/re_([a-z0-9]+)\//i);
    if (alphaNum) return alphaNum[1];
    const num = url.match(/\/(\d{6,})\//);
    if (num) return num[1];
    return btoa(encodeURIComponent(url.replace(/https?:\/\/[^/]+/, ''))).slice(0, 24);
  }

  /** Best-effort city extraction from a Japanese address string. */
  private cityFromAddress(addr: string): string | null {
    return addr.match(/([^\s　]+[市区町村])/)?.[1] ?? null;
  }
}
