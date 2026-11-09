/**
 * Production L2 (Ootle) leg adapter for the cross-layer coordinator.
 *
 * Maps the coordinator's `OotleScriptPathLegPort` onto the wallet's own native HTLC
 * request kinds — `htlcFund` / `htlcClaim` / `htlcRefund` via
 * `tari_createTransactionRequest` (see `services/tariWindow.ts` and the published
 * contract at https://universe.tari.mw/integration/llms-full.txt). The WALLET builds
 * the StealthTransfer and the script-path conditions internally; the dApp supplies
 * only public terms (resource, amount, claimant wallet address, SHA256(S), refund
 * epoch) and never holds key material, balance proofs or per-input authorisations.
 *
 * Contract with the coordinator (`beginL2Funding` etc.): `constructFunding` validates,
 * records the intended terms keyed by the coordinator's `operationId`, and creates the
 * wallet request (which prompts the user). `authorizeFunding` reports the wallet's
 * live approval state. `submitFunding` submits BY REQUEST ID only (the wallet
 * broadcasts the exact reviewed request), parses the wallet-returned
 * commitment/conditions/outputMask from the request result, and returns the tx id.
 * Claim and refund follow the same two-call shape. LU sequence numbers are carried in
 * the adapter-local binding, never in a new transaction.
 *
 * WHAT THIS PORT DOES NOT DO.
 * - No L1 (Minotari) signing: `window.tari` has no L1 methods, so the coordinator's
 *   quote-acceptance gate refuses atomic swaps from the browser until upstream adds
 *   L1 methods. This adapter is only the L2 half.
 * - No auto-submit and no secret persistence: every spend is a wallet request that
 *   persists by requestId; the preimage (S) is passed to `constructClaim` at call
 *   time and is never written to storage, logs or URLs. Only non-secret fields
 *   (commitment, conditions, outputMask — all returned by the wallet and visible
 *   on-chain) are persisted.
 *
 * The binding is an allowlisted localStorage record so a reload between fund and
 * claim still recovers. `localStorage` is untrusted input here: it is only ever used
 * to look values up; settlement evidence always comes from fresh chain reads via
 * `observeHashlockOutput`, and every unrecognised observation fails closed.
 */

import {
  NO_WALLET_LEG_CAPABILITIES,
  requireLegCapabilitiesSingle,
  type OotleScriptPathLegPort,
  type WalletLegCapabilities,
  type SwapDirectionKind,
} from '@tari-ootle/protocol-client/crosschain';
import { parseOotleAddress } from '@tari-ootle/protocol-client';
import {
  TariProviderError,
  createTransactionRequest,
  fetchCapabilities,
  fetchTransactionResult,
  htlcClaimOperation,
  htlcFundOperation,
  htlcRefundOperation,
  mapLegCapabilities,
  mapTransactionStatus,
  pollTransactionRequest,
  resumeTransactionRequest,
  type TariProvider,
} from './tariWindow.js';
import { isExecutionNetwork } from '../lib/networks.js';

/** The directions this adapter gates on: the strictest L2 union of both. */
const STRICT_DIRECTION: SwapDirectionKind = 'TARI_TO_XTM';

const LEG_STORAGE_KEY = 'ootle.htlcLeg.v1';
const MAX_LEG_RECORDS = 50;
const MAX_STRING = 1024;

export interface HtlcLegBinding {
  readonly operationId: string;
  readonly resourceAddress: string;
  readonly amountRaw: string;
  readonly hashH: string;
  readonly claimantWalletAddress: string;
  readonly refundEpoch: string;
  readonly network: string;
  readonly fundRequestId?: string;
  readonly l2TxId?: string;
  readonly commitment?: string;
  readonly conditions?: readonly unknown[];
  readonly outputMask?: string;
  readonly claimRequestId?: string;
  readonly claimTxId?: string;
  readonly refundRequestId?: string;
  readonly refundTxId?: string;
}

/**
 * Fields that must NEVER be persisted. A preimage stored in localStorage is readable
 * by anything with origin access and survives in backups; the coordinator's secret
 * store is the only home for S, and it is not browser storage.
 */
