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
  | 'REVEALED_POOL'
  | 'MIXED_MULTI_HOP'
  | 'NFT_MARKETPLACE'
  | 'P2P_OFFER'
  | 'NFT_BARTER'
  | 'CROSS_LAYER';

export type Availability = 'EXECUTABLE' | 'NO_LIQUIDITY' | 'ENGINE_VERIFIED_NOT_ENABLED' | 'BLOCKED' | 'NOT_APPLICABLE';

/**
 * The mechanisms the Swap page builds, reviews and submits itself.
 *
 * All four are AMM-shaped: both pool templates expose the same
 * `swap(Bucket, ResourceAddress, Amount)`, so one hop or several, in one venue or across
 * both, is one atomic transaction of the same shape (engine: `revealed_asset_pool` r11).
 * Each hop's venue is re-derived from the pool component's own template address at submit
 * time, which decides the builder and the disclosure.
 *
 * The others are reachable but not from this page's quote list: `NFT_MARKETPLACE` has its own
 * page, `P2P_OFFER`/`NFT_BARTER` are escrow flows driven by the offer panel below the quotes,
 * and `CROSS_LAYER` is a conversion rather than a trade. Keeping the set explicit is what
 * stops a button appearing for a route that cannot build its transaction.
 */
export const SIGNABLE_MECHANISMS: readonly Mechanism[] = ['AMM', 'MULTI_HOP_AMM', 'REVEALED_POOL', 'MIXED_MULTI_HOP'];

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
  /** Whether the verified network generation records a SwapOffer template (P2P offers). */
  readonly offerTemplateRecorded?: boolean;
  /**
   * Verified REVEALED-VALUE pools with authoritative reserves. A separate graph from `pools`:
   * these hold the privacy-typed assets Pool v2 refuses, and their reserves are public.
   */
  readonly revealedPools?: readonly PoolEdge[];
  /** Whether the verified generation records a RevealedAssetPool template. */
  readonly revealedPoolTemplateRecorded?: boolean;
}

/**
 * Resources a revealed-value pool may hold: anything whose value is an exact revealed
 * integer. NFTs are excluded (no divisible amount to price).
 */
function revealedEligible(kind: AssetKind): boolean {
  return kind === 'fungible' || kind === 'stealth' || kind === 'confidential';
}

/** Native tTARI is a Stealth-typed resource the Pool accepts by exact address. */
export const CANONICAL_TARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';

function ammEligible(resource: string, kind: AssetKind): boolean {
  return kind === 'fungible' || resource === CANONICAL_TARI;
}

