/**
 * Reads a `CrossLayerHtlc` escrow from chain.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. An invitation is untrusted input, so a taker must not act
 * on its terms — they must act on the escrow's. This decoder is what turns "a maker says they
 * funded 1,000,000 against hash X" into "the component at this address holds 1,000,000 against
 * hash X, claimable by this key until epoch N". Without it, an offer can be displayed but never
 * verified, and displaying an unverified offer as tradeable is the failure this whole design is
 * arranged to avoid.
 *
 * AN ASYMMETRY WORTH KNOWING. This covers the leg that lives on L2 — which is the MAKER's leg
 * for an `L1_TO_L2` (entry) offer, and the TAKER's own leg for `L2_TO_L1` (exit). So an entry
 * offer can be verified entirely in the browser today, while verifying an exit offer's maker leg
 * needs an L1 output read, which only a local wallet can do. `escrowChainForOffer` states which
 * is which, so a UI can report the difference rather than treating both as equally checkable.
 *
 * Fail-closed throughout: a field that cannot be read is an error, never a default. A decoder
 * that guessed would be guessing about whether someone's funds are safe to commit against.
 */

import type { SwapDirection } from './atomicSwap.js';

/** Component state order, from the template's own struct. Changing the struct breaks this. */
const FIELD_COUNT = 10;

export class EscrowDecodeError extends Error {}

export type EscrowStatus = 'Funded' | 'Claimed' | 'Refunded';

export interface CrossLayerEscrowState {
  readonly component: string;
  /** The template the component's own header names, so the caller can check it is recorded. */
  readonly templateAddress: string;
  readonly resourceAddress: string;
  /** The amount recorded at funding, which is what the terms promise. */
  readonly amountRaw: string;
  /** The amount the vault actually holds now. Differs from `amountRaw` once settled. */
  readonly balanceRaw: string;
  readonly hashLockHex: string;
  readonly claimantPublicKeyHex: string;
  readonly funderPublicKeyHex: string;
  readonly expiresAtEpoch: number;
  readonly counterpartyLeg: string;
  readonly status: EscrowStatus;
  /** Present once a claim published it. This is how the other leg gets completed. */
  readonly revealedPreimageHex?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A CBOR tag-N node carrying 32 bytes, as the indexer serialises an object key. */
function taggedHex(node: unknown, what: string): string {
  const bag = record(node);
  const inner = record(bag?.value) ?? bag;
  const hex = inner?.hex;
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new EscrowDecodeError(`${what} does not carry a 32-byte object key`);
  }
  return hex.toLowerCase();
}

/** A CBOR byte string, which the indexer renders either as hex or as an array of bytes. */
function bytesHex(node: unknown, what: string): string {
  if (typeof node === 'string' && /^[0-9a-f]*$/i.test(node)) return node.toLowerCase();
  const bag = record(node);
  if (typeof bag?.hex === 'string') return (bag.hex as string).toLowerCase();
  if (Array.isArray(node)) {
    return node
      .map((b) => {
        if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
          throw new EscrowDecodeError(`${what} contains a non-byte element`);
        }
        return b.toString(16).padStart(2, '0');
      })
      .join('');
  }
  throw new EscrowDecodeError(`${what} is not a readable byte string`);
}

function intString(node: unknown, what: string): string {
  if (typeof node === 'number' && Number.isInteger(node)) return String(node);
  if (typeof node === 'bigint') return node.toString();
  if (typeof node === 'string' && /^\d+$/.test(node)) return node;
  const bag = record(node);
  if (bag !== undefined && typeof bag.value === 'number' && Number.isInteger(bag.value)) return String(bag.value);
  throw new EscrowDecodeError(`${what} is not an integer`);
}

/**
 * A `#[derive]`d enum with unit variants serialises as `[index, []]`. The order is the template's
 * declaration order, so an added variant must be added here too — hence the explicit bound.
 */
function status(node: unknown): EscrowStatus {
  const variants: readonly EscrowStatus[] = ['Funded', 'Claimed', 'Refunded'];
  if (!Array.isArray(node) || node.length < 1) throw new EscrowDecodeError('status is not an enum node');
  const index = Number(intString(node[0], 'status.variant'));
  const name = variants[index];
  if (name === undefined) throw new EscrowDecodeError(`status variant ${index} is not one this build knows`);
  return name;
}

/** `Option<T>` serialises the same way: `[0, []]` for None, `[1, [value]]` for Some. */
function optionalBytes(node: unknown, what: string): string | undefined {
  if (!Array.isArray(node) || node.length < 1) throw new EscrowDecodeError(`${what} is not an Option node`);
  const tag = Number(intString(node[0], `${what}.tag`));
  if (tag === 0) return undefined;
  const payload = node[1];
  if (!Array.isArray(payload) || payload.length < 1) throw new EscrowDecodeError(`${what} is Some but carries nothing`);
  return bytesHex(payload[0], what);
}

/**
 * What a caller's reader must provide. Structurally identical to the pool decoder's reader, and
 * deliberately re-declared rather than imported under the same name: both are "give me the raw
 * substate for this address", and an escrow read must not silently pick up a pool-specific
 * reader's expectations if one of them ever grows a method.
 */
