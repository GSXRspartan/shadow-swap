/**
 * Durable, application-owned protocol operation history (AMM + marketplace).
 *
 * UNKNOWN is a first-class state: a lost submission response is NOT evidence of failure.
 * Reconciliation must consult authoritative chain evidence via durable identifiers before
 * anything is rebuilt or resubmitted (this behavior is reused by future cross-chain XTM/TARI
 * operations).
 */
import {
  OperationRecord,
  OperationState,
  TransactionLookup,
  reconcileUnknownSubmission,
} from './execution.js';

export type ProtocolOperationKind =
  // AMM
  | 'AMM_SWAP'
  | 'AMM_ADD_LIQUIDITY'
  | 'AMM_REMOVE_LIQUIDITY'
  // Marketplace
  | 'MARKET_CREATE_LISTING'
  | 'MARKET_CANCEL_LISTING'
  | 'MARKET_BUY_NFT'
  | 'MARKET_MAKE_ITEM_OFFER'
  | 'MARKET_CANCEL_ITEM_OFFER'
  | 'MARKET_ACCEPT_ITEM_OFFER'
  | 'MARKET_PLACE_COLLECTION_BID'
  | 'MARKET_FILL_COLLECTION_BID'
  | 'MARKET_CANCEL_COLLECTION_BID'
  | 'MARKET_REFUND';

/** Persistence boundary. Implementations: memory (tests), JSON file, SQLite, KeyValueStore. */
export interface ProtocolHistoryStore {
  save(record: OperationRecord): Promise<void>;
  get(operationId: string): Promise<OperationRecord | undefined>;
  listUnknown(): Promise<OperationRecord[]>;
  listByTransactionId(transactionId: string): Promise<OperationRecord[]>;
}

export class InMemoryHistoryStore implements ProtocolHistoryStore {
  private readonly records = new Map<string, OperationRecord>();
  async save(record: OperationRecord): Promise<void> {
    this.records.set(record.operationId, { ...record });
  }
  async get(operationId: string): Promise<OperationRecord | undefined> {
    const record = this.records.get(operationId);
    return record ? { ...record } : undefined;
  }
  async listUnknown(): Promise<OperationRecord[]> {
    return [...this.records.values()].filter((r) => r.state === 'UNKNOWN').map((r) => ({ ...r }));
  }
  async listByTransactionId(transactionId: string): Promise<OperationRecord[]> {
    return [...this.records.values()].filter((r) => r.transactionId === transactionId).map((r) => ({ ...r }));
  }
}

/**
 * Durable store over injected JSON-file/KV IO primitives, so this package stays
 * environment-agnostic: a Node app supplies fs, a browser extension supplies its
 * KeyValueStore, Capacitor supplies its storage. The APPLICATION owns the bytes.
 */
export interface HistoryIo {
  /** Whole-payload read; resolve undefined when nothing was persisted yet. */
  read(): Promise<string | undefined>;
  /** Whole-payload write. Implementations should be atomic. */
  write(text: string): Promise<void>;
}

export class JsonHistoryStore implements ProtocolHistoryStore {
  constructor(private readonly io: HistoryIo) {}
  private async loadAll(): Promise<Map<string, OperationRecord>> {
    try {
      const text = await this.io.read();
      if (!text) return new Map();
      const parsed = JSON.parse(text) as OperationRecord[];
      return new Map(parsed.map((r) => [r.operationId, r]));
    } catch {
      return new Map();
    }
  }
  private async persistAll(records: Map<string, OperationRecord>): Promise<void> {
    await this.io.write(JSON.stringify([...records.values()], null, 2));
  }
  async save(record: OperationRecord): Promise<void> {
    const all = await this.loadAll();
    all.set(record.operationId, { ...record });
    await this.persistAll(all);
  }
  async get(operationId: string): Promise<OperationRecord | undefined> {
    const all = await this.loadAll();
    const record = all.get(operationId);
    return record ? { ...record } : undefined;
  }
  async listUnknown(): Promise<OperationRecord[]> {
    const all = await this.loadAll();
    return [...all.values()].filter((r) => r.state === 'UNKNOWN').map((r) => ({ ...r }));
  }
  async listByTransactionId(transactionId: string): Promise<OperationRecord[]> {
    const all = await this.loadAll();
    return [...all.values()].filter((r) => r.transactionId === transactionId).map((r) => ({ ...r }));
  }
}

