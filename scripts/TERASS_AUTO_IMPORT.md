# TERASS PICKS 自動インポート セットアップガイド

TERASS PICKS (https://picks.terass-agents.com/) の物件データを自動的に Cloudflare D1 に同期する仕組みです。

## 概要

```
Chrome (ログイン済み) → scripts/extract-terass.mjs (Playwright CDP)
  → terass-extract.js (IndexedDB 読み取り)
  → TERASS_ALL_*.csv (6ファイル)
  → terass_convert_and_import.mjs (変換 + D1 import API)
  → Cloudflare D1
```

## 前提ソフトウェア

- Node.js 18以上
- Google Chrome (通常インストールで可)
- npm / pnpm

---

## Step 1: Playwright のインストール

プロジェクトルートで実行:

```bash
cd "H:/マイドライブ/♦♦♦オリジナル プロダクト♦♦♦/🌎MAL検索システム🌎"

# Google Driveパスでは npm install が失敗するため、ローカルにコピーして実施
cp -r . C:/Users/reale/Downloads/mal-worker/
cd C:/Users/reale/Downloads/mal-worker/
npm install --save-dev playwright
npx playwright install chromium
```

> **注意**: `playwright` は devDependencies に追加済みです (`package.json` 参照)。

---

## Step 2: Chrome を CDP モードで起動する

Chrome を **リモートデバッグポート付き**で起動します。ログイン状態を維持するため、専用の `--user-data-dir` を使います。

### 方法 A: バッチファイルで起動 (推奨)

`C:/Users/reale/Desktop/Chrome_CDP.bat` を作成:

```bat
@echo off
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%APPDATA%\Chrome_CDP" ^
  https://picks.terass-agents.com/
```

ダブルクリックで Chrome が起動します。

### 方法 B: PowerShell / コマンドプロンプト

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:APPDATA\Chrome_CDP" `
  https://picks.terass-agents.com/
```

---

## Step 3: TERASS PICKS にログイン (初回のみ)

1. Step 2 で起動した Chrome で https://picks.terass-agents.com/ が開く
2. 通常通りログイン
3. Chrome を**閉じずに**そのままにしておく (セッションは `--user-data-dir` に保存される)
4. 次回以降は自動的にログイン済み状態になる

---

## Step 4: 動作確認 (dry-run)

```bash
node scripts/extract-terass.mjs --dry-run
```

成功すると以下のように表示されます:

```
[extract-terass] === TERASS PICKS 自動エクスポート開始 ===
[extract-terass] モード: DRY-RUN (ダウンロードなし)
[extract-terass] Chrome CDP に接続中: http://localhost:9222
[extract-terass] 検出タブ数: 3
[extract-terass] TERASS PICKS タブ検出: https://picks.terass-agents.com/...
[extract-terass] DRY-RUN: Chrome アタッチ成功確認完了。ダウンロードはスキップします。
[extract-terass] DRY-RUN 完了
```

---

## Step 5: 手動実行

```bash
# プロジェクトルートから
node scripts/extract-terass.mjs
```

または Shell スクリプト経由:

```bash
./scripts/auto-import-terass.sh
```

### fallback モード (Chrome なしでインポートのみ)

既存 CSV がある場合は抽出をスキップしてインポートのみ実行できます:

```bash
SKIP_EXTRACT=1 ./scripts/auto-import-terass.sh
```

---

## Step 6: Windows Task Scheduler で自動化

### 設定手順

1. **タスクスケジューラ**を開く (`taskschd.msc`)
2. **タスクの作成** (基本タスクの作成 → 詳細設定)
3. 以下の設定を行う:

| 項目 | 値 |
|------|----|
| 名前 | `TERASS-PICKS-Auto-Import` |
| トリガー | 毎日 03:00 |
| 操作 | プログラムの開始 |
| プログラム | `C:\Program Files\Git\bin\bash.exe` |
| 引数 | `-c "node 'C:/Users/reale/Downloads/mal-worker/scripts/extract-terass.mjs' >> 'C:/Users/reale/Downloads/terass_cron.log' 2>&1"` |
| 開始場所 | `C:/Users/reale/Downloads/mal-worker` |

4. **条件タブ**: 「AC電源接続時のみ」のチェックを外す
5. **設定タブ**: 「タスクが既に実行中の場合: キューに追加しない」

### PowerShell で登録 (管理者権限)

```powershell
$action = New-ScheduledTaskAction `
  -Execute "C:\Program Files\Git\bin\bash.exe" `
  -Argument "-c `"node 'C:/Users/reale/Downloads/mal-worker/scripts/extract-terass.mjs' >> 'C:/Users/reale/Downloads/terass_cron.log' 2>&1`""

$trigger = New-ScheduledTaskTrigger -Daily -At 3:00AM

Register-ScheduledTask `
  -TaskName "TERASS-PICKS-Auto-Import" `
  -Action $action `
  -Trigger $trigger `
  -RunLevel Highest `
  -Force
```

---

## トラブルシューティング

### `Chrome CDP に接続できません`

**原因**: Chrome が `--remote-debugging-port=9222` で起動していない

**解決策**:
1. `Chrome_CDP.bat` (Step 2) で Chrome を起動し直す
2. `http://localhost:9222/json/list` をブラウザで開いて応答があるか確認

---

### `TERASS PICKS タブが見つかりません`

**原因**: CDP モードの Chrome で `picks.terass-agents.com` が開いていない

**解決策**:
1. CDP 起動の Chrome (ポート 9222) で https://picks.terass-agents.com/ を開く
2. 通常の Chrome (ポート 9222 なし) と混同しないよう注意

---

### IndexedDB にデータがない (0件)

**原因**: TERASS PICKS がデータを IndexedDB に保存していない可能性

**解決策**:
1. TERASS PICKS を開いて物件一覧を読み込む (スクロールしてデータを取得させる)
2. ページをリロードして再試行
3. DevTools Console で手動実行:
   ```javascript
   // DevTools Console でコピペ実行
   // scripts/terass-extract.js の内容をコピーして貼り付ける
   ```

---

### `Playwright` モジュールが見つからない

**原因**: `npm install` が実行されていない

**解決策**:
```bash
cd C:/Users/reale/Downloads/mal-worker
npm install
```

---

### ダウンロードが `C:/Users/reale/Downloads/` に保存されない

**原因**: Chrome のデフォルトダウンロード先が異なる

**解決策**:
```bash
DOWNLOADS_DIR="D:/Downloads" node scripts/extract-terass.mjs
```

---

## ファイル一覧

| ファイル | 役割 |
|---------|------|
| `scripts/terass-extract.js` | ブラウザ DevTools Console 用エクスポーター (IndexedDB → CSV) |
| `scripts/extract-terass.mjs` | Playwright 自動化スクリプト (Chrome CDP 経由) |
| `scripts/auto-import-terass.sh` | 全工程を統括するシェルスクリプト (cron 用) |
| `C:/Users/reale/Downloads/terass_convert_and_import.mjs` | CSV → D1 変換 & インポート |

---

## 環境変数リファレンス

| 変数 | デフォルト値 | 説明 |
|------|-------------|------|
| `CDP_URL` | `http://localhost:9222` | Chrome CDP エンドポイント |
| `DOWNLOADS_DIR` | `C:/Users/reale/Downloads` | CSV の保存先 |
| `CONVERT_SCRIPT` | `C:/Users/reale/Downloads/terass_convert_and_import.mjs` | 変換スクリプトのパス |
| `SKIP_EXTRACT` | `0` | `1` にすると抽出をスキップ |
| `TERASS_CSV_DIR` | `C:/Users/reale/Downloads/TERASS_MAL_converted` | 変換済み CSV の参照先 |
