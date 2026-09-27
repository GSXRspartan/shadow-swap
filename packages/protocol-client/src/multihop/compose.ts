/**
 * Route composition and discovery for this phase: XTM → TARI → AMM output.
 *
 * Deliberately NOT a general graph router. Discovery returns a fixed, explicit hop plan and
 * a structured BLOCKED result for anything else — including the reverse direction, which is
 * not symmetric (§21).
 */
import { ProviderAdvertisement, quoteXtmToTari } from '../crosschain/quote.js';
import { assertTestnetNetwork, requirePositiveAmount, requireRawAmount } from '../crosschain/types.js';
import { SwapQuote, resolveSwap } from '../amm.js';
import { DEFAULT_RECOVERY_POLICY, HopKind, RouteAcceptance, RouteAsset, RouteFeeBreakdown, RouteHop, RoutePriceModel, RouteRecord, hopSafetyFor } from './types.js';

export type RouteDiscoveryResult =
  | { status: 'RESOLVED'; plan: RoutePlan }
  | { status: 'BLOCKED'; reason: RouteBlockReason; detail: string; externalPrerequisite?: string };

export type RouteBlockReason =
  | 'BLOCKED_EXTERNAL'
  | 'UNSUPPORTED_PAIR'
  | 'REVERSE_NOT_SYMMETRIC'
  | 'RESOURCE_NOT_ROUTABLE'
  | 'ACCEPTANCE_BOUNDARY_INVALID';

export interface RouteAssets {
  xtm: RouteAsset;
  tari: RouteAsset;
  destination: RouteAsset;
}

export interface RoutePlan {
  routeId: string;
  hops: Array<{ kind: HopKind; input: RouteAsset; output: RouteAsset }>;
  source: RouteAsset;
  intermediate: RouteAsset;
  destination: RouteAsset;
  /** Only populated for single-hop XTM → TARI plans. */
  providerQuotedTariRaw?: string;
  providerSpreadBps: string;
  poolComponent?: string;
  routeExpiresAtUnixMs: number;
}

/**
 * §20: resolve the routes this phase supports.
 *   XTM → TARI              : FAST_XTM_TARI only
 *   XTM → wSTABLE / token   : FAST_XTM_TARI + AMM_SWAP
 *   reverse (anything → XTM): BLOCKED_EXTERNAL, never pretended
 */
