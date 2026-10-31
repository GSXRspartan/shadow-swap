/**
 * Ootle v0.48 instruction serialisation for the Tari wallet boundary.
 *
 * What crosses the boundary is the serde JSON of upstream's
 * `tari_ootle_transaction::Instruction` (crates/transaction/src/v1/instruction.rs at the
 * pinned cohort). Sapient passes the list straight into its transaction builder
 * (`OotleAccount.execute` -> `TransactionBuilder.withInstructions`), and walletd
 * deserialises the same Rust type, so the JSON has to be exactly upstream's:
 *
 *   { "CallMethod": { "call": { "Address": "component_<hex>" }, "method": "withdraw",
 *                     "args": [ { "Literal": "<cbor hex>" }, { "Literal": "<cbor hex>" } ] } }
 *   { "PutLastInstructionOutputOnWorkspace": { "key": 0 } }
 *   { "CallMethod": { "call": { "Address": "component_<hex>" }, "method": "deposit",
 *                     "args": [ { "Workspace": { "id": 0, "offset": null } } ] } }
 *   { "CallFunction": { "address": "<64 hex, no prefix>", "function": "create", "args": [...] } }
 *   { "CallMethod": { "call": { "Workspace": 0 }, ... } }   (a component created earlier in the tx)
 *
 * Every shape here is byte-pinned to the engine: audit_engine_tests/tests/
 * instruction_wire_v048.rs builds each operation with the upstream Rust builder, serialises
 * it, deserialises the JSON and EXECUTES it; the web suite requires this serializer to emit the
 * same JSON from the same parameters.
 *
 * Three facts that earlier revisions of this file got wrong, now fixed:
 *  1. Arguments are `{ Literal: hex(tari_bor(value)) }`, never bare strings. A literal's
 *     encoding depends on its declared ABI type, so every call carries `argTypes`; an
 *     undeclared type is refused (see lib/instructionArgs.ts).
 *  2. There is no `WithMaxEpoch` instruction. `max_epoch` is a field of the unsigned
 *     transaction that the WALLET sets when it builds and signs (Sapient: current epoch + 10).
 *     The intent's `maxEpoch` is review evidence only and is not serialised.
 *  3. An NFT leaves an account through `withdraw_non_fungible(resource, NonFungibleId)`;
 *     the account's `withdraw(resource, Amount)` cannot take an id.
 *
 * AMOUNTS ARE NEVER NUMBERS HERE. Every amount is a raw integer string; `asRawExecutionAmount`
 * and the literal encoder both gate it.
 */

import { asRawExecutionAmount, asResourceAddress } from './tradeBoundary.js';
import { isLiteralType, literalArg, type ArgType, type LiteralValue } from './instructionArgs.js';

/** A symbolic bucket as the wallet-adapter emits it. */
export interface SymbolicBucket {
  kind: 'workspace_bucket';
  name: string;
  /** Tuple element (e.g. `remove_liquidity` returns `(Bucket, Bucket)`). */
  offset?: number;
}

type Arg = string | number | boolean | null | SymbolicBucket;

interface IntentInstructionLike {
  kind: string;
  accountAddress?: string;
  componentAddress?: string;
  templateAddress?: string;
  method?: string;
  args?: Arg[];
  /** The callee's ABI type for each element of `args`, in order. Required whenever `args` is non-empty. */
  argTypes?: readonly ArgType[];
  resourceAddress?: string;
  nftResource?: string;
  amount?: string;
  nonFungibleId?: string;
  nftId?: string;
  output?: SymbolicBucket;
  bucket?: SymbolicBucket;
  /** A component created earlier in this same transaction. */
  componentWorkspace?: SymbolicBucket;
}

export interface InstructionBuildInput {
  instructions: readonly unknown[];
  /**
   * The intent's expiry evidence. Validated when present but NOT serialised: Ootle has no
   * max-epoch instruction, and the wallet owns the transaction's `max_epoch` field.
   */
  maxEpoch?: string;
  network?: string;
  operationId?: string;
  /**
   * Workspace ids already allocated before these instructions run. Sapient's
   * `withdrawStealthAndExecute` puts its own withdrawal on id 0 and the revealed bucket on id 1,
   * so its follow-up instructions must allocate from 2 (see services/stealthWithdraw.ts).
   */
  reservedWorkspace?: ReadonlyMap<string, number>;
}

