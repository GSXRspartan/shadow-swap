/**
 * Cross-layer XTM↔TARI session coordinator.
 *
 * Orchestrates: quote → reserve → L1 fund → authoritative verify → L2 fund → verify →
 * CLAIM_ARMED → reveal/claim → opposite claim → terminal reconciliation. Enforces:
 * authoritative reads of BOTH chains, deadline-safety rechecks before every irreversible
 * transition, idempotency by durable operation ids, UNKNOWN reconciliation, restart
 * recovery, and the REAL-SUBMIT GATE (default OFF; MAINNET always refused).
 *
 * The L1 leg is gated on MinotariWalletProvider.primitivesStatus() === 'VERIFIED' — until
 * the real SHA atomic-swap API is traced against Tari source (docs/MINOTARI_ATOMIC_SWAP_API.md)
 * the coordinator refuses real submission but fully executes protocol logic, reservations,
 * state machine, and recovery against provider/test ports.
 */
import {
  CrossChainEvent,
  CrossChainSessionRecord,
  IllegalTransitionError,
  SessionStore,
  applyEvent,
  isTerminal,
  requireHashHBound,
  requireSecretRevealAllowed,
} from './session.js';
import { ReservationLedger } from './reservation.js';
import { CrossChainSecretStore, bytesToHex, hexToBytes, sha256, verifyPreimage } from './secret.js';
import { assertDeadlineSafety } from './deadlines.js';
import { assertTestnetNetwork, requireOperationId, requireRawAmount, requirePositiveAmount, requireIdentifier } from './types.js';
import { IrreversiblePhase } from './deadlines.js';
import { MinotariWalletProvider, OotleScriptPathLegPort, requireLegCapabilities, requireLegCapabilitiesSingle } from './provider.js';

/**
 * Real cross-chain submission gate. Default OFF; MAINNET never passes (assertTestnetNetwork).
 * Single source of truth — import this constant, never re-type the string.
 */
export const REAL_CROSSCHAIN_SUBMIT_ENV = 'TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT';

/** Real cross-chain submission is OFF unless the gate passes. MAINNET never passes. */
export function isRealSubmitEnabled(env: Record<string, string | undefined>, network: string): { enabled: boolean; reason: string } {
  assertTestnetNetwork(network);
  if (env[REAL_CROSSCHAIN_SUBMIT_ENV] !== '1') {
    return { enabled: false, reason: `Real cross-chain submission is gated OFF (set ${REAL_CROSSCHAIN_SUBMIT_ENV}=1 to enable testnet submission)` };
  }
  return { enabled: true, reason: 'testnet real submission enabled by explicit gate' };
}

export class CoordinatorRefusal extends Error {}

export interface CoordinatorPorts {
  l1: MinotariWalletProvider;
  l2: OotleScriptPathLegPort;
  reservations: ReservationLedger;
  secrets: CrossChainSecretStore;
  sessions: SessionStore;
  /**
   * Authoritative deadline-margin source. Before every irreversible phase the coordinator
   * asks THIS for the remaining margins instead of trusting numbers supplied by the caller.
   *
   * SECURITY (cross-layer invariants 10, 11): caller-supplied margins are an assertion
   * about chain state. A caller that under-reports the remaining margin — or simply lies —
   * would otherwise cause the preimage to be disclosed late, stranding or stealing funds.
   * Any real deployment MUST provide this port; `unsafeAllowAssertedDeadlines` exists only
   * for tests and is recorded on the session record as CALLER_ASSERTED evidence.
   */
  deadlineAuthority?: DeadlineAuthority;
}

/** Reads authoritative chain heights/epochs and converts them to remaining margins. */
export interface DeadlineAuthority {
  remainingMargins(input: { sessionId: string; phase: IrreversiblePhase }): Promise<{ l1RemainingMarginMs: string; l2RemainingMarginMs: string }>;
}

export type DeadlineSafetyInput = {
  l1RemainingMarginMs: string;
  l2RemainingMarginMs: string;
  requiredL1MarginMs: string;
  requiredL2MarginMs: string;
};

/**
 * Resolve the margin evidence used at an irreversible phase.
 * With a configured authority, its authoritative read WINS over anything the caller passed.
 */
async function resolveDeadlineSafety(input: {
  ports: CoordinatorPorts;
  sessionId: string;
  phase: IrreversiblePhase;
  asserted: DeadlineSafetyInput;
  allowAsserted: boolean | undefined;
}): Promise<{ safety: DeadlineSafetyInput; source: 'AUTHORITATIVE' | 'CALLER_ASSERTED' }> {
  if (input.ports.deadlineAuthority !== undefined) {
    const authoritative = await input.ports.deadlineAuthority.remainingMargins({ sessionId: input.sessionId, phase: input.phase });
    requireRawAmount(authoritative.l1RemainingMarginMs, 'authoritative l1RemainingMarginMs');
    requireRawAmount(authoritative.l2RemainingMarginMs, 'authoritative l2RemainingMarginMs');
    return {
      safety: { ...input.asserted, l1RemainingMarginMs: authoritative.l1RemainingMarginMs, l2RemainingMarginMs: authoritative.l2RemainingMarginMs },
      source: 'AUTHORITATIVE',
    };
  }
  if (input.allowAsserted !== true) {
    throw new IllegalTransitionError(
      `${input.phase} refused: no authoritative deadline authority configured — refusing to act on caller-asserted margins (pass deadlineAuthority, or explicitly opt in with unsafeAllowAssertedDeadlines)`,
    );
  }
  return { safety: input.asserted, source: 'CALLER_ASSERTED' };
}

