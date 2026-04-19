/**
 * TERASS PICKS IndexedDB エクスポーター
 * ===========================================
 * 使い方:
 *   1. Chrome で https://picks.terass-agents.com/ を開いてログイン
 *   2. F12 → Console タブを開く
 *   3. このスクリプト全体をコピー＆ペーストして Enter
 *   4. 6ファイルが自動ダウンロードされる
 *
 * 出力ファイル:
 *   TERASS_ALL_house_在庫.csv
 *   TERASS_ALL_house_成約済.csv
 *   TERASS_ALL_mansion_在庫.csv
 *   TERASS_ALL_mansion_成約済.csv
 *   TERASS_ALL_land_在庫.csv
 *   TERASS_ALL_land_成約済.csv
 */
(async function terassPicksExport() {
  'use strict';

  // ===== CSV ヘッダー定義 (既存CSVと完全一致) =====
  const HEADERS = {
    house: 'お気に入りボタン,マップボタン,販売図面,共有ボタン,掲載サイト,住所,価格,最寄駅,間取り,建物面積(㎡),土地面積(㎡),階建,築年月,取引態様,掲載会社商号,情報公開日,成約年月日',
    mansion: 'お気に入りボタン,マップボタン,販売図面,共有ボタン,掲載サイト,物件名,住所,価格,最寄駅,間取り,専有面積(㎡),所在階,築年月,取引態様,掲載会社商号,情報公開日,成約年月日',
    land: 'お気に入りボタン,マップボタン,販売図面,共有ボタン,掲載サイト,住所,価格,最寄駅,土地面積(㎡),坪単価,建ぺい率,容積率,取引態様,掲載会社商号,情報公開日,成約年月日',
  };

  // ===== ユーティリティ =====

  /** CSVセルのエスケープ: カンマ・改行・ダブルクォートを含む場合は引用符で囲む */
  function escapeCell(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** オブジェクト配列 → CSV 文字列 */
  function toCsv(header, rows) {
    const lines = ['\uFEFF' + header]; // BOM付き UTF-8
    for (const row of rows) {
      lines.push(row.map(escapeCell).join(','));
    }
    return lines.join('\n');
  }

  /** CSV をブラウザからダウンロード */
  function downloadCsv(filename, csvText) {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const rowCount = Math.max(0, csvText.split('\n').length - 1); // 1行目はヘッダー
    console.log(`[TERASS-EXPORT] ダウンロード: ${filename} (${rowCount}行)`);
  }

  // ===== IndexedDB を開く =====

  function openDb(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getAllFromStore(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve([]); // ストアが存在しない場合は空配列
      }
    });
  }

  /** 利用可能なすべての IndexedDB 名を列挙 */
  async function listDatabases() {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      return dbs.map(d => d.name);
    }
    return [];
  }

  // ===== フィールド抽出ヘルパー =====

  /** 物件種別を判定 (house / mansion / land) */
  function detectType(record) {
    const t = (record.propertyType || record.property_type || record.type || '').toLowerCase();
    const category = (record.category || '').toLowerCase();
    if (t.includes('mansion') || t.includes('マンション') || t.includes('apartment') ||
        category.includes('mansion') || category.includes('マンション')) return 'mansion';
    if (t.includes('land') || t.includes('土地') || t.includes('tochi') ||
        category.includes('land') || category.includes('土地')) return 'land';
    // デフォルト: house
    return 'house';
  }

  /** 成約済みかどうかを判定 */
  function isSold(record) {
    const status = (record.status || record.contractStatus || record.deal_status || '').toLowerCase();
    return status.includes('sold') || status.includes('成約') || status.includes('contract') ||
           !!record.contractDate || !!record.contract_date || !!record.sold_at;
  }

  /** 価格を文字列にフォーマット ("17,800,000") */
  function formatPrice(val) {
    if (!val) return '';
    const n = typeof val === 'number' ? val : parseInt(String(val).replace(/[^\d]/g, ''));
    if (isNaN(n)) return String(val);
    return n.toLocaleString('ja-JP');
  }

  /** 日付を "YYYY/MM/DD" に変換 */
  function formatDate(val) {
    if (!val) return '';
    if (typeof val === 'string') {
      // 既に YYYY/MM/DD or YYYY-MM-DD
      return val.replace(/-/g, '/').split('T')[0].replace(/\//g, '/');
    }
    if (val instanceof Date) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}/${m}/${d}`;
    }
    return String(val);
  }

  /** 築年月を "YYYY/MM" に変換 */
  function formatBuiltDate(val) {
    if (!val) return '';
    const s = String(val).replace(/-/g, '/').split('T')[0];
    // YYYY/MM/DD → YYYY/MM
    const parts = s.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return s;
  }

  // ===== レコード → CSV行 変換 =====

  /** house レコードを CSV 行配列 (17列) に変換 */
  function houseToRow(r) {
    return [
      '',                                            // お気に入りボタン
      '',                                            // マップボタン
      '',                                            // 販売図面
      '',                                            // 共有ボタン
      r.site || r.source || r.掲載サイト || '',      // 掲載サイト
      r.address || r.住所 || '',                     // 住所
      formatPrice(r.price || r.価格),                // 価格
      r.nearestStation || r.nearest_station || r.最寄駅 || '', // 最寄駅
      r.floorPlan || r.floor_plan || r.間取り || '', // 間取り
      r.buildingArea || r.building_area || r['建物面積(㎡)'] || '', // 建物面積(㎡)
      r.landArea || r.land_area || r['土地面積(㎡)'] || '',         // 土地面積(㎡)
      r.floors || r.階建 || '',                      // 階建
      formatBuiltDate(r.builtDate || r.built_date || r.築年月), // 築年月
      r.transactionType || r.transaction_type || r.取引態様 || '', // 取引態様
      r.company || r.agencyName || r.agency_name || r.掲載会社商号 || '', // 掲載会社商号
      formatDate(r.publishedAt || r.published_at || r.情報公開日), // 情報公開日
      formatDate(r.contractDate || r.contract_date || r.成約年月日), // 成約年月日
    ];
  }

  /** mansion レコードを CSV 行配列 (18列) に変換 */
  function mansionToRow(r) {
    return [
      '',
      '',
      '',
      '',
      r.site || r.source || r.掲載サイト || '',
      r.buildingName || r.building_name || r.物件名 || '',
      r.address || r.住所 || '',
      formatPrice(r.price || r.価格),
      r.nearestStation || r.nearest_station || r.最寄駅 || '',
      r.floorPlan || r.floor_plan || r.間取り || '',
      r.exclusiveArea || r.exclusive_area || r['専有面積(㎡)'] || '',
      r.floor || r.所在階 || '',
      formatBuiltDate(r.builtDate || r.built_date || r.築年月),
      r.transactionType || r.transaction_type || r.取引態様 || '',
      r.company || r.agencyName || r.agency_name || r.掲載会社商号 || '',
      formatDate(r.publishedAt || r.published_at || r.情報公開日),
      formatDate(r.contractDate || r.contract_date || r.成約年月日),
    ];
  }

  /** land レコードを CSV 行配列 (17列) に変換 */
  function landToRow(r) {
    return [
      '',
      '',
      '',
      '',
      r.site || r.source || r.掲載サイト || '',
      r.address || r.住所 || '',
      formatPrice(r.price || r.価格),
      r.nearestStation || r.nearest_station || r.最寄駅 || '',
      r.landArea || r.land_area || r['土地面積(㎡)'] || '',
      r.pricePerTsubo || r.price_per_tsubo || r.坪単価 || '',
      r.buildingCoverageRatio || r.building_coverage_ratio || r.建ぺい率 || '',
      r.floorAreaRatio || r.floor_area_ratio || r.容積率 || '',
      r.transactionType || r.transaction_type || r.取引態様 || '',
      r.company || r.agencyName || r.agency_name || r.掲載会社商号 || '',
      formatDate(r.publishedAt || r.published_at || r.情報公開日),
      formatDate(r.contractDate || r.contract_date || r.成約年月日),
    ];
  }

  // ===== メイン処理 =====

  console.log('[TERASS-EXPORT] IndexedDB スキャン開始...');

  // 全 IndexedDB を列挙
  const dbNames = await listDatabases();
  console.log('[TERASS-EXPORT] 発見したDB:', dbNames);
  if (dbNames.length === 0) {
    console.warn('[TERASS-EXPORT] ⚠️ IndexedDB が空または indexedDB.databases() 未対応ブラウザ。Chrome/Edge で TERASS PICKS にログイン後、データを一度表示してから再実行してください。');
    return { ok: false, reason: 'no_indexeddb' };
  }

  // バケツ: { house_active, house_sold, mansion_active, mansion_sold, land_active, land_sold }
  const buckets = {
    house_active: [],
    house_sold: [],
    mansion_active: [],
    mansion_sold: [],
    land_active: [],
    land_sold: [],
  };

  let totalRecords = 0;

  for (const dbName of dbNames) {
    if (!dbName) continue;
    let db;
    try {
      db = await openDb(dbName);
    } catch (e) {
      console.warn(`[TERASS-EXPORT] DB open失敗: ${dbName}`, e);
      continue;
    }

    const storeNames = Array.from(db.objectStoreNames);
    console.log(`[TERASS-EXPORT] DB="${dbName}" stores:`, storeNames);

    for (const storeName of storeNames) {
      let records;
      try {
        records = await getAllFromStore(db, storeName);
      } catch (e) {
        console.warn(`[TERASS-EXPORT] store読み取り失敗: ${storeName}`, e);
        continue;
      }
      if (!records.length) continue;

      console.log(`[TERASS-EXPORT]   store="${storeName}" レコード数: ${records.length}`);
      totalRecords += records.length;

      for (const record of records) {
        const type = detectType(record);
        const sold = isSold(record);
        const key = `${type}_${sold ? 'sold' : 'active'}`;
        if (buckets[key]) {
          buckets[key].push(record);
        }
      }
    }

    db.close();
  }

  console.log(`[TERASS-EXPORT] 合計 ${totalRecords} レコードを分類しました`);
  console.log('[TERASS-EXPORT] 分類結果:', Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, v.length])
  ));

  // ===== CSVを生成してダウンロード =====

  const files = [
    { key: 'house_active',   filename: 'TERASS_ALL_house_在庫.csv',    header: HEADERS.house,   toRow: houseToRow },
    { key: 'house_sold',     filename: 'TERASS_ALL_house_成約済.csv',   header: HEADERS.house,   toRow: houseToRow },
    { key: 'mansion_active', filename: 'TERASS_ALL_mansion_在庫.csv',   header: HEADERS.mansion, toRow: mansionToRow },
    { key: 'mansion_sold',   filename: 'TERASS_ALL_mansion_成約済.csv', header: HEADERS.mansion, toRow: mansionToRow },
    { key: 'land_active',    filename: 'TERASS_ALL_land_在庫.csv',      header: HEADERS.land,    toRow: landToRow },
    { key: 'land_sold',      filename: 'TERASS_ALL_land_成約済.csv',    header: HEADERS.land,    toRow: landToRow },
  ];

  let downloadCount = 0;
  for (const { key, filename, header, toRow } of files) {
    const records = buckets[key];
    const rows = records.map(toRow);
    const csvText = toCsv(header, rows);
    downloadCsv(filename, csvText);
    console.log(`[TERASS-EXPORT] ${filename}: ${records.length}件`);
    downloadCount++;
    // ブラウザのダウンロード連続制限を回避するため少し待機
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[TERASS-EXPORT] 完了! ${downloadCount}ファイルをダウンロードしました`);
  console.log('[TERASS-EXPORT] ダウンロードフォルダに以下のファイルが保存されました:');
  files.forEach(f => console.log(`  - ${f.filename}`));

  // 結果サマリーを返す (Playwrightから evaluate() で取得可能)
  return {
    success: true,
    totalRecords,
    counts: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, v.length])
    ),
    files: files.map(f => f.filename),
  };
})();
