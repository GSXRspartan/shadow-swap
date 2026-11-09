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
import { takePrePoolSnapshot } from '../services/marketObservations.js';
import { Badge, Card, CardHeader, EmptyState, Notice, type BadgeTone } from '../components/primitives.js';
import {
  describeResumeRefusal,
  needsAttention,
  resumeBlockReason,
  type PendingWalletRequest,
  type ResumeRefusal,
} from '../lib/pendingRequests.js';
import type { TariRequestOutcome } from '../services/tariWindow.js';

const STATE_TONE: Record<OperationState, BadgeTone> = {
  PENDING: 'info',
  SUBMITTED: 'info',
  CONFIRMED: 'ok',
  FAILED: 'danger',
  UNKNOWN: 'warn',
};

const STATE_EXPLANATION: Record<OperationState, string> = {
  PENDING: 'Built and ready to send, but not yet received by the network.',
  SUBMITTED: 'Sent to the network. Waiting for confirmation that it committed.',
  CONFIRMED: 'The network confirmed this transaction went through.',
  FAILED: 'The network rejected this transaction. It did not execute.',
  UNKNOWN: 'The outcome is unclear. This app will not submit it again automatically — check your wallet and reconcile below; operations are being reconciled by durable identifier, never by resubmission.',
};

const CLAIMED_EXPLANATION =
  'Marked as confirmed in your browser history. Use "Verify on chain" below to get an authoritative answer directly from the network.';

