/**
 * Chain identity for both layers: which networks exist, how each one is named on the wire, and
 * how an address proves which network it belongs to.
 *
 * WHY THIS MODULE IS THE FOUNDATION OF EVERYTHING ELSE HERE
 *
 * The failure this subsystem exists to prevent is a testnet value silently becoming a mainnet
 * destination. Every other guard — manifests, readiness, donation configuration — reduces to one
 * question: *does this value belong to the network I think I am on?* That question is answerable
 * only against an authoritative identity table and real address parsing, so both live here and
 * nothing below them is taken on trust.
 *
 * EVERY CONSTANT IS READ FROM UPSTREAM SOURCE, AND SAYS WHERE
 *
 *   * Network bytes: `crates/ootle_network/src/lib.rs` at Ootle `6a25dbc` (v0.48.0), whose enum
 *     carries the comment "The variants and assigned byte needs to match the L1 network enum" —
 *     cross-checked against `base_layer/common_types/src/configuration/network.rs` in
 *     `tari-project/tari` 6.3.0-pre.2, which agrees byte for byte.
 *   * Ootle address HRPs: `crates/ootle_address/src/hrp.rs`, same cohort.
 *   * Ootle address layout: `crates/ootle_address/src/ootle_address.rs` — bech32m over
 *     account key (32) ++ view-only key (32) ++ optional destination tag (1..=64).
 *   * Minotari address layout: `base_layer/common_types/src/tari_address/` — a THREE-PART base58
 *     encoding over network byte ++ features byte ++ keys ++ optional payment id ++ DammSum.
 *
 * THE ONE THING THE TWO CHAINS SHARE, AND THE MANY THEY DO NOT
 *
 * They share the network discriminant BYTE, and only because upstream requires it. They share
 * nothing else: an L1 address is base58 with a features byte and a DammSum checksum, an L2 address
 * is bech32m with a network-specific human-readable prefix, and neither parses as the other. A
 * caller must never derive one from the other, and `addressNetwork` refuses to guess.
 */

export class ChainIdentityError extends Error {}

/** Every network either chain defines. Not every one is reachable; see the registry. */
export type TariNetwork = 'mainnet' | 'stagenet' | 'nextnet' | 'localnet' | 'igor' | 'esmeralda';

export const TARI_NETWORKS: readonly TariNetwork[] = ['mainnet', 'stagenet', 'nextnet', 'localnet', 'igor', 'esmeralda'];

/**
 * The network discriminant byte, shared by both layers.
 *
 * Checked against `GET /info`'s `network_byte` on L2 and against an address's leading byte on L1,
 * so an endpoint or an address that merely answers plausibly cannot pass for the wrong chain.
 */
export const NETWORK_BYTES: Readonly<Record<TariNetwork, number>> = {
  mainnet: 0x00,
  stagenet: 0x01,
  nextnet: 0x02,
  localnet: 0x10,
  igor: 0x24,
  esmeralda: 0x26,
};

/** Reverse lookup. `undefined` for a byte no network claims — which must fail closed. */
export function networkForByte(byte: number): TariNetwork | undefined {
  if (!Number.isInteger(byte)) return undefined;
  for (const network of TARI_NETWORKS) {
    if (NETWORK_BYTES[network] === byte) return network;
  }
  return undefined;
}

/**
 * Ootle L2 bech32m human-readable prefixes. These make an L2 address SELF-IDENTIFYING: a mainnet
 * address cannot be read as an Esmeralda one, because the prefix is part of the checksummed string.
 */
export const OOTLE_ADDRESS_HRP: Readonly<Record<TariNetwork, string>> = {
  mainnet: 'otl_',
  stagenet: 'otl_stg_',
  nextnet: 'otl_nxt_',
  localnet: 'otl_loc_',
  igor: 'otl_igr_',
  esmeralda: 'otl_esm_',
};

/** Upstream's own predicate: mainnet is the only network that is not a testnet. */
export function isTestnet(network: TariNetwork): boolean {
  return network !== 'mainnet';
}

