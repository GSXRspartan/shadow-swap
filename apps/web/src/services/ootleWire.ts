/**
 * The ONE place an Ootle engine value is taken off the wire.
 *
 * Every indexer and wallet reply that carries a substate value or a transaction
 * receipt goes through here, so there is exactly one implementation of "what does
 * this envelope mean", for every cohort this build supports:
 *
 *   batch entry (`POST /substates/fetch` -> `substates[id]`)
 *     v0.46/0.47  { version, substate: <SubstateValue JSON> }
 *     v0.48       { version, value: "<base64 CBOR SubstateValue>" }
 *
 *   single read (`GET /substates/{id}`, and the Sapient wallet's `tari_getSubstate`,
 *   which returns the indexer's `IndexerGetSubstateResponse` unchanged)
 *     v0.46       { version, substate: <JSON> }
 *     v0.47       { version, state: { up: { substate: <JSON> } } | { down: {} }, verified }
 *     v0.48       { version, state: { up: { substate: "<base64>" } } | { down: {} }, verified }
 *
 *   receipt (`GET /transaction-receipts` -> `receipts[i]`)
 *     ≤ v0.47     [address, { outcome, diff_summary, ... }]
 *     v0.48       [address, "<base64 CBOR TransactionReceipt>"]
 *
 * RULES
 *
 *  1. Base64 values are decoded by the OFFICIAL decoder (`@tari-project/ootle-wasm-bor`,
 *     pinned to the same v0.48.0 release as the templates), which re-serialises the
 *     engine type to the JSON shape the v0.47 indexer served. The protocol-client's
 *     fail-closed decoders therefore see one shape regardless of cohort.
 *  2. Where the caller knows the endpoint's cohort, the entry MUST match it. A v0.48
 *     endpoint that serves a JSON object, or a v0.47 endpoint that serves a string, is
 *     refused rather than coerced.
 *  3. Nothing here returns "empty" for "unreadable". A malformed entry is an error
 *     with a reason; a substate the shard group reports DOWN is reported as DOWN.
 *  4. `verified` is the INDEXER'S OWN CLAIM that it checked the value against a shard
 *     committee proof. Neither this app nor the wallet re-verifies it (the Sapient
 *     wallet requests `include_proof: false`). It is carried through as an assurance
 *     label, never as independent cryptographic verification.
 */

import type { IndexerWireFormat } from '../lib/ootleCohort.js';

/** Decodes the base64 CBOR values the v0.48 indexer serves. Throws on any malformed input. */
export interface ValueCodec {
  decodeSubstateValue(encoded: string): unknown;
  decodeTransactionReceipt(encoded: string): unknown;
  decodeExecuteResult(encoded: string): unknown;
}

/**
 * How much the value's correctness is vouched for. See rule 4.
 *
 *  - `INDEXER_VERIFIED`  the answering indexer reported `verified: true`.
 *  - `UNVERIFIED`        the answering indexer reported `verified: false`.
 *  - `NOT_REPORTED`      the envelope carries no verification field (≤ v0.46 shape, or a
 *                        batch read, which reports none per entry).
 */
export type ReadAssurance = 'INDEXER_VERIFIED' | 'UNVERIFIED' | 'NOT_REPORTED';

export type WireResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface UpSubstate {
  readonly state: 'UP';
  /** Decimal string; `undefined` when the envelope carried none. */
  readonly version?: string;
  /** The `SubstateValue` JSON: `{ Component|Vault|Resource|NonFungible|...: {...} }`. */
  readonly value: Record<string, unknown>;
  readonly assurance: ReadAssurance;
  readonly encoding: 'JSON' | 'CBOR';
}

export interface DownSubstate {
  readonly state: 'DOWN';
  readonly version?: string;
  readonly assurance: ReadAssurance;
}

