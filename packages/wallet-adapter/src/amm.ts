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
export type AmmOperation = 'swap' | 'add_liquidity' | 'remove_liquidity' | 'multi_hop_swap' | 'create_pool';

interface WorkspaceBucket {
  kind: 'workspace_bucket';
  name: string;
  /** Element of a tuple output, e.g. `remove_liquidity`'s `(Bucket, Bucket)`. */
  offset?: number;
}

export interface AmmCall {
  componentAddress?: string;
  /** A component created EARLIER IN THE SAME TRANSACTION, referenced through the workspace. */
  componentWorkspace?: WorkspaceBucket;
  templateName?: string;
  method: string;
  args: Array<string | number | WorkspaceBucket>;
  resourcesInvolved: string[];
  /**
   * Where the call's return value is put. REQUIRED for every call that returns a bucket:
   * the engine rejects a transaction that leaves a returned bucket on the workspace
   * (audit_engine_tests m05), so an output that is not captured and deposited makes the
   * whole transaction fail.
   */
  output?: WorkspaceBucket;
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
  | { kind: 'call_function'; templateAddress: string; method: string; args: Array<string | number | WorkspaceBucket>; output?: WorkspaceBucket }
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
  /** Multi-hop only: every hop, in execution order. */
  route?: readonly RouteHopEvidence[];
}

export interface RouteHopEvidence {
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  /** The hop's quoted output at read time (evidence only). */
  quotedOutput: string;
  /** On-chain min_output for this hop: 1 for intermediate hops, the whole-route minimum for the last. */
  minOutput: string;
  feeBps: string;
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
        output: outputValue,
      },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: outputValue },
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
        output: lp,
      },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: lp },
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
        output: bucket('remove_liquidity_out'),
      },
      // `remove_liquidity` returns `(Bucket, Bucket)`: both tuple elements are deposited.
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: { ...bucket('remove_liquidity_out'), offset: 0 } },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: { ...bucket('remove_liquidity_out'), offset: 1 } },
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
// ---------------------------------------------------------------------------
// Multi-hop swap (atomic: one transaction, audit_engine_tests/tests/multihop_routes.rs)
// ---------------------------------------------------------------------------

export interface MultiHopSwapIntentInput {
  accountAddress: string;
  rawInputAmount: string;
  /** Hops in execution order. hops[i].outputResource === hops[i+1].inputResource. */
  hops: ReadonlyArray<{ poolComponent: string; inputResource: string; outputResource: string; quotedOutput: string; feeBps: string }>;
  /** Whole-route on-chain minimum, enforced by the LAST hop. Must be positive. */
  minOutput: string;
  maxEpoch: string;
  operationId: string;
  slippageBps: string;
  readEpoch?: string;
}

/** Engine-proven bound on route length; three hops already cost three pool fees. */
export const MAX_ROUTE_HOPS = 3;

/**
 * `withdraw -> swap(hop 1) -> ... -> swap(hop n) -> deposit`, in ONE transaction.
 *
 * Every intermediate bucket stays on the workspace, so the intermediate asset never touches
 * the account and either every hop settles or none does (m03/m04). Intermediate hops carry
 * `min_output = 1` (a hop may never return nothing); the user's whole-route minimum is the
 * LAST hop's `min_output`. Because each hop's output is monotone in its input, a worse
 * intermediate result can only lower the final output, which the final bound then refuses.
 */
