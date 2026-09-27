/**
 * DISPLAY-ONLY formatting.
 *
 * HARD BOUNDARY (mission §18/§49): every value produced here is a human-readable
 * string. Nothing in this module may be fed back into routing, execution,
 * min_output, settlement, or a transaction builder. The only sanctioned float
 * conversion in the codebase is the protocol-client's own `toDisplayPrice` /
 * `toChartSeries`; this module calls those rather than re-deriving them.
 *
 * All raw amounts are exact non-negative integer strings in a resource's base
 * units. Every conversion below is integer arithmetic (`BigInt` / string ops).
 * `Number` is never used to carry an on-chain quantity.
 */

import { toDisplayPrice, type PriceRational } from '@tari-ootle/protocol-client';

export const RAW_AMOUNT_PATTERN = /^\d+$/;

/** Placeholder for a metric the protocol could not produce. Never a fake zero. */
export const UNAVAILABLE = '—';

export function isRawAmount(value: unknown): value is string {
  return typeof value === 'string' && RAW_AMOUNT_PATTERN.test(value);
}

export interface FormatUnitsOptions {
  /** Hard cap on fraction digits. Excess digits are truncated, never rounded up. */
  maxFractionDigits?: number;
  /** Hard cap on integer digits; beyond this the value is abbreviated. */
  abbreviate?: boolean;
}

const UNITS: ReadonlyArray<{ threshold: bigint; suffix: string }> = [
  { threshold: 1_000_000_000_000_000n, suffix: 'Q' },
  { threshold: 1_000_000_000_000n, suffix: 'T' },
  { threshold: 1_000_000_000n, suffix: 'B' },
  { threshold: 1_000_000n, suffix: 'M' },
  { threshold: 1_000n, suffix: 'K' },
];

/**
 * Exact base-unit → decimal-string conversion with integer long division.
 * Rejects anything that is not a raw non-negative integer string, so a
 * malformed upstream value surfaces as unavailable instead of becoming NaN.
 */
export function formatUnits(raw: string | undefined | null, decimals: string | number, options: FormatUnitsOptions = {}): string {
  if (!isRawAmount(raw) || raw === undefined || raw === null) return UNAVAILABLE;
  const dec = typeof decimals === 'number' ? decimals : Number.parseInt(decimals, 10);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return UNAVAILABLE;
  const value = BigInt(raw);
  if (value === 0n) return '0';

  const maxFrac = options.maxFractionDigits ?? 6;
  const pad = raw.padStart(dec + 1, '0');
  const intPart = dec === 0 ? pad : pad.slice(0, pad.length - dec);
  const fracPart = dec === 0 ? '' : pad.slice(pad.length - dec);

  if (options.abbreviate === true) {
    return abbreviate(BigInt(intPart + fracPart), intPart, fracPart, dec);
  }

  const trimmed = fracPart.slice(0, maxFrac).replace(/0+$/, '');
  if (trimmed.length === 0) return group(intPart);
  return `${group(intPart)}.${trimmed}`;
}

function abbreviate(total: bigint, intPart: string, fracPart: string, dec: number): string {
  for (const unit of UNITS) {
    if (total < unit.threshold) continue;
    // Display-only: re-quantise with integer math so we never touch a float.
    const scaled = (total * 1000n) / unit.threshold; // three fraction digits
    const asString = scaled.toString().padStart(4, '0');
    const whole = asString.slice(0, asString.length - 3);
    const fraction = asString.slice(asString.length - 3).replace(/0+$/, '');
    void intPart;
    void fracPart;
    void dec;
    return fraction.length > 0 ? `${whole}.${fraction}${unit.suffix}` : `${whole}${unit.suffix}`;
  }
  return group(intPart);
}

