/**
 * NFT off-chain metadata.
 *
 * Metadata is fully attacker-controlled: anyone can create a collection and
 * point `metadataUri` at arbitrary JSON. Everything read here is treated as
 * untrusted:
 *
 *   - the document is fetched from a validated https URL only
 *   - the response size is capped
 *   - the content type must be JSON
 *   - every field passes through `lib/sanitize`
 *   - image URLs are re-validated and rendered with `referrerPolicy="no-referrer"`
 *     and `loading="lazy"`
 *   - no HTML is ever injected; descriptions render as plain text
 *
 * A failure here is non-fatal: the card falls back to the exact identities.
 */

import { safeImageUrl, safeLabel, sanitizeNftText } from '../lib/sanitize.js';

const MAX_METADATA_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export interface NftMetadata {
  name: string;
  description?: string;
  /** Validated https image URL, or undefined. */
  image?: string;
  collectionName: string;
  /** True when the source document contained something we stripped. */
  wasAltered: boolean;
  /** Set when metadata could not be read; the item still renders. */
  failure?: string;
}

const cache = new Map<string, NftMetadata>();

export function clearMetadataCache(): void {
  cache.clear();
}

export async function loadNftMetadata(metadataUri: unknown, fallbackCollectionName: string): Promise<NftMetadata> {
  const fallback: NftMetadata = { name: 'Untitled item', collectionName: safeLabel(fallbackCollectionName, 64) || 'Unknown collection', wasAltered: false };
  const url = safeImageUrl(metadataUri);
  if (url === undefined) {
    return { ...fallback, failure: 'The metadata link for this item is missing or is not a permitted https URL.' };
  }
  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const failure = `Metadata host returned HTTP ${response.status}.`;
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number.parseInt(declaredLength, 10) > MAX_METADATA_BYTES) {
      const failure = 'Metadata document is larger than this build will read.';
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType !== '' && !/json/i.test(contentType)) {
      const failure = `Metadata host returned "${safeLabel(contentType, 40)}" instead of JSON.`;
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) {
      const failure = 'Metadata document is larger than this build will read.';
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const failure = 'Metadata document is not valid JSON.';
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const failure = 'Metadata document is not an object.';
      cache.set(url, { ...fallback, failure });
      return { ...fallback, failure };
    }
    const record = parsed as Record<string, unknown>;
    const text_ = sanitizeNftText({
      name: record.name,
      collection: record.collection ?? fallback.collectionName,
      description: record.description,
    });
    const result: NftMetadata = {
      name: text_.name,
      collectionName: text_.collection,
      wasAltered: text_.wasAltered,
    };
    const description = text_.description;
    if (description !== undefined) result.description = description;
    const image = safeImageUrl(record.image);
    if (image !== undefined) result.image = image;
    cache.set(url, result);
    return result;
  } catch (error) {
    const failure = `Metadata could not be read: ${(error as Error).message}`;
    cache.set(url, { ...fallback, failure });
    return { ...fallback, failure };
  } finally {
    clearTimeout(timer);
  }
}
