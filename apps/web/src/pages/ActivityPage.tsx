/**
 * Operation history and recovery.
 *
 * Reads the durable `OperationRecord`s the protocol-client persisted. All five
 * states are shown, and `UNKNOWN` is shown as `UNKNOWN` with the reconciliation
 * verdict — never hidden, never rewritten to FAILED, and never retried by a
 * button.
 *
 * An explorer link appears only when a known-correct explorer URL template
 * exists. None does for Esmeralda in this repository, so none is rendered.
 */

import { useCallback, useEffect, useState } from 'react';
import type { OperationRecord, OperationState } from '@tari-ootle/protocol-client';
import { listOperations, historyIntegrity } from '../services/history.js';
import { trustLevel } from '../lib/storage.js';
import { createTransactionLookup, reconcile } from '../services/execution.js';
import { useApp } from '../state/AppContext.js';
import { explorerUrl } from '../lib/sanitize.js';
import { formatAddress, UNAVAILABLE } from '../lib/format.js';
import { Badge, Card, CardHeader, EmptyState, Notice, type BadgeTone } from '../components/primitives.js';

const STATE_TONE: Record<OperationState, BadgeTone> = {
  PENDING: 'info',
  SUBMITTED: 'info',
  CONFIRMED: 'ok',
  FAILED: 'danger',
  UNKNOWN: 'warn',
};

const STATE_EXPLANATION: Record<OperationState, string> = {
  PENDING: 'Constructed but not yet acknowledged by the transport.',
  SUBMITTED: 'The transport acknowledged a transaction id. Waiting for an authoritative answer.',
  CONFIRMED: 'An authoritative lookup proved the transaction committed.',
  FAILED: 'An authoritative lookup proved the transaction was rejected or does not exist.',
  UNKNOWN: 'The submission outcome is unknown. It is being reconciled by durable identifier and is deliberately not retried.',
};

/**
 * Why a `CONFIRMED` badge read from this browser is a claim, not a fact.
 *
 * `localStorage` is fully editable by any script on this origin, so a persisted
 * `CONFIRMED` proves only that something wrote it. The record is still shown —
 * hiding it would lose the user's only pointer to a transaction they may need to
 * reconcile — but the badge is qualified and the authoritative lookup stays
 * available instead of being blocked.
 */
const CLAIMED_EXPLANATION =
  'Stored in this browser as CONFIRMED. Local storage can be edited by any script on this origin, so this is a claim. Reconcile it against the chain before treating it as settled.';

