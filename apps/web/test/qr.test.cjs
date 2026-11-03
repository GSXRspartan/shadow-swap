/**
 * The QR encoder, verified three ways, because it renders a destination for money.
 *
 * 1. Against ISO/IEC 18004 Annex A: every Reed–Solomon generator polynomial this encoder uses
 *    must equal the published one, compared as alpha exponents.
 * 2. Against the published capacity table: the byte capacity derived from the block structure
 *    must match the standard's figures for level M, version by version.
 * 3. By ROUND TRIP through an independent reader, written here, which recovers the mask from the
 *    symbol's own format word and reverses the module placement. It shares no code with the
 *    encoder's bit writing, padding or block building, so a placement, masking or interleaving
 *    error shows up as a payload that does not come back.
 *
 * Worth stating plainly: a mis-encoded QR symbol FAILS TO DECODE rather than decoding to a
 * different string, because the symbol carries its own error correction and a BCH-protected
 * format word. The risk this guards against is an unscannable code, not a misdirected donation —
 * and the address is always shown as text with a copy control regardless.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../build-test/lib/qr.js');
const pc = require('@tari-ootle/protocol-client');

/** GF(256) with the QR primitive polynomial, built independently of the encoder's own table. */
const EXP = new Array(256);
const LOG = new Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
}

/** ISO/IEC 18004 Annex A generator polynomials, as alpha exponents. */
const PUBLISHED_GENERATORS = {
  10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
  16: [0, 120, 104, 107, 109, 102, 161, 76, 3, 91, 191, 147, 169, 182, 194, 225, 120],
  18: [0, 215, 234, 158, 94, 184, 97, 118, 170, 79, 187, 152, 148, 252, 179, 5, 98, 96, 153],
  22: [0, 210, 171, 247, 242, 93, 230, 14, 109, 221, 53, 200, 74, 8, 172, 98, 80, 219, 134, 160, 105, 165, 231],
  24: [0, 229, 121, 135, 48, 211, 117, 251, 126, 159, 180, 169, 152, 192, 226, 228, 218, 111, 0, 117, 232, 87, 96, 227, 21],
  26: [0, 173, 125, 158, 2, 103, 182, 118, 17, 145, 201, 111, 28, 165, 53, 161, 21, 245, 142, 13, 102, 48, 227, 153, 145, 218, 70],
};

/** The standard's published byte capacities at error-correction level M. */
const PUBLISHED_CAPACITIES = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };

test('every Reed-Solomon generator matches ISO/IEC 18004 Annex A', () => {
  for (const [degree, published] of Object.entries(PUBLISHED_GENERATORS)) {
    const mine = qr.rsGenerator(Number(degree)).map((coefficient) => LOG[coefficient]);
    assert.deepEqual(mine, published, `generator for ${degree} EC codewords`);
  }
});

test('byte capacities match the published level-M table, derived from the block structure', () => {
  for (const [version, capacity] of Object.entries(PUBLISHED_CAPACITIES)) {
    assert.equal(qr.qrByteCapacity(Number(version)), capacity, `version ${version}`);
    // And the block table is self-consistent: data codewords equal the groups' sum.
    const spec = qr.qrVersionSpec(Number(version));
    const data = spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
    const headerBits = 4 + (Number(version) <= 9 ? 8 : 16);
    assert.equal(Math.floor((data * 8 - headerBits) / 8), capacity);
  }
  assert.deepEqual(qr.QR_CAPACITIES, PUBLISHED_CAPACITIES);
  // The smallest version that fits is chosen, at every boundary.
  assert.equal(qr.qrVersionFor(14), 1);
  assert.equal(qr.qrVersionFor(15), 2);
  assert.equal(qr.qrVersionFor(106), 6);
  assert.equal(qr.qrVersionFor(107), 7);
  assert.equal(qr.qrVersionFor(213), 10);
  // Over capacity is a refusal, never a truncation.
  assert.throws(() => qr.qrVersionFor(214), /refuses rather than truncating/);
  assert.throws(() => qr.encodeQr('x'.repeat(214)), /refuses rather than truncating/);
});

test('the format word for level M, mask 0 is the standard\'s own XOR constant', () => {
  assert.equal(qr.formatBits(0), 0x5412);
  // All eight are distinct 15-bit words, as the BCH code requires.
  const words = new Set();
  for (let mask = 0; mask < 8; mask += 1) {
    const bits = qr.formatBits(mask);
    assert.ok(bits <= 0x7fff, `mask ${mask} fits in 15 bits`);
    words.add(bits);
  }
  assert.equal(words.size, 8, 'every mask has its own format word');
});

/**
 * An independent reader. It re-derives the function-pattern map from the symbol's geometry, reads
 * the mask out of the format word, reverses the zigzag and de-interleaves — then parses the
 * header. No encoder internals are consulted beyond the published block table.
 */