export function discoverRoute(input: {
  routeId: string;
  source: RouteAsset;
  destination: RouteAsset;
  canonicalTari: RouteAsset;
  provider?: ProviderAdvertisement;
  tariPerXtmRate?: string;
  poolComponent?: string;
  nowUnixMs: number;
  routeTtlMs: number;
  destinationRoutingVerdict?: 'ALLOW' | 'REQUIRE_ACKNOWLEDGEMENT';
  /** The source amount the user wants converted (raw XTM). */
  requestAmountRaw?: string;
}): RouteDiscoveryResult {
  try {
    requirePositiveAmount('1', 'discovery sanity');
  } catch {
    return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: 'sanity check failed' };
  }
  if (input.routeId.trim() === '') return { status: 'BLOCKED', reason: 'ACCEPTANCE_BOUNDARY_INVALID', detail: 'routeId is required' };

  // Reverse direction: refuse honestly rather than pretending symmetry.
  if (input.destination.kind === 'MINOTARI_L1') {
    return {
      status: 'BLOCKED',
      reason: 'REVERSE_NOT_SYMMETRIC',
      detail: 'Reverse routes into Minotari L1 are not enabled: the TARI→XTM cross-layer direction requires L1 amount authority for a counterparty-funded leg, which no exposed API can currently provide.',
      externalPrerequisite: 'A wallet/WASM operation that returns a decrypted, range-proof-verified L1 output amount (see security/MINOTARI_AUTHORITY_MODEL.md §2.7).',
    };
  }
  // Only Ootle L2 sources are composable in this phase.
  if (input.source.kind !== 'MINOTARI_L1') {
    return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: `source ${input.source.kind} is not supported in this phase` };
  }
  if (input.destination.kind !== 'OOTLE_L2') {
    return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: `destination ${input.destination.kind} is not supported in this phase` };
  }

  const isSingleHop = input.destination.resourceAddress === input.canonicalTari.resourceAddress;
  if (!isSingleHop && input.destinationRoutingVerdict === undefined) {
    return { status: 'BLOCKED', reason: 'RESOURCE_NOT_ROUTABLE', detail: 'destination routing verdict must be supplied for a non-TARI destination' };
  }
  if (input.destinationRoutingVerdict === 'REQUIRE_ACKNOWLEDGEMENT' && !isSingleHop) {
    return {
      status: 'BLOCKED',
      reason: 'RESOURCE_NOT_ROUTABLE',
      detail: 'destination is issuer-controlled and requires explicit user acknowledgement before it can be routed',
    };
  }

  let providerQuotedTariRaw: string | undefined;
  let providerSpreadBps = '0';
  if (input.provider !== undefined) {
    if (input.tariPerXtmRate === undefined) {
      return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: 'provider supplied without a rate' };
    }
    try {
      // Provider spread is the provider's economic margin and is applied exactly once,
      // here, inside the provider quote.
      providerQuotedTariRaw = quoteXtmToTari(input.provider, input.requestAmountRaw ?? '0', input.tariPerXtmRate).tari;
      providerSpreadBps = input.provider.spreadBps;
    } catch (error) {
      return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: (error as Error).message };
    }
  }

  const hops: RoutePlan['hops'] = [{ kind: 'FAST_XTM_TARI', input: input.source, output: input.canonicalTari }];
  if (!isSingleHop) {
    if (input.poolComponent === undefined) {
      return { status: 'BLOCKED', reason: 'UNSUPPORTED_PAIR', detail: 'a pool component is required for an AMM destination' };
    }
    hops.push({ kind: 'AMM_SWAP', input: input.canonicalTari, output: input.destination });
  }

  return {
    status: 'RESOLVED',
    plan: {
      routeId: input.routeId,
      hops,
      source: input.source,
      intermediate: input.canonicalTari,
      destination: input.destination,
      providerQuotedTariRaw,
      providerSpreadBps,
      poolComponent: input.poolComponent,
      routeExpiresAtUnixMs: input.nowUnixMs + input.routeTtlMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Route record construction
// ---------------------------------------------------------------------------

/** §18: developer trading fee is always zero, by design. Never introduce a rake. */
export function buildRouteFees(input: {
  l1NetworkFeeRaw?: string;
  l2HtlcNetworkFeeRaw?: string;
  providerSpreadRaw?: string;
  ammLpFeeRaw?: string;
  ammNetworkFeeRaw?: string;
}): RouteFeeBreakdown {
  const l1 = input.l1NetworkFeeRaw ?? '0';
  const l2 = input.l2HtlcNetworkFeeRaw ?? '0';
  const spread = input.providerSpreadRaw ?? '0';
  const lp = input.ammLpFeeRaw ?? '0';
  const net = input.ammNetworkFeeRaw ?? '0';
  for (const [name, v] of Object.entries({ l1, l2, spread, lp, net })) {
    if (!/^\d+$/.test(v)) throw new Error(`${name} fee must be a raw non-negative integer string, got ${v}`);
  }
  const total = BigInt(l1) + BigInt(l2) + BigInt(spread) + BigInt(lp) + BigInt(net);
  return {
    l1NetworkFeeRaw: l1,
    l2HtlcNetworkFeeRaw: l2,
    providerSpreadRaw: spread,
    ammLpFeeRaw: lp,
    ammNetworkFeeRaw: net,
    developerTradingFeeRaw: '0',
    totalRaw: total.toString(),
  };
}

/** §19: price model in raw integers. effective price uses 1e18 scaling, never a float. */
export function buildRoutePrice(input: {
  sourceInputRaw: string;
  providerQuotedTariRaw?: string;
  acceptedMinimumFinalOutputRaw: string;
  ammQuote?: Pick<SwapQuote, 'quotedOutput' | 'minOutput'>;
}): RoutePriceModel {
  const model: RoutePriceModel = {
    sourceInputRaw: input.sourceInputRaw,
    providerQuotedTariRaw: input.providerQuotedTariRaw ?? '0',
    acceptedMinimumFinalOutputRaw: input.acceptedMinimumFinalOutputRaw,
  };
  if (input.ammQuote !== undefined) {
    model.ammExpectedOutputRaw = input.ammQuote.quotedOutput;
    model.ammMinimumOutputRaw = input.ammQuote.minOutput;
    // The final minimum is the HARDER of the AMM min_output and the user's accepted floor.
    model.acceptedMinimumFinalOutputRaw = (BigInt(input.ammQuote.minOutput) > BigInt(input.acceptedMinimumFinalOutputRaw) ? input.ammQuote.minOutput : input.acceptedMinimumFinalOutputRaw).toString();
  }
  const finalOut = model.ammExpectedOutputRaw ?? model.settledTariRaw ?? model.providerQuotedTariRaw;
  if (finalOut !== undefined && BigInt(finalOut) > 0n && BigInt(input.sourceInputRaw) > 0n) {
    // 1e18-scaled integer division. No floating point anywhere in settlement math.
    model.effectiveRoutePriceX18 = ((BigInt(finalOut) * 1_000_000_000_000_000_000n) / BigInt(input.sourceInputRaw)).toString();
  }
  return model;
}

export interface BuildRouteInput {
  routeId: string;
  plan: RoutePlan;
  acceptance: RouteAcceptance;
  fees: RouteFeeBreakdown;
  price: RoutePriceModel;
  totalExpectedOutputRaw: string;
  totalMinimumOutputRaw: string;
  quoteExpiresAtUnixMs: number;
  intermediateAccount: string;
  ammSlippagePolicy?: { slippageBps: string };
  nowUnixMs: number;
}

export function buildRouteRecord(input: BuildRouteInput): RouteRecord {
  const hops: RouteHop[] = [
    {
      hopId: 'hop_1',
      index: 0,
      kind: 'FAST_XTM_TARI',
      inputAsset: input.plan.source,
      outputAsset: input.plan.intermediate,
      // Hop 1's input is the authorized source amount.
      inputAmountRaw: input.acceptance.authorizedSourceAmountRaw,
      expectedOutputRaw: input.price.providerQuotedTariRaw,
      safety: hopSafetyFor('FAST_XTM_TARI'),
      execution: 'NOT_STARTED',
      settlement: 'UNSETTLED',
    },
  ];
  if (input.plan.hops.length > 1) {
    hops.push({
      hopId: 'hop_2',
      index: 1,
      kind: 'AMM_SWAP',
      inputAsset: input.plan.intermediate,
      outputAsset: input.plan.destination,
      // Hop 2's input is UNSET until a settlement proof supplies the proven amount. It is
      // never pre-filled with the quote: that is exactly the "stale quoted input" bug.
      inputAmountRaw: '',
      expectedOutputRaw: input.price.ammExpectedOutputRaw ?? '0',
      minimumOutputRaw: input.price.ammMinimumOutputRaw ?? input.acceptance.minimumFinalOutputRaw,
      safety: hopSafetyFor('AMM_SWAP'),
      execution: 'NOT_STARTED',
      settlement: 'UNSETTLED',
    });
  }
  return {
    routeId: input.routeId,
    state: 'ROUTE_QUOTED',
    sourceAsset: input.plan.source,
    destinationAsset: input.plan.destination,
    totalExpectedOutputRaw: input.totalExpectedOutputRaw,
    totalMinimumOutputRaw: input.totalMinimumOutputRaw,
    quoteExpiresAtUnixMs: input.quoteExpiresAtUnixMs,
    routeExpiresAtUnixMs: input.plan.routeExpiresAtUnixMs,
    hops,
    acceptance: input.acceptance,
    fees: input.fees,
    price: input.price,
    recovery: DEFAULT_RECOVERY_POLICY,
    intermediateAccount: input.intermediateAccount,
    createdAtUnixMs: input.nowUnixMs,
    updatedAtUnixMs: input.nowUnixMs,
  };
}
