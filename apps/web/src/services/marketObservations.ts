/**
 * Settlement observations: turning the app's OWN settled swaps into market data.
 *
 * WHY THIS EXISTS. The market-data store validates and aggregates trades, but no
 * source ever fed it: the MarketDataService is constructed without a
 * TradeDiscoverySource. This module is the honest part of the pipeline that needs
 * no discovery scan at all — when the app settles one of its OWN swaps, before/after
 * pool reserves are re-read authoritatively and the swap becomes a canonical trade
 * observation. Market-wide history for OTHER users' swaps is a different problem
 * (receipt/vault scanning) and is deliberately NOT synthesized here.
 *
 * ATTRIBUTION RULE (the whole safety argument). Reserve deltas attribute a trade
 * only when the pool's authoritative identity proves no other transaction touched
 * the pool between the before-read and the after-read (producing hash unchanged,
 * OR version advanced by exactly one with the producing hash equal to our tx id).
 * When someone else's swap interleaved, we record NOTHING rather than a wrong trade.
 */
import type { TradeObservation } from '@tari-ootle/protocol-client';

const SNAPSHOT_STORAGE_KEY = 'ootle.prePool.v1';
const MAX_SNAPSHOTS = 50;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PrePoolSnapshot {
  readonly operationId: string;
  readonly poolComponent: string;
  readonly resourceA: string;
  readonly resourceB: string;
  readonly baseDecimals: string;
  readonly quoteDecimals: string;
  readonly reserveA: string;
  readonly reserveB: string;
  readonly feeBps: string;
  readonly substateVersion?: string;
  readonly producingTxHash?: string;
  readonly savedAtUnixMs: number;
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

function loadSnapshots(): Map<string, PrePoolSnapshot> {
  const map = new Map<string, PrePoolSnapshot>();
  const store = storage();
  if (store === undefined) return map;
  try {
    const raw = store.getItem(SNAPSHOT_STORAGE_KEY);
    if (raw === null || raw === '') return map;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return map;
    const bag = parsed as Record<string, unknown>;
    if (bag.version !== 1 || !Array.isArray(bag.records)) return map;
    for (const entry of bag.records) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.operationId !== 'string' || typeof rec.poolComponent !== 'string') continue;
      if (typeof rec.reserveA !== 'string' || typeof rec.reserveB !== 'string') continue;
      if (typeof rec.savedAtUnixMs !== 'number') continue;
      if (Date.now() - rec.savedAtUnixMs > SNAPSHOT_TTL_MS) continue;
      map.set(rec.operationId, rec as unknown as PrePoolSnapshot);
    }
  } catch {
    return new Map();
  }
  return map;
}

function saveSnapshots(map: Map<string, PrePoolSnapshot>): void {
  const store = storage();
  if (store === undefined) return;
  try {
    const now = Date.now();
    const records = [...map.values()]
      .filter((rec) => now - rec.savedAtUnixMs <= SNAPSHOT_TTL_MS)
      .slice(0, MAX_SNAPSHOTS);
    store.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify({ version: 1, records }));
  } catch {
    /* persistence is a recovery aid; the chain remains the record */
  }
}

export function savePrePoolSnapshot(snapshot: PrePoolSnapshot): void {
  const map = loadSnapshots();
  map.set(snapshot.operationId, snapshot);
  saveSnapshots(map);
}

export function takePrePoolSnapshot(operationId: string): PrePoolSnapshot | undefined {
  const map = loadSnapshots();
  const snapshot = map.get(operationId);
  if (snapshot === undefined) return undefined;
  map.delete(operationId);
  saveSnapshots(map);
  return snapshot;
}

/**
 * Strict attribution: the after-read proves the observed delta is OUR transaction's.
 * Contended pools record nothing.
 */
export function attributesToOurSwap(
  before: { substateVersion?: string; producingTxHash?: string },
  after: { substateVersion?: string; producingTxHash?: string },
  ourTxId?: string,
): boolean {
  if (after.producingTxHash !== undefined && ourTxId !== undefined && after.producingTxHash === ourTxId) return true;
  if (before.substateVersion !== undefined && after.substateVersion !== undefined) {
    try {
      const b = BigInt(before.substateVersion);
      const a = BigInt(after.substateVersion);
      return a === b + 1n;
    } catch {
      return false;
    }
  }
  return before.producingTxHash === after.producingTxHash;
}

export interface SettledObservationInput {
  readonly record: {
    readonly pulledAmount: string;
    readonly pulledResource?: string;
  };
  readonly before: PrePoolSnapshot;
  readonly after: {
    readonly reserveA: string;
    readonly reserveB: string;
    readonly epoch?: string;
    readonly feeBps?: string;
  };
  readonly transactionId: string;
  readonly instructionIndex?: string;
  readonly source?: string;
}

const POSITIVE = /^[1-9]\d*$/;

/**
 * Synthesize ONE canonical trade from settled reserve deltas. Returns undefined
 * when the record is not a swap or the movement is not a trade. Throws never:
 * malformed data means NO observation, never a guessed one.
 */
export function settledObservation(input: SettledObservationInput): TradeObservation | undefined {
  const { before, after } = input;
  if (!POSITIVE.test(input.record.pulledAmount)) return undefined;
  if (!POSITIVE.test(before.reserveA) || !POSITIVE.test(before.reserveB)) return undefined;
  if (!POSITIVE.test(after.reserveA) || !POSITIVE.test(after.reserveB)) return undefined;
  const aBefore = BigInt(before.reserveA);
  const bBefore = BigInt(before.reserveB);
  const aAfter = BigInt(after.reserveA);
  const bAfter = BigInt(after.reserveB);
  const dA = aAfter - aBefore;
  const dB = bAfter - bBefore;
  if (dA === 0n || dB === 0n) return undefined;
  // A swap moves exactly one side in and the other out.
  if ((dA > 0n) === (dB > 0n)) return undefined;
  const isAB = dA > 0n;
  const inputAmount = isAB ? dA : dB;
  const outputAmount = isAB ? -dB : -dA;
  if (inputAmount <= 0n || outputAmount <= 0n) return undefined;
  const epoch = after.epoch ?? '0';
  return {
    chainTxId: input.transactionId,
    instructionIndex: input.instructionIndex ?? '0',
    poolComponent: before.poolComponent,
    inputResource: isAB ? before.resourceA : before.resourceB,
    outputResource: isAB ? before.resourceB : before.resourceA,
    inputAmountRaw: inputAmount.toString(),
    outputAmountRaw: outputAmount.toString(),
    reserveABefore: before.reserveA,
    reserveBBefore: before.reserveB,
    reserveAAfter: after.reserveA,
    reserveBAfter: after.reserveB,
    feeBps: after.feeBps ?? before.feeBps,
    epoch,
    time: { bucketKey: epoch, epoch, source: 'INDEXER_OBSERVED' },
    finality: 'FINALIZED',
    source: input.source ?? 'LOCAL_EXECUTION',
  };
}
