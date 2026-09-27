/**
 * Swap card.
 *
 * EXECUTION AUTHORITY (mission §22): this component computes nothing. Every
 * displayed expected output, minimum output, fee, and refusal comes from
 * `resolveSwap` in the protocol-client, and the intent handed to the wallet is
 * the resolver's own `builderIntent`. There is no constant-product math, no
 * reserve math, and no min_output derivation in this file.
 *
 * The multi-hop XTM → TARI → destination route is rendered as a structured
 * disabled state whenever the browser cannot execute the cross-layer leg. No
 * working button is ever shown for a capability the provider does not have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveSwap,
  type OotleReadbackProvider,
  type PoolState,
  type SwapRequest,
} from '@tari-ootle/protocol-client';
import { ammSwapIntentBuilder, toAmmPreview, type AmmTransactionIntent } from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import type { PoolDescriptor } from '../services/pools.js';
import { executeSwap, newOperationId, IdentityChangedError, ReviewMismatchError, type ExecutionWallets } from '../services/execution.js';
import { reviewFromAmmIntent } from '../lib/review.js';
import { normalizeError, type NormalizedError } from '../lib/errorMessage.js';
import { buildPoolIdentity, presentSafety, type AssetChip } from '../lib/assetIdentity.js';
import { formatBps, formatUnits, UNAVAILABLE } from '../lib/format.js';
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_PRESETS, validateSlippageInput } from '../lib/slippage.js';
import { asRawExecutionAmount } from '../lib/tradeBoundary.js';
import { atomicSwapAvailability } from '../lib/capabilities.js';
import { RoutePanel } from './RoutePanel.js';
import { Badge, DataRow, Field, Notice } from './primitives.js';

type QuoteState =
  | { kind: 'IDLE' }
  | { kind: 'PENDING' }
  | { kind: 'RESOLVED'; resolved: Awaited<ReturnType<typeof resolveSwap<AmmTransactionIntent>>> & { status: 'ACTIVE' } }
  | { kind: 'REFUSED'; status: string; reason: string };

const QUOTE_DEBOUNCE_MS = 350;

/**
 * Map a thrown value to a user-facing message without leaking internals.
 *
 * An identity change or a review mismatch is reported as such, because they are
 * security-relevant and the user should understand that nothing was submitted
 * for a reason other than a wallet rejection.
 */
function normalizeSubmissionFailure(error: unknown): { tone: 'warn' | 'danger' | 'info'; title: string; detail: string } {
  if (error instanceof IdentityChangedError) {
    return { tone: 'warn', title: 'Not submitted — wallet changed', detail: `${error.message} Nothing was signed.` };
  }
  if (error instanceof ReviewMismatchError) {
    return { tone: 'danger', title: 'Not submitted — review mismatch', detail: `${error.message}` };
  }
  const normalized: NormalizedError = normalizeError({ error });
  return { tone: 'danger', title: 'Swap not submitted', detail: normalized.message };
}

/**
 * Transaction validity bound. A generous but finite `with_max_epoch`: this
 * protocol has no infinite validity anywhere.
 */
const MAX_EPOCH = '1000000000';

