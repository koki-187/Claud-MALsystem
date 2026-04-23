#!/usr/bin/env node
/**
 * TERASS PICKS 自動エクスポーター v2 (公式「出力」ボタン経由)
 * =====================================================
 * 旧方式 (IndexedDB 読み取り) は TERASS のアーキテクチャ変更で機能停止。
 * 新方式: 既存 Chrome に CDP アタッチ → 各カテゴリで「出力」ボタンクリック
 *         → 確認モーダルで「実行」→ CSV ダウンロード を 6 回繰り返す。
 *
 * 前提:
 *   Chrome を --remote-debugging-port=9222 オプションで起動済み
 *   TERASS PICKS にログイン済み (Chrome_CDP プロファイル推奨)
 *
 * 取得カテゴリ: mansion / house / land × 在庫 / 成約済 = 6 ファイル
 *
 * 出力:
 *   C:/Users/reale/Downloads/TERASS_ALL_mansion_在庫.csv
 *   C:/Users/reale/Downloads/TERASS_ALL_mansion_成約済.csv
 *   ... (× house / land)
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { existsSync, renameSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ===== 設定 =====
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || 'C:/Users/reale/Downloads';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONVERT_SCRIPT = process.env.CONVERT_SCRIPT || join(SCRIPT_DIR, 'terass_convert_and_import.mjs');
const TERASS_HOST = 'picks-agent.terass.com';
const DRY_RUN = process.argv.includes('--dry-run');

const DOWNLOAD_TIMEOUT_MS = 120_000;
const NAV_TIMEOUT_MS = 30_000;
const CATEGORY_WAIT_MS = 6_000;   // ページ遷移後の安定待ち

// 取得対象: kind × status = 6 ファイル
const CATEGORIES = [
  { kind: 'mansion', status: 'active', label: 'マンション在庫' },
  { kind: 'house',   status: 'active', label: '戸建在庫' },
  { kind: 'land',    status: 'active', label: '土地在庫' },
  { kind: 'mansion', status: 'sold',   label: 'マンション成約済' },
  { kind: 'house',   status: 'sold',   label: '戸建成約済' },
  { kind: 'land',    status: 'sold',   label: '土地成約済' },
];

// ===== ログ =====
function log(msg)  { console.log(`[extract-terass] ${msg}`); }
function warn(msg) { console.warn(`[extract-terass] WARNING: ${msg}`); }
function error(msg){ console.error(`[extract-terass] ERROR: ${msg}`); }

// ===== ファイル名規約 =====
function targetFilename(kind, status) {
  // converter は filename に "マンション/戸建/土地" + "在庫/成約済" を期待
  const kindJp = kind === 'mansion' ? 'マンション' : kind === 'house' ? '戸建' : '土地';
  const statusJp = status === 'sold' ? '成約済' : '在庫';
  return `TERASS_ALL_${kindJp}_${statusJp}.csv`;
}

// ===== CDP 経由で TERASS PICKS タブを取得 =====
async function getOrCreateTerassPage(browser) {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP コンテキストが取得できません');

  let page = ctx.pages().find(p => p.url().includes(TERASS_HOST));
  if (page) {
    log(`既存 TERASS タブを再利用: ${page.url()}`);
  } else {
    page = await ctx.newPage();
    log('新規タブ作成');
    await page.goto(`https://${TERASS_HOST}/search/mansion`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  }
  return { ctx, page };
}

// ===== ログイン状態チェック =====
async function ensureLoggedIn(page) {
  const url = page.url();
  const loginIndicators = ['/login', '/signin', '/sign-in', '/auth', '/oauth', 'accounts.google.com'];
  if (loginIndicators.some(ind => url.includes(ind))) {
    throw new Error(
      `TERASS PICKS のログインセッションが切れています (現在URL: ${url})\n` +
      `Chrome (--user-data-dir=%APPDATA%\\Chrome_CDP) で再ログインしてから実行してください。`
    );
  }
}

// ===== カテゴリ切替 (URL ナビゲーション + 在庫/成約済タブ click) =====
async function switchCategory(page, kind, status) {
  // 1. URL でカテゴリ切替
  const url = `https://${TERASS_HOST}/search/${kind}`;
  log(`  ナビゲート: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(CATEGORY_WAIT_MS);

  // 2. ステータスタブ切替 (在庫 / 成約済) — TERASS UI のラベルテキストでクリック
  const statusLabel = status === 'sold' ? '成約済' : '在庫';
  try {
    // ラジオボタンまたはタブ風 UI
    const statusEl = page.locator(`text="${statusLabel}"`).first();
    if (await statusEl.count() > 0) {
      await statusEl.click({ timeout: 5000 });
      log(`  ステータス切替: ${statusLabel}`);
      await page.waitForTimeout(3000);
    } else {
      warn(`  ステータス UI が見つかりません: ${statusLabel}`);
    }
  } catch (e) {
    warn(`  ステータス切替失敗 (続行): ${e.message}`);
  }

  // 3. 検索ボタンクリック (フィルタ反映)
  try {
    const searchBtn = page.locator('button:has-text("検索")').first();
    if (await searchBtn.count() > 0) {
      await searchBtn.click({ timeout: 5000 });
      log('  検索ボタンクリック');
      await page.waitForTimeout(4000);
    }
  } catch (e) {
    warn(`  検索ボタンクリック失敗 (続行): ${e.message}`);
  }
}

// ===== 「出力」ボタン → メニュー「全件一括出力 → CSV」 → モーダル「実行」 → ダウンロード待機 =====
async function exportCurrent(page, ctx, dst) {
  // 開いている可能性のあるメニュー/モーダルを閉じる
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // ダウンロードイベントを先にリッスン (page スコープ — ctx では発火しない)
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });

  // 「出力」ボタンクリック (メニューが開く)
  const outputBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
  if (await outputBtn.count() === 0) {
    throw new Error('「出力」ボタンが見つかりません');
  }
  await outputBtn.click({ timeout: 5000 });
  log('  「出力」メニューを開く');
  await page.waitForTimeout(1200);

  // 「全件一括出力」セクションの "CSV" を選択
  // 有効な (Mui-disabled でない) "CSV" menuitem は「全件一括出力」配下のみ
  const csvItem = page.locator('[role="menu"] [role="menuitem"]:not(.Mui-disabled)', { hasText: /^CSV$/ }).first();
  if (await csvItem.count() === 0) {
    throw new Error('「全件一括出力 → CSV」項目が見つかりません');
  }
  await csvItem.click({ timeout: 5000 });
  log('  「全件一括出力 → CSV」クリック');

  // 確認モーダル「実行」クリック
  await page.waitForTimeout(1500);
  const execBtn = page.locator('[role="dialog"] button:has-text("実行")').first();
  if (await execBtn.count() === 0) {
    throw new Error('確認モーダルの「実行」ボタンが見つかりません');
  }
  // type="submit" のため navigation 待ちが入りクリックがタイムアウトする → noWaitAfter で回避
  await execBtn.click({ timeout: 5000, noWaitAfter: true });
  log('  「実行」クリック → ダウンロード待機');

  // ダウンロード完了待機
  const download = await downloadPromise;
  await download.saveAs(dst);
  log(`  ダウンロード保存: ${dst}`);
}

// ===== メイン =====
async function main() {
  log('=== TERASS PICKS v2 エクスポート開始 ===');
  log(`モード: ${DRY_RUN ? 'DRY-RUN' : '本番実行'}`);

  log(`Chrome CDP に接続中: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  log('アタッチ成功');

  const { ctx, page } = await getOrCreateTerassPage(browser);
  await ensureLoggedIn(page);

  if (DRY_RUN) {
    log('DRY-RUN: アタッチ + ログイン確認 OK。エクスポートはスキップ');
    await browser.close().catch(() => {});
    return { success: true, dryRun: true, downloadedFiles: [] };
  }

  const downloadedFiles = [];
  const errors = [];

  for (const cat of CATEGORIES) {
    log('');
    log(`▶ ${cat.label} (${cat.kind} / ${cat.status})`);
    try {
      await switchCategory(page, cat.kind, cat.status);
      const fname = targetFilename(cat.kind, cat.status);
      const dst = join(DOWNLOADS_DIR, fname);
      await exportCurrent(page, ctx, dst);
      downloadedFiles.push({ filename: fname, path: dst, ...cat });
    } catch (e) {
      error(`  ${cat.label} 失敗: ${e.message}`);
      errors.push({ category: cat.label, error: e.message });
    }
  }

  // CDP attach の場合は disconnect のみ — Chrome 本体は閉じない
  await browser.close().catch(() => {});

  log('');
  log(`=== エクスポート完了: ${downloadedFiles.length}/${CATEGORIES.length} 成功 ===`);
  downloadedFiles.forEach(f => log(`  ✓ ${f.label}: ${f.filename}`));
  if (errors.length > 0) {
    errors.forEach(e => warn(`  ✗ ${e.category}: ${e.error}`));
  }

  // 1 ファイルでも取れたら convert + import
  if (downloadedFiles.length > 0) {
    log('');
    log('=== 変換 & D1 インポート開始 ===');
    await runConvertAndImport();
  }

  return {
    success: downloadedFiles.length > 0,
    downloadedFiles,
    errors,
  };
}

// ===== 変換 & インポートスクリプトを実行 =====
function runConvertAndImport() {
  return new Promise((resolve) => {
    if (!existsSync(CONVERT_SCRIPT)) {
      warn(`変換スクリプトが見つかりません: ${CONVERT_SCRIPT}`);
      resolve();
      return;
    }
    log(`実行: node ${CONVERT_SCRIPT}`);
    const proc = spawn('node', [CONVERT_SCRIPT], { stdio: 'inherit', shell: true });
    proc.on('close', (code) => {
      if (code === 0) log('変換 & インポート完了');
      else warn(`変換スクリプトが終了コード ${code} で失敗`);
      resolve();
    });
    proc.on('error', (err) => {
      warn(`変換スクリプト起動エラー: ${err.message}`);
      resolve();
    });
  });
}

// ===== エントリーポイント =====
main().then(result => {
  if (result && result.success === false) {
    error('全カテゴリ失敗 (0 ファイル) → exit 2');
    process.exit(2);
  }
}).catch(err => {
  error(err.message || String(err));
  process.exit(1);
});
