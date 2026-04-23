// Click 出力 and then dump modal DOM
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];
console.log('URL:', page.url());

// Dismiss any open menus/popovers first
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);

// Click 出力
const outputBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
const cnt = await outputBtn.count();
console.log('出力 buttons found:', cnt);
if (cnt > 0) {
  await outputBtn.click({ timeout: 5000 });
  console.log('Clicked 出力');
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    // Look for modals/dialogs
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, [class*="odal"], [class*="ialog"]'));
    const allBtns = Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim().slice(0, 50),
      class: (b.className || '').slice(0, 80),
      disabled: b.disabled,
      visible: b.offsetParent !== null,
    })).filter(b => b.visible && b.text);
    return {
      dialogCount: dialogs.length,
      dialogHtml: dialogs.map(d => d.outerHTML.slice(0, 1500)),
      allVisibleBtns: allBtns,
      bodyText: document.body.innerText.slice(0, 1000),
    };
  });
  console.log('Dialogs:', info.dialogCount);
  info.dialogHtml.forEach((h, i) => console.log(`\n--- Dialog ${i} ---\n`, h));
  console.log('\nAll visible buttons:');
  info.allVisibleBtns.forEach(b => console.log('  -', JSON.stringify(b)));
  console.log('\nBody text:', info.bodyText);
}
await browser.close().catch(() => {});
