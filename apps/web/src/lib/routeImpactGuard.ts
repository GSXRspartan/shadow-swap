/**
 * EXECUTION ROUTE-IMPACT GUARD.
 *
 * The AMM quote's `totalCostBps` is what the user ACTUALLY pays beyond the pool's
 * mid price: trading fees compounded with real constant-product price impact. On
 * a thin pool a large input is not an error — but by default it must be an
 * EXPLICIT decision, because the cost shows up as fewer received tokens, and
 *"the transaction still succeeded" has fooled many a user.
 *
 * Tiers:
 *   <= WARN_BPS      → allowed; the row is merely toned as a warning.
 *   <= BLOCK_BPS     → allowed; strong warning text is mandatory.
 *   >  BLOCK_BPS     → refused by default. The only way past it is an explicit,
 *                      deliberate override (checkbox), which is what makes the
 *                      decision the user's own rather than the UI's.
 */

export const IMPACT_WARN_BPS = 2_000n;
export const IMPACT_BLOCK_BPS = 5_000n;

export interface RouteImpactGuardInput {
  readonly totalCostBps?: string;
  readonly overrideConfirmed: boolean;
}

export interface RouteImpactVerdict {
  readonly kind: 'OK' | 'WARN' | 'BLOCK';
  /** Whether the UI may submit as-is. */
  readonly allowed: boolean;
  readonly title?: string;
  readonly detail?: string;
}

export function routeImpactGuard(input: RouteImpactGuardInput): RouteImpactVerdict {
  const { totalCostBps = '0', overrideConfirmed } = input;
  if (!/^\d+$/.test(totalCostBps)) {
    return { kind: 'OK', allowed: true };
  }
  const bps = BigInt(totalCostBps);
  if (bps <= IMPACT_WARN_BPS) return { kind: 'OK', allowed: true };
  if (bps <= IMPACT_BLOCK_BPS) {
    return {
      kind: 'WARN',
      allowed: true,
      title: 'High price impact',
      detail: `This route costs ${(Number(bps) / 100).toFixed(2)}% above the pool's mid price — mostly price impact on a small pool, not fees. Review the amount received before approving.`,
    };
  }
  if (overrideConfirmed) {
    return {
      kind: 'BLOCK',
      allowed: true,
      title: 'Extreme price impact — overridden',
      detail: `You chose to proceed even though this route costs ${(Number(bps) / 100).toFixed(2)}% above the pool's mid price. This is an explicit override of the execution guard.`,
    };
  }
  return {
    kind: 'BLOCK',
    allowed: false,
    title: 'Blocked: excessive price impact',
    detail: `This route costs ${(Number(bps) / 100).toFixed(2)}% above the pool's mid price, so it is refused by default. If this is intentional — for example a deliberate probe of a disposable testnet pool — tick the override below.`,
  };
}