export interface CrossChainQuoteView {
  quoteId: string;
  providerId: string;
  direction: 'XTM_TO_TARI' | 'TARI_TO_XTM';
  xtmRawAmount: string;
  tariRawAmount: string;
  hashH: string;
  l1ClaimRecipient: string;
  l2ClaimRecipient: string;
  l1RefundDeadlineHeight: string;
  l2RefundDeadlineEpoch: string;
  requiredL1Confirmations: string;
  quoteExpiresAtUnixMs: number;
  l1Network: string;
  l2Network: string;
}

export interface AcceptQuoteRequest {
  sessionId: string;
  reservationId: string;
  quote: CrossChainQuoteView;
  nowUnixMs: number;
}

/** ACCEPT_QUOTE: create the durable reservation + session (idempotent by durable ids).
 * Capability negotiation happens HERE — before any reservation/funding — so missing
 * wallet functionality can never be discovered mid-swap. */
export async function acceptQuote(input: { request: AcceptQuoteRequest; ports: CoordinatorPorts }): Promise<{ session: CrossChainSessionRecord }> {
  const q = input.request.quote;
  requireOperationId(input.request.sessionId);
  requireOperationId(input.request.reservationId);
  // SECURITY: the quote object crosses a trust boundary (it originates from the peer
  // provider). Validate EVERY field before any inventory is reserved, so a malformed or
  // hostile quote can never become durable session state.
  validateQuoteView(q, input.request.nowUnixMs);
  assertTestnetNetwork(q.l1Network);
  assertTestnetNetwork(q.l2Network);
  // The two legs must belong to the SAME network — a mixed pairing is refused outright.
  if (q.l1Network !== q.l2Network) {
    throw new CoordinatorRefusal(`Mixed-network quote refused: l1=${q.l1Network} l2=${q.l2Network}`);
  }
  // Capability negotiation: fail BEFORE inventory is reserved.
  requireLegCapabilities(q.direction, input.ports.l1.capabilities?.(), input.ports.l2.capabilities?.());
  await input.ports.reservations.reserve({
    reservationId: input.request.reservationId,
    quoteId: q.quoteId,
    providerId: q.providerId,
    direction: q.direction,
    xtmRawAmount: q.xtmRawAmount,
    tariRawAmount: q.tariRawAmount,
    nowUnixMs: input.request.nowUnixMs,
    quoteExpiresAtUnixMs: q.quoteExpiresAtUnixMs,
  });
  const record: CrossChainSessionRecord = {
    sessionId: input.request.sessionId,
    state: 'QUOTED',
    quoteId: q.quoteId,
    reservationId: input.request.reservationId,
    providerId: q.providerId,
    direction: q.direction,
    xtmRawAmount: q.xtmRawAmount,
    tariRawAmount: q.tariRawAmount,
    hashH: q.hashH,
    l1ClaimRecipient: q.l1ClaimRecipient,
    l2ClaimRecipient: q.l2ClaimRecipient,
    l1Network: q.l1Network,
    l2Network: q.l2Network,
    l1RefundDeadlineHeight: q.l1RefundDeadlineHeight,
    l2RefundDeadlineEpoch: q.l2RefundDeadlineEpoch,
    requiredL1Confirmations: q.requiredL1Confirmations,
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
  };
  const advanced = applyEvent(record, { kind: 'ACCEPT_QUOTE', nowUnixMs: input.request.nowUnixMs });
  await input.ports.sessions.save(advanced);
  return { session: advanced };
}

/**
 * Total validation of an untrusted provider quote before it becomes durable state.
 * Everything here is fail-closed: a field we cannot prove is refused, not defaulted.
 */
