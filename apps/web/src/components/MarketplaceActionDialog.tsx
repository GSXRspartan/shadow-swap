/**
 * MARKETPLACE ACTION DIALOG — one review-and-confirm surface for every
 * create / cancel / refund action.
 *
 * Nine marketplace operations, one dialog. Each action goes through the same four
 * steps with no per-action shortcuts:
 *
 *   1. The user states the terms (amount, quantity, or nothing for a cancel).
 *   2. A human-readable review names the item, the component, the payment resource,
 *      and every raw amount — because "review" for a non-developer means knowing
 *      what moves, not reading instruction JSON.
 *   3. The wallet is asked to approve, through the same frozen-review path as every
 *      other operation in the app. Nothing here re-derives a payload after approval.
 *   4. The result is reported by what it actually is: submitted, awaiting the user's
 *      approval, unknown, or refused. `UNKNOWN` is never rendered as success.
 *
 * The action itself is built and reviewed in `services/marketplaceActions.ts`, so
 * this file contains presentation and nothing else. A component that constructed its
 * own intent would be the place a template address or an amount silently drifted
 * away from what was signed.
 */

import { useRef, useState } from 'react';
import { toMarketplacePreview, type MarketplaceTransactionIntent } from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { executeSwap, newOperationId, IdentityChangedError, ReviewMismatchError, PendingApprovalError } from '../services/execution.js';
import {
  buildMarketplaceIntent,
  recordKindFor,
  reviewForIntent,
  summarizeAction,
  type MarketplaceAction,
} from '../services/marketplaceActions.js';
import { normalizeError } from '../lib/errorMessage.js';
import { formatAddress } from '../lib/format.js';
import { parseDecimalToRaw, compareRaw } from '../lib/amountInput.js';
import { Dialog, Notice } from './primitives.js';

type Phase = 'TERMS' | 'REVIEW' | 'BUSY' | 'DONE';

/**
 * Decimal-aware parse, reduced to a raw integer string or a human sentence.
 *
 * `parseDecimalToRaw` throws a typed error; the dialog wants text, not an exception.
 * The returned string is ALWAYS a base-unit integer — no decimal point ever reaches
 * a signed amount from this path.
 */
function parseAmount(input: string, decimals: string, field: string): string | string {
  try {
    return parseDecimalToRaw(input, Number(decimals), field).raw;
  } catch (error) {
    return (error as Error).message;
  }
}

export interface MarketplaceActionRequest {
  /** The action to run. Constructed by the caller from facts it already read. */
  readonly action: MarketplaceAction;
  /** Divisibility of the payment resource, for decimal-aware amount entry. */
  readonly quoteDecimals: string;
  /** Divisibility of the collection's NFT id space, when an id is entered as text. */
  readonly nftDecimals?: string;
}

/**
 * Run one marketplace action to a reviewed, submitted (or honestly unresolved) end.
 *
 * `onDone` is called only after the flow has settled one way or another, so a
 * caller can safely reread chain state when it fires — and is NOT called while the
 * wallet is merely waiting, because nothing has happened yet.
 */
