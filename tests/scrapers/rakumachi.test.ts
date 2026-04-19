/**
 * 楽待 (Rakumachi) scraper parse tests (standalone Node runner — no vitest dependency).
 *
 * Run:
 *   cd C:/Users/reale/Downloads/mal-worker && npx tsx tests/scrapers/rakumachi.test.ts
 *
 * The test imports html-parser directly and validates parsing logic (including
 * yieldRate extraction) against the fixture at tests/fixtures/rakumachi-listings.html.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { parseDocument, extractJsonLd, findJsonLdByType } from '../../src/parsers/html-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/rakumachi-listings.html');

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertGt(actual: number, min: number, message: string): void {
  assert(actual > min, `${message} (expected > ${min}, got ${actual})`);
}

/** 利回り抽出ロジック (rakumachi.ts と同一) */
function extractYieldRate(text: string): number | null {
  const m = text.match(/利回り[\s:：]*([0-9]+(?:\.[0-9]+)?)\s*%/) ??
            text.match(/([0-9]+(?:\.[0-9]+)?)\s*%\s*(?:利回り|想定)/);
  if (m) {
    const val = parseFloat(m[1]);
    if (!isNaN(val) && val > 0 && val < 50) return val;
  }
  return null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n[rakumachi-parser] parseDocument');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html);
  assert(doc !== null, 'parseDocument returns non-null for valid HTML');
}

console.log('\n[rakumachi-parser] extractJsonLd — item count');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertGt(items.length, 0, 'extractJsonLd returns at least one item');
}

console.log('\n[rakumachi-parser] findJsonLdByType — RealEstateListing nodes');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assertGt(nodes.length, 0, 'at least one RealEstateListing node found');
  assertEquals(nodes.length, 2, 'exactly 2 RealEstateListing nodes in fixture');
}

console.log('\n[rakumachi-parser] first listing — name field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assert(typeof nodes[0]['name'] === 'string' && (nodes[0]['name'] as string).length > 0, 'first node has name');
  assert((nodes[0]['name'] as string).includes('福岡市博多区'), 'first node name contains 福岡市博多区');
}

console.log('\n[rakumachi-parser] first listing — price field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const offer = nodes[0]['offers'] as Record<string, unknown> | undefined;
  assert(offer !== undefined, 'first node has offers');
  const price = parseFloat(String(offer?.['price'] ?? ''));
  assert(!isNaN(price) && price > 0, `price is a positive number (${price})`);
  assertEquals(price, 480000000, 'first listing price is 480000000 JPY (4.8億)');
}

console.log('\n[rakumachi-parser] first listing — floorSize');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const fs_ = nodes[0]['floorSize'] as Record<string, unknown> | undefined;
  assert(fs_ !== undefined, 'first node has floorSize');
  const value = parseFloat(String(fs_?.['value'] ?? ''));
  assert(!isNaN(value) && value > 0, `area value is positive (${value})`);
  assertEquals(value, 310.0, 'first listing area is 310.0m²');
}

console.log('\n[rakumachi-parser] first listing — yieldRate via additionalProperty');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const additionalProp = nodes[0]['additionalProperty'] as Array<Record<string, unknown>> | undefined;
  assert(Array.isArray(additionalProp) && additionalProp.length > 0, 'first node has additionalProperty array');
  const yieldProp = additionalProp?.find(p => typeof p['name'] === 'string' && /利回り/i.test(p['name'] as string));
  assert(yieldProp !== undefined, 'additionalProperty contains 利回り entry');
  assertEquals(yieldProp?.['value'], 10.1, 'yieldRate from additionalProperty is 10.1');
}

console.log('\n[rakumachi-parser] second listing — yieldRate from description text');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  // second node has no additionalProperty — extract from description text
  const desc = nodes[1]['description'] as string ?? '';
  assert(desc.length > 0, 'second node has description');
  const yieldRate = extractYieldRate(desc);
  assertEquals(yieldRate, 8.8, 'yieldRate extracted from description text is 8.8');
}

console.log('\n[rakumachi-parser] first listing — image array');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[0]['image'];
  assert(Array.isArray(img) && (img as string[]).length > 0, 'first node has image array');
  assert((img as string[])[0].startsWith('https://'), 'first image is an https URL');
}

console.log('\n[rakumachi-parser] second listing — image string');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[1]['image'];
  assert(typeof img === 'string' && img.length > 0, 'second node has image string');
}

console.log('\n[rakumachi-parser] DOM parse — og:image in fixture');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  assert(typeof ogImage === 'string' && ogImage.startsWith('https://'), 'og:image meta tag is present and is https URL');
}

console.log('\n[rakumachi-parser] DOM parse — .property card elements present');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('li.property'));
  assertEquals(cards.length, 2, 'fixture has exactly 2 li.property card elements');
}

console.log('\n[rakumachi-parser] DOM parse — card title link');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('li.property'));
  const firstCard = cards[0];
  const linkEl = firstCard.querySelector('a.property-name');
  assert(linkEl !== null, 'first card has a.property-name element');
  const titleText = linkEl?.textContent?.trim() ?? '';
  assert(titleText.length > 0, `card title is non-empty (${titleText})`);
}

console.log('\n[rakumachi-parser] DOM parse — first card yieldRate extraction');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('li.property'));
  const cardText = cards[0].textContent ?? '';
  const yieldRate = extractYieldRate(cardText);
  assert(yieldRate !== null, 'yieldRate extracted from first DOM card');
  assertEquals(yieldRate, 11.5, 'first DOM card yieldRate is 11.5');
}

console.log('\n[rakumachi-parser] DOM parse — second card yieldRate extraction');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('li.property'));
  const cardText = cards[1].textContent ?? '';
  const yieldRate = extractYieldRate(cardText);
  assert(yieldRate !== null, 'yieldRate extracted from second DOM card');
  assertEquals(yieldRate, 9.0, 'second DOM card yieldRate is 9.0');
}

console.log('\n[rakumachi-parser] extractJsonLd — malformed JSON-LD skipped');
{
  const html = '<html><head><script type="application/ld+json">{invalid json}</script></head></html>';
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertEquals(items.length, 0, 'malformed JSON-LD block is silently skipped');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
