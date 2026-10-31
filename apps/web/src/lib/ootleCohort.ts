/**
 * Which Ootle release cohort an indexer belongs to, and what that implies.
 *
 * WHY THIS EXISTS
 *
 * Every Ootle minor release since v0.46 changed what the indexer puts on the wire,
 * and v0.48.0 (2026-10-29) was a TESTNET RESET as well:
 *
 *   - v0.46.x  `POST /substates/fetch` entries are `{ version, substate: <SubstateValue JSON> }`.
 *   - v0.47.x  `GET /substates/{id}` answers `{ version, state: { up: { substate: <JSON> } }, verified }`.
 *   - v0.48.x  every engine value is its CBOR encoding, base64 in JSON:
 *              batch entries are `{ version, value: "<base64>" }`, receipts are
 *              `[address, "<base64>"]`, and `state.up.substate` is a base64 string.
 *              Esmeralda's protocol history collapses to a fresh V0 genesis, every
 *              validator/indexer/wallet database restarts, and templates must be
 *              REPUBLISHED (`crates/engine_types/src/protocol_version.rs` at
 *              `6a25dbc`). The public indexers move to `esme-indexer-{a,b}.ootle.tari.com`.
 *
 * A client that guesses the format reads a v0.48 receipt (a string) as "not a receipt",
 * skips it, and reports a deployed protocol as EMPTY. That is a silent false negative,
 * and it is exactly what the pre-v0.48 discovery code did. So the format is derived
 * from the endpoint's own reported version and then ENFORCED per entry: a value whose
 * shape disagrees with the declared cohort is refused, never coerced.
 *
 * The GENERATION matters for a different reason. Addresses do not survive a reset: a
 * component, template or vault recorded on pre-v0.48 Esmeralda names nothing on the
 * reset network. Every pinned address in this repository is therefore bound to the
 * generation it was observed on, and is only ever consulted against an indexer of
 * that same generation.
 *
 * An unknown version FAILS CLOSED. A newer minor has broken the wire format three
 * releases running; reading one this build has not been verified against would be a
 * guess about money-adjacent data.
 */

export type IndexerWireFormat =
  /** v0.41–v0.47: engine values are rendered as JSON by the indexer. */
  | 'JSON_VALUES'
  /** v0.48: engine values are CBOR, base64 in JSON, decoded client-side. */
  | 'CBOR_VALUES';

export type NetworkGeneration =
  /** Esmeralda as it ran up to and including v0.47.x (Protocol V2 from epoch 12220). */
  | 'PRE_V048_RESET'
  /** The network that starts over at the v0.48.0 reset (single V0 genesis). */
  | 'V048_RESET';

export interface IndexerCohort {
  /** The exact version string the endpoint reported. */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly generation: NetworkGeneration;
  readonly wireFormat: IndexerWireFormat;
}

/** Human-readable range, used in refusals and in the documentation. */
export const SUPPORTED_INDEXER_RANGE = '0.41.x through 0.48.x';

/** The cohort this build's templates and engine tests are pinned to. */
export const PINNED_OOTLE_RELEASE = {
  tag: 'v0.48.0',
  commit: '6a25dbc524581bfaa0a3c6ef120f8d59cc827572',
  published: '2026-10-29',
} as const;

const VERSION = /^v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.+-]{0,64})?$/;

export type CohortClassification =
  | { readonly ok: true; readonly cohort: IndexerCohort }
  | { readonly ok: false; readonly reason: string };

/**
 * Classify a `GET /info` `version` value.
 *
 * Accepts `0.48.0`, `0.48.1`, `v0.47.0`, and pre-release/build suffixes on a known
 * minor (`0.48.0-rc.1`). Refuses anything else, including a missing value: the wire
 * format cannot be known without it.
 */
export function classifyIndexerVersion(version: unknown): CohortClassification {
  if (typeof version !== 'string' || version.trim() === '') {
    return { ok: false, reason: 'The endpoint did not report its software version, so the format of its replies cannot be established.' };
  }
  const text = version.trim();
  const match = VERSION.exec(text);
  if (match === null) {
    return { ok: false, reason: `The endpoint reported an unparseable version "${text.slice(0, 80)}".` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor === 48) {
    return { ok: true, cohort: { version: text, major, minor, generation: 'V048_RESET', wireFormat: 'CBOR_VALUES' } };
  }
  if (major === 0 && minor >= 41 && minor <= 47) {
    return { ok: true, cohort: { version: text, major, minor, generation: 'PRE_V048_RESET', wireFormat: 'JSON_VALUES' } };
  }
  const direction = major > 0 || minor > 48 ? 'newer than' : 'older than';
  return {
    ok: false,
    reason: `The endpoint runs Ootle ${text}, which is ${direction} the range this build is verified against (${SUPPORTED_INDEXER_RANGE}). Its reply format is not assumed.`,
  };
}

export function describeGeneration(generation: NetworkGeneration): string {
  return generation === 'V048_RESET' ? 'reset network (Ootle v0.48)' : 'pre-reset network (Ootle ≤ v0.47)';
}