/* ------------------------------------------------------------------------- *
 * Codec registry.
 *
 * The decoder is WebAssembly and is loaded lazily, on first need, by a loader the
 * application entry point registers (`main.tsx`). Tests register a Node loader. No
 * module under `services/` imports the WASM directly, so the server-render test
 * build never has to resolve a `.wasm` asset.
 * ------------------------------------------------------------------------- */

type CodecLoader = () => Promise<ValueCodec>;

let registeredLoader: CodecLoader | undefined;
let loaded: Promise<ValueCodec> | undefined;

export function registerValueCodecLoader(loader: CodecLoader | undefined): void {
  registeredLoader = loader;
  loaded = undefined;
}

/**
 * The decoder, loading it once. Rejects when no loader is registered or the module
 * fails to load; callers turn that into an explicit "could not decode" outcome.
 */
export async function getValueCodec(): Promise<ValueCodec> {
  if (registeredLoader === undefined) {
    throw new Error('No Ootle value decoder is available in this build, so CBOR-encoded chain values cannot be read.');
  }
  if (loaded === undefined) {
    const attempt = registeredLoader();
    loaded = attempt;
    // A failed load must not be cached forever: a transient fetch failure of the
    // decoder asset would otherwise disable every v0.48 read for the session.
    attempt.catch(() => {
      if (loaded === attempt) loaded = undefined;
    });
  }
  return loaded;
}

/* ------------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** u64 version as a decimal string, from a JSON number (safe range only) or digit string. */
function versionText(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value;
  return undefined;
}

/**
 * Standard base64 (RFC 4648 §4), as `serde` renders `Encoded<T>`. Bounded so a
 * hostile endpoint cannot hand the decoder an arbitrarily large string; the
 * transport already caps the whole body, this caps a single value.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const MAX_ENCODED_VALUE_CHARS = 1_500_000;

function checkBase64(encoded: string, what: string): string | undefined {
  if (encoded.length === 0) return `${what} is an empty encoding.`;
  if (encoded.length > MAX_ENCODED_VALUE_CHARS) return `${what} exceeds the ${MAX_ENCODED_VALUE_CHARS}-character bound for one encoded value.`;
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return `${what} is not standard base64.`;
  return undefined;
}

/** The decoded `SubstateValue` must be a single-variant object such as `{ Component: {...} }`. */
const SUBSTATE_VARIANTS: ReadonlySet<string> = new Set([
  'Component',
  'Resource',
  'Vault',
  'NonFungible',
  'ClaimedOutputTombstone',
  'TransactionReceipt',
  'Template',
  'ValidatorFeePool',
  'Utxo',
  'ConfidentialOutput',
]);

function checkSubstateValue(value: unknown, what: string): WireResult<Record<string, unknown>> {
  const bag = record(value);
  if (bag === undefined) return { ok: false, reason: `${what} is not a substate value object.` };
  const keys = Object.keys(bag);
  if (keys.length !== 1 || !SUBSTATE_VARIANTS.has(keys[0] as string)) {
    return { ok: false, reason: `${what} is not a recognised SubstateValue variant (${keys.slice(0, 4).join(',') || 'no keys'}).` };
  }
  return { ok: true, value: bag };
}

function decodeSubstate(encoded: string, codec: ValueCodec, what: string): WireResult<Record<string, unknown>> {
  const bad = checkBase64(encoded, what);
  if (bad !== undefined) return { ok: false, reason: bad };
  let decoded: unknown;
  try {
    decoded = codec.decodeSubstateValue(encoded);
  } catch (error) {
    return { ok: false, reason: `${what} is not a complete CBOR SubstateValue: ${(error as Error).message}` };
  }
  return checkSubstateValue(decoded, what);
}

/**
 * One `POST /substates/fetch` map entry.
 *
 * `format` is the cohort the endpoint declared at `GET /info`; the entry must match it.
 */
