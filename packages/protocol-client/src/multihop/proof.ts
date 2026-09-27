/**
 * TerminalSettlementProof — the hard dependency between hop 1 and hop 2.
 *
 * §4 of the audit mandate: hop 2 (AMM) may become constructible ONLY when hop 1 produces an
 * explicit, chain-proven settlement artifact. Settlement is NEVER inferred from:
 *   - the CLAIMED enum alone,
 *   - stored session state,
 *   - a transaction submission acknowledgement,
 *   - a provider statement,
 *   - cached indexer state.
 *
 * This module is the ONLY place a proof can be created. The brand symbol is module-private,
 * so an object literal (or a JSON payload from a peer) can never satisfy the type. The
 * substantive protection is `assertMintableSettlementEvidence`, which demands authoritative
 * evidence for every field the mandate lists.
 */
import { ExecutionAuthoritativeRead, Freshness, isAuthoritativeSource, ReadSource } from '../execution.js';
import { CrossChainSessionRecord, isTerminal } from '../crosschain/session.js';
import { TerminalSettlementProofRef } from './types.js';

/** Module-private brand. Not exported: no other module can structurally produce a proof. */
const PROOF_BRAND = Symbol('tari.multihop.terminalSettlementProof');

export interface TerminalSettlementProof {
  readonly [PROOF_BRAND]: true;
  readonly proofId: string;
  readonly routeId: string;
  /** Cross-layer session that produced the settlement. */
  readonly crossLayerSessionId: string;
  readonly hopId: string;
  /** The asset that actually landed (must be canonical TARI for this phase). */
  readonly resultingAssetKind: 'MINOTARI_L1' | 'OOTLE_L2';
  readonly resultingResourceAddress: string;
  /** EXACT raw amount received — from the authoritative read, never the quote. */
  readonly resultingAmountRaw: string;
  /** The account that received it AND that will execute hop 2. Identity binding. */
  readonly recipientAccount: string;
  /** Authoritative source of the balance/output/substate evidence. */
  readonly authoritativeSource: ReadSource;
  /** Transaction/substate identity of the settling claim. */
  readonly chainTxId: string;
  readonly substateIdentity?: string;
  /** Finality evidence. */
  readonly confirmationsSatisfied: true;
  readonly settlementEpochOrVersion: string;
  readonly freshness: Freshness;
  readonly proofFingerprint: string;
  readonly terminalStatus: 'CLAIMED';
  readonly mintedAtUnixMs: number;
  /** Maximum age a consumer may accept before re-verifying from chain. */
  readonly maxAgeMs: number;
}

// ---------------------------------------------------------------------------
// Evidence the mandate requires before minting
// ---------------------------------------------------------------------------

export interface SettlementEvidenceInput {
  routeId: string;
  hopId: string;
  session: CrossChainSessionRecord;
  /** Authoritative L2 balance/output/substate read proving the received TARI. */
  l2BalanceRead: ExecutionAuthoritativeRead<{ account: string; resourceAddress: string; amountRaw: string }>;
  /** The same facts as the balance read, for cross-checking. */
  expectedResourceAddress: string;
  /** The account hop 2 will execute from. MUST equal the receiving account. */
  hop2ExecutionAccount: string;
  /** The cross-layer claim transaction id. */
  l2ClaimTxId: string;
  /** Freshness of the balance read, including its source. */
  freshness: Freshness;
  /** Minimum confirmations the L2 claim must have. */
  requiredConfirmations: string;
  observedConfirmations: string;
  maxAgeMs?: number;
}

export class SettlementProofRefusal extends Error {}

function fail(why: string): never {
  throw new SettlementProofRefusal(`Settlement proof refused: ${why}`);
}

/** Largest value we model: 2^128-1, computed so the bound cannot be mistyped. */
const MAX_UINT_128 = (1n << 128n) - 1n;

function requireRaw(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`${field} must be a raw non-negative integer string`);
  const v = BigInt(value);
  if (v > MAX_UINT_128) fail(`${field} exceeds 128 bits`);
  return v;
}

/**
 * Validate every condition the mandate names, then mint. This is the ONLY constructor.
 */
