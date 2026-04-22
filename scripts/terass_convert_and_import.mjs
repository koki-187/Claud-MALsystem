#!/usr/bin/env node
// ============================================================
// TERASS CSV → MAL インポート変換 & アップロードスクリプト
// ============================================================
// Usage: node terass_convert_and_import.mjs [--dry-run] [--api-url URL]
// ============================================================

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// ===== 設定 =====
const DOWNLOADS_DIR = 'C:/Users/reale/Downloads';
const OUTPUT_DIR = path.join(DOWNLOADS_DIR, 'TERASS_MAL_converted');
const DRY_RUN = process.argv.includes('--dry-run');
const API_URL = process.argv.find(a => a.startsWith('--api-url='))?.split('=')[1]
  || process.env.MAL_API_URL
  || 'https://mal-search-system.navigator-187.workers.dev/api/admin/import';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// 都道府県名→コード
const PREF_MAP = {
  '北海道':'01','青森':'02','岩手':'03','宮城':'04','秋田':'05','山形':'06','福島':'07',
  '茨城':'08','栃木':'09','群馬':'10','埼玉':'11','千葉':'12','東京':'13','神奈川':'14',
  '新潟':'15','富山':'16','石川':'17','福井':'18','山梨':'19','長野':'20','岐阜':'21',
  '静岡':'22','愛知':'23','三重':'24','滋賀':'25','京都':'26','大阪':'27','兵庫':'28',
  '奈良':'29','和歌山':'30','鳥取':'31','島根':'32','岡山':'33','広島':'34','山口':'35',
  '徳島':'36','香川':'37','愛媛':'38','高知':'39','福岡':'40','佐賀':'41','長崎':'42',
  '熊本':'43','大分':'44','宮崎':'45','鹿児島':'46','沖縄':'47'
};

// ファイル名から物件種別を判定
function detectPropertyType(filename) {
  if (filename.includes('マンション') || filename.includes('mansion')) return 'mansion';
  if (filename.includes('戸建') || filename.includes('house')) return 'kodate';
  if (filename.includes('土地') || filename.includes('land')) return 'tochi';
  return 'other';
}

// ファイル名からステータスを判定
function detectStatus(filename) {
  if (filename.includes('成約') || filename.includes('sold')) return 'sold';
  return 'active';
}

// 住所から都道府県コードを抽出
function extractPrefectureCode(address) {
  if (!address) return '13';
  for (const [name, code] of Object.entries(PREF_MAP)) {
    // "東京都", "北海道", "大阪府", "京都府", other "県"
    if (address.includes(name)) return code;
  }
  return '13';
}

// 住所から市区町村を抽出
function extractCity(address) {
  if (!address) return '';
  // 都道府県を除去して市区町村まで取得
  const stripped = address
    .replace(/^.+?[都道府県]/, '')  // 都道府県除去
    .replace(/^(.+?[市区町村群]).*/, '$1');  // 市区町村まで
  return stripped || '';
}

// 価格パース ("17,000,000" → 17000000)
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[,\s"]/g, '');
  const n = parseInt(cleaned);
  return isNaN(n) ? null : n;
}

// 最寄駅パース ("JR山陰本線(豊岡～米子)・鳥取駅　徒歩8分" → {station, minutes})
function parseStation(stationStr) {
  if (!stationStr) return { station: null, minutes: null };
  // 駅名を抽出 (・の後〜駅まで、または全体から駅名部分)
  let station = null;
  let minutes = null;

  const stationMatch = stationStr.match(/[・]?([^・\s]+駅)/);
  if (stationMatch) station = stationMatch[1];

  const minutesMatch = stationStr.match(/徒歩(\d+)分/);
  if (minutesMatch) minutes = parseInt(minutesMatch[1]);

  // バス分も考慮
  if (!minutesMatch) {
    const busMatch = stationStr.match(/バス(\d+)分/);
    if (busMatch) minutes = parseInt(busMatch[1]);
  }

  return { station, minutes };
}

// 築年月から築年数を計算 ("1959/01" → 67)
function calcAge(builtStr) {
  if (!builtStr) return null;
  const match = builtStr.match(/(\d{4})/);
  if (!match) return null;
  const builtYear = parseInt(match[1]);
  const age = new Date().getFullYear() - builtYear;
  return age >= 0 ? age : null;
}

