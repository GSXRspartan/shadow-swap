/**
 * The unified trading-route resolver: given two resources, which settlement mechanisms can
 * ACTUALLY execute, and why the others cannot.
 *
 * A mechanism is reported `EXECUTABLE` only when this build constructs its transaction end to
 * end (intent builder -> review -> wallet request). Everything else is reported with its
 * exact blocker, so the UI never offers a route that cannot be signed. A resource's type is
 * never changed to make a route pass: the mechanism is chosen FROM the types, never the
 * other way round.
 *
 * Evidence for every status lives in docs/SHADOW_SWAP_TRADING_ROUTES_IMPLEMENTATION.md.
 */

import { rankRoutes, type PoolEdge, type RouteQuote } from '@tari-ootle/protocol-client';

export type AssetKind = 'fungible' | 'stealth' | 'confidential' | 'non_fungible' | 'unknown';

export type Mechanism =
  | 'AMM'
  | 'MULTI_HOP_AMM'
  | 'NFT_MARKETPLACE'
  | 'P2P_OFFER'
  | 'NFT_BARTER'
  | 'CROSS_LAYER';

export type Availability = 'EXECUTABLE' | 'NO_LIQUIDITY' | 'ENGINE_VERIFIED_NOT_ENABLED' | 'BLOCKED' | 'NOT_APPLICABLE';

export interface RouteOption {
  readonly mechanism: Mechanism;
  readonly label: string;
  readonly availability: Availability;
  /** Present when not EXECUTABLE. Shown verbatim. */
  readonly reason?: string;
  readonly privacy: string;
  readonly requiredCapabilities: readonly string[];
  /** AMM mechanisms only: executable quotes, best first. */
  readonly quotes?: readonly RouteQuote[];
}

export interface PairInput {
  readonly input: { readonly resource: string; readonly kind: AssetKind };
  readonly output: { readonly resource: string; readonly kind: AssetKind };
  readonly amountIn?: string;
  /** Verified pools with AUTHORITATIVE reserves (never a discovery snapshot). */
  readonly pools: readonly PoolEdge[];
  /** Whether the verified network generation records a Shadow Swap Pool template. */
  readonly poolTemplateRecorded: boolean;
}

/** Native tTARI is a Stealth-typed resource the Pool accepts by exact address. */
export const CANONICAL_TARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';

function ammEligible(resource: string, kind: AssetKind): boolean {
  return kind === 'fungible' || resource === CANONICAL_TARI;
}

const P2P_REASON =
  'The SwapOffer escrow settles this pair in the real v0.48 engine (audit_engine_tests/tests/p2p_offer_routes.rs), but the template is not published and this build has no SwapOffer transaction builder yet, so it cannot be signed here.';

