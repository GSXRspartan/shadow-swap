/**
 * EXACT DECIMAL PARSING (mission §12, §13, §14).
 *
 * An amount field is the most likely place for a silent divergence between what
 * the user typed and what gets signed. The dangerous conversions are:
 *
 *   - `Number(x)` — loses every digit above 2^53, so "0.1" and "0.1000000000001"
 *     collapse, and a value above 2^53 silently rounds;
 *   - `parseFloat` — the same, plus it accepts "0x10", "1e3", and "Infinity";
 *   - multiplying by 10**decimals in a float — the classic decimal-shift bug
 *     where a user enters 1.0 and the builder requests 10.
 *
 * `parseDecimalToRaw` therefore does long division on `BigInt` only, and it is
 * deliberately strict: anything it is not certain about is refused rather than
 * rounded. Excess precision is an ERROR, never a silent truncation, because a
 * user must never sign more (or less) than they typed without being told.
 */

/** Never coerce. `asRawExecutionAmount` in tradeBoundary.ts remains the only execution funnel. */
export const MAX_DECIMALS = 36;
export const MAX_INPUT_LENGTH = 80;

export interface ParsedAmount {
  /** Exact base units. */
  raw: string;
  /** How many fraction digits the user actually typed. */
  typedDecimals: number;
  /** True when the typed value had to be shortened for display. */
  approximate: boolean;
}

export class AmountParseError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
    input: string,
  ) {
    super(`Amount field "${field}" is not a valid amount: ${reason}. Received ${JSON.stringify(truncate(input))}.`);
    this.name = 'AmountParseError';
  }
}