export function validateQuoteView(q: CrossChainQuoteView, nowUnixMs: number): void {
  requireIdentifier(q.quoteId, 'quote.quoteId');
  requireIdentifier(q.providerId, 'quote.providerId');
  if (q.direction !== 'XTM_TO_TARI' && q.direction !== 'TARI_TO_XTM') {
    throw new CoordinatorRefusal(`Unknown swap direction ${String(q.direction)}`);
  }
  // Amounts: positive integer strings only (never zero, never negative, never a float).
  if (requirePositiveAmount(q.xtmRawAmount, 'quote.xtmRawAmount') === 0n) throw new CoordinatorRefusal('quote XTM amount must be positive');
  if (requirePositiveAmount(q.tariRawAmount, 'quote.tariRawAmount') === 0n) throw new CoordinatorRefusal('quote TARI amount must be positive');
  // H is either a bound 32-byte hash, or EXPLICITLY deferred to authoritative chain
  // readback (TARI_TO_XTM, where the counterparty's wallet generates S). Any other
  // shape is a malformed quote, not a deferred hash.
  if (q.hashH !== '' && !/^[0-9a-f]{64}$/.test(q.hashH)) {
    throw new CoordinatorRefusal(`quote.hashH must be 64 lowercase hex chars or exactly '' when deferred to the chain`);
  }
  // Claim identities are exact addresses and must be present on both legs.
  if (typeof q.l1ClaimRecipient !== 'string' || q.l1ClaimRecipient.trim() === '') throw new CoordinatorRefusal('quote.l1ClaimRecipient is required');
  if (typeof q.l2ClaimRecipient !== 'string' || q.l2ClaimRecipient.trim() === '') throw new CoordinatorRefusal('quote.l2ClaimRecipient is required');
  // Deadlines live in DIFFERENT domains and are validated only as integers — they are
  // never compared to each other here.
  requireRawAmount(q.l1RefundDeadlineHeight, 'quote.l1RefundDeadlineHeight');
  requireRawAmount(q.l2RefundDeadlineEpoch, 'quote.l2RefundDeadlineEpoch');
  if (requirePositiveAmount(q.requiredL1Confirmations, 'quote.requiredL1Confirmations') === 0n) {
    throw new CoordinatorRefusal('quote.requiredL1Confirmations must be positive');
  }
  // An already-expired quote must never be accepted into a funded session.
  if (typeof q.quoteExpiresAtUnixMs !== 'number' || !Number.isFinite(q.quoteExpiresAtUnixMs)) {
    throw new CoordinatorRefusal('quote.quoteExpiresAtUnixMs must be a finite number');
  }
  if (nowUnixMs >= q.quoteExpiresAtUnixMs) {
    throw new CoordinatorRefusal(`Quote ${q.quoteId} already expired at ${nowUnixMs} (expires ${q.quoteExpiresAtUnixMs}) — refusing acceptance`);
  }
}

async function requireState(sessionId: string, ports: CoordinatorPorts, expected: string[]): Promise<CrossChainSessionRecord> {  const record = await ports.sessions.get(sessionId);
  if (!record) throw new CoordinatorRefusal(`Unknown session ${sessionId}`);
  if (!expected.includes(record.state)) {
    throw new IllegalTransitionError(`Session ${sessionId} is ${record.state}; expected one of ${expected.join('/')}`);
  }
  return record;
}

export interface LegFundOutcome {
  outcome: 'SUBMITTED' | 'UNKNOWN' | 'REFUSED';
  txId?: string;
  reason?: string;
}

/** BEGIN_L1_FUNDING: capabilities → gate → deadline safety → construct → authorize → submit. */
export async function beginL1Funding(input: { sessionId: string; ports: CoordinatorPorts; env: Record<string, string | undefined>; deadlineSafety: { l1RemainingMarginMs: string; l2RemainingMarginMs: string; requiredL1MarginMs: string; requiredL2MarginMs: string }; unsafeAllowAssertedDeadlines?: boolean }): Promise<LegFundOutcome> {
  const record = await requireState(input.sessionId, input.ports, ['RESERVED']);
  const gate = isRealSubmitEnabled(input.env, input.ports.l1.network());
  if (!gate.enabled) return { outcome: 'REFUSED', reason: gate.reason };
  // Fail closed on missing L1 wallet capabilities before ANY funding occurs.
  requireLegCapabilitiesSingle(record.direction, 'L1', input.ports.l1.capabilities?.());
  const { safety, source } = await resolveDeadlineSafety({ ports: input.ports, sessionId: input.sessionId, phase: 'FIRST_LEG_FUNDING', asserted: input.deadlineSafety, allowAsserted: input.unsafeAllowAssertedDeadlines });
  assertDeadlineSafety({ phase: 'FIRST_LEG_FUNDING', ...safety });
  const advanced = applyEvent(record, { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: source });
  await input.ports.sessions.save(advanced);
  const intent = input.ports.l1.constructHtlcFunding({
    amountRaw: advanced.xtmRawAmount,
    hash: advanced.hashH,
    claimRecipient: advanced.l1ClaimRecipient,
    // TRACED REALITY: the real Minotari refund branch is the FUNDING WALLET'S own one-sided
    // spend key (wallet-derived, not caller-supplied; no refund recipient on the RPC). The
    // claim address is passed only as the informational intent field, and the authoritative
    // refund identity is re-derived from the observed script during verification below.
    refundRecipient: advanced.l1ClaimRecipient,
    refundHeight: advanced.l1RefundDeadlineHeight,
    network: input.ports.l1.network(),
    operationId: `fund_l1_${advanced.sessionId}`,
  });
  await input.ports.l1.authorizeFunding(intent);
  try {
    const submitted = await input.ports.l1.submitFunding(intent.intent);
    // REAL wallet primitive: the wallet generates S itself and returns it with the ack.
    // Verify + bind H and store S BEFORE any second-leg work can happen.
    let boundHashHex: string | undefined;
    if (submitted.walletPreimageHex !== undefined) {
      boundHashHex = await ingestWalletGeneratedSecret(input.ports, input.sessionId, advanced, submitted.walletPreimageHex);
    }
    const acked = applyEvent(advanced, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: submitted.l1TxId, hashHex: boundHashHex });
    await input.ports.sessions.save(acked);
    return { outcome: 'SUBMITTED', txId: submitted.l1TxId };
  } catch (error) {
    const lost = applyEvent(advanced, { kind: 'L1_FUND_UNKNOWN', transportError: (error as Error).message });
    await input.ports.sessions.save(lost);
    return { outcome: 'UNKNOWN', reason: (error as Error).message };
  }
}

