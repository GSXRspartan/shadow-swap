/**
 * Ootle v0.48 instruction ARGUMENT encoding: `InstructionArg::Literal(bytes)`.
 *
 * Upstream (`crates/transaction/src/args.rs` at the pinned cohort) defines an instruction
 * argument as `Workspace(WorkspaceOffsetId) | Literal(Bytes) | Blob(BlobIndex)`, and a
 * Literal's bytes are the `tari_bor` (minicbor) encoding of the value, hex in JSON:
 *
 *   { "Literal": "<hex>" }
 *
 * A bare JSON string is NOT an argument. Every encoding here is pinned, byte for byte, to
 * what the real engine's builder produced (`audit_engine_tests/tests/instruction_wire_v048.rs`
 * -> `apps/web/test/fixtures/ootle-v048-instructions.json`), not to a reading of the spec:
 *
 *   ResourceAddress   tag 131 + bytes(32)        ComponentAddress  tag 128 + bytes(32)
 *   Amount (u128)     uint if <= u64::MAX, else tag 2 (bignum) + minimal big-endian bytes
 *   u16/u32/u64       uint                       bool              f5 / f4
 *   String            text                       Hash32/PublicKey  bytes(32)
 *   Vec<u8>           ARRAY of uints (not a CBOR byte string)
 *   NonFungibleId     [variant, [payload]]: 0 U256 bytes(32), 1 String text, 2 Uint32, 3 Uint64
 *   Option<T>         None -> null (f6); Some(x) -> x, unwrapped
 *
 * Every value is validated against its declared type before a byte is emitted; an argument
 * whose type is not declared is refused (the serializer never guesses a type from a string's
 * shape, because the same string can be a valid value of two different types).
 */

export type ScalarArgType =
  | 'Amount'
  | 'ResourceAddress'
  | 'ComponentAddress'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'bool'
  | 'String'
  | 'Hash32'
  | 'PublicKey'
  | 'Bytes'
  | 'NonFungibleId';

export type OptionArgType = `Option<${ScalarArgType}>`;

/** `Bucket` is a workspace reference; every other type is a Literal. */
export type ArgType = 'Bucket' | ScalarArgType | OptionArgType;

export type LiteralValue = string | boolean | null;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const TAG_COMPONENT = 128;
const TAG_RESOURCE = 131;
const TAG_BIGNUM = 2;
const NFT_STRING_MAX = 64;

class Cbor {
  readonly bytes: number[] = [];

  head(major: number, n: bigint): this {
    const m = major << 5;
    if (n < 24n) this.bytes.push(m | Number(n));
    else if (n <= 0xffn) this.bytes.push(m | 24, Number(n));
    else if (n <= 0xffffn) this.bytes.push(m | 25, ...be(n, 2));
    else if (n <= 0xffff_ffffn) this.bytes.push(m | 26, ...be(n, 4));
    else if (n <= U64_MAX) this.bytes.push(m | 27, ...be(n, 8));
    else throw new LiteralEncodingError(`CBOR head ${n} exceeds 64 bits`);
    return this;
  }

  uint(n: bigint): this {
    return this.head(0, n);
  }

  byteString(b: readonly number[]): this {
    this.head(2, BigInt(b.length));
    this.bytes.push(...b);
    return this;
  }

  text(s: string): this {
    const utf8 = [...new TextEncoder().encode(s)];
    this.head(3, BigInt(utf8.length));
    this.bytes.push(...utf8);
    return this;
  }

  array(len: number): this {
    return this.head(4, BigInt(len));
  }

  tag(t: number): this {
    return this.head(6, BigInt(t));
  }

  hex(): string {
    return this.bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function be(n: bigint, width: number): number[] {
  const out: number[] = [];
  for (let i = width - 1; i >= 0; i -= 1) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
}

export class LiteralEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiteralEncodingError';
  }
}

function fail(type: string, value: unknown, why: string): never {
  throw new LiteralEncodingError(`Cannot encode ${JSON.stringify(value)} as ${type}: ${why}.`);
}

function hex32(value: unknown, type: string): number[] {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(type, value, 'expected exactly 64 lowercase hex characters');
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(Number.parseInt(value.slice(i, i + 2), 16));
  return out;
}

function hexBytes(value: unknown, type: string): number[] {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value)) fail(type, value, 'expected an even-length lowercase hex string');
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 2) out.push(Number.parseInt(value.slice(i, i + 2), 16));
  return out;
}

function unsigned(value: unknown, type: string, max: bigint): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail(type, value, 'expected a canonical non-negative integer string');
  const n = BigInt(value);
  if (n > max) fail(type, value, `exceeds ${max}`);
  return n;
}

function address(value: unknown, type: string, prefix: string): number[] {
  if (typeof value !== 'string' || !value.startsWith(prefix)) fail(type, value, `expected ${prefix}<64 hex>`);
  return hex32(value.slice(prefix.length), type);
}

