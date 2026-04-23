#!/usr/bin/env node
/**
 * TERASS PICKS 自動エクスポーター v3 (都道府県×カテゴリ段階分割)
 * =====================================================
 * 旧方式 (IndexedDB 読み取り) は TERASS のアーキテクチャ変更で機能停止。
 * 新方式: 既存 Chrome に CDP アタッチ → 都道府県フィルタ × 各カテゴリで「出力」ボタンクリック
 *         → 確認モーダルで「実行」→ CSV ダウンロード を最大 47×6=282 回繰り返す。
 *
 * 前提:
 *   Chrome を --remote-debugging-port=9222 オプションで起動済み
 *   TERASS PICKS にログイン済み (Chrome_CDP プロファイル推奨)
 *
 * 取得カテゴリ: mansion / house / land × 在庫 / 成約済 = 6 ファイル/県
 *
 * CLI フラグ:
 *   --prefectures=all              全 47 都道府県 (デフォルト)
 *   --prefectures=tokyo            東京都のみ
 *   --prefectures=tokyo,kanagawa   複数指定
 *   --dry-run                      ブラウザ接続確認のみ
 *
 * 出力:
 *   C:/Users/reale/Downloads/TERASS_東京都_マンション_在庫.csv
 *   C:/Users/reale/Downloads/TERASS_東京都_マンション_成約済.csv
 *   ... (× house / land × 47県)
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { existsSync, renameSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// .env 自動ロード (起動方法に依らず ADMIN_SECRET 等を確実に注入)
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

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
const PREF_MODAL_TIMEOUT_MS = 5_000; // 都道府県モーダル表示タイムアウト

// 取得対象: kind × status = 6 ファイル
const CATEGORIES = [
  { kind: 'mansion', status: 'active', label: 'マンション在庫' },
  { kind: 'house',   status: 'active', label: '戸建在庫' },
  { kind: 'land',    status: 'active', label: '土地在庫' },
  { kind: 'mansion', status: 'sold',   label: 'マンション成約済' },
  { kind: 'house',   status: 'sold',   label: '戸建成約済' },
  { kind: 'land',    status: 'sold',   label: '土地成約済' },
];

// 47 都道府県 (postal code 順)
const PREFECTURES = [
  { code: '01', name: '北海道' },
  { code: '02', name: '青森県' },
  { code: '03', name: '岩手県' },
  { code: '04', name: '宮城県' },
  { code: '05', name: '秋田県' },
  { code: '06', name: '山形県' },
  { code: '07', name: '福島県' },
  { code: '08', name: '茨城県' },
  { code: '09', name: '栃木県' },
  { code: '10', name: '群馬県' },
  { code: '11', name: '埼玉県' },
  { code: '12', name: '千葉県' },
  { code: '13', name: '東京都' },
  { code: '14', name: '神奈川県' },
  { code: '15', name: '新潟県' },
  { code: '16', name: '富山県' },
  { code: '17', name: '石川県' },
  { code: '18', name: '福井県' },
  { code: '19', name: '山梨県' },
  { code: '20', name: '長野県' },
  { code: '21', name: '岐阜県' },
  { code: '22', name: '静岡県' },
  { code: '23', name: '愛知県' },
  { code: '24', name: '三重県' },
  { code: '25', name: '滋賀県' },
  { code: '26', name: '京都府' },
  { code: '27', name: '大阪府' },
  { code: '28', name: '兵庫県' },
  { code: '29', name: '奈良県' },
  { code: '30', name: '和歌山県' },
  { code: '31', name: '鳥取県' },
  { code: '32', name: '島根県' },
  { code: '33', name: '岡山県' },
  { code: '34', name: '広島県' },
  { code: '35', name: '山口県' },
  { code: '36', name: '徳島県' },
  { code: '37', name: '香川県' },
  { code: '38', name: '愛媛県' },
  { code: '39', name: '高知県' },
  { code: '40', name: '福岡県' },
  { code: '41', name: '佐賀県' },
  { code: '42', name: '長崎県' },
  { code: '43', name: '熊本県' },
  { code: '44', name: '大分県' },
  { code: '45', name: '宮崎県' },
  { code: '46', name: '鹿児島県' },
  { code: '47', name: '沖縄県' },
];

// 英語キー → 都道府県名 マッピング (全 47 件)
const PREF_EN_MAP = {
  hokkaido:    '北海道',
  aomori:      '青森県',
  iwate:       '岩手県',
  miyagi:      '宮城県',
  akita:       '秋田県',
  yamagata:    '山形県',
  fukushima:   '福島県',
  ibaraki:     '茨城県',
  tochigi:     '栃木県',
  gunma:       '群馬県',
  saitama:     '埼玉県',
  chiba:       '千葉県',
  tokyo:       '東京都',
  kanagawa:    '神奈川県',
  niigata:     '新潟県',
  toyama:      '富山県',
  ishikawa:    '石川県',
  fukui:       '福井県',
  yamanashi:   '山梨県',
  nagano:      '長野県',
  gifu:        '岐阜県',
  shizuoka:    '静岡県',
  aichi:       '愛知県',
  mie:         '三重県',
  shiga:       '滋賀県',
  kyoto:       '京都府',
  osaka:       '大阪府',
  hyogo:       '兵庫県',
  nara:        '奈良県',
  wakayama:    '和歌山県',
  tottori:     '鳥取県',
  shimane:     '島根県',
  okayama:     '岡山県',
  hiroshima:   '広島県',
  yamaguchi:   '山口県',
  tokushima:   '徳島県',
  kagawa:      '香川県',
  ehime:       '愛媛県',
  kochi:       '高知県',
  fukuoka:     '福岡県',
  saga:        '佐賀県',
  nagasaki:    '長崎県',
  kumamoto:    '熊本県',
  oita:        '大分県',
  miyazaki:    '宮崎県',
  kagoshima:   '鹿児島県',
  okinawa:     '沖縄県',
};

// ===== CLI フラグ解析 =====
/**
 * --prefectures=all | <英語キー,英語キー,...>
 * returns: Array<{ code, name }>
 */