export const FORBIDDEN_LEG_FIELDS = [
  'preimage',
  'preimageHex',
  'secret',
  'secretHex',
  'seed',
  'privateKey',
  'signature',
  'authorization',
] as const;

const LEG_ALLOWED = new Set<string>([
  'operationId',
  'resourceAddress',
  'amountRaw',
  'hashH',
  'claimantWalletAddress',
  'refundEpoch',
  'network',
  'fundRequestId',
  'l2TxId',
  'commitment',
  'conditions',
  'outputMask',
  'claimRequestId',
  'claimTxId',
  'refundRequestId',
  'refundTxId',
]);

function legRecord(value: unknown): HtlcLegBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const bag = value as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (!LEG_ALLOWED.has(key)) return undefined;
    if ((FORBIDDEN_LEG_FIELDS as readonly string[]).includes(key)) return undefined;
  }
  const str = (key: string): string | undefined => {
    const v = bag[key];
    return typeof v === 'string' && v !== '' && v.length <= MAX_STRING ? v : undefined;
  };
  const operationId = str('operationId');
  const resourceAddress = str('resourceAddress');
  const amountRaw = str('amountRaw');
  const hashH = str('hashH');
  const claimantWalletAddress = str('claimantWalletAddress');
  const refundEpoch = str('refundEpoch');
  const network = str('network');
  if (!operationId || !resourceAddress || !amountRaw || !hashH || !claimantWalletAddress || !refundEpoch || !network) return undefined;
  if (!/^\d+$/.test(amountRaw)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(hashH)) return undefined;
  const out: Record<string, unknown> = { operationId, resourceAddress, amountRaw, hashH, claimantWalletAddress, refundEpoch, network };
  for (const key of ['fundRequestId', 'l2TxId', 'commitment', 'outputMask', 'claimRequestId', 'claimTxId', 'refundRequestId', 'refundTxId']) {
    const v = str(key);
    if (v !== undefined) out[key] = v;
  }
  if (bag.conditions !== undefined) {
    if (!Array.isArray(bag.conditions) || bag.conditions.length === 0) return undefined;
    out.conditions = bag.conditions;
  }
  return out as unknown as HtlcLegBinding;
}