/** Parses upstream's canonical NonFungibleId string (`NonFungibleId::to_canonical_string`). */
export function parseCanonicalNftId(value: unknown): { variant: 0 | 1 | 2 | 3; payload: number[] | string | bigint } {
  if (typeof value !== 'string') fail('NonFungibleId', value, 'expected a canonical string');
  const sep = value.indexOf('_');
  if (sep < 0) fail('NonFungibleId', value, 'expected uuid_<hex>, str_<text>, u32_<n> or u64_<n>');
  const kind = value.slice(0, sep);
  const body = value.slice(sep + 1);
  switch (kind) {
    case 'uuid':
      return { variant: 0, payload: hex32(body, 'NonFungibleId(uuid)') };
    case 'str': {
      const len = new TextEncoder().encode(body).length;
      if (len === 0 || len > NFT_STRING_MAX) fail('NonFungibleId', value, `a string id is 1..${NFT_STRING_MAX} bytes`);
      return { variant: 1, payload: body };
    }
    case 'u32':
      return { variant: 2, payload: unsigned(body, 'NonFungibleId(u32)', 0xffff_ffffn) };
    case 'u64':
      return { variant: 3, payload: unsigned(body, 'NonFungibleId(u64)', U64_MAX) };
    default:
      return fail('NonFungibleId', value, `unknown id kind "${kind}"`);
  }
}

/** True for a string that `parseCanonicalNftId` accepts. */
export function isCanonicalNftId(value: unknown): value is string {
  try {
    parseCanonicalNftId(value);
    return true;
  } catch {
    return false;
  }
}

function encodeScalar(c: Cbor, type: ScalarArgType, value: LiteralValue): void {
  switch (type) {
    case 'ResourceAddress':
      c.tag(TAG_RESOURCE).byteString(address(value, type, 'resource_'));
      return;
    case 'ComponentAddress':
      c.tag(TAG_COMPONENT).byteString(address(value, type, 'component_'));
      return;
    case 'Amount': {
      const n = unsigned(value, type, U128_MAX);
      if (n <= U64_MAX) c.uint(n);
      else {
        const bytes: number[] = [];
        for (let v = n; v > 0n; v >>= 8n) bytes.unshift(Number(v & 0xffn));
        c.tag(TAG_BIGNUM).byteString(bytes);
      }
      return;
    }
    case 'u16':
      c.uint(unsigned(value, type, 0xffffn));
      return;
    case 'u32':
      c.uint(unsigned(value, type, 0xffff_ffffn));
      return;
    case 'u64':
      c.uint(unsigned(value, type, U64_MAX));
      return;
    case 'bool':
      if (typeof value !== 'boolean') fail(type, value, 'expected true or false');
      c.bytes.push(value ? 0xf5 : 0xf4);
      return;
    case 'String':
      if (typeof value !== 'string') fail(type, value, 'expected a string');
      c.text(value);
      return;
    case 'Hash32':
    case 'PublicKey':
      c.byteString(hex32(value, type));
      return;
    case 'Bytes': {
      // minicbor's generic `Vec<T>`: an array, one uint per byte (engine fixture "Bytes").
      const b = hexBytes(value, type);
      c.array(b.length);
      for (const x of b) c.uint(BigInt(x));
      return;
    }
    case 'NonFungibleId': {
      const id = parseCanonicalNftId(value);
      c.array(2).uint(BigInt(id.variant)).array(1);
      if (id.variant === 0) c.byteString(id.payload as number[]);
      else if (id.variant === 1) c.text(id.payload as string);
      else c.uint(id.payload as bigint);
      return;
    }
    default:
      fail(String(type), value, 'unknown argument type');
  }
}

const SCALARS: ReadonlySet<string> = new Set<ScalarArgType>(['Amount', 'ResourceAddress', 'ComponentAddress', 'u16', 'u32', 'u64', 'bool', 'String', 'Hash32', 'PublicKey', 'Bytes', 'NonFungibleId']);

export function isLiteralType(type: unknown): type is Exclude<ArgType, 'Bucket'> {
  if (typeof type !== 'string') return false;
  const inner = /^Option<(.+)>$/.exec(type)?.[1];
  return SCALARS.has(inner ?? type);
}

/** The hex payload of `{ Literal }` for one value of one declared type. */
export function encodeLiteral(type: Exclude<ArgType, 'Bucket'>, value: LiteralValue): string {
  if (!isLiteralType(type)) throw new LiteralEncodingError(`Unknown argument type ${JSON.stringify(type)}.`);
  const c = new Cbor();
  const inner = /^Option<(.+)>$/.exec(type)?.[1] as ScalarArgType | undefined;
  if (inner !== undefined) {
    if (value === null) c.bytes.push(0xf6);
    else encodeScalar(c, inner, value);
  } else {
    if (value === null) throw new LiteralEncodingError(`A ${type} argument cannot be null.`);
    encodeScalar(c, type as ScalarArgType, value);
  }
  return c.hex();
}

export function literalArg(type: Exclude<ArgType, 'Bucket'>, value: LiteralValue): { Literal: string } {
  return { Literal: encodeLiteral(type, value) };
}
