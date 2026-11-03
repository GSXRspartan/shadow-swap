/**
 * A QR encoder, byte mode, error-correction level M. Written here rather than taken as a
 * dependency.
 *
 * WHY NOT A DEPENDENCY. This renders a destination for money. A dependency in that path is one
 * more thing that can be replaced in a registry, and `pnpm audit` does not tell you whether a
 * package encodes the string you gave it. ~300 lines of a published, fixed algorithm with its own
 * tests is a smaller trust surface than a transitive tree, and the algorithm has not changed
 * since ISO/IEC 18004.
 *
 * WHAT A WRONG ENCODING WOULD DO, which is the reason this is safe to hand-roll: a QR symbol
 * carries its own Reed–Solomon error correction and a BCH-protected format word. A mis-encoded
 * symbol therefore FAILS TO DECODE rather than decoding to a different string — a scanner reports
 * nothing, it does not report another address. The UI also always shows the full address as text
 * with a copy control, so the QR is a convenience and never the only path.
 *
 * SCOPE, deliberately narrow:
 *   * Byte mode only. Addresses are ASCII; alphanumeric mode would be denser and is not needed.
 *   * Level M only (~15% recovery), the usual choice for an address.
 *   * Versions 1..10, which reach 213 bytes — enough for a 91-character Minotari address and a
 *     114-character Ootle one, with room to spare.
 *
 * Anything that does not fit is a refusal, not a silent truncation.
 */

export class QrError extends Error {}

/** Per version at level M: EC codewords per block, then the block groups. */
export interface VersionSpec {
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
}

/**
 * Level-M block structure for versions 1..10, from ISO/IEC 18004 Table 9.
 *
 * Self-checking: `dataCodewords = g1*g1Data + g2*g2Data`, and the byte capacity this implies
 * matches the published capacity table for every row (106 bytes at v6, 122 at v7, 213 at v10).
 * `QR_CAPACITIES` below is derived from these numbers rather than listed separately, so the two
 * cannot disagree.
 */
const VERSION_SPECS: Readonly<Record<number, VersionSpec>> = {
  1: { ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0 },
  2: { ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0 },
  3: { ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0 },
  4: { ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0 },
  5: { ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0 },
  6: { ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0 },
  7: { ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0 },
  8: { ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39 },
  9: { ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37 },
  10: { ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44 },
};

/** Exposed so a test can decode a symbol independently of how it was built. */
export function qrVersionSpec(version: number): VersionSpec {
  const spec = VERSION_SPECS[version];
  if (spec === undefined) throw new QrError(`version ${version} is outside ${QR_MIN_VERSION}..${QR_MAX_VERSION}`);
  return spec;
}

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/** Alignment-pattern centre coordinates per version, ISO/IEC 18004 Table E.1. */
const ALIGNMENT_CENTRES: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** 18-bit BCH version information, required from version 7 upward. ISO/IEC 18004 Table D.1. */
const VERSION_INFO: Readonly<Record<number, number>> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

function dataCodewords(spec: VersionSpec): number {
  return spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
}

/** The character-count field is 8 bits up to version 9 and 16 bits from version 10. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Byte capacity per version at level M, derived from the block table rather than listed. */
export function qrByteCapacity(version: number): number {
  const spec = VERSION_SPECS[version];
  if (spec === undefined) throw new QrError(`version ${version} is outside ${QR_MIN_VERSION}..${QR_MAX_VERSION}`);
  const bits = dataCodewords(spec) * 8 - 4 - countBits(version);
  return Math.floor(bits / 8);
}

export const QR_CAPACITIES: Readonly<Record<number, number>> = Object.fromEntries(
  Object.keys(VERSION_SPECS).map((key) => [Number(key), qrByteCapacity(Number(key))]),
);

/** The smallest version that fits `byteLength`, or a refusal. */
export function qrVersionFor(byteLength: number): number {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version += 1) {
    if (byteLength <= qrByteCapacity(version)) return version;
  }
  throw new QrError(
    `${byteLength} bytes exceeds ${qrByteCapacity(QR_MAX_VERSION)}, the level-M byte capacity of version ${QR_MAX_VERSION}. This encoder refuses rather than truncating.`,
  );
}

// ---------------------------------------------------------------------------------------------
// GF(256) and Reed–Solomon
// ---------------------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    // The QR field is GF(2^8) with primitive polynomial 0x11d.
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0;
}