/**
 * Ingest a WALLET-GENERATED preimage (real Minotari primitive — SendShaAtomicSwap returns
 * pre_image to the initiator). S is stored in the secret store (TESTNET_REFERENCE
 * discipline, CLAIM_ARMED-only reveal) and H = SHA256(S) is returned for binding.
 * A mismatch with an already-bound quote hash throws — never silent acceptance.
 */
async function ingestWalletGeneratedSecret(ports: CoordinatorPorts, sessionId: string, record: CrossChainSessionRecord, walletPreimageHex: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(walletPreimageHex)) throw new Error('wallet preimage must be 64 lowercase hex chars');
  const computedH = bytesToHex(await sha256(hexToBytes(walletPreimageHex)));
  if (record.hashH && record.hashH !== '' && record.hashH !== computedH) {
    throw new Error(`wallet-generated H does not match the accepted quote hash (session ${sessionId}) — reconcile`);
  }
  if (ports.secrets.ingestExternalSecret) {
    const stored = await ports.secrets.ingestExternalSecret(sessionId, walletPreimageHex);
    if (stored.hashH !== computedH) throw new Error('secret store hash disagrees with SHA256(S)');
  } else {
    // Without ingestion the ONLY durable copy of S is inside the L1 wallet. Proceed only
    // if the coordinator already retains a matching secret (e.g. a provider honoring an
    // external hash); otherwise a later claim could not reveal S.
    const hasMatching = await ports.secrets.hasSecret(sessionId);
    if (!hasMatching) {
      throw new Error('secret store cannot retain the wallet-generated preimage — refusing to continue without durable S');
    }
  }
  return computedH;
}

/** AUTHORITATIVE first-leg verification — required before funding the second leg. */
export async function verifyL1Funded(input: { sessionId: string; ports: CoordinatorPorts; deadlineSafety: { l1RemainingMarginMs: string; l2RemainingMarginMs: string; requiredL1MarginMs: string; requiredL2MarginMs: string } }): Promise<VerifyOutcome> {
  // BOTH_FUNDED/CLAIM_ARMED are legal here: arming and disclosure RE-VERIFY the first leg
  // authoritatively at that later point rather than trusting the original read.
  const record = await requireState(input.sessionId, input.ports, ['L1_FUNDED', 'L1_FUNDING', 'BOTH_FUNDED', 'CLAIM_ARMED']);
  if (!record.l1TxId) return { verified: false, reason: 'No L1 transaction id recorded' };
  const obs = await input.ports.l1.observeHtlc(record.l1TxId);
  // When the quote did not fix H (real wallet generates S at funding time), the FIRST
  // authoritative on-chain script readback binds it — TARI_TO_XTM direction.
  const hashUnbound = !record.hashH || record.hashH === '';
  const hashFromScriptHex = hashUnbound && obs.hashHex && obs.source !== 'PROVIDER_ASSERTION' ? obs.hashHex : undefined;
  // The amount is only "exact" if it is INDEPENDENTLY PROVEN. A provider that merely
  // remembers the funding intent (e.g. the Minotari reference provider, whose base-node
  // readback yields a blinded commitment, not a revealed value) must set
  // `amountAuthoritative: false`, and settlement then refuses to treat the amount as proven.
  const amountAuthoritative = obs.amountAuthoritative === true;
  // DEADLINE FRESHNESS: matching the quoted deadline is not enough. The observed refund
  // height must still be AHEAD of the current tip, otherwise the output is already
  // refundable and the counterparty could take the first leg back at will.
  const deadlineFresh = deadlineIsFresh(obs.refundHeight, obs.currentHeight, record.requiredL1Confirmations);
  const evidence = {
    l1TxId: record.l1TxId,
    confirmations: obs.confirmations,
    hashMatches: hashUnbound ? hashFromScriptHex !== undefined : obs.hashHex === record.hashH,
    amountExact: obs.amountRaw === record.xtmRawAmount && amountAuthoritative,
    amountAuthoritative,
    deadlineSafe: obs.refundHeight === record.l1RefundDeadlineHeight,
    deadlineFresh,
    confirmationsSufficient: isSufficientConfirmations(obs.confirmations, record.requiredL1Confirmations),
    source: obs.source,
    observedHashHex: obs.hashHex,
    observedAmountRaw: obs.amountRaw,
    observedRefundHeight: obs.refundHeight,
    observedCurrentHeight: obs.currentHeight,
    observedClaimPubKeyHex: obs.claimRecipient,
    observedRefundPubKeyHex: obs.refundRecipient,
    hashFromScriptHex,
    verifiedAtUnixMs: Date.now(),
  };
  const verified =
    evidence.hashMatches &&
    evidence.amountExact &&
    evidence.deadlineSafe &&
    evidence.deadlineFresh &&
    evidence.confirmationsSufficient &&
    obs.exists &&
    obs.source !== 'PROVIDER_ASSERTION' &&
    (hashUnbound ? hashFromScriptHex !== undefined : true);
  if (verified) {
    await input.ports.sessions.save(applyEvent(record, { kind: 'L1_VERIFIED_FUNDED', evidence }));
  }
  return { verified, evidence, reason: verified ? undefined : 'Authoritative L1 readback mismatch' };
}