export function SwapCard({ pool }: { pool: PoolDescriptor }) {
  const { wallet, balanceOf, executionWallets, readback, realSubmit, walletBridge, liveExecutionIdentity } = useApp();

  const identity = useMemo(
    () =>
      buildPoolIdentity({
        poolComponent: pool.poolComponent,
        base: { resourceAddress: pool.base.resourceAddress, symbol: pool.base.symbol, decimals: pool.base.decimals, safetyClass: pool.base.safetyClass },
        quote: { resourceAddress: pool.quote.resourceAddress, symbol: pool.quote.symbol, decimals: pool.quote.decimals, safetyClass: pool.quote.safetyClass },
      }),
    [pool],
  );

  const [inputResource, setInputResource] = useState(pool.base.resourceAddress);
  const [amountRaw, setAmountRaw] = useState('');
  const [slippageInput, setSlippageInput] = useState(DEFAULT_SLIPPAGE_BPS);
  const [quote, setQuote] = useState<QuoteState>({ kind: 'IDLE' });
  const [poolState, setPoolState] = useState<PoolState | undefined>(undefined);
  const [executionMessage, setExecutionMessage] = useState<{ tone: 'warn' | 'danger' | 'info'; title: string; detail: string } | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Double-submit guard. The disabled button is a courtesy; this is the
  // defence. A second invocation while a submission is in flight returns
  // immediately, so only one durable operation is ever created.
  const submitGuard = useRef(false);

  const from: AssetChip = inputResource === identity.base.resourceAddress ? identity.base : identity.quote;
  const to: AssetChip = from.resourceAddress === identity.base.resourceAddress ? identity.quote : identity.base;

  const slippage = useMemo(() => validateSlippageInput(slippageInput), [slippageInput]);
  const balanceRaw = balanceOf(from.resourceAddress);
  const balanceText = balanceRaw === undefined ? UNAVAILABLE : formatUnits(balanceRaw, from.decimals, { maxFractionDigits: 6 });

  const canReadAuthoritatively = wallet.status === 'CONNECTED' && readback() !== undefined;

  // ---- quote via the protocol resolver ------------------------------------
  useEffect(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    const provider: OotleReadbackProvider | undefined = readback();
    if (!canReadAuthoritatively || provider === undefined || amountRaw === '' || !slippage.ok) {
      setQuote({ kind: 'IDLE' });
      return;
    }
    setQuote({ kind: 'PENDING' });
    debounceRef.current = setTimeout(() => {
      void (async () => {
        const request: SwapRequest = {
          poolComponent: pool.poolComponent,
          inputResource: asRawExecutionAmount(from.resourceAddress, 'inputResource'),
          outputResource: asRawExecutionAmount(to.resourceAddress, 'outputResource'),
          rawInputAmount: asRawExecutionAmount(amountRaw, 'rawInputAmount'),
          slippage: { slippageBps: asRawExecutionAmount(slippage.bps, 'slippageBps') },
          maxEpoch: MAX_EPOCH,
          ...(pool.feeBps === undefined ? {} : { expectedFeeBps: asRawExecutionAmount(pool.feeBps, 'expectedFeeBps') }),
        };
        try {
          const outcome = await resolveSwap<AmmTransactionIntent>(request, {
            readback: provider,
            builder: ammSwapIntentBuilder(pool.poolComponent, () => newOperationId('intent')),
          });
          if (outcome.status === 'ACTIVE') {
            setPoolState(outcome.resolved.pool);
            setQuote({ kind: 'RESOLVED', resolved: outcome });
          } else {
            setQuote({ kind: 'REFUSED', status: outcome.status, reason: outcome.reason });
          }
        } catch (error) {
          setQuote({ kind: 'REFUSED', status: 'UNAVAILABLE', reason: (error as Error).message });
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    };
  }, [amountRaw, slippage.bps, inputResource, pool, canReadAuthoritatively, readback, from.resourceAddress, to.resourceAddress]);

  const resolved = quote.kind === 'RESOLVED' ? quote.resolved.resolved : undefined;
  const quoteData = resolved?.quote;

  const onSubmit = useCallback(async () => {
    if (resolved === undefined) return;
    const wallets = executionWallets();
    const bridge = walletBridge();
    if (wallets === undefined || bridge === undefined) {
      setExecutionMessage({ tone: 'danger', title: 'Swap not submitted', detail: 'The wallet disconnected before this swap could be submitted.' });
      return;
    }
    if (submitGuard.current) {
      // A second click while a submission is in flight must not create a second
      // durable operation. The button is disabled too; this is the actual guard.
      return;
    }
    submitGuard.current = true;
    setSubmitting(true);
    setExecutionMessage(undefined);
    try {
      const identity = liveExecutionIdentity();
      if (identity === undefined) {
        setExecutionMessage({ tone: 'danger', title: 'Swap not submitted', detail: 'No verified wallet identity is available for this review.' });
        return;
      }
      // Build the frozen review FROM the resolver's intent, so what the user
      // approves and what the wallet is asked to sign are the same object graph.
      const review = reviewFromAmmIntent({
        intent: resolved.builderIntent,
        operationId: newOperationId('swap'),
        network: wallet.networkId ?? 'unknown',
        identity,
        minOutputRaw: resolved.quote.minOutput,
        maxEpochRaw: MAX_EPOCH,
      });
      const result = await executeSwap<AmmTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: resolved.builderIntent,
        recordInput: {
          operationId: review.operationId,
          operationKind: 'AMM_SWAP',
          componentOrOrderId: pool.poolComponent,
          resources: [from.resourceAddress, to.resourceAddress],
          amounts: { [from.resourceAddress]: amountRaw, minOutput: resolved.quote.minOutput },
          quote: { quotedOutput: resolved.quote.quotedOutput, minOutput: resolved.quote.minOutput },
          epoch: resolved.freshness.identity.epoch,
          lastReadback: resolved.freshness,
        },
        toPreview: toAmmPreview,
        context: {
          assets: [from.resourceAddress, to.resourceAddress],
          operation: 'AMM swap',
          network: wallet.networkId ?? 'unknown',
          poolOrDestination: pool.poolComponent,
          privacyDisclosure: 'Pool reserves and amounts are revealed at the AMM boundary.',
        },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
      if (result.outcome === 'UNKNOWN') {
        setExecutionMessage({
          tone: 'warn',
          title: 'Submission outcome unknown',
          detail: `${result.transportError} The operation is recorded as UNKNOWN and is being reconciled by its durable identifier. It will not be automatically retried.`,
        });
      } else if (result.outcome === 'FAILED') {
        setExecutionMessage({ tone: 'danger', title: 'Swap failed', detail: result.reason });
      } else {
        setExecutionMessage({ tone: 'info', title: 'Swap submitted', detail: `Transaction ${result.transactionId} submitted. Track it on the Activity page.` });
      }
      setQuote({ kind: 'IDLE' });
      setAmountRaw('');
    } catch (error) {
      setExecutionMessage(normalizeSubmissionFailure(error));
    } finally {
      submitGuard.current = false;
      setSubmitting(false);
    }
  }, [resolved, executionWallets, wallet.networkId, pool.poolComponent, from.resourceAddress, to.resourceAddress, amountRaw]);

  const atomic = atomicSwapAvailability('XTM_TO_TARI', wallet.capabilities);
  const safety = presentSafety(identity.weakest);
  const canSubmit = canReadAuthoritatively && !submitting && quote.kind === 'RESOLVED' && slippage.ok && amountRaw !== '' && wallet.account !== undefined;

  return (
    <div className="card stack">
      <div className="spread">
        <h2 className="card__title">Swap</h2>
        <Badge tone={identity.requiresAcknowledgement ? 'warn' : 'neutral'} title={safety.explanation}>
          {safety.label}
        </Badge>
      </div>

      <Field label="From" trailing={<span className="hint">Balance {balanceText}</span>}>
        {(id, describedBy) => (
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <input
              id={id}
              className="input"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0"
              value={amountRaw}
              aria-describedby={describedBy}
              aria-invalid={amountRaw !== '' && !/^\d+$/.test(amountRaw)}
              onChange={(event) => setAmountRaw(event.target.value.replace(/[^\d]/g, ''))}
            />
            <span className="btn" style={{ minWidth: 92, cursor: 'default' }} title={from.fullAddress}>
              <span className="truncate">{from.symbol}</span>
            </span>
          </div>
        )}
      </Field>

      <div className="row" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn btn--sm" onClick={() => setInputResource(to.resourceAddress)} aria-label="Reverse swap direction">
          <span aria-hidden="true">⇅</span> Reverse
        </button>
      </div>

      <Field label="To">
        {(id, describedBy) => (
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <input
              id={id}
              className="input"
              readOnly
              value={quoteData === undefined ? '' : formatUnits(quoteData.quotedOutput, to.decimals, { maxFractionDigits: 6 })}
              aria-describedby={describedBy}
              aria-label="Estimated output"
            />
            <span className="btn" style={{ minWidth: 92, cursor: 'default' }} title={to.fullAddress}>
              <span className="truncate">{to.symbol}</span>
            </span>
          </div>
        )}
      </Field>

      <Field
        label="Slippage tolerance"
        hint="The protocol refuses any tolerance above 50%. Minimum received is derived by the protocol from this value, never here."
      >
        {(id, describedBy) => (
          <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            <input
              id={id}
              className="input"
              inputMode="numeric"
              style={{ maxWidth: 104 }}
              value={slippageInput}
              aria-describedby={describedBy}
              aria-invalid={!slippage.ok}
              onChange={(event) => setSlippageInput(event.target.value.replace(/[^\d]/g, ''))}
            />
            <span className="num hint">{slippage.ok ? slippage.percentDisplay : UNAVAILABLE}</span>
            {SLIPPAGE_PRESETS.map((preset) => (
              <button key={preset.bps} type="button" className="btn btn--sm" aria-pressed={slippage.bps === preset.bps} onClick={() => setSlippageInput(preset.bps)}>
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </Field>

      {quote.kind === 'PENDING' && <p className="hint" role="status">Rereading pool state and resolving the quote…</p>}

      {quote.kind === 'REFUSED' && (
        <Notice tone="warn" title={`Swap ${quote.status.toLowerCase()}`}>
          {quote.reason}
        </Notice>
      )}

      {quoteData !== undefined && resolved !== undefined && (
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          <DataRow label="Expected output" value={`${formatUnits(quoteData.quotedOutput, to.decimals, { maxFractionDigits: 6 })} ${to.symbol}`} />
          <DataRow
            label="Minimum received"
            value={`${formatUnits(quoteData.minOutput, to.decimals, { maxFractionDigits: 6 })} ${to.symbol}`}
            title="Derived by the protocol from your slippage tolerance and enforced on-chain."
            tone="warn"
          />
          <DataRow label="LP fee" value={formatBps(quoteData.feeBps)} title="Paid entirely to liquidity providers." />
          <DataRow label="Developer trading fee" value="0" title="This protocol has no developer fee." />
          <DataRow label="Read epoch" value={quoteData.readEpoch ?? UNAVAILABLE} title="Epoch of the authoritative read this quote was built from." />
          <DataRow label="Reserves (read)" value={`${formatUnits(resolved.pool.reserveA, identity.base.decimals, { abbreviate: true })} / ${formatUnits(resolved.pool.reserveB, identity.quote.decimals, { abbreviate: true })}`} />
        </div>
      )}

      {!canReadAuthoritatively && (
        <Notice tone="warn" title="Connect a wallet to quote">
          An authoritative pool reread is required before any quote. No estimate is shown without one.
        </Notice>
      )}

      {identity.requiresAcknowledgement && (
        <Notice tone="warn" title={`${safety.label} asset`}>
          {safety.explanation}
        </Notice>
      )}

      {executionMessage !== undefined && (
        <Notice tone={executionMessage.tone} title={executionMessage.title}>
          {executionMessage.detail}
        </Notice>
      )}

      <button type="button" className="btn btn--primary btn--block" disabled={!canSubmit} onClick={() => void onSubmit()}>
        {submitting ? 'Submitting…' : canReadAuthoritatively ? 'Swap' : 'Connect wallet to swap'}
      </button>

      <hr className="divider" />

      <RoutePanel
        headline="XTM → stablecoin, two hops"
        description="Hop 1: fast XTM / TARI cross-layer swap. Hop 2: AMM swap into the destination asset. The intermediate TARI is yours at every step."
        available={atomic.available}
        unavailableHeadline={atomic.headline}
        unavailableReason={atomic.reason}
        unavailableRemedy={atomic.remedy}
        realSubmit={realSubmit}
      />

      {poolState !== undefined && (
        <p className="hint">
          Pool <span className="mono">{pool.poolComponent}</span> · LP resource <span className="mono">{poolState.lpResource}</span>
        </p>
      )}
    </div>
  );
}