// 日付フォーマット ("2026/04/12" → "2026-04-12")
function formatDate(dateStr) {
  if (!dateStr) return null;
  return dateStr.replace(/\//g, '-');
}

// site_property_id生成 (ユニークキー: site + address + price + rooms)
function generatePropertyId(site, address, price, rooms, builtDate) {
  const key = `${site}|${address}|${price}|${rooms}|${builtDate}`;
  return createHash('md5').update(key).digest('hex').substring(0, 16);
}

// マルチラインCSV分割 (ダブルクォート内の改行を結合)
function splitCSVLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r') {
      // skip CR
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

// CSV行をパース (ダブルクォート対応)
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// CSVエスケープ
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ===== メイン処理 =====
async function main() {
  console.log('TERASS CSV → MAL インポート変換');
  console.log(`ソースディレクトリ: ${DOWNLOADS_DIR}`);
  console.log(`出力ディレクトリ: ${OUTPUT_DIR}`);
  console.log(`API URL: ${API_URL}`);
  console.log(`モード: ${DRY_RUN ? 'DRY RUN (変換のみ)' : '変換 + インポート'}`);
  console.log('='.repeat(60));

  // TERASS CSVファイルを検索 (TERASS_* or Terass_Picks_*)
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => (f.startsWith('TERASS_') || f.startsWith('Terass_Picks_') || f.startsWith('Terass Picks')) && f.endsWith('.csv'));

  if (files.length === 0) {
    console.log('❌ TERASS_*.csv ファイルが見つかりません。先にダウンロードスクリプトを実行してください。');
    process.exit(1);
  }

  console.log(`\n📁 ${files.length}個のCSVファイルを検出\n`);

  // 出力ディレクトリ作成
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // MAL CSV ヘッダー
  const MAL_HEADERS = [
    'site_id', 'site_property_id', 'title', 'property_type', 'status',
    'prefecture', 'city', 'address', 'price', 'price_text',
    'area', 'rooms', 'age', 'station', 'station_minutes',
    'detail_url', 'listed_at', 'sold_at', 'fingerprint'
  ];

  let grandTotalRows = 0;
  let grandTotalFiles = 0;
  const importResults = [];

  for (const file of files) {
    console.log(`\n📄 処理中: ${file}`);

    const propertyType = detectPropertyType(file);
    const fileStatus = detectStatus(file);
    const filePath = path.join(DOWNLOADS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // BOM除去
    const cleanContent = content.replace(/^\uFEFF/, '');
    // マルチラインCSV対応: ダブルクォート内の改行を結合
    const lines = splitCSVLines(cleanContent).filter(l => l.trim());

    if (lines.length < 2) {
      console.log(`  ⏭️ スキップ (データなし)`);
      continue;
    }

    const headers = parseCSVLine(lines[0]);
    // TERASS ヘッダーのインデックスマップ
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    // 変換処理
    const malRows = [];
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 6) { skipped++; continue; }

      const site = fields[idx['掲載サイト']] || 'terass';
      const address = fields[idx['住所']] || '';
      const priceRaw = fields[idx['価格']] || '';
      const stationRaw = fields[idx['最寄駅']] || '';
      const rooms = fields[idx['間取り']] || '';
      const buildingArea = idx['建物面積(㎡)'] !== undefined ? fields[idx['建物面積(㎡)']] || '' : '';
      const landArea = idx['土地面積(㎡)'] !== undefined ? fields[idx['土地面積(㎡)']] || '' : '';
      const squareArea = idx['専有面積(㎡)'] !== undefined ? fields[idx['専有面積(㎡)']] || '' : '';  // mansion
      const stories = idx['階建'] !== undefined ? fields[idx['階建']] || '' : '';
      const floor = idx['所在階'] !== undefined ? fields[idx['所在階']] || '' : '';  // mansion
      const builtDate = idx['築年月'] !== undefined ? fields[idx['築年月']] || '' : '';
      const listedDate = fields[idx['情報公開日']] || '';
      const soldDate = fields[idx['成約年月日']] || '';
      const propertyName = idx['物件名'] !== undefined ? fields[idx['物件名']] || '' : '';  // mansion

      if (!address) { skipped++; continue; }

      const price = parsePrice(priceRaw);
      const { station, minutes } = parseStation(stationRaw);
      const age = calcAge(builtDate);
      const prefCode = extractPrefectureCode(address);
      const city = extractCity(address);
      const sitePropertyId = generatePropertyId(site, address, priceRaw, rooms, builtDate);

      // ステータス判定: 成約年月日があれば sold
      const status = soldDate ? 'sold' : fileStatus;

      // タイトル生成 (mansion: 物件名優先)
      const title = propertyName
        ? `${propertyName} ${rooms}`.trim().substring(0, 100)
        : `${rooms ? rooms + ' ' : ''}${address}`.substring(0, 100);

      // 面積 (専有面積 > 建物面積 > 土地面積)
      const area = squareArea ? parseFloat(squareArea)
                 : buildingArea ? parseFloat(buildingArea)
                 : landArea ? parseFloat(landArea)
                 : null;

      // fingerprint (重複検知用)
      const fp = createHash('md5')
        .update(`${address}|${priceRaw}|${rooms}|${builtDate}`)
        .digest('hex')
        .substring(0, 12);

      const row = {
        site_id: `terass_${site}`,
        site_property_id: sitePropertyId,
        title: title,
        property_type: propertyType,
        status: status,
        prefecture: prefCode,
        city: city,
        address: address,
        price: price,
        price_text: priceRaw,
        area: isNaN(area) ? '' : area,
        rooms: rooms,
        age: age,
        station: station || '',
        station_minutes: minutes,
        detail_url: '',
        listed_at: formatDate(listedDate),
        sold_at: formatDate(soldDate),
        fingerprint: fp
      };

      malRows.push(row);
    }

    console.log(`  ✅ ${malRows.length}行変換 (スキップ: ${skipped})`);
    grandTotalRows += malRows.length;

    if (malRows.length === 0) continue;

    // MAL CSV 出力
    const outFile = path.join(OUTPUT_DIR, file.replace('TERASS_', 'MAL_'));
    const csvLines = [MAL_HEADERS.join(',')];
    for (const row of malRows) {
      const line = MAL_HEADERS.map(h => csvEscape(row[h])).join(',');
      csvLines.push(line);
    }
    // UTF-8 BOM付き
    fs.writeFileSync(outFile, '\uFEFF' + csvLines.join('\n'), 'utf-8');
    grandTotalFiles++;

    // インポート
    if (!DRY_RUN) {
      try {
        const formData = new FormData();
        const blob = new Blob([fs.readFileSync(outFile)], { type: 'text/csv' });
        formData.append('file', blob, path.basename(outFile));

        const headers = {};
        if (ADMIN_SECRET) headers['Authorization'] = `Bearer ${ADMIN_SECRET}`;
        const resp = await fetch(API_URL, {
          method: 'POST',
          body: formData,
          headers
        });

        if (resp.ok) {
          const result = await resp.json();
          console.log(`  📤 インポート完了: ${result.importedRows}件取込, ${result.skippedRows}件スキップ, ${result.errorRows}件エラー`);
          importResults.push({ file, ...result });
        } else {
          const errText = await resp.text();
          console.error(`  ❌ インポートエラー: HTTP ${resp.status} - ${errText.substring(0, 200)}`);
          importResults.push({ file, error: errText.substring(0, 200) });
        }

        // サーバー負荷軽減のため待機
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`  ❌ インポート失敗: ${err.message}`);
        importResults.push({ file, error: err.message });
      }
    }
  }

  // ===== サマリー =====
  console.log('\n' + '='.repeat(60));
  console.log('変換完了サマリー');
  console.log(`ファイル数: ${grandTotalFiles}`);
  console.log(`総行数: ${grandTotalRows.toLocaleString()}`);
  console.log(`出力先: ${OUTPUT_DIR}`);

  if (!DRY_RUN && importResults.length > 0) {
    console.log('\nインポート結果:');
    const totalImported = importResults.filter(r => r.importedRows).reduce((s, r) => s + r.importedRows, 0);
    const totalErrors = importResults.filter(r => r.errorRows).reduce((s, r) => s + r.errorRows, 0);
    console.log(`  取込: ${totalImported.toLocaleString()}件`);
    console.log(`  エラー: ${totalErrors}件`);

    const failures = importResults.filter(r => r.error);
    if (failures.length > 0) {
      console.log('\n失敗ファイル:');
      failures.forEach(f => console.log(`  - ${f.file}: ${f.error}`));
    }
  }
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
