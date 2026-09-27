/**
 * ERROR NORMALISATION (mission §30).
 *
 * An error thrown by a provider, a transport, or a hostile indexer is untrusted
 * text that may contain a stack trace, a local filesystem path, an RPC
 * credential, a wallet database location, or a preimage-shaped hex blob. It is
 * rendered into the DOM, so it must be reduced to a controlled shape before it
 * gets there.
 *
 * The rule: keep a stable reason code and a short, pattern-scrubbed detail. Drop
 * anything that looks like a secret, a path, or a stack. Never echo a raw error
 * message into user-visible text.
 */

/** Stable, non-secret reason codes the UI knows how to render. */
export type ErrorCode =
  | 'WALLET_UNAVAILABLE'
  | 'WALLET_WRONG_NETWORK'
  | 'WALLET_REJECTED'
  | 'WALLET_DISCONNECTED'
  | 'WALLET_CAPABILITY_MISSING'
  | 'IDENTITY_CHANGED'
  | 'QUOTE_UNAVAILABLE'
  | 'QUOTE_STALE'
  | 'QUOTE_EXPIRED'
  | 'ROUTE_UNAVAILABLE'
  | 'INSUFFICIENT_BALANCE'
  | 'UNSUPPORTED_RESOURCE'
  | 'ISSUER_CONTROLLED'
  | 'AMOUNT_INVALID'
  | 'DIVISIBILITY_EXCEEDED'
  | 'REVIEW_MISMATCH'
  | 'MARKET_DATA_UNAVAILABLE'
  | 'MARKET_DATA_STALE'
  | 'SUBMISSION_UNKNOWN'
  | 'SUBMISSION_FAILED'
  | 'PROVIDER_OFFLINE'
  | 'BROWSER_SHA_UNAVAILABLE'
  | 'STORAGE_CORRUPT'
  | 'UNEXPECTED';

export interface NormalizedError {
  code: ErrorCode;
  /** One sentence, safe to render. Never contains untrusted text verbatim. */
  message: string;
  /** Optional numeric hint, e.g. a slippage bps. */
  hint?: string;
  /** True when the user can plausibly do something about it. */
  retryable: boolean;
}

const MESSAGES: Record<ErrorCode, string> = {
  WALLET_UNAVAILABLE: 'No Tari wallet provider is available in this page.',
  WALLET_WRONG_NETWORK: 'The wallet is connected to a different network than this page allows.',
  WALLET_REJECTED: 'The wallet rejected the request.',
  WALLET_DISCONNECTED: 'The wallet disconnected before the operation could complete.',
  WALLET_CAPABILITY_MISSING: 'The wallet does not support an operation this route requires.',
  IDENTITY_CHANGED: 'The wallet account, network, or capabilities changed. This review is no longer valid.',
  QUOTE_UNAVAILABLE: 'A quote could not be produced.',
  QUOTE_STALE: 'The quote is out of date and must be produced again.',
  QUOTE_EXPIRED: 'The quote expired.',
  ROUTE_UNAVAILABLE: 'No route is currently available for this pair.',
  INSUFFICIENT_BALANCE: 'The connected account does not hold enough of this asset.',
  UNSUPPORTED_RESOURCE: 'This resource cannot be routed through a public fungible pool.',
  ISSUER_CONTROLLED: 'This asset is issuer controlled.',
  AMOUNT_INVALID: 'The amount is not a valid value for this asset.',
  DIVISIBILITY_EXCEEDED: 'The amount has more decimal places than this asset supports.',
  REVIEW_MISMATCH: 'The transaction under review does not match what will be submitted.',
  MARKET_DATA_UNAVAILABLE: 'Market data is unavailable.',
  MARKET_DATA_STALE: 'Market data is behind the chain.',
  SUBMISSION_UNKNOWN: 'The submission outcome is unknown and is being reconciled.',
  SUBMISSION_FAILED: 'The transaction was rejected.',
  PROVIDER_OFFLINE: 'The wallet provider is not responding.',
  BROWSER_SHA_UNAVAILABLE: 'Atomic XTM swaps are not available in a browser wallet yet.',
  STORAGE_CORRUPT: 'Saved operation history in this browser could not be read.',
  UNEXPECTED: 'Something went wrong. Nothing was submitted.',
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['WALLET_REJECTED', 'WALLET_DISCONNECTED', 'QUOTE_STALE', 'QUOTE_EXPIRED', 'PROVIDER_OFFLINE', 'SUBMISSION_UNKNOWN']);

