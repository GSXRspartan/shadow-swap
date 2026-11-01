/**
 * Public-AMM route finding and multi-hop resolution.
 *
 * Pools form a graph whose nodes are resources and whose edges are pools. A route is a
 * simple path (no pool and no resource visited twice) of 1..MAX_HOPS edges. Every number
 * here is an exact integer (bigint, carried as decimal strings); there is no floating point
 * anywhere in a quote. Each hop uses `quoteSwapOutput`, the same formula the Pool template
 * executes, and audit_engine_tests/tests/multihop_routes.rs (m07) proves the composed
 * quote equals the engine payout hop by hop.
 *
 * Settlement is ATOMIC: a multi-hop route is ONE transaction (m01/m02), and a failure in
 * any hop reverts every hop (m03/m04). This module never splits a route into sequential
 * submissions.
 *
 * Discovery data is never trusted for execution. `resolveMultiHopSwap` re-reads EVERY hop's
 * pool through the authoritative readback (pinned to recorded templates by the web app),
 * re-derives the route quote from those reads, and refuses a route whose fresh output has
 * fallen below the caller's expectation.
 */

import { deriveMinOutput, quoteSwapOutput, type SlippagePolicy } from './amm.js';
import type { Freshness } from './execution.js';
import type { PoolReadbackProvider } from './ootle.js';

export const MAX_HOPS = 3;

export interface PoolEdge {
  readonly poolComponent: string;
  readonly resourceA: string;
  readonly resourceB: string;
  readonly reserveA: string;
  readonly reserveB: string;
  readonly feeBps: string;
}

export interface HopQuote {
  readonly poolComponent: string;
  readonly inputResource: string;
  readonly outputResource: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly reserveIn: string;
  readonly reserveOut: string;
  readonly feeBps: string;
}

export interface RouteQuote {
  readonly kind: 'DIRECT_AMM' | 'MULTI_HOP_AMM';
  readonly inputResource: string;
  readonly outputResource: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly hops: readonly HopQuote[];
  /**
   * Output at the mid price with NO fee and NO impact: amountIn * Π(reserveOut/reserveIn),
   * floored once at the end. The gap to `amountOut` is the total cost of the route.
   */
  readonly midOutput: string;
  /** (midOutput - amountOut) / midOutput, in bps, rounded UP (never understated). Fees included. */
  readonly totalCostBps: string;
  /** Sum of the hops' fee tiers in bps (the fee part of `totalCostBps`, approximately compounded). */
  readonly feeBpsTotal: string;
}

function edgeSides(edge: PoolEdge, input: string): { reserveIn: string; reserveOut: string; output: string } | undefined {
  if (edge.resourceA === input) return { reserveIn: edge.reserveA, reserveOut: edge.reserveB, output: edge.resourceB };
  if (edge.resourceB === input) return { reserveIn: edge.reserveB, reserveOut: edge.reserveA, output: edge.resourceA };
  return undefined;
}

function wellFormed(edge: PoolEdge): boolean {
  return (
    /^component_[0-9a-f]{64}$|^component_[\w-]+$/.test(edge.poolComponent) &&
    edge.resourceA !== edge.resourceB &&
    /^\d+$/.test(edge.reserveA) &&
    /^\d+$/.test(edge.reserveB) &&
    /^\d+$/.test(edge.feeBps) &&
    BigInt(edge.reserveA) > 0n &&
    BigInt(edge.reserveB) > 0n
  );
}

/** Every simple path from `from` to `to` of at most `maxHops` pools. Deterministic order. */
export function enumerateRoutes(pools: readonly PoolEdge[], from: string, to: string, maxHops: number = MAX_HOPS): PoolEdge[][] {
  if (from === to) return [];
  const limit = Math.min(Math.max(1, Math.floor(maxHops)), MAX_HOPS);
  const usable = [...pools].filter(wellFormed).sort((x, y) => (x.poolComponent < y.poolComponent ? -1 : x.poolComponent > y.poolComponent ? 1 : 0));
  const routes: PoolEdge[][] = [];
  const walk = (at: string, path: PoolEdge[], seenPools: Set<string>, seenResources: Set<string>) => {
    if (path.length >= limit) return;
    for (const edge of usable) {
      if (seenPools.has(edge.poolComponent)) continue;
      const sides = edgeSides(edge, at);
      if (sides === undefined || seenResources.has(sides.output)) continue;
      const next = [...path, edge];
      if (sides.output === to) {
        routes.push(next);
        continue;
      }
      walk(sides.output, next, new Set([...seenPools, edge.poolComponent]), new Set([...seenResources, sides.output]));
    }
  };
  walk(from, [], new Set(), new Set([from]));
  return routes;
}