/** Observed refund height must exceed the tip by at least the required confirmations. */
function deadlineIsFresh(refundHeight: string | undefined, currentHeight: string, requiredConfirmations: string): boolean {
  if (refundHeight === undefined || refundHeight === '') return false;
  try {
    return BigInt(refundHeight) > BigInt(currentHeight) + BigInt(requiredConfirmations);
  } catch {
    return false;
  }
}

/** Confirmation comparison is exact and fail-closed on malformed values. */
function isSufficientConfirmations(observed: string, required: string): boolean {
  try {
    return BigInt(observed) >= BigInt(required);
  } catch {
    return false;
  }
}

export interface VerifyOutcome {
  verified: boolean;
  reason?: string;
  evidence?: unknown;
}

/** BEGIN_L2_FUNDING: only after the first leg is authoritatively verified. */
export async function beginL2Funding(input: { sessionId: string; ports: CoordinatorPorts; env: Record<string, string | undefined>; deadlineSafety: { l1RemainingMarginMs: string; l2RemainingMarginMs: string; requiredL1MarginMs: string; requiredL2MarginMs: string }; unsafeAllowAssertedDeadlines?: boolean }): Promise<LegFundOutcome> {
  const record = await requireState(input.sessionId, input.ports, ['L1_FUNDED']);
  const gate = isRealSubmitEnabled(input.env, input.ports.l1.network());
  if (!gate.enabled) return { outcome: 'REFUSED', reason: gate.reason };
  // SECURITY (cross-layer invariant 2): the second leg may NEVER be funded on an
  // unverified first leg. `l1Verification` is written ONLY by verifyL1Funded on a fully
  // proven authoritative observation, and the state machine refuses to record a partial
  // one — so a submission acknowledgement alone cannot unlock this path.
  if (!record.l1Verification) {
    throw new IllegalTransitionError(`Second-leg funding refused: session ${record.sessionId} has no authoritative L1 verification evidence (run verifyL1Funded first)`);
  }
  // H must be authoritatively bound before the second leg is constructed.
  requireHashHBound(record);
  // Fail closed on missing L2 wallet capabilities before ANY second-leg funding.
  requireLegCapabilitiesSingle(record.direction, 'L2', input.ports.l2.capabilities?.());
  // Never fund the second leg on the first party's word alone: the caller must pass
  // authoritative L1 verification; we re-check the session state enforces it.
  const { safety, source } = await resolveDeadlineSafety({ ports: input.ports, sessionId: input.sessionId, phase: 'SECOND_LEG_FUNDING', asserted: input.deadlineSafety, allowAsserted: input.unsafeAllowAssertedDeadlines });
  assertDeadlineSafety({ phase: 'SECOND_LEG_FUNDING', ...safety });
  const advanced = applyEvent(record, { kind: 'BEGIN_L2_FUNDING', deadlineSafetyEvidence: source });
  await input.ports.sessions.save(advanced);
  try {
    await input.ports.l2.constructFunding({
      hashH: advanced.hashH,
      tariRawAmount: advanced.tariRawAmount,
      claimRecipient: advanced.l2ClaimRecipient,
      refundEpoch: advanced.l2RefundDeadlineEpoch,
      network: advanced.l2Network,
      operationId: `fund_l2_${advanced.sessionId}`,
    });
    await input.ports.l2.authorizeFunding(`fund_l2_${advanced.sessionId}`);
    const submitted = await input.ports.l2.submitFunding(`fund_l2_${advanced.sessionId}`);
    const acked = applyEvent(advanced, { kind: 'L2_FUND_ACKNOWLEDGED', l2TxId: submitted.l2TxId });
    await input.ports.sessions.save(acked);
    await input.ports.reservations.markFunded(advanced.reservationId);
    return { outcome: 'SUBMITTED', txId: submitted.l2TxId };
  } catch (error) {
    const lost = applyEvent(advanced, { kind: 'L2_FUND_UNKNOWN', transportError: (error as Error).message });
    await input.ports.sessions.save(lost);
    return { outcome: 'UNKNOWN', reason: (error as Error).message };
  }
}

