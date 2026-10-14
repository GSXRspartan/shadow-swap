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
 *  4. RATE LIMITS LOOK LIKE OUTAGES. Ootle v0.46.0 put rate limits on ALL public
 *     indexer read routes (#2823). A throttled request answers HTTP 429, which
 *     used to collapse into the same "the endpoint returned HTTP 429" text as any
 *     other failure — so a burst this app itself caused was rendered as the indexer
 *     being unavailable. That is a different fact with a different remedy, and
 *     reporting it as an outage would blame the host for the app's own request rate.
 *
 * `postJson` therefore always terminates, always caps what it buffers, and
 * returns a reason string for every non-success so the caller can render the
 * truth. A 429 is retried at most `RATE_LIMIT_RETRIES` times, honouring
 * `Retry-After` when the host sends one, and if it still does not get through it
 * is reported as `rateLimited` so the caller can say "throttled" rather than
 * "unavailable". The reason is human-facing text; it never embeds a response body.
 */

import { safeLabel } from '../lib/sanitize.js';

/** Long enough for a cold indexer, short enough that a hung host still reports. */
export const DISCOVERY_TIMEOUT_MS = 12_000;

/** Two megabytes is far above any legitimate discovery page and far below a DoS. */
export const MAX_DISCOVERY_BYTES = 2_000_000;

/**
 * How many times a throttled request is retried, and the longest we will wait.
 *
 * Bounded on purpose. Discovery already issues a burst of pages, and an unbounded
 * retry against a rate limiter converts a throttle into an outage by making it worse.
 */
export const RATE_LIMIT_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 4_000;

export interface JsonFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Optional `AbortSignal` owned by the caller (route change, unmount). */
  signal?: AbortSignal;
}

export type JsonFetchResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string; readonly rateLimited?: boolean };

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


/**
 * How long to wait before retrying a throttled request.
 *
 * Honours `Retry-After` when the host sends a usable one, because ignoring it and
 * retrying on our own schedule is precisely what a rate limiter is asking us not to do.
 * Anything unparseable or longer than `MAX_RETRY_AFTER_MS` falls back to a short
 * exponential backoff rather than an unbounded wait inside a user-facing request.
 */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return 250 * 2 ** attempt;
}

async function requestJson(url: string, init: RequestInit, options: JsonFetchOptions): Promise<JsonFetchResult> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await requestJsonOnce(url, init, options);
    // Only a throttle is retried. Every other failure is already terminal, and
    // retrying one would turn a clear answer into a slower unclear one.
    if (outcome.ok || outcome.rateLimited !== true || attempt >= RATE_LIMIT_RETRIES) return outcome;
    if (options.signal?.aborted === true) return outcome;
    await new Promise((resolve) => setTimeout(resolve, outcome.retryAfterMs ?? 250 * 2 ** attempt));
  }
}

async function requestJsonOnce(url: string, init: RequestInit, options: JsonFetchOptions): Promise<JsonFetchResult & { retryAfterMs?: number }> {
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
        headers: {
          // `Content-Type` describes a request BODY. Sending it on a bodyless
          // GET makes the request non-simple, which forces the browser into a
          // CORS preflight round-trip for a request that has nothing to say.
          // That is a real cost on every network-identity check, and it makes
          // discovery depend on preflight support it does not otherwise need.
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, reason: reason(`The discovery endpoint did not answer within ${deadlineSeconds}s. It may be overloaded or offline.`) };
      }
      return { ok: false, reason: reason(`The discovery request failed (${describeError(error)}).`) };
    }
    if (!response.ok) {
      if (response.status === 429) {
        // Distinct from every other failure: the host is up and answering, this app was
        // simply asking too fast. Saying "unavailable" here would be a false claim about
        // the network.
        return {
          ok: false,
          rateLimited: true,
          retryAfterMs: retryAfterMs(response, 0),
          reason: reason('The discovery endpoint is rate-limiting this client. Try again shortly.'),
        };
      }
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
