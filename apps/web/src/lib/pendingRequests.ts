/**
 * DURABLE WALLET-REQUEST LEDGER — the reload-safe half of wallet approval.
 *
 * THE GAP THIS CLOSES.
 *
 * The published Tari contract splits signing into
 * `tari_createTransactionRequest` -> (human answers) -> `tari_getTransactionRequest`
 * -> `tari_submitTransactionRequest`. The whole point of that split is stated by the
 * reference itself: a one-shot call "loses its result forever if the page reloads
 * while the approval popup is open". A durable `requestId` survives the reload; the
 * `Map` that used to hold it did not.
 *
 * So the browser could approve a swap, and a reload between *create* and *approve*
 * would erase the only thing that made recovery possible. The user's money was
 * neither spent nor recorded as pending — the state simply evaporated.
 *
 * WHAT IS AND IS NOT PERSISTED.
 *
 * Persisted: identity and constraints. The operation id, the wallet's request id,
 * a fingerprint of the review that was approved, and the account + network the
 * approval was bound to.
 *
 * NOT persisted: the instructions, the amounts, the nonce, the signature, any
 * capability advertisement, any network or account *credential*. This is deliberate
 * and it is what makes the store safe to write to `localStorage` at all: there is
 * nothing here that could be replayed, because there is no payload here. Submission
 * is by `requestId` alone, so recovering needs the id and nothing else — there is
 * no code path on which a persisted blob could be turned back into a transaction.
 *
 * THE TRUST MODEL — READ THIS.
 *
 * `localStorage` is attacker-modifiable, exactly as for operation history. So:
 *
 *   - Every field is rebuilt from an allowlist. An unrecognised field is DROPPED,
 *     and a forbidden field REJECTS the whole record.
 *   - A persisted `state` is a CLAIM. Nothing here is ever allowed to satisfy an
 *     authoritative read, produce a transaction id, or mark anything executed.
 *     `resumePendingRequest` rereads the wallet's real answer via
 *     `tari_getTransactionRequest` and the wallet's word is the only word.
 *   - The persisted `approvedAccount` / `approvedNetwork` can only ever NARROW what
 *     the resume is allowed to do. A tampered network can stop a resume; it can
 *     never authorise one. See `resumeBlockReason`.
 *
 * The asymmetry is the whole design: forged local state must be able to deny a user
 * their money moving, but must never be able to make it move.
 */

/** Storage key. Deliberately separate from the operation-history key. */
export const PENDING_REQUEST_STORAGE_KEY = 'ootle.pendingRequests.v1';

/** Cap so a hostile writer cannot make a resume scan unbounded. */
const MAX_PENDING = 50;
/** Cap on the serialised payload. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_STRING = 512;

/**
 * Lifecycle as this app knows it.
 *
 * `AWAITING_APPROVAL` is the state a session-gated approval degrades into. It is
 * NOT a failure and NOT a submission — the wallet holds a live request carrying the
 * exact reviewed intent, and nothing has been broadcast.
 */
export type PendingRequestState =
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'REJECTED'
  | 'FAILED'
  | 'UNKNOWN';

const VALID_STATES: ReadonlySet<string> = new Set<PendingRequestState>([
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTED',
  'REJECTED',
  'FAILED',
  'UNKNOWN',
]);

/**
 * Fields that must never be persisted here under any circumstances.
 *
 * `network` and `capabilities` are in the operation-history deny-list because a
 * persisted claim about them could be displayed as identity. Here the equivalent
 * values are named `approvedNetwork` / they are absent entirely, precisely because
 * this store's network field exists to REFUSE a resume rather than to authorise one.
 */
export const FORBIDDEN_PENDING_FIELDS: ReadonlyArray<string> = [
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
  'signature',
  'signatureHex',
  'nonce',
  'capabilities',
  'network',
  'apiKey',
  'token',
  'instructions',
  'transaction',
  'walletRequest',
  'seedHex',
];