/** AUTHORITATIVE L2 verification of the hashlock output. */
export async function verifyL2Funded(input: { sessionId: string; ports: CoordinatorPorts }): Promise<VerifyOutcome> {
  const record = await requireState(input.sessionId, input.ports, ['BOTH_FUNDED', 'L2_FUNDING', 'CLAIM_ARMED']);
  if (!record.l2TxId) return { verified: false, reason: 'No L2 transaction id recorded' };
  const obs = await input.ports.l2.observeHashlockOutput(record.l2TxId);
  const evidence = {
    l2TxId: record.l2TxId,
    hashExact: obs.hashExact === true,
    amountExact: obs.amountRaw === record.tariRawAmount,
    deadlineSafe: obs.epochRefundExact === true,
    claimantExact: obs.claimantExact === true,
    unspent: obs.unspent === true,
    source: obs.source,
    observedAmountRaw: obs.amountRaw,
    verifiedAtUnixMs: Date.now(),
  };
  const ok = obs.exists && obs.source === 'AUTHORITATIVE' && evidence.hashExact && evidence.amountExact && evidence.deadlineSafe && evidence.claimantExact && evidence.unspent;
  if (ok) await input.ports.sessions.save(applyEvent(record, { kind: 'L2_VERIFIED_FUNDED', evidence }));
  return { verified: ok, evidence, reason: ok ? undefined : 'L2 hashlock output failed authoritative verification' };
}

/**
 * CLAIM_ARMED — the last gate before the preimage may ever be disclosed.
 *
 * SECURITY (cross-layer invariants 2, 10, 11, 18): this does NOT trust the durable state,
 * a caller-supplied evidence string, or any cached read. It RE-OBSERVES both chains
 * authoritatively at arm time, so a reorg, a spent output, a changed account, a provider
 * disconnect, or a capability change between funding and arming is caught here rather than
 * after the secret is public.
 */
export async function armClaim(input: { sessionId: string; ports: CoordinatorPorts; deadlineSafety: { l1RemainingMarginMs: string; l2RemainingMarginMs: string; requiredL1MarginMs: string; requiredL2MarginMs: string }; unsafeAllowAssertedDeadlines?: boolean }): Promise<{ armed: boolean; reason?: string }> {
  const record = await requireState(input.sessionId, input.ports, ['BOTH_FUNDED']);
  requireHashHBound(record);
  const toRecovery = async (reason: string) => {
    await input.ports.sessions.save(applyEvent(record, { kind: 'ENTER_RECOVERY', reason }));
    return { armed: false, reason };
  };
  // 1. Both legs must carry authoritative verification stamps from an earlier phase.
  if (!record.l1Verification) return toRecovery('arm refused: no authoritative L1 verification evidence');
  if (!record.l2Verification) return toRecovery('arm refused: no authoritative L2 verification evidence');
  // 2. Capabilities must still hold — a provider that lost a primitive cannot be trusted
  //    to construct the claim that discloses S.
  try {
    requireLegCapabilitiesSingle(record.direction, 'L1', input.ports.l1.capabilities?.());
    requireLegCapabilitiesSingle(record.direction, 'L2', input.ports.l2.capabilities?.());
  } catch (error) {
    return toRecovery(`arm refused: capability lost (${(error as Error).message})`);
  }
  // 3. Deadline margin must still hold immediately before arming.
  let safety: DeadlineSafetyInput;
  try {
    const resolved = await resolveDeadlineSafety({ ports: input.ports, sessionId: input.sessionId, phase: 'CLAIM_ARMED', asserted: input.deadlineSafety, allowAsserted: input.unsafeAllowAssertedDeadlines });
    safety = resolved.safety;
    await input.ports.sessions.save({ ...record, deadlineEvidenceSource: resolved.source });
    assertDeadlineSafety({ phase: 'CLAIM_ARMED', ...safety });
  } catch (error) {
    return toRecovery(`deadline margin unsafe: ${(error as Error).message}`);
  }
  // 4. FRESH authoritative re-observation of BOTH legs. Anything that drifted since the
  //    verification phase (reorg, spend, wrong account, weaker confirmations) refuses.
  const l1 = await verifyL1Funded({ sessionId: input.sessionId, ports: input.ports, deadlineSafety: safety });
  if (!l1.verified) return toRecovery(`arm refused: L1 no longer authoritatively verified (${l1.reason ?? 'mismatch'})`);
  const l2 = await verifyL2Funded({ sessionId: input.sessionId, ports: input.ports });
  if (!l2.verified) return toRecovery('arm refused: L2 no longer authoritatively verified');
  const current = (await input.ports.sessions.get(input.sessionId)) ?? record;
  const armed = applyEvent(current, { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'recheck-passed', claimConstructibleEvidence: 'authoritative-reobservation-passed' });
  await input.ports.sessions.save(armed);
  return { armed: true };
}

