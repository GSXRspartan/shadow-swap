// Durable wallet request flow against the REAL v0.45 walletd.
//
// VERIFIES the walletd half of the browser contract: the browser's
// `tari_createTransactionRequest` -> `tari_getTransactionRequest` -> submit/reject maps
// onto the daemon's `transaction_requests.create` / `.get` / `.list` / `.reject`.
//
// NO SUBMISSION. The request carries a READ-ONLY manifest (pool.fee_bps) marked dry_run,
// and it is REJECTED at the end, so no transaction is ever submitted regardless of shape.

import { WalletdExecutor } from './walletd.mjs';

const ex = new WalletdExecutor();
const ACCOUNT = (await ex.defaultAccount()).component;
const POOL = 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2';

// An unsigned transaction in the V1 shape the daemon itself stores (mirrored from a real
// `transaction_requests.list` entry). `pay_fee` 100000 micro-tTARI from the default
// account; the instruction is READ-ONLY. `dry_run` is true, so even an approve could not
// commit anything.
const UNSIGNED = {
  V1: {
    network: 38,
    max_epoch: 4_294_967_295,
    is_seal_signer_authorized: false,
    blobs: [],
    dry_run: true,
    fee_instructions: [
      { CallMethod: { args: [{ Literal: '1a000186a0' }], call: { Address: ACCOUNT }, method: 'pay_fee' } },
    ],
    inputs: [],
    instructions: [
      { CallMethod: { args: [], call: { Address: POOL }, method: 'fee_bps' } },
    ],
  },
};

const created = await ex.rpc('transaction_requests.create', {
  transaction: UNSIGNED,
  network: 'esmeralda',
  seal_signer: { Derived: { index: 0, key_branch: 'account' } },
}, { timeoutMs: 60_000 });
const requestId = created?.request_id ?? created?.requestId ?? created?.id;
console.log('CREATE -> keys=' + Object.keys(created ?? {}).join(',') + ' id=' + requestId);
if (requestId === undefined) {
  console.log('FULL CREATE REPLY:', JSON.stringify(created).slice(0, 800));
  process.exit(1);
}

const got = await ex.rpc('transaction_requests.get', { request_id: requestId }, { timeoutMs: 60_000 });
console.log('GET    -> status=' + (got?.request?.status ?? got?.status));

const listed = await ex.rpc('transaction_requests.list', { offset: 0, limit: 5 }, { timeoutMs: 60_000 });
const mine = (listed?.requests ?? []).find((r) => (r.request_id ?? r.id) === requestId);
console.log('LIST   -> found=' + (mine !== undefined) + ' status=' + (mine?.status ?? 'absent'));

await ex.rpc('transaction_requests.reject', { request_id: requestId }, { timeoutMs: 60_000 });
console.log('REJECT -> ok');

const after = await ex.rpc('transaction_requests.get', { request_id: requestId }, { timeoutMs: 60_000 });
console.log('GET AFTER REJECT -> status=' + (after?.request?.status ?? after?.status));

const listed2 = await ex.rpc('transaction_requests.list', { offset: 0, limit: 5 }, { timeoutMs: 60_000 });
const mine2 = (listed2?.requests ?? []).find((r) => (r.request_id ?? r.id) === requestId);
console.log('LIST AFTER REJECT -> status=' + (mine2?.status ?? 'absent'));

// A closed request must not accept a second decision.
try {
  await ex.rpc('transaction_requests.reject', { request_id: requestId }, { timeoutMs: 60_000 });
  console.log('DOUBLE REJECT -> ACCEPTED (duplicate-decision bug)');
} catch (e) {
  console.log('DOUBLE REJECT -> refused: ' + String(e.message).slice(0, 200));
}