/** Compose a route's integer quote. Throws if any hop cannot pay a positive amount. */
export function quoteRoute(path: readonly PoolEdge[], inputResource: string, amountIn: string): RouteQuote {
  if (path.length === 0 || path.length > MAX_HOPS) throw new Error(`a route has 1..${MAX_HOPS} hops`);
  if (!/^\d+$/.test(amountIn) || BigInt(amountIn) === 0n) throw new Error('amountIn must be a positive integer');
  const hops: HopQuote[] = [];
  let resource = inputResource;
  let amount = amountIn;
  let midNum = BigInt(amountIn);
  let midDen = 1n;
  let feeTotal = 0n;
  for (const edge of path) {
    const sides = edgeSides(edge, resource);
    if (sides === undefined) throw new Error(`pool ${edge.poolComponent} does not trade ${resource}`);
    const { output } = quoteSwapOutput(sides.reserveIn, sides.reserveOut, amount, edge.feeBps);
    hops.push({ poolComponent: edge.poolComponent, inputResource: resource, outputResource: sides.output, amountIn: amount, amountOut: output, reserveIn: sides.reserveIn, reserveOut: sides.reserveOut, feeBps: edge.feeBps });
    midNum *= BigInt(sides.reserveOut);
    midDen *= BigInt(sides.reserveIn);
    feeTotal += BigInt(edge.feeBps);
    resource = sides.output;
    amount = output;
  }
  const mid = midNum / midDen;
  const out = BigInt(amount);
  const cost = mid > out && mid > 0n ? ((mid - out) * 10_000n + mid - 1n) / mid : 0n;
  return {
    kind: path.length === 1 ? 'DIRECT_AMM' : 'MULTI_HOP_AMM',
    inputResource,
    outputResource: resource,
    amountIn,
    amountOut: amount,
    hops,
    midOutput: String(mid),
    totalCostBps: String(cost),
    feeBpsTotal: String(feeTotal),
  };
}

export interface RankedRoutes {
  /** Executable quotes, best output first (ties: fewer hops first). */
  readonly routes: readonly RouteQuote[];
  /** Candidate paths that could not be quoted, with the reason. Never silently dropped. */
  readonly rejected: readonly { readonly pools: readonly string[]; readonly reason: string }[];
}

/** Quote every candidate path and rank by EXECUTABLE OUTPUT, not by hop count (m08). */
export function rankRoutes(pools: readonly PoolEdge[], from: string, to: string, amountIn: string, maxHops: number = MAX_HOPS): RankedRoutes {
  const routes: RouteQuote[] = [];
  const rejected: { pools: string[]; reason: string }[] = [];
  for (const path of enumerateRoutes(pools, from, to, maxHops)) {
    try {
      routes.push(quoteRoute(path, from, amountIn));
    } catch (error) {
      rejected.push({ pools: path.map((p) => p.poolComponent), reason: (error as Error).message });
    }
  }
  routes.sort((x, y) => {
    const a = BigInt(x.amountOut);
    const b = BigInt(y.amountOut);
    if (a !== b) return a > b ? -1 : 1;
    return x.hops.length - y.hops.length;
  });
  return { routes, rejected };
}

// ---------------------------------------------------------------------------
// Authoritative resolution
// ---------------------------------------------------------------------------

export interface MultiHopSwapRequest {
  readonly inputResource: string;
  readonly outputResource: string;
  readonly rawInputAmount: string;
  /** Pools in execution order, as chosen from a (discovery-time) RouteQuote. */
  readonly pools: readonly string[];
  readonly slippage: SlippagePolicy;
  readonly maxEpoch: string;
  /** The output the user saw. A fresh re-read that pays less than `expectedOutput`'s minimum is STALE. */
  readonly expectedOutput?: string;
}