export function normalizeBatchEntry(raw: unknown, format: IndexerWireFormat, codec: ValueCodec | undefined, what = 'substate'): WireResult<UpSubstate> {
  const entry = record(raw);
  if (entry === undefined) return { ok: false, reason: `${what}: the batch entry is not an object.` };
  const version = versionText(entry.version);
  if (format === 'CBOR_VALUES') {
    if (typeof entry.value !== 'string') {
      return { ok: false, reason: `${what}: a v0.48 endpoint must serve the value as a base64 CBOR string; it did not.` };
    }
    if (codec === undefined) return { ok: false, reason: `${what}: no CBOR decoder is loaded.` };
    const decoded = decodeSubstate(entry.value, codec, what);
    if (!decoded.ok) return decoded;
    return { ok: true, value: { state: 'UP', version, value: decoded.value, assurance: 'NOT_REPORTED', encoding: 'CBOR' } };
  }
  if (typeof entry.value === 'string') {
    return { ok: false, reason: `${what}: a pre-v0.48 endpoint served a CBOR string; the reply does not match the version it reported.` };
  }
  const checked = checkSubstateValue(entry.substate, `${what}.substate`);
  if (!checked.ok) return checked;
  return { ok: true, value: { state: 'UP', version, value: checked.value, assurance: 'NOT_REPORTED', encoding: 'JSON' } };
}

/**
 * A single-substate envelope whose cohort is NOT declared by the caller (a wallet reply).
 *
 * The shape itself selects the decoding, and every recognised shape is strict. An
 * unrecognised shape is an error naming what was received, never a guess.
 */
export function normalizeSingleSubstate(raw: unknown, codec: ValueCodec | undefined, what = 'substate'): WireResult<UpSubstate | DownSubstate> {
  const bag = record(raw);
  if (bag === undefined) return { ok: false, reason: `${what}: the reply is not an object.` };
  const version = versionText(bag.version);
  const assurance: ReadAssurance = bag.verified === true ? 'INDEXER_VERIFIED' : bag.verified === false ? 'UNVERIFIED' : 'NOT_REPORTED';

  const state = record(bag.state);
  if (state !== undefined) {
    // v0.47 / v0.48: { state: { up: { substate } } | { down: {} } }
    if (record(state.down) !== undefined && state.up === undefined) {
      return { ok: true, value: { state: 'DOWN', version, assurance } };
    }
    const up = record(state.up);
    if (up === undefined) return { ok: false, reason: `${what}: the reply's state is neither up nor down.` };
    if (typeof up.substate === 'string') {
      if (codec === undefined) return { ok: false, reason: `${what}: no CBOR decoder is loaded.` };
      const decoded = decodeSubstate(up.substate, codec, what);
      if (!decoded.ok) return decoded;
      return { ok: true, value: { state: 'UP', version, value: decoded.value, assurance, encoding: 'CBOR' } };
    }
    const checked = checkSubstateValue(up.substate, `${what}.state.up.substate`);
    if (!checked.ok) return checked;
    return { ok: true, value: { state: 'UP', version, value: checked.value, assurance, encoding: 'JSON' } };
  }

  if (bag.substate !== undefined) {
    // v0.46: { version, substate: <JSON> }. A legacy WRAPPER `{ substate: { substate } }`
    // some providers used is accepted one level deep and no further.
    const direct = checkSubstateValue(bag.substate, `${what}.substate`);
    if (direct.ok) return { ok: true, value: { state: 'UP', version, value: direct.value, assurance, encoding: 'JSON' } };
    const inner = record(bag.substate);
    if (inner !== undefined && inner.substate !== undefined) {
      const nested = checkSubstateValue(inner.substate, `${what}.substate.substate`);
      if (nested.ok) {
        return { ok: true, value: { state: 'UP', version: version ?? versionText(inner.version), value: nested.value, assurance, encoding: 'JSON' } };
      }
    }
    return direct;
  }

  // A bare SubstateValue (`{ Component: {...} }`) with no envelope.
  const bare = checkSubstateValue(bag, what);
  if (bare.ok) return { ok: true, value: { state: 'UP', version: undefined, value: bare.value, assurance: 'NOT_REPORTED', encoding: 'JSON' } };
  return { ok: false, reason: `${what}: unrecognised substate envelope (keys: ${Object.keys(bag).slice(0, 6).join(',') || 'none'}).` };
}

