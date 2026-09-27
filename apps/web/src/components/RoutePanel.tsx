/**
 * Multi-hop route display.
 *
 * Renders the protocol's `RouteView` verbatim: the hop chain, each hop's
 * provider/state/expected amount, the final minimum, and the accepted minimum
 * shown as a protected floor. Nothing here is inferred from a timer, and the
 * preimage is never present on the view.
 *
 * When a route exists, partial completion and requote are represented honestly:
 * a settled cross-layer hop with a paused AMM hop is "intermediate received —
 * final swap paused", not "failed", and the settled intermediate is never
 * described as rollable back.
 */

import type { RouteView } from '@tari-ootle/protocol-client';
import { compareRequote, deriveRouteProgress, routeChain } from '../lib/routeProgress.js';
import { formatDuration, formatUnits, UNAVAILABLE } from '../lib/format.js';
import type { RealSubmitGate } from '../services/config.js';
import { Badge, DataRow, Notice, type BadgeTone } from './primitives.js';
import { useState } from 'react';

const STEP_TONE: Record<string, BadgeTone> = {
  DONE: 'ok',
  ACTIVE: 'info',
  PENDING: 'neutral',
  BLOCKED: 'warn',
  FAILED: 'danger',
  UNKNOWN: 'warn',
  SKIPPED: 'neutral',
};

function fmt(raw: string | undefined, decimals: string): string {
  if (raw === undefined || raw === '') return UNAVAILABLE;
  return formatUnits(raw, decimals, { maxFractionDigits: 6 });
}

