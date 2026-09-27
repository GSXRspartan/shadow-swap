/**
 * Slippage presentation.
 *
 * The frontend NEVER derives `min_output` itself. It hands the user's basis-point
 * choice to the protocol-client's `validateSlippage` / `deriveMinOutput` and
 * renders exactly what those return, including their refusals.
 */

import { validateSlippage, deriveMinOutput, type SlippagePolicy } from '@tari-ootle/protocol-client';

/**
 * Protocol policy: the client refuses >50% as economically unsafe
 * (`validateSlippage`). The UI mirrors that ceiling and labels the presets so a
 * user cannot pick something the resolver will refuse.
 */
export const PROTOCOL_MAX_SLIPPAGE_BPS = 5_000;

export interface SlippagePreset {
  bps: string;
  label: string;
}

export const SLIPPAGE_PRESETS: readonly SlippagePreset[] = [
  { bps: '10', label: '0.1%' },
  { bps: '50', label: '0.5%' },
  { bps: '100', label: '1.0%' },
];

/** Conservative default. Not a protocol constant; a presentation default only. */
export const DEFAULT_SLIPPAGE_BPS = '50';

export interface SlippageValidation {
  ok: boolean;
  bps: string;
  /** Presentational percentage, e.g. "0.50%". */
  percentDisplay: string;
  reason?: string;
}

export function percentLabel(bps: string): string {
  const asBig = /^\d+$/.test(bps) ? BigInt(bps) : 0n;
  const whole = asBig / 100n;
  const frac = ((asBig % 100n).toString().padStart(2, '0')).replace(/0$/, '');
  return `${whole}.${frac}%`;
}

export function validateSlippageInput(input: string): SlippageValidation {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, bps: trimmed, percentDisplay: UNAVAILABLE_PERCENT, reason: 'Slippage must be a whole number of basis points.' };
  }
  try {
    // Delegates the safety ceiling to the protocol-client.
    const bps = validateSlippage({ slippageBps: trimmed });
    return { ok: true, bps: bps.toString(), percentDisplay: percentLabel(bps.toString()) };
  } catch (error) {
    return { ok: false, bps: trimmed, percentDisplay: UNAVAILABLE_PERCENT, reason: (error as Error).message };
  }
}

const UNAVAILABLE_PERCENT = '—';

export interface MinOutputPresentation {
  ok: boolean;
  quotedOutput?: string;
  minOutput?: string;
  reason?: string;
}

/**
 * Render the protocol's min_output for a quote. Any refusal (for example a
 * tolerance that would floor min_output to zero) is surfaced verbatim — the UI
 * never works around it.
 */
export function presentMinOutput(quotedOutput: string | undefined, policy: SlippagePolicy): MinOutputPresentation {
  if (quotedOutput === undefined || quotedOutput === '') {
    return { ok: false, reason: 'No quote is available yet.' };
  }
  try {
    return { ok: true, quotedOutput, minOutput: deriveMinOutput(quotedOutput, policy) };
  } catch (error) {
    return { ok: false, quotedOutput, reason: (error as Error).message };
  }
}