export interface PendingWalletRequest {
  /** This app's durable operation identity. The primary key. */
  readonly operationId: string;
  /** The wallet's durable request id. The ONLY thing a resume needs to submit. */
  readonly requestId: string;
  /**
   * Fingerprint of the review that was approved.
   *
   * This is the anti-substitution binding. On resume the live review is re-fingerprinted
   * and compared; a mismatch refuses, so a persisted id can never be pointed at a
   * transaction the user did not actually see and approve.
   */
  readonly reviewFingerprint: string;
  /** Human-facing operation label, e.g. `AMM_SWAP`. */
  readonly operation: string;
  /** The account component the approval was bound to. */
  readonly approvedAccount: string;
  /** The network the approval was bound to. */
  readonly approvedNetwork: string;
  /** Pool component or marketplace component, for display and for the bind check. */
  readonly destination: string;
  readonly createdAtUnixMs: number;
  readonly state: PendingRequestState;
  /** Only ever set from the WALLET's own answer, never from local state. */
  readonly transactionId?: string;
  /** Why it is in this state, when the wallet or the app said so. */
  readonly detail?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function safeString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > max) return undefined;
  // Control characters in a persisted identifier are a tampering signal.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** A raw integer string — never a JS number, so no float can ever enter the ledger. */
function safeRaw(value: unknown, max = 32): string | undefined {
  const text = safeString(value, max);
  return text !== undefined && /^\d+$/.test(text) ? text : undefined;
}

/**
 * A non-negative integer millisecond timestamp, from either wire form.
 *
 * Accepting both is not leniency, it is correctness: a record is BUILT in memory
 * (where `createdAtUnixMs` is a `Date.now()` number) and comes BACK from storage
 * (where it is a decimal string, so no float can enter the ledger). A validator that
 * accepted only one form would reject the app's own freshly-minted records and
 * silently record nothing — which is the exact failure this store exists to prevent.
 */
function safeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  const text = safeRaw(value, 20);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Validate ONE persisted pending request. Rebuild from the allowlist; anything else
 * is dropped.
 *
 * Returns `undefined` on any malformation rather than a partial record. A half-known
 * request is worse than an absent one: an absent one leaves the user's funds unspent
 * and visible in the wallet, while a half-known one could be submitted with an id the
 * app does not actually understand.
 */
export function validatePendingRequest(candidate: unknown): PendingWalletRequest | undefined {
  if (!isRecord(candidate)) return undefined;

  for (const field of FORBIDDEN_PENDING_FIELDS) {
    if (candidate[field] !== undefined) return undefined;
  }

  const operationId = safeString(candidate.operationId, 128);
  const requestId = safeString(candidate.requestId, 256);
  const reviewFingerprint = safeString(candidate.reviewFingerprint, 128);
  const operation = safeString(candidate.operation, 64);
  const approvedAccount = safeString(candidate.approvedAccount, 128);
  const approvedNetwork = safeString(candidate.approvedNetwork, 64);
  const destination = safeString(candidate.destination, 128);
  const state = safeString(candidate.state, 24);
  const createdAtUnixMs = safeTimestamp(candidate.createdAtUnixMs);

  if (operationId === undefined || requestId === undefined) return undefined;
  if (reviewFingerprint === undefined || reviewFingerprint === '') return undefined;
  if (operation === undefined || approvedAccount === undefined) return undefined;
  if (approvedNetwork === undefined || destination === undefined) return undefined;
  if (state === undefined || !VALID_STATES.has(state)) return undefined;
  if (createdAtUnixMs === undefined) return undefined;

  const record: {
    -readonly [K in keyof PendingWalletRequest]: PendingWalletRequest[K];
  } = {
    operationId,
    requestId,
    reviewFingerprint,
    operation,
    approvedAccount,
    approvedNetwork,
    destination,
    createdAtUnixMs,
    state: state as PendingRequestState,
  };
  const transactionId = safeString(candidate.transactionId, 256);
  if (transactionId !== undefined) record.transactionId = transactionId;
  const detail = safeString(candidate.detail, 1024);
  if (detail !== undefined) record.detail = detail;
  return Object.freeze(record);
}

export interface PendingLoadResult {
  records: PendingWalletRequest[];
  /** Entries dropped because they failed validation. */
  rejected: number;
  /** True when the payload could not be parsed at all and was treated as empty. */
  corrupt: boolean;
  reason?: string;
}

/**
 * Parse a persisted ledger. Bounded, validated, never throwing.
 *
 * A corrupt payload yields ZERO records, not a best-effort subset. Half-reading a
 * tampered ledger is how a resume ends up aimed at the wrong request id.
 */