export function resolvePairRoutes(pair: PairInput): RouteOption[] {
  const { input, output } = pair;
  const options: RouteOption[] = [];
  if (input.resource === output.resource) return options;

  const bothAmm = ammEligible(input.resource, input.kind) && ammEligible(output.resource, output.kind);
  if (bothAmm) {
    const amount = pair.amountIn !== undefined && /^\d+$/.test(pair.amountIn) && pair.amountIn !== '0' ? pair.amountIn : undefined;
    const ranked = amount === undefined ? undefined : rankRoutes(pair.pools, input.resource, output.resource, amount);
    const direct = ranked?.routes.filter((r) => r.kind === 'DIRECT_AMM') ?? [];
    const multi = ranked?.routes.filter((r) => r.kind === 'MULTI_HOP_AMM') ?? [];
    const noTemplate = 'No Shadow Swap Pool template is recorded for this network generation, so there is no pool to trade against.';
    const tariInput = input.resource === CANONICAL_TARI;
    const caps = tariInput ? ['transactionRequests', 'stealth withdraw for tTARI input (Sapient local accounts: withdrawStealthAndExecute — not yet built)'] : ['transactionRequests'];
    options.push({
      mechanism: 'AMM',
      label: 'AMM',
      availability: !pair.poolTemplateRecorded ? 'BLOCKED' : amount === undefined ? 'NO_LIQUIDITY' : direct.length > 0 ? 'EXECUTABLE' : 'NO_LIQUIDITY',
      ...(!pair.poolTemplateRecorded ? { reason: noTemplate } : amount === undefined ? { reason: 'Enter an amount to quote.' } : direct.length === 0 ? { reason: 'No verified pool holds this exact pair.' } : {}),
      privacy: 'Public: amounts and reserves are revealed at the pool.',
      requiredCapabilities: caps,
      quotes: direct,
    });
    options.push({
      mechanism: 'MULTI_HOP_AMM',
      label: 'Multi-hop AMM',
      availability: !pair.poolTemplateRecorded ? 'BLOCKED' : amount === undefined ? 'NO_LIQUIDITY' : multi.length > 0 ? 'EXECUTABLE' : 'NO_LIQUIDITY',
      ...(!pair.poolTemplateRecorded ? { reason: noTemplate } : amount === undefined ? { reason: 'Enter an amount to quote.' } : multi.length === 0 ? { reason: 'No 2- or 3-hop path through verified pools connects this pair.' } : {}),
      privacy: 'Public: every hop is a public pool. One atomic transaction; the intermediate asset never reaches your account.',
      requiredCapabilities: caps,
      quotes: multi,
    });
  }

  if (input.kind === 'non_fungible' && output.kind !== 'non_fungible') {
    options.push({ mechanism: 'NFT_MARKETPLACE', label: 'NFT marketplace', availability: 'EXECUTABLE', privacy: 'Public listing, offer or collection bid.', requiredCapabilities: ['transactionRequests'] });
  }
  if (input.kind === 'non_fungible' && output.kind === 'non_fungible') {
    options.push({ mechanism: 'NFT_BARTER', label: 'NFT barter (P2P)', availability: 'ENGINE_VERIFIED_NOT_ENABLED', reason: P2P_REASON, privacy: 'Public: both NFTs are visible in escrow.', requiredCapabilities: ['transactionRequests'] });
  }

  // A created-Stealth (anything Stealth-typed except native tTARI) or Confidential side can
  // never enter Pool v2; the P2P escrow is its lane.
  const isPrivate = (side: PairInput['input']) => (side.kind === 'stealth' && side.resource !== CANONICAL_TARI) || side.kind === 'confidential';
  if (isPrivate(input) || isPrivate(output)) {
    const confidential = input.kind === 'confidential' || output.kind === 'confidential';
    options.push({
      mechanism: 'P2P_OFFER',
      label: 'Revealed private-asset trade (P2P)',
      availability: 'ENGINE_VERIFIED_NOT_ENABLED',
      reason: P2P_REASON + (confidential ? ' Only REVEALED confidential balances are covered; blinded commitments need wallet-built ConfidentialWithdrawProofs.' : ''),
      privacy: 'The traded amount is REVEALED: privacy is given up for the portion you trade, and only for it.',
      requiredCapabilities: ['transactionRequests', 'reveal of the offered stealth/confidential amount'],
    });
  }

  if (input.kind === 'unknown' || output.kind === 'unknown') {
    options.push({ mechanism: 'CROSS_LAYER', label: 'Cross-layer (L1 <-> L2)', availability: 'BLOCKED', reason: 'Disabled until proven: the cross-layer coordinator is gated off and no live settlement exists.', privacy: 'n/a', requiredCapabilities: [] });
  }
  return options;
}

/** The single best EXECUTABLE AMM quote across direct and multi-hop, by output. */
export function bestAmmQuote(options: readonly RouteOption[]): RouteQuote | undefined {
  const all = options.filter((o) => o.availability === 'EXECUTABLE').flatMap((o) => o.quotes ?? []);
  return [...all].sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : a.hops.length - b.hops.length))[0];
}
