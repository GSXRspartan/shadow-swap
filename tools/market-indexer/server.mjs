/**
 * Shadow Swap read-only market indexer (Ootle Esmeralda VPS sidecar).
 * Plain Node ESM. Polls the public indexer for CURRENT pool state and maps each
 * vault version change to a trade row. No signing, no custody, no walletd.
 * Historical substates are unavailable on the indexer, so this indexer accrues
 * history FORWARD from its first observation; it never invents what came before.
 *
 * Endpoints (read-only):
 *   GET /healthz                            -> ok
 *   GET /readyz                             -> { ok, indexerEpoch, indexerVersion }
 *   GET /api/v1/pools                       -> latest decoded pools
 *   GET /api/v1/trades?pool=<component>     -> derived trade observations
 *   GET /api/v1/candles?pool=<component>&limit=N -> candles (trade close aggregated per epoch)
 *
 * Env: INDEXER_URL, POLL_MS, DATA_DIR, PORT (8080), POOLS (comma list, default TESTA pool)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_URL = process.env.INDEXER_URL ?? 'https://esme-indexer-a.ootle.tari.com';
const POLL_MS = Number(process.env.POLL_MS ?? 15000);
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? path.join(HERE, 'data');

// --- codec -------------------------------------------------------------------

const { loadOotleWasmBor } = await import('./codec.mjs');
const codec = await loadOotleWasmBor();

// --- decode (mirrors protocol-client/src/poolSubstate.ts) ---------------------

const record = (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined);
const text = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
function intString(value, what) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error(`${what} is not a non-negative integer`);
}
const HEX64 = /^[0-9a-f]{64}$/;
function taggedHex(node, expectedTag, what) {
  const bag = record(node);
  if (bag === undefined || bag['@cbor'] !== 'tag' || bag.tag !== expectedTag) {
    throw new Error(`${what} is not a CBOR tag ${expectedTag} node`);
  }
  const inner = record(bag.value);
  const hex = inner?.hex;
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error(`${what} does not carry a 32-byte object key`);
  return hex;
}
function bareObjectKey(value) {
  const bag = record(value);
  if (bag !== undefined && typeof bag.hex === 'string') {
    if (!HEX64.test(bag.hex)) throw new Error('object key is not 32 bytes');
    return bag.hex;
  }
  // Some mirrors nest: { value: { hex } }.
  const inner = record(record(value)?.value);
  if (inner?.hex !== undefined && HEX64.test(inner.hex)) return inner.hex;
  if (typeof value === 'string' && HEX64.test(value)) return value;
  throw new Error('template address is not a 32-byte hash');
}
function decodePoolComponent(substate) {
  const comp = record(record(substate)?.Component) ?? record(substate);
  const body = record(comp?.body);
  const state = body?.state;
  if (!Array.isArray(state) || state.length < 4) throw new Error('pool state is not the expected tuple');
  const header = record(comp?.header);
  const template = text(header?.template_address);
  if (template === undefined) throw new Error('header does not name its template');
  const poolsMap = record(state[0]);
  const entries = poolsMap?.entries;
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error('pools map must have exactly two entries');
  const pairs = entries.map((e, i) => {
    if (!Array.isArray(e) || e.length < 2) throw new Error(`pools entry ${i} is malformed`);
    return { resource: 'resource_' + taggedHex(e[0], 131, `pools[${i}].resource`), vault: 'vault_' + taggedHex(e[1], 132, `pools[${i}].vault`) };
  });
  return {
    templateAddress: bareObjectKey(template),
    resourceA: pairs[0].resource,
    reserveVaultA: pairs[0].vault,
    resourceB: pairs[1].resource,
    reserveVaultB: pairs[1].vault,
    feeBps: intString(state[2], 'fee_bps'),
  };
}
function decodeVault(vaultSubstate) {
  const container = record(record(record(vaultSubstate)?.Vault)?.resource_container) ?? record(record(vaultSubstate)?.resource_container);
  if (container === undefined) throw new Error('no resource_container');
  for (const kind of ['Fungible', 'Stealth', 'Confidential']) {
    const inner = record(container[kind]);
    const amt = inner?.amount ?? inner?.revealed_amount;
    if (inner === undefined) continue;
    return { amount: intString(amt, 'amount'), kind };
  }
  throw new Error('unrecognised container kind');
}

// --- ledger -------------------------------------------------------------------

class Ledger {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'ledger.jsonl');
    this.rows = [];
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.rows.push(JSON.parse(line));
        } catch {
          /* skip corrupt lines */
        }
      }
    }
  }

  append(row) {
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    this.rows.push(row);
    if (this.rows.length > 50_000) {
      const kept = this.rows.slice(-50_000);
      fs.writeFileSync(this.file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      this.rows = kept;
    }
  }

  all(type, filterFn = () => true) {
    return this.rows.filter((r) => r.type === type && filterFn(r));
  }
}

