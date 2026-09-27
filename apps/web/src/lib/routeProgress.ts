/**
 * Multi-hop route presentation.
 *
 * The XTM → TARI → wSTABLE route is rendered straight from the protocol's
 * `RouteView`. The frontend does not run a state machine, infer progress from
 * timers, or decide that a partial route "failed". Every label here is derived
 * from an actual `RouteState`, `HopExecutionState`, `HopSettlementState`, or
 * `RoutePauseReason` value.
 *
 * The preimage (secret S) is never present on a `RouteView` — `containsSecret`
 * is typed `false` — and no function in this module can introduce one.
 */

import type { RouteView, RouteStepView } from '@tari-ootle/protocol-client';

export type ProgressStatus = 'DONE' | 'ACTIVE' | 'PENDING' | 'BLOCKED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';

export interface RouteProgressStage {
  id: string;
  label: string;
  status: ProgressStatus;
  detail?: string;
  /** Transaction id once a durable one exists. */
  chainTxId?: string;
}

export interface RouteProgress {
  stages: RouteProgressStage[];
  headline: string;
  explanation: string;
  /** True when hop 1 settled but the final hop has not executed. */
  partiallyComplete: boolean;
  /** True when the UI must offer Requote / Continue. */
  actionRequired: 'NONE' | 'REQUOTE' | 'CONTINUE' | 'RECOVER' | 'REFUND' | 'RESUME';
  /** Never a number the UI invented. */
  totalExpectedOutputRaw: string;
  totalMinimumOutputRaw: string;
  acceptedMinimumFinalOutputRaw: string;
  /** The user floor, shown as protected. */
  minimumProtected: boolean;
}

const HOP_LABELS: Record<string, string> = {
  FAST_XTM_TARI: 'Cross-layer XTM / TARI',
  AMM_SWAP: 'AMM swap',
};

function stepLabel(step: RouteStepView): string {
  return `${step.fromLabel} → ${step.toLabel}`;
}

function stageForStep(step: RouteStepView): ProgressStatus {
  switch (step.status) {
    case 'SETTLED':
      return 'DONE';
    case 'EXECUTING':
      return 'ACTIVE';
    case 'AWAITING_CONFIRMATION':
      return 'ACTIVE';
    case 'SKIPPED':
      return 'SKIPPED';
    case 'FAILED':
      return 'FAILED';
    case 'UNKNOWN':
      return 'UNKNOWN';
    case 'PENDING':
    default:
      return 'PENDING';
  }
}

const PAUSE_EXPLANATIONS: Record<string, string> = {
  INTERMEDIATE_SETTLED_REQUOTE_REQUIRED:
    'The cross-layer hop settled. The AMM moved outside the constraints this quote was accepted under, so the final hop is paused rather than executed.',
  AMM_LIQUIDITY_GONE: 'The AMM hop has no usable liquidity. The settled TARI remains yours.',
  AMM_MIN_OUTPUT_BELOW_ACCEPTED_MINIMUM: "The AMM's own min_output now falls below the minimum you accepted, so the route is paused.",
  AMM_QUOTE_EXPIRED: 'The AMM quote expired. The settled TARI remains yours.',
  AMM_PRICE_OUT_OF_ACCEPTED_BOUNDS: 'The AMM price moved outside the bounds this quote was accepted under.',
  INTERMEDIATE_AMOUNT_MISMATCH: 'The settled intermediate amount does not match the amount this route was built for.',
  AMM_DUST_INPUT: 'The settled intermediate amount is too small to produce a non-zero AMM output.',
  AMM_EXECUTION_FAILED: 'The AMM leg failed. The settled intermediate is safe, unspent, and still yours — it is not rolled back.',
  WALLET_PROVIDER_UNAVAILABLE: 'The wallet provider became unavailable before the final hop could be submitted.',
};

export function explainPause(reason: string | undefined): string {
  if (reason === undefined) return 'The route is paused.';
  return PAUSE_EXPLANATIONS[reason] ?? `The route is paused: ${reason}.`;
}

/**
 * Derive a clean progress model. Ordering follows the actual hop order in the
 * route record, never an assumed shape.
 */