export function buildMultiHopSwapIntent(input: MultiHopSwapIntentInput): AmmTransactionIntent {
  assertPositiveComponent(input.accountAddress, 'accountAddress');
  assertPositiveRawAmount(input.rawInputAmount, 'rawInputAmount');
  assertPositiveRawAmount(input.minOutput, 'minOutput');
  const hops = input.hops;
  if (hops.length < 2 || hops.length > MAX_ROUTE_HOPS) throw new Error(`a multi-hop route has 2..${MAX_ROUTE_HOPS} hops, got ${hops.length}`);
  const seenPools = new Set<string>();
  const seenResources = new Set<string>([hops[0]!.inputResource]);
  hops.forEach((hop, i) => {
    assertPositiveComponent(hop.poolComponent, `hops[${i}].poolComponent`);
    assertPositiveComponent(hop.inputResource, `hops[${i}].inputResource`);
    assertPositiveComponent(hop.outputResource, `hops[${i}].outputResource`);
    assertPositiveRawAmount(hop.quotedOutput, `hops[${i}].quotedOutput`);
    if (hop.inputResource === hop.outputResource) throw new Error(`hops[${i}] swaps a resource for itself`);
    if (i > 0 && hops[i - 1]!.outputResource !== hop.inputResource) throw new Error(`hops[${i}] does not continue from hops[${i - 1}]`);
    if (seenPools.has(hop.poolComponent)) throw new Error(`pool ${hop.poolComponent} appears twice in one route`);
    if (seenResources.has(hop.outputResource)) throw new Error(`resource ${hop.outputResource} is revisited; a cyclic route is refused`);
    seenPools.add(hop.poolComponent);
    seenResources.add(hop.outputResource);
  });
  if (BigInt(input.minOutput) > BigInt(hops[hops.length - 1]!.quotedOutput)) {
    throw new Error('minOutput exceeds the quoted route output; the route could never settle');
  }

  const buckets = hops.map((_, i) => bucket(`route_${i}`));
  const finalBucket = bucket(`route_${hops.length}`);
  const instructions: AmmInstruction[] = [
    { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: hops[0]!.inputResource, amount: input.rawInputAmount, output: buckets[0]! },
  ];
  const calls: AmmCall[] = [];
  const route: RouteHopEvidence[] = [];
  hops.forEach((hop, i) => {
    const min = i === hops.length - 1 ? input.minOutput : '1';
    const out = i === hops.length - 1 ? finalBucket : buckets[i + 1]!;
    const call: AmmCall = {
      componentAddress: hop.poolComponent,
      method: 'swap',
      args: [buckets[i]!, hop.outputResource, min],
      resourcesInvolved: [hop.inputResource, hop.outputResource],
      output: out,
    };
    calls.push(call);
    instructions.push({ kind: 'call_method', ...call });
    route.push({ poolComponent: hop.poolComponent, inputResource: hop.inputResource, outputResource: hop.outputResource, quotedOutput: hop.quotedOutput, minOutput: min, feeBps: hop.feeBps });
  });
  instructions.push({ kind: 'deposit_all', accountAddress: input.accountAddress, bucket: finalBucket });

  const first = hops[0]!;
  const last = hops[hops.length - 1]!;
  return {
    operation: 'multi_hop_swap',
    poolComponent: first.poolComponent,
    calls,
    instructions,
    requiredReadbacks: ['pool'],
    privacyDisclosure: 'PUBLIC_AMM_BOUNDARY',
    settlement: { accountAddress: input.accountAddress, outputBuckets: [finalBucket.name] },
    route,
    evidence: {
      operationId: input.operationId,
      poolComponent: first.poolComponent,
      maxEpoch: input.maxEpoch,
      readEpoch: input.readEpoch,
      quote: {
        inputResource: first.inputResource,
        outputResource: last.outputResource,
        rawInputAmount: input.rawInputAmount,
        feeBps: hops.map((h) => h.feeBps).join('+'),
        quotedOutput: last.quotedOutput,
        minOutput: input.minOutput,
        slippageBps: input.slippageBps,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Permissionless pool creation (atomic create-and-fund, m06)
// ---------------------------------------------------------------------------

export interface CreatePoolIntentInput {
  /** A Pool template RECORDED for the verified network generation (never a catalogue name match). */
  poolTemplateAddress: string;
  accountAddress: string;
  resourceA: string;
  resourceB: string;
  rawAmountA: string;
  rawAmountB: string;
  /** Fixed by the public deployment: 30 bps, retained by LPs. */
  feeBps: number;
  maxEpoch: string;
  operationId: string;
}

/** Template constants (templates/fungible_pool/src/lib.rs). */
export const POOL_MINIMUM_INITIAL_LIQUIDITY = 1_000_000n;
export const POOL_MINIMUM_LOCKED_LIQUIDITY = 1_000n;

/** floor(sqrt(n)) for a non-negative bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of a negative number');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** What the first deposit mints: total = floor(sqrt(a*b)); the creator receives total - 1000. */
export function initialLiquidityPreview(rawAmountA: string, rawAmountB: string): { totalShares: string; lockedShares: string; creatorShares: string } {
  const a = BigInt(rawAmountA);
  const b = BigInt(rawAmountB);
  if (a < POOL_MINIMUM_INITIAL_LIQUIDITY || b < POOL_MINIMUM_INITIAL_LIQUIDITY) {
    throw new Error(`each side of the first deposit must be at least ${POOL_MINIMUM_INITIAL_LIQUIDITY} raw units (template MINIMUM_INITIAL_LIQUIDITY)`);
  }
  const total = isqrt(a * b);
  if (total <= POOL_MINIMUM_LOCKED_LIQUIDITY) throw new Error('the initial deposit is too small to lock the minimum liquidity');
  return { totalShares: String(total), lockedShares: String(POOL_MINIMUM_LOCKED_LIQUIDITY), creatorShares: String(total - POOL_MINIMUM_LOCKED_LIQUIDITY) };
}

/**
 * `Pool::new(a, b, fee)` -> workspace -> withdraw both sides -> `add_liquidity` on the NEW
 * component by workspace reference -> deposit LP. One transaction: the pool either exists
 * AND is funded, or nothing happened. The pool is ownerless (OwnerRule::None), its LP
 * mint/burn is scoped to itself, and 1000 LP are locked forever by the template.
 */
export function buildCreatePoolIntent(input: CreatePoolIntentInput): AmmTransactionIntent {
  if (!/^(template_)?[0-9a-f]{64}$/.test(input.poolTemplateAddress)) throw new Error('poolTemplateAddress must be a 64-hex template address');
  assertPositiveComponent(input.accountAddress, 'accountAddress');
  assertPositiveComponent(input.resourceA, 'resourceA');
  assertPositiveComponent(input.resourceB, 'resourceB');
  if (input.resourceA === input.resourceB) throw new Error('a pool needs two distinct resources');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 1 || input.feeBps > 1000) throw new Error('feeBps must be 1..1000');
  initialLiquidityPreview(input.rawAmountA, input.rawAmountB);
  const template = input.poolTemplateAddress.replace(/^template_/, '');
  const pool = bucket('new_pool');
  const a = bucket('create_pool_a');
  const b = bucket('create_pool_b');
  const lp = bucket('create_pool_lp');
  const addCall: AmmCall = { componentWorkspace: pool, method: 'add_liquidity', args: [a, b], resourcesInvolved: [input.resourceA, input.resourceB], output: lp };
  return {
    operation: 'create_pool',
    poolComponent: `template_${template}`,
    calls: [addCall],
    instructions: [
      { kind: 'call_function', templateAddress: `template_${template}`, method: 'new', args: [input.resourceA, input.resourceB, String(input.feeBps)], output: pool },
      { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: input.resourceA, amount: input.rawAmountA, output: a },
      { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: input.resourceB, amount: input.rawAmountB, output: b },
      { kind: 'call_method', ...addCall },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: lp },
    ],
    requiredReadbacks: [],
    privacyDisclosure: 'PUBLIC_AMM_BOUNDARY',
    settlement: { accountAddress: input.accountAddress, outputBuckets: ['create_pool_lp'] },
    evidence: {
      operationId: input.operationId,
      poolComponent: `template_${template}`,
      maxEpoch: input.maxEpoch,
      quote: null,
    },
  };
}

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

