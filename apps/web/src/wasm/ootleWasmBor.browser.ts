/**
 * Browser loader for the official Ootle value decoder.
 *
 * `@tari-project/ootle-wasm-bor` is published as a wasm-bindgen "bundler" build whose
 * entry module does `import * as wasm from "./ootle_wasm_bor_bg.wasm"` — ES-module
 * WebAssembly integration, which Vite does not support without extra plugins. Rather
 * than add a build plugin to a financial frontend, this file performs the same three
 * steps the entry module would, explicitly:
 *
 *   1. the `.wasm` is emitted by Vite as a hashed SAME-ORIGIN asset (`?url`) and fetched
 *      with no credentials and no referrer;
 *   2. it is instantiated against the package's own JS glue, which supplies the only
 *      three imports the module declares (an error constructor, a throw helper and the
 *      externref-table initialiser);
 *   3. the glue is bound to the instance and the module's start function is run.
 *
 * Executing WebAssembly needs `'wasm-unsafe-eval'` in `script-src`. That keyword permits
 * compiling WebAssembly only; it does NOT permit `eval`, `new Function`, or any remote
 * script, and the only module this app ever compiles is this same-origin asset.
 *
 * The package version is pinned EXACTLY (`0.48.0`) and its tarball integrity is fixed
 * by the lockfile, so the decoder is the one published with the v0.48.0 release.
 */

import wasmUrl from '@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.wasm?url';
import * as glue from '@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.js';
import type { ValueCodec } from '../services/ootleWire.js';

/** The decoder's compiled size is ~470 KB; anything far larger is not the pinned module. */
const MAX_WASM_BYTES = 2_000_000;

export async function loadOotleWasmBor(): Promise<ValueCodec> {
  const response = await fetch(wasmUrl, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  if (!response.ok) throw new Error(`the decoder module answered HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WASM_BYTES) throw new Error(`the decoder module has an implausible size (${bytes.byteLength} bytes)`);
  const { instance } = await WebAssembly.instantiate(bytes, { './ootle_wasm_bor_bg.js': glue as unknown as WebAssembly.ModuleImports });
  glue.__wbg_set_wasm(instance.exports);
  (instance.exports.__wbindgen_start as () => void)();
  return {
    decodeSubstateValue: (encoded: string): unknown => JSON.parse(glue.decodeSubstateValue(encoded)),
    decodeTransactionReceipt: (encoded: string): unknown => JSON.parse(glue.decodeTransactionReceipt(encoded)),
    decodeExecuteResult: (encoded: string): unknown => JSON.parse(glue.decodeExecuteResult(encoded)),
  };
}
