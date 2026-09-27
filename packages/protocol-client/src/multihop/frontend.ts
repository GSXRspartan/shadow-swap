/**
 * Frontend-facing route view and market-data seam.
 *
 * §31: expose a stable view model the future webpage can consume. NO React/UI here — this is
 * the contract only, deliberately serialisable and framework-free.
 *
 * §32: on successful AMM settlement, emit enough metadata to later feed trade history,
 * OHLC candles, volume, and pool charts. Candle AGGREGATION is explicitly not implemented.
 */
import { RouteRecord, RouteState, MarketDataEvent, RouteFeeBreakdown } from './types.js';

export interface RouteStepView {
  index: number;
  kind: string;
  fromLabel: string;
  toLabel: string;
  inputAmountRaw: string;
  expectedOutputRaw: string;
  minimumOutputRaw?: string;
  status: 'PENDING' | 'EXECUTING' | 'AWAITING_CONFIRMATION' | 'SETTLED' | 'REFUNDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';
  chainTxId?: string;
  failureReason?: string;
}

export interface RouteView {
  routeId: string;
  state: RouteState;
  from: { label: string; amountRaw: string; kind: string };
  to: { label: string; kind: string };
  inputAmountRaw: string;
  expectedOutputRaw: string;
  minimumOutputRaw: string;
  /** The user's accepted hard floor — the UI must show this as protected. */
  acceptedMinimumFinalOutputRaw: string;
  provider: { providerId: string; spreadBps: string } | null;
  steps: RouteStepView[];
  fees: RouteFeeBreakdown;
  /** Developer fee is always zero; surfaced so the UI never implies a rake. */
  developerTradingFeeRaw: '0';
  requiresApproval: boolean;
  waitingForConfirmation: boolean;
  requoteRequired: boolean;
  /** Claim/refund/recovery state surfaced for the user, not just a generic status. */
  claimState: 'NOT_STARTED' | 'ARMED' | 'REVEALED' | 'CLAIMED' | 'REFUNDABLE' | 'REFUNDED' | 'RECOVERY';
  recoveryRequired: boolean;
  pausedReason?: string;
  /** Route expires / quote expires, so the UI can show a countdown. */
  quoteExpiresAtUnixMs: number;
  routeExpiresAtUnixMs: number;
  /** Always false: the preimage must never reach a UI-facing model. */
  containsSecret: false;
}

function stepStatus(hop: RouteRecord['hops'][number]): RouteStepView['status'] {
  if (hop.settlement === 'SETTLED') return 'SETTLED';
  if (hop.settlement === 'REFUNDED') return 'REFUNDED';
  if (hop.settlement === 'FAILED_TERMINAL') return 'FAILED';
  if (hop.execution === 'UNKNOWN') return 'UNKNOWN';
  if (hop.execution === 'SUBMITTED') return 'AWAITING_CONFIRMATION';
  if (hop.execution === 'EXECUTING') return 'EXECUTING';
  if (hop.execution === 'FAILED') return 'FAILED';
  return 'PENDING';
}

