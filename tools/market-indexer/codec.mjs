import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('@tari-project/ootle-wasm-bor/package.json', { paths: [HERE] }));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
if (manifest.version !== '0.49.2') throw new Error(`expected the pinned ootle-wasm-bor 0.49.2, found ${manifest.version}`);
const glue = await import(pathToFileURL(path.join(pkg, 'ootle_wasm_bor_bg.js')).href);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(pkg, 'ootle_wasm_bor_bg.wasm')), { './ootle_wasm_bor_bg.js': glue });
glue.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

export async function loadOotleWasmBor() {
  return {
    decodeSubstateValue: (encoded) => JSON.parse(glue.decodeSubstateValue(encoded)),
  };
}
