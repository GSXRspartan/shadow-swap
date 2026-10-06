#!/usr/bin/env node
// Guarded Esmeralda testnet AMM operations CLI.
//
// A thin, reviewed command surface over WalletdExecutor. Every state-changing
// command DRY-RUNS first (fee estimate + acceptance), enforces a per-transaction
// fee ceiling, records to a durable ledger, submits ONCE, and reconciles to a
// committed result. It talks only to a loopback wallet daemon on the esmeralda
// testnet. Test tokens are public fungibles minted by the published
// `TestCoinFactory`; the pool is the published `Pool` template.
//
// Usage:
//   node cli.mjs create-token  <SYMBOL> [--supply N] [--div 6]
//   node cli.mjs create-pool   --a <resA> --b <resB> [--fee-bps 30]
//   node cli.mjs add-liquidity --pool <c> --res-a <r> --amt-a N --res-b <r> --amt-b N
//   node cli.mjs swap          --pool <c> --in <res> --amt N --out <res> --min-out N
//   node cli.mjs remove-liquidity --pool <c> --lp <res> --amt N
//   node cli.mjs read-pool     --pool <c>
//   node cli.mjs account
// Global flags: --max-fee <micro> (<=5_000_000), --dry-run, --url <loopback>, --json
//
// Testnet only. No mainnet. No key export. No L1. No cross-chain.

import { WalletdExecutor } from './walletd.mjs';