/** Build the frontend contract from the authoritative route record. */
export function toRouteView(record: RouteRecord, input: { provider?: { providerId: string; spreadBps: string } } = {}): RouteView {
  const requote = record.state === 'ROUTE_PAUSED' && record.pause?.reason === 'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED';
  const waiting = record.hops.some((h) => h.execution === 'SUBMITTED' || h.execution === 'EXECUTING');
  const hop2Skipped = record.state === 'HOP2_SKIPPED' || record.hops[1]?.execution === 'NOT_STARTED';
  return {
    routeId: record.routeId,
    state: record.state,
    from: { label: record.sourceAsset.label, amountRaw: record.acceptance.authorizedSourceAmountRaw, kind: record.sourceAsset.kind },
    to: { label: record.destinationAsset.label, kind: record.destinationAsset.kind },
    inputAmountRaw: record.acceptance.authorizedSourceAmountRaw,
    expectedOutputRaw: record.totalExpectedOutputRaw,
    minimumOutputRaw: record.totalMinimumOutputRaw,
    acceptedMinimumFinalOutputRaw: record.acceptance.minimumFinalOutputRaw,
    provider: input.provider ?? null,
    steps: record.hops.map((hop, index) => ({
      index,
      kind: hop.kind,
      fromLabel: hop.inputAsset.label,
      toLabel: hop.outputAsset.label,
      inputAmountRaw: hop.inputAmountRaw,
      expectedOutputRaw: hop.expectedOutputRaw,
      minimumOutputRaw: hop.minimumOutputRaw,
      status: hop2Skipped && index === 1 && hop.settlement === 'UNSETTLED' && record.state === 'HOP2_SKIPPED' ? 'SKIPPED' : stepStatus(hop),
      chainTxId: hop.chainTxId,
      failureReason: hop.failureReason,
    })),
    fees: record.fees,
    developerTradingFeeRaw: '0',
    requiresApproval: record.state === 'ROUTE_QUOTED' || record.state === 'ROUTE_PAUSED',
    waitingForConfirmation: waiting,
    requoteRequired: requote,
    claimState: record.hops[0]?.settlement === 'SETTLED' ? 'CLAIMED' : record.state === 'ROUTE_RECOVERY_REQUIRED' ? 'RECOVERY' : record.state === 'ROUTE_PAUSED' ? 'CLAIMED' : 'NOT_STARTED',
    recoveryRequired: record.state === 'ROUTE_RECOVERY_REQUIRED',
    pausedReason: record.pause?.reason,
    quoteExpiresAtUnixMs: record.quoteExpiresAtUnixMs,
    routeExpiresAtUnixMs: record.routeExpiresAtUnixMs,
    containsSecret: false,
  };
}

// ---------------------------------------------------------------------------
// Market data seam (§32)
// ---------------------------------------------------------------------------

/** Sink for successful AMM executions. Implementations may index; none aggregate candles. */
export interface MarketDataSink {
  record(event: MarketDataEvent): void;
}

export class InMemoryMarketDataSink implements MarketDataSink {
  readonly events: MarketDataEvent[] = [];
  record(event: MarketDataEvent): void {
    this.events.push(event);
  }
}

/**
 * Build the market-data event for a SUCCESSFUL hop-2 settlement.
 *
 * Deliberately includes the exact price inputs (reserves before AND after) so candles can
 * be recomputed later without re-reading the chain, and the txid + epoch/version for
 * ordering and deduplication.
 */
export function buildMarketDataEvent(input: {
  routeId: string;
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  reserveInBefore: string;
  reserveOutBefore: string;
  reserveInAfter: string;
  reserveOutAfter: string;
  feeBps: string;
  chainTxId: string;
  epoch: string;
  substateVersion?: string;
  nowUnixMs?: number;
}): MarketDataEvent {
  for (const [k, v] of Object.entries({ inputAmountRaw: input.inputAmountRaw, outputAmountRaw: input.outputAmountRaw, reserveInBefore: input.reserveInBefore, reserveOutBefore: input.reserveOutBefore })) {
    if (!/^\d+$/.test(v)) throw new Error(`market data ${k} must be a raw integer string, got ${v}`);
  }
  if (input.chainTxId === '') throw new Error('market data event requires the hop-2 chain tx id');
  return {
    poolComponent: input.poolComponent,
    inputResource: input.inputResource,
    outputResource: input.outputResource,
    inputAmountRaw: input.inputAmountRaw,
    outputAmountRaw: input.outputAmountRaw,
    reserveInBefore: input.reserveInBefore,
    reserveOutBefore: input.reserveOutBefore,
    reserveInAfter: input.reserveInAfter,
    reserveOutAfter: input.reserveOutAfter,
    feeBps: input.feeBps,
    chainTxId: input.chainTxId,
    epoch: input.epoch,
    substateVersion: input.substateVersion,
    routeId: input.routeId,
    emittedAtUnixMs: input.nowUnixMs ?? Date.now(),
  };
}
