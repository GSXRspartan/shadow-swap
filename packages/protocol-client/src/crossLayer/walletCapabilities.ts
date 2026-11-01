/**
 * Which wallet can sign which leg of a cross-layer exchange.
 *
 * This is the finding from `docs/CROSS_LAYER_WALLET_CAPABILITY_MATRIX.md` in executable form, so
 * it cannot drift from the code that depends on it. Every entry below was read from source at a
 * pinned revision, and the test suite asserts the conclusions rather than restating them.
 *
 * THE POINT. A cross-layer trade needs FOUR signatures across two chains (fund and claim or
 * refund on each leg), and no single wallet can produce all four today. A UI that offers a trade
 * it cannot finish would strand a user mid-settlement with an irreversible funded leg — so
 * `planSigners` refuses a route unless every operation it will need has a signer, and names the
 * first one that does not.
 *
 * WHAT WAS SURPRISING, AND IS THEREFORE PINNED HERE. Tari Universe reaches BOTH layers from a web
 * page (its Tapplet signer exposes L1 and L2), but its only sends are plain payments:
 * `sendOneSided` cannot carry a custom TariScript, and `sendOotleStealth` goes to an ADDRESS
 * rather than calling a template method. So the richer application has the NARROWER surface for
 * this purpose, and Sapient — an L2-only provider — is the one that can drive the L2 HTLC leg.
 */

import { DIRECTIONS, type SwapDirection } from './atomicSwap.js';

/** A signing surface a user might have available. */
export type WalletKind = 'LOCAL_WALLETD_GRPC' | 'SAPIENT' | 'UNIVERSE_TAPPLET';

/** The operations a cross-layer exchange needs, per leg. */
export type CrossLayerOperation =
  | 'L1_FUND_HTLC'
  | 'L1_CLAIM_HTLC'
  | 'L1_REFUND_HTLC'
  | 'L2_FUND_HTLC'
  | 'L2_CLAIM_HTLC'
  | 'L2_REFUND_HTLC'
  | 'L1_READ'
  | 'L2_READ';

export interface WalletSurface {
  readonly kind: WalletKind;
  readonly label: string;
  /** The revision the capability set was read from, so a stale entry is visible. */
  readonly readFrom: string;
  readonly can: readonly CrossLayerOperation[];
  /** Why the operations it cannot do are missing. Shown verbatim to a user or a reviewer. */
  readonly limits: readonly string[];
  /** True when the surface runs outside the browser and needs a local endpoint. */
  readonly requiresLocalEndpoint: boolean;
}

export const WALLET_SURFACES: Readonly<Record<WalletKind, WalletSurface>> = {
  /**
   * The user's own console wallet or walletd over gRPC. The ONLY surface that builds the L1 HTLC
   * script at all, via `SendShaAtomicSwapTransaction` / `ClaimShaAtomicSwapTransaction` /
   * `ClaimHtlcRefundTransaction`.
   */
  LOCAL_WALLETD_GRPC: {
    kind: 'LOCAL_WALLETD_GRPC',
    label: 'Your own Minotari wallet (local gRPC)',
    readFrom: 'tari-project/tari 6.3.0-pre.2, 3994846',
    can: ['L1_FUND_HTLC', 'L1_CLAIM_HTLC', 'L1_REFUND_HTLC', 'L1_READ'],
    limits: [
      'Not reachable from a web page: it needs a wallet running on your own machine with gRPC enabled.',
      'Cannot choose the HTLC hash or timeout — the wallet generates the preimage itself and fixes the refund height at tip + 720 blocks.',
      'HTLC funding is refused on Ledger wallets (claiming and refunding still work).',
      'Has no Ootle L2 surface.',
    ],
    requiresLocalEndpoint: true,
  },
  /**
   * The browser L2 provider Shadow Swap already uses. Its transaction requests can call a
   * template method, which is what makes it the only browser surface able to drive the L2 HTLC.
   */
  SAPIENT: {
    kind: 'SAPIENT',
    label: 'Sapient (browser, Ootle L2)',
    readFrom: 'Sapient v0.6.17 documented provider surface',
    can: ['L2_FUND_HTLC', 'L2_CLAIM_HTLC', 'L2_REFUND_HTLC', 'L2_READ'],
    limits: [
      'Has no Minotari L1 surface at all, so it cannot fund, claim or refund the L1 leg.',
      'Advertises no burn or claim capability (its WalletCapabilities has no such field).',
    ],
    requiresLocalEndpoint: false,
  },
  /**
   * Tari Universe, through a Tapplet. Reaches BOTH layers — and that correction matters — but
   * every send it exposes is a plain payment.
   */
  UNIVERSE_TAPPLET: {
    kind: 'UNIVERSE_TAPPLET',
    label: 'Tari Universe (Tapplet, both layers)',
    readFrom: 'tari-project/universe 22366ad',
    can: ['L1_READ', 'L2_READ'],
    limits: [
      'Reaches both layers, but its only L1 send is `sendOneSided`, a plain one-sided payment that cannot carry a custom TariScript — and an L1 HTLC output IS a custom script.',
      'Its only L2 send is `sendOotleStealth`, a transfer to an address rather than a template method call, so it cannot call the cross-layer escrow at all.',
      'No atomic-swap or HTLC code exists anywhere in the Universe repository.',
      'ONE generic L2 transaction-request method in its Tapplet allowlist would make the whole L2 leg signable here; that is the single upstream change this route is waiting on.',
    ],
    requiresLocalEndpoint: false,
  },
};