export function loadPendingRequests(text: string | undefined | null): PendingLoadResult {
  if (text === undefined || text === null || text.trim() === '') return { records: [], rejected: 0, corrupt: false };
  if (text.length > MAX_PAYLOAD_BYTES) {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted wallet-request ledger exceeds the maximum size this build will read.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted wallet-request ledger could not be parsed and is being treated as empty.' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.requests)) {
    return { records: [], rejected: 0, corrupt: true, reason: 'Persisted wallet-request ledger is not a well-formed request list.' };
  }
  const records: PendingWalletRequest[] = [];
  let rejected = 0;
  for (const entry of parsed.requests.slice(0, MAX_PENDING)) {
    const validated = validatePendingRequest(entry);
    if (validated === undefined) rejected += 1;
    else records.push(validated);
  }
  return { records, rejected, corrupt: false };
}

/** Minimal storage seam. Everything is wrapped so a storage failure is never fatal. */
export interface PendingRequestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readAll(storage: PendingRequestStorage | undefined): { records: PendingWalletRequest[]; corrupt: boolean } {
  if (storage === undefined) return { records: [], corrupt: false };
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_REQUEST_STORAGE_KEY);
  } catch {
    return { records: [], corrupt: false };
  }
  const loaded = loadPendingRequests(raw);
  return { records: loaded.records, corrupt: loaded.corrupt };
}

/** Every valid persisted request, oldest first. A corrupt payload yields none. */
export function listPendingRequests(storage: PendingRequestStorage | undefined): PendingWalletRequest[] {
  return readAll(storage).records;
}

/**
 * Insert or replace by `operationId`.
 *
 * Best-effort: a storage failure (Safari private mode, a hostile extension) must
 * never break the approval flow it is recording. Losing the ledger degrades recovery
 * to the in-session path; it must never convert a pending approval into a failure.
 */
export function rememberPendingRequest(storage: PendingRequestStorage | undefined, record: PendingWalletRequest): void {
  if (storage === undefined) return;
  const validated = validatePendingRequest(record);
  if (validated === undefined) return;
  const { records } = readAll(storage);
  const next = [...records.filter((r) => r.operationId !== validated.operationId), validated].slice(-MAX_PENDING);
  try {
    storage.setItem(PENDING_REQUEST_STORAGE_KEY, JSON.stringify({ version: 1, requests: next }));
  } catch {
    // Best-effort, as above.
  }
}

/**
 * Drop a request once it is genuinely terminal: submitted with an acknowledged
 * transaction id, rejected, or failed. This is what bounds the ledger — an entry is
 * only removed once the WALLET said so, never merely because time passed.
 */
export function forgetPendingRequest(storage: PendingRequestStorage | undefined, operationId: string): void {
  if (storage === undefined) return;
  const { records } = readAll(storage);
  const next = records.filter((r) => r.operationId !== operationId);
  if (next.length === records.length) return;
  try {
    if (next.length === 0) storage.removeItem(PENDING_REQUEST_STORAGE_KEY);
    else storage.setItem(PENDING_REQUEST_STORAGE_KEY, JSON.stringify({ version: 1, requests: next }));
  } catch {
    // Best-effort.
  }
}

/**
 * Is this request one that still needs the user's attention?
 *
 * `SUBMITTED` stays in the ledger until its transaction id is confirmed by the chain,
 * because between "wallet accepted the submit" and "the chain agreed" there is still
 * a window in which the transaction must not be started again.
 */
export function needsAttention(record: PendingWalletRequest): boolean {
  return record.state !== 'REJECTED' && record.state !== 'FAILED';
}

/** The unresolved request blocking new submissions, if there is one. */
export function blockingPendingRequest(
  records: readonly PendingWalletRequest[],
  account: string | undefined,
  network: string,
): PendingWalletRequest | undefined {
  return records.find(
    (r) =>
      needsAttention(r) &&
      (account === undefined || r.approvedAccount === account) &&
      r.approvedNetwork === network,
  );
}

export interface ResumeBinding {
  /** The account the live session is actually on. */
  readonly account: string;
  /** The network the live session is actually on. */
  readonly network: string;
  /** The fingerprint of the review the user is looking at right now, if any. */
  readonly reviewFingerprint?: string;
}

