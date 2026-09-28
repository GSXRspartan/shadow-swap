/**
 * Fail-closed endpoint and network identity check for a configured indexer.
 *
 * WHY THIS EXISTS.
 *
 * On 2026-09-27 this app was configured against
 * `https://indexer.esmeralda.tari.com` and
 * `https://indexer-fallback.tari.com`. Both are authoritative NXDOMAIN. The
 * repository had concluded from that alone that "Ootle was unavailable", which
 * was wrong: the network was fine and the *configuration* was stale. Nothing in
 * the app could tell the two cases apart, because the configured URL was never
 * asked what it actually was. A URL that resolves, answers, and reports a
 * network was therefore indistinguishable from one that is a captive portal, a
 * stale record, or a different chain entirely.
 *
 * This module closes that gap. Before discovery is trusted for anything beyond
 * "there is a server there", the endpoint is asked for its own identity and the
 * answer is compared against the network this build is allowed to talk to.
 *
 * THE INVARIANTS THIS MUST NOT BREAK.
 *
 *  1. It is DISCOVERY evidence only. It never authorises an execution input,
 *     never satisfies an authoritative reread, and never becomes settlement
 *     authority. A matching identity proves "this endpoint is the chain this
 *     build expects", not "this data is true".
 *  2. It FAILS CLOSED. An unreachable, unusable, unidentified, or
 *     wrong-network endpoint produces a typed refusal. It never degrades into
 *     "zero pools" or "empty result".
 *  3. UNKNOWN IS NOT SUCCESS AND NOT FAILURE OF THE CHAIN. `UNREACHABLE` says
 *     nothing about whether the network is up.
 *  4. Mainnet is refused unconditionally, before any request is made.
 *
 * The endpoint shape read here is `GET {base}/info`, which the live Esmeralda
 * `tari_indexer` (0.41.4) serves as:
 *
 *   { "version":"0.41.4", "network":"esmeralda", "network_byte":38,
 *     "current_epoch":11602, ... }
 *
 * `network_byte` 38 is 0x26, which is `Network.Esmeralda` in the official Tari
 * SDKs, so both the name and the byte are checked: a hostile or simply wrong
 * endpoint can agree on the easy string while disagreeing on the byte.
 */

import { NETWORK_BYTES, type FrontendNetworkId } from '../lib/networks.js';
import { getJson, type JsonFetchOptions } from './net.js';

/** The canonical identity path on a `tari_indexer` REST API. */
export const INDEXER_IDENTITY_PATH = '/info';

export type IndexerIdentityVerdict =
  | {
      readonly status: 'VERIFIED';
      readonly url: string;
      readonly network: string;
      readonly networkByte: number;
      readonly version: string;
      readonly currentEpoch?: string;
    }
  /** The endpoint could not be reached. Says nothing about the network. */
  | { readonly status: 'UNREACHABLE'; readonly url: string; readonly reason: string }
  /** Reached, but the reply is not a usable identity document. */
  | { readonly status: 'UNUSABLE'; readonly url: string; readonly reason: string }
  /** Reached and readable, but it does not identify itself at all. */
  | { readonly status: 'UNIDENTIFIED'; readonly url: string; readonly reason: string }
  /** Identified, and it is NOT the network this build permits. */
  | { readonly status: 'NETWORK_MISMATCH'; readonly url: string; readonly reason: string };

/** Join a configured base URL with a path without duplicating or dropping the slash. */
export function identityUrl(base: string, path: string = INDEXER_IDENTITY_PATH): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const trimmedBase = base.replace(/\/+$/, '');
  return `${trimmedBase}${path}`;
}

/**
 * Classify a `/info` document already in hand.
 *
 * Split out from the fetch so the decision is directly testable and so a hostile
 * payload can be reasoned about without a network. Every branch is a refusal
 * except a fully-populated, matching identity.
 */
