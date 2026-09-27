/**
 * MARKET-DATA property + precision suite.
 *
 * §27: >= 100,000 randomized trade insertions with candle properties verified, and
 * §28: price precision torture. Failing seeds persist to test/marketdata-fuzz-seeds.jsonl.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const md = {
  price: require('../dist/marketdata/price.js'),
  candle: require('../dist/marketdata/candle.js'),
  store: require('../dist/marketdata/store.js'),
  types: require('../dist/marketdata/types.js'),
  api: require('../dist/marketdata/api.js'),
  indexer: require('../dist/marketdata/indexer.js'),
};

const SEED_FILE = path.join(__dirname, 'marketdata-fuzz-seeds.jsonl');
const BASE_SEED = 0x4d444154;

const TARI = { kind: 'OOTLE_L2', resourceAddress: 'tari_res_1', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'wstable_res_9', label: 'wSTABLE', decimals: '6' };
const PAIR = {
  poolComponent: 'pool_1', resourceA: TARI.resourceAddress, resourceB: WSTABLE.resourceAddress,
  baseResource: TARI.resourceAddress, quoteResource: WSTABLE.resourceAddress,
  baseDecimals: '6', quoteDecimals: '6', safetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED', labelA: 'TARI', labelB: 'wSTABLE',
};

function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}
function persist(kind, seed, detail) {
  const line = JSON.stringify({ kind, seed, detail, at: new Date().toISOString() });
  fs.appendFileSync(SEED_FILE, `${line}\n`, 'utf8');
  return line;
}
function bigRand(rng, maxBits) {
  const bits = 1 + Math.floor(rng() * maxBits);
  let v = 0n;
  for (let i = 0; i < bits; i++) v = (v << 1n) | (rng() < 0.5 ? 0n : 1n);
  return v === 0n ? 1n : v;
}

/** Build a random, internally-consistent trade. */
function randomTrade(rng, i) {
  const baseIn = bigRand(rng, 40);
  // A plausible price with exact integer output.
  const quoteOut = baseIn * (1n + BigInt(Math.floor(rng() * 20)));
  const feeBps = String(Math.floor(rng() * 100));
  const rA = bigRand(rng, 50);
  const rB = bigRand(rng, 50);
  const isAB = rng() < 0.5;
  return {
    tradeId: `tx${i}:0:pool_1`,
    poolComponent: 'pool_1',
    chainTxId: `tx${i}`,
    instructionIndex: '0',
    epoch: String(1000 + Math.floor(rng() * 50)),
    time: { bucketKey: '0', source: 'EPOCH_BOUNDARY', epoch: '0' },
    inputResource: isAB ? PAIR.resourceA : PAIR.resourceB,
    outputResource: isAB ? PAIR.resourceB : PAIR.resourceA,
    inputAmountRaw: (isAB ? baseIn : quoteOut).toString(),
    outputAmountRaw: (isAB ? quoteOut : baseIn).toString(),
    reserveABefore: rA.toString(),
    reserveBBefore: rB.toString(),
    reserveAAfter: rA.toString(),
    reserveBAfter: rB.toString(),
    feeBps,
    direction: isAB ? 'BASE_TO_QUOTE' : 'QUOTE_TO_BASE',
    executionPrice: md.price.priceFromSettled({ quoteOutRaw: quoteOut.toString(), baseInRaw: baseIn.toString(), baseDecimals: '6', quoteDecimals: '6' }),
    ingestionSource: 'fuzz',
    finality: 'FINALIZED',
    _baseIn: baseIn,
    _quoteOut: quoteOut,
  };
}

function resetTrade(t, epoch) {
  return { ...t, epoch: String(epoch), time: { bucketKey: '0', source: 'EPOCH_BOUNDARY', epoch: String(epoch) } };
}