export function deriveRouteProgress(view: RouteView): RouteProgress {
  const stages: RouteProgressStage[] = [
    {
      id: 'prepare',
      label: 'Preparing',
      status: view.state === 'ROUTE_QUOTED' ? 'ACTIVE' : 'DONE',
      detail: 'Quote built from the protocol route resolver. No funds have moved.',
    },
    {
      id: 'approval',
      label: 'Awaiting wallet approval',
      status: view.requiresApproval ? 'ACTIVE' : 'DONE',
      detail: view.requiresApproval ? 'The wallet is being asked to authorise this exact route and its accepted minimum.' : 'Route already authorised.',
    },
  ];

  for (const step of view.steps) {
    stages.push({
      id: `hop-${step.index}`,
      label: HOP_LABELS[step.kind] ?? stepLabel(step),
      status: stageForStep(step),
      detail: step.failureReason ?? `${stepLabel(step)} — expected ${step.expectedOutputRaw}${step.minimumOutputRaw !== undefined ? `, minimum ${step.minimumOutputRaw}` : ''}`,
      chainTxId: step.chainTxId,
    });
  }

  if (view.steps.length > 1) {
    const terminal = view.steps[view.steps.length - 1];
    stages.push({
      id: 'final',
      label: 'Complete',
      status: terminal.status === 'SETTLED' ? 'DONE' : terminal.status === 'FAILED' ? 'FAILED' : terminal.status === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING',
      detail: `Final settlement of ${view.to.label}.`,
    });
  }

  const hop1 = view.steps[0];
  const hop1Settled = hop1?.status === 'SETTLED';
  const lastStep = view.steps[view.steps.length - 1];
  const lastSettled = lastStep?.status === 'SETTLED';
  const partiallyComplete = hop1Settled && !lastSettled;

  let actionRequired: RouteProgress['actionRequired'] = 'NONE';
  let headline = 'Route in progress';
  let explanation = 'The route is executing against the protocol state machine.';

  if (view.recoveryRequired) {
    actionRequired = view.claimState === 'REFUNDABLE' ? 'REFUND' : 'RECOVER';
    headline = 'Recovery required';
    explanation =
      'This route is in recovery. The execution layer will not resubmit a hop whose outcome is unknown; recovery re-reads authoritative state first.';
  } else if (view.claimState === 'REFUNDABLE') {
    actionRequired = 'REFUND';
    headline = 'Refund available';
    explanation = 'The refund leg is available. Claiming the refund is an explicit user action.';
  } else if (lastSettled) {
    actionRequired = 'NONE';
    headline = 'Route complete';
    explanation = 'Every hop settled and the final asset was delivered.';
  } else if (lastStep?.status === 'FAILED') {
    // A failed FINAL hop is not a failed route: hop 1 already settled, so the
    // intermediate stays with the user and the final hop can be retried,
    // re-quoted, or skipped.
    actionRequired = partiallyComplete ? 'CONTINUE' : 'RECOVER';
    headline = partiallyComplete ? 'Intermediate asset received — final swap failed' : 'Route failed';
    explanation = explainPause(view.pausedReason);
  } else if (lastStep?.status === 'UNKNOWN') {
    actionRequired = 'RECOVER';
    headline = 'Final hop outcome unknown';
    explanation = 'The submission outcome is unknown. It is being reconciled by durable identifier, not retried.';
  } else if (view.state === 'HOP2_SKIPPED') {
    actionRequired = 'CONTINUE';
    headline = 'Intermediate asset kept';
    explanation = 'The final hop was deliberately skipped. The intermediate asset remains under your control.';
  } else if (view.requoteRequired) {
    actionRequired = 'REQUOTE';
    headline = 'Intermediate asset received — final swap paused';
    explanation = explainPause(view.pausedReason);
  } else if (partiallyComplete) {
    actionRequired = 'CONTINUE';
    headline = 'Intermediate asset received — final swap paused';
    explanation = explainPause(view.pausedReason);
  } else if (view.state === 'ROUTE_QUOTED') {
    actionRequired = 'NONE';
    headline = 'Quote ready';
    explanation = 'Review the route, fees, and the minimum you are accepting before authorising.';
  } else if (view.state === 'ROUTE_FAILED_TERMINAL') {
    actionRequired = 'RECOVER';
    headline = 'Route failed';
    explanation = 'The route reached a terminal failure state.';
  }

  if (view.steps.some((s) => s.status === 'SKIPPED') && actionRequired === 'NONE') {
    stages[stages.length - 1] = { ...stages[stages.length - 1], status: 'SKIPPED' };
  }

  return {
    stages,
    headline,
    explanation,
    partiallyComplete,
    actionRequired,
    totalExpectedOutputRaw: view.expectedOutputRaw,
    totalMinimumOutputRaw: view.minimumOutputRaw,
    acceptedMinimumFinalOutputRaw: view.acceptedMinimumFinalOutputRaw,
    minimumProtected: true,
  };
}

