/**
 * The two-chain acceptance harness: every cross-layer scenario, driven end to end.
 *
 * WHAT THIS IS, STATED BEFORE ANYTHING ELSE. The two chains here are SIMULATED. Nothing in this
 * file opens a socket, and no result it produces is evidence that anything executed on Minotari
 * or on Ootle. Its value is narrower and real: it restates the rules both chains enforce, in one
 * place, and drives the whole client stack — timeouts, quoting, the maker's ledger, the
 * invitation, the escrow decoder, the lifecycle and the L1 companion — through each scenario so
 * that a contradiction between any two of them shows up as a failing scenario.
 *
 * The L2 rules below are the ones `templates/cross_layer_htlc/src/lib.rs` asserts, and the
 * engine tests in `audit_engine_tests/tests/cross_layer_htlc.rs` are what prove the template
 * itself. The L1 rules are the ones `send_sha_atomic_swap_transaction` builds into its script
 * (tari 6.3.0-pre.2). Where the two differ — the L1 claim branch has no height condition and so
 * races the refund, the L2 one does not — the simulation keeps the difference rather than
 * smoothing it, because that difference is the thing a cross-layer trade has to survive.
 *
 * WHY A SIMULATION IS WORTH WRITING AT ALL, given it proves nothing about either chain: the
 * failure modes of this protocol are sequences, not states. "Fund L1 while the wallet is 200
 * blocks behind, then derive the L2 deadline from the tip, then have the counterparty claim one
 * epoch late" is not a thing a unit test of any single module can express. Here it is one
 * scenario, and its expected outcome is written down.
 */

import {
  CLAIM_MARGIN_FRACTION,
  DIRECTIONS,
  L1_HTLC_REFUND_BLOCKS,
  deriveTimeouts,
  type SwapDirection,
} from './atomicSwap.js';
import { L1_APPROVED_NETWORKS, MAX_SYNC_GAP_BLOCKS, assessSync } from './l1Companion.js';

export class SimulationError extends Error {}

export type Party = 'USER' | 'MAKER';

/** An L1 output, with exactly the fields the HTLC script branches on. */
export interface SimL1Output {
  readonly outputHashHex: string;
  readonly amountMicroRaw: string;
  readonly hashLockHex: string;
  /** The claim branch's `PushPubKey(destination)`. */
  readonly destinationPublicKeyHex: string;
  /** The refund branch's `PushPubKey(sender)`. */
  readonly senderPublicKeyHex: string;
  /** `CheckHeightVerify(height)`: scanned height + 720, NOT tip + 720. */
  readonly refundHeight: number;
  readonly spentBy?: 'CLAIM' | 'REFUND';
  readonly confirmations: number;
}

export type SimL2Status = 'Funded' | 'Claimed' | 'Refunded';

/** An L2 escrow, with the state the template actually holds. */
export interface SimL2Escrow {
  readonly component: string;
  readonly resourceAddress: string;
  readonly amountRaw: string;
  readonly hashLockHex: string;
  readonly claimantPublicKeyHex: string;
  readonly funderPublicKeyHex: string;
  readonly expiresAtEpoch: number;
  readonly counterpartyLeg: string;
  readonly status: SimL2Status;
  /** Published by a successful claim, exactly as the template does. */
  readonly revealedSecretHex?: string;
}

export interface SimKeys {
  readonly userL1PublicKeyHex: string;
  readonly userL2PublicKeyHex: string;
  readonly makerL1PublicKeyHex: string;
  readonly makerL2PublicKeyHex: string;
}

/**
 * A deterministic stand-in for SHA-256, and deliberately NOT a hash.
 *
 * The scenarios need exactly two properties: one secret maps to one lock and no other, and a
 * lock is the 64-hex shape every real validator in this package insists on — so the simulation
 * feeds those validators the same shape a chain would, instead of quietly bypassing them.
 *
 * It is a per-byte affine permutation, `x -> 7x + 13 mod 256`. Seven is odd, so the map is
 * invertible and therefore injective; and it is transparently not a digest, which matters more
 * than its being realistic. Nothing here verifies a hash, and nothing should look like it does.
 */
export function simLock(secretHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) {
    throw new SimulationError('a simulated secret must be 64 hex characters, the shape L1 actually returns');
  }
  let lock = '';
  for (let i = 0; i < 64; i += 2) {
    const byte = parseInt(secretHex.slice(i, i + 2), 16);
    lock += (((byte * 7) + 13) % 256).toString(16).padStart(2, '0');
  }
  return lock;
}

/** A 64-hex identifier with a visible prefix, so a simulated id is never mistaken for a real one. */
function simId(prefix: string, n: number): string {
  return prefix + n.toString(16).padStart(64 - prefix.length, '0');
}

