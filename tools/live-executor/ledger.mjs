// Durable append-only operation ledger.
//
// Every live operation records its intent, estimate, submission id, and final
// outcome here BEFORE the result is trusted, so an interrupted run can be
// reconciled by durable identifier rather than blind-retried. One JSON object
// per line (JSONL): append-only, never rewritten.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LEDGER = fileURLToPath(new URL('./live-op-ledger.jsonl', import.meta.url));

export async function appendLedger(path, entry) {
  const target = path ?? DEFAULT_LEDGER;
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, JSON.stringify(entry) + '\n', 'utf8');
  return target;
}

export { DEFAULT_LEDGER };