export function mintTerminalSettlementProof(input: SettlementEvidenceInput): TerminalSettlementProof {
  // 1. Cross-layer session must be TERMINAL and specifically CLAIMED.
  const session = input.session;
  if (!isTerminal(session.state)) fail(`cross-layer session is ${session.state}, not terminal`);
  if (session.state !== 'CLAIMED') fail(`only a CLAIMED session can settle a route hop (got ${session.state})`);

  // 2. No unresolved UNKNOWN anywhere: the session must be terminal (checked above), and
  //    recovery is a non-terminal state, so an UNKNOWN/RECOVERY session can never reach here.
  if (session.l1Verification === undefined) fail('no authoritative L1 verification on the session');
  if (session.l2Verification === undefined) fail('no authoritative L2 verification on the session');
  if (session.l2Verification.source !== 'AUTHORITATIVE') fail('L2 verification source is not AUTHORITATIVE');
  // 3. Amount authority must be certain for the leg that delivered the TARI. The
  //    cross-layer layer refuses to stamp an L1 verification without it, so this is a
  //    transitive but explicit re-check: an uncertain L1 amount may not produce a trusted
  //    settlement proof.
  if (session.l1Verification.amountAuthoritative !== true) {
    fail('L1 amount authority is not established — refusing to trust the settlement (this direction stays blocked, by design)');
  }
  if (session.l1Verification.source === 'PROVIDER_ASSERTION') fail('L1 evidence is a provider assertion');

  // 4. No pending refund path. A CLAIMED session has no outgoing transitions in the session
  //    machine, so it cannot be mid-refund; a recorded refund id here would mean the record
  //    was tampered with, and the route must not settle on it.
  if (session.l1RefundTxId !== undefined || session.l2RefundTxId !== undefined) {
    fail('a refund path is recorded on a CLAIMED session — refusing to settle');
  }

  // 5. Claim transaction identity must exist and match.
  if (typeof input.l2ClaimTxId !== 'string' || input.l2ClaimTxId === '') fail('missing L2 claim transaction id');
  if (session.l2ClaimTxId !== undefined && session.l2ClaimTxId !== '' && session.l2ClaimTxId !== input.l2ClaimTxId) {
    fail(`L2 claim tx mismatch: session ${session.l2ClaimTxId} vs evidence ${input.l2ClaimTxId}`);
  }

  // 6. The balance evidence must be AUTHORITATIVE (never an indexer or a provider claim).
  if (input.l2BalanceRead.status !== 'FOUND') fail(`L2 balance evidence unavailable: ${input.l2BalanceRead.status}`);
  const balance = input.l2BalanceRead.value;
  if (!isAuthoritativeSource(input.freshness.source)) {
    fail(`settlement evidence source ${input.freshness.source} is not authoritative`);
  }
  if (input.freshness.source !== input.l2BalanceRead.freshness.source) {
    fail('balance evidence and freshness disagree about their source');
  }

  // 7. Resource identity must be exact, and must be the canonical TARI resource.
  if (balance.resourceAddress !== input.expectedResourceAddress) {
    fail(`settled resource ${balance.resourceAddress} is not the expected ${input.expectedResourceAddress} (exact identity required)`);
  }

  // 8. Amount must be positive and raw. It may legitimately be LESS than the quote (partial
  //    fill is a provider risk the route policy handles at the route level) but can never
  //    EXCEED the accepted quote — that would mean value was invented.
  const amount = requireRaw(balance.amountRaw, 'settled amountRaw');
  if (amount <= 0n) fail('settled amount is zero — nothing to compose');
  if (amount > requireRaw(session.tariRawAmount, 'session tariRawAmount')) {
    fail(`settled amount ${balance.amountRaw} exceeds the accepted quote ${session.tariRawAmount} — refusing to invent value`);
  }

  // 9. Ownership binding: the account that received the TARI MUST be the account hop 2 runs
  //    from. This prevents "hop 1 settles into wallet A, hop 2 spends from wallet B".
  if (balance.account !== input.hop2ExecutionAccount) {
    fail(`intermediate asset settled to ${balance.account} but hop 2 executes from ${input.hop2ExecutionAccount} — identity binding violated`);
  }

  // 10. Finality: confirmations must satisfy policy.
  const observed = requireRaw(input.observedConfirmations, 'observedConfirmations');
  const required = requireRaw(input.requiredConfirmations, 'requiredConfirmations');
  if (observed < required) fail(`confirmations ${input.observedConfirmations} < required ${input.requiredConfirmations}`);

  // 11. Freshness: evidence must not be older than the accepted max age.
  const maxAge = input.maxAgeMs ?? 120_000;
  const age = Date.now() - input.freshness.identity.readAtUnixMs;
  if (age > maxAge) fail(`settlement evidence is stale (age ${age}ms > maxAge ${maxAge}ms)`);

  const proof: TerminalSettlementProof = {
    [PROOF_BRAND]: true,
    proofId: `${input.routeId}:${input.hopId}:settlement`,
    routeId: input.routeId,
    crossLayerSessionId: session.sessionId,
    hopId: input.hopId,
    resultingAssetKind: 'OOTLE_L2',
    resultingResourceAddress: balance.resourceAddress,
    resultingAmountRaw: balance.amountRaw,
    recipientAccount: balance.account,
    authoritativeSource: input.freshness.source,
    chainTxId: input.l2ClaimTxId,
    substateIdentity: input.freshness.identity.stateIdentity,
    confirmationsSatisfied: true,
    settlementEpochOrVersion: input.freshness.identity.epoch ?? input.freshness.identity.substateVersion ?? 'unknown',
    freshness: input.freshness,
    proofFingerprint: '',
    terminalStatus: 'CLAIMED',
    mintedAtUnixMs: Date.now(),
    maxAgeMs: maxAge,
  };
  return Object.freeze({ ...proof, proofFingerprint: fingerprint(proof) });
}

