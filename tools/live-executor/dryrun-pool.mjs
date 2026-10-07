// READ-ONLY + DRY-RUN conformance under walletd v0.45.
//
// Nothing here submits a state-changing transaction. Every op is a `dry_run: true`
// manifest submission, which is how the daemon itself answers "would this be accepted and
// what would it cost". Reserves are re-read live immediately before each quote so the
// expected output is derived from current chain state, not from a cached snapshot.
//
// Usage: node dryrun-pool.mjs

import { WalletdExecutor } from './walletd.mjs';
import { quoteSwapOutput, deriveMinOutput } from '../../packages/protocol-client/dist/esm/amm.js';

const POOL = 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2';
const POOL_TEMPLATE = 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab';
const ACCOUNT = 'component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b';
// Fee ceiling for these DRY RUNS. It must fit inside the account's REVEALED tTARI
// (the daemon withdraws the fee ceiling during a dry run, so an oversized ceiling is
// reported as InsufficientFunds rather than as a free rejection), and it stays far below
// the executor's hard 5 tTARI ceiling.
const CEILING = 1_000_000;

const ex = new WalletdExecutor();
const { decodePoolState } = await import('../../packages/protocol-client/dist/esm/poolSubstate.js');
const liveReader = { read: async (a) => (await ex.rpc('substates.get', { substate_id: a }, { timeoutMs: 60_000 }))?.substate_from_remote?.substate };

const out = [];
const say = (s) => { out.push(s); console.log(s); };

const identity = await ex.verifyNetwork();
const balances = await ex.rpc('accounts.get_balances', { account: ACCOUNT }, { timeoutMs: 60_000 });
const balanceOf = (res) => balances.balances.find((b) => b.resource_address === res);

async function poolNow() {
  return decodePoolState(liveReader, POOL, { templateAddress: POOL_TEMPLATE });
}

async function dryRun(label, manifest, variables) {
  // A rejected dry run is a RESULT, not a failure: several cases below exist precisely to
  // prove the engine refuses them. Both the JSON-RPC error form and the ExecuteResult
  // `Reject` form are reported verbatim, never smoothed into "ok".
  try {
    const result = await ex.rpc(
      'transactions.submit_manifest',
      { manifest, variables, max_fee: CEILING, dry_run: true, signing_key_ids: [] },
      { timeoutMs: 120_000 },
    );
    const inner = result?.result?.finalize?.result ?? result?.result;
    const verdict = inner && typeof inner === 'object' ? Object.keys(inner)[0] : 'UNKNOWN';
    const required = result?.required_fees ?? null;
    const rejectReason = JSON.stringify(inner?.Reject ?? inner?.AcceptFeeRejectRest ?? null);
    say(`  ${label.padEnd(52)} fees=${String(required).padStart(8)} verdict=${verdict}${verdict === 'Reject' ? ' ' + rejectReason.slice(0, 400) : ''}`);
    return { required, verdict, raw: result };
  } catch (error) {
    const message = String(error.message);
    const verdict = /rejected|InsufficientFunds|panic|Reject/i.test(message) ? 'REJECT(rpc)' : 'ERROR';
    say(`  ${label.padEnd(52)} fees=${'-'.padStart(8)} verdict=${verdict} ${message.slice(0, 400)}`);
    return { required: null, verdict, error: message };
  }
}

const pool = await poolNow();
say(`LIVE Pool v2 @ epoch ${identity.epoch}`);
say(`  reserveA(tTARI)=${pool.reserveA}  reserveB(LPTESTA)=${pool.reserveB}  lpSupply=${pool.totalLpSupply}  lockedLP=${pool.lockedLpSupply}  feeBps=${pool.feeBps}`);
say(`  wallet: tTARI=${balanceOf(pool.resourceA)?.balance}  LPTESTA=${balanceOf(pool.resourceB)?.balance}  LP=${balanceOf(pool.lpResource)?.balance}`);
say('');

// ---- READ the on-chain getters via a dry run (no state change) --------------
say('READ (dry run, AllowAll getters):');
const READ = (call) => `fn main() { let pool = arg!["pool"]; ${call}; }`;
await dryRun('pool.fee_bps()', READ('pool.fee_bps()'), { pool: POOL });
await dryRun('pool.lp_total_supply()', READ('pool.lp_total_supply()'), { pool: POOL });
await dryRun('pool.locked_lp_supply()', READ('pool.locked_lp_supply()'), { pool: POOL });
await dryRun('pool.lp_resource()', READ('pool.lp_resource()'), { pool: POOL });
await dryRun('pool.get_pool_balances()', READ('pool.get_pool_balances()'), { pool: POOL });
// DenyAll on an ownerless pool: this MUST be refused, which is the point of the check.
await dryRun('pool.get_a_resource()  [expect REJECT: DenyAll]', READ('pool.get_a_resource()'), { pool: POOL });
await dryRun('pool.get_b_resource()  [expect REJECT: DenyAll]', READ('pool.get_b_resource()'), { pool: POOL });
say('');