export interface EscrowSubstateReader {
  read(address: string): Promise<unknown>;
}

/**
 * Reads and assembles the escrow. The vault balance is read separately, because the recorded
 * amount and the live balance answer different questions: the first is what the terms promised,
 * the second is what is still there.
 */
export async function decodeCrossLayerEscrow(reader: EscrowSubstateReader, component: string): Promise<CrossLayerEscrowState> {
  const substate = await reader.read(component);
  if (substate === undefined || substate === null) {
    throw new EscrowDecodeError(`Escrow component ${component} does not exist or could not be read`);
  }
  const comp = record(record(substate)?.Component) ?? record(substate);
  const header = record(comp?.header);
  const template = header?.template_address;
  if (typeof template !== 'string' || template.length === 0) {
    throw new EscrowDecodeError(`Escrow ${component} carries no template address; its identity cannot be established`);
  }
  const state = record(comp?.body)?.state;
  if (!Array.isArray(state) || state.length < FIELD_COUNT) {
    throw new EscrowDecodeError(
      `Escrow ${component} state is not the expected ${FIELD_COUNT}-field tuple; this is not a CrossLayerHtlc of this build`,
    );
  }

  const vaultId = 'vault_' + taggedHex(state[0], 'escrow vault');
  const vault = await reader.read(vaultId);
  const container = record(record(record(vault)?.Vault)?.resource_container) ?? record(record(vault)?.resource_container);
  if (container === undefined) throw new EscrowDecodeError('the escrow vault carries no resource_container');
  let balanceRaw: string | undefined;
  let vaultResource: string | undefined;
  for (const kind of ['Fungible', 'Stealth', 'Confidential'] as const) {
    const inner = record(container[kind]);
    if (inner !== undefined) {
      balanceRaw = intString(inner.amount ?? inner.revealed_amount, `escrow vault ${kind} amount`);
      if (typeof inner.address === 'string') vaultResource = inner.address;
      break;
    }
  }
  if (balanceRaw === undefined) {
    throw new EscrowDecodeError(`the escrow vault has an unrecognised container (${Object.keys(container).join(',')})`);
  }

  const resourceAddress = 'resource_' + taggedHex(state[1], 'resource');
  // The vault must actually hold the resource the component declares, or every downstream check
  // would be against the wrong asset.
  if (vaultResource !== undefined && vaultResource !== resourceAddress) {
    throw new EscrowDecodeError(`escrow ${component} declares ${resourceAddress} but its vault holds ${vaultResource}`);
  }

  return {
    component,
    templateAddress: template.startsWith('template_') ? template.slice('template_'.length) : template,
    resourceAddress,
    amountRaw: intString(state[2], 'amount'),
    balanceRaw,
    hashLockHex: bytesHex(state[3], 'hash_lock'),
    claimantPublicKeyHex: bytesHex(state[4], 'claimant'),
    funderPublicKeyHex: bytesHex(state[5], 'funder'),
    expiresAtEpoch: Number(intString(state[6], 'expires_at_epoch')),
    counterpartyLeg: typeof state[7] === 'string' ? state[7] : String(state[7] ?? ''),
    status: status(state[8]),
    ...(optionalBytes(state[9], 'revealed_preimage') === undefined
      ? {}
      : { revealedPreimageHex: optionalBytes(state[9], 'revealed_preimage') }),
  };
}

/**
 * Which chain the MAKER's escrow sits on for an offer, and therefore whether a browser can verify
 * it alone. Derived from the direction, because the L1 funder is always the secret holder.
 */
export function escrowChainForOffer(direction: SwapDirection): { readonly chain: 'L1' | 'L2'; readonly browserVerifiable: boolean; readonly reason: string } {
  return direction === 'L1_TO_L2'
    ? {
        chain: 'L2',
        browserVerifiable: true,
        reason: 'For an XTM → TARI offer the maker escrows TARI on L2, which this app reads from chain directly. The offer can be verified in the browser before you commit anything.',
      }
    : {
        chain: 'L1',
        browserVerifiable: false,
        reason: 'For a TARI → XTM offer the maker escrows XTM on Minotari L1. Verifying it means reading an L1 output, which only your own wallet can do — no browser API exposes it. Until a local wallet is connected, such an offer can be displayed but not verified, and so is never offered as tradeable.',
      };
}

/** Turns an escrow read into the shape `verifyCrossLayerInvitation` compares against. */
export function escrowAsFundedLeg(escrow: CrossLayerEscrowState): {
  readonly leg: string;
  readonly chain: 'L2';
  readonly hashLockHex: string;
  readonly amountRaw: string;
  readonly claimantOrDestination: string;
  readonly expiresAtEpoch: number;
  readonly settled: boolean;
} {
  return {
    leg: escrow.component,
    chain: 'L2',
    hashLockHex: escrow.hashLockHex,
    // The LIVE balance, not the recorded amount: a claimed escrow records what it held but holds
    // nothing, and a taker must not be told an empty escrow backs an offer.
    amountRaw: escrow.balanceRaw,
    claimantOrDestination: escrow.claimantPublicKeyHex,
    expiresAtEpoch: escrow.expiresAtEpoch,
    settled: escrow.status !== 'Funded',
  };
}
