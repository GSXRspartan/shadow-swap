/**
 * Swap: pick any two assets; see every settlement mechanism, which ones can execute, and the
 * executable quotes compared by output.
 *
 * - Reserves come ONLY from the wallet's authoritative reads (pinned to recorded Pool
 *   templates), never from discovery.
 * - The chosen route is re-resolved immediately before review (`resolveMultiHopSwap`
 *   re-reads every hop), so a stale quote is refused rather than signed.
 * - Execution reuses the existing review -> submit-once pipeline (`executeSwap`), so
 *   duplicate-submit refusal, pending-approval persistence and reconciliation are unchanged.
 * - Mechanisms that cannot be signed in this build are shown with their exact reason and no
 *   action.
 * - P2P offers (create / import an invitation / my offers) sit below the AMM routes: the way to
 *   trade a pair with no AMM route, a private-typed asset, or one NFT for another. They are
 *   available only where a SwapOffer template is recorded for the verified generation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveMultiHopSwap, type PoolEdge, type RouteQuote } from '@tari-ootle/protocol-client';
import { ammRouteIntentBuilder, toAmmPreview, type AmmTransactionIntent } from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { executeSwap, newOperationId, type ExecutionWallets } from '../services/execution.js';
import { reviewFromAmmIntent } from '../lib/review.js';
import { stealthInputFor } from '../services/stealthWithdraw.js';
import { parseDecimalToRaw } from '../lib/amountInput.js';
import { formatAddress, formatUnits, UNAVAILABLE } from '../lib/format.js';
import { DEFAULT_SLIPPAGE_BPS } from '../lib/slippage.js';
import { normalizeError } from '../lib/errorMessage.js';
import { CANONICAL_TARI, bestAmmQuote, resolvePairRoutes, type AssetKind, type RouteOption } from '../lib/routeResolver.js';
import { Badge, Card, CardHeader, DataRow, EmptyState, Notice } from '../components/primitives.js';
import { P2POfferPanel } from '../components/P2POfferPanel.js';

const MAX_EPOCH = '18446744073709551615';

interface AssetChoice {
  resource: string;
  label: string;
  kind: AssetKind;
  decimals: number;
}

export function SwapRoutesPage() {
  const { config, wallet, market, readback, executionWallets, walletBridge, liveExecutionIdentity } = useApp();
  const [edges, setEdges] = useState<PoolEdge[]>([]);
  const [readError, setReadError] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [chosen, setChosen] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; detail: string } | undefined>(undefined);
  const guard = useRef(false);

  // Authoritative reserves for every verified pool (pinned readback; display purpose is fine
  // here because execution re-reads every hop before review).
  useEffect(() => {
    const provider = readback();
    if (provider === undefined || market.pools.length === 0) {
      setEdges([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: PoolEdge[] = [];
      const failures: string[] = [];
      for (const pool of market.pools) {
        const read = await provider.readPool(pool.poolComponent);
        if (read.status === 'FOUND') {
          const v = read.value;
          out.push({ poolComponent: pool.poolComponent, resourceA: v.resourceA, resourceB: v.resourceB, reserveA: v.reserveA, reserveB: v.reserveB, feeBps: v.feeBps });
        } else failures.push(`${formatAddress(pool.poolComponent)}: ${read.reason}`);
      }
      if (!cancelled) {
        setEdges(out);
        setReadError(failures.length > 0 ? failures.join(' · ') : undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [market.pools, readback]);

  const assets = useMemo<AssetChoice[]>(() => {
    const byResource = new Map<string, AssetChoice>();
    for (const pool of market.pools) {
      for (const side of [pool.base, pool.quote]) {
        byResource.set(side.resourceAddress, {
          resource: side.resourceAddress,
          label: side.symbol ?? formatAddress(side.resourceAddress),
          // Pool v2 admits only ordinary fungibles and native tTARI (by exact address).
          kind: side.resourceAddress === CANONICAL_TARI ? 'stealth' : 'fungible',
          decimals: Number(side.decimals) || 0,
        });
      }
    }
    for (const b of wallet.balances) {
      if (byResource.has(b.resourceAddress)) continue;
      byResource.set(b.resourceAddress, { resource: b.resourceAddress, label: b.symbol ?? formatAddress(b.resourceAddress), kind: b.resourceType, decimals: b.divisibility ?? 0 });
    }
    return [...byResource.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [market.pools, wallet.balances]);

  const fromAsset = assets.find((a) => a.resource === from);
  const toAsset = assets.find((a) => a.resource === to);
  const amountRaw = useMemo(() => {
    if (fromAsset === undefined || amount.trim() === '') return undefined;
    try {
      return parseDecimalToRaw(amount.trim(), fromAsset.decimals, 'amount').raw;
    } catch {
      return undefined;
    }
  }, [amount, fromAsset]);

  const deployment = activeDeployment(config.network);
  const options: RouteOption[] = useMemo(() => {
    if (fromAsset === undefined || toAsset === undefined) return [];
    return resolvePairRoutes({
      input: { resource: fromAsset.resource, kind: fromAsset.kind },
      output: { resource: toAsset.resource, kind: toAsset.kind },
      ...(amountRaw === undefined ? {} : { amountIn: amountRaw }),
      pools: edges,
      poolTemplateRecorded: (deployment?.poolTemplates.length ?? 0) > 0,
      offerTemplateRecorded: (deployment?.offerTemplates.length ?? 0) > 0,
    });
  }, [fromAsset, toAsset, amountRaw, edges, deployment]);

  const quotes: RouteQuote[] = useMemo(() => options.filter((o) => o.availability === 'EXECUTABLE').flatMap((o) => o.quotes ?? []).sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : a.hops.length - b.hops.length)), [options]);
  const best = bestAmmQuote(options);
  useEffect(() => setChosen(0), [from, to, amountRaw]);
  const selected = quotes[chosen];

  const symbolOf = (resource: string) => assets.find((a) => a.resource === resource)?.label ?? formatAddress(resource);
  const decimalsOf = (resource: string) => assets.find((a) => a.resource === resource)?.decimals ?? 0;

  const submit = useCallback(async () => {
    if (selected === undefined || guard.current) return;
    const provider = readback();
    const wallets = executionWallets();
    const bridge = walletBridge();
    const identity = liveExecutionIdentity();
    const account = wallet.account;
    if (provider === undefined || wallets === undefined || bridge === undefined || identity === undefined || account === undefined) {
      setMessage({ tone: 'danger', title: 'Not submitted', detail: 'Connect a wallet first.' });
      return;
    }
    guard.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      // Re-read EVERY hop and re-derive the quote; refuse if it moved against the user.
      const outcome = await resolveMultiHopSwap<AmmTransactionIntent>(
        {
          inputResource: selected.inputResource,
          outputResource: selected.outputResource,
          rawInputAmount: selected.amountIn,
          pools: selected.hops.map((h) => h.poolComponent),
          slippage: { slippageBps: DEFAULT_SLIPPAGE_BPS },
          maxEpoch: MAX_EPOCH,
          expectedOutput: selected.amountOut,
        },
        { readback: provider, builder: ammRouteIntentBuilder(account, () => newOperationId('route')) },
      );
      if (outcome.status !== 'ACTIVE') {
        setMessage({ tone: 'warn', title: `Route ${outcome.status.toLowerCase()}`, detail: outcome.reason });
        return;
      }
      // A Stealth-typed input (tTARI) from a Sapient seed account goes through the wallet's
      // native withdrawStealthAndExecute; walletd-relayed accounts keep the plain path.
      const stealthInput = stealthInputFor(outcome.builderIntent.instructions, wallet);
      const review = reviewFromAmmIntent({ intent: outcome.builderIntent, operationId: newOperationId('swap'), network: wallet.networkId ?? 'unknown', identity, minOutputRaw: outcome.minOutput, maxEpochRaw: MAX_EPOCH, ...(stealthInput !== undefined ? { stealthInput } : {}) });
      const result = await executeSwap<AmmTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: outcome.builderIntent,
        recordInput: {
          operationId: review.operationId,
          operationKind: 'AMM_SWAP',
          componentOrOrderId: selected.hops[0]!.poolComponent,
          resources: [selected.inputResource, selected.outputResource],
          amounts: { [selected.inputResource]: selected.amountIn, minOutput: outcome.minOutput },
          quote: { quotedOutput: outcome.quote.amountOut, minOutput: outcome.minOutput },
          lastReadback: outcome.freshness[0]!,
        },
        toPreview: toAmmPreview,
        context: {
          assets: [selected.inputResource, selected.outputResource],
          operation: selected.hops.length === 1 ? 'AMM swap' : `Multi-hop AMM swap (${selected.hops.length} pools, one transaction)`,
          network: wallet.networkId ?? 'unknown',
          poolOrDestination: selected.hops.map((h) => h.poolComponent).join(' -> '),
          privacyDisclosure: 'Pool reserves and amounts are revealed at every AMM hop.',
        },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
      if (result.outcome === 'UNKNOWN') setMessage({ tone: 'warn', title: 'Submission outcome unknown', detail: `${result.transportError} Recorded as UNKNOWN and reconciled by its durable id; it will not be retried automatically.` });
      else if (result.outcome === 'FAILED') setMessage({ tone: 'danger', title: 'Swap failed', detail: result.reason });
      else setMessage({ tone: 'info', title: 'Swap submitted', detail: `Transaction ${result.transactionId} submitted. Confirmation and balances update on the Activity page.` });
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Not submitted', detail: normalizeError({ error }).message });
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }, [selected, readback, executionWallets, walletBridge, liveExecutionIdentity, wallet]);

  return (
    <div className="page-stack">
      <Card>
        <CardHeader title="Swap" />
        {wallet.status !== 'CONNECTED' && <Notice tone="info" title="Connect a wallet">Quotes use your wallet's authoritative pool reads, so a wallet is needed to price a route.</Notice>}
        {readError !== undefined && <Notice tone="warn" title="Some pools could not be read">{readError}</Notice>}
        <div className="form-grid">
          <label className="field">
            <span className="field-label">From</span>
            <select className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Input asset">
              <option value="">Select asset</option>
              {assets.map((a) => (
                <option key={a.resource} value={a.resource}>{a.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Output asset">
              <option value="">Select asset</option>
              {assets.filter((a) => a.resource !== from).map((a) => (
                <option key={a.resource} value={a.resource}>{a.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Amount</span>
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Input amount" placeholder="0.0" />
          </label>
        </div>
      </Card>

      {fromAsset !== undefined && toAsset !== undefined && (
        <Card>
          <CardHeader title="Settlement routes" />
          {options.length === 0 && <EmptyState title="No route" detail="No settlement mechanism applies to this pair." />}
          <ul className="route-list" aria-label="Route mechanisms">
            {options.map((o) => (
              <li key={o.mechanism} className="route-option">
                <Badge tone={o.availability === 'EXECUTABLE' ? 'ok' : o.availability === 'NO_LIQUIDITY' ? 'neutral' : 'warn'}>{o.label}</Badge>{' '}
                <span>{o.availability === 'EXECUTABLE' ? `${o.quotes?.length ?? 0} executable quote(s)` : o.availability.replace(/_/g, ' ').toLowerCase()}</span>
                {o.reason !== undefined && <p className="muted">{o.reason}</p>}
                <p className="muted">Privacy: {o.privacy}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {quotes.length > 0 && (
        <Card>
          <CardHeader title="Executable quotes" />
          <ol className="quote-list" aria-label="Executable quotes">
            {quotes.map((q, i) => (
              <li key={q.hops.map((h) => h.poolComponent).join('>')}>
                <label>
                  <input type="radio" name="route" checked={chosen === i} onChange={() => setChosen(i)} />{' '}
                  <strong>{q.hops.length === 1 ? 'AMM' : `Multi-hop AMM · ${q.hops.length} hops`}</strong>{q === best ? ' · best output' : ''}
                </label>
                <div className="muted">{[q.inputResource, ...q.hops.map((h) => h.outputResource)].map(symbolOf).join(' → ')}</div>
                <DataRow label="You receive (quoted)" value={formatUnits(q.amountOut, decimalsOf(q.outputResource))} />
                <DataRow label="Pool fees" value={`${q.hops.map((h) => `${h.feeBps} bps`).join(' + ')} (kept by each pool's LPs)`} />
                <DataRow label="Total route cost vs mid price" value={`${(Number(q.totalCostBps) / 100).toFixed(2)}% (fees + price impact)`} tone={Number(q.totalCostBps) > 300 ? 'warn' : undefined} />
              </li>
            ))}
          </ol>
          {selected !== undefined && (
            <>
              <DataRow label="Minimum received (0.50% slippage, enforced on-chain by the final hop)" value={formatUnits(String((BigInt(selected.amountOut) * 9950n) / 10000n), decimalsOf(selected.outputResource))} />
              <p className="muted">The route is re-read from your wallet immediately before review. Every hop settles in one transaction or none does.</p>
              <button type="button" className="button button-primary" disabled={busy || wallet.status !== 'CONNECTED'} onClick={() => void submit()}>
                {busy ? 'Waiting for wallet…' : 'Review and swap'}
              </button>
            </>
          )}
        </Card>
      )}
      {quotes.length === 0 && fromAsset !== undefined && toAsset !== undefined && amountRaw !== undefined && (
        <Notice tone="info" title="No executable quote">{options.map((o) => o.reason).filter(Boolean).join(' ') || UNAVAILABLE}</Notice>
      )}
      {message !== undefined && <Notice tone={message.tone} title={message.title}>{message.detail}</Notice>}

      <P2POfferPanel {...(from !== '' ? { offeredResource: from } : {})} {...(to !== '' ? { requestedResource: to } : {})} />
    </div>
  );
}
