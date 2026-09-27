/**
 * Source-level security and policy scans.
 *
 * These read the real source files rather than the build, so they fail if a rule
 * is broken by an edit that happens to compile.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(appRoot, 'src');
const stylesRoot = path.join(srcRoot, 'styles');

function walk(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const sourceFiles = walk(srcRoot, ['.ts', '.tsx']);
const styleFiles = walk(stylesRoot, ['.css']);

test('xss: the app never injects raw HTML', () => {
  // Comments are excluded: the sanitiser's own doc comment names the API it
  // exists to prevent, and must not be mistaken for a use of it.
  const offenders = sourceFiles.filter((file) => {
    const code = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    return /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\(/.test(code);
  });
  assert.deepEqual(offenders.map((f) => path.relative(appRoot, f)), []);
});

test('xss: every href/src comes from the URL validator, never from raw data', () => {
  // External links must be plain anchors with a hard-coded https target.
  const appShell = fs.readFileSync(path.join(srcRoot, 'components', 'AppShell.tsx'), 'utf8');
  const hrefs = [...appShell.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    assert.match(href, /^\/|^(https?:\/\/|#)/, `unexpected href: ${href}`);
  }
  // NFT media may only come from the validating metadata loader, and must never
  // leak a referrer to a third-party host.
  for (const name of ['NftCard.tsx', 'NftDetailPanel.tsx']) {
    const text = fs.readFileSync(path.join(srcRoot, 'components', name), 'utf8');
    assert.match(text, /loadNftMetadata/, `${name} must source media through the validating metadata loader`);
    assert.match(text, /referrerPolicy="no-referrer"/, `${name} must not leak a referrer`);
    assert.match(text, /metadata\??\.image|loaded\.image/, `${name} must render only the loader-validated URL`);
  }
  // The sanitiser itself must be the only place a URL scheme is judged.
  const sanitiser = fs.readFileSync(path.join(srcRoot, 'lib', 'sanitize.ts'), 'utf8');
  assert.match(sanitiser, /ALLOWED_URL_PROTOCOLS/);
  assert.match(sanitiser, /javascript:/i, 'the validator must explicitly reject javascript: URLs');
});

test('secrets: no secret-bearing protocol field is read, logged, or rendered by the app', () => {
  const forbidden = [
    'preimageHex',
    'walletPreimageHex',
    'secretHex',
    'observedPreimage',
    'CrossChainSecretStore',
    'privateKey',
    'seedPhrase',
    'mnemonic',
  ];
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // A DETECTOR is not a USE. `errorMessage.ts` names secret-shaped patterns in
    // order to strip them, and `storage.ts` names forbidden persisted fields in
    // order to reject them. Both are the defence, not a leak.
    const relative = path.relative(appRoot, file).split(path.sep).join('/');
    const isDetector = /^src\/lib\/(errorMessage|storage)\.ts$/.test(relative);
    const codeLines = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    for (const field of forbidden) {
      if (isDetector) {
        // Permitted only on a regex-literal line or a quoted list entry, i.e.
        // inside a detection pattern.
        const offenders = codeLines
          .split('\n')
          .filter((line) => line.includes(field))
          .filter((line) => !/^\s*\/.*\/[gimsuy]*\s*[,;]?\s*$/.test(line))
          .filter((line) => !/^\s*['"][A-Za-z0-9_.-]+['"]\s*[,;]?\s*$/.test(line));
        assert.deepEqual(offenders, [], `${relative} must only reference ${field} inside a detection pattern`);
        continue;
      }
      const hit = codeLines.split('\n').find((line) => line.includes(field));
      assert.equal(hit, undefined, `${relative} must not reference ${field} in code: ${hit ?? ''}`);
    }
  }
});

test('secrets: the secret scrubber and storage validator exist and are strict', () => {
  // The two modules that are ALLOWED to name secret-shaped strings must actually
  // be doing the detecting.
  const scrubber = fs.readFileSync(path.join(srcRoot, 'lib', 'errorMessage.ts'), 'utf8');
  for (const shape of ['[A-Za-z]:\\', 'a-f0-9]{64,}', 'Authorization', 'Bearer', ':\\/\\/']) {
    assert.ok(scrubber.includes(shape), `the scrubber must recognise the "${shape}" shape`);
  }
  const storage = fs.readFileSync(path.join(srcRoot, 'lib', 'storage.ts'), 'utf8');
  assert.ok(storage.includes('FORBIDDEN_PERSISTED_FIELDS'), 'the storage validator must declare its forbidden field list');
  assert.ok(storage.includes('lastReadback'), 'the storage validator must exclude freshness from a restored record');
});

test('secrets: the app never logs to the console', () => {
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.split('\n').find((line) => /console\.(log|debug|info|warn|error|trace)/.test(line));
    assert.equal(hit, undefined, `${path.relative(appRoot, file)} must not log: ${hit ?? ''}`);
  }
});

test('boundary: no display-formatted price is fed into an execution input', () => {
  // Every execution input goes through the boundary funnel.
  const swap = fs.readFileSync(path.join(srcRoot, 'components', 'SwapCard.tsx'), 'utf8');
  const rawInputAssignments = [...swap.matchAll(/rawInputAmount:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  assert.ok(rawInputAssignments.length > 0);
  for (const value of rawInputAssignments) {
    assert.match(value, /asRawExecutionAmount\(/, `rawInputAmount must be funnelled through asRawExecutionAmount, got: ${value}`);
  }
  const liquidity = fs.readFileSync(path.join(srcRoot, 'components', 'LiquidityPanel.tsx'), 'utf8');
  for (const match of [...liquidity.matchAll(/rawAmount[AB]:\s*([^,\n]+)/g)].map((m) => m[1].trim())) {
    assert.match(match, /asRawExecutionAmount\(/, `liquidity amounts must be funnelled through asRawExecutionAmount, got: ${match}`);
  }
  for (const match of [...liquidity.matchAll(/rawLpAmount:\s*([^,\n]+)/g)].map((m) => m[1].trim())) {
    assert.match(match, /asRawExecutionAmount\(/, `lp amount must be funnelled through asRawExecutionAmount, got: ${match}`);
  }
});

test('boundary: the frontend does not reimplement AMM or route math', () => {
  const banned = [
    /reserveIn\s*\*\s*/,
    /effectiveInput\s*=/,
    /FEE_DENOMINATOR\s*-/,
    /SLIPPAGE_DENOMINATOR\s*-/,
    /\(\s*\w+\s*\*\s*\(?10000n/,
  ];
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith(path.join('test', 'x'))) continue;
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path.relative(appRoot, file)} must not reimplement constant-product math (${pattern})`);
    }
  }
  // The only sanctioned price division is delegated to the protocol-client.
  const chartData = fs.readFileSync(path.join(srcRoot, 'lib', 'chartData.ts'), 'utf8');
  assert.match(chartData, /toChartSeries/);
  assert.equal(/function toDisplayPrice/.test(chartData), false, 'display conversion is not reimplemented locally');
});

test('policy: mainnet is not configurable anywhere in the app', () => {
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(appRoot, file);
    // `looksLikeMainnet` / `BROWSER_PROVIDER_BLOCKER` are refusals, not options.
    if (relative.includes('networks.ts') || relative.includes('config.ts') || relative.includes('AppShell.tsx')) continue;
    const hit = text.split('\n').find((line) => /['"]mainnet['"]/.test(line));
    assert.equal(hit, undefined, `${relative} must not name mainnet as a value: ${hit ?? ''}`);
  }
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  assert.equal(/VITE_[A-Z_]*MAINNET/.test(config), false, 'there is no mainnet env var');
});

test('policy: the development fixtures cannot be enabled by a shipped flag', () => {
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  assert.match(config, /if \(wantsFixtures && !development\)/);
  assert.match(config, /if \(wantsDevProviders && !development\)/);
  const envSource = fs.readFileSync(path.join(srcRoot, 'services', 'envSource.ts'), 'utf8');
  assert.equal(/localStorage|127\.0\.0\.1/.test(envSource), false, 'no localhost default is baked in');
  const vite = fs.readFileSync(path.join(appRoot, 'vite.config.ts'), 'utf8');
  assert.equal(/127\.0\.0\.1/.test(vite), false, 'the build config has no hard-coded localhost');
});

test('policy: the real cross-chain submit gate is mirrored, never bypassed', () => {
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  assert.match(config, /TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT/);
  assert.match(config, /Only test networks are permitted/);
  // The app must not construct a cross-chain transaction itself.
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text.split('\n').find((line) => /initShaAtomicSwap|acceptQuote\(|beginL1Funding\(|revealAndClaim/.test(line));
    assert.equal(hit, undefined, `${path.relative(appRoot, file)} must not drive the cross-layer coordinator directly: ${hit ?? ''}`);
  }
});

test('policy: no developer trading fee is introduced', () => {
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    // The only permitted references state that it is zero.
    const offenders = text
      .split('\n')
      .filter((line) => /developerTradingFee|developerFee|platformFee/.test(line))
      .filter((line) => !/'0'|"0"|Developer trading fee|developer fee|no developer/i.test(line));
    assert.deepEqual(offenders, [], `${path.relative(appRoot, file)} must not introduce a developer fee: ${offenders.join(' | ')}`);
  }
});

test('chart: the TradingView attribution logo option is enabled', () => {
  const chart = fs.readFileSync(path.join(srcRoot, 'components', 'CandleChart.tsx'), 'utf8');
  assert.match(chart, /attributionLogo:\s*true/);
  const shell = fs.readFileSync(path.join(srcRoot, 'components', 'AppShell.tsx'), 'utf8');
  assert.match(shell, /tradingview\.com/);
  assert.match(shell, /Copyright 2023 TradingView/);
  assert.match(shell, /rel="noreferrer noopener"/);
});

test('chart lifecycle: the chart is created once, updated incrementally, and removed on unmount', () => {
  const chart = fs.readFileSync(path.join(srcRoot, 'components', 'CandleChart.tsx'), 'utf8');
  const effectBlocks = chart.split('useEffect(');
  assert.equal(chart.split('createChart(').length - 1, 1, 'createChart appears exactly once');
  assert.match(chart, /chart\.remove\(\)/, 'the chart is removed on unmount');
  assert.match(chart, /unsubscribeCrosshairMove/);
  assert.match(chart, /observer\.disconnect\(\)/, 'the resize observer is disconnected');
  assert.match(chart, /\.setData\(/, 'history is set with setData');
  assert.match(chart, /\.update\(/, 'live trades use the incremental update path');
  assert.match(chart, /addPane\(\)/, 'volume lives in its own pane');
  // The creation effect must not depend on the data, or the chart would be
  // rebuilt on every tick.
  assert.equal(effectBlocks.some((block) => block.startsWith('()') === false && /\[candles\]/.test(block.slice(0, 200))), false);
});

test('responsive: the stylesheet handles the narrow widths in scope and never overflows', () => {
  const css = styleFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(css, /overflow-x:\s*hidden/, 'the page must never scroll horizontally');
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(min-width: 1100px\)/);
  assert.match(css, /\.table-wrap[\s\S]*?overflow-x:\s*auto/, 'wide tables scroll inside their own container');
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'grid tracks may shrink to zero');
  assert.match(css, /@media \(pointer: coarse\)/, 'touch targets grow on coarse pointers');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /word-break|overflow-wrap|\.mono\s*\{/, 'long addresses can break');
});

test('accessibility: focus is always visible and the skip link exists', () => {
  const css = styleFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(css, /:focus-visible/);
  assert.match(css, /--focus-ring/);
  const shell = fs.readFileSync(path.join(srcRoot, 'components', 'AppShell.tsx'), 'utf8');
  assert.match(shell, /skip-link/);
  assert.match(shell, /id="main"/);
});

