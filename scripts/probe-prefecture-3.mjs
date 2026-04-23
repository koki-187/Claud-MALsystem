// Probe v3: click 都道府県, immediately scan for ANY element with prefecture-name text.
import { chromium } from 'playwright';
import fs from 'fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];

await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

console.log('Clicking 都道府県…');
await page.locator('button:has-text("都道府県")').first().click();
await page.waitForTimeout(2000);

const snapshot = await page.evaluate(() => {
  const PREFS = ['北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川','新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄'];
  const all = Array.from(document.querySelectorAll('label, button, [role="checkbox"], [role="option"], li, span, div'));
  const hits = all.filter(el => {
    if (!el.offsetParent) return false;
    const t = (el.innerText || '').trim();
    if (!t || t.length > 8) return false;
    return PREFS.some(p => t === p || t === p + '都' || t === p + '府' || t === p + '県');
  });
  return {
    totalHits: hits.length,
    sample: hits.slice(0, 15).map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: (el.innerText || '').trim(),
      class: (el.className || '').toString().slice(0, 100),
      // Path to root for context
      ancestorChain: (() => {
        const chain = [];
        let cur = el;
        for (let i = 0; i < 6 && cur; i++) {
          chain.push(`${cur.tagName}${cur.id ? '#' + cur.id : ''}.${(cur.className || '').toString().slice(0, 40)}`);
          cur = cur.parentElement;
        }
        return chain;
      })(),
      // Surrounding HTML for ONE example
      outerHtml: el.outerHTML.slice(0, 300),
      parentOuter: el.parentElement?.outerHTML.slice(0, 400),
    })),
  };
});

console.log(`Total prefecture-name hits: ${snapshot.totalHits}`);
snapshot.sample.forEach(h => {
  console.log(`\n--- ${h.tag}[role=${h.role}] "${h.text}" ---`);
  console.log('  class:', h.class);
  console.log('  ancestors:', h.ancestorChain.join(' > '));
  console.log('  outerHTML:', h.outerHtml);
  console.log('  parent outerHTML:', h.parentOuter);
});

// Save full body html if hits found
if (snapshot.totalHits > 5) {
  const html = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync('C:/Users/reale/Downloads/terass_pref_modal.html', html);
  console.log('\nFull body HTML saved → C:/Users/reale/Downloads/terass_pref_modal.html');
}

await browser.close().catch(() => {});