function readSymbol(matrix) {
  const { size, version, modules } = matrix;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true;
  };
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(br + r, bc + c);
  }
  const CENTRES = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }[version];
  for (const r of CENTRES) {
    for (const c of CENTRES) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
    }
  }
  for (let i = 8; i < size - 8; i += 1) { mark(6, i); mark(i, 6); }
  mark(4 * version + 9, 8);
  for (let i = 0; i < 9; i += 1) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i += 1) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 3; j += 1) { mark(size - 11 + j, i); mark(i, size - 11 + j); }
  }

  let raw = 0;
  for (let i = 0; i < 15; i += 1) {
    let bit;
    if (i < 6) bit = modules[i][8];
    else if (i === 6) bit = modules[7][8];
    else if (i === 7) bit = modules[8][8];
    else if (i === 8) bit = modules[8][7];
    else bit = modules[8][14 - i];
    if (bit) raw |= 1 << i;
  }
  const unmasked = raw ^ 0x5412;
  const level = (unmasked >>> 13) & 3;
  const mask = (unmasked >>> 10) & 7;

  const maskAt = (m, r, c) => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const pair = right === 6 ? [5, 4] : [right, right - 1];
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of pair) {
        if (reserved[row][column]) continue;
        const stored = modules[row][column];
        bits.push((maskAt(mask, row, column) ? !stored : stored) ? 1 : 0);
      }
    }
    if (right === 6) right -= 1;
    upward = !upward;
  }
  const stream = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    stream.push(byte);
  }

  const spec = qr.qrVersionSpec(version);
  const sizes = [...Array(spec.group1Blocks).fill(spec.group1Data), ...Array(spec.group2Blocks).fill(spec.group2Data)];
  const blocks = sizes.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...sizes); i += 1) {
    for (let b = 0; b < blocks.length; b += 1) if (i < sizes[b]) blocks[b].push(stream[index++]);
  }
  const data = blocks.flat();

  let position = 0;
  const take = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = data[position >> 3];
      value = (value << 1) | ((byte >> (7 - (position & 7))) & 1);
      position += 1;
    }
    return value;
  };
  const mode = take(4);
  const count = take(version <= 9 ? 8 : 16);
  let text = '';
  for (let i = 0; i < count; i += 1) text += String.fromCharCode(take(8));
  return { level, mask, mode, count, text };
}

test('EVERY PAYLOAD ROUND-TRIPS EXACTLY, including both real donation address shapes', () => {
  const ootleShape = `otl_1${'q'.repeat(108)}`;
  const cases = [
    pc.XTM_DONATION_ADDRESS_MAINNET,
    'otl_loc_1nsy5c5mfn7jgmg5nm3s3m4vr829tgpeehmymkme6k5wszde6wc7zcfwtyyxwn62tqefqyfyjangalt4zrygzwyf8c6c2jtfqyd8dk0gtwcv5x',
    ootleShape,
    'A',
    'hello world',
    'x'.repeat(14),
    'x'.repeat(15),
    'x'.repeat(106),
    'x'.repeat(107),
    'x'.repeat(122),
    'x'.repeat(213),
  ];
  for (const text of cases) {
    const matrix = qr.encodeQr(text);
    const decoded = readSymbol(matrix);
    assert.equal(decoded.text, text, `payload for ${text.length} bytes (version ${matrix.version})`);
    assert.equal(decoded.mode, 4, 'byte mode');
    assert.equal(decoded.count, text.length);
    assert.equal(decoded.level, 0, 'error-correction level M');
    assert.equal(decoded.mask, matrix.mask, 'the mask read from the format word is the one used');
    assert.equal(matrix.size, 17 + 4 * matrix.version);
  }
});

test('the symbol carries its function patterns, so a scanner can find and orient it', () => {
  const matrix = qr.encodeQr(pc.XTM_DONATION_ADDRESS_MAINNET);
  const { modules, size } = matrix;
  // Three finder patterns: dark ring, light ring, dark 3x3 core.
  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[row][column], true, 'finder outer corner is dark');
    assert.equal(modules[row + 1][column + 1], false, 'finder separator ring is light');
    assert.equal(modules[row + 3][column + 3], true, 'finder core is dark');
  }
  // The dark module, which is always set.
  assert.equal(modules[4 * matrix.version + 9][8], true);
  // The timing patterns alternate.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
  // A quiet zone is included in the view box, which scanners need.
  assert.equal(qr.QR_QUIET_ZONE, 4);
  assert.equal(qrViewBoxSpan(matrix), size + 8);
  // The path is non-empty and made only of unit squares.
  const path = qr.qrSvgPath(matrix);
  assert.ok(path.length > 0);
  assert.equal(/[^M0-9 hvz.\-]/.test(path), false, 'the path uses only move/horizontal/vertical/close');
});

function qrViewBoxSpan(matrix) {
  const parts = qr.qrViewBox(matrix).split(' ').map(Number);
  return parts[2];
}

test('non-ASCII input is refused rather than mangled', () => {
  // Byte mode is ISO-8859-1. An address is ASCII, so a wide character is a sign the wrong value
  // was passed — a resource symbol, say — and silently encoding it would hide that.
  assert.throws(() => qr.encodeQr('TARI→XTM'), /outside ISO-8859-1/);
  assert.throws(() => qr.encodeQr(''), /nothing to encode/);
  assert.throws(() => qr.encodeQr(undefined), /nothing to encode/);
});