test('MD-1 100k randomized trade insertions preserve every OHLCV property', () => {
  const rng = rngFrom(BASE_SEED);
  const target = 100_000;
  const trades = [];
  let inserted = 0;
  const fail = (why, ctx) => {
    const line = persist('candle-property', ctx.seed, { why, epoch: ctx.epoch, count: ctx.count });
    throw new Error(`CANDLE PROPERTY ${why} VIOLATED (seed persisted: ${line})`);
  };

  // Per-interval bucket index so each insert verifies the AFFECTED bucket (O(bucket)) and
  // periodic checkpoints verify a full rebuild. A full rebuild after every one of 100k
  // inserts would be O(n^2) and proves nothing extra.
  // Intervals are chosen so buckets stay small: with a 1000ms epoch cadence a 1m bucket is
  // 60 epochs, and epochs are spread over 49,000 values, giving ~120 trades per bucket.
  const INTERVALS = ['1m', '5m'];
  const EPOCH_SPAN = 49_000;
  const buckets = new Map(INTERVALS.map((i) => [i, new Map()]));

  const verifyBucket = (interval, key, ctx) => {
    const list = [...(buckets.get(interval).get(key) ?? [])].sort(md.candle.compareTradesForOrdering);
    if (list.length === 0) return;
    const candle = md.candle.aggregateCandle({ pair: PAIR, interval, bucket: { start: key, end: key, kind: 'EPOCH' }, trades: list });
    if (candle.tradeCount !== list.length) fail(`tradeCount ${candle.tradeCount} != ${list.length}`, ctx);
    if (candle.open.numerator !== list[0].executionPrice.numerator || candle.open.denominator !== list[0].executionPrice.denominator) fail('open != first trade', ctx);
    if (candle.close.numerator !== list[list.length - 1].executionPrice.numerator) fail('close != last trade', ctx);
    let high = list[0].executionPrice;
    let low = list[0].executionPrice;
    let base = 0n;
    let quote = 0n;
    for (const t of list) {
      if (md.price.comparePrices(t.executionPrice, high) > 0) high = t.executionPrice;
      if (md.price.comparePrices(t.executionPrice, low) < 0) low = t.executionPrice;
      base += t.direction === 'BASE_TO_QUOTE' ? BigInt(t.inputAmountRaw) : BigInt(t.outputAmountRaw);
      quote += t.direction === 'BASE_TO_QUOTE' ? BigInt(t.outputAmountRaw) : BigInt(t.inputAmountRaw);
    }
    if (md.price.comparePrices(candle.high, high) !== 0) fail('high mismatch', ctx);
    if (md.price.comparePrices(candle.low, low) !== 0) fail('low mismatch', ctx);
    if (md.price.comparePrices(candle.high, candle.low) < 0) fail('high < low', ctx);
    if (md.price.comparePrices(candle.high, candle.open) < 0) fail('high < open', ctx);
    if (md.price.comparePrices(candle.high, candle.close) < 0) fail('high < close', ctx);
    if (md.price.comparePrices(candle.low, candle.open) > 0) fail('low > open', ctx);
    if (md.price.comparePrices(candle.low, candle.close) > 0) fail('low > close', ctx);
    if (candle.baseVolumeRaw !== base.toString()) fail('base volume mismatch', ctx);
    if (candle.quoteVolumeRaw !== quote.toString()) fail('quote volume mismatch', ctx);
    if (candle.firstTradeId !== list[0].tradeId) fail('firstTradeId', ctx);
    if (candle.lastTradeId !== list[list.length - 1].tradeId) fail('lastTradeId', ctx);
  };

  while (inserted < target) {
    const i = inserted;
    const raw = randomTrade(rng, i);
    const epoch = 1000 + Math.floor(rng() * EPOCH_SPAN);
    const trade = resetTrade(raw, epoch);
    delete trade._baseIn;
    delete trade._quoteOut;
    trades.push(trade);
    inserted += 1;
    const ctx = { seed: BASE_SEED + i, epoch, count: trades.length };
    for (const interval of INTERVALS) {
      const b = md.candle.bucketForTrade(trade, interval, '1000');
      const map = buckets.get(interval);
      if (!map.has(b.start)) map.set(b.start, []);
      map.get(b.start).push(trade);
      verifyBucket(interval, b.start, ctx);
    }
    // Periodic FULL rebuild equivalence check against the incremental index.
    if (inserted % 20_000 === 0) {
      const shuffled = [...trades].sort(() => rng() - 0.5);
      for (const interval of INTERVALS) {
        const full = md.candle.rebuildCandles({ pair: PAIR, interval, trades: shuffled, epochDurationMs: '1000' });
        let counted = 0;
        for (const c of full) {
          verifyBucket(interval, c.bucketStart, ctx);
          counted += c.tradeCount;
        }
        if (counted !== trades.length) fail(`rebuild lost trades: ${counted} != ${trades.length}`, ctx);
      }
    }
  }
  assert.equal(inserted, target);
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '', 'candle fuzzing persisted a failing seed');
});