export interface LegStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeLocalStorage(): LegStorage | undefined {
  try {
    if (typeof window === 'undefined' || window.localStorage === undefined) return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function loadLegs(storage: LegStorage | undefined): Map<string, HtlcLegBinding> {
  const map = new Map<string, HtlcLegBinding>();
  if (storage === undefined) return map;
  try {
    const raw = storage.getItem(LEG_STORAGE_KEY);
    if (raw === null || raw === '') return map;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return map;
    const bag = parsed as Record<string, unknown>;
    if (bag.version !== 1 || !Array.isArray(bag.records)) return map;
    for (const entry of bag.records) {
      const rec = legRecord(entry);
      if (rec !== undefined && rec.operationId !== '') map.set(rec.operationId, rec);
    }
  } catch {
    return new Map();
  }
  return map;
}

function saveLegs(storage: LegStorage | undefined, map: Map<string, HtlcLegBinding>): void {
  if (storage === undefined) return;
  try {
    const records = [...map.values()].slice(0, MAX_LEG_RECORDS);
    storage.setItem(LEG_STORAGE_KEY, JSON.stringify({ version: 1, records }));
  } catch {
    /* persistence is a recovery aid; the chain remains the record */
  }
}

export interface OotleHtlcLegOptions {
  provider: TariProvider;
  /** The L2 asset this leg trades (the port knows its asset; the quote prices it). */
  resourceAddress: string;
  network: string;
  /** Last-known leg capabilities snapshot (fetch via `legCapabilitiesOf`). */
  legCapabilities?: WalletLegCapabilities | undefined;
  /** Authoritative raw substate read (the value `tari_getSubstate` returns). */
  readSubstate: (substateId: string) => Promise<unknown>;
  storage?: LegStorage | undefined;
}

/** Parse an htlcFund submit result: the wallet's own returned commitment/conditions/mask. */
export function parseHtlcFundResult(result: unknown): { commitment: string; conditions: readonly unknown[]; outputMask: string } {
  const bag = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const commitment = bag.ownCommitment ?? bag.commitment;
  if (typeof commitment !== 'string' || commitment === '') {
    throw new TariProviderError('The wallet\u2019s htlcFund result carried no ownCommitment; refusing to guess which output was funded.', 'MALFORMED_REPLY');
  }
  const conditions = bag.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new TariProviderError('The wallet\u2019s htlcFund result carried no conditions; refusing to guess the claim/refund terms.', 'MALFORMED_REPLY');
  }
  const outputMask = bag.outputMask;
  if (typeof outputMask !== 'string' || outputMask === '') {
    throw new TariProviderError('The wallet\u2019s htlcFund result carried no outputMask; refusing to fund without a recovery path.', 'MALFORMED_REPLY');
  }
  return { commitment, conditions, outputMask };
}

/**
 * Verify an observed funded output against recorded terms. Defensive by design: any
 * unrecognised shape fails closed (a flag stays false) rather than being guessed at —
 * a guessed observation could authorise the preimage reveal on an unfunded or wrong
 * output.
 */
export function classifyHtlcObservation(
  substate: unknown,
  expected: { hashH: string; amountRaw: string; claimantWalletAddress: string; refundEpoch: string },
): { exists: boolean; amountRaw: string; hashExact: boolean; claimantExact: boolean; epochRefundExact: boolean; unspent: boolean } {
  if (substate === null || substate === undefined) {
    return { exists: false, amountRaw: '0', hashExact: false, claimantExact: false, epochRefundExact: false, unspent: false };
  }
  // Flatten every scalar string/number in the raw substate value for searching.
  const scalars: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || scalars.length > 5000) return;
    if (typeof node === 'string') scalars.push(node);
    else if (typeof node === 'number' || typeof node === 'bigint') scalars.push(String(node));
    else if (Array.isArray(node)) for (const entry of node) walk(entry, depth + 1);
    else if (typeof node === 'object' && node !== null) for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
  };
  walk(substate, 0);
  const lower = scalars.map((s) => s.toLowerCase());
  const hashExact = lower.some((s) => s === expected.hashH.toLowerCase());
  let claimantPubkey = '';
  try {
    claimantPubkey = parseOotleAddress(expected.claimantWalletAddress).accountPublicKeyHex.toLowerCase();
  } catch {
    claimantPubkey = '';
  }
  const claimantExact = claimantPubkey !== '' && lower.some((s) => s === claimantPubkey);
  const epochExact = lower.some((s) => s === expected.refundEpoch);
  const amountExact = lower.some((s) => s === expected.amountRaw);
  // `unspent` is evidenced by presence: a spent output is DOWN and reads undefined.
  return {
    exists: true,
    amountRaw: amountExact ? expected.amountRaw : '0',
    hashExact,
    claimantExact,
    epochRefundExact: epochExact,
    unspent: true,
  };
}

/** Fetch the provider's leg capabilities. Used at construction and before each spend. */
export async function legCapabilitiesOf(provider: TariProvider): Promise<WalletLegCapabilities | undefined> {
  const caps = await fetchCapabilities(provider);
  return mapLegCapabilities(caps) ?? undefined;
}