/** SECRET REVEAL + claim submission — IRREVERSIBLE. UNKNOWN results force reconciliation. */
export async function revealAndClaimL2(input: { sessionId: string; ports: CoordinatorPorts; env: Record<string, string | undefined>; deadlineSafety: { l1RemainingMarginMs: string; l2RemainingMarginMs: string; requiredL1MarginMs: string; requiredL2MarginMs: string }; unsafeAllowAssertedDeadlines?: boolean }): Promise<LegFundOutcome> {
  const record = await requireState(input.sessionId, input.ports, ['CLAIM_ARMED']);
  const gate = isRealSubmitEnabled(input.env, input.ports.l1.network());
  if (!gate.enabled) return { outcome: 'REFUSED', reason: gate.reason };
  requireHashHBound(record);
  requireSecretRevealAllowed(record);
  // Invariant 10: the margin is recomputed IMMEDIATELY before disclosure, from the
  // authoritative authority. Never from a number the caller asserted earlier.
  const { safety } = await resolveDeadlineSafety({ ports: input.ports, sessionId: input.sessionId, phase: 'SECRET_REVEAL', asserted: input.deadlineSafety, allowAsserted: input.unsafeAllowAssertedDeadlines });
  assertDeadlineSafety({ phase: 'SECRET_REVEAL', ...safety });
  const preimage = await input.ports.secrets.revealSecret(record.sessionId, record.state === 'CLAIM_ARMED');
  // The preimage must hash to the BOUND session hash — never trust storage blindly.
  if (!(await verifyPreimage(preimage, record.hashH))) {
    const bad = applyEvent(record, { kind: 'ENTER_RECOVERY', reason: 'stored preimage does not hash to the bound session hash' });
    await input.ports.sessions.save(bad);
    return { outcome: 'UNKNOWN', reason: 'stored preimage does not match bound hash; reconcile' };
  }
  const revealed = applyEvent(record, { kind: 'REVEAL_SECRET' });
  await input.ports.sessions.save(revealed);
  try {
    await input.ports.l2.constructClaim(record.l2TxId!, preimage, `claim_l2_${record.sessionId}`);
    const submitted = await input.ports.l2.submitClaim(record.l2TxId!, preimage);
    const claiming = applyEvent(applyEvent(record, { kind: 'REVEAL_SECRET' }), { kind: 'BEGIN_CLAIM', leg: 'L2' });
    await input.ports.sessions.save(applyEvent(claiming, { kind: 'CLAIM_ACKNOWLEDGED', leg: 'L2', txId: submitted.l2TxId }));
    return { outcome: 'SUBMITTED', txId: submitted.l2TxId };
  } catch (error) {
    // The secret MAY already be public (the claim may have reached the network even though
    // the response was lost). Persist the recovery transition from the REVEALED record so
    // the durable evidence that S went out is never lost — an operator must be able to see
    // this session can no longer be treated as secret.
    const recovery = applyEvent(revealed, { kind: 'ENTER_RECOVERY', reason: `claim submit unknown: ${(error as Error).message}` });
    await input.ports.sessions.save(recovery);
    return { outcome: 'UNKNOWN', reason: (error as Error).message };
  }
}

/** Opposite-leg claim (L1 by the provider/taker after the preimage is observable). */
export async function claimL1(input: { sessionId: string; preimage: string; ports: CoordinatorPorts }): Promise<LegFundOutcome> {
  // RECOVERY_REQUIRED is deliberately NOT accepted here (cross-layer invariant 14: recovery
  // is absorbing and never auto-resumes execution). Accepting it used to submit the claim
  // and THEN throw on the unrecordable CLAIM_ACKNOWLEDGED transition, so the durable record
  // lost the claim tx id and a retry had no idempotency key. A session in recovery must be
  // explicitly resolved (RECOVERY_RESOLVED) into CLAIMING first.
  const record = await requireState(input.sessionId, input.ports, ['CLAIMING', 'CLAIMED']);
  if (input.ports.l1.capabilities && !input.ports.l1.capabilities().l1ShaClaim) {
    return { outcome: 'REFUSED', reason: 'L1 wallet cannot claim SHA atomic-swap outputs (capability l1ShaClaim unavailable)' };
  }
  if (record.l1ClaimTxId) {
    // Idempotent: a claim already exists for this session; reconcile it.
    const status = await input.ports.l1.lookupTransaction(record.l1ClaimTxId);
    return { outcome: status === 'COMMITTED' ? 'SUBMITTED' : 'UNKNOWN', txId: record.l1ClaimTxId };
  }
  if (record.state === 'CLAIMED') {
    // A CLAIMED session is terminal: there is no transition that could record a new claim
    // acknowledgement, so submitting one would throw AFTER the irreversible submission and
    // strand the evidence. Reconcile by durable id instead of creating an unrecordable claim.
    return { outcome: 'UNKNOWN', reason: 'session is CLAIMED with no recorded L1 claim id — reconcile by durable id; a new submission could not be recorded' };
  }
  // Never submit a preimage that does not hash to the bound hash (real hashlock refusal).
  requireHashHBound(record);
  if (!(await verifyPreimage(input.preimage, record.hashH))) {
    return { outcome: 'REFUSED', reason: 'preimage does not hash to the bound session hash — refusing L1 claim' };
  }
  try {
    await input.ports.l1.constructClaim(record.l1TxId!, input.preimage, record.l1ClaimRecipient, `claim_l1_${record.sessionId}`);
    const submitted = await input.ports.l1.submitClaim(record.l1TxId!, input.preimage);
    await input.ports.sessions.save(applyEvent(record, { kind: 'CLAIM_ACKNOWLEDGED', leg: 'L1', txId: submitted.l1TxId }));
    return { outcome: 'SUBMITTED', txId: submitted.l1TxId };
  } catch (error) {
    return { outcome: 'UNKNOWN', reason: (error as Error).message };
  }
}

