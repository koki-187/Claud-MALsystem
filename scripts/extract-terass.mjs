#!/usr/bin/env node
/**
 * TERASS PICKS 自動エクスポーター (Playwright / CDP版)
 * =====================================================
 * 既存 Chrome にリモートデバッガー経由でアタッチし、
 * TERASS PICKS タブで terass-extract.js を実行して CSV をダウンロードします。
 *
 * 前提:
 *   Chrome を --remote-debugging-port=9222 オプションで起動済み
 *   TERASS PICKS (https://picks.terass-agents.com/) にログイン済み
 *
 * 使い方:
 *   node scripts/extract-terass.mjs            # 通常実行
 *   node scripts/extract-terass.mjs --dry-run  # アタッチ確認のみ (ダウンロードしない)
 *
 * Chrome 起動コマンド (管理者権限不要):
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%APPDATA%\Chrome_CDP"
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ===== 設定 =====
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || 'C:/Users/reale/Downloads';
const CONVERT_SCRIPT = process.env.CONVERT_SCRIPT || join(DOWNLOADS_DIR, 'terass_convert_and_import.mjs');
const TERASS_URL_PATTERN = 'picks.terass-agents.com';
const DRY_RUN = process.argv.includes('--dry-run');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACT_JS_PATH = join(SCRIPT_DIR, 'terass-extract.js');

// ダウンロード完了を待つタイムアウト (ms)
const DOWNLOAD_TIMEOUT_MS = 60_000;
// IndexedDB 評価タイムアウト (ms)
const EVAL_TIMEOUT_MS = 30_000;

// ===== ログ =====
function log(msg) {
  console.log(`[extract-terass] ${msg}`);
}
function warn(msg) {
  console.warn(`[extract-terass] WARNING: ${msg}`);
}
function error(msg) {
  console.error(`[extract-terass] ERROR: ${msg}`);
}

// ===== CDPエンドポイント一覧を取得 =====
async function fetchCdpTargets() {
  const url = `${CDP_URL}/json/list`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(
      `Chrome CDP に接続できません (${url})\n` +
      `Chrome が --remote-debugging-port=9222 で起動しているか確認してください。\n` +
      `詳細: ${e.message}`
    );
  }
}

// ===== TERASS PICKS タブを検索 =====
function findTerassTab(targets) {
  return targets.find(t =>
    t.type === 'page' &&
    t.url &&
    t.url.includes(TERASS_URL_PATTERN)
  );
}

// ===== メイン =====
async function main() {
  log('=== TERASS PICKS 自動エクスポート開始 ===');
  log(`モード: ${DRY_RUN ? 'DRY-RUN (ダウンロードなし)' : '本番実行'}`);

  // 1. terass-extract.js を読み込み
  if (!existsSync(EXTRACT_JS_PATH)) {
    throw new Error(`エクスポートスクリプトが見つかりません: ${EXTRACT_JS_PATH}`);
  }
  const extractScript = readFileSync(EXTRACT_JS_PATH, 'utf-8');
  log(`エクスポートスクリプト読み込み完了: ${EXTRACT_JS_PATH}`);

  // 2. CDP ターゲット一覧を取得
  log(`Chrome CDP に接続中: ${CDP_URL}`);
  const targets = await fetchCdpTargets();
  log(`検出タブ数: ${targets.length}`);

  // 3. TERASS PICKS タブを検索
  const terassTarget = findTerassTab(targets);
  if (!terassTarget) {
    const pageTargets = targets.filter(t => t.type === 'page');
    log('利用可能なタブ一覧:');
    pageTargets.forEach((t, i) => log(`  [${i}] ${t.url}`));
    throw new Error(
      `TERASS PICKS タブが見つかりません (URL に "${TERASS_URL_PATTERN}" を含むタブ)\n` +
      `Chrome で https://picks.terass-agents.com/ を開いてからもう一度実行してください。`
    );
  }
  log(`TERASS PICKS タブ検出: ${terassTarget.url}`);

  if (DRY_RUN) {
    log('DRY-RUN: Chrome アタッチ成功確認完了。ダウンロードはスキップします。');
    log(`  タブID: ${terassTarget.id}`);
    log(`  タブURL: ${terassTarget.url}`);
    log('DRY-RUN 完了');
    return { success: true, dryRun: true };
  }

  // 4. Playwright で既存 Chrome にアタッチ
  log('Playwright で Chrome にアタッチ中...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  log('アタッチ成功');

  let result;
  try {
    // 5. TERASS PICKS タブを取得
    const contexts = browser.contexts();
    let terassPage = null;

    for (const ctx of contexts) {
      const pages = ctx.pages();
      for (const page of pages) {
        if (page.url().includes(TERASS_URL_PATTERN)) {
          terassPage = page;
          break;
        }
      }
      if (terassPage) break;
    }

    if (!terassPage) {
      throw new Error('Playwright 経由で TERASS PICKS タブを取得できませんでした');
    }
    log(`ページ取得成功: ${terassPage.url()}`);

    // 6. ダウンロード先を設定
    const downloadContext = terassPage.context();
    await downloadContext.setDefaultTimeout(DOWNLOAD_TIMEOUT_MS);

    // 7. ダウンロードイベントをリッスン
    const downloadPromises = [];
    const downloadedFiles = [];

    const downloadHandler = (download) => {
      const p = download.path().then(async (tmpPath) => {
        const suggested = download.suggestedFilename();
        const destPath = join(DOWNLOADS_DIR, suggested);
        await download.saveAs(destPath);
        downloadedFiles.push({ filename: suggested, path: destPath });
        log(`ダウンロード完了: ${suggested} → ${destPath}`);
        return destPath;
      });
      downloadPromises.push(p);
    };
    downloadContext.on('download', downloadHandler);

    // 8. IndexedDB エクスポートスクリプトを実行
    log('IndexedDB エクスポートスクリプトを実行中...');
    let evalResult;
    try {
      evalResult = await terassPage.evaluate(
        new Function(`return (${extractScript})()`)  // IIFE を evaluate
      );
    } catch (evalErr) {
      // evaluate がタイムアウトした場合でもダウンロードは完了している可能性がある
      warn(`スクリプト評価エラー (ダウンロードは継続される場合があります): ${evalErr.message}`);
    }

    if (evalResult) {
      log(`スクリプト結果: ${JSON.stringify(evalResult)}`);
    }

    // 9. ダウンロード完了を待機 (最大 DOWNLOAD_TIMEOUT_MS ms)
    log(`ダウンロード完了待機中 (最大 ${DOWNLOAD_TIMEOUT_MS / 1000}秒)...`);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ダウンロードタイムアウト')), DOWNLOAD_TIMEOUT_MS)
    );

    // 6ファイルのダウンロードを待つ、または 5秒経ってもダウンロードが来なければ完了とみなす
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, 8000)), // 最低8秒待機
      timeout,
    ]);

    // 残ダウンロードを待機
    if (downloadPromises.length > 0) {
      await Promise.race([
        Promise.all(downloadPromises),
        timeout,
      ]).catch(e => warn(`一部ダウンロードが未完了: ${e.message}`));
    }

    downloadContext.off('download', downloadHandler);

    log(`ダウンロードされたファイル数: ${downloadedFiles.length}`);
    downloadedFiles.forEach(f => log(`  - ${f.filename}`));

    result = {
      success: true,
      downloadedFiles,
      evalResult,
    };

  } finally {
    // 既存ブラウザを終了させないよう disconnect のみ
    browser.close().catch(() => {});
  }

  // 10. terass_convert_and_import.mjs を実行
  if (result.success) {
    log('');
    log('=== 変換 & D1 インポート開始 ===');
    await runConvertAndImport();
  }

  log('=== 全処理完了 ===');
  return result;
}

// ===== 変換 & インポートスクリプトを実行 =====
function runConvertAndImport() {
  return new Promise((resolve, reject) => {
    if (!existsSync(CONVERT_SCRIPT)) {
      warn(`変換スクリプトが見つかりません: ${CONVERT_SCRIPT}`);
      warn('D1 インポートをスキップします。手動で実行してください:');
      warn(`  node ${CONVERT_SCRIPT}`);
      resolve();
      return;
    }

    log(`実行: node ${CONVERT_SCRIPT}`);
    const proc = spawn('node', [CONVERT_SCRIPT], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        log('変換 & インポート完了');
        resolve();
      } else {
        warn(`変換スクリプトが終了コード ${code} で失敗しました`);
        // エラーでも全体を失敗させない (fallback として継続)
        resolve();
      }
    });

    proc.on('error', (err) => {
      warn(`変換スクリプト起動エラー: ${err.message}`);
      resolve(); // fallback
    });
  });
}

// ===== エントリーポイント =====
main().catch(err => {
  error(err.message);
  process.exit(1);
});
