// Probe v4: simulate exact switchCategory flow then inspect modal state at each step.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];

async function snapshotModals(label) {
  const info = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('div.MuiModal-root'));
    return modals.map(m => ({
      tag: m.tagName,
      role: m.getAttribute('role'),
      class: (m.className || '').toString().slice(0, 100),
      hidden: m.classList.contains('MuiModal-hidden'),
      visible: m.offsetParent !== null,
      ariaHidden: m.getAttribute('aria-hidden'),
      hasHokkaidoLabel: !!m.querySelector('label')?.innerText && Array.from(m.querySelectorAll('label')).some(l => (l.innerText || '').trim() === '北海道'),
      textPreview: (m.innerText || '').slice(0, 80).replace(/\n/g, ' | '),
    }));
  });
  console.log(`\n[${label}] modals=${info.length}`);
  info.forEach((m, i) => console.log(` ${i}:`, JSON.stringify(m)));
}

console.log('1. Navigate mansion');
await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await snapshotModals('after-nav');

console.log('\n2. Press Escape x2');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await snapshotModals('after-escape');

console.log('\n3. Click 在庫 status tab');
const stockBtn = page.locator('button:has-text("在庫"), [role="tab"]:has-text("在庫")').first();
const stockCount = await stockBtn.count();
console.log(`   stock button count: ${stockCount}`);
if (stockCount > 0) {
  await stockBtn.click({ force: true }).catch(e => console.log('   stock click err:', e.message));
  await page.waitForTimeout(1500);
}
await snapshotModals('after-stock-click');

console.log('\n4. Click 都道府県 button');
const prefBtn = page.locator('button:has-text("都道府県")').first();
const prefCount = await prefBtn.count();
console.log(`   prefecture button count: ${prefCount}`);
if (prefCount > 0) {
  // Inspect button itself
  const btnInfo = await prefBtn.evaluate(el => ({
    text: el.innerText,
    disabled: el.disabled,
    ariaExpanded: el.getAttribute('aria-expanded'),
    class: (el.className || '').toString().slice(0, 100),
    visible: el.offsetParent !== null,
    rect: el.getBoundingClientRect().toJSON(),
  }));
  console.log('   prefBtn:', JSON.stringify(btnInfo));
  await prefBtn.click({ force: true }).catch(e => console.log('   prefBtn click err:', e.message));
  await page.waitForTimeout(1500);
}
await snapshotModals('after-pref-click');

console.log('\n5. Wait 3s then snapshot again');
await page.waitForTimeout(3000);
await snapshotModals('after-wait');

console.log('\n6. Try DOM-level check for any 北海道 text on page');
const hokkaidoVisible = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('label, span, div'));
  const hits = all.filter(el => el.offsetParent !== null && (el.innerText || '').trim() === '北海道');
  return hits.slice(0, 5).map(el => ({
    tag: el.tagName,
    parentClass: (el.parentElement?.className || '').toString().slice(0, 80),
    rect: el.getBoundingClientRect().toJSON(),
  }));
});
console.log('   visible 北海道 elements:', JSON.stringify(hokkaidoVisible, null, 2));

await browser.close().catch(() => {});
