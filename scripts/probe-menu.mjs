// Click 出力 → enumerate menu items
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];
console.log('URL:', page.url());

await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

const outputBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
await outputBtn.click({ timeout: 5000 });
console.log('Clicked 出力');
await page.waitForTimeout(1500);

const items = await page.evaluate(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return { error: 'no menu' };
  const lis = Array.from(menu.querySelectorAll('li'));
  return lis.map(li => ({
    text: li.innerText.trim().slice(0, 80),
    role: li.getAttribute('role'),
    disabled: li.getAttribute('aria-disabled') === 'true' || li.classList.contains('Mui-disabled'),
  }));
});
console.log('Menu items:');
console.log(JSON.stringify(items, null, 2));

await browser.close().catch(() => {});
