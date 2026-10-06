// Guarded Esmeralda testnet transaction executor (walletd manifest submission).
//
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// This talks to a LOCAL, LOOPBACK Tari Ootle wallet daemon (`tari_ootle_walletd`)
// over its documented JSON-RPC and submits transactions as human-readable Tari
// MANIFESTS via `transactions.submit_manifest`. The daemon parses the manifest,
// selects inputs, pays fees from its own default account, and SIGNS with the
// account's owner key that IT holds. This module never sees, derives, exports, or
// reconstructs any private key, and it never hand-encodes instructions or forges a
// signature: all of that stays inside the daemon's normal signing path. It is the
// "delegate signing/input-selection to the wallet daemon" path, not a raw ad-hoc
// publisher.
//
// It is deliberately NOT a generic remote execution service:
//   - the endpoint MUST be loopback (127.0.0.1 / ::1 / localhost);
//   - the network MUST be esmeralda (testnet, byte 38) — anything mainnet-shaped
//     is refused before a single transaction is built;
//   - every submission has an explicit per-transaction max-fee ceiling;
//   - every submission is recorded to a durable append-only ledger BEFORE the
//     result is trusted, so an interrupted run can be reconciled, never blind-retried.
//
// Testnet only. No mainnet. No key export. No cross-chain. No L1.

import { appendLedger } from './ledger.mjs';

/** Loopback hosts we will talk to. Anything else is refused. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Esmeralda testnet identity. These are checked, not assumed. */
export const EXPECTED_NETWORK = 'esmeralda';
export const EXPECTED_NETWORK_BYTE = 38;

/** Hard ceiling: no single transaction may be submitted above this fee (micro-tTARI). */
export const MAX_FEE_PER_TX_MICRO = 5_000_000; // 5 tTARI

export class ExecutorError extends Error {}

function assertLoopback(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ExecutorError(`walletd URL is not a valid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ExecutorError(`walletd URL must be http(s): ${url}`);
  }
  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`); strip them so
  // the loopback comparison matches the bare address form.
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ExecutorError(
      `REFUSED: walletd URL host "${u.hostname}" is not loopback. This tool only ever talks to a local wallet daemon.`,
    );
  }
  return u;
}

export class WalletdExecutor {
  /**
   * @param {object} opts
   * @param {string} [opts.url] walletd JSON-RPC base (default http://127.0.0.1:5100)
   * @param {number} [opts.maxFeePerTxMicro] per-tx fee ceiling override (<= hard ceiling)
   * @param {string} [opts.ledgerPath] durable ledger file path
   */
  constructor(opts = {}) {
    this.url = opts.url ?? 'http://127.0.0.1:5100';
    assertLoopback(this.url);
    this.rpcUrl = this.url.replace(/\/+$/, '') + '/json_rpc';
    this.maxFeePerTxMicro = Math.min(opts.maxFeePerTxMicro ?? MAX_FEE_PER_TX_MICRO, MAX_FEE_PER_TX_MICRO);
    this.ledgerPath = opts.ledgerPath;
    this.token = undefined;
  }