/** Every operation a direction needs, in the order the protocol performs them. */
export function requiredOperations(direction: SwapDirection): readonly CrossLayerOperation[] {
  const shape = DIRECTIONS[direction];
  if (shape === undefined) throw new Error(`unknown direction ${direction}`);
  // Both legs must be fundable, both claimable, and both refundable — a route whose refund
  // cannot be signed is a route that can strand funds, so refunds are required, not optional.
  return [
    'L1_READ',
    'L2_READ',
    'L1_FUND_HTLC',
    'L2_FUND_HTLC',
    'L2_CLAIM_HTLC',
    'L1_CLAIM_HTLC',
    'L1_REFUND_HTLC',
    'L2_REFUND_HTLC',
  ];
}

export type SignerPlan =
  | {
      readonly ok: true;
      /** Which wallet performs each operation. */
      readonly assignment: Readonly<Record<CrossLayerOperation, WalletKind>>;
      /** True when any assigned wallet needs a local endpoint, so the UI can say so up front. */
      readonly needsLocalWallet: boolean;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      /** The operations nothing available can sign. */
      readonly missing: readonly CrossLayerOperation[];
      readonly reason: string;
    };

/**
 * Assigns a signer to every operation a direction needs, or refuses with the exact gap.
 *
 * Refusing is the whole value: a partial plan would let a UI offer a trade that cannot be
 * finished, and the first leg of a cross-layer trade is irreversible once the counterparty
 * claims it.
 */
export function planSigners(
  direction: SwapDirection,
  available: readonly WalletKind[],
): SignerPlan {
  const surfaces = available.map((kind) => {
    const surface = WALLET_SURFACES[kind];
    if (surface === undefined) throw new Error(`unknown wallet kind ${kind}`);
    return surface;
  });
  const needed = requiredOperations(direction);
  const assignment: Partial<Record<CrossLayerOperation, WalletKind>> = {};
  const missing: CrossLayerOperation[] = [];

  for (const operation of needed) {
    // Prefer a surface that needs no local endpoint, so a browser-only plan is chosen when one
    // exists; otherwise fall back to the local wallet.
    const candidates = surfaces.filter((s) => s.can.includes(operation));
    const chosen =
      candidates.find((s) => !s.requiresLocalEndpoint) ?? candidates[0];
    if (chosen === undefined) missing.push(operation);
    else assignment[operation] = chosen.kind;
  }

  if (missing.length > 0) {
    const explanations = surfaces
      .flatMap((s) => s.limits.map((limit) => `${s.label}: ${limit}`))
      .join(' ');
    return {
      ok: false,
      missing,
      reason:
        `This route cannot be completed with the wallets available (${available.join(', ') || 'none'}): nothing can sign ${missing.join(', ')}. ` +
        `A cross-layer trade needs every one of these, including the refunds — a route whose refund cannot be signed is one that can strand funds. ${explanations}`,
    };
  }

  const used = [...new Set(Object.values(assignment))] as WalletKind[];
  const needsLocalWallet = used.some((kind) => WALLET_SURFACES[kind].requiresLocalEndpoint);
  return {
    ok: true,
    assignment: assignment as Record<CrossLayerOperation, WalletKind>,
    needsLocalWallet,
    summary:
      `${direction}: L1 legs signed by ${WALLET_SURFACES[assignment.L1_FUND_HTLC!].label}, ` +
      `L2 legs by ${WALLET_SURFACES[assignment.L2_FUND_HTLC!].label}.` +
      (needsLocalWallet
        ? ' This requires a Minotari wallet running on your own machine with gRPC enabled; a browser alone cannot complete it.'
        : ''),
  };
}

/** Everything a given set of wallets still cannot do, for an honest capability screen. */
export function capabilityGaps(available: readonly WalletKind[]): readonly string[] {
  const surfaces = available.map((k) => WALLET_SURFACES[k]).filter((s) => s !== undefined);
  const covered = new Set(surfaces.flatMap((s) => s.can));
  const all: CrossLayerOperation[] = [
    'L1_FUND_HTLC',
    'L1_CLAIM_HTLC',
    'L1_REFUND_HTLC',
    'L2_FUND_HTLC',
    'L2_CLAIM_HTLC',
    'L2_REFUND_HTLC',
    'L1_READ',
    'L2_READ',
  ];
  return all.filter((op) => !covered.has(op));
}