export function ActivityPage() {
  const { executionWallets } = useApp();
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [integrity, setIntegrity] = useState<{ ok: boolean; reason?: string; count: number }>({ ok: true, count: 0 });
  const [reconciling, setReconciling] = useState<string | undefined>(undefined);
  const [verdicts, setVerdicts] = useState<Map<string, { resubmissionAllowed: boolean; reason: string; finalState: OperationState }>>(new Map());

  const refresh = useCallback(async () => {
    const [list, check] = await Promise.all([listOperations(100), historyIntegrity()]);
    setRecords(list);
    setIntegrity(check);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runReconcile = useCallback(
    async (record: OperationRecord) => {
      const wallets = executionWallets();
      if (wallets === undefined) return;
      setReconciling(record.operationId);
      try {
        const outcome = await reconcile(record, createTransactionLookup(wallets as never));
        setVerdicts((existing) => {
          const next = new Map(existing);
          next.set(record.operationId, { resubmissionAllowed: outcome.resubmissionAllowed, reason: outcome.reason, finalState: outcome.finalState });
          return next;
        });
        await refresh();
      } finally {
        setReconciling(undefined);
      }
    },
    [executionWallets, refresh],
  );

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>Activity</h1>
        <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {integrity.ok === false && (
        <Notice tone="warn" title="History integrity">
          {integrity.reason}
        </Notice>
      )}

      {records.length === 0 ? (
        <Card>
          <EmptyState
            title="No operations recorded"
            detail="Operations are persisted in this browser when a transaction is submitted. Nothing is stored on a server, and nothing is fabricated."
          />
        </Card>
      ) : (
        <div className="stack">
          {records.map((record) => (
            <OperationCard
              key={record.operationId}
              record={record}
              verdict={verdicts.get(record.operationId)}
              reconciling={reconciling === record.operationId}
              onReconcile={() => void runReconcile(record)}
              canReconcile={executionWallets() !== undefined}
            />
          ))}
        </div>
      )}

      <Card>
        <CardHeader title="What each state means" />
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Operation state definitions</caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(STATE_EXPLANATION) as OperationState[]).map((state) => (
                <tr key={state}>
                  <td>
                    <Badge tone={STATE_TONE[state]}>{state}</Badge>
                  </td>
                  <td className="hint">{STATE_EXPLANATION[state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function OperationCard({
  record,
  verdict,
  reconciling,
  onReconcile,
  canReconcile,
}: {
  record: OperationRecord;
  verdict?: { resubmissionAllowed: boolean; reason: string; finalState: OperationState };
  reconciling: boolean;
  onReconcile: () => void;
  canReconcile: boolean;
}) {
  const link = record.transactionId === undefined ? undefined : explorerUrl(record.transactionId);
  const claimed = trustLevel(record) === 'CLAIMED_BY_STORAGE';
  const stateExplanation = claimed ? CLAIMED_EXPLANATION : STATE_EXPLANATION[record.state];
  return (
    <Card className="stack">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{record.operationKind.replace(/_/g, ' ').toLowerCase()}</span>
          <span className="hint mono truncate" title={record.operationId}>
            {record.operationId}
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <Badge tone={STATE_TONE[record.state]} title={stateExplanation}>
            {record.state}
          </Badge>
          {claimed && (
            <Badge tone="warn" title={CLAIMED_EXPLANATION}>
              Unverified claim
            </Badge>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="stack" style={{ gap: 'var(--s-1)', minWidth: 0 }}>
          <span className="label">Assets</span>
          {record.resources.length === 0 ? (
            <span className="hint">{UNAVAILABLE}</span>
          ) : (
            record.resources.map((resource) => (
              <span key={resource} className="mono hint" style={{ wordBreak: 'break-all' }}>
                {resource}
              </span>
            ))
          )}
        </div>
        <div className="stack" style={{ gap: 'var(--s-1)', minWidth: 0 }}>
          <span className="label">Amounts</span>
          {Object.entries(record.amounts).length === 0 ? (
            <span className="hint">{UNAVAILABLE}</span>
          ) : (
            Object.entries(record.amounts).map(([key, value]) => (
              <span key={key} className="hint mono" style={{ wordBreak: 'break-all' }}>
                {key}: {value}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="stack" style={{ gap: 'var(--s-1)', minWidth: 0 }}>
          <span className="label">Component</span>
          <span className="mono hint" style={{ wordBreak: 'break-all' }}>
            {record.componentOrOrderId ?? UNAVAILABLE}
          </span>
        </div>
        <div className="stack" style={{ gap: 'var(--s-1)', minWidth: 0 }}>
          <span className="label">Transaction</span>
          {record.transactionId === undefined ? (
            <span className="hint">{UNAVAILABLE}</span>
          ) : link === undefined ? (
            <span className="mono hint" title={record.transactionId}>
              {formatAddress(record.transactionId, 10, 8)}
            </span>
          ) : (
            <a href={link} target="_blank" rel="noreferrer noopener">
              {formatAddress(record.transactionId, 10, 8)}
            </a>
          )}
        </div>
      </div>

      {record.quote !== undefined && (
        <div className="stack" style={{ gap: 'var(--s-1)' }}>
          <span className="label">Quote</span>
          <span className="hint mono">
            expected {record.quote.quotedOutput} · minimum {record.quote.minOutput}
          </span>
        </div>
      )}

      <div className="grid-2">
        <div className="stack" style={{ gap: 'var(--s-1)' }}>
          <span className="label">Created</span>
          <span className="hint">{new Date(record.createdAtUnixMs).toISOString()}</span>
        </div>
        <div className="stack" style={{ gap: 'var(--s-1)' }}>
          <span className="label">Epoch</span>
          <span className="hint mono">{record.epoch ?? UNAVAILABLE}</span>
        </div>
      </div>

      {record.failureReason !== undefined && (
        <Notice tone={record.state === 'FAILED' ? 'danger' : 'warn'} title="Failure / recovery information">
          {record.failureReason}
        </Notice>
      )}

      {verdict !== undefined && (
        <Notice tone={verdict.finalState === 'CONFIRMED' ? 'info' : verdict.finalState === 'FAILED' ? 'danger' : 'warn'} title={`Reconciled: ${verdict.finalState}`}>
          {verdict.reason} {verdict.resubmissionAllowed ? 'A fresh submission is safe per the authoritative lookup.' : 'Resubmission is not permitted from this state.'}
        </Notice>
      )}

      {record.state === 'UNKNOWN' && (
        <Notice tone="warn" title="Reconciling, not retrying">
          A lost submission response is not evidence of failure and not licence to submit again. The execution layer reconciles by durable identifier.
        </Notice>
      )}

      {claimed && (
        <Notice tone="warn" title="Local claim, not chain proof">
          {CLAIMED_EXPLANATION}
        </Notice>
      )}

      <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn--sm" disabled={!canReconcile || reconciling} onClick={onReconcile}>
          {reconciling ? 'Reconciling…' : claimed ? 'Verify against the chain' : 'Reconcile now'}
        </button>
        {!canReconcile && <span className="hint">Reconciliation needs a connected wallet that can look the transaction up.</span>}
      </div>
    </Card>
  );
}
