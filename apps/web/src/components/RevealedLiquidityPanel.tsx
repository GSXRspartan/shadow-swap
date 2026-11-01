/**
 * Liquidity for REVEALED-VALUE pools (templates/revealed_asset_pool): create a pool, add to
 * one, and withdraw from one, for assets the public AMM refuses — created-Stealth resources
 * (native tTARI included) and Confidential resources carrying no blinded commitments — as well
 * as ordinary public fungibles.
 *
 * This is a SEPARATE venue from Pool v2, and the panel says so everywhere, because the
 * privacy properties differ: the reserves, every trade and every LP position here are public
 * integers. Trading a privacy-typed asset in such a pool reveals the amount, its timing and
 * the account. The asset's type is never converted.
 *
 * Every number comes from an authoritative read or from the user's own input; nothing is
 * priced from discovery. Execution reuses the existing review -> submit-once pipeline, so
 * duplicate-submit refusal, pending-approval resumption and reconciliation are unchanged.
 *
 * Engine evidence: audit_engine_tests/tests/revealed_asset_pool.rs (r01-r11). Available only
 * where a RevealedAssetPool template is RECORDED for the verified network generation; with
 * none recorded the panel explains that instead of offering an action.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readAccountInventory, revealedBalance, type AccountInventory, type PoolEdge } from '@tari-ootle/protocol-client';
import {
  buildCreateRevealedPoolIntent,
  buildRevealedAddLiquidityIntent,
  buildRevealedRemoveLiquidityIntent,
  revealedInitialLiquidityPreview,
  toAmmPreview,
  REVEALED_POOL_DISCLOSURE,
  type AmmTransactionIntent,
} from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { executeSwap, newOperationId, type ExecutionWallets } from '../services/execution.js';
import { stealthInputFor } from '../services/stealthWithdraw.js';
import { reviewFromAmmIntent } from '../lib/review.js';
import { parseDecimalToRaw } from '../lib/amountInput.js';
import { formatAddress, formatUnits } from '../lib/format.js';
import { normalizeError } from '../lib/errorMessage.js';
import { Badge, Card, CardHeader, DataRow, Notice } from './primitives.js';

const MAX_EPOCH = '18446744073709551615';
const FEE_BPS = 30;
/** Exit minimum: 0.50%, the same tolerance the swap path uses. */
const EXIT_SLIPPAGE_NUM = 9950n;
const EXIT_SLIPPAGE_DEN = 10000n;

type Msg = { tone: 'info' | 'warn' | 'danger'; title: string; detail: string };