export interface SimulationOptions {
  readonly network: string;
  readonly keys: SimKeys;
  readonly l1TipHeight: number;
  /** The funding wallet's own scanned height. Below the tip, this is the sync gap. */
  readonly l1ScannedHeight: number;
  readonly l2CurrentEpoch: number;
}

/**
 * Both chains, as rule-enforcing state machines.
 *
 * Every refusal below is a restatement of a real assertion, and each is commented with where the
 * real one lives, so a drift in either direction is visible in review.
 */
export class SimulatedChains {
  private readonly network: string;
  private readonly keys: SimKeys;
  private tip: number;
  private scanned: number;
  private epoch: number;
  private readonly l1 = new Map<string, SimL1Output>();
  private readonly l2 = new Map<string, SimL2Escrow>();
  private counter = 0;

  constructor(options: SimulationOptions) {
    if (!L1_APPROVED_NETWORKS.includes(options.network.toLowerCase())) {
      throw new SimulationError(
        `This harness only simulates networks the companion will drive (${L1_APPROVED_NETWORKS.join(', ')}). A mainnet scenario is not a test fixture.`,
      );
    }
    this.network = options.network;
    this.keys = options.keys;
    this.tip = options.l1TipHeight;
    this.scanned = options.l1ScannedHeight;
    this.epoch = options.l2CurrentEpoch;
  }

  get l1TipHeight(): number {
    return this.tip;
  }

  get l1ScannedHeight(): number {
    return this.scanned;
  }

  get l2CurrentEpoch(): number {
    return this.epoch;
  }

  get networkName(): string {
    return this.network;
  }

  /** Advances L1, keeping the wallet's scan gap constant unless `catchUp` closes it. */
  advanceL1(blocks: number, catchUp = true): void {
    if (blocks < 0) throw new SimulationError('L1 does not go backwards in this harness');
    this.tip += blocks;
    if (catchUp) this.scanned += blocks;
    for (const [hash, output] of this.l1) {
      this.l1.set(hash, { ...output, confirmations: output.confirmations + blocks });
    }
  }

  advanceL2(epochs: number): void {
    if (epochs < 0) throw new SimulationError('L2 does not go backwards in this harness');
    this.epoch += epochs;
  }

  l1Output(hash: string): SimL1Output | undefined {
    return this.l1.get(hash);
  }

  l2Escrow(component: string): SimL2Escrow | undefined {
    return this.l2.get(component);
  }

  /**
   * Funds an L1 HTLC. The WALLET generates the secret and returns it, and the refund height is
   * the wallet's scanned height + 720 — neither is an input. That is the forced shape of
   * `send_sha_atomic_swap_transaction`, and the whole protocol is arranged around it.
   */
  fundL1(input: { readonly by: Party; readonly destinationPublicKeyHex: string; readonly amountMicroRaw: string }): {
    readonly outputHashHex: string;
    readonly secretHex: string;
    readonly refundHeight: number;
  } {
    const sender = input.by === 'USER' ? this.keys.userL1PublicKeyHex : this.keys.makerL1PublicKeyHex;
    if (sender === input.destinationPublicKeyHex) {
      throw new SimulationError('The funder and the destination must differ, or the script has one outcome');
    }
    if (BigInt(input.amountMicroRaw) <= 0n) throw new SimulationError('An L1 escrow of zero cannot be claimed');
    this.counter += 1;
    const secretHex = simId('5ecc', this.counter);
    const outputHashHex = simId('a1ba', this.counter);
    const refundHeight = this.scanned + L1_HTLC_REFUND_BLOCKS;
    this.l1.set(outputHashHex, {
      outputHashHex,
      amountMicroRaw: input.amountMicroRaw,
      hashLockHex: simLock(secretHex),
      destinationPublicKeyHex: input.destinationPublicKeyHex,
      senderPublicKeyHex: sender,
      refundHeight,
      confirmations: 0,
    });
    return { outputHashHex, secretHex, refundHeight };
  }

  /**
   * The L1 claim branch: the destination key plus a secret that opens the lock, at ANY height.
   * There is deliberately no height condition here — that is what makes a late L1 claim race the
   * refund, and it is the asymmetry the L2 template does not copy.
   */
  claimL1(input: { readonly outputHashHex: string; readonly secretHex: string; readonly by: Party }): void {
    const output = this.l1.get(input.outputHashHex);
    if (output === undefined) throw new SimulationError(`No L1 output ${input.outputHashHex}`);
    if (output.spentBy !== undefined) throw new SimulationError(`L1 output ${input.outputHashHex} is already spent by ${output.spentBy}`);
    const claimant = input.by === 'USER' ? this.keys.userL1PublicKeyHex : this.keys.makerL1PublicKeyHex;
    if (claimant !== output.destinationPublicKeyHex) {
      throw new SimulationError('Only the destination key named in the claim branch can claim this output');
    }
    if (simLock(input.secretHex) !== output.hashLockHex) {
      throw new SimulationError('The secret does not open this output\'s hash lock');
    }
    this.l1.set(input.outputHashHex, { ...output, spentBy: 'CLAIM' });
  }