const ledger = new Ledger(DATA_DIR);
const byVault = new Map();
const byPool = new Map();

/* Persistence-across-restart: the pool-state rows carry vault versions, so a
 * restart seeds `byPool` and the next poll continues the version chain instead
 * of restarting attribution from zero. */
for (const row of ledger.rows.filter((r) => r.type === 'vault-state')) {
  byVault.set(row.vault, row);
}
for (const row of ledger.rows.filter((r) => r.type === 'pool-state')) {
  if (!byPool.has(row.pool)) byPool.set(row.pool, row);
  else byPool.set(row.pool, row);
}

/** Idempotent ingestion: a vault version (pool + version) may ingest exactly once. */
function ledgerHasVaultVersion(vault, version) {
  if (version === undefined || version === null) return true; // unknown -> refuse (fail closed)
  return ledger.rows.some((r) => r.type === 'vault-state' && r.vault === vault && r.vaultVersion === version);
}

// --- fetch -------------------------------------------------------------------

async function fetchBatch(ids) {
  const response = await fetch(new URL('/substates/fetch', INDEXER_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: ids, cached_only: false }),
  });
  if (!response.ok) throw new Error(`substates/fetch ${response.status}`);
  const body = await response.json();
  return body.substates ?? {};
}

// --- derive -------------------------------------------------------------------

export function deriveTrade(before, after) {
  const a0 = BigInt(before.reserveA);
  const b0 = BigInt(before.reserveB);
  const a1 = BigInt(after.reserveA);
  const b1 = BigInt(after.reserveB);
  const dA = a1 - a0;
  const dB = b1 - b0;
  if (dA === 0n || dB === 0n) return undefined;
  // Both sides moving the same way is liquidity movement, not a trade. Like the
  // frontend's observation sink, non-trades produce nothing rather than a
  // liquidity row this module would have to label.
  if ((dA > 0n) === (dB > 0n)) return undefined;
  const isAB = dA > 0n;
  const input = isAB ? dA : dB;
  const output = isAB ? -dB : -dA;
  if (input <= 0n || output <= 0n) return undefined;
  return { kind: 'trade', direction: isAB ? 'BASE_TO_QUOTE' : 'QUOTE_TO_BASE', inputAmount: input.toString(), outputAmount: output.toString() };
}

/**
 * Totally-ordered chain state READ: for a fetched pool at component version V
 * with vault versions (vA, vB), knowledge of (vA_d, vB_d) before this read
 * gives the aggregate effect of (dA_v, dB_v) swaps starting from a state whose
 * reserves matched those versions.
 *
 * A receipt scan would attribute dA_v + dB_v d trades but receipt diffs are
 * hash-only (value bodies unavailable), so exact per-transaction amounts for
 * historical receipts are unavailable. An aggregate row marked partial=true is
 * the honest representation of >1 chained trades.
 */
export function aggregateTrade(before, after, advanceA, advanceB) {
  const common = Math.min(advanceA, advanceB);
  const derived = deriveTrade(before, after);
  if (derived === undefined) return undefined;
  if (common === 1 && advanceA === 1 && advanceB === 1) return { ...derived, partial: false, multiCount: 1 };
  return { ...derived, partial: true, multiCount: common };
}

// --- poll ---------------------------------------------------------------------

function poolComponent(overrides) {
  const text = process.env.POOLS ?? '';
  const list = text.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : ['component_5c554ab71fa912da3f92f932cc79db4af2ecb21bbec657480a97b5017704b2c6'];
}

