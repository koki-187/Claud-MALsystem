// Focused probe: click 都道府県 button, wait, then inspect modal in detail.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];

await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

console.log('Clicking 都道府県 button…');
await page.locator('button:has-text("都道府県")').first().click();
await page.waitForTimeout(2500);

// Snapshot all visible dialogs after click
const info = await page.evaluate(() => {
  const allDialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="presentation"]'));
  return allDialogs
    .filter(d => d.offsetParent !== null)
    .map((d, idx) => ({
      idx,
      role: d.getAttribute('role'),
      ariaLabel: d.getAttribute('aria-label'),
      class: (d.className || '').toString().slice(0, 80),
      text: (d.innerText || '').slice(0, 2000),
      // Detail of interactive elements
      checkboxes: Array.from(d.querySelectorAll('input[type="checkbox"]')).slice(0, 50).map(cb => ({
        name: cb.name,
        value: cb.value,
        checked: cb.checked,
        labelText: cb.closest('label')?.innerText?.trim().slice(0, 30) || cb.parentElement?.innerText?.trim().slice(0, 30),
      })),
      labels: Array.from(d.querySelectorAll('label, [role="checkbox"], [role="option"]')).slice(0, 60).map(l => ({
        tag: l.tagName,
        role: l.getAttribute('role'),
        text: l.innerText?.trim().slice(0, 30),
        ariaChecked: l.getAttribute('aria-checked'),
        dataValue: l.getAttribute('data-value'),
      })),
      buttons: Array.from(d.querySelectorAll('button')).slice(0, 20).map(b => ({
        text: b.innerText?.trim().slice(0, 30),
        type: b.type,
      })),
    }));
});

console.log(`Found ${info.length} visible dialog(s)`);
info.forEach(d => {
  console.log(`\n=== Dialog #${d.idx} (role=${d.role}, class=${d.class}) ===`);
  console.log('  text preview (2000 chars):');
  console.log('   ', d.text.replace(/\n/g, '\n    '));
  console.log(`  checkboxes (${d.checkboxes.length}):`);
  d.checkboxes.forEach(cb => console.log('   -', JSON.stringify(cb)));
  console.log(`  labels/options (${d.labels.length}):`);
  d.labels.forEach(l => console.log('   -', JSON.stringify(l)));
  console.log(`  buttons (${d.buttons.length}):`);
  d.buttons.forEach(b => console.log('   -', JSON.stringify(b)));
});

await browser.close().catch(() => {});
