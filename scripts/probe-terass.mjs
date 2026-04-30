/**
 * TERASS PICKS 診断プローブ v2
 * CDP port 9222 に接続し、URL params 遷移後の状態を検査
 * - 件数テキスト確認
 * - 検索ボタンクリック後の件数変化
 * - 出力メニューの disabled 状態列挙
 */
import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';
const TERASS_HOST = 'picks-agent.terass.com';
// 神奈川 (code=14) の base64 params
const TEST_URL = `https://${TERASS_HOST}/search/mansion?params=eyJqc29uIjp7InByZWZlY3R1cmVDb2RlcyI6WzE0XX19&limit=50`;

async function probe() {
  console.log('[probe] CDP接続中...');
  const browser = await chromium.connectOverCDP(CDP_URL);

  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.find(p => p.url().includes(TERASS_HOST)) || pages[0] || await context.newPage();

  console.log(`[probe] 使用タブ: ${page.url()}`);

  // 遷移
  console.log(`[probe] 遷移先: ${TEST_URL}`);
  try {
    await page.goto(TEST_URL, { waitUntil: 'commit', timeout: 15000 });
  } catch (e) {
    console.log(`[probe] goto例外(無視): ${e.message.slice(0, 80)}`);
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  console.log('[probe] domcontentloaded完了, 8000ms待機...');
  await page.waitForTimeout(8000);

  // 1. 検索結果件数テキストを探す
  console.log('\n--- [1] 検索件数テキスト (遷移直後) ---');
  const countText = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/([0-9,]+)\s*件/g);
    return m ? m.slice(0, 5).join(' | ') : '(件数なし)';
  });
  console.log(`  件数テキスト: ${countText}`);

  // 2. ステータスタブを確認
  console.log('\n--- [2] ステータスタブ ---');
  try {
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    if (tabCount > 0) {
      const texts = await tabs.allTextContents();
      console.log(`  tabs: ${JSON.stringify(texts.slice(0, 8))}`);
    } else {
      const inStock = await page.locator('text="在庫"').count();
      const sold = await page.locator('text="成約済"').count();
      console.log(`  「在庫」要素数: ${inStock}, 「成約済」要素数: ${sold}`);
    }
  } catch (e) {
    console.log(`  タブ検査エラー: ${e.message}`);
  }

  // 3. 検索ボタンをクリックして再ロード
  console.log('\n--- [3] 検索ボタンクリック ---');
  try {
    const searchBtn = page.locator('button[type="submit"]:has-text("検索")').first();
    const visible = await searchBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      console.log('  検索ボタン発見、クリック...');
      await searchBtn.click({ force: true });
      console.log('  クリック後 8000ms待機...');
      await page.waitForTimeout(8000);
    } else {
      const fb = page.locator('button:has-text("検索")').first();
      const fbVisible = await fb.isVisible({ timeout: 2000 }).catch(() => false);
      if (fbVisible) {
        console.log('  検索ボタン(fallback)発見、クリック...');
        await fb.click({ force: true });
        await page.waitForTimeout(8000);
      } else {
        console.log('  検索ボタン非表示');
      }
    }
    const countAfter = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/([0-9,]+)\s*件/g);
      return m ? m.slice(0, 5).join(' | ') : '(件数なし)';
    });
    console.log(`  検索後件数: ${countAfter}`);
  } catch (e) {
    console.log(`  検索ボタンエラー: ${e.message}`);
  }

  // 4. 出力ボタンをクリックしてメニュー検査
  console.log('\n--- [4] 出力メニュー検査 ---');
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    const exportBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
    const visible = await exportBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const disabled = visible ? await exportBtn.isDisabled().catch(() => false) : false;
    console.log(`  出力ボタン: visible=${visible}, disabled=${disabled}`);

    if (visible && !disabled) {
      await exportBtn.click({ timeout: 5000 });
      await page.waitForTimeout(1500);

      const menuItems = page.locator('[role="menu"] [role="menuitem"]');
      const count = await menuItems.count();
      console.log(`  menuitem数: ${count}`);
      for (let i = 0; i < count; i++) {
        const item = menuItems.nth(i);
        const text = (await item.textContent().catch(() => '')).trim();
        const hasMuiDisabled = await item.evaluate(el => el.classList.contains('Mui-disabled'));
        const ariaDisabled = await item.getAttribute('aria-disabled').catch(() => null);
        console.log(`  [${i}] "${text}" Mui-disabled=${hasMuiDisabled} aria-disabled=${ariaDisabled}`);
      }

      await page.keyboard.press('Escape').catch(() => {});
    } else if (visible && disabled) {
      console.log('  出力ボタンが disabled → 0件状態の可能性');
    } else {
      console.log('  出力ボタン非表示');
    }
  } catch (e) {
    console.log(`  出力メニューエラー: ${e.message}`);
  }

  // 5. 現在URL
  console.log('\n--- [5] 現在のURL ---');
  console.log(`  ${page.url()}`);

  // 6. URL params decode
  console.log('\n--- [6] URL params decode ---');
  const decoded = await page.evaluate(() => {
    try {
      const u = new URL(location.href);
      const params = u.searchParams.get('params');
      if (!params) return '(paramsなし)';
      return JSON.stringify(JSON.parse(atob(decodeURIComponent(params))));
    } catch (e) {
      return `decode error: ${e.message}`;
    }
  });
  console.log(`  params: ${decoded}`);

  // 7. UIリスト確認
  console.log('\n--- [7] UIリスト ---');
  const bodySnippet = await page.evaluate(() => {
    const grid = document.querySelector('[role="grid"], [role="table"], table');
    if (grid) return `grid/table found: rows=${grid.querySelectorAll('[role="row"], tr').length}`;
    const list = document.querySelector('[class*="list"], [class*="List"], [class*="result"]');
    if (list) return `list found: children=${list.children.length}`;
    return '(リスト要素なし)';
  });
  console.log(`  UI: ${bodySnippet}`);

  await browser.close();
  console.log('\n[probe] 完了');
}

probe().catch(e => {
  console.error('[probe] FATAL:', e.message);
  process.exit(1);
});