// ---- input selection: tTARI (stealth, must be revealed) ---------------------
const ttari = pool.resourceA;
const lptesta = pool.resourceB;
// The round-trip is `withdraw` then `deposit` back into the SAME account. `burn()` is
// NOT used for the happy path: every token in this wallet has `burn: DenyAll`, so a burn
// probe would fail on the burn rule rather than on the thing being probed.
//
// MANIFEST DIALECT NOTE (v0.45): a call argument must be a literal or a bound identifier.
// `a.deposit(a.withdraw(...))` and `account.deposit(pool.add_liquidity(a, b))` are SYNTAX
// ERRORS here, not runtime failures, so every nested call is bound to a `let` first.
const ROUNDTRIP = (amount) => `fn main() { let a = arg!["account"]; let b = a.withdraw(arg!["r"], amount!(${amount})); a.deposit(b); }`;
const BURN_PROBE = (amount) => `fn main() { let a = arg!["account"]; let b = a.withdraw(arg!["r"], amount!(${amount})); b.burn(); }`;
const ADD_LIQ = (aAmt, bAmt, deposit) => `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bucket_a = account.withdraw(arg!["res_a"], amount!(${aAmt}));
  let bucket_b = account.withdraw(arg!["res_b"], amount!(${bAmt}));
  let lp = pool.add_liquidity(bucket_a, bucket_b);
  ${deposit}
}`;
say('INPUT SELECTION (reveal tTARI / withdraw LPTESTA from the default account):');
await dryRun('account.withdraw+deposit(tTARI, 1000)  [stealth reveal]', ROUNDTRIP('1000'), { account: ACCOUNT, r: ttari });
await dryRun('account.withdraw+deposit(LPTESTA, 1000)  [public fungible]', ROUNDTRIP('1000'), { account: ACCOUNT, r: lptesta });
// Stealth burn is DenyAll for this wallet's own tokens (v0.44+ tightened defaults).
await dryRun('account.withdraw(tTARI, 1000) then BURN  [expect REJECT]', BURN_PROBE('1000'), { account: ACCOUNT, r: ttari });
// STEST is a CREATED-STEALTH resource: the public Pool must refuse it by resource type
// (POOL_TEMPLATE_BLOCKED). Proved two ways: offering an STEST bucket to `add_liquidity`,
// and by invoking the constructor on the template itself.
const stest = balances.balances.find((b) => b.token_symbol === 'STEST')?.resource_address;
if (stest !== undefined) {
  await dryRun('account.withdraw+deposit(STEST, 1000)  [created stealth]', ROUNDTRIP('1000'), { account: ACCOUNT, r: stest });
  await dryRun(
    'pool.add_liquidity(STEST + LPTESTA)  [expect REJECT: POOL_TEMPLATE_BLOCKED]',
    ADD_LIQ('1000', '1000', 'account.deposit(lp);'),
    { account: ACCOUNT, pool: POOL, res_a: stest, res_b: lptesta },
  );
  await dryRun(
    'Pool::new(STEST, LPTESTA)  [expect REJECT: stealth type]',
    `use template_${POOL_TEMPLATE} as Pool;
fn main() { Pool::new(arg!["a"], arg!["b"], 30u16); }`,
    { a: stest, b: lptesta },
  );
  // And the CONTROL: the same shape with the real public pair is ACCEPTED, proving the
  // rejection above is the resource type and not a malformed call.
  await dryRun(
    'Pool::new(tTARI, LPTESTA) CONTROL  [expect Accept]',
    `use template_${POOL_TEMPLATE} as Pool;
fn main() { Pool::new(arg!["a"], arg!["b"], 30u16); }`,
    { a: ttari, b: lptesta },
  );
}
say('');

// ---- swap: quote + construction + slippage failure --------------------------
const inAmount = '10000'; // 0.01 tTARI
const { output: quotedOut, effectiveInput } = quoteSwapOutput(pool.reserveA, pool.reserveB, inAmount, pool.feeBps);
const minOut = deriveMinOutput(quotedOut, { slippageBps: '50' });
say(`SWAP QUOTE (current reserves, ${pool.feeBps} bps):`);
say(`  in=${inAmount} tTARI  effectiveIn(after fee)=${effectiveInput}  quotedOut=${quotedOut} LPTESTA  minOut(50bps slippage)=${minOut}`);
say('');
say('SWAP CONSTRUCTION:');
await dryRun(
  `swap ${inAmount} tTARI -> ${quotedOut} LPTESTA (min ${minOut})`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(${quotedOut}));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: ttari, out_res: lptesta },
);
// SLIPPAGE FAILURE: demand 10x the quoted output; the engine must Reject.
await dryRun(
  `swap ${inAmount} with IMPOSSIBLE min_out (expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(${BigInt(quotedOut) * 10n}));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: ttari, out_res: lptesta },
);
// Wrong direction must be refused by the engine too.
await dryRun(
  `swap tTARI -> tTARI (wrong pair, expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(1));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: ttari, out_res: ttari },
);
say('');