/** Thousands separators. Display only. */
function group(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/**
 * Prices use the protocol-client's intentional display boundary. The frontend
 * never performs its own price division.
 */
export function formatPrice(price: PriceRational | undefined | null, maxSignificantDigits = 12): string {
  if (price === undefined || price === null) return UNAVAILABLE;
  try {
    const display = toDisplayPrice(price, maxSignificantDigits);
    if (display.value === '0') return '0';
    return display.value;
  } catch {
    return UNAVAILABLE;
  }
}

/** A percentage expressed in basis points. Exact integer arithmetic throughout. */
export function formatBps(bps: string | number | undefined | null, fractionDigits = 2): string {
  const asString = typeof bps === 'number' ? String(bps) : bps;
  if (asString === undefined || asString === null || !RAW_AMOUNT_PATTERN.test(asString)) return UNAVAILABLE;
  const magnitude = BigInt(asString);
  // 1 bp = 0.01%, so the percentage scaled to `fractionDigits` places is
  // (bps * 10^fractionDigits) / 100 — exact for every integer basis-point value.
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = (magnitude * scale) / 100n;
  const whole = scaled / scale;
  const frac = fractionDigits === 0 ? '' : (scaled % scale).toString().padStart(fractionDigits, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}%` : `${whole}%`;
}

/** Preserves a pre-formatted percentage string from the query API verbatim. */
export function formatPercentDisplay(value: string | undefined): string {
  return value === undefined || value === '' ? UNAVAILABLE : value;
}

export function formatAddress(address: string | undefined | null, lead = 8, tail = 6): string {
  if (address === undefined || address === null || address === '') return UNAVAILABLE;
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function formatNumber(value: number | undefined | null, fractionDigits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return UNAVAILABLE;
  return value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

export interface TradeTimeDisplay {
  /** What to render. */
  text: string;
  /** Whether a wall-clock time was actually available. */
  hasWallClock: boolean;
  /** Longer explanation for the title/aria affordance. */
  title: string;
}

/**
 * Honest time rendering. A trade with only an epoch bucket gets an epoch label —
 * never a synthesised wall-clock timestamp.
 */
export function formatTradeTime(time: { source: string; unixMs?: string; epoch?: string; bucketKey: string } | undefined): TradeTimeDisplay {
  if (time === undefined) {
    return { text: UNAVAILABLE, hasWallClock: false, title: 'No time information was reported for this record.' };
  }
  if (time.source === 'CONSENSUS_TIMESTAMP' && isRawAmount(time.unixMs ?? '')) {
    const ms = BigInt(time.unixMs as string);
    const date = new Date(Number(ms));
    if (Number.isFinite(date.getTime())) {
      return {
        text: date.toISOString().replace('T', ' ').slice(0, 19) + 'Z',
        hasWallClock: true,
        title: `Consensus timestamp (bucket ${time.bucketKey})`,
      };
    }
  }
  const epoch = time.source === 'EPOCH_BOUNDARY' || time.source === 'CONSENSUS_TIMESTAMP' ? (time.epoch ?? time.bucketKey) : undefined;
  if (isRawAmount(epoch ?? '')) {
    return {
      text: `Epoch ${epoch}`,
      hasWallClock: false,
      title: 'No trustworthy wall-clock timestamp is exposed for this source; showing the consensus epoch instead.',
    };
  }
  return {
    text: UNAVAILABLE,
    hasWallClock: false,
    title: `Time source ${time.source} is not a consensus clock, so no time is displayed rather than a fabricated one.`,
  };
}

export function formatDuration(msRemaining: number | undefined): string {
  if (msRemaining === undefined || !Number.isFinite(msRemaining)) return UNAVAILABLE;
  if (msRemaining <= 0) return 'expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/** `<amount> <symbol>` with a graceful fallback when metadata is unknown. */
export function formatAmountWithSymbol(raw: string | undefined, decimals: string | number, symbol: string | undefined, options?: FormatUnitsOptions): string {
  const amount = formatUnits(raw, decimals, options);
  if (amount === UNAVAILABLE) return UNAVAILABLE;
  const label = symbol !== undefined && symbol.trim() !== '' ? symbol.trim() : 'units';
  return `${amount} ${label}`;
}