function truncate(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…(${value.length} chars)`;
}

/**
 * Strictly-typed digit validation. Rejects every form a hostile paste can take:
 * `+1`, `.1`, `1.`, `1e3`, `Infinity`, `NaN`, `0x10`, Arabic-Indic digits,
 * non-breaking spaces, thousands separators, and repeated decimal points.
 */
export function parseDecimalToRaw(input: string, decimals: number, field = 'amount'): ParsedAmount {
  if (typeof input !== 'string') throw new AmountParseError(field, 'value must be a string', String(input));
  if (input.length > MAX_INPUT_LENGTH) {
    throw new AmountParseError(field, `value is longer than ${MAX_INPUT_LENGTH} characters`, input);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountParseError(field, `resource divisibility ${decimals} is outside the supported range 0..${MAX_DECIMALS}`, input);
  }
  if (input.trim() !== input) throw new AmountParseError(field, 'surrounding whitespace is not accepted', input);
  if (input === '') throw new AmountParseError(field, 'value is empty', input);

  // ASCII digits only. `^0-9$` excludes Unicode decimal digits, which look
  // identical but are different code points and are a known paste attack.
  if (!/^[0-9]*(\.[0-9]*)?$/.test(input)) {
    throw new AmountParseError(field, 'only ASCII digits and at most one decimal point are accepted', input);
  }
  if (input === '.') throw new AmountParseError(field, 'a bare decimal point is not a number', input);
  if (input.startsWith('.')) throw new AmountParseError(field, 'a number must have at least one digit before the decimal point', input);
  if (input.endsWith('.')) throw new AmountParseError(field, 'a trailing decimal point is not accepted; write the fraction explicitly', input);

  const [intPart, fracRaw = ''] = input.split('.');
  if (intPart === '' && fracRaw === '') throw new AmountParseError(field, 'value is empty', input);

  const typedDecimals = fracRaw.length;
  if (typedDecimals > decimals) {
    // Refuse rather than truncate: silently dropping digits is how a user ends
    // up signing an amount they did not read.
    throw new AmountParseError(
      field,
      `the value has ${typedDecimals} fraction digits but this resource has only ${decimals} decimals; extra precision cannot be represented and is not rounded`,
      input,
    );
  }

  // Scale to the asset's divisibility by APPENDING zeros for the missing
  // fraction digits. Deriving this by padding and slicing is where the
  // classic decimal-shift bug lives: "1.0" at 6 decimals must become
  // 1000000, not 1.
  const digits = `${intPart}${fracRaw}`;
  const scaled = `${digits}${'0'.repeat(decimals - typedDecimals)}`.replace(/^0+(?=\d)/, '');
  return { raw: scaled === '' ? '0' : scaled, typedDecimals, approximate: false };
}

/**
 * Format an exact raw amount for pre-filling an input field.
 *
 * Display -> input -> raw must be lossless, so this strips trailing zeros and
 * never emits a trailing decimal point or scientific notation.
 */
export function rawToDecimalInput(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) throw new AmountParseError('raw', 'must be a raw non-negative integer string', raw);
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}

/** Compare two exact raw amounts without converting either. */
export function compareRaw(a: string, b: string): -1 | 0 | 1 {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new AmountParseError('compare', 'both operands must be raw integer strings', `${a} / ${b}`);
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The largest value the protocol's 128-bit amount guard permits. */
export const MAX_PROTOCOL_AMOUNT = (1n << 128n) - 1n;

export function assertWithinProtocolAmount(raw: string, field: string): string {
  if (!/^\d+$/.test(raw)) throw new AmountParseError(field, 'must be a raw non-negative integer string', raw);
  const value = BigInt(raw);
  if (value > MAX_PROTOCOL_AMOUNT) {
    throw new AmountParseError(field, `value exceeds the 128-bit protocol maximum (${MAX_PROTOCOL_AMOUNT})`, raw);
  }
  return raw;
}

/**
 * Hostile-input corpus. Every case states what must happen, so a future
 * relaxation of the parser is caught rather than absorbed.
 */
export const HOSTILE_AMOUNT_CASES: ReadonlyArray<{ input: string; decimals: number; accept: boolean; note: string }> = [
  { input: '0', decimals: 6, accept: true, note: 'zero is a valid (if useless) amount' },
  { input: '-1', decimals: 6, accept: false, note: 'negative' },
  { input: '+1', decimals: 6, accept: false, note: 'signed' },
  { input: '.1', decimals: 6, accept: false, note: 'no integer part' },
  { input: '1.', decimals: 6, accept: false, note: 'trailing point' },
  { input: '01', decimals: 6, accept: true, note: 'leading zero is harmless and normalises' },
  { input: '0001', decimals: 6, accept: true, note: 'leading zeros normalise' },
  { input: '1.000000', decimals: 6, accept: true, note: 'exact divisibility' },
  { input: '1.0000000', decimals: 6, accept: false, note: 'excess precision is refused, not rounded' },
  { input: '1.5', decimals: 0, accept: false, note: 'a zero-decimal resource cannot take a fraction' },
  { input: '1e3', decimals: 6, accept: false, note: 'scientific notation' },
  { input: '1E3', decimals: 6, accept: false, note: 'scientific notation' },
  { input: 'Infinity', decimals: 6, accept: false, note: 'not finite' },
  { input: 'NaN', decimals: 6, accept: false, note: 'not a number' },
  { input: '0x10', decimals: 6, accept: false, note: 'hex' },
  { input: '0b1', decimals: 6, accept: false, note: 'binary' },
  { input: '1,000', decimals: 6, accept: false, note: 'thousands separator' },
  { input: '1.2.3', decimals: 6, accept: false, note: 'two decimal points' },
  { input: ' 1', decimals: 6, accept: false, note: 'leading whitespace' },
  { input: '1 ', decimals: 6, accept: false, note: 'trailing whitespace' },
  { input: '1 ', decimals: 6, accept: false, note: 'non-breaking space' },
  { input: '١٢٣', decimals: 6, accept: false, note: 'Arabic-Indic digits are different code points' },
  { input: '１', decimals: 6, accept: false, note: 'fullwidth digit' },
  { input: '1b', decimals: 6, accept: false, note: 'zero-width space' },
  { input: '1‮000', decimals: 6, accept: false, note: 'bidi override' },
  { input: '1_000', decimals: 6, accept: false, note: 'numeric separator' },
  { input: '1'.padEnd(81, '0'), decimals: 6, accept: false, note: 'absurdly long input' },
];

export const HOSTILE_DIVISIBILITY_CASES: ReadonlyArray<number> = [0, 1, 2, 6, 8, 18, MAX_DECIMALS];