export type ResumeRefusal =
  | 'ACCOUNT_CHANGED'
  | 'NETWORK_CHANGED'
  | 'REVIEW_SUBSTITUTED'
  | 'NO_LIVE_REVIEW'
  | 'NOT_BLOCKING';

/**
 * Why a resume may not proceed, or `undefined` when it may.
 *
 * EVERY branch here is a refusal. The function has no permissive path that depends on
 * anything read from storage: `account`, `network`, and `reviewFingerprint` all come
 * from the LIVE session, and the persisted values only ever appear on the left of a
 * comparison whose mismatch stops everything.
 *
 * That is the anti-substitution property stated as code. Flipping `approvedNetwork` in
 * `localStorage` cannot make a resume happen — it can only make this return
 * `NETWORK_CHANGED`. Flipping `reviewFingerprint` cannot redirect a resume either; it
 * can only cause a refusal.
 */
export function resumeBlockReason(record: PendingWalletRequest, live: ResumeBinding): ResumeRefusal | undefined {
  if (!needsAttention(record)) return 'NOT_BLOCKING';
  if (record.approvedAccount !== live.account) return 'ACCOUNT_CHANGED';
  if (record.approvedNetwork !== live.network) return 'NETWORK_CHANGED';
  // A resume that carries no live review cannot prove the request being submitted is
  // the one the user saw. The wallet approved a specific transaction; re-deriving it
  // here would be exactly the reconstruction this design forbids.
  if (live.reviewFingerprint === undefined) return 'NO_LIVE_REVIEW';
  if (record.reviewFingerprint !== live.reviewFingerprint) return 'REVIEW_SUBSTITUTED';
  return undefined;
}

/** A refusal explained for a person, not for a log. */
export function describeResumeRefusal(refusal: ResumeRefusal): string {
  switch (refusal) {
    case 'ACCOUNT_CHANGED':
      return 'This approval was given by a different wallet account. Switch back to the account that approved it, or cancel the request in your wallet.';
    case 'NETWORK_CHANGED':
      return 'This approval was given on a different network. Switch back to that network, or cancel the request in your wallet.';
    case 'REVIEW_SUBSTITUTED':
      return 'The transaction shown now is not the one that was approved, so it will not be submitted. Rebuild and review the transaction again.';
    case 'NO_LIVE_REVIEW':
      return 'There is no reviewed transaction on screen matching this approval, so nothing can be submitted. Rebuild the transaction to continue.';
    case 'NOT_BLOCKING':
      return 'This request is already settled.';
    default:
      return 'This approval cannot be resumed.';
  }
}

/**
 * The browser's storage, or `undefined` when it cannot be used at all.
 *
 * Returning `undefined` rather than throwing is deliberate. Every function above
 * treats missing storage as "no ledger", so a browser in private mode (or a hostile
 * extension that makes `localStorage.setItem` throw) degrades recovery to the
 * in-session path instead of breaking the approval flow that is trying to record it.
 */
export function browserPendingRequestStorage(scope: unknown = globalThis): PendingRequestStorage | undefined {
  const candidate = (scope as { localStorage?: PendingRequestStorage }).localStorage;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function') return undefined;
  // Probe once. A `Storage` that throws on write (Safari private mode, a locked-down
  // origin) is worse than no storage, because every record would throw at the moment
  // it mattered most.
  const probe = `${PENDING_REQUEST_STORAGE_KEY}.probe`;
  try {
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
  } catch {
    return undefined;
  }
  return candidate;
}

/**
 * Parse a provider-reported request status into this ledger's vocabulary.
 *
 * An unrecognised status maps to `UNKNOWN`, never to a terminal state. Mapping an
 * unknown status onto `SUBMITTED` or `REJECTED` would be inventing a settlement the
 * wallet never reported, and `UNKNOWN` is the only state that keeps a resume possible.
 */
export function mapRequestStatus(status: unknown): PendingRequestState | 'TERMINAL' {
  if (typeof status !== 'string') return 'UNKNOWN';
  switch (status.toLowerCase()) {
    case 'pending':
      return 'AWAITING_APPROVAL';
    case 'approved':
      return 'APPROVED';
    case 'submitting':
    case 'submitted':
      return 'SUBMITTED';
    case 'rejected':
      return 'REJECTED';
    case 'failed':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}