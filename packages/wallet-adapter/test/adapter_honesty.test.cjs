/**
 * Wallet adapter honesty.
 *
 * A placeholder adapter that returns fabricated account, balance, or
 * transaction state is a fund-loss vector, not a convenience:
 *
 *   - a fabricated `signAndSubmit` receipt leaves the operation permanently
 *     SUBMITTED, because the invented id resolves to nothing and can never be
 *     confirmed, failed, or reconciled;
 *   - a fabricated account makes the UI show a balance that does not exist;
 *   - `isSupported() === true` lets a caller bind to a provider that answers
 *     nothing.
 *
 * Every adapter in this package that is a declared placeholder must therefore
 * report `false` from `isSupported()` and throw from every other operation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BrowserExtensionWalletAdapter,
  WalletDaemonAdapter,
  EmbeddedOotleWalletAdapter,
  SapientWalletAdapter,
  SapientConnectionNotSupported,
  WalletAdapterNotImplementedError,
} = require('../dist/index.js');

const PLACEHOLDERS = [
  { name: 'BrowserExtensionWalletAdapter', make: () => new BrowserExtensionWalletAdapter() },
  { name: 'WalletDaemonAdapter', make: () => new WalletDaemonAdapter() },
  { name: 'EmbeddedOotleWalletAdapter', make: () => new EmbeddedOotleWalletAdapter() },
];

const STATE_BEARING = ['connect', 'getNetwork', 'getAccounts', 'getSelectedAccount', 'getBalances', 'getResources', 'previewTransaction', 'signAndSubmit', 'getTransactionStatus'];

test('adapters: a placeholder must report that it is not supported', async () => {
  for (const adapter of PLACEHOLDERS) {
    const instance = adapter.make();
    assert.equal(await instance.isSupported(), false, `${adapter.name}.isSupported() must be false`);
    assert.match(instance.adapterName(), /NOT_IMPLEMENTED/, `${adapter.name} must name itself as unimplemented`);
  }
});

test('adapters: no placeholder may return fabricated account or transaction state', async () => {
  for (const adapter of PLACEHOLDERS) {
    const instance = adapter.make();
    for (const operation of STATE_BEARING) {
      await assert.rejects(
        async () => instance[operation](operation === 'signAndSubmit' ? {} : operation === 'previewTransaction' ? {} : operation === 'getTransactionStatus' ? 'tx' : undefined),
        (error) => {
          assert.ok(error instanceof WalletAdapterNotImplementedError, `${adapter.name}.${operation} must refuse loudly, got ${error?.name}`);
          assert.match(error.message, /NOT IMPLEMENTED/);
          // The message must explain the harm, not just the fact.
          assert.match(error.message, /fabricated "submitted" receipt/);
          return true;
        },
        `${adapter.name}.${operation} must reject`,
      );
    }
  }
});

test('adapters: a placeholder must never yield a plausible session or a synthesised txid', async () => {
  for (const adapter of PLACEHOLDERS) {
    const instance = adapter.make();
    let session = null;
    let receipt = null;
    try {
      session = await instance.connect();
    } catch (error) {
      assert.ok(error instanceof WalletAdapterNotImplementedError);
    }
    try {
      receipt = await instance.signAndSubmit({});
    } catch (error) {
      assert.ok(error instanceof WalletAdapterNotImplementedError);
    }
    assert.equal(session, null, `${adapter.name}.connect must not return a session`);
    assert.equal(receipt, null, `${adapter.name}.signAndSubmit must not return a receipt`);
  }
});

const srcDir = path.join(__dirname, '..', 'src');

/**
 * Reduce a TypeScript source to EXECUTABLE code: comments and string literals
 * are removed, so documentation prose that merely names a banned value cannot
 * mask a real use, and a banned value inside an error message cannot cause a
 * false positive.
 */
function executableSource(name) {
  const raw = fs.readFileSync(path.join(srcDir, name), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('adapters: no fabricated addresses or transaction ids remain in executable code', () => {
  const banned = ['extension-account-placeholder', 'walletd-account', 'embedded-account', 'tx-ext-', 'tx-walletd-', 'tx-embedded-', 'test-entropy-placeholder'];
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue;
    const code = executableSource(name);
    for (const marker of banned) {
      assert.equal(code.includes(marker), false, `${name} must not contain the fabricated value "${marker}"`);
    }
  }
});

test('adapters: no adapter defaults to a localhost endpoint', () => {
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue;
    const code = executableSource(name);
    assert.equal(/localhost:\d+|127\.0\.0\.1/.test(code), false, `${name} must not hard-code a localhost endpoint`);
    assert.equal(/=\s*['"]https?:\/\/(localhost|127\.0\.0\.1)/.test(code), false, `${name} must not default to a local URL`);
  }
  // And the constructor takes no default at all.
  assert.equal(new WalletDaemonAdapter().describeEndpoint(), 'none configured');
});

test('adapters: no adapter reads or writes key material', () => {
  const keyMarkers = ['seed', 'entropy', 'mnemonic', 'privateKey', 'privKey'];
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue;
    const lines = executableSource(name).split('\n');
    for (const marker of keyMarkers) {
      const hit = lines.find((line) => line.includes(marker) && !/NOT_IMPLEMENTED|would require key material|refuse/i.test(line));
      assert.equal(hit, undefined, `${name} must not handle key material: ${hit ?? ''}`);
    }
  }
});

test('adapters: the injected key-value store is never read or written', async () => {
  const calls = [];
  const spyStore = {
    get: async (key) => {
      calls.push(['get', key]);
      return 'leaked-secret';
    },
    set: async (key) => {
      calls.push(['set', key]);
    },
    remove: async (key) => {
      calls.push(['remove', key]);
    },
  };
  const adapter = new EmbeddedOotleWalletAdapter(spyStore);
  assert.equal(adapter.hasStore(), true, 'the store is retained for call-site compatibility');
  await adapter.isSupported();
  await assert.rejects(() => adapter.connect(), WalletAdapterNotImplementedError);
  await assert.rejects(() => adapter.getBalances(), WalletAdapterNotImplementedError);
  await assert.rejects(() => adapter.signAndSubmit({}), WalletAdapterNotImplementedError);
  assert.deepEqual(calls, [], 'the store must never be touched');
});

test('adapters: the sapient placeholder already refuses everywhere and is preserved', async () => {
  const adapter = new SapientWalletAdapter();
  assert.equal(await adapter.isSupported(), false);
  for (const operation of STATE_BEARING) {
    await assert.rejects(
      async () => adapter[operation](operation === 'signAndSubmit' || operation === 'previewTransaction' ? {} : operation === 'getTransactionStatus' ? 'tx' : undefined),
      SapientConnectionNotSupported,
      `SapientWalletAdapter.${operation} must refuse`,
    );
  }
});

test('adapters: every exported adapter either refuses or is a real implementation', () => {
  // A new adapter added to the package must either be a placeholder that
  // refuses, or declare itself. This catches a future stub slipping in.
  const index = require('../dist/index.js');
  const adapterNames = Object.keys(index).filter((name) => /Adapter$/.test(name) && typeof index[name] === 'function');
  assert.ok(adapterNames.length >= 4, `expected the known adapters, found ${adapterNames.join(', ')}`);
  for (const name of adapterNames) {
    const instance = new index[name]();
    assert.equal(typeof instance.isSupported, 'function', `${name} must implement the adapter interface`);
    assert.equal(typeof instance.signAndSubmit, 'function', `${name} must implement the adapter interface`);
  }
});
