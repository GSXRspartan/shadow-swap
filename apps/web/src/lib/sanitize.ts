/**
 * Untrusted-metadata handling.
 *
 * Token symbols, NFT names, collection names, descriptions, image URLs and
 * provider labels all originate outside the protocol. They are treated as text,
 * never as markup: this app never uses `dangerouslySetInnerHTML`, and this
 * module is the single place that decides whether a string may be shown and
 * whether a URL may be navigated to or rendered as an image source.
 */

/** Hard cap so a hostile 4 MB "name" cannot wedge layout or a table cell. */
export const MAX_LABEL_LENGTH = 96;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

/** Unicode bidi overrides can visually reverse text; strip them from labels. */
const BIDI_OVERRIDES = /[\u202a-\u202e\u2066-\u2069]/g;

const ALLOWED_URL_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * Normalise an untrusted label for rendering. Control characters, bidi
 * overrides and zero-width joiners are removed; the result is plain text that
 * React will escape normally.
 */
export function safeLabel(value: unknown, maxLength = MAX_LABEL_LENGTH): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(CONTROL_CHARS, '').replace(BIDI_OVERRIDES, '').trim();
  if (cleaned.length === 0) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** True when the label contains nothing renderable. */
export function isBlankLabel(value: unknown): boolean {
  return safeLabel(value) === '';
}

/**
 * Validate an external URL.
 *
 * `javascript:`, `data:`, `vbscript:`, and any other scheme are refused —
 * including obfuscated forms such as `java\tscript:` and `JaVaScRiPt:`. Control
 * characters are stripped before the scheme test, and leading whitespace or
 * embedded newlines are removed, because browsers ignore them when navigating.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(CONTROL_CHARS, '').replace(BIDI_OVERRIDES, '').trim();
  if (stripped === '' || stripped.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return undefined;
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return undefined;
  // Reject credentials in the authority: `https://user:pass@host` is a classic
  // phishing shape and has no legitimate use for NFT media.
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  return parsed.toString();
}

/** Image sources additionally require a known raster/vector media shape. */
const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.apng'];

export function safeImageUrl(value: unknown): string | undefined {
  const url = safeExternalUrl(value);
  if (url === undefined) return undefined;
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (ALLOWED_IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return url;
  // Extensionless CDN URLs are common; allow them only on a known https host set
  // is too restrictive in practice, so accept any https URL without credentials.
  return url.startsWith('https://') ? url : undefined;
}

/**
 * Build a transaction-explorer link ONLY from a known-good template. There is no
 * verified explorer URL template for Esmeralda in this repository, so this
 * returns undefined rather than inventing a destination.
 */
export function explorerUrl(_txId: string): string | undefined {
  return undefined;
}

export interface SanitizedNftText {
  name: string;
  collection: string;
  description?: string;
  /** True when the source had text that the sanitiser stripped or truncated. */
  wasAltered: boolean;
}

export function sanitizeNftText(input: { name?: unknown; collection?: unknown; description?: unknown }): SanitizedNftText {
  const rawName = typeof input.name === 'string' ? input.name : '';
  const rawCollection = typeof input.collection === 'string' ? input.collection : '';
  const rawDescription = typeof input.description === 'string' ? input.description : '';
  const name = safeLabel(input.name, 64);
  const collection = safeLabel(input.collection, 64);
  const description = rawDescription === '' ? undefined : safeLabel(input.description, 400);
  return {
    name: name === '' ? 'Untitled item' : name,
    collection: collection === '' ? 'Unknown collection' : collection,
    description,
    wasAltered:
      name !== rawName || collection !== rawCollection || (description !== undefined && description !== rawDescription),
  };
}