/** Parses a network name as the SDKs spell it on the wire (lowercase, no aliases invented here). */
export function networkFromName(value: unknown): TariNetwork | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return (TARI_NETWORKS as readonly string[]).includes(name) ? (name as TariNetwork) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Minotari L1 addresses
// ---------------------------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Internal byte lengths, from `tari_address/mod.rs`. */
const L1_SINGLE_BYTES = 35;
const L1_DUAL_BYTES = 67;
const L1_MAX_PAYMENT_ID_BYTES = 256;
/** base58 string bounds the upstream parser itself enforces before decoding. */
const L1_BASE58_MIN = 45;
const L1_BASE58_MAX = 443;

/**
 * DammSum mask, from `base_layer/common_types/src/dammsum.rs`: `COEFFICIENTS = [4, 3, 1]`, and
 * `MASK = 1 + 2^4 + 2^3 + 2^1`. A valid address's checksum over the WHOLE byte string is zero.
 */
const DAMMSUM_MASK = 1 + (1 << 4) + (1 << 3) + (1 << 1);

/** The features bits a Minotari address can carry, from `TariAddressFeatures`. */
export const L1_ADDRESS_FEATURES = {
  PAYMENT_ID: 0b0000_0100,
  INTERACTIVE: 0b0000_0010,
  ONE_SIDED: 0b0000_0001,
} as const;

export type L1AddressFeature = keyof typeof L1_ADDRESS_FEATURES;

export interface MinotariAddress {
  readonly base58: string;
  readonly network: TariNetwork;
  readonly networkByte: number;
  /** `dual` carries a view key and a spend key; `single` carries only a spend key. */
  readonly kind: 'single' | 'dual';
  readonly featuresByte: number;
  readonly features: readonly L1AddressFeature[];
  /** Bytes of payment id carried in the address, if any. Dual addresses only. */
  readonly paymentIdBytes: number;
}

function base58Decode(text: string): number[] {
  let acc = 0n;
  for (const character of text) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) throw new ChainIdentityError(`"${character}" is not a base58 character`);
    acc = acc * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (acc > 0n) {
    bytes.unshift(Number(acc & 0xffn));
    acc >>= 8n;
  }
  // Leading '1's are leading zero bytes, which carry meaning: the mainnet network byte is 0x00.
  for (const character of text) {
    if (character !== BASE58_ALPHABET[0]) break;
    bytes.unshift(0);
  }
  return bytes;
}

function dammsum(bytes: readonly number[]): number {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte;
    const overflow = (result & 0x80) !== 0;
    result = (result << 1) & 0xff;
    if (overflow) result ^= DAMMSUM_MASK;
  }
  return result & 0xff;
}

/**
 * Parses a Minotari L1 address, with the checks the upstream parser makes and in its order.
 *
 * THIS IS NOT A STRING CHECK, and the distinction is the point. The encoding is three separate
 * base58 blocks — byte 0, byte 1, then the rest — concatenated, so decoding the whole string as
 * one base58 number produces different bytes and a plausible-looking address that is not one. A
 * regex over the alphabet would accept a typo; the DammSum checksum will not.
 *
 * What a successful parse establishes: the string is well formed, its checksum holds, its length
 * is one the chain accepts, and its leading byte names a network this build knows. What it does
 * NOT establish: that any funds exist there, or that the holder of the keys is who a UI says.
 */
