// Probe: click 都道府県 modal, inspect whether 北海道 label renders & needs scroll.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];
await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(400);
await page.locator('button:has-text("都道府県")').first().click({ force: true });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  // Find the dialog (MuiModal-root.css-8ndowl)
  const modal = Array.from(document.querySelectorAll('div.MuiModal-root.css-8ndowl'))[0];
  if (!modal) return { error: 'no modal' };
  // List all labels in modal
  const labels = Array.from(modal.querySelectorAll('label')).map(l => ({
    text: (l.innerText || '').trim().slice(0, 30),
    hasCheckbox: !!l.querySelector('input[type="checkbox"]'),
    rect: l.getBoundingClientRect().toJSON(),
  }));
  // Find 北海道 specifically
  const hokkaido = labels.findIndex(l => l.text === '北海道');
  // Region headers (non-label elements)
  const headers = Array.from(modal.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div')).filter(el => {
    const t = (el.innerText || '').trim();
    return t && t.length < 12 && /^(北海道|東北|関東|中部|近畿|中国|四国|九州)/.test(t);
  }).slice(0, 10).map(el => ({ tag: el.tagName, text: el.innerText.trim(), rect: el.getBoundingClientRect().toJSON() }));
  // scrollTop / scrollHeight of modal inner scroll container
  const scrollContainers = Array.from(modal.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight && el.scrollHeight > 100).slice(0, 5).map(el => ({
    tag: el.tagName,
    class: (el.className || '').toString().slice(0, 60),
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  return { labelCount: labels.length, hokkaido, firstLabels: labels.slice(0, 10), lastLabels: labels.slice(-10), headers, scrollContainers };
});

console.log(JSON.stringify(info, null, 2));
await browser.close().catch(()=>{});