/** Refund eligibility requires AUTHORITATIVE chain state (height/epoch), never wall clock. */
export async function assessRefundEligibility(input: { sessionId: string; ports: CoordinatorPorts; l1CurrentHeight: string; l2CurrentEpoch: string }): Promise<{ refundable: boolean; leg?: 'L1' | 'L2'; reason?: string }> {
  const record = await input.ports.sessions.get(input.sessionId);
  if (!record) return { refundable: false, reason: 'unknown session' };
  const l1Passed = BigInt(input.l1CurrentHeight) >= BigInt(record.l1RefundDeadlineHeight);
  const l2Passed = BigInt(input.l2CurrentEpoch) >= BigInt(record.l2RefundDeadlineEpoch);
  if (l1Passed) {
    await input.ports.sessions.save(applyEvent(record, { kind: 'REFUND_ELIGIBLE', leg: 'L1', authorityEvidence: `l1_height=${input.l1CurrentHeight}` }));
    return { refundable: true, leg: 'L1' };
  }
  if (l2Passed) {
    await input.ports.sessions.save(applyEvent(record, { kind: 'REFUND_ELIGIBLE', leg: 'L2', authorityEvidence: `l2_epoch=${input.l2CurrentEpoch}` }));
    return { refundable: true, leg: 'L2' };
  }
  return { refundable: false, reason: `l1_height=${input.l1CurrentHeight}/${record.l1RefundDeadlineHeight} l2_epoch=${input.l2CurrentEpoch}/${record.l2RefundDeadlineEpoch}` };
}

/** Terminal reconciliation: releases inventory exactly once on settlement/refund evidence. */
export async function finalizeSession(input: { sessionId: string; ports: CoordinatorPorts; evidenceOperationId: string; resolution: 'SETTLED' | 'REFUNDED' }): Promise<void> {
  const record = await input.ports.sessions.get(input.sessionId);
  if (!record) return;
  await input.ports.reservations.requestRelease(record.reservationId, input.evidenceOperationId, input.resolution);
  await input.ports.reservations.completeRelease(record.reservationId);
  await input.ports.secrets.destroySecret(input.sessionId);
}

/**
 * RESTART RECOVERY: load durable sessions, query BOTH chains, reconstruct the REAL state.
 * Never trusts the stored pre-crash state alone.
 */
export async function recoverSession(input: { sessionId: string; ports: CoordinatorPorts; preimage?: string }): Promise<RecoveryDecision> {
  const record = await input.ports.sessions.get(input.sessionId);
  if (!record) throw new CoordinatorRefusal('no such session');
  if (isTerminal(record.state)) return { action: undefined, reason: `terminal state ${record.state}; no recovery action required` };
  const l1Status = record.l1TxId ? await input.ports.l1.lookupTransaction(record.l1TxId) : 'NOT_FOUND';
  const l2Status = record.l2TxId ? await input.ports.l2.lookupTransaction(record.l2TxId) : 'NOT_FOUND';
  if (record.l1ClaimTxId) {
    const claimStatus = await input.ports.l1.lookupTransaction(record.l1ClaimTxId);
    if (claimStatus === 'COMMITTED') return { action: 'FINALIZE', resolution: 'SETTLED', reason: 'L1 claim committed' };
  }
  if (record.l2ClaimTxId && (await input.ports.l2.lookupTransaction(record.l2ClaimTxId)) === 'COMMITTED') {
    return { action: 'CONTINUE', reason: 'L2 claim committed; counterparty claim proceeds' };
  }
  if (l1Status === 'COMMITTED' && l2Status === 'COMMITTED') {
    return { action: 'ARM', reason: 'both legs authoritatively funded; re-arm claim' };
  }
  if (l1Status === 'COMMITTED' && l2Status !== 'COMMITTED') {
    return { action: 'CONTINUE', reason: 'L1 funded; L2 leg pending/unknown' };
  }
  if (l1Status === 'NOT_FOUND' && l2Status === 'NOT_FOUND') {
    return { action: 'WAIT_OR_REFUND', reason: 'no authoritative evidence of either funding leg' };
  }
  return { action: 'RECONCILE', reason: `l1=${l1Status} l2=${l2Status}` };
}

export interface RecoveryDecision {
  /**
   * The recovery action, or `undefined` when NO action is required (terminal session —
   * its outcome is already durable and must not be re-driven).
   */
  action?: 'CONTINUE' | 'ARM' | 'CLAIM' | 'WAIT_OR_REFUND' | 'RECONCILE' | 'FINALIZE';
  resolution?: 'SETTLED' | 'REFUNDED';
  reason: string;
}