/** Creates a fresh PENDING record. operationId is the durable identity — keep it. */
export function createOperationRecord(input: {
  operationId: string;
  operationKind: string;
  componentOrOrderId?: string;
  resources: string[];
  amounts: Record<string, string>;
  quote?: { quotedOutput: string; minOutput: string };
  epoch?: string;
  expiryEpoch?: string;
}): OperationRecord {
  return {
    operationId: input.operationId,
    operationKind: input.operationKind,
    state: 'PENDING',
    componentOrOrderId: input.componentOrOrderId,
    resources: [...input.resources],
    amounts: { ...input.amounts },
    quote: input.quote ? { ...input.quote } : undefined,
    epoch: input.epoch,
    expiryEpoch: input.expiryEpoch,
    createdAtUnixMs: Date.now(),
  };
}

/** Marks a record as submitted with its durable chain transaction id. */
export function markSubmitted(record: OperationRecord, transactionId: string, epoch?: string): OperationRecord {
  return {
    ...record,
    state: 'SUBMITTED',
    transactionId,
    submittedAtUnixMs: Date.now(),
    epoch: epoch ?? record.epoch,
  };
}

/** Marks a record UNKNOWN — a lost submission response is not evidence of failure. */
export function markUnknown(record: OperationRecord, transportError: string): OperationRecord {
  return {
    ...record,
    state: 'UNKNOWN',
    failureReason: `TRANSPORT_UNKNOWN: ${transportError}`,
  };
}

export function markFailed(record: OperationRecord, reason: string): OperationRecord {
  return { ...record, state: 'FAILED', failureReason: record.failureReason ?? reason, confirmedAtUnixMs: Date.now() };
}

export function markConfirmed(record: OperationRecord, epoch?: string): OperationRecord {
  return { ...record, state: 'CONFIRMED', confirmedAtUnixMs: Date.now(), epoch: epoch ?? record.epoch };
}

export interface ReconciliationOutcome {
  record: OperationRecord;
  finalState: OperationState;
  resubmissionAllowed: boolean;
  reason: string;
}

/**
 * Retry-safe reconciliation for an operation whose submission response was lost.
 * Consults the authoritative transaction lookup; NEVER resubmits on its own.
 */
export async function reconcileOperation(record: OperationRecord, lookup: TransactionLookup): Promise<ReconciliationOutcome> {
  const result = await reconcileUnknownSubmission({ record, lookup });
  let finalState = result.finalState;
  if (finalState === 'CONFIRMED' && record.state !== 'CONFIRMED') {
    // Recover: promote the record with the durable txid.
    finalState = 'CONFIRMED';
  }
  const updated: OperationRecord = {
    ...record,
    state: finalState,
    confirmedAtUnixMs: finalState === 'CONFIRMED' ? Date.now() : record.confirmedAtUnixMs,
    failureReason: finalState === 'FAILED' ? result.reason : record.failureReason,
  };
  return {
    record: updated,
    finalState,
    resubmissionAllowed: result.resubmissionAllowed,
    reason: result.reason,
  };
}

/**
 * Pre-submit guard. Callers MUST call this before handing a transaction to a signer.
 * Fails closed: UNKNOWN and SUBMITTED records can never be silently submitted again.
 */
export function requireFreshSubmissionAllowed(record: OperationRecord): void {
  if (record.state === 'CONFIRMED') {
    throw new Error(`Operation ${record.operationId} is already CONFIRMED; a second submission would double-execute the intent`);
  }
  if (record.state === 'SUBMITTED' && record.transactionId) {
    throw new Error(`Operation ${record.operationId} was already submitted as ${record.transactionId}; reconcile instead of resubmitting`);
  }
  if (record.state === 'UNKNOWN') {
    throw new Error(`Operation ${record.operationId} is UNKNOWN; reconcile by durable identifier before any resubmission`);
  }
}