// One-shot script: TERASS PICKS の 3 カテゴリを巡回して IndexedDB を populate
// 既存の Chrome (--remote-debugging-port=9222) にアタッチして使う
import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';
const URLS = [
  'https://picks-agent.terass.com/search/mansion',
  'https://picks-agent.terass.com/search/house',
  'https://picks-agent.terass.com/search/land',
];

function log(m) { console.log(`[warmup] ${m}`); }

async function listIdb(page) {
  try {
    return await page.evaluate(async () => {
      if (!('databases' in indexedDB)) return null;
      const dbs = await indexedDB.databases();
      return dbs.map(d => ({ name: d.name, version: d.version }));
    });
  } catch (e) { return [{ error: e.message }]; }
}

(async () => {
  log(`Connect: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error('No context'); process.exit(1); }

  // 既存の TERASS タブを探す。あればそれを使い、なければ新規作成
  let page = ctx.pages().find(p => p.url().includes('picks-agent.terass.com'));
  if (page) {
    log(`Reuse existing tab: ${page.url()}`);
  } else {
    page = await ctx.newPage();
    log('Created new tab');
  }

  for (const url of URLS) {
    log(`Navigate: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      log(`  goto warning: ${e.message}`);
    }
    // SPA hydration + IndexedDB cache writes
    await page.waitForTimeout(8000);

    // 検索ボタン or 適当な操作で API 経由のデータ取得をトリガ
    try {
      const searchBtn = await page.locator('button:has-text("検索"), button:has-text("Search"), [type="submit"]').first();
      if (await searchBtn.count() > 0) {
        log('  Click search button');
        await searchBtn.click({ timeout: 3000 }).catch(() => log('  click failed (probably not needed)'));
        await page.waitForTimeout(5000);
      } else {
        log('  No search button found (data may auto-load)');
      }
    } catch (e) { log(`  click probe error: ${e.message}`); }

    const dbs = await listIdb(page);
    log(`  IndexedDB after: ${JSON.stringify(dbs)}`);
  }

  log('Final IndexedDB enumeration:');
  const finalDbs = await listIdb(page);
  log(JSON.stringify(finalDbs, null, 2));

  // disconnect だけ。ブラウザは閉じない (cron で再利用)
  await browser.close().catch(() => {});
  log('Done. Chrome left running for cron.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
