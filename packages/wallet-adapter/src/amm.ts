import { TransactionPreview } from './interface.js';

/**
 * Signer-agnostic AMM transaction descriptions. Wallet adapters translate these into their
 * own manifest/SDK format, then sign and submit separately. The pool template consumes
 * buckets, so withdrawals are explicit instructions — an adapter cannot accidentally build
 * a call whose inputs cannot be produced on-chain.
 *
 * Every intent carries a maxEpoch expiry bound (bound to `with_max_epoch` on-chain): a
 * signed swap must never remain valid indefinitely after market state moves.
 */
export type AmmOperation = 'swap' | 'add_liquidity' | 'remove_liquidity';

interface WorkspaceBucket {
  kind: 'workspace_bucket';
  name: string;
}

export interface AmmCall {
  componentAddress?: string;
  templateName?: string;
  method: string;
  args: Array<string | number | WorkspaceBucket>;
  resourcesInvolved: string[];
}

export type AmmInstruction =
  | {
      kind: 'withdraw_fungible';
      accountAddress: string;
      resourceAddress: string;
      /** Raw integer amount string — never a float. */
      amount: string;
      output: WorkspaceBucket;
    }
  | ({ kind: 'call_method' } & AmmCall)
  | { kind: 'deposit_all'; accountAddress: string; bucket: WorkspaceBucket };

/** Evidence recorded for the operation history store at construction time. */
export interface AmmIntentEvidence {
  operationId: string;
  quote: {
    inputResource: string;
    outputResource: string;
    rawInputAmount: string;
    feeBps: string;
    quotedOutput: string;
    minOutput: string;
    slippageBps: string;
    effectiveInput?: string;
  } | null;
  poolComponent: string;
  freshnessStateIdentity?: string;
  readEpoch?: string;
  maxEpoch: string;
}

export interface AmmTransactionIntent {
  operation: AmmOperation;
  poolComponent: string;
  calls: AmmCall[];
  instructions: AmmInstruction[];
  /** The router must obtain a fresh authoritative pool read before settlement. */
  requiredReadbacks: Array<'pool'>;
  /** Output bucket handling: deposited back to the user's account. */
  settlement: { accountAddress: string; outputBuckets: string[] };
  privacyDisclosure: 'PUBLIC_AMM_BOUNDARY';
  evidence: AmmIntentEvidence;
}

function bucket(name: string): WorkspaceBucket {
  return { kind: 'workspace_bucket', name };
}

function methodCall(componentAddress: string, method: string, args: AmmCall['args'], resourcesInvolved: string[]): AmmInstruction {
  return { kind: 'call_method', componentAddress, method, args, resourcesInvolved };
}