export interface RequoteComparison {
  originalExpectedOutputRaw: string;
  newExpectedOutputRaw?: string;
  newMinimumOutputRaw?: string;
  userAcceptedMinimumRaw: string;
  /** True when the protocol proves the new minimum is below the accepted floor. */
  belowAcceptedMinimum: boolean;
  /** True when the route may continue under the same acceptance. */
  canContinueWithoutReacceptance: boolean;
  headline: string;
  detail: string;
}

/**
 * Requote comparison. The user's accepted minimum is displayed as a protected
 * floor; the UI never lowers it and never continues automatically when the
 * protocol says the new output cannot satisfy it.
 */
export function compareRequote(input: {
  originalExpectedOutputRaw: string;
  originalExpectedOutputLabel: string;
  newExpectedOutputRaw?: string;
  newExpectedOutputLabel?: string;
  newMinimumOutputRaw?: string;
  newMinimumOutputLabel?: string;
  acceptedMinimumFinalOutputRaw: string;
  acceptedMinimumLabel: string;
  pauseReason?: string;
}): RequoteComparison {
  const below =
    input.newMinimumOutputRaw !== undefined && BigInt(input.newMinimumOutputRaw) < BigInt(input.acceptedMinimumFinalOutputRaw);
  return {
    originalExpectedOutputRaw: input.originalExpectedOutputRaw,
    newExpectedOutputRaw: input.newExpectedOutputRaw,
    newMinimumOutputRaw: input.newMinimumOutputRaw,
    userAcceptedMinimumRaw: input.acceptedMinimumFinalOutputRaw,
    belowAcceptedMinimum: below,
    canContinueWithoutReacceptance: !below && input.newExpectedOutputRaw !== undefined,
    headline: below ? 'New quote cannot meet your minimum' : 'New quote available',
    detail: below
      ? `The re-quoted minimum (${input.newMinimumOutputLabel ?? input.newMinimumOutputRaw}) is below the minimum you accepted (${input.acceptedMinimumLabel ?? input.acceptedMinimumFinalOutputRaw}). Continuing would lower a floor you already approved, so it requires a fresh, explicit acceptance.`
      : `${explainPause(input.pauseReason)} The original expected output was ${input.originalExpectedOutputLabel ?? input.originalExpectedOutputRaw}; the re-quote now expects ${input.newExpectedOutputLabel ?? input.newExpectedOutputRaw ?? '—'}.`,
  };
}

/**
 * The route visual chain required by the mission, built from the actual hop
 * kinds present in the route record rather than a hard-coded XTM diagram.
 */
export interface RouteChainNode {
  label: string;
  kind: 'SOURCE' | 'CROSS_LAYER' | 'INTERMEDIATE' | 'AMM' | 'DESTINATION';
  /** Extra label shown beneath the node, e.g. the hop's output asset. */
  detail?: string;
  /** Exact identity when the node corresponds to a known resource. */
  resourceAddress?: string;
}

export function routeChain(view: RouteView): RouteChainNode[] {
  const nodes: RouteChainNode[] = [{ label: view.from.label, kind: 'SOURCE' }];
  for (const step of view.steps) {
    if (step.kind === 'FAST_XTM_TARI') {
      nodes.push({ label: 'FAST XTM / TARI', kind: 'CROSS_LAYER', detail: step.toLabel });
    } else if (step.kind === 'AMM_SWAP') {
      nodes.push({ label: 'AMM', kind: 'AMM' });
    }
    nodes.push({ label: step.toLabel, kind: step.kind === 'AMM_SWAP' ? 'DESTINATION' : 'INTERMEDIATE' });
  }
  if (nodes[nodes.length - 1]?.label !== view.to.label) {
    nodes.push({ label: view.to.label, kind: 'DESTINATION' });
  }
  return nodes;
}

export interface FeeLineItem {
  label: string;
  raw: string;
  /** Clarifies whose margin this is. Never labelled protocol revenue. */
  note: string;
}

/** Fee presentation. The developer trading fee is always rendered as zero. */
export function feeLineItems(view: RouteView): FeeLineItem[] {
  const items: FeeLineItem[] = [
    { label: 'Provider spread', raw: view.fees.providerSpreadRaw, note: "The cross-layer provider's economic margin. Not a protocol fee." },
    { label: 'L1 network fee', raw: view.fees.l1NetworkFeeRaw, note: 'Estimated Minotari network fee.' },
    { label: 'L2 HTLC network fee', raw: view.fees.l2HtlcNetworkFeeRaw, note: 'Estimated Ootle network fee for the HTLC leg.' },
    { label: 'AMM LP fee', raw: view.fees.ammLpFeeRaw, note: 'Paid entirely to liquidity providers.' },
    { label: 'AMM network fee', raw: view.fees.ammNetworkFeeRaw, note: 'Estimated Ootle network fee for the swap.' },
  ];
  return items;
}