export function parseMinotariAddress(value: unknown): MinotariAddress {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new ChainIdentityError('A Minotari address must be a string with no surrounding whitespace');
  }
  if (value.length < L1_BASE58_MIN || value.length > L1_BASE58_MAX) {
    throw new ChainIdentityError(
      `A Minotari address is ${L1_BASE58_MIN}..${L1_BASE58_MAX} base58 characters; this is ${value.length}`,
    );
  }
  // Three separate base58 blocks, exactly as `TariAddress::to_base58` writes them.
  const bytes = [
    ...base58Decode(value.slice(0, 1)),
    ...base58Decode(value.slice(1, 2)),
    ...base58Decode(value.slice(2)),
  ];
  const length = bytes.length;
  const isSingle = length === L1_SINGLE_BYTES;
  const isDual = length >= L1_DUAL_BYTES && length <= L1_DUAL_BYTES + L1_MAX_PAYMENT_ID_BYTES;
  if (!isSingle && !isDual) {
    throw new ChainIdentityError(
      `A Minotari address decodes to ${L1_SINGLE_BYTES} bytes (single) or ${L1_DUAL_BYTES}..${L1_DUAL_BYTES + L1_MAX_PAYMENT_ID_BYTES} bytes (dual); this decodes to ${length}`,
    );
  }
  if (dammsum(bytes) !== 0) {
    throw new ChainIdentityError('This Minotari address fails its DammSum checksum: a character is wrong, missing or added');
  }
  const networkByte = bytes[0] ?? -1;
  const network = networkForByte(networkByte);
  if (network === undefined) {
    throw new ChainIdentityError(`This address names network byte 0x${networkByte.toString(16).padStart(2, '0')}, which no Tari network claims`);
  }
  const featuresByte = bytes[1] ?? 0;
  const known = Object.values(L1_ADDRESS_FEATURES).reduce((all, bit) => all | bit, 0);
  if ((featuresByte & ~known) !== 0) {
    throw new ChainIdentityError(`This address sets unknown feature bits (0x${featuresByte.toString(16)})`);
  }
  const features = (Object.keys(L1_ADDRESS_FEATURES) as L1AddressFeature[]).filter(
    (name) => (featuresByte & L1_ADDRESS_FEATURES[name]) !== 0,
  );
  return {
    base58: value,
    network,
    networkByte,
    kind: isSingle ? 'single' : 'dual',
    featuresByte,
    features,
    paymentIdBytes: isSingle ? 0 : length - L1_DUAL_BYTES,
  };
}

// ---------------------------------------------------------------------------------------------
// Ootle L2 addresses
// ---------------------------------------------------------------------------------------------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** Key length and destination-tag bound, from `ootle_address.rs` and `destination_tag.rs`. */
const L2_KEY_BYTES = 32;
const L2_MAX_DESTINATION_TAG_BYTES = 64;

export interface OotleAddress {
  readonly bech32: string;
  readonly network: TariNetwork;
  readonly hrp: string;
  /** 64-hex account (spend) public key. */
  readonly accountPublicKeyHex: string;
  /** 64-hex view-only public key. */
  readonly viewPublicKeyHex: string;
  readonly destinationTagBytes: number;
}

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if (((top >>> i) & 1) !== 0) checksum ^= BECH32_GENERATOR[i] ?? 0;
    }
  }
  return checksum >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) {
    const code = hrp.charCodeAt(i);
    high.push(code >>> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/** 5-bit groups to bytes, refusing any padding a valid encoding would not produce. */
function fromWords(words: readonly number[]): number[] {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    if (word < 0 || word > 31) throw new ChainIdentityError('bech32 data contains a value outside 0..31');
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits >= 5) throw new ChainIdentityError('bech32 data has excess padding');
  if (((accumulator << (8 - bits)) & 0xff) !== 0) throw new ChainIdentityError('bech32 data has non-zero padding');
  return bytes;
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The HRP for a network, or `undefined` for a prefix no network claims. */
export function networkForHrp(hrp: string): TariNetwork | undefined {
  for (const network of TARI_NETWORKS) {
    if (OOTLE_ADDRESS_HRP[network] === hrp) return network;
  }
  return undefined;
}

/**
 * Parses an Ootle L2 address: real bech32m, with the checksum verified and the payload laid out
 * as upstream writes it.
 *
 * The bech32m checksum covers the HRP, which is what makes an L2 address self-identifying: a
 * mainnet `otl_` address cannot be relabelled `otl_esm_` without breaking it. That property is
 * why network checks on this chain can be made from the address alone, and why an L2 donation
 * destination can be validated for its intended network with no chain read at all.
 */
export function parseOotleAddress(value: unknown): OotleAddress {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new ChainIdentityError('An Ootle address must be a string with no surrounding whitespace');
  }
  if (value.length > 400) throw new ChainIdentityError('An Ootle address is at most 400 characters');
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
    throw new ChainIdentityError('A bech32m string must not mix upper and lower case');
  }
  const text = value.toLowerCase();
  const separator = text.lastIndexOf('1');
  if (separator < 1) throw new ChainIdentityError('An Ootle address has no bech32 separator');
  const hrp = text.slice(0, separator);
  const dataPart = text.slice(separator + 1);
  if (dataPart.length < 6) throw new ChainIdentityError('An Ootle address has no bech32 checksum');
  const words: number[] = [];
  for (const character of dataPart) {
    const index = BECH32_CHARSET.indexOf(character);
    if (index < 0) throw new ChainIdentityError(`"${character}" is not a bech32 character`);
    words.push(index);
  }
  if (bech32Polymod([...hrpExpand(hrp), ...words]) !== BECH32M_CONST) {
    throw new ChainIdentityError('This Ootle address fails its bech32m checksum: a character is wrong, missing or added');
  }
  const network = networkForHrp(`${hrp}_`) ?? networkForHrp(hrp);
  if (network === undefined) {
    throw new ChainIdentityError(
      `"${hrp}_" is not an Ootle network prefix. Known prefixes: ${TARI_NETWORKS.map((n) => OOTLE_ADDRESS_HRP[n]).join(', ')}`,
    );
  }
  const payload = fromWords(words.slice(0, words.length - 6));
  if (payload.length < L2_KEY_BYTES * 2) {
    throw new ChainIdentityError(`An Ootle address carries at least ${L2_KEY_BYTES * 2} payload bytes; this carries ${payload.length}`);
  }
  const tagBytes = payload.length - L2_KEY_BYTES * 2;
  if (tagBytes > L2_MAX_DESTINATION_TAG_BYTES) {
    throw new ChainIdentityError(`An Ootle destination tag is at most ${L2_MAX_DESTINATION_TAG_BYTES} bytes; this carries ${tagBytes}`);
  }
  return {
    bech32: text,
    network,
    hrp: OOTLE_ADDRESS_HRP[network],
    accountPublicKeyHex: toHex(payload.slice(0, L2_KEY_BYTES)),
    viewPublicKeyHex: toHex(payload.slice(L2_KEY_BYTES, L2_KEY_BYTES * 2)),
    destinationTagBytes: tagBytes,
  };
}