export function MarketplaceActionDialog({ request, onClose, onDone }: { request: MarketplaceActionRequest; onClose: () => void; onDone: () => void }) {
  const { config, wallet, walletBridge, executionWallets, liveExecutionIdentity } = useApp();
  const { action, quoteDecimals } = request;
  const summary = summarizeAction(action);
  const [phase, setPhase] = useState<Phase>('TERMS');
  const [status, setStatus] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; detail: string } | undefined>(undefined);
  const [transactionId, setTransactionId] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<MarketplaceTransactionIntent | undefined>(undefined);
  /**
   * Synchronous submission guard.
   *
   * `phase` is React state and stays at its previous value for every click that
   * lands before the re-render, so a fast double click would start two submissions
   * and create two durable operations. A ref updates in the same tick, so the
   * second click is refused.
   */
  const guard = useRef(false);

  const wallets = executionWallets();
  const account = wallet.account;

  const needsAmount = action.kind === 'CREATE_LISTING' || action.kind === 'MAKE_ITEM_OFFER' || action.kind === 'PLACE_COLLECTION_BID';

  /** The concrete action with the user's terms folded in, or a refusal. */
  const resolveAction = (): MarketplaceAction | { error: string } => {
    const expiryEpoch = expiry.trim() === '' ? 0 : Number(expiry.trim());
    if (expiry.trim() !== '' && (!Number.isSafeInteger(expiryEpoch) || expiryEpoch < 0)) {
      return { error: 'The expiry must be a whole number of epochs, or blank for no expiry.' };
    }
    if (action.kind === 'CREATE_LISTING') {
      const raw = parseAmount(amount, quoteDecimals, 'price');
      if (typeof raw !== 'string') return { error: raw };
      if (compareRaw(raw, '0') <= 0) return { error: 'A listing price must be greater than zero.' };
      return { ...action, priceRaw: raw, expiryEpoch };
    }
    if (action.kind === 'MAKE_ITEM_OFFER') {
      const raw = parseAmount(amount, quoteDecimals, 'offer');
      if (typeof raw !== 'string') return { error: raw };
      if (compareRaw(raw, '0') <= 0) return { error: 'An offer must be greater than zero.' };
      return { ...action, offerAmountRaw: raw, expiryEpoch };
    }
    if (action.kind === 'PLACE_COLLECTION_BID') {
      const raw = parseAmount(amount, quoteDecimals, 'bid');
      if (typeof raw !== 'string') return { error: raw };
      if (compareRaw(raw, '0') <= 0) return { error: 'A bid price must be greater than zero.' };
      if (!/^\d+$/.test(quantity.trim()) || quantity.trim() === '0') return { error: 'The quantity must be a whole number of items, at least one.' };
      return { ...action, pricePerNftRaw: raw, quantityRaw: quantity.trim(), expiryEpoch };
    }
    // A cancel or refund carries no terms of its own, so it is returned unchanged.
    return action;
  };

  const advance = () => {
    setStatus(undefined);
    const concrete = resolveAction();
    if ('error' in concrete) {
      setAmountError(concrete.error);
      return;
    }
    setAmountError(undefined);
    try {
      // Templates come from the generation this session VERIFIED, never from a constant.
      setIntent(buildMarketplaceIntent(concrete, activeDeployment(config.network)?.marketplaceTemplates));
    } catch (error) {
      setStatus({ tone: 'danger', title: 'Not available on this network', detail: (error as Error).message });
      return;
    }
    setPhase('REVIEW');
  };

  const confirm = async () => {
    if (guard.current || intent === undefined || wallets === undefined) return;
    const bridge = walletBridge();
    const identity = liveExecutionIdentity();
    if (bridge === undefined || identity === undefined || account === undefined) {
      setStatus({ tone: 'danger', title: 'Not submitted', detail: 'No verified wallet identity is available for this operation.' });
      return;
    }
    guard.current = true;
    setPhase('BUSY');
    setStatus(undefined);
    try {
      const operationId = newOperationId('mkt');
      const review = reviewForIntent({
        action: action.kind,
        operationId,
        network: wallet.networkId ?? 'unknown',
        account,
        identity,
        intent,
      });
      const result = await executeSwap<MarketplaceTransactionIntent>(wallets as never, {
        resolvedIntent: intent,
        recordInput: {
          operationId,
          operationKind: recordKindFor(action.kind),
          componentOrOrderId: intent.target.componentOrOrderId,
          resources: [intent.target.nftResource, intent.target.quoteResource],
          amounts: intent.target.amount === undefined ? {} : { escrow: intent.target.amount },
          lastReadback: {
            source: 'WALLET_PROVIDER',
            // A create has no component to reread, so the freshest available anchor
            // is the connected account identity at construction time. It is not
            // settlement evidence and is not treated as any.
            identity: { stateIdentity: account, readAtUnixMs: Date.now() },
          },
        },
        toPreview: toMarketplacePreview,
        context: {
          assets: [intent.target.nftResource, intent.target.quoteResource],
          operation: intent.operation,
          network: wallet.networkId ?? 'unknown',
          poolOrDestination: intent.target.componentOrOrderId ?? intent.calls[0]?.templateAddress ?? 'MARKETPLACE',
          privacyDisclosure: 'Listing, offer, and bid terms are public on-chain.',
        },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });

      if (result.outcome === 'SUBMITTED') {
        setTransactionId(result.transactionId);
        setStatus({ tone: 'info', title: 'Submitted', detail: `Transaction ${formatAddress(result.transactionId, 10, 8)}. Confirming on-chain.` });
        setPhase('DONE');
        onDone();
      } else if (result.outcome === 'UNKNOWN') {
        setStatus({ tone: 'warn', title: 'Not settled yet', detail: `${result.transportError} Nothing further is submitted automatically — check Activity.` });
        setPhase('DONE');
      } else {
        setStatus({ tone: 'danger', title: 'Not submitted', detail: result.reason });
        setPhase('REVIEW');
      }
    } catch (error) {
      if (error instanceof PendingApprovalError) {
        setStatus({ tone: 'warn', title: 'Already awaiting your approval', detail: error.message });
        setPhase('REVIEW');
      } else if (error instanceof IdentityChangedError) {
        setStatus({ tone: 'warn', title: 'Not submitted — wallet changed', detail: `${error.message} Nothing was signed.` });
        setPhase('REVIEW');
      } else if (error instanceof ReviewMismatchError) {
        setStatus({ tone: 'danger', title: 'Not submitted — review mismatch', detail: error.message });
        setPhase('REVIEW');
      } else {
        setStatus({ tone: 'danger', title: 'Not submitted', detail: normalizeError({ error }).message });
        setPhase('REVIEW');
      }
    } finally {
      guard.current = false;
    }
  };

  return (
    <Dialog open onClose={phase === 'BUSY' ? () => undefined : onClose} title={summary.title}>
      <div className="stack" style={{ gap: 'var(--s-3)' }}>
        {needsAmount && phase === 'TERMS' && (
          <div className="stack" style={{ gap: 'var(--s-2)' }}>
            <label className="label" htmlFor="mkt-amount">
              {action.kind === 'PLACE_COLLECTION_BID' ? 'Price per item' : action.kind === 'CREATE_LISTING' ? 'Asking price' : 'Your offer'}
            </label>
            <input
              id="mkt-amount"
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              autoComplete="off"
            />
            {action.kind === 'PLACE_COLLECTION_BID' && (
              <>
                <label className="label" htmlFor="mkt-quantity">
                  Quantity
                </label>
                <input id="mkt-quantity" className="input" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
              </>
            )}
            <label className="label" htmlFor="mkt-expiry">
              Expires at epoch (blank for no expiry)
            </label>
            <input id="mkt-expiry" className="input" inputMode="numeric" value={expiry} onChange={(event) => setExpiry(event.target.value)} placeholder="optional" />
          </div>
        )}

        {phase === 'REVIEW' || phase === 'DONE' ? (
          <div className="stack" style={{ gap: 'var(--s-2)' }}>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Transaction review</caption>
                <tbody>
                  {summary.lines.map((line) => (
                    <tr key={line.label}>
                      <th scope="row" className="label">
                        {line.label}
                      </th>
                      <td className="mono" style={{ wordBreak: 'break-all' }}>
                        {line.value}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="label">
                      Network
                    </th>
                    <td>{wallet.networkId ?? 'unknown'}</td>
                  </tr>
                  <tr>
                    <th scope="row" className="label">
                      Account
                    </th>
                    <td className="mono" style={{ wordBreak: 'break-all' }}>
                      {account ?? '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="hint">
              Marketplace terms are public on-chain. Your wallet will ask you to approve this exact transaction before anything is submitted.
            </p>
          </div>
        ) : null}

        {amountError !== undefined && (
          <Notice tone="danger" title="Check the amount">
            {amountError}
          </Notice>
        )}
        {status !== undefined && (
          <Notice tone={status.tone} title={status.title}>
            {status.detail}
          </Notice>
        )}

        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          {phase === 'TERMS' && (
            <button type="button" className="btn btn--primary" onClick={advance}>
              Review
            </button>
          )}
          {(phase === 'REVIEW' || phase === 'BUSY') && status?.tone !== 'info' && (
            <button type="button" className="btn btn--primary" disabled={phase === 'BUSY'} onClick={() => void confirm()}>
              {phase === 'BUSY' ? 'Waiting for your wallet…' : 'Approve in wallet'}
            </button>
          )}
          <button type="button" className="btn btn--ghost" disabled={phase === 'BUSY'} onClick={onClose}>
            {phase === 'DONE' ? 'Close' : 'Cancel'}
          </button>
        </div>
        {transactionId !== undefined && (
          <p className="hint mono" style={{ wordBreak: 'break-all' }}>
            {transactionId}
          </p>
        )}
      </div>
    </Dialog>
  );
}