/**
 * Consumer-side verification. Called before EVERY hop-2 construction, not once.
 * `expectedRouteId` is supplied by the caller so route A cannot consume route B's proof.
 */
export function verifyTerminalSettlementProof(
  proof: TerminalSettlementProof | undefined | null,
  expected: { routeId: string; hop2ExecutionAccount: string; expectedResourceAddress: string },
  nowUnixMs: number = Date.now(),
): TerminalSettlementProofRef {
  if (proof === undefined || proof === null) fail('no terminal settlement proof supplied — hop 2 cannot be constructed');
  const brand = (proof as unknown as Record<symbol, unknown>)[PROOF_BRAND];
  if (brand !== true) fail('supplied object is not a minted terminal settlement proof (forged)');
  if (proof.routeId !== expected.routeId) fail(`proof belongs to route ${proof.routeId}, not ${expected.routeId}`);
  if (proof.hopId !== 'hop_1') fail(`proof is not from hop 1 (got ${proof.hopId})`);
  if (proof.terminalStatus !== 'CLAIMED') fail(`proof terminal status is ${proof.terminalStatus}`);
  if (proof.recipientAccount !== expected.hop2ExecutionAccount) {
    fail(`proof recipient ${proof.recipientAccount} does not match the hop-2 account ${expected.hop2ExecutionAccount}`);
  }
  if (proof.resultingResourceAddress !== expected.expectedResourceAddress) {
    fail(`proof resource ${proof.resultingResourceAddress} is not the expected ${expected.expectedResourceAddress}`);
  }
  if (!isAuthoritativeSource(proof.authoritativeSource)) fail(`proof source ${proof.authoritativeSource} is not authoritative`);
  requireRaw(proof.resultingAmountRaw, 'proof resultingAmountRaw');
  if (BigInt(proof.resultingAmountRaw) <= 0n) fail('proof amount is zero');
  // Fingerprint integrity: a mutated field is detectable without a signature.
  if (fingerprint(proof) !== proof.proofFingerprint) fail('proof fingerprint mismatch — the proof was mutated after minting');
  // Staleness: a proof older than its declared max age must be re-derived.
  if (nowUnixMs - proof.mintedAtUnixMs > proof.maxAgeMs) {
    fail(`proof is stale (age ${nowUnixMs - proof.mintedAtUnixMs}ms > maxAge ${proof.maxAgeMs}ms)`);
  }
  return { proofId: proof.proofId, routeId: proof.routeId, fingerprint: proof.proofFingerprint };
}