// ---------------------------------------------------------------------------------------------
// Cross-layer: which network a value belongs to, without guessing
// ---------------------------------------------------------------------------------------------

export type AddressLayer = 'L1_MINOTARI' | 'L2_OOTLE';

export interface AddressIdentity {
  readonly layer: AddressLayer;
  readonly network: TariNetwork;
}

/**
 * Which layer and network an address belongs to, by PARSING it on both — never by prefix alone.
 *
 * Returns `undefined` when neither parse succeeds, and every caller must treat that as a refusal.
 * This is the function a donation destination, a swap recipient and a manifest entry all go
 * through, because "which network is this for" must have exactly one answer and one implementation.
 */
export function addressIdentity(value: unknown): AddressIdentity | undefined {
  try {
    return { layer: 'L2_OOTLE', network: parseOotleAddress(value).network };
  } catch {
    /* not an Ootle address; try L1 */
  }
  try {
    return { layer: 'L1_MINOTARI', network: parseMinotariAddress(value).network };
  } catch {
    return undefined;
  }
}

export type NetworkMatch =
  | { readonly ok: true; readonly identity: AddressIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * Asserts that an address belongs to the layer AND network a caller intends.
 *
 * The refusal text names both the expected and the actual network, because the dangerous case is
 * not a malformed address — it is a perfectly valid address for the wrong chain, which looks
 * entirely normal right up to the moment funds are irrecoverable.
 */
export function requireAddressFor(value: unknown, expect: { readonly layer: AddressLayer; readonly network: TariNetwork }): NetworkMatch {
  const identity = addressIdentity(value);
  if (identity === undefined) {
    return { ok: false, reason: 'This is not a valid Minotari or Ootle address. It was parsed as both and failed both.' };
  }
  if (identity.layer !== expect.layer) {
    const want = expect.layer === 'L1_MINOTARI' ? 'a Minotari base-layer (L1) address' : 'an Ootle (L2) address';
    const got = identity.layer === 'L1_MINOTARI' ? 'a Minotari base-layer (L1) address' : 'an Ootle (L2) address';
    return {
      ok: false,
      reason: `This is ${got}, but ${want} is required. The two layers are different networks with different assets, addresses and wallets; one is never a destination for the other.`,
    };
  }
  if (identity.network !== expect.network) {
    return {
      ok: false,
      reason: `This address is for ${identity.network}, but ${expect.network} is required. Sending to it would send to a different network.`,
    };
  }
  return { ok: true, identity };
}