export interface NormalizedReceipt {
  readonly address: string;
  readonly receipt: Record<string, unknown>;
}

/**
 * One `GET /transaction-receipts` element, `[address, receipt]`.
 *
 * The receipt is returned decoded; the caller still validates the fields it reads.
 */
export function normalizeReceipt(raw: unknown, format: IndexerWireFormat, codec: ValueCodec | undefined): WireResult<NormalizedReceipt> {
  if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, reason: 'A receipt entry is not an [address, receipt] pair.' };
  const [address, body] = raw as [unknown, unknown];
  if (typeof address !== 'string' || address === '') return { ok: false, reason: 'A receipt entry carries no address.' };
  if (format === 'CBOR_VALUES') {
    if (typeof body !== 'string') return { ok: false, reason: `Receipt ${address}: a v0.48 endpoint must serve it as a base64 CBOR string.` };
    if (codec === undefined) return { ok: false, reason: `Receipt ${address}: no CBOR decoder is loaded.` };
    const bad = checkBase64(body, `Receipt ${address}`);
    if (bad !== undefined) return { ok: false, reason: bad };
    let decoded: unknown;
    try {
      decoded = codec.decodeTransactionReceipt(body);
    } catch (error) {
      return { ok: false, reason: `Receipt ${address} is not a complete CBOR TransactionReceipt: ${(error as Error).message}` };
    }
    const receipt = record(decoded);
    if (receipt === undefined) return { ok: false, reason: `Receipt ${address} decoded to a non-object.` };
    return { ok: true, value: { address, receipt } };
  }
  if (typeof body === 'string') {
    return { ok: false, reason: `Receipt ${address}: a pre-v0.48 endpoint served a CBOR string; the reply does not match the version it reported.` };
  }
  const receipt = record(body);
  if (receipt === undefined) return { ok: false, reason: `Receipt ${address} is not an object.` };
  return { ok: true, value: { address, receipt } };
}