function parsePrefsFlag() {
  const arg = process.argv.find(a => a.startsWith('--prefectures='));
  if (!arg) return PREFECTURES; // デフォルト: 全 47 件

  const val = arg.split('=')[1].trim().toLowerCase();
  if (val === 'all' || val === '') return PREFECTURES;

  const keys = val.split(',').map(k => k.trim()).filter(Boolean);
  const result = [];
  for (const key of keys) {
    const jpName = PREF_EN_MAP[key];
    if (!jpName) {
      warn(`不明な都道府県キー: "${key}" — スキップ`);
      continue;
    }
    const pref = PREFECTURES.find(p => p.name === jpName);
    if (pref) result.push(pref);
  }
  if (result.length === 0) {
    warn('有効な都道府県が指定されていません。全 47 件を使用します。');
    return PREFECTURES;
  }
  return result;
}

// ===== ログ =====
function log(msg)  { console.log(`[extract-terass] ${msg}`); }
function warn(msg) { console.warn(`[extract-terass] WARNING: ${msg}`); }
function error(msg){ console.error(`[extract-terass] ERROR: ${msg}`); }

// ===== ファイル名規約 =====
/**
 * prefectureName が渡された場合: TERASS_<県名>_<種別>_<ステータス>.csv
 * 未指定 (後方互換): TERASS_ALL_<種別>_<ステータス>.csv
 */
