/**
 * HOME'S scraper parse tests (standalone Node runner — no vitest dependency).
 *
 * Run:
 *   cd C:/Users/reale/Downloads/mal-worker && npx tsx tests/scrapers/homes.test.ts
 *
 * The test imports html-parser directly and validates parsing logic
 * against the fixture at tests/fixtures/homes-listings.html.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { parseDocument, extractJsonLd, findJsonLdByType } from '../../src/parsers/html-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/homes-listings.html');

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

console.log('\n[homes-parser] parseDocument');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html);
  assert(doc !== null, 'parseDocument returns non-null for valid HTML');
}

console.log('\n[homes-parser] extractJsonLd — item count');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  // Fixture has 1 script tag containing an array of 2 RealEstateListing nodes
  assertGt(items.length, 0, 'extractJsonLd returns at least one item');
}

console.log('\n[homes-parser] findJsonLdByType — RealEstateListing nodes');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assertGt(nodes.length, 0, 'at least one RealEstateListing node found');
  assertEquals(nodes.length, 2, 'exactly 2 RealEstateListing nodes in fixture');
}

console.log('\n[homes-parser] first listing — name field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assert(typeof nodes[0]['name'] === 'string' && (nodes[0]['name'] as string).length > 0, 'first node has name');
  assert((nodes[0]['name'] as string).includes('渋谷区'), 'first node name contains 渋谷区');
}

console.log('\n[homes-parser] first listing — price field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const offer = nodes[0]['offers'] as Record<string, unknown> | undefined;
  assert(offer !== undefined, 'first node has offers');
  const price = parseFloat(String(offer?.['price'] ?? ''));
  assert(!isNaN(price) && price > 0, `price is a positive number (${price})`);
  assertEquals(price, 92000000, 'first listing price is 92000000 JPY');
}

console.log('\n[homes-parser] first listing — floorSize');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const fs_ = nodes[0]['floorSize'] as Record<string, unknown> | undefined;
  assert(fs_ !== undefined, 'first node has floorSize');
  const value = parseFloat(String(fs_?.['value'] ?? ''));
  assert(!isNaN(value) && value > 0, `area value is positive (${value})`);
  assertEquals(value, 78.4, 'first listing area is 78.4m²');
}

console.log('\n[homes-parser] first listing — image array');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[0]['image'];
  assert(Array.isArray(img) && (img as string[]).length > 0, 'first node has image array');
  assert((img as string[])[0].startsWith('https://'), 'first image is an https URL');
}

console.log('\n[homes-parser] second listing — image string');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[1]['image'];
  assert(typeof img === 'string' && img.length > 0, 'second node has image string');
}

console.log('\n[homes-parser] first listing — address locality');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const addr = nodes[0]['address'] as Record<string, unknown> | undefined;
  assert(addr !== undefined, 'first node has address');
  assertEquals(addr?.['addressLocality'], '渋谷区', 'first listing locality is 渋谷区');
}

console.log('\n[homes-parser] DOM parse — og:image in fixture');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  assert(typeof ogImage === 'string' && ogImage.startsWith('https://'), 'og:image meta tag is present and is https URL');
}

console.log('\n[homes-parser] DOM parse — card elements present');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('.mod-mergeBuilding--sale'));
  assertEquals(cards.length, 2, 'fixture has exactly 2 CSS card elements');
}

console.log('\n[homes-parser] DOM parse — card title link');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('.mod-mergeBuilding--sale'));
  const firstCard = cards[0];
  const linkEl = firstCard.querySelector('.bukkenName a');
  assert(linkEl !== null, 'first card has .bukkenName a element');
  const titleText = linkEl?.textContent?.trim() ?? '';
  assert(titleText.length > 0, `card title is non-empty (${titleText})`);
}

console.log('\n[homes-parser] DOM parse — card price label');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const cards = Array.from(doc.querySelectorAll('.mod-mergeBuilding--sale'));
  const priceText = cards[0].querySelector('.priceLabel')?.textContent?.trim() ?? '';
  assert(priceText.includes('万円'), `first card price label contains 万円 (${priceText})`);
}

console.log('\n[homes-parser] parseDocument on empty string');
{
  const doc = parseDocument('');
  assert(true, 'parseDocument does not throw on empty string');
}

console.log('\n[homes-parser] extractJsonLd — malformed JSON-LD skipped');
{
  const html = '<html><head><script type="application/ld+json">{invalid json}</script></head></html>';
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertEquals(items.length, 0, 'malformed JSON-LD block is silently skipped');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
