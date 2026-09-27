/**
 * Router integration for the FAST_XTM_TARI cross-layer route.
 *
 * Single-hop in this phase. Composition seam (NOT implemented until failure semantics are
 * audited): XTM → FAST_XTM_TARI → TARI → AMM → wSTABLE. No unsafe multi-hop atomic
 * composition is implemented here.
 */
import { requirePositiveAmount, assertTestnetNetwork } from './types.js';
import { ProviderAdvertisement, CrossChainQuote } from './quote.js';

export type RouteKind = 'FAST_XTM_TARI';

/**
 * AUTHORITATIVE settlement status of the cross-layer leg. A composed hop (e.g. an AMM
 * deposit) may only start from a terminal, chain-proven outcome.
 *
 * SECURITY (multi-hop boundary): 'UNSETTLED' is the only value a freshly resolved route
 * can carry, and `RouteResult.composable` is hard-wired to false. A downstream hop must
 * never infer "probably done" from funding progress, a submitted transaction, or a
 * coordinator's optimism.
 */
export type RouteSettlementStatus = 'UNSETTLED' | 'CLAIMED' | 'REFUNDED' | 'FAILED_TERMINAL';

export interface RouteRequest {
  source: 'XTM' | 'TARI';
  destination: 'TARI' | 'XTM';
  amountRaw: string;
  network: string;
}

export interface RouteResult {
  routeKind: RouteKind;
  provider: ProviderAdvertisement;
  quote: CrossChainQuote;
  /** Exact input/output in raw integer units (BigInt strings). */
  inputAmount: string;
  expectedOutput: string;
  estimatedNetworkFeeL1?: string;
  estimatedNetworkFeeL2?: string;
  requiredL1Confirmations: string;
  quoteExpiresAtUnixMs: number;
  routeState: 'RESOLVABLE' | 'UNAVAILABLE';
  routeStateReason?: string;
  /**
   * Progress flags are ADVISORY UI state only — they are never settlement evidence and
   * `routeResult` always emits all-false here.
   */
  fundingProgress: { l1Funded: boolean; l2Funded: boolean; claimArmed: boolean; claimed: boolean; refunded: boolean };
  /**
   * Durable operation identity for the cross-layer session, once one exists. A composed
   * hop needs this to observe the SAME session, never a fresh lookup by amount.
   */
  operationId?: string;
  /** Chain-proven settlement status. Only a terminal value permits composition. */
  settlementStatus: RouteSettlementStatus;
  /**
   * Hard-wired false in this phase. Multi-hop composition (XTM → TARI → AMM) stays
   * blocked until a composed hop can consume an authoritative, terminal settlement proof.
   */
  composable: false;
  /** The secret S is NEVER part of a route result. */
  containsSecret: false;
}

export function routeResult(input: { request: RouteRequest; ad: ProviderAdvertisement; quote: CrossChainQuote }): RouteResult {
  const validPair =
    (input.request.source === 'XTM' && input.request.destination === 'TARI') ||
    (input.request.source === 'TARI' && input.request.destination === 'XTM');
  if (!validPath(validPair)) throw new Error(`Unsupported route ${input.request.source} → ${input.request.destination}`);
  requirePositiveAmount(input.request.amountRaw, 'amountRaw');
  // SECURITY: the route must be refused on a network that is not the allowlisted testnet,
  // and on any mismatch between the request and the quote it is priced from.
  assertTestnetNetwork(input.request.network);
  if (input.quote.l1Network !== input.request.network || input.quote.l2Network !== input.request.network) {
    throw new Error(`Quote network mismatch: request ${input.request.network} vs quote ${input.quote.l1Network}/${input.quote.l2Network}`);
  }
  if (input.ad.network !== input.request.network) {
    throw new Error(`Advertisement network mismatch: request ${input.request.network} vs provider ${input.ad.network}`);
  }
  return {
    routeKind: 'FAST_XTM_TARI',
    provider: input.ad,
    quote: input.quote,
    inputAmount: input.request.amountRaw,
    expectedOutput: input.request.source === 'XTM' ? input.quote.tariRawAmount : input.quote.xtmRawAmount,
    requiredL1Confirmations: input.ad.requiredL1Confirmations,
    quoteExpiresAtUnixMs: input.quote.quoteExpiresAtUnixMs,
    routeState: 'RESOLVABLE',
    fundingProgress: { l1Funded: false, l2Funded: false, claimArmed: false, claimed: false, refunded: false },
    settlementStatus: 'UNSETTLED',
    composable: false,
    containsSecret: false,
  };
}

function validPath(ok: boolean): boolean {
  return ok;
}