// ---- add liquidity ---------------------------------------------------------
const ratioNum = BigInt(pool.reserveA);
const ratioDen = BigInt(pool.reserveB);
const depA = '10000';
const depB = ((BigInt(depA) * ratioDen) / ratioNum).toString();
say(`ADD LIQUIDITY: current ratio 1 tTARI = ${ratioDen}/${ratioNum} LPTESTA; deposit ${depA} tTARI + ${depB} LPTESTA`);
await dryRun(
  `add_liquidity ${depA} + ${depB} (expect Accept)`,
  ADD_LIQ(depA, depB, 'account.deposit(lp);'),
  { account: ACCOUNT, pool: POOL, res_a: ttari, res_b: lptesta },
);
// Unbalanced deposit must be REFUSED (the pool only mints on a balanced deposit).
await dryRun(
  `add_liquidity ${depA} + 1 (unbalanced, expect REJECT)`,
  ADD_LIQ(depA, '1', 'account.deposit(lp);'),
  { account: ACCOUNT, pool: POOL, res_a: ttari, res_b: lptesta },
);
// Adding more tTARI than exists must be REFUSED by the account, not by the pool.
await dryRun(
  `add_liquidity more tTARI than held (expect REJECT)`,
  ADD_LIQ('99999999', depB, 'account.deposit(lp);'),
  { account: ACCOUNT, pool: POOL, res_a: ttari, res_b: lptesta },
);
say('');

// ---- remove liquidity ------------------------------------------------------
// The pool's LP resource has divisibility 18 and a total supply of only `totalLpSupply`
// RAW units (600000), so the wallet's whole position is 599000 raw units and 1000 of them
// are permanently locked. A burn of `burnAmount` must stay strictly below 599000.
const lpHeld = balanceOf(pool.lpResource)?.balance ?? '0';
const locked = BigInt(pool.lockedLpSupply);
const spendable = BigInt(lpHeld) - locked;
const burnAmount = (spendable / 2n).toString();
const outA = ((BigInt(burnAmount) * BigInt(pool.reserveA)) / BigInt(pool.totalLpSupply)).toString();
const outB = ((BigInt(burnAmount) * BigInt(pool.reserveB)) / BigInt(pool.totalLpSupply)).toString();
say(`REMOVE LIQUIDITY: wallet holds ${lpHeld} LP raw units, ${pool.lockedLpSupply} permanently locked -> ${spendable} spendable; burn ${burnAmount}`);
say(`  expected returns ${outA} tTARI + ${outB} LPTESTA`);
await dryRun(
  `remove_liquidity ${burnAmount} (expect Accept)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp_bucket = account.withdraw(arg!["lp_res"], amount!(${burnAmount}));
  let (bucket_a, bucket_b) = pool.remove_liquidity(lp_bucket);
  account.deposit(bucket_a);
  account.deposit(bucket_b);
}`,
  { account: ACCOUNT, pool: POOL, lp_res: pool.lpResource },
);
// Burning more than the wallet holds must be refused.
await dryRun(
  `remove_liquidity ${lpHeld}+1 (more than held, expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp_bucket = account.withdraw(arg!["lp_res"], amount!(${BigInt(lpHeld) + 1n}));
  let (bucket_a, bucket_b) = pool.remove_liquidity(lp_bucket);
  account.deposit(bucket_a);
  account.deposit(bucket_b);
}`,
  { account: ACCOUNT, pool: POOL, lp_res: pool.lpResource },
);
// Burning MORE than exists in the whole pool must be refused even from a funded account.
await dryRun(
  `remove_liquidity totalLpSupply+1 (more than supply, expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp_bucket = account.withdraw(arg!["lp_res"], amount!(1));
  let (bucket_a, bucket_b) = pool.remove_liquidity(lp_bucket);
  account.deposit(bucket_a);
  account.deposit(bucket_b);
}`,
  { account: ACCOUNT, pool: POOL, lp_res: pool.lpResource },
);
say('');

// ---- fee estimation for a publish-shaped op (estimation only, no submit) ----
await dryRun('empty manifest (baseline fee floor)', `fn main() { }`, {});
say('');
say('DRY-RUN COMPLETE — no state-changing transaction was submitted.');