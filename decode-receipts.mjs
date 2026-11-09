// Decode both transfer execution_result fields using the repo's ootle-wasm-bor package.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const pkgRoot = join(process.cwd(),
  'node_modules/.pnpm/@tari-project+ootle-wasm-bor@0.49.2/node_modules/@tari-project/ootle-wasm-bor');
const wasmPath = join(pkgRoot, 'ootle_wasm_bor_bg.wasm');
const gluePath = join(pkgRoot, 'ootle_wasm_bor_bg.js');

// Dynamic import the ES-module glue (Windows requires file:// URL)
const glue = await import(pathToFileURL(gluePath).href);

// Instantiate WASM
const wasmBytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  './ootle_wasm_bor_bg.js': glue
});
glue.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

// Read receipts
const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
const testaRaw = JSON.parse(readFileSync(join(tmpDir, 'shadow-swap-TESTA-receipt.json'), 'utf8'));
const tariRaw  = JSON.parse(readFileSync(join(tmpDir, 'shadow-swap-tTARI-receipt.json'), 'utf8'));

const testaB64 = testaRaw?.result?.Finalized?.execution_result;
const tariB64  = tariRaw?.result?.Finalized?.execution_result;

function decodeAndPrint(label, b64) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${label} ===`);
  console.log('='.repeat(60));
  if (!b64) { console.log('NO execution_result'); return; }
  try {
    const decoded = JSON.parse(glue.decodeExecuteResult(b64));
    console.log(JSON.stringify(decoded, null, 2));
  } catch (e) {
    console.error('decode error:', e.message);
    // Try as transaction receipt
    try {
      const decoded2 = JSON.parse(glue.decodeTransactionReceipt(b64));
      console.log('(as receipt)', JSON.stringify(decoded2, null, 2));
    } catch (e2) {
      console.error('receipt decode error:', e2.message);
    }
  }
}

decodeAndPrint('TESTA transfer', testaB64);
decodeAndPrint('tTARI transfer', tariB64);
