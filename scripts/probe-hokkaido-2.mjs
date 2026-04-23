// Dump FULL modal HTML + look for region tabs / search inputs / hidden labels
import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];
await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(400);
await page.locator('button:has-text("都道府県")').first().click({ force: true });
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => {
  const modal = document.querySelector('div.MuiModal-root.css-8ndowl');
  if (!modal) return { error: 'no modal' };
  // ALL text nodes
  const allText = Array.from(modal.querySelectorAll('*')).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
  // ALL buttons, tabs, inputs
  const interactive = [
    ...Array.from(modal.querySelectorAll('button')).map(b => ({type:'button', text: (b.innerText||'').trim().slice(0,40), ariaLabel: b.getAttribute('aria-label')})),
    ...Array.from(modal.querySelectorAll('input')).map(i => ({type:'input', inputType: i.type, placeholder: i.placeholder, name: i.name, value: i.value})),
    ...Array.from(modal.querySelectorAll('[role="tab"]')).map(t => ({type:'tab', text: (t.innerText||'').trim(), selected: t.getAttribute('aria-selected')})),
  ];
  return {
    html: modal.outerHTML,
    innerText: modal.innerText,
    interactiveCount: interactive.length,
    interactive: interactive.slice(0, 30),
    textSamples: [...new Set(allText)].slice(0, 50),
  };
});

if (dump.html) {
  fs.writeFileSync('/tmp/modal-hokkaido.html', dump.html);
  console.log('Saved HTML to /tmp/modal-hokkaido.html (' + dump.html.length + ' bytes)');
}
console.log('--- innerText ---');
console.log(dump.innerText);
console.log('--- interactive ---');
console.log(JSON.stringify(dump.interactive, null, 2));

await browser.close().catch(()=>{});
