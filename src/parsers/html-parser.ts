/**
 * html-parser.ts
 * Lightweight linkedom wrapper for Cloudflare Workers-safe HTML parsing.
 * Workers CPU budget: keep DOM operations minimal.
 */
import { parseHTML } from 'linkedom';

export type ParsedDocument = ReturnType<typeof parseHTML>['document'];

/**
 * Parse an HTML string into a linkedom Document.
 * Returns null on parse failure instead of throwing.
 */
export function parseDocument(html: string): ParsedDocument | null {
  try {
    return parseHTML(html).document;
  } catch {
    return null;
  }
}

/**
 * Extract all <script type="application/ld+json"> blocks from a document
 * and return their parsed JSON values. Silently skips malformed blocks.
 */
export function extractJsonLd(doc: ParsedDocument): unknown[] {
  const results: unknown[] = [];
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    try {
      const text = script.textContent ?? '';
      if (text.trim()) results.push(JSON.parse(text));
    } catch {
      // skip malformed JSON-LD
    }
  }
  return results;
}

/** Recursively walk JSON-LD graph (handles @graph arrays). */
function flatten(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const obj = node as Record<string, unknown>;
  const items: unknown[] = [obj];
  if (Array.isArray(obj['@graph'])) items.push(...flatten(obj['@graph']));
  return items;
}

/**
 * Find all JSON-LD nodes matching one of the given @types.
 * Handles both string types and arrays (e.g. ["Product", "RealEstateListing"]).
 */
export function findJsonLdByType(
  items: unknown[],
  ...types: string[]
): Record<string, unknown>[] {
  const typeSet = new Set(types);
  return items
    .flatMap(flatten)
    .filter((n): n is Record<string, unknown> => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) return false;
      const t = (n as Record<string, unknown>)['@type'];
      if (typeof t === 'string') return typeSet.has(t);
      if (Array.isArray(t)) return t.some(v => typeSet.has(v));
      return false;
    });
}

/**
 * Safely get text content of the first element matching selector.
 * Returns trimmed string or null.
 */
export function queryText(doc: ParsedDocument, selector: string): string | null {
  const el = doc.querySelector(selector);
  const text = el?.textContent?.trim();
  return text || null;
}

/**
 * Get trimmed text for all matching elements.
 */
export function queryAllText(doc: ParsedDocument, selector: string): string[] {
  return Array.from(doc.querySelectorAll(selector))
    .map(el => el.textContent?.trim() ?? '')
    .filter(Boolean);
}

/**
 * Get attribute value of first matching element.
 */
export function queryAttr(
  doc: ParsedDocument,
  selector: string,
  attr: string
): string | null {
  const el = doc.querySelector(selector);
  return el?.getAttribute(attr) ?? null;
}

/**
 * Get all attribute values for matching elements.
 */
export function queryAllAttr(
  doc: ParsedDocument,
  selector: string,
  attr: string
): string[] {
  return Array.from(doc.querySelectorAll(selector))
    .map(el => el.getAttribute(attr) ?? '')
    .filter(Boolean);
}
