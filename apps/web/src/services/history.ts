/**
 * Durable operation history.
 *
 * Uses the protocol-client's `JsonHistoryStore` with a `localStorage`-backed
 * `HistoryIo`. The client owns the record shape and every state transition
 * helper; this module only supplies the bytes.
 *
 * `UNKNOWN` is persisted as-is. A lost submission response is never rewritten to
 * FAILED and never auto-retried — that is the protocol's decision, not the UI's.
 */

import { JsonHistoryStore, type ProtocolHistoryStore, type OperationRecord } from '@tari-ootle/protocol-client';
import { loadHistoryPayload, type HistoryLoadResult } from '../lib/storage';

const STORAGE_KEY = 'ootle.operations.v1';

function storage(): Storage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (candidate === undefined) return undefined;
    // Probe: Safari private mode throws on setItem.
    const probe = '__ootle_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return undefined;
  }
}

const memory = new Map<string, string>();

const io = {
  async read(): Promise<string | undefined> {
    const store = storage();
    if (store === undefined) return memory.get(STORAGE_KEY);
    return store.getItem(STORAGE_KEY) ?? undefined;
  },
  async write(text: string): Promise<void> {
    const store = storage();
    if (store === undefined) {
      memory.set(STORAGE_KEY, text);
      return;
    }
    store.setItem(STORAGE_KEY, text);
  },
};

export const historyStore: ProtocolHistoryStore = new JsonHistoryStore(io);

/**
 * The single parse point for persisted history.
 *
 * Everything the UI displays must come from here. The raw path — `JSON.parse`
 * plus an `operationId` type check — is deliberately not used: it accepts a
 * record whose amounts were tampered with, carries unrecognised fields (a
 * preimage written by an older build) into app state, and parses an unbounded
 * payload. `loadHistoryPayload` bounds the input, validates every record, and
 * rebuilds each one from an allowlist so unknown fields cannot survive.
 */
function parseHistory(text: string | undefined | null): HistoryLoadResult {
  return loadHistoryPayload(text);
}

/**
 * `JsonHistoryStore` degrades a corrupt payload to an empty map, which would
 * silently look like "no history yet". This surfaces that possibility so the UI
 * can warn instead of implying a clean slate.
 */
export async function historyIntegrity(): Promise<{ ok: boolean; reason?: string; count: number }> {
  const text = await io.read();
  if (text === undefined || text.trim() === '') return { ok: true, count: 0 };
  const result = parseHistory(text);
  if (result.corrupt) return { ok: false, reason: result.reason, count: 0 };
  if (result.rejected > 0) {
    return {
      ok: false,
      reason: `${result.rejected} stored operation record${result.rejected === 1 ? '' : 's'} failed validation and ${
        result.rejected === 1 ? 'was' : 'were'
      } discarded. Anything this page shows below is unverified local data.`,
      count: result.records.length,
    };
  }
  return { ok: true, count: result.records.length };
}

/** List newest-first, bounded. History is never rendered unbounded. */
export async function listOperations(limit = 100): Promise<OperationRecord[]> {
  const all = await listAllOperations();
  return all.sort((a, b) => b.createdAtUnixMs - a.createdAtUnixMs).slice(0, limit);
}

async function listAllOperations(): Promise<OperationRecord[]> {
  const text = await io.read();
  if (text === undefined || text.trim() === '') return [];
  return parseHistory(text).records;
}