export function ActivityPage() {
  const { executionWallets, walletBridge, wallet, market, bundleFor } = useApp();
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [integrity, setIntegrity] = useState<{ ok: boolean; reason?: string; count: number }>({ ok: true, count: 0 });
  const [reconciling, setReconciling] = useState<string | undefined>(undefined);
  const [verdicts, setVerdicts] = useState<Map<string, { resubmissionAllowed: boolean; reason: string; finalState: OperationState }>>(new Map());
  const [pending, setPending] = useState<PendingWalletRequest[]>([]);
  const [checkBusy, setCheckBusy] = useState<string | undefined>(undefined);
  const [submitBusy, setSubmitBusy] = useState<string | undefined>(undefined);
  const [checkResults, setCheckResults] = useState<Map<string, TariRequestOutcome>>(new Map());
  const [resumeOutcome, setResumeOutcome] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    const [list, check] = await Promise.all([listOperations(100), historyIntegrity()]);
    setRecords(list);
    setIntegrity(check);
    const bridge = walletBridge();
    setPending(bridge === undefined ? [] : [...bridge.pendingRequests()]);
  }, [walletBridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runReconcile = useCallback(
    async (record: OperationRecord) => {
      const wallets = executionWallets();
      if (wallets === undefined) return;
      setReconciling(record.operationId);
      try {
        const snapshot = takePrePoolSnapshot(record.operationId);
        const bridge = walletBridge();
        const pool = market.pools.find((p) => snapshot !== undefined && p.poolComponent === snapshot.poolComponent);
        const outcome = await reconcile(record, createTransactionLookup(wallets as never), snapshot === undefined || bridge === undefined || pool === undefined
          ? undefined
          : {
              before: snapshot,
              readback: bridge.readbackProvider(),
              ingest: async (observation) => {
                const bundle = bundleFor(pool.poolComponent, pool);
                await bundle?.ingest(observation);
              },
            });
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
    [executionWallets, refresh, walletBridge, market.pools, bundleFor],
  );

  /**
   * Read-only status check: query the wallet for the current state of this request.
   * Never calls tari_submitTransactionRequest. The result is shown to the user;
   * if the wallet reports APPROVED a separate Submit button appears.
   */
  const runCheck = useCallback(
    async (record: PendingWalletRequest) => {
      const bridge = walletBridge();
      const account = wallet.account;
      if (bridge === undefined || account === undefined) return;
      setCheckBusy(record.operationId);
      try {
        const outcome = await bridge.checkRequestStatus(record, { account, network: wallet.networkId ?? '' });
        setCheckResults((existing) => {
          const next = new Map(existing);
          next.set(record.operationId, outcome);
          return next;
        });
        // If the wallet already submitted this, surface the txId in the outcome map too.
        if (outcome.state === 'SUBMITTED' && outcome.transactionId !== undefined) {
          setResumeOutcome((existing) => {
            const next = new Map(existing);
            next.set(record.operationId, `Already submitted as ${formatAddress(outcome.transactionId!, 10, 8)}. Reconcile below to confirm it committed.`);
            return next;
          });
        }
        await refresh();
      } catch (error) {
        setCheckResults((existing) => {
          const next = new Map(existing);
          next.set(record.operationId, { state: 'FAILED', requestId: record.requestId, reason: (error as Error).message });
          return next;
        });
      } finally {
        setCheckBusy(undefined);
      }
    },
    [walletBridge, wallet.account, wallet.networkId, refresh],
  );

  /**
   * Submit the already-approved request by id — exactly once.
   *
   * Only reachable after runCheck returns APPROVED. Guards at the service layer
   * prevent double-submission even if the button is clicked twice.
   */
  const runSubmit = useCallback(
    async (record: PendingWalletRequest) => {
      const bridge = walletBridge();
      const account = wallet.account;
      if (bridge === undefined || account === undefined) return;
      setSubmitBusy(record.operationId);
      try {
        const result = await bridge.submitApprovedRequest(record, { account, network: wallet.networkId ?? '' });
        setResumeOutcome((existing) => {
          const next = new Map(existing);
          next.set(record.operationId, `Submitted as ${formatAddress(result.transactionId, 10, 8)}. Reconcile below to confirm it committed.`);
          return next;
        });
        // Clear the check result so the submit button disappears.
        setCheckResults((existing) => {
          const next = new Map(existing);
          next.delete(record.operationId);
          return next;
        });
        await refresh();
      } catch (error) {
        setResumeOutcome((existing) => {
          const next = new Map(existing);
          next.set(record.operationId, (error as Error).message);
          return next;
        });
      } finally {
        setSubmitBusy(undefined);
      }
    },
    [walletBridge, wallet.account, wallet.networkId, refresh],
  );

  const liveAccount = wallet.account;
  const liveNetwork = wallet.networkId ?? '';
  const blocking = pending.find(
    (p) => needsAttention(p) && (liveAccount === undefined || p.approvedAccount === liveAccount) && p.approvedNetwork === liveNetwork,
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

      {blocking !== undefined && (
        <Notice tone="warn" title="A transaction is waiting for your approval">
          A {blocking.operation.replace(/_/g, ' ').toLowerCase()} request is open in your wallet and has not been submitted. Approve or
          cancel it there. Starting another transaction while this one is open would create a second request for the same intent, and approving
          both would execute both.
        </Notice>
      )}

      <PendingApprovalPanel
        pending={pending}
        checkBusy={checkBusy}
        submitBusy={submitBusy}
        checkResults={checkResults}
        outcomes={resumeOutcome}
        liveAccount={liveAccount}
        liveNetwork={liveNetwork}
        onCheck={(record) => void runCheck(record)}
        onSubmit={(record) => void runSubmit(record)}
      />

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

function PendingApprovalPanel({
  pending,
  checkBusy,
  submitBusy,
  checkResults,
  outcomes,
  liveAccount,
  liveNetwork,
  onCheck,
  onSubmit,
}: {
  pending: readonly PendingWalletRequest[];
  checkBusy: string | undefined;
  submitBusy: string | undefined;
  checkResults: ReadonlyMap<string, TariRequestOutcome>;
  outcomes: ReadonlyMap<string, string>;
  liveAccount: string | undefined;
  liveNetwork: string;
  onCheck: (record: PendingWalletRequest) => void;
  onSubmit: (record: PendingWalletRequest) => void;
}) {
  if (pending.length === 0) return null;
  return (
    <Card className="stack">
      <CardHeader title="Wallet approvals" />
      <p className="hint">
        These transactions are open in your wallet. Use <strong>Check status</strong> to query the current state without submitting anything. If the wallet confirms approval, a separate <strong>Submit approved transaction</strong> button will appear.
      </p>
      <div className="stack">
        {pending.map((record) => {
          // Safety checks against the LIVE session. Every mismatch blocks.
          // NO_LIVE_REVIEW is not a block: id-based submit needs no live review.
          const refusal: ResumeRefusal | undefined =
            liveAccount === undefined ? 'ACCOUNT_CHANGED' : resumeBlockReason(record, { account: liveAccount, network: liveNetwork });
          const blocked = refusal !== undefined && refusal !== 'NOT_BLOCKING' && refusal !== 'NO_LIVE_REVIEW';
          const outcome = outcomes.get(record.operationId);
          const checkResult = checkResults.get(record.operationId);
          const anyBusy = checkBusy === record.operationId || submitBusy === record.operationId;

          // Submit button: only shown when the wallet confirmed APPROVED and no
          // outcome (submission or terminal error) has been recorded yet.
          const showSubmit = checkResult?.state === 'APPROVED' && outcome === undefined;

          return (
            <div key={record.operationId} className="stack" style={{ gap: 'var(--s-2)', padding: 'var(--s-3)', border: '1px solid var(--border, rgba(255,255,255,.08))', borderRadius: 'var(--r-2)' }}>
              <div className="spread" style={{ flexWrap: 'wrap' }}>
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{record.operation.replace(/_/g, ' ').toLowerCase()}</span>
                  <span className="hint mono truncate" title={record.operationId}>
                    {record.operationId}
                  </span>
                </div>
                <Badge tone={record.state === 'REJECTED' || record.state === 'FAILED' ? 'danger' : 'warn'}>
                  {record.state.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              </div>

              <div className="grid-2">
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="label">Wallet request</span>
                  <span className="mono hint" style={{ wordBreak: 'break-all' }}>
                    {record.requestId}
                  </span>
                </div>
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="label">Approved by</span>
                  <span className="mono hint" style={{ wordBreak: 'break-all' }}>
                    {formatAddress(record.approvedAccount, 10, 8)} on {record.approvedNetwork}
                  </span>
                </div>
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="label">Destination</span>
                  <span className="mono hint" style={{ wordBreak: 'break-all' }}>
                    {formatAddress(record.destination, 10, 8)}
                  </span>
                </div>
              </div>

              {blocked && refusal !== undefined && (
                <Notice tone="warn" title="Cannot resume from this session">
                  {describeResumeRefusal(refusal)}
                </Notice>
              )}

              {/* Wallet status after a check — shown until submission clears it */}
              {checkResult !== undefined && outcome === undefined && (
                <Notice
                  tone={checkResult.state === 'APPROVED' || checkResult.state === 'SUBMITTED' ? 'info' : 'warn'}
                  title="Wallet status"
                >
                  {checkResult.state === 'PENDING'
                    ? 'Still waiting for your approval. Nothing has been submitted.'
                    : checkResult.state === 'APPROVED'
                      ? 'Your wallet has approved this request. Click Submit below to broadcast it.'
                      : checkResult.state === 'SUBMITTED'
                        ? `Already submitted${checkResult.transactionId !== undefined ? ` as ${formatAddress(checkResult.transactionId, 10, 8)}` : ''}. Reconcile below to confirm it committed.`
                        : checkResult.state === 'REJECTED'
                          ? `Declined by wallet${checkResult.reason !== undefined ? `: ${checkResult.reason}` : '.'}`
                          : checkResult.state === 'FAILED'
                            ? `Wallet reported failure${checkResult.reason !== undefined ? `: ${checkResult.reason}` : '.'}`
                            : `Unknown wallet status${checkResult.state === 'UNKNOWN_STATUS' && checkResult.rawStatus !== undefined ? ` (${checkResult.rawStatus})` : ''}.`}
                </Notice>
              )}

              {outcome !== undefined && (
                <Notice tone={outcome.startsWith('Submitted') || outcome.startsWith('Already') ? 'info' : 'warn'} title="Result">
                  {outcome}
                </Notice>
              )}

              <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                {/* Read-only check button — never submits */}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={blocked || liveAccount === undefined || anyBusy}
                  onClick={() => onCheck(record)}
                >
                  {checkBusy === record.operationId ? 'Querying wallet…' : 'Check status in my wallet'}
                </button>

                {/* Submit button — appears only after wallet confirms APPROVED */}
                {showSubmit && (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={blocked || liveAccount === undefined || anyBusy}
                    onClick={() => onSubmit(record)}
                  >
                    {submitBusy === record.operationId ? 'Submitting…' : 'Submit approved transaction'}
                  </button>
                )}

                {blocked && <span className="hint">This request belongs to a different account or network.</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
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