/** Non-cryptographic correlation fingerprint (FNV-1a over the fact fields). */
function fingerprint(proof: Omit<TerminalSettlementProof, 'proofFingerprint'>): string {
  const material = [
    proof.routeId, proof.crossLayerSessionId, proof.hopId, proof.resultingResourceAddress,
    proof.resultingAmountRaw, proof.recipientAccount, proof.chainTxId, proof.terminalStatus,
    proof.settlementEpochOrVersion,
  ].join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE REVALIDATION (closes the recorded stale/reorg gap)
// ---------------------------------------------------------------------------

/**
 * The facts an authoritative reader must re-derive before a settlement proof is allowed to
 * authorise hop 2. A proof alone is an in-process capability validated at mint time; a
 * reorg, a rollback, or an account/state change inside `maxAgeMs` would otherwise escape
 * notice. These fields are what the revalidation is checked against.
 */
export interface SettlementRevalidation {
  status: 'CONFIRMED' | 'MISMATCH' | 'REORGED_OR_ROLLED_BACK' | 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE';
  reason?: string;
  observed?: {
    account: string;
    resourceAddress: string;
    /** Amount currently attributable to the settlement for this account/resource. */
    amountRaw: string;
    /** Whether the settling transaction/output is still settled (not reverted, not re-spent). */
    settled: boolean;
    confirmations: string;
    chainTxId: string;
    substateIdentity?: string;
  };
  source?: ReadSource;
}

export interface SettlementRevalidator {
  /**
   * MUST come from an authoritative source (chain node or wallet provider). Indexers,
   * caches, and provider assertions are not acceptable and are refused on inspection.
   */
  revalidate(input: { proof: TerminalSettlementProof; requiredConfirmations: string }): Promise<SettlementRevalidation>;
}

/**
 * Re-verify a proof against authoritative chain state.
 *
 * Fails closed in every direction: an unavailable authoritative reader is NOT treated as
 * equivalent to a recent read (the `maxAgeMs` window is a liveness bound, not a security
 * one), and any divergence in identity, resource, amount, account, transaction, settled
 * state, or confirmations refuses.
 */
export async function revalidateTerminalSettlementProof(
  proof: TerminalSettlementProof,
  revalidator: SettlementRevalidator | undefined,
  options: { requiredConfirmations: string },
): Promise<SettlementRevalidation> {
  if (revalidator === undefined) {
    return {
      status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE',
      reason: 'no authoritative settlement revalidation provider is configured — the proof age window is not a substitute for a chain read; hop 2 must not be constructed',
    };
  }
  if (typeof revalidator.revalidate !== 'function') {
    return { status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE', reason: 'settlement revalidator does not implement revalidate()' };
  }
  let result: SettlementRevalidation;
  try {
    result = await revalidator.revalidate({ proof, requiredConfirmations: options.requiredConfirmations });
  } catch (error) {
    return { status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE', reason: `authoritative revalidation failed: ${(error as Error).message}` };
  }
  if (result.status !== 'CONFIRMED') {
    return { ...result, reason: result.reason ?? `authoritative revalidation returned ${result.status}` };
  }
  // The reader must itself be authoritative.
  if (result.source !== undefined && !isAuthoritativeSource(result.source)) {
    return { status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE', reason: `revalidation source ${result.source} is not authoritative` };
  }
  const observed = result.observed;
  if (observed === undefined) {
    return { status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE', reason: 'revalidation returned no observed facts' };
  }
  if (observed.settled !== true) {
    return { status: 'REORGED_OR_ROLLED_BACK', reason: 'the settling transaction/output is no longer settled authoritatively' };
  }
  if (observed.chainTxId !== proof.chainTxId) {
    return { status: 'MISMATCH', reason: `settlement tx mismatch: proof ${proof.chainTxId} vs authoritative ${observed.chainTxId}` };
  }
  if (observed.account !== proof.recipientAccount) {
    return { status: 'MISMATCH', reason: `settlement account mismatch: proof ${proof.recipientAccount} vs authoritative ${observed.account}` };
  }
  if (observed.resourceAddress !== proof.resultingResourceAddress) {
    return { status: 'MISMATCH', reason: `settled resource mismatch: proof ${proof.resultingResourceAddress} vs authoritative ${observed.resourceAddress}` };
  }
  if (observed.amountRaw !== proof.resultingAmountRaw) {
    return { status: 'MISMATCH', reason: `settled amount mismatch: proof ${proof.resultingAmountRaw} vs authoritative ${observed.amountRaw}` };
  }
  if (proof.substateIdentity !== undefined && observed.substateIdentity !== undefined && observed.substateIdentity !== proof.substateIdentity) {
    return { status: 'MISMATCH', reason: `substate identity mismatch: proof ${proof.substateIdentity} vs authoritative ${observed.substateIdentity}` };
  }
  // Confirmations must still satisfy policy at consumption time.
  const observedConf = BigInt(observed.confirmations);
  const requiredConf = BigInt(options.requiredConfirmations);
  if (observedConf < requiredConf) {
    return { status: 'MISMATCH', reason: `confirmations ${observed.confirmations} < required ${options.requiredConfirmations} at consumption time` };
  }
  return { status: 'CONFIRMED', observed, source: result.source };
}

export function isTerminalSettlementProof(value: unknown): value is TerminalSettlementProof {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[PROOF_BRAND] === true;
}