  /** The L1 refund branch: the sender key, at or after `CheckHeightVerify(height)`. */
  refundL1(input: { readonly outputHashHex: string; readonly by: Party }): void {
    const output = this.l1.get(input.outputHashHex);
    if (output === undefined) throw new SimulationError(`No L1 output ${input.outputHashHex}`);
    if (output.spentBy !== undefined) throw new SimulationError(`L1 output ${input.outputHashHex} is already spent by ${output.spentBy}`);
    const sender = input.by === 'USER' ? this.keys.userL1PublicKeyHex : this.keys.makerL1PublicKeyHex;
    if (sender !== output.senderPublicKeyHex) throw new SimulationError('Only the funder can take the refund branch');
    if (this.tip < output.refundHeight) {
      throw new SimulationError(`CheckHeightVerify(${output.refundHeight}) fails at tip ${this.tip}: until then the output is the claimant's to take`);
    }
    this.l1.set(input.outputHashHex, { ...output, spentBy: 'REFUND' });
  }

  /**
   * Funds an L2 escrow. Mirrors `CrossLayerHtlc::fund`: the hash is an INPUT (so the escrow can
   * be bound to an already-funded L1 output's lock), the claimant is named at fund time, the
   * expiry is absolute and must be in the future, and the funder cannot be the claimant.
   */
  fundL2(input: {
    readonly by: Party;
    readonly resourceAddress: string;
    readonly amountRaw: string;
    readonly hashLockHex: string;
    readonly claimantPublicKeyHex: string;
    readonly expiresAtEpoch: number;
    readonly counterpartyLeg: string;
  }): string {
    const funder = input.by === 'USER' ? this.keys.userL2PublicKeyHex : this.keys.makerL2PublicKeyHex;
    if (BigInt(input.amountRaw) <= 0n) throw new SimulationError('A cross-layer escrow must be funded with a positive amount');
    if (input.expiresAtEpoch <= this.epoch) {
      throw new SimulationError('expires_at_epoch must be in the future: an escrow that is already expired could be refunded before it could ever be claimed');
    }
    if (input.counterpartyLeg.length === 0 || input.counterpartyLeg.length > 128) {
      throw new SimulationError('counterparty_leg must name the other chain\'s leg and be at most 128 characters');
    }
    if (funder === input.claimantPublicKeyHex) throw new SimulationError('The funder and the claimant must be different parties');
    this.counter += 1;
    const component = `component_${simId('c0de', this.counter)}`;
    this.l2.set(component, {
      component,
      resourceAddress: input.resourceAddress,
      amountRaw: input.amountRaw,
      hashLockHex: input.hashLockHex,
      claimantPublicKeyHex: input.claimantPublicKeyHex,
      funderPublicKeyHex: funder,
      expiresAtEpoch: input.expiresAtEpoch,
      counterpartyLeg: input.counterpartyLeg,
      status: 'Funded',
    });
    return component;
  }

  /**
   * `CrossLayerHtlc::claim`: the named claimant only, STRICTLY before expiry, once, and it
   * publishes the secret in component state.
   */
  claimL2(input: { readonly component: string; readonly secretHex: string; readonly by: Party }): string {
    const escrow = this.l2.get(input.component);
    if (escrow === undefined) throw new SimulationError(`No L2 escrow ${input.component}`);
    if (escrow.status !== 'Funded') throw new SimulationError('This escrow has already been settled');
    const claimant = input.by === 'USER' ? this.keys.userL2PublicKeyHex : this.keys.makerL2PublicKeyHex;
    if (claimant !== escrow.claimantPublicKeyHex) throw new SimulationError('Only the claimant key may call claim');
    if (this.epoch >= escrow.expiresAtEpoch) {
      throw new SimulationError(`This escrow expired at epoch ${escrow.expiresAtEpoch}; it can now only be refunded to the funder`);
    }
    if (simLock(input.secretHex) !== escrow.hashLockHex) {
      throw new SimulationError('The preimage does not match this escrow\'s hash lock');
    }
    this.l2.set(input.component, { ...escrow, status: 'Claimed', revealedSecretHex: input.secretHex });
    return input.secretHex;
  }