/** The generator polynomial for `degree` EC codewords: product of (x - a^i). */
export function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j] ?? 0, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** The EC codewords for one data block. */
export function rsEncode(data: readonly number[], ecCount: number): number[] {
  const generator = rsGenerator(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecCount; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------------------------
// Bit stream
// ---------------------------------------------------------------------------------------------

class BitWriter {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pads to a whole codeword and then with the standard 0xEC / 0x11 alternation. */
  toCodewords(total: number): number[] {
    const bits = [...this.bits];
    const capacity = total * 8;
    if (bits.length > capacity) throw new QrError('bit stream exceeds the chosen version\'s capacity');
    // Terminator: up to four zero bits, then zeros to the codeword boundary.
    for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
      codewords.push(byte);
    }
    const PAD = [0xec, 0x11];
    let index = 0;
    while (codewords.length < total) {
      codewords.push(PAD[index % 2] ?? 0);
      index += 1;
    }
    return codewords;
  }
}

/** ASCII/latin-1 bytes. Byte mode's default interpretation is ISO-8859-1. */
function toBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0xff) {
      throw new QrError(
        `"${character}" is outside ISO-8859-1, which byte mode encodes. An address is ASCII, so this is a sign the wrong value was passed.`,
      );
    }
    bytes.push(code);
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------------------------

/** `true` is a dark module. `reserved` marks function patterns that data must skip. */
export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  readonly mask: number;
  readonly modules: readonly boolean[][];
}

function emptyGrid(size: number): { modules: boolean[][]; reserved: boolean[][] } {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function placeFinder(modules: boolean[][], reserved: boolean[][], row: number, column: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = column + c;
      if (y < 0 || x < 0 || y >= modules.length || x >= modules.length) continue;
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      (modules[y] ?? [])[x] = dark;
      (reserved[y] ?? [])[x] = true;
    }
  }
}

function placeAlignment(modules: boolean[][], reserved: boolean[][], version: number): void {
  const centres = ALIGNMENT_CENTRES[version] ?? [];
  const size = modules.length;
  for (const row of centres) {
    for (const column of centres) {
      // The three finder corners already own their areas.
      const nearFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          (modules[row + r] ?? [])[column + c] = dark;
          (reserved[row + r] ?? [])[column + c] = true;
        }
      }
    }
  }
}

function placeTimingAndReserved(modules: boolean[][], reserved: boolean[][], version: number): void {
  const size = modules.length;
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    (modules[6] ?? [])[i] = dark;
    (reserved[6] ?? [])[i] = true;
    (modules[i] ?? [])[6] = dark;
    (reserved[i] ?? [])[6] = true;
  }
  // The dark module, always set, at (4*version + 9, 8).
  (modules[4 * version + 9] ?? [])[8] = true;
  (reserved[4 * version + 9] ?? [])[8] = true;
  // Format information areas.
  for (let i = 0; i < 9; i += 1) {
    if (!(reserved[8] ?? [])[i]) (reserved[8] ?? [])[i] = true;
    if (!(reserved[i] ?? [])[8]) (reserved[i] ?? [])[8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    (reserved[8] ?? [])[size - 1 - i] = true;
    (reserved[size - 1 - i] ?? [])[8] = true;
  }
  // Version information areas, from version 7.
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        (reserved[size - 11 + j] ?? [])[i] = true;
        (reserved[i] ?? [])[size - 11 + j] = true;
      }
    }
  }
}

/** 15-bit BCH format information for level M and a mask, XOR 0x5412. */
export function formatBits(mask: number): number {
  // Level M is 0b00, so the five data bits are 0b00 followed by the three mask bits.
  let value = mask & 7;
  let bch = value << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((bch >>> (10 + i)) & 1) bch ^= 0x537 << i;
  }
  value = ((value << 10) | bch) ^ 0x5412;
  return value & 0x7fff;
}

function placeFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    // Around the top-left finder.
    if (i < 6) (modules[i] ?? [])[8] = dark;
    else if (i === 6) (modules[7] ?? [])[8] = dark;
    else if (i === 7) (modules[8] ?? [])[8] = dark;
    else if (i === 8) (modules[8] ?? [])[7] = dark;
    else (modules[8] ?? [])[14 - i] = dark;
    // The duplicate copy, split between the other two corners.
    if (i < 8) (modules[8] ?? [])[size - 1 - i] = dark;
    else (modules[size - 15 + i] ?? [])[8] = dark;
  }
}

function placeVersion(modules: boolean[][], version: number): void {
  if (version < 7) return;
  const size = modules.length;
  const bits = VERSION_INFO[version];
  if (bits === undefined) throw new QrError(`no version information recorded for version ${version}`);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const column = i % 3;
    (modules[size - 11 + column] ?? [])[row] = dark;
    (modules[row] ?? [])[size - 11 + column] = dark;
  }
}

function maskAt(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    case 7: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: throw new QrError(`mask ${mask} is outside 0..7`);
  }
}