async function pollOnce() {
  const infoRes = await fetch(new URL('/info', INDEXER_URL));
  if (!infoRes.ok) throw new Error(`/info ${infoRes.status}`);
  const info = await infoRes.json();
  if (info.network !== 'esmeralda' && info.network !== 'localnet') {
    throw new Error(`refusing to observe non-test network: ${info.network}`);
  }
  const epoch = info.current_epoch;

  for (const component of poolComponent()) {
    const batch = await fetchBatch([component]);
    const entry = batch[component];
    if (!entry) continue;
    let shape;
    try {
      shape = decodePoolComponent(codec.decodeSubstateValue(entry.value));
    } catch {
      continue;
    }
    const vaultIds = [shape.reserveVaultA, shape.reserveVaultB];
    const vaultBatch = await fetchBatch(vaultIds);
    const va = vaultBatch[shape.reserveVaultA];
    const vb = vaultBatch[shape.reserveVaultB];
    if (!va || !vb) continue;
    let amountA;
    let amountB;
    try {
      amountA = decodeVault(codec.decodeSubstateValue(va.value)).amount;
      amountB = decodeVault(codec.decodeSubstateValue(vb.value)).amount;
    } catch {
      continue;
    }
    const versions = { A: va.version ?? 0, B: vb.version ?? 0 };
    const previous = byPool.get(component);
    const state = {
      pool: component,
      epoch,
      resourceA: shape.resourceA,
      resourceB: shape.resourceB,
      feeBps: shape.feeBps,
      reserveA: amountA,
      reserveB: amountB,
      version: entry.version ?? 0,
      vaultVersions: versions,
    };
    byPool.set(component, state);
    if (previous !== undefined) {
      const advanceA = Number(versions.A) - Number(previous.vaultVersions?.A ?? 0);
      const advanceB = Number(versions.B) - Number(previous.vaultVersions?.B ?? 0);
      if (advanceA >= 1 && advanceB >= 1) {
        // Inferred trade(s): both vaults advanced since the previous read and
        // the movement is opposite. For >1 advances the row aggregates the
        // window's activity and is marked partial — it is not one trade.
        const derived = aggregateTrade(
          { reserveA: previous.reserveA, reserveB: previous.reserveB },
          { reserveA: amountA, reserveB: amountB },
          advanceA,
          advanceB,
        );
        if (derived !== undefined && derived.kind === 'trade') {
          ledger.append({
            type: 'trade',
            ts: Date.now(),
            pool: component,
            epoch,
            direction: derived.direction,
            inputResource: derived.direction === 'BASE_TO_QUOTE' ? state.resourceA : state.resourceB,
            outputResource: derived.direction === 'BASE_TO_QUOTE' ? state.resourceB : state.resourceA,
            inputAmount: derived.inputAmount,
            outputAmount: derived.outputAmount,
            before: { reserveA: previous.reserveA, reserveB: previous.reserveB },
            after: { reserveA: amountA, reserveB: amountB },
            partial: derived.partial,
            multiCount: derived.multiCount,
            provenance: 'INFERRED_CONSECUTIVE_OBSERVATION',
            verifiedByReceipt: false,
            chainTxId: `derived:${epoch}:${versions.A}:${versions.B}`,
          });
        }
      }
    }
    if (!ledgerHasVaultVersion(shape.reserveVaultA, versions.A)) {
      ledger.append({ type: 'vault-state', ts: Date.now(), pool: component, epoch, vault: shape.reserveVaultA, vaultVersion: versions.A, vaultKind: 'A', rawAmount: amountA });
    }
    if (!ledgerHasVaultVersion(shape.reserveVaultB, versions.B)) {
      ledger.append({ type: 'vault-state', ts: Date.now(), pool: component, epoch, vault: shape.reserveVaultB, vaultVersion: versions.B, vaultKind: 'B', rawAmount: amountB });
    }
    const previousPoolState = ledger.rows.filter((r) => r.type === 'pool-state' && r.pool === component).pop();
    const stateChanged =
      previousPoolState === undefined ||
      previousPoolState.version !== state.version ||
      previousPoolState.reserveA !== state.reserveA ||
      previousPoolState.reserveB !== state.reserveB ||
      previousPoolState.epoch !== state.epoch;
    if (stateChanged) ledger.append({ type: 'pool-state', ts: Date.now(), ...state });
  }
}

// --- HTTP ----------------------------------------------------------------------

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/healthz') return void response.end('ok');
  if (url.pathname === '/readyz') {
    try {
      const info = await fetch(new URL('/info', INDEXER_URL));
      const body = await info.json();
      return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, epoch: body.current_epoch, version: body.version }));
    } catch (error) {
      return void response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
  }
  if (url.pathname === '/api/v1/pools') {
    return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([...byPool.values()]));
  }
  if (url.pathname === '/api/v1/trades') {
    const pool = url.searchParams.get('pool') ?? '';
    const rows = ledger.rows.filter((r) => r.type === 'trade' && r.pool === pool);
    return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ pool: pool || null, count: rows.length, trades: rows }));
  }
  if (url.pathname === '/api/v1/candles') {
    const pool = url.searchParams.get('pool') ?? '';
    const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
    const trades = ledger.rows.filter((r) => r.type === 'trade' && r.pool === pool).slice(-limit);
    const candles = trades.map((t) => ({ pool: t.pool, epoch: t.epoch, direction: t.direction, inputAmount: t.inputAmount, outputAmount: t.outputAmount, before: t.before, after: t.after }));
    return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ pool: pool || null, candles }));
  }
  return void response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
});

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => console.log(`[market-indexer] listening on 127.0.0.1:${PORT}`));
}

async function tick() {
  try {
    await pollOnce();
  } catch (error) {
    console.error('[market-indexer] poll failed:', error.message);
  }
}

if (isMain) {
  const timer = setInterval(tick, POLL_MS);
  tick();
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
}
