/**
 * BROWSER STORAGE INVENTORY AND TAMPER RESISTANCE (mission §31, §32).
 *
 * Everything this app persists is attacker-modifiable: `localStorage` is fully
 * under the page's control, and a page script can rewrite it between reloads.
 * The rule that follows: **persisted state may only ever be a display cache.**
 * It must never be able to satisfy an authoritative reread, produce a
 * settlement proof, or make a transaction look executed.
 *
 * Inventory:
 *
 *   | key                        | class                       | sensitivity |
 *   |----------------------------|-----------------------------|-------------|
 *   | ootle.operations.v1        | operation history (display) | low: ids, kinds, states, amounts |
 *   | __ootle_probe__            | storage probe, removed      | none        |
 *
 * Nothing else is written. No key material, no preimage, no seed, no capability
 * advertisement, no network choice, and no gate flag.
 *
 * On load every record is schema-validated and re-classified. A record whose
 * persisted state is `CONFIRMED` is still re-verified against the chain before
 * the UI treats it as final, because a tampered `CONFIRMED` would otherwise
 * suppress the user's own funds being pending.
 */

import type { OperationRecord, OperationState } from '@tari-ootle/protocol-client';

export const STORAGE_KEYS = {
  operationHistory: 'ootle.operations.v1',
  storageProbe: '__ootle_probe__',
} as const;

/** The exact set of keys this app is permitted to write. */
export const ALLOWED_STORAGE_KEYS: ReadonlySet<string> = new Set([STORAGE_KEYS.operationHistory, STORAGE_KEYS.storageProbe]);

/** Fields that must never appear in persisted state under any circumstances. */
export const FORBIDDEN_PERSISTED_FIELDS: ReadonlyArray<string> = [
  'preimage',
  'preimageHex',
  'walletPreimageHex',
  'secret',
  'secretHex',
  'seed',
  'seedPhrase',
  'mnemonic',
  'privateKey',
  'privKey',
  'capabilities',
  'network',
  'apiKey',
  'token',
];

const VALID_STATES: ReadonlySet<string> = new Set<OperationState>(['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN']);
const MAX_STRING = 512;
const MAX_RECORDS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function safeString(value: unknown, field: string, max = MAX_STRING): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.length > max) return undefined;
  // Control characters in a persisted identifier are a tampering signal.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  void field;
  return value;
}

function safeRaw(value: unknown): string | undefined {
  const text = safeString(value, 'raw', 80);
  return text !== undefined && /^\d+$/.test(text) ? text : undefined;
}

/**
 * Validate ONE persisted operation record.
 *
 * Anything unrecognised is dropped rather than coerced. A tampered record is
 * worse than a missing one: a missing record costs the user a lookup, a
 * tampered one can lie about whether their money moved.
 */
