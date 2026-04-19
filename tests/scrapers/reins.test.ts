/**
 * REINS scraper parse tests (standalone Node runner — no vitest dependency).
 *
 * Run:
 *   cd C:/Users/reale/Downloads/mal-worker && npx tsx tests/scrapers/reins.test.ts
 *
 * The test imports html-parser directly and validates parsing logic
 * against the fixture at tests/fixtures/reins-listings.html.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { parseDocument, extractJsonLd, findJsonLdByType } from '../../src/parsers/html-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/reins-listings.html');

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

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n[reins-parser] parseDocument');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html);
  assert(doc !== null, 'parseDocument returns non-null for valid HTML');
}

console.log('\n[reins-parser] extractJsonLd — item count');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertGt(items.length, 0, 'extractJsonLd returns at least one item');
}

console.log('\n[reins-parser] findJsonLdByType — RealEstateListing nodes');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assertGt(nodes.length, 0, 'at least one RealEstateListing node found');
  assertEquals(nodes.length, 2, 'exactly 2 RealEstateListing nodes in fixture');
}

console.log('\n[reins-parser] first listing — name field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assert(typeof nodes[0]['name'] === 'string' && (nodes[0]['name'] as string).length > 0, 'first node has name');
  assert((nodes[0]['name'] as string).includes('港区'), 'first node name contains 港区');
}

console.log('\n[reins-parser] first listing — price field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const offer = nodes[0]['offers'] as Record<string, unknown> | undefined;
  assert(offer !== undefined, 'first node has offers');
  const price = parseFloat(String(offer?.['price'] ?? ''));
  assert(!isNaN(price) && price > 0, `price is a positive number (${price})`);
  assertEquals(price, 125000000, 'first listing price is 125000000 JPY');
}

console.log('\n[reins-parser] first listing — floorSize');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const fs_ = nodes[0]['floorSize'] as Record<string, unknown> | undefined;
  assert(fs_ !== undefined, 'first node has floorSize');
  const value = parseFloat(String(fs_?.['value'] ?? ''));
  assert(!isNaN(value) && value > 0, `area value is positive (${value})`);
  assertEquals(value, 92.5, 'first listing area is 92.5m²');
}

console.log('\n[reins-parser] first listing — image array');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[0]['image'];
  assert(Array.isArray(img) && (img as string[]).length > 0, 'first node has image array');
  assert((img as string[])[0].startsWith('https://'), 'first image is an https URL');
}

console.log('\n[reins-parser] second listing — image string');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[1]['image'];
  assert(typeof img === 'string' && img.length > 0, 'second node has image string');
}

console.log('\n[reins-parser] first listing — address locality');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const addr = nodes[0]['address'] as Record<string, unknown> | undefined;
  assert(addr !== undefined, 'first node has address');
  assertEquals(addr?.['addressLocality'], '港区', 'first listing locality is 港区');
}

console.log('\n[reins-parser] DOM parse — og:image in fixture');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  assert(typeof ogImage === 'string' && ogImage.startsWith('https://'), 'og:image meta tag is present and is https URL');
}

console.log('\n[reins-parser] DOM parse — bukken-row card elements present');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('tr.bukken-row'));
  assertEquals(cards.length, 2, 'fixture has exactly 2 tr.bukken-row elements');
}

console.log('\n[reins-parser] DOM parse — card title link');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('tr.bukken-row'));
  const firstCard = cards[0];
  const linkEl = firstCard.querySelector('td.name a');
  assert(linkEl !== null, 'first card has td.name a element');
  const titleText = linkEl?.textContent?.trim() ?? '';
  assert(titleText.length > 0, `card title is non-empty (${titleText})`);
}

console.log('\n[reins-parser] DOM parse — card price');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('tr.bukken-row'));
  const priceText = cards[0].querySelector('td.price')?.textContent?.trim() ?? '';
  assert(priceText.includes('万円'), `first card price contains 万円 (${priceText})`);
}

console.log('\n[reins-parser] parseDocument on empty string');
{
  const doc = parseDocument('');
  assert(true, 'parseDocument does not throw on empty string');
}

console.log('\n[reins-parser] extractJsonLd — malformed JSON-LD skipped');
{
  const html = '<html><head><script type="application/ld+json">{invalid json}</script></head></html>';
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertEquals(items.length, 0, 'malformed JSON-LD block is silently skipped');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