export function RevealedLiquidityPanel() {
  const { config, wallet, market, readback, executionWallets, walletBridge, liveExecutionIdentity, refreshPools } = useApp();
  const deployment = activeDeployment(config.network);
  const template = deployment?.revealedPoolTemplates[0];
  const [mode, setMode] = useState<'create' | 'add' | 'remove'>('create');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | undefined>(undefined);
  const [inventory, setInventory] = useState<AccountInventory | undefined>(undefined);
  const guard = useRef(false);

  const revealedPools = useMemo(() => market.pools.filter((p) => p.kind === 'REVEALED'), [market.pools]);

  // Eligible to pool here: anything whose value is an exact revealed integer. An NFT
  // collection has no divisible amount and is never offered.
  const eligible = useMemo(() => wallet.balances.filter((b) => b.resourceType === 'fungible' || b.resourceType === 'stealth' || b.resourceType === 'confidential'), [wallet.balances]);
  const label = useCallback((r: string) => eligible.find((x) => x.resourceAddress === r)?.symbol ?? formatAddress(r), [eligible]);
  const decimals = useCallback((r: string) => eligible.find((x) => x.resourceAddress === r)?.divisibility ?? 0, [eligible]);
  const typeOf = useCallback((r: string) => eligible.find((x) => x.resourceAddress === r)?.resourceType, [eligible]);

  const account = wallet.account;
  useEffect(() => {
    const bridge = walletBridge();
    const raw = bridge?.substateReader('EXECUTION').readRaw;
    if (raw === undefined || account === undefined || wallet.status !== 'CONNECTED') {
      setInventory(undefined);
      return;
    }
    let cancelled = false;
    void readAccountInventory({ read: (id: string) => raw(id) }, account)
      .then((inv) => {
        if (!cancelled) setInventory(inv);
      })
      .catch(() => {
        if (!cancelled) setInventory(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [walletBridge, account, wallet.status, wallet.identityEpoch]);

  const run = useCallback(
    async (intent: AmmTransactionIntent, kind: 'AMM_ADD_LIQUIDITY' | 'AMM_REMOVE_LIQUIDITY', what: string, resources: string[], amounts: Record<string, string>) => {
      const wallets = executionWallets();
      const bridge = walletBridge();
      const identity = liveExecutionIdentity();
      if (wallets === undefined || bridge === undefined || identity === undefined) throw new Error('Connect a wallet first.');
      const stealthInput = stealthInputFor(intent.instructions, wallet);
      const review = reviewFromAmmIntent({ intent, operationId: newOperationId('revealed-lp'), network: wallet.networkId ?? 'unknown', identity, maxEpochRaw: MAX_EPOCH, ...(stealthInput !== undefined ? { stealthInput } : {}) });
      return executeSwap<AmmTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: intent,
        recordInput: {
          operationId: review.operationId,
          operationKind: kind,
          componentOrOrderId: intent.poolComponent,
          resources,
          amounts,
          lastReadback: { source: 'WALLET_PROVIDER', identity: { stateIdentity: `${intent.operation}@${intent.poolComponent}`, readAtUnixMs: Date.now() } },
        },
        toPreview: toAmmPreview,
        context: { assets: resources, operation: what, network: wallet.networkId ?? 'unknown', poolOrDestination: intent.poolComponent, privacyDisclosure: REVEALED_POOL_DISCLOSURE },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
    },
    [executionWallets, walletBridge, liveExecutionIdentity, wallet],
  );

  const guarded = useCallback(async (fn: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
    } catch (error) {
      setMsg({ tone: 'danger', title: 'Not submitted', detail: normalizeError({ error }).message });
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }, []);

  const report = (result: Awaited<ReturnType<typeof run>>, ok: string) => {
    if (result.outcome === 'SUBMITTED') {
      setMsg({ tone: 'info', title: ok, detail: `Transaction ${result.transactionId}. Balances update on the Activity page once it commits.` });
      void refreshPools();
    } else if (result.outcome === 'UNKNOWN') setMsg({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} It will not be retried automatically.` });
    else setMsg({ tone: 'danger', title: 'Failed', detail: result.reason });
  };

  if (template === undefined) {
    return (
      <Card>
        <CardHeader title="Transparent pools for private-typed assets" />
        <Notice tone="info" title="Not available on this network">
          {`No Shadow Swap RevealedAssetPool template is published and recorded for this ${config.network} deployment, so a transparent pool cannot be created or funded here. The pool is engine-verified (audit_engine_tests/tests/revealed_asset_pool.rs); publishing it is an operator decision.`}
        </Notice>
        <p className="muted">
          When it is available, this is where a created-Stealth or Confidential balance — the assets the public pool refuses — can be given AMM liquidity, with the reserves and every trade publicly visible.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Transparent pools for private-typed assets" />
      <Notice tone="warn" title="This pool is transparent, not confidential">
        {REVEALED_POOL_DISCLOSURE}
      </Notice>
      <div className="button-row" role="tablist" aria-label="Revealed pool actions">
        {(['create', 'add', 'remove'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`button${mode === m ? ' button-primary' : ''}`} onClick={() => setMode(m)}>
            {m === 'create' ? 'Create pool' : m === 'add' ? 'Add liquidity' : 'Withdraw'}
          </button>
        ))}
      </div>
      {mode === 'create' && (
        <CreateRevealed
          template={template}
          busy={busy}
          eligible={eligible}
          label={label}
          decimals={decimals}
          typeOf={typeOf}
          held={(r) => (inventory === undefined ? undefined : revealedBalance(inventory, r))}
          existing={revealedPools}
          onSubmit={(intent, resources, amounts) =>
            guarded(async () => {
              report(await run(intent, 'AMM_ADD_LIQUIDITY', 'Create and fund a transparent pool', resources, amounts), 'Pool creation submitted');
            })
          }
        />
      )}
      {mode !== 'create' && (
        <ExistingRevealed
          mode={mode}
          busy={busy}
          pools={revealedPools}
          readback={readback}
          account={account}
          label={label}
          decimals={decimals}
          held={(r) => (inventory === undefined ? undefined : revealedBalance(inventory, r))}
          onSubmit={(intent, kind, resources, amounts, ok) =>
            guarded(async () => {
              report(await run(intent, kind, ok, resources, amounts), `${ok} submitted`);
            })
          }
        />
      )}
      {msg !== undefined && <Notice tone={msg.tone} title={msg.title}>{msg.detail}</Notice>}
    </Card>
  );
}

function CreateRevealed(props: {
  template: string;
  busy: boolean;
  eligible: ReadonlyArray<{ resourceAddress: string; resourceType: string; symbol?: string }>;
  label: (r: string) => string;
  decimals: (r: string) => number;
  typeOf: (r: string) => string | undefined;
  held: (r: string) => string | undefined;
  existing: ReadonlyArray<{ poolComponent: string; base: { resourceAddress: string }; quote: { resourceAddress: string } }>;
  onSubmit: (intent: AmmTransactionIntent, resources: string[], amounts: Record<string, string>) => void;
}) {
  const { wallet } = useApp();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const raw = useMemo(() => {
    try {
      if (a === '' || b === '' || amountA.trim() === '' || amountB.trim() === '') return undefined;
      return { a: parseDecimalToRaw(amountA.trim(), props.decimals(a), 'deposit A').raw, b: parseDecimalToRaw(amountB.trim(), props.decimals(b), 'deposit B').raw };
    } catch {
      return undefined;
    }
  }, [a, b, amountA, amountB, props]);
  const preview = useMemo(() => {
    if (raw === undefined) return undefined;
    try {
      return { ok: true as const, ...revealedInitialLiquidityPreview(raw.a, raw.b) };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  }, [raw]);
  const already = props.existing.find((p) => (p.base.resourceAddress === a && p.quote.resourceAddress === b) || (p.base.resourceAddress === b && p.quote.resourceAddress === a));
  const privateSide = [a, b].some((r) => r !== '' && props.typeOf(r) !== 'fungible');
  const insufficient = raw !== undefined && [
    [a, raw.a],
    [b, raw.b],
  ].some(([resource, want]) => {
    const have = props.held(resource as string);
    return have !== undefined && BigInt(have) < BigInt(want as string);
  });

  return (
    <div>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Asset A</span>
          <select className="input" value={a} onChange={(e) => setA(e.target.value)} aria-label="Revealed pool asset A">
            <option value="">Select</option>
            {props.eligible.map((x) => <option key={x.resourceAddress} value={x.resourceAddress}>{`${props.label(x.resourceAddress)} (${x.resourceType})`}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Asset B</span>
          <select className="input" value={b} onChange={(e) => setB(e.target.value)} aria-label="Revealed pool asset B">
            <option value="">Select</option>
            {props.eligible.filter((x) => x.resourceAddress !== a).map((x) => <option key={x.resourceAddress} value={x.resourceAddress}>{`${props.label(x.resourceAddress)} (${x.resourceType})`}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Deposit A</span><input className="input" inputMode="decimal" value={amountA} onChange={(e) => setAmountA(e.target.value)} aria-label="Revealed initial deposit A" /></label>
        <label className="field"><span className="field-label">Deposit B</span><input className="input" inputMode="decimal" value={amountB} onChange={(e) => setAmountB(e.target.value)} aria-label="Revealed initial deposit B" /></label>
      </div>
      {privateSide && (
        <Notice tone="warn" title="You are revealing this amount">
          A private-typed asset deposited here sits in a publicly visible reserve. Only the amount you deposit is revealed, and only for as long as it is in the pool; the asset keeps its type.
        </Notice>
      )}
      {already !== undefined && <Notice tone="warn" title="A transparent pool already exists for this pair">{`Add liquidity to ${formatAddress(already.poolComponent)} instead: a second pool splits liquidity.`}</Notice>}
      {insufficient && <Notice tone="warn" title="Insufficient revealed balance">One of these deposits is larger than the revealed balance this account holds, read from its own vaults.</Notice>}
      {preview?.ok === false && <Notice tone="warn" title="Deposit too small">{preview.reason}</Notice>}
      {error !== undefined && <Notice tone="danger" title="Not submitted">{error}</Notice>}
      {preview?.ok === true && raw !== undefined && (
        <>
          <DataRow label="Initial price" value={`1 ${props.label(a)} = ${formatUnits(String((BigInt(raw.b) * 10n ** BigInt(props.decimals(a))) / BigInt(raw.a)), props.decimals(b))} ${props.label(b)}`} />
          <DataRow label="LP minted to you" value={preview.creatorShares} />
          <DataRow label="Locked forever" value={`${preview.lockedShares} LP (at most 1% of your position; never redeemable by anyone)`} />
          <DataRow label="Fee" value={`${FEE_BPS} bps per swap, retained by LPs. No owner, no admin, no protocol fee.`} />
          <button
            type="button"
            className="button button-primary"
            disabled={props.busy || wallet.status !== 'CONNECTED' || already !== undefined || insufficient}
            onClick={() => {
              setError(undefined);
              try {
                const intent = buildCreateRevealedPoolIntent({
                  poolTemplateAddress: props.template,
                  accountAddress: wallet.account ?? '',
                  resourceA: a,
                  resourceB: b,
                  rawAmountA: raw.a,
                  rawAmountB: raw.b,
                  feeBps: FEE_BPS,
                  maxEpoch: MAX_EPOCH,
                  operationId: newOperationId('revealed-create'),
                });
                props.onSubmit(intent, [a, b], { [a]: raw.a, [b]: raw.b });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {props.busy ? 'Waiting for wallet…' : 'Review and create transparent pool'}
          </button>
        </>
      )}
    </div>
  );
}

function ExistingRevealed(props: {
  mode: 'add' | 'remove';
  busy: boolean;
  pools: ReadonlyArray<{ poolComponent: string; base: { resourceAddress: string; symbol?: string }; quote: { resourceAddress: string; symbol?: string }; lpResource?: string }>;
  readback: () => { readPool: (c: string) => Promise<{ status: string; value?: PoolEdge & { lpResource?: string; totalLpSupply?: string }; reason?: string }> } | undefined;
  account: string | undefined;
  label: (r: string) => string;
  decimals: (r: string) => number;
  held: (r: string) => string | undefined;
  onSubmit: (intent: AmmTransactionIntent, kind: 'AMM_ADD_LIQUIDITY' | 'AMM_REMOVE_LIQUIDITY', resources: string[], amounts: Record<string, string>, ok: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [lpAmount, setLpAmount] = useState('');
  const [state, setState] = useState<{ edge: PoolEdge; lpResource?: string; totalLpSupply?: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // The pool is RE-READ authoritatively whenever it is selected: a discovery snapshot never
  // prices a deposit or a withdrawal.
  useEffect(() => {
    const provider = props.readback();
    if (provider === undefined || selected === '') {
      setState(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const read = await provider.readPool(selected);
        if (cancelled) return;
        if (read.status === 'FOUND' && read.value !== undefined) {
          setState({ edge: read.value, ...(read.value.lpResource === undefined ? {} : { lpResource: read.value.lpResource }), ...(read.value.totalLpSupply === undefined ? {} : { totalLpSupply: read.value.totalLpSupply }) });
          setError(undefined);
        } else {
          setState(undefined);
          setError(read.reason ?? 'The pool could not be read authoritatively.');
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, props]);

  if (props.pools.length === 0) {
    return <p className="muted">No transparent pool has been discovered on this network yet. Create one first.</p>;
  }

  const edge = state?.edge;
  return (
    <div>
      <label className="field">
        <span className="field-label">Pool</span>
        <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Transparent pool">
          <option value="">Select a pool</option>
          {props.pools.map((p) => (
            <option key={p.poolComponent} value={p.poolComponent}>{`${props.label(p.base.resourceAddress)} / ${props.label(p.quote.resourceAddress)} — ${formatAddress(p.poolComponent)}`}</option>
          ))}
        </select>
      </label>
      {error !== undefined && <Notice tone="warn" title="Pool not read">{error}</Notice>}
      {edge !== undefined && (
        <>
          <DataRow label="Reserves" value={`${formatUnits(edge.reserveA, props.decimals(edge.resourceA))} ${props.label(edge.resourceA)} / ${formatUnits(edge.reserveB, props.decimals(edge.resourceB))} ${props.label(edge.resourceB)}`} />
          <DataRow label="Fee" value={`${edge.feeBps} bps, retained by LPs`} />
          {props.mode === 'add' ? (
            <>
              <div className="form-grid">
                <label className="field"><span className="field-label">{`Add ${props.label(edge.resourceA)}`}</span><input className="input" inputMode="decimal" value={amountA} onChange={(e) => setAmountA(e.target.value)} aria-label="Revealed add amount A" /></label>
                <label className="field"><span className="field-label">{`Add ${props.label(edge.resourceB)}`}</span><input className="input" inputMode="decimal" value={amountB} onChange={(e) => setAmountB(e.target.value)} aria-label="Revealed add amount B" /></label>
              </div>
              <p className="muted">Only the balanced amounts are taken; the remainder of both sides is refunded in the same transaction.</p>
              <button
                type="button"
                className="button button-primary"
                disabled={props.busy || amountA.trim() === '' || amountB.trim() === ''}
                onClick={() => {
                  setError(undefined);
                  try {
                    const rawA = parseDecimalToRaw(amountA.trim(), props.decimals(edge.resourceA), 'amount A').raw;
                    const rawB = parseDecimalToRaw(amountB.trim(), props.decimals(edge.resourceB), 'amount B').raw;
                    // The on-chain LP minimum is derived from the authoritative reserves just
                    // read, with the same 0.50% tolerance the swap path uses.
                    const total = state?.totalLpSupply;
                    let minLp = '0';
                    if (total !== undefined && BigInt(total) > 0n) {
                      const byA = (BigInt(rawA) * BigInt(total)) / BigInt(edge.reserveA);
                      const byB = (BigInt(rawB) * BigInt(total)) / BigInt(edge.reserveB);
                      const expected = byA < byB ? byA : byB;
                      minLp = String((expected * EXIT_SLIPPAGE_NUM) / EXIT_SLIPPAGE_DEN);
                    }
                    const intent = buildRevealedAddLiquidityIntent({
                      poolComponent: selected,
                      accountAddress: props.account ?? '',
                      resourceA: edge.resourceA,
                      resourceB: edge.resourceB,
                      rawAmountA: rawA,
                      rawAmountB: rawB,
                      minLpOut: minLp,
                      maxEpoch: MAX_EPOCH,
                      operationId: newOperationId('revealed-add'),
                    });
                    props.onSubmit(intent, 'AMM_ADD_LIQUIDITY', [edge.resourceA, edge.resourceB], { [edge.resourceA]: rawA, [edge.resourceB]: rawB }, 'Add liquidity');
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {props.busy ? 'Waiting for wallet…' : 'Review and add liquidity'}
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span className="field-label">LP to burn</span>
                <input className="input" inputMode="decimal" value={lpAmount} onChange={(e) => setLpAmount(e.target.value)} aria-label="Revealed LP amount" />
                {state?.lpResource !== undefined && <span className="hint">{`You hold ${props.held(state.lpResource) ?? '—'} raw LP units.`}</span>}
              </label>
              <p className="muted">Both sides are withdrawn in proportion to your share, with on-chain minimums so the exit cannot be sandwiched.</p>
              <button
                type="button"
                className="button button-primary"
                disabled={props.busy || lpAmount.trim() === '' || state?.lpResource === undefined}
                onClick={() => {
                  setError(undefined);
                  try {
                    const lpResource = state?.lpResource;
                    const total = state?.totalLpSupply;
                    if (lpResource === undefined) throw new Error('The pool did not report its LP resource, so a withdrawal cannot be priced.');
                    if (total === undefined || BigInt(total) === 0n) throw new Error('The pool reported no LP supply, so a withdrawal cannot be priced.');
                    const rawLp = parseDecimalToRaw(lpAmount.trim(), 0, 'LP amount').raw;
                    const share = (reserve: string) => String(((BigInt(rawLp) * BigInt(reserve)) / BigInt(total) * EXIT_SLIPPAGE_NUM) / EXIT_SLIPPAGE_DEN);
                    // The template returns the pair in CANONICAL order, which is what the
                    // authoritative read reports as A and B.
                    const intent = buildRevealedRemoveLiquidityIntent({
                      poolComponent: selected,
                      accountAddress: props.account ?? '',
                      lpResource,
                      rawLpAmount: rawLp,
                      minA: share(edge.reserveA),
                      minB: share(edge.reserveB),
                      maxEpoch: MAX_EPOCH,
                      operationId: newOperationId('revealed-remove'),
                    });
                    props.onSubmit(intent, 'AMM_REMOVE_LIQUIDITY', [edge.resourceA, edge.resourceB], { [lpResource]: rawLp }, 'Withdraw liquidity');
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {props.busy ? 'Waiting for wallet…' : 'Review and withdraw'}
              </button>
            </>
          )}
          <p className="hint">
            <Badge tone="warn">transparent</Badge> This pool&apos;s reserves and your LP position are public on chain.
          </p>
        </>
      )}
    </div>
  );
}
