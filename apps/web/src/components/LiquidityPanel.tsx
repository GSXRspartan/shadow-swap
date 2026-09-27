/**
 * Add / remove liquidity and LP position.
 *
 * Both flows go through the protocol-client's authoritative resolvers
 * (`resolveAddLiquidity` / `resolveRemoveLiquidity`). The LP mint hint and the
 * redemption amounts shown here are the resolvers' outputs, not frontend math.
 *
 * Two honest refusals are surfaced rather than worked around:
 *   - the first deposit into an empty pool is the on-chain bootstrap path and
 *     this resolver deliberately refuses to construct it
 *   - APR/APY and impermanent loss are NOT shown, because nothing in the
 *     protocol derives them defensibly yet
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveAddLiquidity, resolveRemoveLiquidity } from '@tari-ootle/protocol-client';
import { ammLiquidityIntentBuilder, toAmmPreview, type AmmTransactionIntent } from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import type { PoolDescriptor } from '../services/pools.js';
import { executeSwap, newOperationId, IdentityChangedError, ReviewMismatchError, type ExecutionWallets } from '../services/execution.js';
import { reviewFromAmmIntent } from '../lib/review.js';
import { normalizeError } from '../lib/errorMessage.js';
import { formatUnits, UNAVAILABLE } from '../lib/format.js';
import { asRawExecutionAmount } from '../lib/tradeBoundary.js';
import { Badge, Card, CardHeader, DataRow, Field, Notice } from './primitives.js';

const MAX_EPOCH = '1000000000';

type Mode = 'add' | 'remove';

export function LiquidityPanel({ pool }: { pool: PoolDescriptor }) {
  const { wallet, balanceOf, readback, executionWallets, walletBridge, liveExecutionIdentity } = useApp();
  const [mode, setMode] = useState<Mode>('add');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [lpAmount, setLpAmount] = useState('');
  const [percentage, setPercentage] = useState<number | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: 'warn' | 'danger' | 'info'; title: string; detail: string } | undefined>(undefined);
  const [preview, setPreview] = useState<
    | { kind: 'add'; lpHint: string; feeBps: string }
    | { kind: 'remove'; expectedA: string; expectedB: string }
    | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  /**
   * Synchronous submission guard. `busy` is React state, so it is still `false`
   * for every click that lands before the re-render: two rapid clicks both read
   * `busy === false` and both start a submission, creating two durable
   * operations. A ref is updated in the same tick, so the second click is
   * refused. State still drives the disabled attribute for the visual.
   */
  const submitGuard = useRef(false);

  const canRead = wallet.status === 'CONNECTED' && readback() !== undefined;
  const balanceA = balanceOf(pool.base.resourceAddress);
  const balanceB = balanceOf(pool.quote.resourceAddress);

  useEffect(() => {
    setPreview(undefined);
    setMessage(undefined);
  }, [mode, amountA, amountB, lpAmount]);

  const resolveAdd = useCallback(async () => {
    const provider = readback();
    if (provider === undefined || !/^\d+$/.test(amountA) || !/^\d+$/.test(amountB) || amountA === '0' || amountB === '0') return;
    const outcome = await resolveAddLiquidity<AmmTransactionIntent>(
      {
        poolComponent: pool.poolComponent,
        rawAmountA: asRawExecutionAmount(amountA, 'rawAmountA'),
        rawAmountB: asRawExecutionAmount(amountB, 'rawAmountB'),
        maxEpoch: MAX_EPOCH,
      },
      { readback: provider, builder: ammLiquidityIntentBuilder(pool.poolComponent, () => newOperationId('lp-add')) },
    );
    if (outcome.status === 'ACTIVE') {
      setPreview({ kind: 'add', lpHint: outcome.resolved.expectedLpMintHint, feeBps: outcome.resolved.pool.feeBps });
      setMessage(undefined);
    } else {
      setPreview(undefined);
      setMessage({ tone: outcome.status === 'UNAVAILABLE' ? 'warn' : 'danger', title: `Add liquidity ${outcome.status.toLowerCase()}`, detail: outcome.reason });
    }
  }, [readback, pool.poolComponent, amountA, amountB]);

  const resolveRemove = useCallback(async () => {
    const provider = readback();
    if (provider === undefined || !/^\d+$/.test(lpAmount) || lpAmount === '0') return;
    const outcome = await resolveRemoveLiquidity<AmmTransactionIntent>(
      {
        poolComponent: pool.poolComponent,
        rawLpAmount: asRawExecutionAmount(lpAmount, 'rawLpAmount'),
        maxEpoch: MAX_EPOCH,
      },
      { readback: provider, builder: ammLiquidityIntentBuilder(pool.poolComponent, () => newOperationId('lp-remove')) },
    );
    if (outcome.status === 'ACTIVE') {
      setPreview({ kind: 'remove', expectedA: outcome.resolved.expectedA, expectedB: outcome.resolved.expectedB });
      setMessage(undefined);
    } else {
      setPreview(undefined);
      setMessage({ tone: outcome.status === 'UNAVAILABLE' ? 'warn' : 'danger', title: `Remove liquidity ${outcome.status.toLowerCase()}`, detail: outcome.reason });
    }
  }, [readback, pool.poolComponent, lpAmount]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void (mode === 'add' ? resolveAdd() : resolveRemove());
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, resolveAdd, resolveRemove]);

  const submit = useCallback(async () => {
    // Claimed before any await, and released in a finally block below.
    if (submitGuard.current) return;
    submitGuard.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const wallets = executionWallets();
      const bridge = walletBridge();
      if (wallets === undefined || bridge === undefined) return;
      const identity = liveExecutionIdentity();
      if (identity === undefined) {
        setMessage({ tone: 'danger', title: 'Not submitted', detail: 'No verified wallet identity is available for this operation.' });
        return;
      }
      const provider = readback();
      if (provider === undefined) throw new Error('The wallet disconnected.');
      const resolved =
        mode === 'add'
          ? await resolveAddLiquidity<AmmTransactionIntent>(
              { poolComponent: pool.poolComponent, rawAmountA: asRawExecutionAmount(amountA, 'rawAmountA'), rawAmountB: asRawExecutionAmount(amountB, 'rawAmountB'), maxEpoch: MAX_EPOCH },
              { readback: provider, builder: ammLiquidityIntentBuilder(pool.poolComponent, () => newOperationId('lp-add')) },
            )
          : await resolveRemoveLiquidity<AmmTransactionIntent>(
              { poolComponent: pool.poolComponent, rawLpAmount: asRawExecutionAmount(lpAmount, 'rawLpAmount'), maxEpoch: MAX_EPOCH },
              { readback: provider, builder: ammLiquidityIntentBuilder(pool.poolComponent, () => newOperationId('lp-remove')) },
            );
      if (resolved.status !== 'ACTIVE') {
        setMessage({ tone: 'warn', title: `Not submitted (${resolved.status.toLowerCase()})`, detail: resolved.reason });
        return;
      }
      // The review is built from the resolver's intent, so the amounts the user
      // sees are the amounts the wallet is asked to sign.
      const review = reviewFromAmmIntent({
        intent: resolved.resolved.builderIntent,
        operationId: newOperationId(mode === 'add' ? 'lp-add' : 'lp-remove'),
        network: wallet.networkId ?? 'unknown',
        identity,
        maxEpochRaw: MAX_EPOCH,
      });
      const result = await executeSwap<AmmTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: resolved.resolved.builderIntent,
        recordInput: {
          operationId: review.operationId,
          operationKind: mode === 'add' ? 'AMM_ADD_LIQUIDITY' : 'AMM_REMOVE_LIQUIDITY',
          componentOrOrderId: pool.poolComponent,
          resources:
            mode === 'add'
              ? [pool.base.resourceAddress, pool.quote.resourceAddress]
              : [resolved.resolved.pool.lpResource],
          amounts: mode === 'add' ? { a: amountA, b: amountB } : { lp: lpAmount },
          lastReadback: resolved.resolved.freshness,
        },
        toPreview: toAmmPreview,
        context: {
          assets: mode === 'add' ? [pool.base.resourceAddress, pool.quote.resourceAddress] : [pool.poolComponent],
          operation: mode === 'add' ? 'Add liquidity' : 'Remove liquidity',
          network: wallet.networkId ?? 'unknown',
          poolOrDestination: pool.poolComponent,
          privacyDisclosure: 'Pool reserves and amounts are revealed at the AMM boundary.',
        },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
      if (result.outcome === 'SUBMITTED') {
        setMessage({ tone: 'info', title: 'Submitted', detail: `Transaction ${result.transactionId}. Track it on the Activity page.` });
        setAmountA('');
        setAmountB('');
        setLpAmount('');
        setPreview(undefined);
      } else if (result.outcome === 'UNKNOWN') {
        setMessage({ tone: 'warn', title: 'Submission outcome unknown', detail: `${result.transportError} Recorded as UNKNOWN and being reconciled; it will not be auto-retried.` });
      } else {
        setMessage({ tone: 'danger', title: 'Failed', detail: result.reason });
      }
    } catch (error) {
      if (error instanceof IdentityChangedError) {
        setMessage({ tone: 'warn', title: 'Not submitted — wallet changed', detail: `${error.message} Nothing was signed.` });
      } else if (error instanceof ReviewMismatchError) {
        setMessage({ tone: 'danger', title: 'Not submitted — review mismatch', detail: error.message });
      } else {
        setMessage({ tone: 'danger', title: 'Not submitted', detail: normalizeError({ error }).message });
      }
    } finally {
      submitGuard.current = false;
      setBusy(false);
    }
  }, [executionWallets, walletBridge, liveExecutionIdentity, preview, mode, readback, pool, amountA, amountB, lpAmount, wallet.networkId]);

  return (
    <Card className="stack">
      <CardHeader
        title="Liquidity"
        actions={
          <div className="row" role="group" aria-label="Liquidity action" style={{ gap: 2 }}>
            <button type="button" className="btn btn--sm" aria-pressed={mode === 'add'} onClick={() => setMode('add')} style={mode === 'add' ? { background: 'var(--accent-wash)', borderColor: 'var(--accent-line)', color: 'var(--accent)' } : { background: 'transparent', borderColor: 'transparent', color: 'var(--text-3)' }}>
              Add
            </button>
            <button type="button" className="btn btn--sm" aria-pressed={mode === 'remove'} onClick={() => setMode('remove')} style={mode === 'remove' ? { background: 'var(--accent-wash)', borderColor: 'var(--accent-line)', color: 'var(--accent)' } : { background: 'transparent', borderColor: 'transparent', color: 'var(--text-3)' }}>
              Remove
            </button>
          </div>
        }
      />

      {mode === 'add' ? (
        <>
          <Field label={`${pool.base.symbol} amount`} trailing={<span className="hint">Balance {formatUnits(balanceA, pool.base.decimals, { maxFractionDigits: 4 })}</span>}>
            {(id) => (
              <input id={id} className="input" inputMode="numeric" pattern="[0-9]*" value={amountA} onChange={(event) => setAmountA(event.target.value.replace(/[^\d]/g, ''))} />
            )}
          </Field>
          <Field label={`${pool.quote.symbol} amount`} trailing={<span className="hint">Balance {formatUnits(balanceB, pool.quote.decimals, { maxFractionDigits: 4 })}</span>}>
            {(id) => (
              <input id={id} className="input" inputMode="numeric" pattern="[0-9]*" value={amountB} onChange={(event) => setAmountB(event.target.value.replace(/[^\d]/g, ''))} />
            )}
          </Field>
          <p className="hint">
            The pool is unweighted, so both sides must be deposited in the current reserve ratio. The pool enforces this; the exact LP mint is only an
            advisory hint until it settles.
          </p>
          {preview?.kind === 'add' && (
            <div className="stack" style={{ gap: 'var(--s-2)' }}>
              <DataRow label="Expected LP tokens" value={formatUnits(preview.lpHint, '0', { maxFractionDigits: 4 })} title="Advisory proportional hint. The pool is authoritative." />
              <DataRow label="LP fee tier" value={`${preview.feeBps} bps`} />
            </div>
          )}
        </>
      ) : (
        <>
          <Field label="LP amount" trailing={<span className="hint">Balance {UNAVAILABLE}</span>}>
            {(id) => (
              <input id={id} className="input" inputMode="numeric" pattern="[0-9]*" value={lpAmount} onChange={(event) => setLpAmount(event.target.value.replace(/[^\d]/g, ''))} />
            )}
          </Field>
          <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            {[25, 50, 100].map((percent) => (
              <button
                key={percent}
                type="button"
                className="btn btn--sm"
                aria-pressed={percentage === percent}
                onClick={() => {
                  setPercentage(percent);
                  setMessage({ tone: 'warn', title: 'LP balance unavailable', detail: 'This build cannot read your LP balance without a provider that exposes LP holdings. Enter an amount explicitly.' });
                }}
              >
                {percent}%
              </button>
            ))}
          </div>
          {preview?.kind === 'remove' && (
            <div className="stack" style={{ gap: 'var(--s-2)' }}>
              <DataRow label={`Expected ${pool.base.symbol}`} value={formatUnits(preview.expectedA, pool.base.decimals, { maxFractionDigits: 6 })} title="Proportional redemption from the read-time reserves." />
              <DataRow label={`Expected ${pool.quote.symbol}`} value={formatUnits(preview.expectedB, pool.quote.decimals, { maxFractionDigits: 6 })} />
            </div>
          )}
        </>
      )}

      {!canRead && (
        <Notice tone="warn" title="Connect a wallet">
          Adding or removing liquidity requires an authoritative pool reread. No estimate is shown without one.
        </Notice>
      )}

      {message !== undefined && (
        <Notice tone={message.tone} title={message.title}>
          {message.detail}
        </Notice>
      )}

      <button type="button" className="btn btn--primary btn--block" disabled={!canRead || busy || preview === undefined} onClick={() => void submit()}>
        {busy ? 'Submitting…' : mode === 'add' ? 'Add liquidity' : 'Remove liquidity'}
      </button>

      <hr className="divider" />
      <div className="stack" style={{ gap: 'var(--s-2)' }}>
        <span className="label">Position</span>
        <p className="hint">
          <Badge>No APR shown</Badge> <Badge>No APY shown</Badge> <Badge>No impermanent-loss figure shown</Badge>
        </p>
        <p className="hint">
          Fee earnings are not projected here. Nothing in the protocol derives a defensible yield figure, so none is displayed. Your actual position is
          whatever the pool pays out at the time you redeem.
        </p>
      </div>
    </Card>
  );
}