export function classifyIndexerIdentity(
  url: string,
  payload: unknown,
  expected: { readonly network: FrontendNetworkId; readonly networkName: string },
): IndexerIdentityVerdict {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: 'UNUSABLE', url, reason: 'The endpoint identity reply was not a JSON object.' };
  }
  const bag = payload as Record<string, unknown>;
  const name = bag.network;
  const byte = bag.networkByte !== undefined ? bag.networkByte : bag.network_byte;

  if (typeof name !== 'string' || name === '') {
    return { status: 'UNIDENTIFIED', url, reason: 'The endpoint did not report a network name, so its identity cannot be established.' };
  }
  // The byte is required, not optional. A name alone is a self-assertion a
  // substituted endpoint can trivially make; the byte is independent evidence.
  if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0) {
    return { status: 'UNIDENTIFIED', url, reason: 'The endpoint reported a network name but no usable network byte.' };
  }

  const expectedByte = NETWORK_BYTES[expected.network];
  if (name !== expected.networkName || byte !== expectedByte) {
    return {
      status: 'NETWORK_MISMATCH',
      url,
      reason: `The endpoint reports network "${name}" (byte ${byte}). This build is restricted to "${expected.networkName}" (byte ${expectedByte}). Refusing to read it.`,
    };
  }

  const version = typeof bag.version === 'string' && bag.version !== '' ? bag.version : 'unknown';
  const epoch = bag.currentEpoch !== undefined ? bag.currentEpoch : bag.current_epoch;
  const epochText = typeof epoch === 'string' || typeof epoch === 'number' ? String(epoch) : undefined;
  const verdict: {
    status: 'VERIFIED';
    url: string;
    network: string;
    networkByte: number;
    version: string;
    currentEpoch?: string;
  } = { status: 'VERIFIED', url, network: name, networkByte: byte, version };
  if (epochText !== undefined) verdict.currentEpoch = epochText;
  return verdict;
}

/**
 * Read and verify an endpoint's own network identity.
 *
 * Never throws for transport or protocol reasons: every outcome is a typed
 * verdict, so a caller cannot accidentally read a refusal as an empty chain.
 */
export async function verifyIndexerIdentity(
  base: string,
  expected: { readonly network: FrontendNetworkId; readonly networkName: string },
  options: JsonFetchOptions = {},
): Promise<IndexerIdentityVerdict> {
  const url = identityUrl(base);
  if (url === undefined) {
    return { status: 'UNUSABLE', url: base, reason: `The configured indexer URL is not a usable http(s) origin: ${base}` };
  }
  const result = await getJson(url, options);
  if (!result.ok) {
    return { status: 'UNREACHABLE', url, reason: result.reason };
  }
  return classifyIndexerIdentity(url, result.payload, expected);
}

/** True only for a fully verified identity. There is no permissive default. */
export function isVerified(verdict: IndexerIdentityVerdict): verdict is Extract<IndexerIdentityVerdict, { status: 'VERIFIED' }> {
  return verdict.status === 'VERIFIED';
}

/**
 * Human-facing summary for the network/health surfaces.
 *
 * The wording deliberately separates "we could not ask" from "it said the wrong
 * thing", because those are different operator actions.
 */
export function describeIdentity(verdict: IndexerIdentityVerdict): string {
  switch (verdict.status) {
    case 'VERIFIED':
      return `Indexing ${verdict.network} via ${verdict.url} (indexer ${verdict.version}${verdict.currentEpoch === undefined ? '' : `, epoch ${verdict.currentEpoch}`}).`;
    case 'UNREACHABLE':
      return `The indexer at ${verdict.url} could not be read. This says nothing about the network itself: ${verdict.reason}`;
    case 'UNUSABLE':
      return `The indexer at ${verdict.url} did not answer with a usable identity. ${verdict.reason}`;
    case 'UNIDENTIFIED':
      return `The indexer at ${verdict.url} could not be identified. ${verdict.reason}`;
    case 'NETWORK_MISMATCH':
      return `Endpoint refused: ${verdict.reason}`;
  }
}
