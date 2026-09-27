/**
 * Exact price representation for market data.
 *
 * Prices are stored as an exact RATIONAL (numerator/denominator BigInts of raw units) plus
 * the divisibilities needed to interpret them. A price is never collapsed to an IEEE-754
 * Number during storage or aggregation — `Number` cannot represent a 128-bit raw amount and
 * silently rounding it would corrupt OHLC comparisons.
 *
 * Display conversion exists but is explicitly separated (see `toDisplayPrice`) and is never
 * used for ordering, aggregation, or any decision.
 */

export interface PriceRational {
  /** Raw quote units in the numerator. */
  numerator: string;
  /** Raw base units in the denominator. Always > 0. */
  denominator: string;
  /** Decimals of the base resource (for interpretation/display only). */
  baseDecimals: string;
  /** Decimals of the quote resource. */
  quoteDecimals: string;
}

export type PriceComparison = -1 | 0 | 1;

/** Build a quote-per-base price from settled amounts. Exact, no rounding. */
export function priceFromSettled(input: { quoteOutRaw: string; baseInRaw: string; baseDecimals: string; quoteDecimals: string }): PriceRational {
  const numerator = requireRaw(input.quoteOutRaw, 'quoteOutRaw');
  const denominator = requireRaw(input.baseInRaw, 'baseInRaw');
  if (denominator === 0n) throw new Error('price denominator (base input) must be positive');
  return { numerator: numerator.toString(), denominator: denominator.toString(), baseDecimals: input.baseDecimals, quoteDecimals: input.quoteDecimals };
}

/**
 * Exact rational comparison via cross multiplication. No precision loss for tiny or huge
 * pools, and no dependence on the order of arguments.
 */
export function comparePrices(a: PriceRational, b: PriceRational): PriceComparison {
  const left = BigInt(a.numerator) * BigInt(b.denominator);
  const right = BigInt(b.numerator) * BigInt(a.denominator);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Midpoint of two prices, exact (used only for display-ish summaries, never for OHLC). */
export function priceMidpoint(a: PriceRational, b: PriceRational): PriceRational {
  const n = (BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator));
  const d = 2n * BigInt(a.denominator) * BigInt(b.denominator);
  return { numerator: n.toString(), denominator: d.toString(), baseDecimals: a.baseDecimals, quoteDecimals: a.quoteDecimals };
}

export interface DisplayPrice {
  /** Human-readable decimal string, computed with exact decimal arithmetic. */
  value: string;
  /** True when the exact value could not be represented within `maxSignificantDigits`. */
  approximate: boolean;
}

/**
 * The DISPLAY boundary. Converts a raw-unit price to a decimal string by dividing out the
 * divisibilities, and rounds to a bounded number of significant decimal digits using exact
 * integer long division. Callers must treat the result as presentational.
 */
export function toDisplayPrice(price: PriceRational, maxSignificantDigits = 12): DisplayPrice {
  if (maxSignificantDigits < 1 || maxSignificantDigits > 30) throw new Error('maxSignificantDigits must be between 1 and 30');
  // price in display units = (num / 10^quoteDecimals) / (den / 10^baseDecimals)
  //                                  = num * 10^baseDecimals / (den * 10^quoteDecimals)
  const num = BigInt(price.numerator) * 10n ** BigInt(price.baseDecimals);
  const den = BigInt(price.denominator) * 10n ** BigInt(price.quoteDecimals);
  if (den <= 0n) throw new Error('price denominator must be positive');
  if (num < 0n) throw new Error('price numerator must be non-negative');
  if (num === 0n) return { value: '0', approximate: false };

  // Exact long division: the integer part is never estimated, and the fraction is
  // generated digit by digit so a value with many integer digits (for example
  // 25.0) does not acquire spurious leading digits.
  const intQ = num / den;
  let remainder = num % den;
  const intText = intQ.toString();
  const digits: string[] = [];
  for (let i = 0; i < maxSignificantDigits && remainder > 0n; i += 1) {
    const scaled = remainder * 10n;
    digits.push((scaled / den).toString());
    remainder = scaled % den;
  }
  // Bound the fraction by the significant-digit budget: if the integer part is
  // wide, fewer fraction digits are meaningful.
  const fractionBudget = Math.max(0, maxSignificantDigits - intText.length);
  const fracText = digits.join('').slice(0, fractionBudget).replace(/0+$/, '');
  const value = fracText.length > 0 ? `${intText}.${fracText}` : intText;
  return { value, approximate: true };
}

/** Exact string parsing for prices supplied by a trusted producer (never a UI). */
export function priceFromDecimalString(input: { value: string; baseDecimals: string; quoteDecimals: string }): PriceRational {
  if (!/^-?\d+(\.\d+)?$/.test(input.value)) throw new Error('price must be a decimal string');
  const negative = input.value.startsWith('-');
  const [intPart, fracPart = ''] = input.value.replace('-', '').split('.');
  // price = num/10^quoteDec * 10^baseDec / den  →  num/den = value * 10^(quoteDec-baseDec)
  const scale = BigInt(input.quoteDecimals) - BigInt(input.baseDecimals);
  const digits = BigInt(intPart + fracPart);
  if (scale >= 0n) {
    const den = 10n ** scale * 10n ** BigInt(fracPart.length);
    return { numerator: (negative ? -digits : digits).toString(), denominator: den.toString(), baseDecimals: input.baseDecimals, quoteDecimals: input.quoteDecimals };
  }
  const num = digits * 10n ** (-scale) * 10n ** BigInt(fracPart.length);
  const den = 10n ** BigInt(fracPart.length);
  return { numerator: (negative ? -num : num).toString(), denominator: den.toString(), baseDecimals: input.baseDecimals, quoteDecimals: input.quoteDecimals };
}

function requireRaw(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${field} must be a raw non-negative integer string`);
  const v = BigInt(value);
  if (v > (1n << 128n) - 1n) throw new Error(`${field} exceeds 128 bits`);
  return v;
}
