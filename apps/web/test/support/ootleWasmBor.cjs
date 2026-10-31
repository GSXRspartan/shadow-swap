/**
 * Node loader for the OFFICIAL Ootle v0.48 value decoder (`@tari-project/ootle-wasm-bor@0.48.0`).
 *
 * Performs exactly the instantiation the browser loader (`src/wasm/ootleWasmBor.browser.ts`)
 * performs, against the same installed package bytes, so the tests exercise the real
 * decoder rather than a stand-in.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let cached;

async function loadOotleWasmBor() {
  if (cached !== undefined) return cached;
  const pkg = path.dirname(require.resolve('@tari-project/ootle-wasm-bor/package.json', { paths: [path.resolve(__dirname, '..', '..')] }));
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  if (manifest.version !== '0.48.0') throw new Error(`expected the pinned ootle-wasm-bor 0.48.0, found ${manifest.version}`);
  const glue = await import(pathToFileURL(path.join(pkg, 'ootle_wasm_bor_bg.js')).href);
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(pkg, 'ootle_wasm_bor_bg.wasm')), { './ootle_wasm_bor_bg.js': glue });
  glue.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
  cached = {
    decodeSubstateValue: (encoded) => JSON.parse(glue.decodeSubstateValue(encoded)),
    decodeTransactionReceipt: (encoded) => JSON.parse(glue.decodeTransactionReceipt(encoded)),
    decodeExecuteResult: (encoded) => JSON.parse(glue.decodeExecuteResult(encoded)),
  };
  return cached;
}

module.exports = { loadOotleWasmBor };