  /** Low-level JSON-RPC call. Throws ExecutorError on a JSON-RPC error. */
  async rpc(method, params = {}, { auth = true, timeoutMs = 60_000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      if (this.token === undefined) await this.authenticate();
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ExecutorError(`walletd ${method} transport error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ExecutorError(`walletd ${method} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body.error) {
      throw new ExecutorError(`walletd ${method} error ${body.error.code}: ${body.error.message}`);
    }
    return body.result;
  }

  /**
   * Authenticate against a `--authentication none` daemon. v0.43 requires the
   * `credentials` field; `{None:null}` is the no-auth variant and the daemon
   * returns a short-lived Admin JWT. No password or secret is involved.
   */
  async authenticate() {
    const result = await this.rpc(
      'auth.request',
      { permissions: ['Admin'], duration: null, credentials: { None: null } },
      { auth: false },
    );
    if (!result || typeof result.token !== 'string') {
      throw new ExecutorError('walletd auth.request did not return a token');
    }
    this.token = result.token;
    return this.token;
  }

  /**
   * Fail-closed network identity preflight. Refuses anything that is not the
   * expected esmeralda testnet identity, BEFORE any transaction is built.
   */
  async verifyNetwork() {
    const settings = await this.rpc('settings.get');
    const net = settings?.network ?? {};
    const name = String(net.name ?? '');
    const byte = Number(net.byte);
    if (/mainnet/i.test(name) || byte === 0) {
      throw new ExecutorError(`REFUSED: walletd reports a mainnet-shaped network (${name}, byte ${byte}).`);
    }
    if (name !== EXPECTED_NETWORK || byte !== EXPECTED_NETWORK_BYTE) {
      throw new ExecutorError(
        `REFUSED: walletd network is "${name}" (byte ${byte}); this tool only runs against ${EXPECTED_NETWORK} (byte ${EXPECTED_NETWORK_BYTE}).`,
      );
    }
    return { network: name, networkByte: byte, epoch: settings.current_epoch, indexerUrl: settings.indexer_url };
  }

  /** The default (fee-paying) account component address. */
  async defaultAccount() {
    const r = await this.rpc('accounts.get_default', {});
    // Shape: { account: { name, address: {Component: "component_..."} , ... }, ... }
    const acct = r?.account ?? r;
    const name = acct?.name;
    const addr = extractComponent(acct?.address) ?? extractComponent(acct?.component_address) ?? acct?.component_address;
    if (typeof addr !== 'string') throw new ExecutorError('could not resolve default account component address');
    return { name, component: addr };
  }

  /**
   * Submit a manifest. Always DRY-RUNS first to obtain the authoritative fee
   * estimate, enforces the per-tx ceiling, records intent to the ledger, then
   * (unless dryRunOnly) submits once and waits for a committed result.
   *
   * @param {object} p
   * @param {string} p.opId stable operation id for the ledger
   * @param {string} p.intent human description
   * @param {string} p.manifest manifest text
   * @param {Record<string,string>} p.variables manifest globals (strings)
   * @param {number} [p.maxFeeMicro] per-tx fee ceiling for THIS tx (<= constructor ceiling)
   * @param {boolean} [p.dryRunOnly] stop after the dry run (no state change)
   * @param {Record<string,unknown>} [p.meta] extra ledger context (exact resources etc.)
   */
  async submitManifest(p) {
    const ceiling = Math.min(p.maxFeeMicro ?? this.maxFeePerTxMicro, this.maxFeePerTxMicro);
    const identity = await this.verifyNetwork();

    // 1. Dry run for the authoritative required fee.
    const dry = await this.rpc('transactions.submit_manifest', {
      manifest: p.manifest,
      variables: p.variables ?? {},
      max_fee: ceiling,
      dry_run: true,
      signing_key_ids: [],
    });
    const requiredFees = dry?.required_fees ?? null;
    if (requiredFees !== null && Number(requiredFees) > ceiling) {
      throw new ExecutorError(
        `REFUSED: estimated fee ${requiredFees} exceeds the per-transaction ceiling ${ceiling} micro-tTARI for op ${p.opId}.`,
      );
    }
    const dryResultOk = extractOutcomeOk(dry?.result);

    await appendLedger(this.ledgerPath, {
      ts: new Date().toISOString(),
      opId: p.opId,
      phase: 'dry_run',
      intent: p.intent,
      account: identity,
      meta: p.meta ?? {},
      requiredFees,
      feeCeiling: ceiling,
      dryRunOutcome: dryResultOk,
    });

    if (p.dryRunOnly) {
      return { dryRun: true, requiredFees, result: dry?.result ?? null };
    }
    if (dryResultOk === false) {
      throw new ExecutorError(`REFUSED: dry run for op ${p.opId} did not accept; not submitting. See ledger.`);
    }

    // 2. Record SUBMIT intent BEFORE submitting, so an interrupted run is reconcilable.
    await appendLedger(this.ledgerPath, {
      ts: new Date().toISOString(),
      opId: p.opId,
      phase: 'submitting',
      intent: p.intent,
      feeCeiling: ceiling,
      requiredFees,
    });

    const submit = await this.rpc('transactions.submit_manifest', {
      manifest: p.manifest,
      variables: p.variables ?? {},
      max_fee: ceiling,
      dry_run: false,
      signing_key_ids: [],
    });
    const txId = submit?.transaction_id;
    if (!txId) throw new ExecutorError(`op ${p.opId}: submit returned no transaction_id`);

    await appendLedger(this.ledgerPath, {
      ts: new Date().toISOString(),
      opId: p.opId,
      phase: 'submitted',
      transactionId: txId,
    });

    // 3. Wait for an authoritative result. Never blind-retry.
    const finalResult = await this.rpc('transactions.wait_result', { transaction_id: txId }, { timeoutMs: 180_000 });
    const outcome = summariseResult(finalResult);
    await appendLedger(this.ledgerPath, {
      ts: new Date().toISOString(),
      opId: p.opId,
      phase: 'final',
      transactionId: txId,
      status: outcome.status,
      actualFee: outcome.actualFee,
      epoch: outcome.epoch,
      uppedComponents: outcome.components,
      uppedResources: outcome.resources,
    });
    return { dryRun: false, transactionId: txId, requiredFees, outcome, raw: finalResult };
  }
}

function extractComponent(addr) {
  if (typeof addr === 'string') return addr.startsWith('component_') ? addr : undefined;
  if (addr && typeof addr === 'object' && typeof addr.Component === 'string') return addr.Component;
  return undefined;
}

/**
 * "Did the engine accept this?" from a dry-run's ExecuteResult.
 *
 * walletd dry-run returns `result` as an ExecuteResult: `{ events, fee_receipt,
 * result: { Accept | Reject | AcceptFeeRejectRest } }`.
 */
function extractOutcomeOk(executeResult) {
  // Dry-run wraps the FinalizeResult under `finalize`; a committed result has the
  // outcome directly under `result`. Accept either.
  const inner = executeResult?.finalize?.result ?? executeResult?.result;
  if (inner && typeof inner === 'object') {
    if ('Accept' in inner) return true;
    if ('Reject' in inner || 'AcceptFeeRejectRest' in inner) return false;
  }
  return undefined;
}

/**
 * Normalise a `transactions.wait_result`/`get_result` payload into a compact,
 * ledgerable outcome.
 *
 * Real v0.43 shape:
 *   { status: "Accepted" | "Rejected" | ...,
 *     transaction_id,
 *     result: {               // ExecuteResult
 *       fee_receipt: { total_fees_paid, total_fee_payment, ... },
 *       result: { Accept: { up_substates: [[substate_id, value], ...], down_substates } }
 *     } }
 */
export function summariseResult(res) {
  const out = { status: 'UNKNOWN', actualFee: null, epoch: null, components: [], resources: [], templates: [] };
  if (!res || typeof res !== 'object') return out;
  const exec = res.result ?? res; // ExecuteResult
  const status = res.status;
  const accept = exec?.result?.Accept;
  if (status === 'Accepted' || accept) out.status = 'COMMITTED';
  else if (status === 'Rejected' || exec?.result?.Reject || exec?.result?.AcceptFeeRejectRest) out.status = 'REJECTED';

  const fee = exec?.fee_receipt?.total_fees_paid;
  if (fee !== undefined) out.actualFee = fee;
  if (res.epoch !== undefined) out.epoch = res.epoch;

  const up = Array.isArray(accept?.up_substates) ? accept.up_substates : [];
  for (const pair of up) {
    const id = Array.isArray(pair) ? pair[0] : pair?.substate_id ?? pair;
    if (typeof id !== 'string') continue;
    if (id.startsWith('component_')) out.components.push(id);
    else if (id.startsWith('resource_')) out.resources.push(id);
    else if (id.startsWith('template_')) out.templates.push(id);
  }
  return out;
}
