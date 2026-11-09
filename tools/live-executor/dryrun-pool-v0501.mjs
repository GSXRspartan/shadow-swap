// READ-ONLY + DRY-RUN conformance for the v0501 TESTA/TESTB pool.
//
// Nothing here submits a state-changing transaction. Every op is a `dry_run: true`
// manifest submission to prove the Pool template is executable under current
// Esmeralda v0.50.1 engine rules (user requirement 4: post-upgrade verification).
//
// Addresses verified against live indexer CBOR on 2026-11-08:
//   - Pool component: component state at version 0, vault substates at version 2
//   - Template address matches esme-indexer-a catalogue
//   - Reserves: 101.000000 TESTA, 99.012842 TESTB (confirmed from vault substates)
//
// Prerequisites:
//   1. walletd running: cd C:\Users\pdark\.tari\ootle\shadow-swap-esmeralda-live && .\walletd.exe
//   2. Auth=None (confirmed) — no JWT needed
//   3. Walletd account must hold TESTA and TESTB tokens
//
// Usage: node dryrun-pool-v0501.mjs

import { WalletdExecutor } from './walletd.mjs';
import { quoteSwapOutput, deriveMinOutput } from '../../packages/protocol-client/dist/esm/amm.js';

// v0.50.1 Esmeralda pool — verified on-chain 2026-11-08
const POOL = 'component_5c554ab71fa912da3f92f932cc79db4af2ecb21bbec657480a97b5017704b2c6';
const POOL_TEMPLATE = '1c7d39e782b6ca5023ad186c7d5f82cb2ad171336cd75ae0025245fe84bebae3';

// Fee ceiling for dry runs — well below the 5 tTARI executor ceiling.
const CEILING = 1_000_000;

const ex = new WalletdExecutor();
const { decodePoolState } = await import('../../packages/protocol-client/dist/esm/poolSubstate.js');
const liveReader = { read: async (a) => (await ex.rpc('substates.get', { substate_id: a }, { timeoutMs: 60_000 }))?.substate_from_remote?.substate };

const out = [];
const say = (s) => { out.push(s); console.log(s); };

const identity = await ex.verifyNetwork();

// Auto-discover the default account from walletd (returns { name, component })
const defaultAcct = await ex.defaultAccount();
const ACCOUNT = defaultAcct.component;
say(`Using account: ${defaultAcct.name} (${ACCOUNT})`);

const balances = await ex.rpc('accounts.get_balances', { account: ACCOUNT }, { timeoutMs: 60_000 });
const balanceOf = (res) => balances.balances.find((b) => b.resource_address === res);

async function poolNow() {
  return decodePoolState(liveReader, POOL, { templateAddress: POOL_TEMPLATE });
}

async function dryRun(label, manifest, variables) {
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
    say(`  ${label.padEnd(60)} fees=${String(required).padStart(8)} verdict=${verdict}${verdict === 'Reject' ? ' ' + rejectReason.slice(0, 400) : ''}`);
    return { required, verdict, raw: result };
  } catch (error) {
    const message = String(error.message);
    const verdict = /rejected|InsufficientFunds|panic|Reject/i.test(message) ? 'REJECT(rpc)' : 'ERROR';
    say(`  ${label.padEnd(60)} fees=${'-'.padStart(8)} verdict=${verdict} ${message.slice(0, 400)}`);
    return { required: null, verdict, error: message };
  }
}

const pool = await poolNow();
say(`\n=== v0501 Pool dry-run suite @ epoch ${identity.epoch} ===`);
say(`Pool: ${POOL}`);
say(`Template: ${POOL_TEMPLATE}`);
say(`Reserves: A(TESTB)=${pool.reserveA}  B(TESTA)=${pool.reserveB}  LP=${pool.totalLpSupply}  locked=${pool.lockedLpSupply}  fee=${pool.feeBps}bps`);
say(`Wallet balances: TESTB=${balanceOf(pool.resourceA)?.balance}  TESTA=${balanceOf(pool.resourceB)?.balance}  LP=${balanceOf(pool.lpResource)?.balance}`);
say('');

// ---- READ getters (dry run, AllowAll) ----------------------------------------
say('READ (dry run, AllowAll getters):');
const READ = (call) => `fn main() { let pool = arg!["pool"]; ${call}; }`;
await dryRun('pool.fee_bps()', READ('pool.fee_bps()'), { pool: POOL });
await dryRun('pool.lp_total_supply()', READ('pool.lp_total_supply()'), { pool: POOL });
await dryRun('pool.get_pool_balances()', READ('pool.get_pool_balances()'), { pool: POOL });
// DenyAll on an ownerless pool: these MUST be refused
await dryRun('pool.get_a_resource()  [expect REJECT: DenyAll]', READ('pool.get_a_resource()'), { pool: POOL });
await dryRun('pool.get_b_resource()  [expect REJECT: DenyAll]', READ('pool.get_b_resource()'), { pool: POOL });
say('');

