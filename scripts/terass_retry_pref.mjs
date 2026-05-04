#!/usr/bin/env node
// ============================================================
// TERASS 新形式CSVリトライインポート (都道府県別・503対策)
// ============================================================
// Usage: ADMIN_SECRET=xxx node terass_retry_pref.mjs [--dry-run] [--delay=15000]
// ============================================================

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const DOWNLOADS_DIR = 'C:/Users/reale/Downloads';
const OUTPUT_DIR = path.join(DOWNLOADS_DIR, 'TERASS_MAL_converted');
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '12000');
const MAX_RETRY = 3;
const RETRY_WAIT_MS = 60000; // 503時は60秒待ってリトライ
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const API_URL = 'https://mal-search-system.navigator-187.workers.dev/api/admin/import';
const API_BASE = 'https://mal-search-system.navigator-187.workers.dev';
const HIT_LIMIT_THRESHOLD = 9990;

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

function extractPrefectureCode(address) {
  if (!address) return '13';
  for (const [name, code] of Object.entries(PREF_MAP)) {
    if (address.includes(name)) return code;
  }
  return '13';
}

function extractPrefectureCodeFromFilename(filename) {
  const base = filename.replace(/\.csv$/i, '');
  const parts = base.split('_');
  if (parts.length < 2) return null;
  const prefCandidate = parts[1];
  if (!prefCandidate || prefCandidate === 'ALL') return null;
  for (const [name, code] of Object.entries(PREF_MAP)) {
    if (prefCandidate.includes(name)) return code;
  }
  return null;
}

function detectPropertyType(filename) {
  if (filename.includes('マンション')) return 'mansion';
  if (filename.includes('戸建')) return 'kodate';
  if (filename.includes('土地')) return 'tochi';
  return 'other';
}

function detectStatus(filename) {
  return filename.includes('成約') ? 'sold' : 'active';
}

function detectCategoryKey(filename) {
  const t = detectPropertyType(filename);
  const s = detectStatus(filename);
  const typeKey = t === 'mansion' ? 'mansion' : t === 'kodate' ? 'house' : t === 'tochi' ? 'land' : 'other';
  const prefCode = extractPrefectureCodeFromFilename(filename);
  return prefCode ? `${typeKey}_${s}_${prefCode}` : `${typeKey}_${s}`;
}

