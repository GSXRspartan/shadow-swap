/**
 * Ootle instruction serialisation for the Tari wallet boundary.
 *
 * The published contract types `tari_signAndSubmitTransaction.params.instructions`
 * and the `instructions` member of a `tari_createTransactionRequest` operation as
 * `unknown[]`. The
 * integration reference gives the wire form:
 *
 *   { CallMethod: { call: { Address: account },
 *                   method: "withdraw",
 *                   args: [resource, amount] } }
 *   { PutLastInstructionOutputOnWorkspace: { key: 0 } }
 *   { CallMethod: { call: { Address: target },
 *                   method: "deposit",
 *                   args: [{ Workspace: { id: 0, offset: null } }] } }
 *
 * The reference is explicit that a workspace reference in instructions WE build
 * must be a plain integer id — `{ Workspace: { id: 0, offset: null } }` — because
 * named-workspace resolution only applies to instructions the wallet itself
 * builds. So the adapter's symbolic `{ kind: 'workspace_bucket', name }` values
 * are resolved here to sequential integer ids, in first-use order.
 *
 * The wallet-adapter intents are signer-agnostic and carry a `maxEpoch`
 * (`with_max_epoch` on-chain). That expiry is part of the operation the user
 * reviewed, so it is serialised as a final `WithMaxEpoch` instruction rather
 * than dropped. Dropping it would let a signed swap stay valid indefinitely
 * after market state moves, which the adapter's own documentation forbids.
 *
 * AMOUNTS ARE NEVER NUMBERS HERE. Every amount that crosses into an
 * instruction argument is a raw integer string, because raw resource units
 * exceed `Number.MAX_SAFE_INTEGER`. `asRawExecutionAmount` is the gate.
 */

import { asRawExecutionAmount, asResourceAddress } from './tradeBoundary.js';

/** A symbolic bucket as the wallet-adapter emits it. */
export interface SymbolicBucket {
  kind: 'workspace_bucket';
  name: string;
}

type Arg = string | number | SymbolicBucket;

interface IntentInstructionLike {
  kind: string;
  accountAddress?: string;
  componentAddress?: string;
  templateAddress?: string;
  method?: string;
  args?: Arg[];
  resourceAddress?: string;
  nftResource?: string;
  amount?: string;
  nonFungibleId?: string;
  nftId?: string;
  output?: SymbolicBucket;
  bucket?: SymbolicBucket;
}

export interface InstructionBuildInput {
  instructions: readonly unknown[];
  /** Raw `with_max_epoch` bound, as an integer string. */
  maxEpoch?: string;
  network?: string;
  operationId?: string;
}

/** One Ootle instruction in its externally-tagged JSON form. */
export type TariInstruction = Record<string, unknown>;

/** Resolves symbolic bucket names to the integer workspace ids the wallet expects. */
class WorkspaceIds {
  private readonly ids = new Map<string, number>();

  constructor(private readonly startAt: number) {}

  idFor(bucket: SymbolicBucket): number {
    const existing = this.ids.get(bucket.name);
    if (existing !== undefined) return existing;
    // Sequential in first-use order, so the mapping is a pure function of the
    // instruction list and is therefore reproducible and reviewable.
    const next = this.startAt + this.ids.size;
    this.ids.set(bucket.name, next);
    return next;
  }
}

function callMethod(componentAddress: string, method: string, args: unknown[]): TariInstruction {
  return { CallMethod: { call: { Address: componentAddress }, method, args } };
}

function workspaceRef(id: number): unknown {
  return { Workspace: { id, offset: null } };
}

function translateArg(arg: Arg, ids: WorkspaceIds): unknown {
  if (arg !== null && typeof arg === 'object' && (arg as SymbolicBucket).kind === 'workspace_bucket') {
    return workspaceRef(ids.idFor(arg as SymbolicBucket));
  }
  if (typeof arg === 'number') {
    // A numeric argument reaching the wire would be a float by construction.
    // Only exact non-negative safe integers are representable, and the protocol
    // requires raw integer strings for every amount, so this is refused rather
    // than silently widened.
    if (!Number.isSafeInteger(arg) || arg < 0) {
      throw new Error(`Instruction argument ${arg} is not an exact non-negative integer and cannot be serialised without losing precision.`);
    }
    return String(arg);
  }
  return arg;
}

/**
 * Serialise a signer-agnostic intent into the wallet's instruction list.
 *
 * Refuses, rather than guesses, on anything it does not recognise: an
 * unrecognised instruction kind would otherwise be dropped silently and the
 * transaction that reached the wallet would be a different transaction from the
 * one the user reviewed, which is exactly the defect this repository exists to
 * prevent.
 */
export function buildSignableInstructions(input: InstructionBuildInput): TariInstruction[] {
  const ids = new WorkspaceIds(0);
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
        // The canonical account `withdraw` / vault `deposit` pair, exactly as the
        // integration reference writes it.
        out.push(callMethod(account, 'withdraw', [resource, amount]));
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'withdraw_non_fungible': {
        const account = requireComponent(instruction.accountAddress, 'withdraw_non_fungible.accountAddress');
        const resource = asResourceAddress(instruction.resourceAddress ?? instruction.nftResource ?? '', 'withdraw_non_fungible.resourceAddress');
        // A non-fungible id is an identifier, not an amount, so it is validated
        // as a non-empty opaque token rather than as a raw integer.
        const nftId = requireOpaque(instruction.nonFungibleId ?? instruction.nftId, 'withdraw_non_fungible.nonFungibleId');
        out.push(callMethod(account, 'withdraw', [resource, nftId]));
        if (instruction.output !== undefined) {
          out.push({ PutLastInstructionOutputOnWorkspace: { key: ids.idFor(instruction.output) } });
        }
        break;
      }

      case 'call_method': {
        const component = requireComponent(instruction.componentAddress ?? instruction.templateAddress, 'call_method.componentAddress');
        const method = requireOpaque(instruction.method, 'call_method.method');
        const args = (instruction.args ?? []).map((arg) => translateArg(arg, ids));
        out.push(callMethod(component, method, args));
        break;
      }

      case 'deposit_all': {
        const account = requireComponent(instruction.accountAddress, 'deposit_all.accountAddress');
        const bucketRef = instruction.bucket ?? instruction.output;
        if (bucketRef === undefined) throw new Error('deposit_all requires a bucket to deposit.');
        out.push(callMethod(account, 'deposit', [workspaceRef(ids.idFor(bucketRef))]));
        break;
      }

      default:
        // Fail loudly. Silently skipping an instruction would produce a
        // transaction that differs from the review the user approved.
        throw new Error(`Refusing to serialise unrecognised instruction kind "${instruction.kind}".`);
    }
  }

  // with_max_epoch binds the on-chain expiry the intent already carries.
  if (input.maxEpoch !== undefined && input.maxEpoch !== '') {
    asRawExecutionAmount(input.maxEpoch, 'maxEpoch');
    out.push({ WithMaxEpoch: { epoch: input.maxEpoch } });
  }

  if (out.length === 0) throw new Error('Refusing to build an empty instruction list: the user would be approving nothing visible.');
  return out;
}

function requireComponent(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty component address.`);
  }
  return value;
}

function requireOpaque(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}