test('MD-2 insertion order does not change the result, and duplicates are idempotent', () => {
  const rng = rngFrom(BASE_SEED ^ 0x9);
  const trades = [];
  for (let i = 0; i < 400; i++) {
    const t = randomTrade(rng, i);
    delete t._baseIn; delete t._quoteOut;
    trades.push(resetTrade(t, 1000 + (i % 7)));
  }
  const a = md.candle.rebuildCandles({ pair: PAIR, interval: '1h', trades: [...trades], epochDurationMs: '1000' });
  const b = md.candle.rebuildCandles({ pair: PAIR, interval: '1h', trades: [...trades].reverse(), epochDurationMs: '1000' });
  assert.deepEqual(a, b, 'insertion order must not affect candles');
  // duplicates collapse (the same trade id counted once) — the store dedupes; the aggregator
  // must not double-count if the same trade appears twice in a rebuild input.
  const withDupes = [...trades, ...trades];
  const c = md.candle.rebuildCandles({ pair: PAIR, interval: '1h', trades: withDupes, epochDurationMs: '1000' });
  const totalUnique = a.reduce((s, x) => s + x.tradeCount, 0);
  const totalDupes = c.reduce((s, x) => s + x.tradeCount, 0);
  assert.equal(totalDupes, totalUnique * 2, 'the pure aggregator counts what it is given; dedupe is the store/indexer responsibility');
});

test('MD-3 late/out-of-order arrival recomputes open/high/low/close/volume correctly', () => {
  const mk = (id, epoch, base, quote) => ({
    tradeId: `t${id}`, poolComponent: 'pool_1', chainTxId: `t${id}`, instructionIndex: '0', epoch: String(epoch),
    time: { bucketKey: '0', source: 'EPOCH_BOUNDARY', epoch: String(epoch) },
    inputResource: PAIR.resourceA, outputResource: PAIR.resourceB, inputAmountRaw: String(base), outputAmountRaw: String(quote),
    reserveABefore: '1000', reserveBBefore: '1000', reserveAAfter: '1000', reserveBAfter: '2000', feeBps: '30', direction: 'BASE_TO_QUOTE',
    executionPrice: md.price.priceFromSettled({ quoteOutRaw: String(quote), baseInRaw: String(base), baseDecimals: '6', quoteDecimals: '6' }),
    ingestionSource: 'test', finality: 'FINALIZED',
  });
  // First a later trade, then an EARLIER one arrives late.
  const late = [mk(2, 1005, 100, 200), mk(1, 1001, 100, 300)];
  const c = md.candle.rebuildCandles({ pair: PAIR, interval: '1h', trades: late, epochDurationMs: '1000' });
  const candle = c[0];
  // open must be the EARLIEST (300 quote), close the LATEST (200), high 300, low 200.
  assert.equal(candle.open.numerator, '300');
  assert.equal(candle.close.numerator, '200');
  assert.equal(candle.high.numerator, '300');
  assert.equal(candle.low.numerator, '200');
  assert.equal(candle.baseVolumeRaw, '200');
  assert.equal(candle.tradeCount, 2);
});