  /** `CrossLayerHtlc::refund`: the funder only, at or after expiry, once. */
  refundL2(input: { readonly component: string; readonly by: Party }): void {
    const escrow = this.l2.get(input.component);
    if (escrow === undefined) throw new SimulationError(`No L2 escrow ${input.component}`);
    if (escrow.status !== 'Funded') throw new SimulationError('This escrow has already been settled');
    const funder = input.by === 'USER' ? this.keys.userL2PublicKeyHex : this.keys.makerL2PublicKeyHex;
    if (funder !== escrow.funderPublicKeyHex) throw new SimulationError('Only the funder key may call refund');
    if (this.epoch < escrow.expiresAtEpoch) {
      throw new SimulationError(`This escrow cannot be refunded before epoch ${escrow.expiresAtEpoch}: until then it is the claimant's to take`);
    }
    this.l2.set(input.component, { ...escrow, status: 'Refunded' });
  }

  /** The secret a claim published, or `undefined`. This is how the second claimant learns it. */
  revealedSecret(component: string): string | undefined {
    return this.l2.get(component)?.revealedSecretHex;
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario outcomes
// ---------------------------------------------------------------------------------------------

export type Settlement =
  | 'BOTH_SETTLED'
  | 'BOTH_REFUNDED'
  | 'L1_REFUNDED_L2_NEVER_FUNDED'
  | 'L2_REFUNDED_L1_CLAIMED'
  | 'REFUSED_BEFORE_FUNDING'
  | 'ONE_SIDED_LOSS';

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly direction: SwapDirection;
  readonly settlement: Settlement;
  /** What each party ended up with, in the asset they were owed. */
  readonly steps: readonly string[];
  /** Set when the scenario ends because something was correctly refused. */
  readonly refusal?: string;
}

/**
 * Who funds which leg, and who claims which — all forced by the direction, because the L1 wallet
 * generates the secret and the secret holder must reveal by claiming the leg that expires first.
 */
export function roles(direction: SwapDirection): {
  readonly l1Funder: Party;
  readonly l2Funder: Party;
  readonly secretHolder: Party;
  readonly l2Claimant: Party;
  readonly l1Claimant: Party;
} {
  const shape = DIRECTIONS[direction];
  if (shape === undefined) throw new SimulationError(`unknown direction ${direction}`);
  const l1Funder: Party = shape.l1FundedBy;
  const l2Funder: Party = shape.l2FundedBy;
  return {
    l1Funder,
    l2Funder,
    secretHolder: shape.secretHeldBy,
    // The secret holder funds L1 and claims L2, publishing the secret there; the other party
    // then spends it on L1. This is the only ordering that works.
    l2Claimant: l1Funder,
    l1Claimant: l2Funder,
  };
}

/**
 * Derives the pair of deadlines for a scenario, from the SCANNED height rather than the tip.
 *
 * This is the correction the sync gap forces. `deriveTimeouts` takes a tip, because in the
 * normal case the funding wallet is synced and tip is what a caller has. Here the actual refund
 * height is the wallet's own, so the L2 deadline is derived against that instead — otherwise the
 * margin the L2 deadline is supposed to preserve is measured from the wrong end.
 */
export function scenarioTimeouts(chains: SimulatedChains): {
  readonly l1RefundHeight: number;
  readonly l2ExpiresAtEpoch: number;
  readonly claimMarginSeconds: number;
  readonly syncOk: boolean;
  readonly syncReason: string;
} {
  const sync = assessSync({ tipHeight: chains.l1TipHeight, scannedHeight: chains.l1ScannedHeight });
  const network = chains.networkName.toLowerCase() === 'mainnet' ? 'mainnet' : 'esmeralda';
  const derived = deriveTimeouts({
    network,
    // The wallet's own height: the refund branch is built from it, so the margin must be too.
    l1TipHeight: chains.l1ScannedHeight,
    l2CurrentEpoch: chains.l2CurrentEpoch,
  });
  return {
    l1RefundHeight: derived.l1RefundHeight,
    l2ExpiresAtEpoch: derived.l2ExpiresAtEpoch,
    claimMarginSeconds: derived.claimMarginSeconds,
    syncOk: sync.ok,
    syncReason: sync.reason,
  };
}

/** The margin fraction and the fixed window, re-exported so a scenario can state them. */
export const HARNESS_FACTS: readonly string[] = [
  `The L1 refund branch is locked for a fixed ${L1_HTLC_REFUND_BLOCKS} blocks from the funding wallet's own scanned height.`,
  `The L2 deadline reserves ${CLAIM_MARGIN_FRACTION * 100}% of that window as margin for the second claimant.`,
  `A funding wallet more than ${MAX_SYNC_GAP_BLOCKS} blocks behind the tip is refused: its output would refund early by exactly the gap.`,
  'Both chains here are SIMULATED. No result from this harness is evidence that anything executed on Minotari or on Ootle.',
];