function targetFilename(kind, status, prefectureName) {
  const kindJp = kind === 'mansion' ? 'マンション' : kind === 'house' ? '戸建' : '土地';
  const statusJp = status === 'sold' ? '成約済' : '在庫';
  const prefPart = prefectureName ? prefectureName : 'ALL';
  return `TERASS_${prefPart}_${kindJp}_${statusJp}.csv`;
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

// ===== 都道府県モーダルで1県を選択 =====
/**
 * 都道府県ボタンをクリック → モーダルを開く → 前回選択解除 → 指定県を選択 → 決定
 * ボタン/モーダルが見つからない場合は warn して return (フィルタなしで継続)
 */
async function selectPrefecture(page, prefectureName) {
  // 都道府県ボタン
  const prefBtn = page.locator('button:has-text("都道府県")').first();
  if (await prefBtn.count() === 0) {
    warn(`  「都道府県」ボタンが見つかりません — フィルタなしで続行`);
    return;
  }

  // 残存 backdrop / モーダル を必ず閉じてから 都道府県 を開く
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);

  try {
    // force:true で MuiBackdrop の pointer-events 阻害を回避
    await prefBtn.click({ timeout: 8000, force: true });
    log(`  都道府県モーダルを開く`);
  } catch (e) {
    warn(`  「都道府県」ボタンクリック失敗 — フィルタなしで続行: ${e.message}`);
    return;
  }

  // PrefectureModal は role="presentation" — モーダル DOM の "都道府県を選択" ヘッダ出現で開口判定
  // 注: offsetParent が null になる場合があるため visible 判定は使わず attached + テキスト一致で判定
  const dialog = page.locator('div.MuiModal-root.css-8ndowl').filter({ hasText: '都道府県を選択' }).first();
  try {
    await dialog.waitFor({ state: 'attached', timeout: PREF_MODAL_TIMEOUT_MS });
    // 内容描画の安定化
    await page.waitForTimeout(700);
  } catch (e) {
    warn(`  都道府県モーダルが開きません (${PREF_MODAL_TIMEOUT_MS}ms) — Escape して続行`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    return;
  }

  // 前回選択済みチェックボックスをすべて解除
  try {
    // クリアボタンがあれば優先使用
    const clearBtn = dialog.locator('button:has-text("クリア"), button:has-text("リセット"), button:has-text("全解除")').first();
    if (await clearBtn.count() > 0) {
      await clearBtn.click({ timeout: 3000 });
      log('  選択クリアボタンをクリック');
      await page.waitForTimeout(500);
    } else {
      // checked な checkbox を順次解除
      const checkedBoxes = dialog.locator('input[type="checkbox"]:checked');
      const checkedCount = await checkedBoxes.count();
      if (checkedCount > 0) {
        log(`  チェック済み ${checkedCount} 件を解除`);
        for (let i = 0; i < checkedCount; i++) {
          const box = checkedBoxes.nth(i);
          await box.click({ timeout: 2000 }).catch(() => {});
        }
        await page.waitForTimeout(300);
      }
    }
  } catch (e) {
    warn(`  選択クリア中にエラー (続行): ${e.message}`);
  }

  // 指定都道府県を選択
  // Modal は virtual scroll / 条件 render のため label が DOM に出ない場合あり。
  // → 最大 6 回まで modal 内を上下スクロールしながら探索し、最終手段は JS eval で直接クリック。
  let clicked = false;
  for (let attempt = 0; attempt < 6 && !clicked; attempt++) {
    try {
      const prefLabel = dialog.locator(`label:has-text("${prefectureName}")`).first();
      if (await prefLabel.count() > 0) {
        await prefLabel.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await prefLabel.click({ timeout: 3000, force: true });
        log(`  ${prefectureName} を選択${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
        clicked = true;
        break;
      }
    } catch { /* retry */ }
    // スクロールして再試行 (方向を交互に: 先に上に戻して全域をスキャン、その後下へ)
    await page.evaluate((dir) => {
      const m = document.querySelector('div.MuiModal-root.css-8ndowl');
      if (!m) return;
      // modal 内の全スクロール可能要素を対象
      const scrolls = [m, ...m.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 5);
      for (const el of scrolls) el.scrollBy(0, dir);
      // window も fallback
      window.scrollBy(0, dir);
    }, attempt < 3 ? -400 : 400);
    await page.waitForTimeout(400);
  }
  // 最終手段: page.evaluate で modal 内の label 全走査 → 一致クリック
  if (!clicked) {
    clicked = await page.evaluate((name) => {
      const m = document.querySelector('div.MuiModal-root.css-8ndowl');
      if (!m) return false;
      const label = Array.from(m.querySelectorAll('label')).find(l => (l.innerText || '').trim() === name);
      if (!label) return false;
      label.scrollIntoView({ block: 'center' });
      const cb = label.querySelector('input[type="checkbox"]');
      if (cb && !cb.checked) cb.click();
      else label.click();
      return true;
    }, prefectureName);
    if (clicked) log(`  ${prefectureName} を選択 (JS eval fallback)`);
  }
  if (!clicked) {
    warn(`  ${prefectureName} のチェックボックスが見つかりません — フィルタなしで続行`);
    await page.keyboard.press('Escape').catch(() => {});
    return;
  }

  await page.waitForTimeout(300);

  // モーダルを閉じる: 「検索」or「決定」ボタン、なければ Escape
  try {
    const confirmBtn = dialog.locator('button:has-text("検索"), button:has-text("決定"), button:has-text("適用")').first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click({ timeout: 3000, force: true });
      log('  モーダルを閉じる (確定ボタン)');
    } else {
      log('  確定ボタンが見つかりません — Escape で閉じる');
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (e) {
    warn(`  モーダルクローズ失敗 — Escape: ${e.message}`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  // backdrop が完全に消えるまで待つ (次クリックを阻害しないように)
  try {
    await page.locator('div.MuiBackdrop-root.MuiModal-backdrop').first().waitFor({ state: 'hidden', timeout: 5000 });
  } catch { /* backdrop persists — proceed anyway */ }
  await page.waitForTimeout(2500);
}

// ===== カテゴリ切替 (URL ナビゲーション + 在庫/成約済タブ click + 都道府県絞り込み) =====
async function switchCategory(page, kind, status, prefectureName) {
  // 1. URL でカテゴリ切替
  // TERASS モーダルは coverage 外の 17 県 (北海道, 東北, 北陸, 沖縄 等) を render しないため、
  // `?params=<base64>` に prefectureCodes を直接埋めて URL 段階で絞り込む方が確実。
  let url = `https://${TERASS_HOST}/search/${kind}`;
  if (prefectureName) {
    const pref = PREFECTURES.find(p => p.name === prefectureName);
    if (pref) {
      const payload = { json: { prefectureCodes: [parseInt(pref.code, 10)] } };
      const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      url += `?params=${encodeURIComponent(b64)}&limit=50`;
    }
  }
  log(`  ナビゲート: ${url}`);
  // SPA のクライアントナビと重なると ERR_ABORTED が出るため:
  //   1) waitUntil: 'commit' で早期 resolve
  //   2) ERR_ABORTED は無視して body 表示待ちに切替
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    if (!/ERR_ABORTED|net::ERR_ABORTED/.test(e.message)) throw e;
    warn(`  goto ERR_ABORTED 無視 (SPA 内部ナビ競合)`);
  }
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  // Fix 3: params が SPA に届いているか確認 — 消失時はリトライ
  if (prefectureName) {
    const currentUrl = page.url();
    if (!currentUrl.includes('params=')) {
      warn(`  params 消失検知 → リトライ`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
  }
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

  // 3. 都道府県絞り込み
  // URL params で prefectureCodes を指定済のため、モーダル操作はスキップ (coverage 外県でも確実に動作)。
  if (prefectureName) {
    log(`  都道府県フィルタは URL params で指定済 (modal skip)`);
  }
  if (false && prefectureName) {
    await selectPrefecture(page, prefectureName);
  }

  // 4. 検索ボタンクリック (フィルタ反映)
  // backdrop 残存に備え force:true。押下対象は左サイドバー検索条件パネル下部の「検索」(submit) ボタン。
  try {
    const searchBtn = page.locator('button[type="submit"]:has-text("検索")').first();
    if (await searchBtn.count() > 0) {
      await searchBtn.click({ timeout: 5000, force: true });
      log('  検索ボタンクリック');
      // Fix 1: 固定 4s ではなく API 完了シグナル (件数テキスト変化) を待つ
      await page.waitForFunction(
        () => {
          const t = document.body.innerText || '';
          return /[1-9][0-9,]*\s*件/.test(t) || /該当するデータ|No rows|no data|データがありません/i.test(t);
        },
        { timeout: 12000, polling: 500 }
      ).catch(() => {});
      await page.waitForTimeout(1200);
    } else {
      // fallback: 任意の検索ボタン
      const fb = page.locator('button:has-text("検索")').first();
      if (await fb.count() > 0) {
        await fb.click({ timeout: 5000, force: true });
        log('  検索ボタンクリック (fallback)');
        // Fix 1: 固定 4s ではなく API 完了シグナル (件数テキスト変化) を待つ
      await page.waitForFunction(
        () => {
          const t = document.body.innerText || '';
          return /[1-9][0-9,]*\s*件/.test(t) || /該当するデータ|No rows|no data|データがありません/i.test(t);
        },
        { timeout: 12000, polling: 500 }
      ).catch(() => {});
      await page.waitForTimeout(1200);
      }
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
  // throw 時の unhandled rejection 抑止 (後続で await されない場合に備える)
  downloadPromise.catch(() => {});

  // 0件検知: ページ上の「0件」「0 件」「該当するデータはありません」「no data」を先にチェック
  const zeroRows = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return /0\s*件|該当するデータ|no data|No rows|データがありません/i.test(t) && !/[1-9]\d*\s*件/.test(t);
  });
  if (zeroRows) {
    throw new Error('NO_DATA: 0件のためエクスポート対象なし');
  }

  // 「出力」ボタンクリック (メニューが開く)
  const outputBtn = page.locator('button[aria-label="Export"], button:has-text("出力")').first();
  if (await outputBtn.count() === 0) {
    throw new Error('「出力」ボタンが見つかりません');
  }
  // disabled なら NO_DATA (出力不能状態)
  if (await outputBtn.isDisabled().catch(() => false)) {
    throw new Error('NO_DATA: 出力ボタンが disabled');
  }
  await outputBtn.click({ timeout: 5000 });
  log('  「出力」メニューを開く');
  // Fix 2: menuitem が DOM に出るまで待機 (MUI Menu アニメーション)
  await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  // 「全件一括出力」セクションの "CSV" を選択
  // 有効な (Mui-disabled でない) "CSV" menuitem は「全件一括出力」配下のみ
  const csvItem = page.locator('[role="menu"] [role="menuitem"]:not(.Mui-disabled)', { hasText: /^CSV$/ }).first();
  if (await csvItem.count() === 0) {
    // disabled の CSV 項目のみ → 0件で出力不能
    const disabledCsv = await page.locator('[role="menu"] [role="menuitem"].Mui-disabled', { hasText: /^CSV$/ }).count().catch(() => 0);
    if (disabledCsv > 0) {
      throw new Error('NO_DATA: CSV 項目が全て disabled (0件)');
    }
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
  // 失敗確認 (ネットワークエラー / サーバエラー)
  const failure = await download.failure().catch(() => null);
  if (failure) {
    throw new Error(`NO_DATA: ダウンロード失敗 (${failure})`);
  }
  // tmp path 取得 — 消失時は NO_DATA 扱い
  const tmpPath = await download.path().catch(() => null);
  if (!tmpPath) {
    throw new Error('NO_DATA: ダウンロード tmp ファイルが存在しない (空/キャンセル)');
  }
  try {
    await download.saveAs(dst);
    log(`  ダウンロード保存: ${dst}`);
  } catch (e) {
    if (/ENOENT/.test(e.message)) {
      throw new Error(`NO_DATA: saveAs ENOENT (tmp 消失 — 0件ダウンロードの可能性)`);
    }
    throw e;
  }
}

// ===== メイン =====
async function main() {
  log('=== TERASS PICKS v3 エクスポート開始 (都道府県×カテゴリ) ===');
  log(`モード: ${DRY_RUN ? 'DRY-RUN' : '本番実行'}`);

  const targetPrefs = parsePrefsFlag();
  log(`対象都道府県: ${targetPrefs.length} 件 (${targetPrefs.map(p => p.name).join(', ')})`);
  log(`対象カテゴリ: ${CATEGORIES.length} 件`);
  log(`合計: ${targetPrefs.length * CATEGORIES.length} ファイル予定`);

  if (DRY_RUN) {
    log('DRY-RUN: フラグ解析 OK。ブラウザ接続はスキップ');
    return { success: true, dryRun: true, downloadedFiles: [] };
  }

  // 旧フォーマット (TERASS_ALL_*, TERASS_<カテゴリ名>_*) を archive へ退避し
  // converter が今回の都道府県分割 CSV のみを処理するよう保証
  try {
    const { readdirSync, mkdirSync } = await import('fs');
    const archiveDir = join(DOWNLOADS_DIR, '_terass_archive');
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    const PREF_NAMES = new Set(PREFECTURES.map(p => p.name));
    let movedCount = 0;
    for (const f of readdirSync(DOWNLOADS_DIR)) {
      if (!/^TERASS_.+\.csv$/i.test(f)) continue;
      // ファイル名 2 セグメント目が県名でなければ旧フォーマット → 退避
      const seg = f.replace(/^TERASS_/, '').split('_')[0];
      if (!PREF_NAMES.has(seg)) {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        renameSync(join(DOWNLOADS_DIR, f), join(archiveDir, `${stamp}_${f}`));
        movedCount++;
      }
    }
    if (movedCount > 0) log(`旧フォーマット CSV ${movedCount} 件を ${archiveDir} へ退避`);
  } catch (e) {
    warn(`旧 CSV 退避中にエラー (続行): ${e.message}`);
  }

  log(`Chrome CDP に接続中: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  log('アタッチ成功');

  const { ctx, page } = await getOrCreateTerassPage(browser);
  await ensureLoggedIn(page);

  const downloadedFiles = [];
  const errors = [];
  const totalItems = targetPrefs.length * CATEGORIES.length;
  let itemIndex = 0;

  for (const pref of targetPrefs) {
    for (const cat of CATEGORIES) {
      itemIndex++;
      const prefIdx = targetPrefs.indexOf(pref) + 1;
      const catIdx = CATEGORIES.indexOf(cat) + 1;
      log('');
      log(`▶ ${pref.name} / ${cat.label} (${prefIdx}/${targetPrefs.length} 県, ${catIdx}/${CATEGORIES.length} カテゴリ, 通算 ${itemIndex}/${totalItems})`);

      try {
        await switchCategory(page, cat.kind, cat.status, pref.name);
        const fname = targetFilename(cat.kind, cat.status, pref.name);
        const dst = join(DOWNLOADS_DIR, fname);
        await exportCurrent(page, ctx, dst);
        downloadedFiles.push({ filename: fname, path: dst, prefecture: pref, ...cat });
      } catch (e) {
        if (/NO_DATA/.test(e.message)) {
          log(`  ${pref.name} / ${cat.label} スキップ (TERASS 在庫なし)`);
          errors.push({ prefecture: pref.name, category: cat.label, error: 'NO_DATA', skipped: true });
        } else {
          error(`  ${pref.name} / ${cat.label} 失敗: ${e.message}`);
          errors.push({ prefecture: pref.name, category: cat.label, error: e.message });
        }
      }
    }
  }

  // CDP attach の場合は disconnect のみ — Chrome 本体は閉じない
  await browser.close().catch(() => {});

  const successCount = downloadedFiles.length;
  const failCount = errors.length;
  const skipCount = totalItems - successCount - failCount;

  log('');
  log(`=== エクスポート完了 ===`);
  log(`成功 ${successCount} / 失敗 ${failCount} / スキップ ${skipCount} (合計 ${totalItems})`);
  downloadedFiles.forEach(f => log(`  ✓ ${f.prefecture.name} / ${f.label}: ${f.filename}`));
  if (errors.length > 0) {
    errors.forEach(e => warn(`  ✗ ${e.prefecture} / ${e.category}: ${e.error}`));
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