/** One Ootle instruction in its externally-tagged JSON form. */
export type TariInstruction = Record<string, unknown>;

/** Resolves symbolic bucket names to the integer workspace ids the wallet expects. */
class WorkspaceIds {
  private readonly ids = new Map<string, number>();
  private next: number;

  constructor(reserved?: ReadonlyMap<string, number>) {
    let max = -1;
    for (const [name, id] of reserved ?? []) {
      if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff) throw new Error(`Reserved workspace id ${id} is not a u16.`);
      this.ids.set(name, id);
      max = Math.max(max, id);
    }
    this.next = max + 1;
  }

  idFor(bucket: SymbolicBucket): number {
    const existing = this.ids.get(bucket.name);
    if (existing !== undefined) return existing;
    // Sequential in first-use order -- the upstream Rust and TS builders allocate the same way
    // (`WorkspaceIds::insert`), so the mapping is a pure, reviewable function of the list.
    const id = this.next;
    if (id > 0xffff) throw new Error('Workspace id overflow (u16).');
    this.next += 1;
    this.ids.set(bucket.name, id);
    return id;
  }
}

function isBucket(arg: unknown): arg is SymbolicBucket {
  return arg !== null && typeof arg === 'object' && (arg as SymbolicBucket).kind === 'workspace_bucket';
}

function callMethod(componentAddress: string, method: string, args: unknown[]): TariInstruction {
  return { CallMethod: { call: { Address: componentAddress }, method, args } };
}

function workspaceRef(id: number, offset?: number): unknown {
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 15)) {
    throw new Error(`Workspace tuple offset ${offset} is not a small non-negative integer.`);
  }
  return { Workspace: { id, offset: offset ?? null } };
}

function translateArgs(instruction: IntentInstructionLike, ids: WorkspaceIds, where: string): unknown[] {
  const args = instruction.args ?? [];
  const types = instruction.argTypes ?? [];
  if (types.length !== args.length) {
    throw new Error(`${where}: ${args.length} argument(s) but ${types.length} declared type(s); every argument needs its ABI type to be encoded.`);
  }
  return args.map((arg, i) => {
    const type = types[i]!;
    if (type === 'Bucket') {
      if (!isBucket(arg)) throw new Error(`${where}: argument ${i} is declared Bucket but is not a workspace bucket.`);
      return workspaceRef(ids.idFor(arg), arg.offset);
    }
    if (!isLiteralType(type)) throw new Error(`${where}: argument ${i} has unknown type ${JSON.stringify(type)}.`);
    if (isBucket(arg)) throw new Error(`${where}: argument ${i} is a workspace bucket but is declared ${type}.`);
    if (typeof arg === 'number') {
      // A JS number would already have lost precision above 2^53; only exact small integers
      // are accepted, and they are encoded from their decimal string.
      if (!Number.isSafeInteger(arg) || arg < 0) throw new Error(`${where}: argument ${i} (${arg}) is not an exact non-negative integer.`);
      return literalArg(type, String(arg));
    }
    return literalArg(type, arg as LiteralValue);
  });
}

/**
 * Serialise a signer-agnostic intent into the wallet's instruction list.
 *
 * Refuses, rather than guesses, on anything it does not recognise: an unrecognised
 * instruction kind would otherwise be dropped silently and the transaction that reached the
 * wallet would be a different transaction from the one the user reviewed.
 */