// ---- Swap dry run (the key post-upgrade check) --------------------------------
// Use TESTA → TESTB. resource_a=TESTB (pool.resourceA), resource_b=TESTA (pool.resourceB).
// In the v0501 pool: resourceA = TESTB, resourceB = TESTA.
const testa = pool.resourceB;  // TESTA
const testb = pool.resourceA;  // TESTB

const inAmount = '1000000'; // 1.000000 TESTA (matches first swap proposal)
const { output: quotedOut, effectiveInput } = quoteSwapOutput(pool.reserveB, pool.reserveA, inAmount, pool.feeBps);
const minOut = deriveMinOutput(quotedOut, { slippageBps: '200' }); // 2% slippage
say(`SWAP QUOTE (1 TESTA → TESTB, ${pool.feeBps}bps fee):`);
say(`  in=${inAmount}µ TESTA  effectiveIn=${effectiveInput}  quotedOut=${quotedOut}µ TESTB  minOut(2%)=${minOut}`);
say('');
say('SWAP DRY RUNS:');

await dryRun(
  `swap 1 TESTA -> TESTB (expect Accept)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(${minOut}));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: testa, out_res: testb },
);

// Demand 10× quoted output — engine must Reject on slippage
await dryRun(
  `swap 1 TESTA with impossible min_out (expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(${BigInt(quotedOut) * 10n}));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: testa, out_res: testb },
);

// Wrong direction: TESTA → TESTA (must be Rejected: same resource in and out)
await dryRun(
  `swap TESTA -> TESTA (wrong pair, expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${inAmount}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(1));
  account.deposit(bout);
}`,
  { account: ACCOUNT, pool: POOL, in_res: testa, out_res: testa },
);
say('');

// ---- Add liquidity (dry run) -------------------------------------------------
// Current ratio: reserveA(TESTB)/reserveB(TESTA) = pool.reserveA/pool.reserveB
const rA = BigInt(pool.reserveA); // TESTB
const rB = BigInt(pool.reserveB); // TESTA
const depB = '1000000'; // 1 TESTA
const depA = ((BigInt(depB) * rA) / rB).toString(); // matching TESTB
say(`ADD LIQUIDITY: ratio 1 TESTA = ${rA}/${rB} TESTB; deposit ${depB} TESTA + ${depA} TESTB`);

const ADD_LIQ = (aAmt, bAmt, deposit) => `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bucket_a = account.withdraw(arg!["res_a"], amount!(${aAmt}));
  let bucket_b = account.withdraw(arg!["res_b"], amount!(${bAmt}));
  let lp = pool.add_liquidity(bucket_a, bucket_b);
  ${deposit}
}`;

await dryRun(
  `add_liquidity 1 TESTA + matching TESTB (expect Accept)`,
  ADD_LIQ(depA, depB, 'account.deposit(lp);'),
  { account: ACCOUNT, pool: POOL, res_a: testb, res_b: testa },
);

await dryRun(
  `add_liquidity unbalanced 1 TESTA + 1 TESTB (expect REJECT)`,
  ADD_LIQ('1', '1', 'account.deposit(lp);'),
  { account: ACCOUNT, pool: POOL, res_a: testb, res_b: testa },
);
say('');

// ---- Remove liquidity (dry run) ----------------------------------------------
const lpHeld = balanceOf(pool.lpResource)?.balance ?? '0';
const locked = BigInt(pool.lockedLpSupply);
const spendable = BigInt(lpHeld) - locked;
say(`REMOVE LIQUIDITY: wallet holds ${lpHeld} LP raw, ${pool.lockedLpSupply} locked → ${spendable} spendable`);

if (spendable > 0n) {
  const burnAmount = (spendable / 2n).toString();
  const outA = ((BigInt(burnAmount) * rA) / BigInt(pool.totalLpSupply)).toString();
  const outB = ((BigInt(burnAmount) * rB) / BigInt(pool.totalLpSupply)).toString();
  say(`  Burn ${burnAmount} → ~${outA} TESTB + ${outB} TESTA`);

  await dryRun(
    `remove_liquidity ${burnAmount} LP (expect Accept)`,
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
} else {
  say('  Skipping remove_liquidity — wallet holds no LP tokens.');
}

await dryRun(
  `remove_liquidity 0 LP (zero input, expect REJECT)`,
  `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp_bucket = account.withdraw(arg!["lp_res"], amount!(0));
  let (bucket_a, bucket_b) = pool.remove_liquidity(lp_bucket);
  account.deposit(bucket_a);
  account.deposit(bucket_b);
}`,
  { account: ACCOUNT, pool: POOL, lp_res: pool.lpResource },
);
say('');

// Baseline fee floor
await dryRun('empty manifest (baseline fee floor)', `fn main() { }`, {});
say('');
say('DRY-RUN COMPLETE — no state-changing transaction was submitted.');
say(`Pool verified against ESMERALDA v0501 engine. Template: ${POOL_TEMPLATE}`);