export function createOotleHtlcLeg(options: OotleHtlcLegOptions): OotleScriptPathLegPort {
  const { provider, resourceAddress, network } = options;
  if (!/^resource_[0-9a-f]{64}$/.test(resourceAddress)) {
    throw new TariProviderError('createOotleHtlcLeg requires resource_<64 hex> as the leg asset.', 'REJECTED');
  }
  const storage = options.storage !== undefined ? options.storage : safeLocalStorage();
  const legs = loadLegs(storage);
  const persist = (): void => saveLegs(storage, legs);
  const get = (operationId: string): HtlcLegBinding => {
    const binding = legs.get(operationId);
    if (binding === undefined) throw new TariProviderError(`No HTLC leg binding recorded for ${operationId}.`, 'MALFORMED_REPLY');
    return binding;
  };
  const update = (operationId: string, patch: Partial<HtlcLegBinding>): HtlcLegBinding => {
    const next = { ...get(operationId), ...patch } as HtlcLegBinding;
    legs.set(operationId, next);
    persist();
    return next;
  };
  const liveCaps = async (): Promise<WalletLegCapabilities | undefined> => {
    try {
      const fresh = await legCapabilitiesOf(provider);
      if (fresh !== undefined) return fresh;
    } catch {
      /* fall through to the snapshot */
    }
    return options.legCapabilities;
  };
  const requireL2Caps = async (): Promise<void> => {
    const caps = await liveCaps();
    if (caps === undefined) throw new TariProviderError('HTLC leg cannot read the wallet\u2019s capability advertisement.', 'UNKNOWN');
    requireLegCapabilitiesSingle(STRICT_DIRECTION, 'L2', caps);
  };
  const submitByBinding = async (operationId: string, kind: 'fund' | 'claim' | 'refund'): Promise<{ l2TxId: string }> => {
    const binding = get(operationId);
    const requestId = kind === 'fund' ? binding.fundRequestId : kind === 'claim' ? binding.claimRequestId : binding.refundRequestId;
    if (requestId === undefined) throw new TariProviderError(`No ${kind} requestId recorded for ${operationId}; construct first.`, 'MALFORMED_REPLY');
    // `resumeTransactionRequest` is the reload-safe approve/submit primitive: PENDING
    // returns an id (never submits), APPROVED submits once by id, SUBMITTED reuses the
    // stored result without a duplicate broadcast.
    const resumed = await resumeTransactionRequest(provider, requestId, {
      onRequestId: () => undefined,
      onSubmitted: () => undefined,
    });
    if ('pendingRequestId' in resumed) {
      throw new TariProviderError(`The ${kind} approval for ${operationId} is still pending in the wallet; poll again before submitting.`, 'UNKNOWN');
    }
    const txId = resumed.transactionId;
    if (kind === 'fund') {
      const outcome = await pollTransactionRequest(provider, requestId);
      if (outcome.state !== 'SUBMITTED') {
        throw new TariProviderError(`htlcFund submission did not settle as submitted (${outcome.state}).`, 'MALFORMED_REPLY');
      }
      const parsed = parseHtlcFundResult(outcome.result ?? { ownCommitment: '' });
      update(operationId, { l2TxId: txId, commitment: parsed.commitment, conditions: parsed.conditions, outputMask: parsed.outputMask });
    } else if (kind === 'claim') {
      update(operationId, { claimTxId: txId });
    } else {
      update(operationId, { refundTxId: txId });
    }
    return { l2TxId: txId };
  };

  return {
    capabilities(): WalletLegCapabilities {
      // No snapshot: report every capability as absent (fails closed through the
      // coordinator's own missing-key refusal), never throw and never assume.
      return options.legCapabilities ?? NO_WALLET_LEG_CAPABILITIES;
    },

    async constructFunding(intent) {
      await requireL2Caps();
      if (!isExecutionNetwork(network)) {
        throw new TariProviderError(`HTLC funding refused: network "${network}" is not an execution network for this build.`, 'REJECTED');
      }
      if (!/^[0-9a-f]{64}$/.test(intent.hashH)) throw new TariProviderError('HTLC funding requires a 64-hex hash lock.', 'REJECTED');
      if (!/^[1-9]\d*$/.test(intent.tariRawAmount)) throw new TariProviderError('HTLC funding requires a positive raw amount.', 'REJECTED');
      if (!/^[1-9]\d*$/.test(intent.refundEpoch)) throw new TariProviderError('HTLC funding requires a positive refund epoch.', 'REJECTED');
      try {
        parseOotleAddress(intent.claimRecipient);
      } catch {
        throw new TariProviderError('HTLC funding requires the claimant as an otl_… wallet address the wallet can pay to.', 'REJECTED');
      }
      const operation = htlcFundOperation({
        resourceAddress,
        amount: intent.tariRawAmount,
        claimantWalletAddress: intent.claimRecipient,
        hashLockHex: intent.hashH,
        refundEpoch: intent.refundEpoch,
      });
      const requestId = await createTransactionRequest(provider, operation);
      legs.set(intent.operationId, {
        operationId: intent.operationId,
        resourceAddress,
        amountRaw: intent.tariRawAmount,
        hashH: intent.hashH,
        claimantWalletAddress: intent.claimRecipient,
        refundEpoch: intent.refundEpoch,
        network: intent.network ?? network,
        fundRequestId: requestId,
      });
      persist();
      return { feeEstimate: '0' };
    },

    async authorizeFunding(operationId) {
      const binding = get(operationId);
      if (binding.fundRequestId === undefined) throw new TariProviderError(`No fund requestId for ${operationId}; construct first.`, 'MALFORMED_REPLY');
      const outcome = await pollTransactionRequest(provider, binding.fundRequestId);
      if (outcome.state === 'APPROVED') return { authorized: true };
      if (outcome.state === 'PENDING') {
        throw new TariProviderError(`Approval for ${operationId} is still pending in the wallet; poll again before submitting.`, 'UNKNOWN');
      }
      if (outcome.state === 'SUBMITTED') return { authorized: true };
      throw new TariProviderError(
        outcome.state === 'REJECTED'
          ? `The user declined the HTLC funding for ${operationId}.`
          : `The wallet reported the HTLC funding for ${operationId} as ${outcome.state}.`,
        outcome.state === 'REJECTED' ? 'REJECTED' : 'MALFORMED_REPLY',
      );
    },

    async submitFunding(operationId) {
      return submitByBinding(operationId, 'fund');
    },

    async observeHashlockOutput(l2TxId) {
      const entry = [...legs.values()].find((l) => l.l2TxId === l2TxId);
      if (entry === undefined || entry.commitment === undefined) {
        return { exists: false, amountRaw: '0', hashExact: false, claimantExact: false, epochRefundExact: false, unspent: false, source: 'AUTHORITATIVE' as const };
      }
      const substate = await options.readSubstate(entry.commitment);
      const parsed = classifyHtlcObservation(substate, entry);
      return { ...parsed, source: 'AUTHORITATIVE' as const };
    },

    async constructClaim(l2TxId, preimage, operationId) {
      await requireL2Caps();
      const binding = get(operationId);
      if (binding.commitment === undefined || binding.conditions === undefined) {
        throw new TariProviderError(`Claim for ${operationId} refused: the funding commitment is not recorded.`, 'MALFORMED_REPLY');
      }
      void l2TxId;
      const operation = htlcClaimOperation({
        resourceAddress: binding.resourceAddress,
        commitment: binding.commitment,
        conditions: [...binding.conditions],
        preimageHex: preimage,
      });
      const requestId = await createTransactionRequest(provider, operation);
      update(operationId, { claimRequestId: requestId });
      return { feeEstimate: '0' };
    },

    async submitClaim(l2TxId, preimage) {
      void preimage;
      const entry = [...legs.values()].find((l) => l.l2TxId === l2TxId);
      if (entry === undefined) throw new TariProviderError(`No HTLC leg funded with tx ${l2TxId}; refusing to guess the claim.`, 'MALFORMED_REPLY');
      return submitByBinding(entry.operationId, 'claim');
    },

    async constructRefund(l2TxId, operationId) {
      await requireL2Caps();
      const binding = get(operationId);
      if (binding.commitment === undefined || binding.conditions === undefined || binding.outputMask === undefined) {
        throw new TariProviderError(`Refund for ${operationId} refused: the funding commitment/mask is not recorded.`, 'MALFORMED_REPLY');
      }
      void l2TxId;
      const operation = htlcRefundOperation({
        resourceAddress: binding.resourceAddress,
        commitment: binding.commitment,
        conditions: [...binding.conditions],
        amount: binding.amountRaw,
        outputMask: binding.outputMask,
      });
      const requestId = await createTransactionRequest(provider, operation);
      update(operationId, { refundRequestId: requestId });
      return { feeEstimate: '0' };
    },

    async submitRefund(l2TxId) {
      const entry = [...legs.values()].find((l) => l.l2TxId === l2TxId);
      if (entry === undefined) throw new TariProviderError(`No HTLC leg funded with tx ${l2TxId}; refusing to guess the refund.`, 'MALFORMED_REPLY');
      return submitByBinding(entry.operationId, 'refund');
    },

    async lookupTransaction(l2TxId) {
      const view = await fetchTransactionResult(provider, l2TxId);
      return mapTransactionStatus(view);
    },
  };
}
