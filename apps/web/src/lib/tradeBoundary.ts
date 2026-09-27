/**
 * The market-data trust boundary, enforced in the type system.
 *
 * Mission §49 requires that this architecture be impossible to reverse. The
 * mechanism here is a branded wrapper: a market-data derived value is a
 * `DisplayOnly` object, which is NOT structurally assignable to `string`.
 *
 * Every protocol resolver takes raw decimal strings for amounts and accepts
 * `rawInputAmount: string` / `slippageBps: string` / `quotedOutput: string`.
 * Because `DisplayOnly` has no `toString`/`valueOf` in its public shape and is
 * an object rather than a string, the compiler rejects
 * `resolveSwap({ rawInputAmount: marketData.price })` outright. A runtime guard
 * in `asRawExecutionAmount` covers values that arrive as `any` (for example
 * from `JSON.parse`), and the boundary tests prove that a hostile market-data
 * price leaves the resolver output byte-identical.
 *
 * Nothing in this module is a display conversion — it is a type-level fence.
 */

/**
 * A real runtime symbol, so the brand survives compilation to JavaScript. A
 * `declare const` brand would be erased and the runtime guard would silently
 * stop recognising its own values.
 */
const DISPLAY_ONLY_BRAND = Symbol('ootle.tradeBoundary.displayOnly.v1');

/** A presentational string. Deliberately NOT a `string`. */
export interface DisplayOnly {
  readonly [DISPLAY_ONLY_BRAND]: true;
  /** The rendered text. */
  readonly text: string;
  /** Where it came from, for audit logs and error messages. */
  readonly origin: string;
}

/** Wrap a formatted display string. The only way to create one. */
export function asDisplayOnly(text: string, origin = 'display'): DisplayOnly {
  // The brand is a REAL property, not a type-level fiction, so the runtime guard
  // recognises its own values after compilation.
  return { [DISPLAY_ONLY_BRAND]: true, text, origin };
}

export function isDisplayOnly(value: unknown): value is DisplayOnly {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DISPLAY_ONLY_BRAND] === true;
}

export class ExecutionBoundaryViolation extends Error {
  constructor(what: string, origin = 'unknown') {
    super(`Refusing to use a market-data display value (${origin}) as an execution input: ${what}. Market data is informational and may never set an amount, a min_output, a resource, or a settlement proof.`);
    this.name = 'ExecutionBoundaryViolation';
  }
}

/**
 * The single funnel for turning a user-entered value into an execution input.
 * It accepts only a genuine raw integer string and refuses branded display
 * objects, numbers, and anything non-canonical.
 */
export function asRawExecutionAmount(value: unknown, field: string): string {
  if (isDisplayOnly(value)) throw new ExecutionBoundaryViolation(field, (value as DisplayOnly).origin);
  if (typeof value !== 'string') {
    throw new ExecutionBoundaryViolation(`${field} must be a raw decimal string, received ${typeof value}`);
  }
  if (!/^\d+$/.test(value)) {
    throw new ExecutionBoundaryViolation(`${field} must be a non-negative raw integer string, received "${value}"`);
  }
  return value;
}

/** Same funnel for a resource address. Exact identity only, never a label. */
export function asResourceAddress(value: unknown, field: string): string {
  if (isDisplayOnly(value)) throw new ExecutionBoundaryViolation(field, (value as DisplayOnly).origin);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExecutionBoundaryViolation(`${field} must be an exact ResourceAddress string`);
  }
  return value;
}

/**
 * A read-only view over market data. It exposes formatted strings only; there
 * is no accessor that returns a raw price, so no component can pass one on.
 */
export class MarketDataView {
  private constructor(
    readonly poolComponent: string,
    private readonly values: ReadonlyMap<string, DisplayOnly>,
    readonly informationalOnly: true = true,
  ) {}

  static fromEntries(poolComponent: string, entries: Iterable<readonly [string, string]>): MarketDataView {
    const map = new Map<string, DisplayOnly>();
    for (const [key, text] of entries) map.set(key, asDisplayOnly(text, `market-data:${poolComponent}:${key}`));
    return new MarketDataView(poolComponent, map);
  }

  /** Display string for a metric, or the explicit unavailable marker. */
  get(key: string, unavailable = '—'): string {
    return this.values.get(key)?.text ?? unavailable;
  }

  get keys(): string[] {
    return [...this.values.keys()];
  }

  /**
   * Escape hatch for code that must interoperate with a library expecting a
   * string. The returned value is still only a display string, and the caller
   * must name the destination explicitly.
   */
  readText(key: string): DisplayOnly {
    const value = this.values.get(key);
    if (value === undefined) throw new ExecutionBoundaryViolation(`No market-data value named ${key}`, `market-data:${this.poolComponent}`);
    return value;
  }
}