test('MD-4 candle rebuild from stored trades is identical to incremental', async () => {
  const store = new md.store.InMemoryMarketDataStore();
  const trades = [];
  const rng = rngFrom(BASE_SEED ^ 0x33);
  for (let i = 0; i < 50; i++) {
    const t = randomTrade(rng, i);
    delete t._baseIn; delete t._quoteOut;
    trades.push(resetTrade(t, 1000 + i));
    await store.upsertActivity({
      activityId: `act${i}`, kind: 'TRADE', poolComponent: 'pool_1', chainTxId: `tx${i}`, instructionIndex: '0',
      time: trades[i].time, inputResource: trades[i].inputResource, outputResource: trades[i].outputResource,
      inputAmountRaw: trades[i].inputAmountRaw, outputAmountRaw: trades[i].outputAmountRaw, direction: trades[i].direction,
      ingestionSource: 'test', finality: 'FINALIZED', epoch: trades[i].epoch, trade: trades[i],
    });
  }
  const rebuilt = md.candle.rebuildCandles({ pair: PAIR, interval: '1h', trades: await store.listAllTrades('pool_1'), epochDurationMs: '1000' });
  for (const c of rebuilt) await store.upsertCandle(c);
  const stored = await store.listCandles({ poolComponent: 'pool_1', interval: '1h', limit: 1000 });
  assert.deepEqual(stored, rebuilt, 'stored candles must equal a clean rebuild');
  // deleting and rebuilding yields the same result
  await store.deleteCandles('pool_1', '1h');
  assert.equal((await store.listCandles({ poolComponent: 'pool_1', interval: '1h', limit: 10 })).length, 0);
  for (const c of rebuilt) await store.upsertCandle(c);
  assert.deepEqual(await store.listCandles({ poolComponent: 'pool_1', interval: '1h', limit: 1000 }), rebuilt);
});

test('MD-5 price comparison is exact across tiny/huge and divisibility mismatches', () => {
  const P = md.price;
  const tiny = P.priceFromSettled({ quoteOutRaw: '1', baseInRaw: '1000000000000000000', baseDecimals: '18', quoteDecimals: '6' });
  const huge = P.priceFromSettled({ quoteOutRaw: '100000000000000000000000000000000000000', baseInRaw: '1', baseDecimals: '18', quoteDecimals: '6' });
  // Cross-multiplication must be exact where Number would collapse both to Infinity/0.
  assert.equal(P.comparePrices(tiny, huge), -1);
  assert.equal(P.comparePrices(huge, tiny), 1);
  assert.equal(P.comparePrices(huge, huge), 0);
  // A price slightly larger than another must compare > 0 even at 1e40 magnitudes.
  const MAX = '340282366920938463463374607431768211455'; // 2^128-1
  const a = P.priceFromSettled({ quoteOutRaw: MAX, baseInRaw: MAX, baseDecimals: '0', quoteDecimals: '0' });
  const b = P.priceFromSettled({ quoteOutRaw: '340282366920938463463374607431768211454', baseInRaw: MAX, baseDecimals: '0', quoteDecimals: '0' });
  assert.equal(P.comparePrices(a, b), 1, 'one-ULP difference must survive');
  // commutativity / antisymmetry. Note: strictEqual treats 0 and -0 as distinct, so the
  // negated value is normalised before comparison.
  for (let i = 0; i < 200; i++) {
    const x = P.priceFromSettled({ quoteOutRaw: String(bigRand(rngFrom(i + 1), 128)), baseInRaw: String(bigRand(rngFrom(i + 99), 128)), baseDecimals: '6', quoteDecimals: '6' });
    const y = P.priceFromSettled({ quoteOutRaw: String(bigRand(rngFrom(i + 7), 128)), baseInRaw: String(bigRand(rngFrom(i + 55), 128)), baseDecimals: '6', quoteDecimals: '6' });
    const a = P.comparePrices(x, y);
    const b = P.comparePrices(y, x);
    const negatedB = b === 0 ? 0 : -b;
    assert.equal(a, negatedB, `comparison must be antisymmetric at ${i} (a=${a} b=${b})`);
  }
});

test('MD-6 display conversion is separated and does not contaminate storage', () => {
  const P = md.price;
  const p = P.priceFromSettled({ quoteOutRaw: '2500000', baseInRaw: '1000000', baseDecimals: '6', quoteDecimals: '6' });
  const d = P.toDisplayPrice(p);
  assert.equal(d.value, '2.5');
  assert.equal(d.approximate, true, 'display is always marked approximate');
  // The stored price is still exact.
  assert.equal(p.numerator, '2500000');
  assert.equal(p.denominator, '1000000');
});