export function RoutePanel({
  headline,
  description,
  available,
  unavailableHeadline,
  unavailableReason,
  realSubmit,
  route,
  unavailableRemedy,
  intermediateDecimals = '6',
  finalDecimals = '6',
  onRequote,
  onContinue,
  requote,
}: {
  headline: string;
  description: string;
  available: boolean;
  unavailableHeadline: string;
  unavailableReason: string;
  /** What the user can do about the unavailability, if anything. */
  unavailableRemedy?: string;
  realSubmit: RealSubmitGate;
  route?: RouteView;
  intermediateDecimals?: string;
  finalDecimals?: string;
  onRequote?: () => void;
  onContinue?: () => void;
  requote?: {
    newExpectedOutputRaw: string;
    newMinimumOutputRaw: string;
  };
}) {
  const [showDetail, setShowDetail] = useState(false);

  if (route === undefined) {
    return (
      <div className="stack">
        <div className="spread">
          <span className="label">Route</span>
          <Badge tone={available ? 'ok' : 'warn'}>{available ? 'Available' : 'Unavailable'}</Badge>
        </div>
        <p className="hint">{description}</p>
        <ol className="stack" style={{ gap: 'var(--s-1)', listStyle: 'none', margin: 0, padding: 0 }}>
          {['XTM', 'Fast XTM / TARI', 'TARI', 'AMM', 'Destination asset'].map((node, index) => (
            <li key={node} className="row" style={{ gap: 'var(--s-2)' }}>
              <span className="muted" aria-hidden="true">
                ↓
              </span>
              <span style={{ fontWeight: index === 0 || index === 4 ? 600 : 400 }}>{node}</span>
            </li>
          ))}
        </ol>
        <Notice tone={available ? 'info' : 'warn'} title={available ? 'Route can be quoted' : unavailableHeadline}>
          {available ? 'Every capability this route requires is advertised by the connected provider.' : unavailableReason}
          {unavailableRemedy !== undefined && (
            <>
              <br />
              {unavailableRemedy}
            </>
          )}
        </Notice>
        {!realSubmit.enabled && (
          <p className="hint">
            <strong>Real cross-chain submit:</strong> {realSubmit.reason}
          </p>
        )}
        <button type="button" className="btn btn--sm" onClick={() => setShowDetail(!showDetail)} aria-expanded={showDetail}>
          {showDetail ? 'Hide' : 'Show'} capability detail
        </button>
        {showDetail && (
          <p className="hint">
            A route is only executable when the connected provider advertises every leg capability, the real-submit gate is open, and a deadline is
            still safe. The UI never bypasses the gate.
          </p>
        )}
        <p className="hint">{headline}</p>
      </div>
    );
  }

  const progress = deriveRouteProgress(route);
  const chain = routeChain(route);
  const comparison =
    requote === undefined
      ? undefined
      : compareRequote({
          originalExpectedOutputRaw: progress.totalExpectedOutputRaw,
          originalExpectedOutputLabel: fmt(progress.totalExpectedOutputRaw, finalDecimals),
          newExpectedOutputRaw: requote.newExpectedOutputRaw,
          newExpectedOutputLabel: fmt(requote.newExpectedOutputRaw, finalDecimals),
          newMinimumOutputRaw: requote.newMinimumOutputRaw,
          newMinimumOutputLabel: fmt(requote.newMinimumOutputRaw, finalDecimals),
          acceptedMinimumFinalOutputRaw: progress.acceptedMinimumFinalOutputRaw,
          acceptedMinimumLabel: fmt(progress.acceptedMinimumFinalOutputRaw, finalDecimals),
          pauseReason: route.pausedReason,
        });

  return (
    <div className="stack">
      <div className="spread">
        <span className="label">Route</span>
        <Badge tone={progress.actionRequired === 'NONE' ? 'ok' : 'warn'}>{route.state.replace(/_/g, ' ').toLowerCase()}</Badge>
      </div>

      <ol className="stack" style={{ gap: 2, listStyle: 'none', margin: 0, padding: 0 }}>
        {chain.map((node, index) => (
          <li key={`${node.kind}-${node.label}-${index}`} className="row" style={{ gap: 'var(--s-2)' }}>
            <span style={{ fontWeight: node.kind === 'SOURCE' || node.kind === 'DESTINATION' ? 600 : 400 }}>{node.label}</span>
            {node.detail !== undefined && <span className="hint">→ {node.detail}</span>}
          </li>
        ))}
      </ol>

      <Notice tone={progress.partiallyComplete ? 'warn' : 'info'} title={progress.headline}>
        {progress.explanation}
      </Notice>

      <ol className="stack" style={{ gap: 'var(--s-2)', listStyle: 'none', margin: 0, padding: 0 }}>
        {progress.stages.map((stage) => (
          <li key={stage.id} className="spread" style={{ alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>{stage.label}</span>
              {stage.detail !== undefined && <span className="hint">{stage.detail}</span>}
              {stage.chainTxId !== undefined && <span className="hint mono">{stage.chainTxId}</span>}
            </div>
            <Badge tone={STEP_TONE[stage.status] ?? 'neutral'}>{stage.status}</Badge>
          </li>
        ))}
      </ol>

      <div className="stack" style={{ gap: 'var(--s-2)' }}>
        <DataRow label="Expected output" value={fmt(route.expectedOutputRaw, finalDecimals)} />
        <DataRow label="Final minimum" value={fmt(route.minimumOutputRaw, finalDecimals)} />
        <DataRow
          label="Your accepted minimum"
          value={fmt(route.acceptedMinimumFinalOutputRaw, finalDecimals)}
          title="A requote never lowers this floor. Continuing below it requires a fresh, explicit acceptance."
          tone="warn"
        />
        {route.provider !== null && <DataRow label="Provider" value={`${route.provider.providerId} (${route.provider.spreadBps} bps spread)`} />}
        <DataRow label="Developer trading fee" value="0" title="This protocol has no developer fee." />
        <DataRow label="Quote expires in" value={formatDuration(route.quoteExpiresAtUnixMs - Date.now())} />
      </div>

      {comparison !== undefined && (
        <Notice tone={comparison.belowAcceptedMinimum ? 'danger' : 'warn'} title={comparison.headline}>
          {comparison.detail}
        </Notice>
      )}

      {progress.partiallyComplete && (
        <p className="hint">
          Intermediate amount carried by hop 1: <strong>{fmt(route.steps[0]?.expectedOutputRaw, intermediateDecimals)}</strong>. It remains under your
          control and is not rolled back.
        </p>
      )}

      <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        {(progress.actionRequired === 'REQUOTE' || progress.actionRequired === 'CONTINUE') && onRequote !== undefined && (
          <button type="button" className="btn btn--sm btn--primary" onClick={onRequote}>
            Requote
          </button>
        )}
        {progress.actionRequired === 'CONTINUE' && onContinue !== undefined && (
          <button type="button" className="btn btn--sm" onClick={onContinue}>
            Continue
          </button>
        )}
        {progress.actionRequired === 'RECOVER' && (
          <p className="hint">
            Recovery is driven by the execution layer, which rereads both chains before deciding anything. There is deliberately no blind retry here.
          </p>
        )}
        {progress.actionRequired === 'REFUND' && (
          <p className="hint">A refund leg is available. Claiming it is an explicit action and is not performed automatically.</p>
        )}
      </div>
    </div>
  );
}