export function validateOperationRecord(candidate: unknown): OperationRecord | undefined {
  if (!isRecord(candidate)) return undefined;

  // Reject outright if any forbidden field is present, rather than ignoring it.
  for (const field of FORBIDDEN_PERSISTED_FIELDS) {
    if (candidate[field] !== undefined) return undefined;
  }

  const operationId = safeString(candidate.operationId, 'operationId', 128);
  const operationKind = safeString(candidate.operationKind, 'operationKind', 64);
  const state = safeString(candidate.state, 'state', 16);
  // An empty durable identity is not an identity: it would make two operations
  // indistinguishable in the history list.
  if (operationId === undefined || operationId === '') return undefined;
  if (operationKind === undefined || operationKind === '') return undefined;
  if (state === undefined || !VALID_STATES.has(state)) return undefined;

  const createdAtUnixMs = candidate.createdAtUnixMs;
  if (typeof createdAtUnixMs !== 'number' || !Number.isFinite(createdAtUnixMs) || createdAtUnixMs < 0) return undefined;

  const resources = Array.isArray(candidate.resources) ? candidate.resources.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 256).slice(0, 32) : [];
  const amounts: Record<string, string> = {};
  if (isRecord(candidate.amounts)) {
    for (const [key, value] of Object.entries(candidate.amounts).slice(0, 32)) {
      const raw = safeRaw(value);
      // Fail closed on a malformed amount rather than dropping it: a record
      // whose amount was tampered with must not be displayed with a silently
      // missing figure, which reads as "zero" or "unknown" to a user deciding
      // whether their money moved.
      if (raw === undefined) return undefined;
      amounts[key] = raw;
    }
  }
  if (isRecord(candidate.quote)) {
    if (safeRaw(candidate.quote.quotedOutput) === undefined || safeRaw(candidate.quote.minOutput) === undefined) return undefined;
  }

  const record: OperationRecord = {
    operationId,
    operationKind,
    state: state as OperationState,
    resources,
    amounts,
    createdAtUnixMs,
  };

  const transactionId = safeString(candidate.transactionId, 'transactionId', 256);
  if (transactionId !== undefined) record.transactionId = transactionId;
  const componentOrOrderId = safeString(candidate.componentOrOrderId, 'componentOrOrderId', 256);
  if (componentOrOrderId !== undefined) record.componentOrOrderId = componentOrOrderId;
  const epoch = safeRaw(candidate.epoch);
  if (epoch !== undefined) record.epoch = epoch;
  const expiryEpoch = safeRaw(candidate.expiryEpoch);
  if (expiryEpoch !== undefined) record.expiryEpoch = expiryEpoch;
  const failureReason = safeString(candidate.failureReason, 'failureReason', 1024);
  if (failureReason !== undefined) record.failureReason = failureReason;
  for (const field of ['submittedAtUnixMs', 'confirmedAtUnixMs'] as const) {
    const value = candidate[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record[field] = value;
  }
  if (isRecord(candidate.quote)) {
    const quoted = safeRaw(candidate.quote.quotedOutput);
    const min = safeRaw(candidate.quote.minOutput);
    if (quoted !== undefined && min !== undefined) record.quote = { quotedOutput: quoted, minOutput: min };
  }
  // `lastReadback` is deliberately NOT restored. A tampered freshness record
  // would let the UI claim a readback it never performed.
  return record;
}

export interface HistoryLoadResult {
  records: OperationRecord[];
  /** Records dropped because they failed validation. */
  rejected: number;
  /** True when the payload could not be parsed at all. */
  corrupt: boolean;
  reason?: string;
}

/**
 * Parse a persisted history payload. Bounded, validated, and never throwing.
 */
export function loadHistoryPayload(text: string | undefined | null): HistoryLoadResult {
  if (text === undefined || text === null || text.trim() === '') return { records: [], rejected: 0, corrupt: false };
  if (text.length > 4 * 1024 * 1024) {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted history exceeds the maximum size this build will read.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted operation history could not be parsed and is being treated as empty.' };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted operation history is not a list of operation records.' };
  }
  const capped = parsed.slice(0, MAX_RECORDS);
  const records: OperationRecord[] = [];
  let rejected = 0;
  for (const entry of capped) {
    const validated = validateOperationRecord(entry);
    if (validated === undefined) rejected += 1;
    else records.push(validated);
  }
  return { records, rejected, corrupt: false };
}

/**
 * Classify a loaded record for display.
 *
 * A persisted `CONFIRMED` is a CLAIM, not a fact. The UI must show it as
 * "reported confirmed" until an authoritative lookup agrees, because the
 * alternative is a tampered localStorage entry suppressing a pending
 * transaction.
 */
export function trustLevel(record: OperationRecord): 'AUTHORITATIVE_REQUIRED' | 'CLAIMED_BY_STORAGE' {
  if (record.state === 'PENDING' || record.state === 'SUBMITTED' || record.state === 'UNKNOWN' || record.state === 'FAILED') {
    return 'AUTHORITATIVE_REQUIRED';
  }
  // CONFIRMED and anything terminal must be re-verified before it is treated as
  // final: persisted state is attacker-modifiable.
  return 'CLAIMED_BY_STORAGE';
}

/** Storage keys an operator may inspect when reporting a problem. */
export function storageInventory(): ReadonlyArray<{ key: string; class: string; containsSecrets: boolean }> {
  return [
    { key: STORAGE_KEYS.operationHistory, class: 'operation history (display cache only)', containsSecrets: false },
    { key: STORAGE_KEYS.storageProbe, class: 'availability probe, written then immediately removed', containsSecrets: false },
  ];
}
