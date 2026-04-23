// Click 実行 and observe download / network / DOM
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com')) || ctx.pages()[0];

// State should already be: モーダル表示中 from previous probe
// If not, run the flow
const hasModal = await page.locator('text="検索結果を一括ダウンロードします"').count();
console.log('Modal already visible?', hasModal);

if (!hasModal) {
  await page.goto('https://picks-agent.terass.com/search/mansion', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('button[aria-label="Export"]').first().click();
  await page.waitForTimeout(1200);
  await page.locator('[role="menu"] [role="menuitem"]:not(.Mui-disabled)', { hasText: /^CSV$/ }).first().click();
  await page.waitForTimeout(2500);
}

// Listen for downloads on BOTH context and page, network responses
ctx.on('download', d => console.log('CTX DOWNLOAD:', d.suggestedFilename(), d.url()));
page.on('download', d => console.log('PAGE DOWNLOAD:', d.suggestedFilename(), d.url()));
page.on('popup', p => console.log('POPUP:', p.url()));
page.on('response', r => {
  const u = r.url();
  if (u.includes('export') || u.includes('csv') || u.includes('download') || u.includes('search')) {
    console.log('RESPONSE:', r.status(), r.request().method(), u.slice(0, 200));
  }
});

const execBtn = page.locator('[role="dialog"] button:has-text("実行")').first();
console.log('Executing click...');
await execBtn.click({ timeout: 5000, noWaitAfter: true });
console.log('Clicked. Waiting 30s for response...');

await page.waitForTimeout(30000);

// Check DOM after click
const after = await page.evaluate(() => {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map(d => ({
    visible: d.offsetParent !== null,
    text: d.innerText.slice(0, 300),
  }));
  return {
    url: location.href,
    dialogs,
    bodyTextStart: document.body.innerText.slice(0, 400),
    snackbar: document.querySelector('.MuiSnackbar-root, [role="alert"]')?.innerText,
  };
});
console.log('AFTER 30s:', JSON.stringify(after, null, 2));
await browser.close().catch(() => {});