function assertRawAmount(value: string, field: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a raw non-negative integer string, got ${value}`);
}

function assertPositiveRawAmount(value: string, field: string): void {
  assertRawAmount(value, field);
  if (BigInt(value) === 0n) throw new Error(`${field} must be positive`);
}

export interface SwapIntentInput {
  poolComponent: string;
  accountAddress: string;
  inputResource: string;
  outputResource: string;
  /** Raw integer input amount. */
  rawInputAmount: string;
  /** On-chain enforced slippage bound (from the resolver, never the raw user tolerance). */
  minOutput: string;
  /** Transaction expiry bound (with_max_epoch). */
  maxEpoch: string;
  operationId: string;
  /** Authoritative quote carried for evidence; adapters must not recompute it. */
  quoteEvidence: SwapIntentEvidenceQuote;
}

export interface SwapIntentEvidenceQuote {
  quotedOutput: string;
  feeBps: string;
  slippageBps: string;
  effectiveInput: string;
  readEpoch?: string;
}

/** Builds a signer-agnostic swap intent. min_output is REQUIRED and must be positive. */
export function buildSwapIntent(input: SwapIntentInput): AmmTransactionIntent {
  assertPositiveComponent(input.poolComponent, 'poolComponent');
  assertPositiveComponent(input.accountAddress, 'accountAddress');
  assertPositiveComponent(input.inputResource, 'inputResource');
  assertPositiveComponent(input.outputResource, 'outputResource');
  assertPositiveRawAmount(input.rawInputAmount, 'rawInputAmount');
  assertPositiveRawAmount(input.minOutput, 'minOutput');
  if (BigInt(input.minOutput) === 0n) {
    // Zero min_output for a positive trade is only legitimate with an explicit, recorded
    // dust-trade justification; the resolver marks such quotes with slippage policy.
    throw new Error('minOutput must be positive for a positive-amount swap; a zero min_output disables on-chain slippage protection');
  }
  const inputValue = bucket('swap_input');
  const outputValue = bucket('swap_output');
  return {
    operation: 'swap',
    poolComponent: input.poolComponent,
    calls: [
      {
        componentAddress: input.poolComponent,
        method: 'swap',
        args: [inputValue, input.outputResource, input.minOutput],
        resourcesInvolved: [input.inputResource, input.outputResource],
      },
    ],
    instructions: [
      {
        kind: 'withdraw_fungible',
        accountAddress: input.accountAddress,
        resourceAddress: input.inputResource,
        amount: input.rawInputAmount,
        output: inputValue,
      },
      {
        kind: 'call_method',
        componentAddress: input.poolComponent,
        method: 'swap',
        args: [inputValue, input.outputResource, input.minOutput],
        resourcesInvolved: [input.inputResource, input.outputResource],
      },
    ],
    requiredReadbacks: ['pool'],
    privacyDisclosure: 'PUBLIC_AMM_BOUNDARY',
    settlement: { accountAddress: input.accountAddress, outputBuckets: ['swap_output'] },
    evidence: {
      operationId: input.operationId,
      maxEpoch: input.maxEpoch,
      poolComponent: input.poolComponent,
      readEpoch: input.quoteEvidence.readEpoch,
      quote: {
        inputResource: input.inputResource,
        outputResource: input.outputResource,
        rawInputAmount: input.rawInputAmount,
        feeBps: input.quoteEvidence.feeBps,
        quotedOutput: input.quoteEvidence.quotedOutput,
        minOutput: input.minOutput,
        slippageBps: input.quoteEvidence.slippageBps,
        effectiveInput: input.quoteEvidence.effectiveInput,
      },
    },
  };
}

export interface AddLiquidityIntentInput {
  poolComponent: string;
  accountAddress: string;
  resourceA: string;
  resourceB: string;
  rawAmountA: string;
  rawAmountB: string;
  maxEpoch: string;
  operationId: string;
}

export function buildAddLiquidityIntent(input: AddLiquidityIntentInput): AmmTransactionIntent {
  assertPositiveComponent(input.poolComponent, 'poolComponent');
  assertPositiveComponent(input.accountAddress, 'accountAddress');
  assertPositiveComponent(input.resourceA, 'resourceA');
  assertPositiveComponent(input.resourceB, 'resourceB');
  if (input.resourceA === input.resourceB) throw new Error('add_liquidity requires two distinct resources');
  assertPositiveRawAmount(input.rawAmountA, 'rawAmountA');
  assertPositiveRawAmount(input.rawAmountB, 'rawAmountB');
  const a = bucket('add_liquidity_a');
  const b = bucket('add_liquidity_b');
  const lp = bucket('add_liquidity_lp');
  return {
    operation: 'add_liquidity',
    poolComponent: input.poolComponent,
    calls: [
      {
        componentAddress: input.poolComponent,
        method: 'add_liquidity',
        args: [a, b],
        resourcesInvolved: [input.resourceA, input.resourceB],
      },
    ],
    instructions: [
      { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: input.resourceA, amount: input.rawAmountA, output: a },
      { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: input.resourceB, amount: input.rawAmountB, output: b },
      {
        kind: 'call_method',
        componentAddress: input.poolComponent,
        method: 'add_liquidity',
        args: [a, b],
        resourcesInvolved: [input.resourceA, input.resourceB],
      },
    ],
    requiredReadbacks: ['pool'],
    privacyDisclosure: 'PUBLIC_AMM_BOUNDARY',
    settlement: { accountAddress: input.accountAddress, outputBuckets: ['add_liquidity_lp'] },
    evidence: {
      operationId: input.operationId,
      poolComponent: input.poolComponent,
      maxEpoch: input.maxEpoch,
      quote: {
        inputResource: input.resourceA,
        outputResource: input.resourceB,
        rawInputAmount: input.rawAmountA,
        feeBps: '0',
        quotedOutput: input.rawAmountB,
        minOutput: '0',
        slippageBps: '0',
        effectiveInput: input.rawAmountA,
      },
    },
  };
}

export interface RemoveLiquidityIntentInput {
  poolComponent: string;
  accountAddress: string;
  lpResource: string;
  /** Raw LP amount to burn. */
  rawLpAmount: string;
  maxEpoch: string;
  operationId: string;
}

export function buildRemoveLiquidityIntent(input: RemoveLiquidityIntentInput): AmmTransactionIntent {
  assertPositiveComponent(input.poolComponent, 'poolComponent');
  assertPositiveComponent(input.accountAddress, 'accountAddress');
  assertPositiveComponent(input.lpResource, 'lpResource');
  assertPositiveRawAmount(input.rawLpAmount, 'rawLpAmount');
  const lp = bucket('remove_liquidity_lp');
  return {
    operation: 'remove_liquidity',
    poolComponent: input.poolComponent,
    calls: [
      {
        componentAddress: input.poolComponent,
        method: 'remove_liquidity',
        args: [lp],
        resourcesInvolved: [input.lpResource],
      },
    ],
    instructions: [
      {
        kind: 'withdraw_fungible',
        accountAddress: input.accountAddress,
        resourceAddress: input.lpResource,
        amount: input.rawLpAmount,
        output: lp,
      },
      {
        kind: 'call_method',
        componentAddress: input.poolComponent,
        method: 'remove_liquidity',
        args: [lp],
        resourcesInvolved: [input.lpResource],
      },
    ],
    requiredReadbacks: ['pool'],
    privacyDisclosure: 'PUBLIC_AMM_BOUNDARY',
    settlement: { accountAddress: input.accountAddress, outputBuckets: ['remove_liquidity_a', 'remove_liquidity_b'] },
    evidence: {
      operationId: input.operationId,
      poolComponent: input.poolComponent,
      maxEpoch: input.maxEpoch,
      quote: {
        inputResource: input.lpResource,
        outputResource: '',
        rawInputAmount: input.rawLpAmount,
        feeBps: '0',
        quotedOutput: input.rawLpAmount,
        minOutput: '0',
        slippageBps: '0',
        effectiveInput: input.rawLpAmount,
      },
    },
  };
}

function assertPositiveComponent(value: string, field: string): void {
  if (value.length === 0) throw new Error(`${field} must be a non-empty component/resource address`);
}

/** Numeric display shim; refuses to represent out-of-safe-range epochs as a lossy number. */
function safeEpochShim(maxEpoch: string): number {
  if (!/^\d+$/.test(maxEpoch)) return 0;
  const value = Number(maxEpoch);
  return Number.isSafeInteger(value) ? value : 0;
}

/** Converts an AMM intent into the adapter preview seam without selecting a wallet. */
export function toAmmPreview(intentValue: AmmTransactionIntent): TransactionPreview {
  const first = intentValue.calls[0];
  return {
    componentAddress: first?.componentAddress,
    method: first?.method,
    args: intentValue.instructions,
    resourcesInvolved: [...new Set(intentValue.calls.flatMap((call) => call.resourcesInvolved))],
    estimatedOutputs: intentValue.evidence.quote ? [{ resource: intentValue.evidence.quote.outputResource, amount: intentValue.evidence.quote.minOutput }] : [],
    fee: 0,
    // Display shim only: TransactionPreview.maxEpoch is a JS number. The AUTHORITATIVE
    // expiry bound is intentValue.evidence.maxEpoch (decimal string) and must be bound via
    // with_max_epoch by the adapter that builds the real manifest.
    maxEpoch: safeEpochShim(intentValue.evidence.maxEpoch),
    privacyDisclosure: 'PUBLIC AMM BOUNDARY: pool reserves, swap direction, and amounts are revealed.',
    networkName: '',
  };
}