/** Interleaves blocks as the standard requires, data first then EC. */
function interleave(codewords: readonly number[], spec: VersionSpec): number[] {
  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    blocks.push(codewords.slice(offset, offset + spec.group1Data));
    offset += spec.group1Data;
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    blocks.push(codewords.slice(offset, offset + spec.group2Data));
    offset += spec.group2Data;
  }
  const ecBlocks = blocks.map((block) => rsEncode(block, spec.ecPerBlock));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) {
      const value = block[i];
      if (value !== undefined) out.push(value);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      const value = block[i];
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

/** The module order data occupies: two-column strips, right to left, alternating direction. */
function placeData(modules: boolean[][], reserved: boolean[][], bytes: readonly number[], mask: number): void {
  const size = modules.length;
  let bitIndex = 0;
  const nextBit = (): boolean => {
    const byte = bytes[bitIndex >>> 3];
    if (byte === undefined) return false;
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex += 1;
    return bit === 1;
  };
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    const columnPair = right === 6 ? [5, 4] : [right, right - 1];
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of columnPair) {
        if ((reserved[row] ?? [])[column]) continue;
        const dark = nextBit();
        (modules[row] ?? [])[column] = maskAt(mask, row, column) ? !dark : dark;
      }
    }
    if (right === 6) right -= 1;
    upward = !upward;
  }
}

/** The four penalty rules, used to pick the mask the standard would pick. */
function penalty(modules: readonly boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const run = (get: (i: number, j: number) => boolean): void => {
    for (let i = 0; i < size; i += 1) {
      let length = 1;
      for (let j = 1; j < size; j += 1) {
        if (get(i, j) === get(i, j - 1)) {
          length += 1;
        } else {
          if (length >= 5) score += 3 + (length - 5);
          length = 1;
        }
      }
      if (length >= 5) score += 3 + (length - 5);
    }
  };
  run((i, j) => (modules[i] ?? [])[j] ?? false);
  run((i, j) => (modules[j] ?? [])[i] ?? false);

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const a = (modules[row] ?? [])[column];
      if (
        a === (modules[row] ?? [])[column + 1] &&
        a === (modules[row + 1] ?? [])[column] &&
        a === (modules[row + 1] ?? [])[column + 1]
      ) {
        score += 3;
      }
    }
  }

  const FINDER = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (values: readonly boolean[]): number => {
    let found = 0;
    for (let i = 0; i + 11 <= values.length; i += 1) {
      const forward = FINDER.every((bit, k) => values[i + k] === bit);
      const backward = FINDER.every((bit, k) => values[i + 10 - k] === bit);
      if (forward || backward) found += 1;
    }
    return found;
  };
  for (let i = 0; i < size; i += 1) {
    const row: boolean[] = [];
    const column: boolean[] = [];
    for (let j = 0; j < size; j += 1) {
      row.push((modules[i] ?? [])[j] ?? false);
      column.push((modules[j] ?? [])[i] ?? false);
    }
    score += 40 * (matches(row) + matches(column));
  }

  let dark = 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) if ((modules[i] ?? [])[j]) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

/**
 * Encodes `text` as a QR matrix, choosing the smallest version that fits and the mask the
 * standard's penalty rules select.
 */
export function encodeQr(text: string): QrMatrix {
  if (typeof text !== 'string' || text.length === 0) throw new QrError('nothing to encode');
  const bytes = toBytes(text);
  const version = qrVersionFor(bytes.length);
  const spec = VERSION_SPECS[version];
  if (spec === undefined) throw new QrError(`no block specification for version ${version}`);

  const writer = new BitWriter();
  writer.push(0b0100, 4); // byte mode
  writer.push(bytes.length, countBits(version));
  for (const byte of bytes) writer.push(byte, 8);
  const interleaved = interleave(writer.toCodewords(dataCodewords(spec)), spec);

  const size = 17 + 4 * version;
  let best: QrMatrix | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const { modules, reserved } = emptyGrid(size);
    placeFinder(modules, reserved, 0, 0);
    placeFinder(modules, reserved, 0, size - 7);
    placeFinder(modules, reserved, size - 7, 0);
    placeAlignment(modules, reserved, version);
    placeTimingAndReserved(modules, reserved, version);
    placeData(modules, reserved, interleaved, mask);
    placeFormat(modules, mask);
    placeVersion(modules, version);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { size, version, mask, modules };
    }
  }
  if (best === undefined) throw new QrError('no mask produced a matrix');
  return best;
}

/**
 * The matrix as an SVG path, with a quiet zone.
 *
 * One `<path>` of rectangles rather than one element per module: a version-7 symbol is 45×45, and
 * two thousand DOM nodes per render is a real cost on a phone for no benefit.
 */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if ((matrix.modules[row] ?? [])[column]) parts.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return parts.join('');
}

/** The standard's four-module quiet zone, which scanners need to find the symbol. */
export const QR_QUIET_ZONE = 4;

export function qrViewBox(matrix: QrMatrix): string {
  const span = matrix.size + QR_QUIET_ZONE * 2;
  return `${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${span} ${span}`;
}