const BY_PATTERN: ReadonlyArray<{ pattern: RegExp; code: ErrorCode }> = [
  { pattern: /user rejected|denied by user|declined|rejected by (the )?user/i, code: 'WALLET_REJECTED' },
  { pattern: /insufficient (balance|funds)/i, code: 'INSUFFICIENT_BALANCE' },
  { pattern: /no (tari )?wallet provider|not injected|provider unavailable/i, code: 'WALLET_UNAVAILABLE' },
  { pattern: /network/i, code: 'WALLET_WRONG_NETWORK' },
  { pattern: /capabilit/i, code: 'WALLET_CAPABILITY_MISSING' },
  { pattern: /expired/i, code: 'QUOTE_EXPIRED' },
  { pattern: /stale/i, code: 'QUOTE_STALE' },
  { pattern: /floors to zero|too small|dust/i, code: 'AMOUNT_INVALID' },
  { pattern: /fraction digits|divisibilit/i, code: 'DIVISIBILITY_EXCEEDED' },
  { pattern: /unsafe resource|unsupported resource type/i, code: 'UNSUPPORTED_RESOURCE' },
  { pattern: /issuer[- ]controlled/i, code: 'ISSUER_CONTROLLED' },
  { pattern: /review refused|mismatch/i, code: 'REVIEW_MISMATCH' },
  { pattern: /rejected on-chain|TRANSPORT_UNKNOWN|aborted|reverted/i, code: 'SUBMISSION_UNKNOWN' },
];

/**
 * Anything matching this is never surfaced: file paths, URLs with credentials,
 * long hex blobs (a preimage or a private key), and stack frames.
 */
const SECRET_SHAPED = [
  /[A-Za-z]:\\[^\s"']+/, // Windows path
  /(?:^|\s)\/(?:home|root|Users|var|tmp|etc|proc|app|src|usr|opt)\/[^\s"']+/, // POSIX path
  /\b[a-f0-9]{64,}\b/i, // 32+ byte hex blob
  /\b(?:seed|mnemonic|private[ _]?key|secret[ _]?key|passphrase)\b\s*[:=]/i,
  /\b(?:Authorization|Bearer)\s+\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*:[^\s"']*@/i, // credentialed URL
  /\bat\s+[\w.$<>]+\s*[([]/, // stack frame header
  /:\d+:\d+\)/, // file:line:col tail of a stack frame
  /\bat\s+[\w.$<>]+\s*\([^)]*\)/, // stack frame
];

/** Reduce untrusted error text to a short scrubbed fragment, or undefined. */
export function scrubUntrustedText(text: unknown, maxLength = 120): string | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed === '' || trimmed.length > 2000) return undefined;
  for (const pattern of SECRET_SHAPED) {
    if (pattern.test(trimmed)) return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

export interface NormalizeInput {
  error?: unknown;
  /** An explicit code from the caller, which always wins. */
  code?: ErrorCode;
  /** A short, already-safe extra detail, e.g. a slippage value. */
  hint?: string;
}

/**
 * Map any thrown value to a renderable, non-leaking error.
 *
 * An explicit `code` is trusted because it comes from this codebase, not from the
 * provider. Otherwise the code is inferred from a pattern over the message; if
 * nothing matches, the result is `UNEXPECTED`, whose message says nothing about
 * what was thrown.
 */
export function normalizeError(input: NormalizeInput): NormalizedError {
  const code = input.code ?? inferCode(input.error);
  const message = MESSAGES[code];
  const detail = scrubUntrustedText(input.error);
  const result: NormalizedError = { code, message, retryable: RETRYABLE.has(code) };
  const hint = input.hint ?? detail;
  if (hint !== undefined) result.hint = hint;
  return result;
}

function inferCode(error: unknown): ErrorCode {
  if (error === undefined || error === null) return 'UNEXPECTED';
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (text === '') return 'UNEXPECTED';
  for (const entry of BY_PATTERN) {
    if (entry.pattern.test(text)) return entry.code;
  }
  return 'UNEXPECTED';
}

/** The one-line form the UI shows. */
export function formatError(error: NormalizedError): string {
  return error.hint === undefined ? error.message : `${error.message} (${error.hint})`;
}