export function buildSignableInstructions(input: InstructionBuildInput): TariInstruction[] {
  const ids = new WorkspaceIds(input.reservedWorkspace);
  const out: TariInstruction[] = [];

  for (const raw of input.instructions) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Instruction entries must be objects; received ${typeof raw}.`);
    }
    const instruction = raw as IntentInstructionLike;

    switch (instruction.kind) {
      case 'withdraw_fungible': {
        const account = requireComponent(instruction.accountAddress, 'withdraw_fungible.accountAddress');
        const resource = asResourceAddress(instruction.resourceAddress ?? '', 'withdraw_fungible.resourceAddress');
        const amount = asRawExecutionAmount(instruction.amount ?? '', 'withdraw_fungible.amount');
        // Account::withdraw(resource: ResourceAddress, amount: Amount) -> Bucket
        out.push(callMethod(account, 'withdraw', [literalArg('ResourceAddress', resource), literalArg('Amount', amount)]));
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'withdraw_non_fungible': {
        const account = requireComponent(instruction.accountAddress, 'withdraw_non_fungible.accountAddress');
        const resource = asResourceAddress(instruction.resourceAddress ?? instruction.nftResource ?? '', 'withdraw_non_fungible.resourceAddress');
        const nftId = requireOpaque(instruction.nonFungibleId ?? instruction.nftId, 'withdraw_non_fungible.nonFungibleId');
        // Account::withdraw_non_fungible(resource: ResourceAddress, nf_id: NonFungibleId) -> Bucket
        out.push(callMethod(account, 'withdraw_non_fungible', [literalArg('ResourceAddress', resource), literalArg('NonFungibleId', nftId)]));
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'call_method': {
        const method = requireOpaque(instruction.method, 'call_method.method');
        const args = translateArgs(instruction, ids, `call_method ${method}`);
        if (instruction.componentWorkspace !== undefined) {
          // A component this transaction created (e.g. a new pool): ComponentReference::Workspace(id).
          out.push({ CallMethod: { call: { Workspace: ids.idFor(instruction.componentWorkspace) }, method, args } });
        } else {
          const component = requireComponent(instruction.componentAddress, 'call_method.componentAddress');
          out.push(callMethod(component, method, args));
        }
        // A returned bucket that is not captured and consumed fails the whole transaction
        // (dangling resources, audit_engine_tests/tests/multihop_routes.rs m05).
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'call_function': {
        // A template FUNCTION call (pool, listing, item offer, collection bid, SwapOffer
        // constructors). `CallFunction.address` is a `TemplateAddress`, whose serde form is the
        // bare 64-hex hash (engine fixture "probe"); a `template_` prefix is accepted on input
        // and stripped, anything else is refused.
        const template = requireTemplateHash(instruction.templateAddress, 'call_function.templateAddress');
        const fn = requireOpaque(instruction.method, 'call_function.method');
        const args = translateArgs(instruction, ids, `call_function ${fn}`);
        out.push({ CallFunction: { address: template, function: fn, args } });
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'deposit_all': {
        const account = requireComponent(instruction.accountAddress, 'deposit_all.accountAddress');
        const bucketRef = instruction.bucket ?? instruction.output;
        if (bucketRef === undefined) throw new Error('deposit_all requires a bucket to deposit.');
        // Account::deposit(bucket: Bucket)
        out.push(callMethod(account, 'deposit', [workspaceRef(ids.idFor(bucketRef), bucketRef.offset)]));
        break;
      }

      default:
        throw new Error(`Refusing to serialise unrecognised instruction kind "${instruction.kind}".`);
    }
  }

  // Validated as evidence; deliberately NOT serialised (no such instruction exists).
  if (input.maxEpoch !== undefined && input.maxEpoch !== '') asRawExecutionAmount(input.maxEpoch, 'maxEpoch');

  if (out.length === 0) throw new Error('Refusing to build an empty instruction list: the user would be approving nothing visible.');
  return out;
}

function requireComponent(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || !/^component_[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a component_<64 hex> address.`);
  }
  return value;
}

function requireOpaque(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

/** A template address as the bare 64-hex hash upstream's serde emits. */
function requireTemplateHash(value: string | undefined, field: string): string {
  const text = requireOpaque(value, field);
  const m = /^(?:template_)?([0-9a-f]{64})$/.exec(text);
  if (m === null) throw new Error(`${field} must be a 64-hex template address; received a different shape.`);
  return m[1]!;
}