const TEST_COIN_FACTORY = '93aa539e3a59bd9e45db35f88ec733a40d493223b5892d8724fbfe198831b692';
const POOL_TEMPLATE = 'ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function req(flags, name) {
  if (flags[name] === undefined || flags[name] === true) {
    throw new Error(`missing required --${name}`);
  }
  return String(flags[name]);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const json = Boolean(flags.json);
  const dryRunOnly = Boolean(flags['dry-run']);
  const maxFeeMicro = flags['max-fee'] !== undefined && flags['max-fee'] !== true ? Number(flags['max-fee']) : undefined;
  const ex = new WalletdExecutor({ url: flags.url && flags.url !== true ? String(flags.url) : undefined });
  const acct = await ex.defaultAccount();

  const emit = (obj) => console.log(json ? JSON.stringify(obj, null, 2) : render(command, obj));

  switch (command) {
    case 'account': {
      const identity = await ex.verifyNetwork();
      emit({ account: acct, network: identity });
      break;
    }
    case 'create-token': {
      const symbol = positional[1];
      if (!symbol) throw new Error('usage: create-token <SYMBOL>');
      const supply = flags.supply && flags.supply !== true ? String(flags.supply) : '1000000000';
      const div = flags.div && flags.div !== true ? Number(flags.div) : 6;
      const manifest = `use template_${TEST_COIN_FACTORY} as TestCoinFactory;
fn main() {
  let account = arg!["account"];
  let coins = TestCoinFactory::create_public_fungible_test_coin("${symbol}", ${div}u8, amount!(${supply}));
  account.deposit(coins);
}`;
      const r = await ex.submitManifest({
        opId: `create-token-${symbol}`,
        intent: `create public fungible ${symbol} (supply ${supply}, div ${div})`,
        manifest,
        variables: { account: acct.component },
        maxFeeMicro,
        dryRunOnly,
        meta: { symbol, supply, divisibility: div, template: 'TestCoinFactory' },
      });
      emit(r);
      break;
    }
    case 'create-pool': {
      const a = req(flags, 'a');
      const b = req(flags, 'b');
      const feeBps = flags['fee-bps'] && flags['fee-bps'] !== true ? Number(flags['fee-bps']) : 30;
      const manifest = `use template_${POOL_TEMPLATE} as Pool;
fn main() { Pool::new(arg!["a"], arg!["b"], ${feeBps}u16); }`;
      const r = await ex.submitManifest({
        opId: 'create-pool',
        intent: `instantiate Pool(${a},${b},${feeBps}bps)`,
        manifest,
        variables: { a, b },
        maxFeeMicro,
        dryRunOnly,
        meta: { template: POOL_TEMPLATE, a, b, feeBps },
      });
      emit(r);
      break;
    }
    case 'add-liquidity': {
      const pool = req(flags, 'pool');
      const resA = req(flags, 'res-a');
      const amtA = req(flags, 'amt-a');
      const resB = req(flags, 'res-b');
      const amtB = req(flags, 'amt-b');
      const manifest = `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bucket_a = account.withdraw(arg!["res_a"], amount!(${amtA}));
  let bucket_b = account.withdraw(arg!["res_b"], amount!(${amtB}));
  let lp = pool.add_liquidity(bucket_a, bucket_b);
  account.deposit(lp);
}`;
      const r = await ex.submitManifest({
        opId: 'add-liquidity',
        intent: `add liquidity ${amtA} + ${amtB}`,
        manifest,
        variables: { account: acct.component, pool, res_a: resA, res_b: resB },
        maxFeeMicro,
        dryRunOnly,
        meta: { pool, resA, amtA, resB, amtB },
      });
      emit(r);
      break;
    }
    case 'swap': {
      const pool = req(flags, 'pool');
      const inRes = req(flags, 'in');
      const amt = req(flags, 'amt');
      const outRes = req(flags, 'out');
      const minOut = req(flags, 'min-out');
      const manifest = `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let bin = account.withdraw(arg!["in_res"], amount!(${amt}));
  let bout = pool.swap(bin, arg!["out_res"], amount!(${minOut}));
  account.deposit(bout);
}`;
      const r = await ex.submitManifest({
        opId: 'swap',
        intent: `swap ${amt} ${inRes} -> ${outRes} (min ${minOut})`,
        manifest,
        variables: { account: acct.component, pool, in_res: inRes, out_res: outRes },
        maxFeeMicro,
        dryRunOnly,
        meta: { pool, inRes, amt, outRes, minOut },
      });
      emit(r);
      break;
    }
    case 'remove-liquidity': {
      const pool = req(flags, 'pool');
      const lp = req(flags, 'lp');
      const amt = req(flags, 'amt');
      const manifest = `fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp_bucket = account.withdraw(arg!["lp_res"], amount!(${amt}));
  let (bucket_a, bucket_b) = pool.remove_liquidity(lp_bucket);
  account.deposit(bucket_a);
  account.deposit(bucket_b);
}`;
      const r = await ex.submitManifest({
        opId: 'remove-liquidity',
        intent: `remove ${amt} LP`,
        manifest,
        variables: { account: acct.component, pool, lp_res: lp },
        maxFeeMicro,
        dryRunOnly,
        meta: { pool, lp, amt },
      });
      emit(r);
      break;
    }
    case 'read-pool': {
      const pool = req(flags, 'pool');
      // NOTE: get_a_resource/get_b_resource are DenyAll on the pool (not in the granted
      // method set), so an ownerless pool refuses them. The pair is read from
      // get_pool_balances (AllowAll), which returns both resources with their reserves.
      const manifest = `fn main() {
  let pool = arg!["pool"];
  pool.fee_bps();
  pool.lp_resource();
  pool.lp_total_supply();
  pool.locked_lp_supply();
  pool.get_pool_balances();
}`;
      const dry = await ex.rpc('transactions.submit_manifest', { manifest, variables: { pool }, max_fee: 100_000, dry_run: true, signing_key_ids: [] });
      const er = dry.result.finalize.execution_results;
      const names = ['fee_bps', 'lp_resource', 'lp_total_supply', 'locked_lp_supply', 'pool_balances'];
      const fields = {};
      er.forEach((r, i) => { fields[names[i] ?? `r${i}`] = decodeValue(r.indexed?.value); });
      emit({ pool, fields });
      break;
    }
    default:
      console.error('unknown command. See the header of cli.mjs for usage.');
      process.exit(2);
  }
}

/** Decode the manifest read-value CBOR shapes into plain JS where obvious. */
function decodeValue(v) {
  if (v && typeof v === 'object' && v['@cbor'] === 'tag' && v.tag === 131) {
    return 'resource_' + v.value?.hex;
  }
  if (v && typeof v === 'object' && v['@cbor'] === 'map') {
    const out = {};
    for (const [k, val] of v.entries ?? []) out[decodeValue(k)] = val;
    return out;
  }
  return v;
}

function render(command, obj) {
  if (obj.dryRun) return `DRY RUN ${command}: required_fees=${obj.requiredFees}`;
  if (obj.transactionId) {
    const o = obj.outcome ?? {};
    return `${command}: ${o.status} tx=${obj.transactionId} fee=${o.actualFee}` +
      (o.components?.length ? ` components=${o.components.join(',')}` : '') +
      (o.resources?.length ? ` resources=${o.resources.join(',')}` : '');
  }
  return JSON.stringify(obj);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