function extractCity(address) {
  if (!address) return '';
  return address
    .replace(/^.+?[都道府県]/, '')
    .replace(/^(.+?[市区町村群]).*/, '$1') || '';
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  const n = parseInt(priceStr.replace(/[,\s"]/g, ''));
  return isNaN(n) ? null : n;
}

function parseStation(stationStr) {
  if (!stationStr) return { station: null, minutes: null };
  const stationMatch = stationStr.match(/[・]?([^・\s]+駅)/);
  const minutesMatch = stationStr.match(/徒歩(\d+)分/) || stationStr.match(/バス(\d+)分/);
  return {
    station: stationMatch ? stationMatch[1] : null,
    minutes: minutesMatch ? parseInt(minutesMatch[1]) : null
  };
}

function calcAge(builtStr) {
  if (!builtStr) return null;
  const match = builtStr.match(/(\d{4})/);
  if (!match) return null;
  const age = new Date().getFullYear() - parseInt(match[1]);
  return age >= 0 ? age : null;
}

function formatDate(dateStr) {
  return dateStr ? dateStr.replace(/\//g, '-') : null;
}

function generatePropertyId(site, address, price, rooms, builtDate) {
  return createHash('md5').update(`${site}|${address}|${price}|${rooms}|${builtDate}`).digest('hex').substring(0, 16);
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function splitCSVLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else if (ch === '\r') { /* skip */ }
    else { current += ch; }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const MAL_HEADERS = [
  'site_id','site_property_id','title','property_type','status',
  'prefecture','city','address','price','price_text',
  'area','rooms','age','station','station_minutes',
  'detail_url','listed_at','sold_at','fingerprint'
];

async function importWithRetry(importUrl, outFile, filename, attempt = 1) {
  const formData = new FormData();
  const blob = new Blob([fs.readFileSync(outFile)], { type: 'text/csv' });
  formData.append('file', blob, path.basename(outFile));
  const headers = {};
  if (ADMIN_SECRET) headers['Authorization'] = `Bearer ${ADMIN_SECRET}`;

  try {
    const resp = await fetch(importUrl, { method: 'POST', body: formData, headers });
    if (resp.ok) {
      const result = await resp.json();
      return { success: true, ...result };
    } else if (resp.status === 503 && attempt <= MAX_RETRY) {
      console.log(`  ⏳ 503 → ${RETRY_WAIT_MS/1000}秒待機してリトライ (${attempt}/${MAX_RETRY})`);
      await new Promise(r => setTimeout(r, RETRY_WAIT_MS));
      return importWithRetry(importUrl, outFile, filename, attempt + 1);
    } else {
      const errText = await resp.text();
      return { success: false, status: resp.status, error: errText.substring(0, 100) };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('TERASS 新形式CSV リトライインポート');
  console.log(`遅延: ${DELAY_MS}ms / リトライ: ${MAX_RETRY}回 (503時${RETRY_WAIT_MS/1000}秒待機)`);
  console.log(`モード: ${DRY_RUN ? 'DRY RUN' : '変換 + インポート'}`);
  console.log('='.repeat(60));

  // TERASS_県名_*.csv のみ対象
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => /^TERASS_[^_]+_[^_]+_[^_]+\.csv$/i.test(f))
    .sort();

  console.log(`\n📁 ${files.length}個のTERASS_県名CSVを検出\n`);
  if (files.length === 0) { console.log('ファイルなし'); process.exit(0); }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // セッション開始
  let sessionId = null;
  if (!DRY_RUN) {
    try {
      const resp = await fetch(`${API_BASE}/api/admin/import/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}` },
        body: JSON.stringify({ source: 'terass_pref' })
      });
      if (resp.ok) {
        const j = await resp.json();
        sessionId = j.sessionId;
        console.log(`🆔 Session: ${sessionId}\n`);
      } else {
        console.warn(`⚠️ session/start 失敗: ${resp.status} — セッションなしで続行`);
      }
    } catch (e) { console.warn(`⚠️ session/start エラー: ${e.message}`); }
  }

  let totalImported = 0, totalSkipped = 0, totalFailed = 0, totalFiles = 0;
  const failed = [];

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    console.log(`[${fi+1}/${files.length}] 📄 ${file}`);

    const raw = fs.readFileSync(path.join(DOWNLOADS_DIR, file));
    // BOM除去 + デコード
    let text = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
      ? raw.slice(3).toString('utf8')
      : raw.toString('utf8');

    const lines = splitCSVLines(text);
    if (lines.length < 2) { console.log('  ⏭️ データなし'); continue; }

    const headers = parseCSVLine(lines[0]);
    const idx = {};
    headers.forEach((h, i) => { idx[h] = i; });

    const fileStatus = detectStatus(file);
    const propertyType = detectPropertyType(file) === 'mansion' ? 'mansion'
      : detectPropertyType(file) === 'kodate' ? 'house'
      : detectPropertyType(file) === 'tochi' ? 'land' : 'other';

    const malRows = [];
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 6) { skipped++; continue; }
      const site = fields[idx['掲載サイト']] || 'terass';
      const address = fields[idx['住所']] || '';
      if (!address) { skipped++; continue; }
      const priceRaw = fields[idx['価格']] || '';
      const stationRaw = fields[idx['最寄駅']] || '';
      const rooms = fields[idx['間取り']] || '';
      const squareArea = idx['専有面積(㎡)'] !== undefined ? fields[idx['専有面積(㎡)']] || '' : '';
      const buildingArea = idx['建物面積(㎡)'] !== undefined ? fields[idx['建物面積(㎡)']] || '' : '';
      const landArea = idx['土地面積(㎡)'] !== undefined ? fields[idx['土地面積(㎡)']] || '' : '';
      const builtDate = idx['築年月'] !== undefined ? fields[idx['築年月']] || '' : '';
      const listedDate = fields[idx['情報公開日']] || '';
      const soldDate = fields[idx['成約年月日']] || '';
      const propertyName = idx['物件名'] !== undefined ? fields[idx['物件名']] || '' : '';

      const price = parsePrice(priceRaw);
      const { station, minutes } = parseStation(stationRaw);
      const age = calcAge(builtDate);
      const prefCode = extractPrefectureCode(address);
      const city = extractCity(address);
      const sitePropertyId = generatePropertyId(site, address, priceRaw, rooms, builtDate);
      const status = soldDate ? 'sold' : fileStatus;
      const title = (propertyName ? `${propertyName} ${rooms}` : `${rooms ? rooms + ' ' : ''}${address}`).trim().substring(0, 100);
      const area = squareArea ? parseFloat(squareArea) : buildingArea ? parseFloat(buildingArea) : landArea ? parseFloat(landArea) : null;
      const fp = createHash('md5').update(`${address}|${priceRaw}|${rooms}|${builtDate}`).digest('hex').substring(0, 12);

      malRows.push({
        site_id: `terass_${site}`, site_property_id: sitePropertyId,
        title, property_type: propertyType, status, prefecture: prefCode,
        city, address, price, price_text: priceRaw,
        area: (isNaN(area) || area === null) ? '' : area,
        rooms, age, station: station || '', station_minutes: minutes,
        detail_url: '', listed_at: formatDate(listedDate), sold_at: formatDate(soldDate), fingerprint: fp
      });
    }

    console.log(`  ✅ ${malRows.length}行変換 (スキップ:${skipped})`);
    if (malRows.length === 0) continue;

    // 変換済CSVを保存
    const outFile = path.join(OUTPUT_DIR, file.replace('TERASS_', 'MAL_retry_'));
    const csvContent = [MAL_HEADERS.join(','), ...malRows.map(r => MAL_HEADERS.map(h => csvEscape(r[h])).join(','))].join('\n');
    fs.writeFileSync(outFile, '﻿' + csvContent, 'utf-8');
    totalFiles++;

    if (!DRY_RUN) {
      const hitLimit = malRows.length >= HIT_LIMIT_THRESHOLD;
      const qs = new URLSearchParams({ category: detectCategoryKey(file), hit_export_limit: hitLimit ? '1' : '0' });
      if (sessionId) qs.set('session', sessionId);
      const importUrl = `${API_URL}?${qs}`;

      if (hitLimit) console.log(`  ⚠️ 10000行打ち切り検知`);

      const result = await importWithRetry(importUrl, outFile, file);
      if (result.success) {
        console.log(`  📤 ${result.importedRows}件取込, ${result.skippedRows}件スキップ`);
        totalImported += result.importedRows || 0;
        totalSkipped += result.skippedRows || 0;
      } else {
        console.error(`  ❌ 失敗: ${result.status || ''} ${result.error || ''}`);
        totalFailed++;
        failed.push(file);
      }

      // レート制限回避: ファイル間待機
      if (fi < files.length - 1) {
        process.stdout.write(`  ⏱️ ${DELAY_MS/1000}秒待機...`);
        await new Promise(r => setTimeout(r, DELAY_MS));
        process.stdout.write(' 完了\n');
      }
    }
  }

  // セッション完了
  if (!DRY_RUN && sessionId) {
    try {
      const resp = await fetch(`${API_BASE}/api/admin/import/session/complete?session=${encodeURIComponent(sessionId)}&abort_threshold=0.30`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` }
      });
      if (resp.ok) {
        const j = await resp.json();
        if (j.aborted) console.log(`\n⛔ Delisted ABORT: ${j.reason}`);
        else console.log(`\n🗑️ Delisted: ${j.totalMarkedDelisted}件`);
      }
    } catch (e) { console.warn(`⚠️ session/complete エラー: ${e.message}`); }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`完了: ${totalFiles}ファイル / 取込:${totalImported}件 / スキップ:${totalSkipped}件 / 失敗:${totalFailed}件`);
  if (failed.length) { console.log('失敗ファイル:', failed.join(', ')); }
  console.log('='.repeat(60));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
