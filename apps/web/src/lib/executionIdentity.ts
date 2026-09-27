/**
 * EXECUTION IDENTITY (mission §7, §8, §9, §25, §26).
 *
 * A UI can hold a wallet session for minutes. During that time the provider
 * object, the selected account, the network, or the advertised capabilities can
 * all change. Without a binding, an operation reviewed against one identity can
 * be executed under another — the classic time-of-check / time-of-use gap.
 *
 * `ExecutionIdentity` is a captured snapshot. `verifyIdentity` re-derives the
 * snapshot from live provider state and compares every field. It is called
 * immediately before EVERY financial authorization, not once at connect.
 *
 * Three properties matter:
 *
 *  1. The provider is compared BY OBJECT IDENTITY, not by a name. A hostile page
 *     script can install a `window.tari` with any shape it likes, including a
 *     matching `adapterName()`. Only a reference to the same object is accepted.
 *
 *  2. Capabilities are fingerprinted. A provider that downgrades its
 *     advertisement after the handshake is detected, rather than trusted from
 *     the connect-time snapshot.
 *
 *  3. A nonce prevents replay. A caller may pass a `expectedNonce` it issued; a
 *     stale review from a previous session cannot be re-authorized.
 */

/**
 * A capability advertisement. The protocol's own WalletLegCapabilities is a
 * fixed-shape interface with no index signature, so it is accepted structurally here
 * by reading the keys rather than by assignment.
 */
export type ProviderCapabilities = Readonly<Record<string, boolean>>;

export interface ExecutionIdentity {
  /** The exact provider object. Compared by reference. */
  readonly providerRef: object;
  /** Stable identity of the provider's method implementations. */
  readonly providerFingerprint: string;
  /** The network the page is pinned to. */
  readonly expectedNetwork: string;
  /** The network the provider reported. */
  readonly providerNetwork: string;
  /** The account the review is bound to. */
  readonly account: string;
  /** Sorted capability fingerprint, or 'none' when nothing was advertised. */
  readonly capabilityFingerprint: string;
  /** A per-session nonce issued at connect. */
  readonly nonce: string;
  readonly capturedAtUnixMs: number;
}

export interface IdentityCheck {
  ok: boolean;
  /** Which field changed. Present only when `ok` is false. */
  changed?: 'provider' | 'providerImplementation' | 'network' | 'account' | 'capabilities' | 'nonce';
  reason?: string;
}

/** FNV-1a over a string; used only for change detection, never for secrecy. */
function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Fingerprint the provider's own method implementations.
 *
 * A provider can keep the same object identity and swap `request` to a different
 * function. Comparing function identity catches that, which matters because a
 * swapped `request` is the direct route from "the page trusts a provider" to
 * "the page trusts attacker code".
 */
export function providerFingerprint(provider: unknown): string {
  if (provider === null || typeof provider !== 'object') return 'none';
  const record = provider as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (typeof value === 'function') {
      // Function identity is not stable across a reload, so a function's source
      // shape is used instead: a swapped implementation has different source.
      parts.push(`${key}=fn:${hash(String(value).slice(0, 400))}`);
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`);
    }
  }
  // The prototype chain is part of the identity: a provider can inherit its
  // request method and be indistinguishable from an own-property one otherwise.
  const proto = Object.getPrototypeOf(record);
  if (proto !== null && proto !== Object.prototype) {
    const protoKey = typeof proto === 'object' && proto !== null ? hash(String((proto as Record<string, unknown>).constructor?.name ?? 'anon')) : 'null';
    parts.push(`__proto__=${protoKey}`);
  }
  return parts.length === 0 ? 'empty' : hash(parts.join('|'));
}

/** Sorted, stable fingerprint of a capability advertisement. */
export function capabilityFingerprint(capabilities: ProviderCapabilities | undefined): string {
  if (capabilities === undefined) return 'none';
  const entries = Object.keys(capabilities)
    .sort()
    .map((key) => `${key}=${capabilities[key] === true ? '1' : '0'}`);
  return entries.length === 0 ? 'empty' : hash(entries.join('|'));
}

let nonceCounter = 0;

/** A session nonce. Not a secret: it only distinguishes snapshots. */
export function issueNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${nonceCounter.toString(36)}`;
}

export interface CaptureIdentityInput {
  provider: object;
  expectedNetwork: string;
  providerNetwork: string;
  account: string;
  capabilities?: ProviderCapabilities;
  nonce?: string;
}

export function captureIdentity(input: CaptureIdentityInput): ExecutionIdentity {
  const identity: ExecutionIdentity = {
    providerRef: input.provider,
    providerFingerprint: providerFingerprint(input.provider),
    expectedNetwork: input.expectedNetwork,
    providerNetwork: input.providerNetwork,
    account: input.account,
    capabilityFingerprint: capabilityFingerprint(input.capabilities),
    nonce: input.nonce ?? issueNonce(),
    capturedAtUnixMs: Date.now(),
  };
  // Frozen: a snapshot is a value, not a mutable record.
  return Object.freeze(identity);
}

export interface LiveIdentityInput {
  provider: object;
  providerNetwork: string;
  account: string;
  capabilities?: ProviderCapabilities;
  nonce: string;
}

/**
 * Re-derive and compare. Every field is checked; the first mismatch is
 * reported with the field name so the UI can say precisely what changed.
 */
export function verifyIdentity(expected: ExecutionIdentity, live: LiveIdentityInput): IdentityCheck {
  if (expected.nonce !== live.nonce) {
    return { ok: false, changed: 'nonce', reason: 'This review belongs to an earlier wallet session and cannot be re-authorized.' };
  }
  // Object identity first: a different object is never the same provider, no
  // matter what it claims to be called.
  if (expected.providerRef !== live.provider) {
    return { ok: false, changed: 'provider', reason: 'The injected wallet provider object was replaced after this review was created.' };
  }
  if (expected.providerFingerprint !== providerFingerprint(live.provider)) {
    return { ok: false, changed: 'providerImplementation', reason: 'The wallet provider implementation changed after this review was created.' };
  }
  if (expected.providerNetwork !== live.providerNetwork) {
    return { ok: false, changed: 'network', reason: `The wallet network changed from "${expected.providerNetwork}" to "${live.providerNetwork}".` };
  }
  if (expected.expectedNetwork !== live.providerNetwork) {
    return { ok: false, changed: 'network', reason: `The wallet is on "${live.providerNetwork}" but this page is pinned to "${expected.expectedNetwork}".` };
  }
  if (expected.account !== live.account) {
    return { ok: false, changed: 'account', reason: `The active account changed from ${expected.account} to ${live.account}.` };
  }
  if (expected.capabilityFingerprint !== capabilityFingerprint(live.capabilities)) {
    return { ok: false, changed: 'capabilities', reason: 'The wallet changed the capabilities it advertises after this review was created.' };
  }
  return { ok: true };
}

/** Human-readable summary of what a review is bound to, for the review card. */
export function describeIdentity(identity: ExecutionIdentity): string {
  return `${identity.providerNetwork} · ${identity.account}`;
}

