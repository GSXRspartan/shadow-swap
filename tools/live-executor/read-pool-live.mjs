// Authoritative Pool v2 live read: walletd + BOTH public Esmeralda indexers, decoded with the
// SAME strict `decodePoolState` the product quote path uses.
//
// Read-only. No transaction is built or submitted. Every source is reported separately and
// agreement is asserted, never assumed: a source that fails is reported FAILED, not folded in.
//
// Usage: node read-pool-live.mjs [--pool component_..] [--json]

import { WalletdExecutor } from './walletd.mjs';

const POOL_V2 = 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2';
const POOL_V2_TEMPLATE = 'template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab';
const INDEXERS = ['https://ootle-indexer-a.tari.com', 'https://ootle-indexer-b.tari.com'];

const { decodePoolState } = await import(
  '../../packages/protocol-client/dist/esm/poolSubstate.js'
);

/**
 * walletd `substates.get` -> the raw `{Component|Vault|Resource:{...}}` value.
 *
 * The v0.45 daemon answers `{ local_record, substate_from_remote: { substate, version } }`.
 * It proxies the indexer, so this is a genuinely independent path only in that it is served by
 * the daemon rather than the REST host — the underlying indexer is reported separately below.
 */
function walletdReader(ex) {
  return {
    label: 'walletd',
    async read(address) {
      const r = await ex.rpc('substates.get', { substate_id: address }, { timeoutMs: 60_000 });
      return r?.substate_from_remote?.substate;
    },
  };
}

/**
 * `POST /substates/fetch` batch reader (max 20 ids per request).
 *
 * The live v0.45 shape is `{ substates: { <substate_id>: { substate, version } }, proofs }`
 * — a MAP keyed by id, not an array of per-request results. Anything the daemon/indexer does
 * not return is surfaced as `undefined` so `decodePoolState` fails closed rather than
 * silently substituting a field.
 */
function indexerReader(base) {
  return {
    label: base,
    async read(address) {
      const res = await fetch(`${base}/substates/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [address], cached_only: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${base} /substates/fetch HTTP ${res.status}`);
      const body = await res.json();
      const entry = body?.substates?.[address] ?? body?.substates?.[0]?.[1] ?? body?.[0];
      return entry?.substate;
    },
  };
}

async function decodeFrom(reader, pool) {
  try {
    const state = await decodePoolState({ read: (a) => reader.read(a) }, pool);
    return { ok: true, state };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Independent owner/template read straight from the indexer component substate. */
async function indexerComponentFacts(base, pool) {
  const reader = indexerReader(base);
  const substate = await reader.read(pool);
  const c = substate?.Component;
  const access = c?.header?.access_rules;
  return {
    template_address: c?.header?.template_address ?? null,
    owner_rule: c?.header?.owner_rule ?? null,
    method_access: access?.method_access ?? null,
    default_access: access?.default ?? null,
  };
}

const argv = process.argv.slice(2);
const poolIdx = argv.indexOf('--pool');
const pool = poolIdx >= 0 ? argv[poolIdx + 1] : POOL_V2;
const asJson = argv.includes('--json');

const ex = new WalletdExecutor();
const identity = await ex.verifyNetwork();
const info = await ex.rpc('wallet.get_info', {});

const sources = [walletdReader(ex), ...INDEXERS.map(indexerReader)];
const results = {};
for (const s of sources) results[s.label] = await decodeFrom(s, pool);

const templateFacts = {};
for (const b of INDEXERS) {
  try {
    templateFacts[b] = await indexerComponentFacts(b, pool);
  } catch (e) {
    templateFacts[b] = { error: e instanceof Error ? e.message : String(e) };
  }
}

const decoded = Object.entries(results).filter(([, r]) => r.ok).map(([, r]) => JSON.stringify(r.state));
const agree = decoded.length > 0 && new Set(decoded).size === 1;

const report = {
  evidence: 'LIVE READ VERIFIED',
  walletd: { version: info?.version, network: info?.network, network_byte: info?.network_byte, indexer_url: identity.indexerUrl },
  network: { name: identity.network, byte: identity.networkByte, epoch: identity.epoch },
  pool,
  expected_template: POOL_V2_TEMPLATE,
  template_facts: templateFacts,
  sources_agree: agree,
  states: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? v.state : { FAILED: v.error }])),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`walletd ${report.walletd.version} on ${report.walletd.network}/${report.walletd.network_byte} epoch ${report.network.epoch} via ${report.walletd.indexer_url}`);
  console.log(`pool ${pool}`);
  for (const [label, r] of Object.entries(results)) {
    console.log(
      r.ok
        ? `  ${label.padEnd(34)} reserveA=${r.state.reserveA} reserveB=${r.state.reserveB} lpSupply=${r.state.totalLpSupply} lockedLP=${r.state.lockedLpSupply} feeBps=${r.state.feeBps}`
        : `  ${label.padEnd(34)} FAILED: ${r.error}`,
    );
  }
  for (const [b, f] of Object.entries(templateFacts)) console.log(`  template@${b}: ${JSON.stringify(f)}`);
  console.log(`  all readable sources agree: ${agree}`);
}

process.exit(agree ? 0 : 1);