/** Load the codec only when the declared format needs it. */
export async function codecFor(format: IndexerWireFormat): Promise<WireResult<ValueCodec | undefined>> {
  if (format === 'JSON_VALUES') return { ok: true, value: undefined };
  try {
    return { ok: true, value: await getValueCodec() };
  } catch (error) {
    return { ok: false, reason: `The CBOR value decoder could not be loaded: ${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * Transaction outcome.
 *
 * The Sapient wallet's `tari_getTransactionResult` returns the indexer's
 * `IndexerGetTransactionResultResponse` unchanged:
 *
 *   { result: "Pending"
 *           | { Finalized: { final_decision: "Commit" | { Abort: reason },
 *                            execution_result: <ExecuteResult JSON> | "<base64>" | null,
 *                            abort_details: string | null, ... } }
 *           | { Rejected: { details, rejected_time } } }
 *
 * `final_decision: "Commit"` alone does NOT mean the requested operation happened. A
 * transaction commits with `finalize.result = AcceptFeeRejectRest` when its fee intent
 * is applied and everything else is rejected: the fee is gone and the swap is not. The
 * outcome is therefore COMMITTED only when the execution result itself says `Accept`.
 * Anything that cannot be established is UNKNOWN — never success.
 * ------------------------------------------------------------------------- */

export type TransactionOutcome =
  | { readonly status: 'COMMITTED' }
  | { readonly status: 'FEE_ONLY'; readonly reason: string }
  | { readonly status: 'REJECTED'; readonly reason: string }
  | { readonly status: 'PENDING' }
  | { readonly status: 'UNKNOWN'; readonly reason: string };

function describeReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  const bag = record(reason);
  if (bag === undefined) return 'unrecognised reason';
  const [key] = Object.keys(bag);
  if (key === undefined) return 'unrecognised reason';
  const inner = bag[key];
  const code = record(inner)?.code;
  const message = record(inner)?.message ?? (typeof inner === 'string' ? inner : undefined);
  return [key, typeof code === 'string' ? `(${code})` : '', typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''].join('');
}

/** Classify `finalize.result` of an ExecuteResult JSON. */
export function outcomeOfExecuteResult(executeResult: unknown): TransactionOutcome {
  const finalize = record(record(executeResult)?.finalize);
  const result = finalize?.result;
  if (result === 'Accept') return { status: 'COMMITTED' };
  const bag = record(result);
  if (bag === undefined) return { status: 'UNKNOWN', reason: 'The execution result carries no transaction result.' };
  if ('Accept' in bag && Object.keys(bag).length === 1) return { status: 'COMMITTED' };
  if ('AcceptFeeRejectRest' in bag) {
    const pair = bag.AcceptFeeRejectRest;
    const reason = Array.isArray(pair) ? describeReason(pair[1]) : 'reason not reported';
    return { status: 'FEE_ONLY', reason: `Only the fee was taken; the operation itself was rejected (${reason}).` };
  }
  if ('Reject' in bag) return { status: 'REJECTED', reason: `Rejected: ${describeReason(bag.Reject)}` };
  return { status: 'UNKNOWN', reason: 'The execution result names an unrecognised transaction result.' };
}

/**
 * Interpret an `IndexerGetTransactionResultResponse`-shaped reply. Returns `undefined`
 * when the reply is not that shape, so the caller can fall back to the flat
 * `{ status }` shape other providers use.
 */
export function interpretIndexerTransactionResult(reply: unknown, codec: ValueCodec | undefined): TransactionOutcome | undefined {
  const bag = record(reply);
  if (bag === undefined || !('result' in bag)) return undefined;
  const result = bag.result;
  if (result === 'Pending') return { status: 'PENDING' };
  const outer = record(result);
  if (outer === undefined) return { status: 'UNKNOWN', reason: 'The transaction result is neither pending, finalized nor rejected.' };
  const rejected = record(outer.Rejected);
  if (rejected !== undefined) {
    return { status: 'REJECTED', reason: typeof rejected.details === 'string' ? `Rejected before execution: ${rejected.details.slice(0, 200)}` : 'Rejected before execution.' };
  }
  const finalized = record(outer.Finalized);
  if (finalized === undefined) return { status: 'UNKNOWN', reason: 'The transaction result is neither pending, finalized nor rejected.' };
  const decision = finalized.final_decision;
  if (decision !== 'Commit') {
    const abort = record(decision)?.Abort;
    const detail = typeof finalized.abort_details === 'string' ? `: ${finalized.abort_details.slice(0, 200)}` : '';
    return abort === undefined
      ? { status: 'UNKNOWN', reason: 'The finalized decision is unrecognised.' }
      : { status: 'REJECTED', reason: `Aborted by consensus (${describeReason(abort)})${detail}` };
  }
  const execution = finalized.execution_result;
  if (execution === null || execution === undefined) {
    return { status: 'UNKNOWN', reason: 'Committed, but no execution result was served, so whether the operation itself (and not only its fee) applied cannot be established.' };
  }
  if (typeof execution === 'string') {
    if (codec === undefined) return { status: 'UNKNOWN', reason: 'Committed, but the CBOR execution result could not be decoded in this session.' };
    const bad = checkBase64(execution, 'The execution result');
    if (bad !== undefined) return { status: 'UNKNOWN', reason: bad };
    try {
      return outcomeOfExecuteResult(codec.decodeExecuteResult(execution));
    } catch (error) {
      return { status: 'UNKNOWN', reason: `Committed, but the execution result is undecodable: ${(error as Error).message}` };
    }
  }
  return outcomeOfExecuteResult(execution);
}
