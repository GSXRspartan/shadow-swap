/**
 * Wallet capability presentation.
 *
 * Capability-driven behaviour only: no wallet brand appears in trading logic,
 * and the browser's known L1 SHA-atomic-swap gap is reported from the
 * protocol-client's own constant rather than from hand-written copy.
 */

import { BROWSER_MINOTARI_PROVIDER, BROWSER_PROVIDER_BLOCKER, requiredCapabilitiesFor, NO_WALLET_LEG_CAPABILITIES, type WalletLegCapabilities } from '@tari-ootle/protocol-client/crosschain';
import type { SwapDirectionKind } from '@tari-ootle/protocol-client/crosschain';

export type { WalletLegCapabilities, SwapDirectionKind };

export const CAPABILITY_LABELS: Record<keyof WalletLegCapabilities, string> = {
  l1Balance: 'L1 balance',
  l1NormalSend: 'L1 normal send',
  l1ShaInit: 'L1 SHA atomic swap (init)',
  l1ShaInspect: 'L1 SHA atomic swap (inspect)',
  l1ShaClaim: 'L1 SHA atomic swap (claim)',
  l1ShaRefund: 'L1 SHA atomic swap (refund)',
  l2HtlcFund: 'L2 HTLC (fund)',
  l2HtlcClaim: 'L2 HTLC (claim)',
  l2HtlcRefund: 'L2 HTLC (refund)',
};

export interface LegCapabilityReport {
  leg: 'L1' | 'L2';
  direction: SwapDirectionKind;
  required: Array<keyof WalletLegCapabilities>;
  missing: Array<keyof WalletLegCapabilities>;
  satisfied: boolean;
}

export function reportLeg(
  direction: SwapDirectionKind,
  leg: 'L1' | 'L2',
  capabilities: WalletLegCapabilities | undefined,
): LegCapabilityReport {
  const required = requiredCapabilitiesFor(direction)[leg.toLowerCase() as 'l1' | 'l2'];
  const caps = capabilities ?? NO_WALLET_LEG_CAPABILITIES;
  const missing = required.filter((key) => caps[key] !== true);
  return { leg, direction, required, missing, satisfied: missing.length === 0 };
}

export interface AtomicSwapAvailability {
  /** Whether the browser can execute the atomic XTM↔TARI route at all. */
  available: boolean;
  /** The upstream blocker, quoted verbatim from the protocol-client. */
  reason: string;
  /** Structured disabled state for the swap control. */
  headline: string;
  /** What the user must do, if anything. */
  remedy: string;
  l1: LegCapabilityReport;
  l2: LegCapabilityReport;
}

/**
 * FAST_XTM_TARI availability.
 *
 * `BROWSER_MINOTARI_PROVIDER` is pinned to `'BLOCKED_EXTERNAL'` by the
 * protocol-client because no browser-safe Minotari provider exposes the traced
 * L1 SHA atomic-swap primitives. Normal tXTM balance/send may still be shown
 * when the provider advertises it, but the atomic route must be disabled with an
 * honest reason. There is deliberately NO fallback to walletd for normal users.
 */
export function atomicSwapAvailability(
  direction: SwapDirectionKind,
  capabilities: WalletLegCapabilities | undefined,
): AtomicSwapAvailability {
  const l1 = reportLeg(direction, 'L1', capabilities);
  const l2 = reportLeg(direction, 'L2', capabilities);
  const browserBlocked = BROWSER_MINOTARI_PROVIDER === 'BLOCKED_EXTERNAL';
  const missing = [...l1.missing, ...l2.missing];
  const available = !browserBlocked && l1.satisfied && l2.satisfied;

  if (available) {
    return {
      available: true,
      reason: 'Both legs advertise the capabilities this route requires.',
      headline: 'Atomic XTM swap ready',
      remedy: 'The route can be quoted and executed.',
      l1,
      l2,
    };
  }

  if (browserBlocked) {
    return {
      available: false,
      reason: BROWSER_PROVIDER_BLOCKER,
      headline: 'Wallet upgrade required for atomic XTM swaps',
      remedy:
        'Browser Minotari SHA atomic swaps are upstream-blocked. Normal tXTM balance and send may still be available. This build does not fall back to a local wallet service for you.',
      l1,
      l2,
    };
  }

  return {
    available: false,
    reason: `Missing required capability: ${missing.map((key) => CAPABILITY_LABELS[key]).join(', ')}.`,
    headline: 'Wallet does not support this route',
    remedy: 'The connected provider did not advertise every capability the route requires, so it is refused before any funding.',
    l1,
    l2,
  };
}

export interface CapabilityRow {
  key: keyof WalletLegCapabilities;
  label: string;
  leg: 'L1' | 'L2';
  available: boolean;
  requiredFor: SwapDirectionKind[];
}

const L1_KEYS: Array<keyof WalletLegCapabilities> = ['l1Balance', 'l1NormalSend', 'l1ShaInit', 'l1ShaInspect', 'l1ShaClaim', 'l1ShaRefund'];
const L2_KEYS: Array<keyof WalletLegCapabilities> = ['l2HtlcFund', 'l2HtlcClaim', 'l2HtlcRefund'];

export function capabilityRows(capabilities: WalletLegCapabilities | undefined): CapabilityRow[] {
  const caps = capabilities ?? NO_WALLET_LEG_CAPABILITIES;
  const rows: CapabilityRow[] = [];
  for (const key of L1_KEYS) {
    rows.push({
      key,
      label: CAPABILITY_LABELS[key],
      leg: 'L1',
      available: caps[key] === true,
      requiredFor: (['XTM_TO_TARI', 'TARI_TO_XTM'] as SwapDirectionKind[]).filter((d) => requiredCapabilitiesFor(d).l1.includes(key)),
    });
  }
  for (const key of L2_KEYS) {
    rows.push({
      key,
      label: CAPABILITY_LABELS[key],
      leg: 'L2',
      available: caps[key] === true,
      requiredFor: (['XTM_TO_TARI', 'TARI_TO_XTM'] as SwapDirectionKind[]).filter((d) => requiredCapabilitiesFor(d).l2.includes(key)),
    });
  }
  return rows;
}