const P2P_UNPUBLISHED =
  'The SwapOffer escrow settles this pair in the real v0.48 engine (audit_engine_tests/tests/p2p_offer_routes.rs) and this app builds, reviews and verifies the whole maker/taker flow, but no SwapOffer template is published and recorded for this network generation, so no offer can be created or filled here.';

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
    const caps = tariInput ? ['transactionRequests', 'tTARI input: Sapient seed accounts use withdrawStealthAndExecute (capabilities.stealthWithdraw); walletd-relayed accounts use a plain withdraw'] : ['transactionRequests'];
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
  // --- Revealed-value pools (templates/revealed_asset_pool) ----------------------------
  //
  // A SEPARATE graph from the public AMM. It admits exactly the assets Pool v2 refuses
  // (created-Stealth, Confidential) alongside public fungibles, and its reserves are public
  // integers, so every option here carries the transparency disclosure.
  const bothRevealed = revealedEligible(input.kind) && revealedEligible(output.kind);
  if (bothRevealed) {
    const amount = pair.amountIn !== undefined && /^\d+$/.test(pair.amountIn) && pair.amountIn !== '0' ? pair.amountIn : undefined;
    const revealed = pair.revealedPools ?? [];
    const recorded = pair.revealedPoolTemplateRecorded === true;
    const ranked = amount === undefined ? undefined : rankRoutes(revealed, input.resource, output.resource, amount);
    const direct = ranked?.routes.filter((r) => r.kind === 'DIRECT_AMM') ?? [];
    const noTemplate = 'No Shadow Swap RevealedAssetPool template is recorded for this network generation, so there is no revealed-value pool to trade against.';
    const privateSide = input.kind === 'stealth' || input.kind === 'confidential' || output.kind === 'stealth' || output.kind === 'confidential';
    const caps = input.kind === 'stealth' || input.kind === 'confidential'
      ? ['transactionRequests', 'Stealth-typed input: Sapient seed accounts use withdrawStealthAndExecute; walletd-relayed accounts use a plain withdraw']
      : ['transactionRequests'];
    options.push({
      mechanism: 'REVEALED_POOL',
      label: privateSide ? 'Transparent pool (revealed-value)' : 'Transparent pool',
      availability: !recorded ? 'BLOCKED' : amount === undefined ? 'NO_LIQUIDITY' : direct.length > 0 ? 'EXECUTABLE' : 'NO_LIQUIDITY',
      ...(!recorded ? { reason: noTemplate } : amount === undefined ? { reason: 'Enter an amount to quote.' } : direct.length === 0 ? { reason: 'No verified revealed-value pool holds this exact pair.' } : {}),
      privacy: privateSide
        ? 'The traded amount is REVEALED: this pool holds public reserves, so the amount, its timing and your account are visible for this trade. The asset keeps its type; nothing is converted.'
        : 'Public: amounts and reserves are revealed at the pool.',
      requiredCapabilities: caps,
      quotes: direct,
    });

    // A route may cross BOTH pool kinds in one transaction: both templates expose the same
    // `swap(Bucket, ResourceAddress, Amount)` signature, so the instruction shape is
    // identical and every intermediate stays on the workspace (engine: revealed_asset_pool
    // r11). That is what lets a privacy-typed asset reach a purely public one atomically, and
    // only the transaction's INPUT needs a Stealth-capable withdrawal.
    if (amount !== undefined && recorded && pair.poolTemplateRecorded) {
      const merged = [...pair.pools, ...revealed];
      const mixedRanked = rankRoutes(merged, input.resource, output.resource, amount);
      const mixed = mixedRanked.routes.filter((r) => {
        if (r.hops.length < 2) return false;
        const kinds = new Set(r.hops.map((h) => (revealed.some((p) => p.poolComponent === h.poolComponent) ? 'REVEALED' : 'PUBLIC')));
        return kinds.size > 1;
      });
      if (mixed.length > 0) {
        options.push({
          mechanism: 'MIXED_MULTI_HOP',
          label: 'Multi-hop across a transparent and a public pool',
          availability: 'EXECUTABLE',
          privacy:
            'The traded amount is REVEALED at every hop, including the transparent pool. One atomic transaction; the intermediate asset never reaches your account.',
          requiredCapabilities: caps,
          quotes: mixed,
        });
      }
    }
  }

  const p2p = (mechanism: 'P2P_OFFER' | 'NFT_BARTER', label: string, privacy: string, extraReason = '', caps: readonly string[] = ['transactionRequests']): RouteOption => ({
    mechanism,
    label,
    availability: pair.offerTemplateRecorded === true ? 'EXECUTABLE' : 'BLOCKED',
    ...(pair.offerTemplateRecorded === true ? (extraReason === '' ? {} : { reason: extraReason.trim() }) : { reason: P2P_UNPUBLISHED + extraReason }),
    privacy,
    requiredCapabilities: caps,
  });

  if (input.kind === 'non_fungible' && output.kind === 'non_fungible') {
    options.push(p2p('NFT_BARTER', 'NFT barter (P2P offer)', 'Public: both NFTs and their ids are visible in escrow.'));
  }

  // A created-Stealth (anything Stealth-typed except native tTARI) or Confidential side can
  // never enter Pool v2; the P2P escrow is its lane. Public pairs get it too: it is how a
  // pair with no AMM liquidity trades at an agreed price.
  const isPrivate = (side: PairInput['input']) => (side.kind === 'stealth' && side.resource !== CANONICAL_TARI) || side.kind === 'confidential';
  const nftOnly = input.kind === 'non_fungible' && output.kind === 'non_fungible';
  if (!nftOnly && input.kind !== 'unknown' && output.kind !== 'unknown') {
    const priv = isPrivate(input) || isPrivate(output);
    const confidential = input.kind === 'confidential' || output.kind === 'confidential';
    const stealthIn = input.kind === 'stealth';
    options.push(
      p2p(
        'P2P_OFFER',
        priv ? 'Revealed private-asset offer (P2P)' : 'P2P offer at your price',
        priv
          ? 'The traded amount is REVEALED: privacy is given up for the portion you trade, and only for it. The asset keeps its type; nothing is converted.'
          : 'Public: the offer, both assets and their amounts are visible on-chain. No pool, no price impact; someone must accept your terms.',
        confidential ? ' Only REVEALED confidential balances are covered; blinded commitments need wallet-built ConfidentialWithdrawProofs, which no browser wallet exposes.' : '',
        stealthIn ? ['transactionRequests', 'Stealth-typed input: Sapient seed accounts (withdrawStealthAndExecute)'] : ['transactionRequests'],
      ),
    );
  }

  if (input.kind === 'unknown' || output.kind === 'unknown') {
    // Burn-and-claim (L1 -> L2) is a real upstream protocol and has its own page, but it is a
    // one-way CONVERSION whose first step is irreversible, so it is never offered here beside
    // trades that settle or do not. The reverse direction does not exist at all: v0.48's
    // instruction set has a one-way `ClaimBurn` and nothing that burns or exits on L2.
    options.push({
      mechanism: 'CROSS_LAYER',
      label: 'Cross-layer (L1 → L2 conversion)',
      availability: 'BLOCKED',
      reason:
        'Not a trade: converting Minotari (L1) into Ootle (L2) is a one-way burn-and-claim whose first step is irreversible, and the claim is signed by your own wallet. It has its own page. There is no L2 → L1 route in this protocol.',
      privacy: 'The L1 burn and the L2 claim are both public.',
      requiredCapabilities: ['a base-layer wallet for the burn', 'your own wallet for the claim (no browser wallet exposes one)'],
    });
  }
  return options;
}

/** The single best EXECUTABLE AMM quote across direct and multi-hop, by output. */
export function bestAmmQuote(options: readonly RouteOption[]): RouteQuote | undefined {
  const all = options.filter((o) => o.availability === 'EXECUTABLE').flatMap((o) => o.quotes ?? []);
  return [...all].sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : a.hops.length - b.hops.length))[0];
}
