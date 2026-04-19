/**
 * AtHome scraper parse tests (standalone Node runner — no vitest dependency).
 *
 * Run:
 *   npx tsx tests/scrapers/athome.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { parseDocument, extractJsonLd, findJsonLdByType } from '../../src/parsers/html-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/athome-listings.html');

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

console.log('\n[athome-parser] parseDocument');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html);
  assert(doc !== null, 'parseDocument returns non-null for valid HTML');
}

console.log('\n[athome-parser] extractJsonLd — item count');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertGt(items.length, 0, 'extractJsonLd returns at least one item');
}

console.log('\n[athome-parser] findJsonLdByType — RealEstateListing nodes');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assertGt(nodes.length, 0, 'at least one RealEstateListing node found');
  assertEquals(nodes.length, 2, 'exactly 2 RealEstateListing nodes in fixture');
}

console.log('\n[athome-parser] first listing — name field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  assert(typeof nodes[0]['name'] === 'string' && (nodes[0]['name'] as string).length > 0, 'first node has name');
}

console.log('\n[athome-parser] first listing — price field');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const offer = nodes[0]['offers'] as Record<string, unknown> | undefined;
  assert(offer !== undefined, 'first node has offers');
  const price = parseFloat(String(offer?.['price'] ?? ''));
  assert(!isNaN(price) && price > 0, `price is a positive number (${price})`);
}

console.log('\n[athome-parser] first listing — floorSize');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const fs_ = nodes[0]['floorSize'] as Record<string, unknown> | undefined;
  assert(fs_ !== undefined, 'first node has floorSize');
  const value = parseFloat(String(fs_?.['value'] ?? ''));
  assert(!isNaN(value) && value > 0, `area value is positive (${value})`);
}

console.log('\n[athome-parser] first listing — image array');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[0]['image'];
  assert(Array.isArray(img) && (img as string[]).length > 0, 'first node has image array');
}

console.log('\n[athome-parser] second listing — image string');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const img = nodes[1]['image'];
  assert(typeof img === 'string' && img.length > 0, 'second node has image string');
}

console.log('\n[athome-parser] first listing — address locality');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const addr = nodes[0]['address'] as Record<string, unknown> | undefined;
  assert(addr !== undefined, 'first node has address');
  assert(typeof addr?.['addressLocality'] === 'string' && (addr['addressLocality'] as string).length > 0, 'addressLocality is a non-empty string');
}

console.log('\n[athome-parser] first listing — geo coordinates');
{
  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  const nodes = findJsonLdByType(items, 'RealEstateListing');
  const geo = nodes[0]['geo'] as Record<string, unknown> | undefined;
  assert(geo !== undefined, 'first node has geo');
  assert(typeof geo?.['latitude'] === 'number' && typeof geo?.['longitude'] === 'number', 'geo has numeric latitude and longitude');
}

console.log('\n[athome-parser] parseDocument on empty string');
{
  const doc = parseDocument('');
  assert(true, 'parseDocument does not throw on empty string');
}

console.log('\n[athome-parser] extractJsonLd — malformed JSON-LD skipped');
{
  const html = '<html><head><script type="application/ld+json">{invalid json}</script></head></html>';
  const doc = parseDocument(html)!;
  const items = extractJsonLd(doc);
  assertEquals(items.length, 0, 'malformed JSON-LD block is silently skipped');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
