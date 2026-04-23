// Probe TERASS PICKS prefecture selector DOM
// Goal: identify how to programmatically filter by 都道府県 so extract can iterate 47 times.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];

await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);

console.log('URL:', page.url());

// Strategy 1: search URL params (most reliable if supported)
const urlVariants = [
  'https://picks-agent.terass.com/search/mansion?prefecture=13',
  'https://picks-agent.terass.com/search/mansion?pref=13',
  'https://picks-agent.terass.com/search/mansion?prefecture_code=13',
  'https://picks-agent.terass.com/search/mansion?todofuken=tokyo',
];

// Strategy 2: scan DOM for filter UI keywords
const dom = await page.evaluate(() => {
  // Look for elements containing 都道府県, エリア, 地域 keyword
  const all = Array.from(document.querySelectorAll('button, [role="button"], label, span, div'));
  const hits = all
    .filter(el => {
      const t = (el.innerText || '').trim();
      return t && t.length < 30 && /都道府県|エリア|地域|条件/.test(t);
    })
    .slice(0, 30)
    .map(el => ({
      tag: el.tagName,
      text: el.innerText.trim().slice(0, 50),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      class: (el.className || '').toString().slice(0, 80),
      visible: el.offsetParent !== null,
    }));
  // Look for any 東京 / 神奈川 / 大阪 mentions in clickable elements
  const prefHits = all
    .filter(el => {
      const t = (el.innerText || '').trim();
      return t && t.length < 20 && /^(東京|神奈川|大阪|北海道|福岡)/.test(t);
    })
    .slice(0, 20)
    .map(el => ({
      tag: el.tagName,
      text: el.innerText.trim().slice(0, 30),
      role: el.getAttribute('role'),
      class: (el.className || '').toString().slice(0, 60),
      visible: el.offsetParent !== null,
    }));
  // Filter chips / search-related buttons (top toolbar usually)
  const filterBtns = Array.from(document.querySelectorAll('button')).filter(b => {
    const t = (b.innerText || '').trim();
    return b.offsetParent !== null && t && t.length < 25;
  }).map(b => ({
    text: b.innerText.trim().slice(0, 40),
    ariaLabel: b.getAttribute('aria-label'),
    class: (b.className || '').toString().slice(0, 80),
  }));
  return {
    keywordHits: hits,
    prefHits,
    filterBtns: filterBtns.slice(0, 50),
  };
});

console.log('\n=== Keyword hits (都道府県/エリア/地域/条件) ===');
dom.keywordHits.forEach(h => console.log(' -', JSON.stringify(h)));
console.log('\n=== Visible filter buttons (top 50) ===');
dom.filterBtns.forEach(b => console.log(' -', JSON.stringify(b)));
console.log('\n=== Pref name hits (東京/神奈川/...) ===');
dom.prefHits.forEach(h => console.log(' -', JSON.stringify(h)));

// Try clicking 詳細条件 / エリア / 都道府県 if found
const candidates = ['詳細条件', '条件を変更', 'エリア', '都道府県', '絞り込み', 'フィルタ'];
for (const label of candidates) {
  const loc = page.locator(`button:has-text("${label}"), [role="button"]:has-text("${label}")`).first();
  const cnt = await loc.count();
  if (cnt > 0) {
    console.log(`\n>>> Found "${label}" (count=${cnt}) — clicking to probe modal`);
    try {
      await loc.click({ timeout: 3000 });
      await page.waitForTimeout(1500);
      const modal = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="presentation"]'));
        return dialogs.filter(d => d.offsetParent !== null).map(d => ({
          ariaLabel: d.getAttribute('aria-label'),
          textPreview: (d.innerText || '').slice(0, 1500),
          buttons: Array.from(d.querySelectorAll('button, [role="checkbox"], input')).slice(0, 30).map(b => ({
            tag: b.tagName,
            text: (b.innerText || b.value || '').trim().slice(0, 30),
            type: b.type,
            name: b.name,
            value: b.value,
          })),
        }));
      });
      console.log(JSON.stringify(modal, null, 2));
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      break; // first useful candidate
    } catch (e) {
      console.log(`   click failed: ${e.message}`);
    }
  }
}

// Probe URL strategy
console.log('\n=== URL param tests ===');
for (const url of urlVariants) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const finalUrl = page.url();
    const counter = await page.evaluate(() => {
      // try to find result count display like "1,234件"
      const all = document.body.innerText.match(/[\d,]+\s*件/g) || [];
      return all.slice(0, 5);
    });
    console.log(` ${url} -> finalURL=${finalUrl} | counts=${JSON.stringify(counter)}`);
  } catch (e) {
    console.log(` ${url} -> ERROR ${e.message}`);
  }
}

await browser.close().catch(() => {});
