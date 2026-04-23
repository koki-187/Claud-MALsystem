// Click 出力 → 全件一括出力 CSV → dump resulting modal
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];
await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('URL:', page.url());

await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

const outputBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
await outputBtn.click({ timeout: 5000 });
console.log('Clicked 出力');
await page.waitForTimeout(1200);

const csvItem = page.locator('[role="menu"] [role="menuitem"]:not(.Mui-disabled)', { hasText: /^CSV$/ }).first();
await csvItem.click({ timeout: 5000 });
console.log('Clicked CSV');
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  return {
    dialogs: dialogs.map(d => ({
      ariaLabel: d.getAttribute('aria-label'),
      title: d.querySelector('[id^=":r"]')?.innerText?.slice(0, 100),
      visible: d.offsetParent !== null,
      text: d.innerText.slice(0, 600),
      buttons: Array.from(d.querySelectorAll('button')).map(b => ({
        text: b.innerText.trim().slice(0, 50),
        type: b.type,
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      })),
    })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close().catch(() => {});
