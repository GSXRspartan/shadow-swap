/**
 * Types for the wasm-bindgen glue module of `@tari-project/ootle-wasm-bor@0.48.0`.
 *
 * The package ships declarations for its entry module only (`ootle_wasm_bor.d.ts`), and
 * this app deliberately bypasses that entry (see `ootleWasmBor.browser.ts`). The names
 * below are exactly the glue's exports at 0.48.0; each decoder takes the base64 string
 * the indexer serves and returns a JSON string, throwing on malformed input.
 */
declare module '@tari-project/ootle-wasm-bor/ootle_wasm_bor_bg.js' {
  export function decodeSubstateValue(encoded: string): string;
  export function decodeTransactionReceipt(encoded: string): string;
  export function decodeExecuteResult(encoded: string): string;
  export function decodeEvent(encoded: string): string;
  export function decodeResource(encoded: string): string;
  export function decodeUtxo(encoded: string): string;
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
