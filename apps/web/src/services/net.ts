/**
 * Bounded JSON transport for discovery endpoints.
 *
 * Pool and NFT discovery are the only two places the browser talks to an
 * operator-controlled host, and both previously used a bare `fetch`. That has
 * three failure modes that matter when the indexer is degraded rather than
 * cleanly dead — which is the normal state of a public testnet:
 *
 *  1. NO DEADLINE. A host that accepts the TCP connection and then never
 *     answers leaves the promise pending forever. The pool list then shows a
 *     permanent loading state instead of the outage state, and the user cannot
 *     tell "slow" from "broken" from "empty".
 *  2. NO SIZE CAP. `response.json()` buffers the entire body. A hostile or
 *     misconfigured endpoint can return hundreds of megabytes and exhaust the
 *     tab; the metadata reader caps its body but discovery did not.
 *  3. SWALLOWED REASONS. A failed fetch collapsed to the same value as a
 *     successful query that legitimately returned zero records, so the UI was
 *     forced to say "no pools" about data it never received. That is the exact
 *     class of dishonest empty state this app refuses to produce.
 *
 * `postJson` therefore always terminates, always caps what it buffers, and
 * returns a reason string for every non-success so the caller can render the
 * truth. The reason is human-facing text; it never embeds a response body.
 */

import { safeLabel } from '../lib/sanitize.js';

/** Long enough for a cold indexer, short enough that a hung host still reports. */
export const DISCOVERY_TIMEOUT_MS = 12_000;

/** Two megabytes is far above any legitimate discovery page and far below a DoS. */
export const MAX_DISCOVERY_BYTES = 2_000_000;

export interface JsonFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Optional `AbortSignal` owned by the caller (route change, unmount). */
  signal?: AbortSignal;
}

export type JsonFetchResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string };

function reason(text: string): string {
  // Reasons reach the UI verbatim, so they are sanitised and length-clamped.
  return safeLabel(text, 220);
}

/** A short, safe description of a thrown error that never echoes a body. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name === 'Error' ? 'error' : error.name;
    const detail = safeLabel(error.message, 120);
    return detail === '' ? name : `${name}: ${detail}`;
  }
  return `value of type ${typeof error}`;
}

/**
 * POST a JSON envelope and read a capped JSON document.
 *
 * Never throws for transport reasons: every failure is a `{ ok: false, reason }`
 * so the caller cannot accidentally treat an outage as an empty result.
 */
export async function postJson(url: string, body: unknown, options: JsonFetchOptions = {}): Promise<JsonFetchResult> {
  return requestJson(url, { method: 'POST', body: JSON.stringify(body) }, options);
}

/** The same contract for a plain GET. */
export async function getJson(url: string, options: JsonFetchOptions = {}): Promise<JsonFetchResult> {
  return requestJson(url, { method: 'GET' }, options);
}


async function requestJson(url: string, init: RequestInit, options: JsonFetchOptions): Promise<JsonFetchResult> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DISCOVERY_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('discovery-timeout')), timeoutMs);
  const abortFromOwner = () => controller.abort(new Error('discovery-cancelled-by-owner'));
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { ok: false, reason: reason('The request was cancelled before it was sent.') };
    }
    options.signal.addEventListener('abort', abortFromOwner, { once: true });
  }
  const deadlineSeconds = Math.round(timeoutMs / 1000);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, reason: reason(`The discovery endpoint did not answer within ${deadlineSeconds}s. It may be overloaded or offline.`) };
      }
      return { ok: false, reason: reason(`The discovery request failed (${describeError(error)}).`) };
    }
    if (!response.ok) {
      return { ok: false, reason: reason(`The discovery endpoint returned HTTP ${response.status}.`) };
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number.parseInt(declared, 10) > maxBytes) {
      return { ok: false, reason: reason(`The discovery response is larger than this build will read (${declared} bytes declared).`) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, reason: reason(`The discovery endpoint stopped answering mid-response after ${deadlineSeconds}s.`) };
      }
      return { ok: false, reason: reason(`The discovery response body could not be read (${describeError(error)}).`) };
    }
    if (text.length > maxBytes) {
      return { ok: false, reason: reason(`The discovery response exceeded the ${maxBytes} byte read limit.`) };
    }
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: false, reason: reason('The discovery endpoint returned a body that is not valid JSON.') };
    }
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) options.signal.removeEventListener('abort', abortFromOwner);
  }
}

/**
 * Extract the record list from the two shapes discovery endpoints use, or
 * explain why the payload is unusable. A missing list is a protocol mismatch,
 * never an empty list.
 */
export function discoveryList(payload: unknown): { readonly ok: true; readonly list: unknown[] } | { readonly ok: false; readonly reason: string } {
  if (Array.isArray(payload)) return { ok: true, list: payload };
  if (typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)) {
    return { ok: true, list: (payload as { data: unknown[] }).data };
  }
  return { ok: false, reason: reason('The discovery response did not contain a record list.') };
}