export interface MultiHopIntentBuilder<TIntent> {
  multiHopSwap(input: {
    quote: RouteQuote;
    minOutput: string;
    maxEpoch: string;
    slippageBps: string;
    /**
     * Each hop's published template address, in route order, as named by that component's OWN
     * header in the authoritative re-read above.
     *
     * Two templates share this pool shape — the public pool and the revealed-value pool — so
     * a caller that must disclose the venue reads it from here. This module stays policy-free:
     * it reports what each component said and never decides which templates are acceptable.
     *
     * An entry is `undefined` only when the transport could not report that hop's template
     * (the legacy flat-field envelope path). A builder that needs the venue must refuse such
     * a hop rather than assume one.
     */
    templateAddresses: readonly (string | undefined)[];
  }): TIntent;
}

export type MultiHopOutcome<TIntent> =
  | {
      status: 'ACTIVE';
      quote: RouteQuote;
      minOutput: string;
      builderIntent: TIntent;
      /** Freshness of each hop's authoritative read, in route order. */
      freshness: readonly Freshness[];
      /** Each hop's own published template address, in route order (see the builder input). */
      templateAddresses: readonly (string | undefined)[];
    }
  | { status: 'STALE' | 'UNAVAILABLE' | 'EXPIRED' | 'CONFLICTED'; reason: string };

export async function resolveMultiHopSwap<TIntent>(
  request: MultiHopSwapRequest,
  deps: { readback: PoolReadbackProvider; builder: MultiHopIntentBuilder<TIntent>; currentEpoch?: string },
): Promise<MultiHopOutcome<TIntent>> {
  if (request.pools.length < 1 || request.pools.length > MAX_HOPS) return { status: 'UNAVAILABLE', reason: `a route has 1..${MAX_HOPS} hops` };
  if (new Set(request.pools).size !== request.pools.length) return { status: 'CONFLICTED', reason: 'a pool appears twice in the route' };
  if (deps.currentEpoch !== undefined && BigInt(deps.currentEpoch) >= BigInt(request.maxEpoch)) {
    return { status: 'EXPIRED', reason: `Current epoch ${deps.currentEpoch} is at/after the route's max epoch ${request.maxEpoch}` };
  }
  const edges: PoolEdge[] = [];
  const freshness: Freshness[] = [];
  const templateAddresses: (string | undefined)[] = [];
  for (const pool of request.pools) {
    // EVERY hop is re-read authoritatively; a discovery snapshot never prices a signed route.
    const read = await deps.readback.readPool(pool);
    if (read.status !== 'FOUND') return { status: 'UNAVAILABLE', reason: `Pool ${pool}: ${read.reason}` };
    const v = read.value;
    freshness.push(read.freshness);
    templateAddresses.push(v.templateAddress);
    edges.push({ poolComponent: pool, resourceA: v.resourceA, resourceB: v.resourceB, reserveA: v.reserveA, reserveB: v.reserveB, feeBps: v.feeBps });
  }
  let quote: RouteQuote;
  try {
    quote = quoteRoute(edges, request.inputResource, request.rawInputAmount);
  } catch (error) {
    return { status: 'CONFLICTED', reason: (error as Error).message };
  }
  if (quote.outputResource !== request.outputResource) {
    return { status: 'CONFLICTED', reason: `the route ends in ${quote.outputResource}, not the requested ${request.outputResource}` };
  }
  let minOutput: string;
  try {
    minOutput = deriveMinOutput(quote.amountOut, request.slippage);
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }
  if (request.expectedOutput !== undefined) {
    const floor = deriveMinOutput(request.expectedOutput, request.slippage);
    if (BigInt(quote.amountOut) < BigInt(floor)) {
      return { status: 'STALE', reason: `Reserves moved since the quote: the route now pays ${quote.amountOut}, below the ${floor} the shown quote allowed. Re-quote before signing.` };
    }
  }
  return {
    status: 'ACTIVE',
    quote,
    minOutput,
    freshness,
    templateAddresses,
    builderIntent: deps.builder.multiHopSwap({ quote, minOutput, maxEpoch: request.maxEpoch, slippageBps: request.slippage.slippageBps, templateAddresses }),
  };
}
