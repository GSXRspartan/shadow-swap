/**
 * Create and fund a new ownerless pool from the wallet, in ONE transaction.
 *
 * `Pool::new(a, b, 30)` is called on the Pool template RECORDED for the verified network
 * generation, the new component is put on the workspace, `add_liquidity` is called on it by
 * workspace reference, and the LP is deposited (engine-proven: audit_engine_tests m06). The
 * pool either exists AND is funded, or nothing happened. Pool v2 is not republished.
 *
 * Only ordinary public fungibles and native tTARI can be pooled (the template's own guard);
 * Stealth/confidential/NFT balances are not offered here.
 */
import { useMemo, useRef, useState } from 'react';
import { buildCreatePoolIntent, initialLiquidityPreview, toAmmPreview, type AmmTransactionIntent } from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { executeSwap, newOperationId, type ExecutionWallets } from '../services/execution.js';
import { reviewFromAmmIntent } from '../lib/review.js';
import { stealthInputFor } from '../services/stealthWithdraw.js';
import { parseDecimalToRaw } from '../lib/amountInput.js';
import { formatAddress, formatUnits } from '../lib/format.js';
import { normalizeError } from '../lib/errorMessage.js';
import { CANONICAL_TARI } from '../lib/routeResolver.js';
import { Card, CardHeader, DataRow, Notice } from './primitives.js';

const MAX_EPOCH = '18446744073709551615';
const PUBLIC_POOL_FEE_BPS = 30;

export function CreatePoolPanel() {
  const { config, wallet, market, executionWallets, walletBridge, liveExecutionIdentity, refreshPools } = useApp();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; detail: string } | undefined>(undefined);
  const guard = useRef(false);

  const eligible = useMemo(() => wallet.balances.filter((x) => x.resourceType === 'fungible' || x.resourceAddress === CANONICAL_TARI), [wallet.balances]);
  const label = (r: string) => eligible.find((x) => x.resourceAddress === r)?.symbol ?? formatAddress(r);
  const decimals = (r: string) => eligible.find((x) => x.resourceAddress === r)?.divisibility ?? 0;
  const template = activeDeployment(config.network)?.poolTemplates[0];
  const existing = market.pools.find((p) => (p.base.resourceAddress === a && p.quote.resourceAddress === b) || (p.base.resourceAddress === b && p.quote.resourceAddress === a));

  const raw = useMemo(() => {
    try {
      if (a === '' || b === '' || amountA.trim() === '' || amountB.trim() === '') return undefined;
      return { a: parseDecimalToRaw(amountA.trim(), decimals(a)).raw, b: parseDecimalToRaw(amountB.trim(), decimals(b)).raw };
    } catch {
      return undefined;
    }
  }, [a, b, amountA, amountB, eligible]);
  const preview = useMemo(() => {
    if (raw === undefined) return undefined;
    try {
      return { ok: true as const, ...initialLiquidityPreview(raw.a, raw.b) };
    } catch (error) {
      return { ok: false as const, reason: (error as Error).message };
    }
  }, [raw]);

  const blocked = template === undefined
    ? 'No Shadow Swap Pool template is recorded for this network generation, so a pool cannot be created here yet.'
    : wallet.status !== 'CONNECTED'
      ? 'Connect a wallet to create a pool.'
      : undefined;

  const submit = async () => {
    if (guard.current || raw === undefined || preview?.ok !== true || template === undefined) return;
    const wallets = executionWallets();
    const bridge = walletBridge();
    const identity = liveExecutionIdentity();
    const account = wallet.account;
    if (wallets === undefined || bridge === undefined || identity === undefined || account === undefined) return;
    guard.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const intent = buildCreatePoolIntent({ poolTemplateAddress: template, accountAddress: account, resourceA: a, resourceB: b, rawAmountA: raw.a, rawAmountB: raw.b, feeBps: PUBLIC_POOL_FEE_BPS, maxEpoch: MAX_EPOCH, operationId: newOperationId('create-pool') });
      const stealthInput = stealthInputFor(intent.instructions, wallet);
      const review = reviewFromAmmIntent({ intent, operationId: newOperationId('create-pool'), network: wallet.networkId ?? 'unknown', identity, maxEpochRaw: MAX_EPOCH, ...(stealthInput !== undefined ? { stealthInput } : {}) });
      const result = await executeSwap<AmmTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: intent,
        recordInput: {
          operationId: review.operationId,
          operationKind: 'AMM_ADD_LIQUIDITY',
          componentOrOrderId: `template_${template}`,
          resources: [a, b],
          amounts: { [a]: raw.a, [b]: raw.b },
          // A pool that does not exist yet has no prior read; the record says so explicitly.
          lastReadback: { source: 'WALLET_PROVIDER', identity: { stateIdentity: `new-pool@template_${template}`, readAtUnixMs: Date.now() } },
        },
        toPreview: toAmmPreview,
        context: { assets: [a, b], operation: 'Create and fund a new pool', network: wallet.networkId ?? 'unknown', poolOrDestination: `template_${template}`, privacyDisclosure: 'The pool, its reserves and your deposit are public.' },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
      if (result.outcome === 'SUBMITTED') {
        setMessage({ tone: 'info', title: 'Pool creation submitted', detail: `Transaction ${result.transactionId}. Discovery will pick the new pool up once it commits.` });
        void refreshPools();
      } else if (result.outcome === 'UNKNOWN') setMessage({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} It will not be retried automatically.` });
      else setMessage({ tone: 'danger', title: 'Pool creation failed', detail: result.reason });
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Not submitted', detail: normalizeError({ error }).message });
    } finally {
      guard.current = false;
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Create a pool" />
      {blocked !== undefined && <Notice tone="info" title="Pool creation unavailable">{blocked}</Notice>}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Asset A</span>
          <select className="input" value={a} onChange={(e) => setA(e.target.value)} aria-label="Pool asset A">
            <option value="">Select</option>
            {eligible.map((x) => <option key={x.resourceAddress} value={x.resourceAddress}>{label(x.resourceAddress)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Asset B</span>
          <select className="input" value={b} onChange={(e) => setB(e.target.value)} aria-label="Pool asset B">
            <option value="">Select</option>
            {eligible.filter((x) => x.resourceAddress !== a).map((x) => <option key={x.resourceAddress} value={x.resourceAddress}>{label(x.resourceAddress)}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Deposit A</span><input className="input" inputMode="decimal" value={amountA} onChange={(e) => setAmountA(e.target.value)} aria-label="Initial deposit A" /></label>
        <label className="field"><span className="field-label">Deposit B</span><input className="input" inputMode="decimal" value={amountB} onChange={(e) => setAmountB(e.target.value)} aria-label="Initial deposit B" /></label>
      </div>
      {existing !== undefined && <Notice tone="warn" title="A verified pool already exists for this pair">{`Add liquidity to ${formatAddress(existing.poolComponent)} instead: a second pool splits liquidity.`}</Notice>}
      {preview?.ok === false && <Notice tone="warn" title="Deposit too small">{preview.reason}</Notice>}
      {preview?.ok === true && raw !== undefined && (
        <>
          <DataRow label="Initial price" value={`1 ${label(a)} = ${formatUnits(String((BigInt(raw.b) * 10n ** BigInt(decimals(a))) / BigInt(raw.a)), decimals(b))} ${label(b)}`} />
          <DataRow label="LP minted to you" value={preview.creatorShares} />
          <DataRow label="Locked forever" value={`${preview.lockedShares} LP (the template's first-depositor defence; never redeemable by anyone)`} />
          <DataRow label="Fee" value={`${PUBLIC_POOL_FEE_BPS} bps per swap, retained by LPs. No owner, no admin, no protocol fee.`} />
          <p className="muted">One transaction creates the pool and deposits both sides; you pay the network fee shown by your wallet.</p>
          <button type="button" className="button button-primary" disabled={busy || blocked !== undefined || existing !== undefined} onClick={() => void submit()}>
            {busy ? 'Waiting for wallet…' : 'Review and create pool'}
          </button>
        </>
      )}
      {message !== undefined && <Notice tone={message.tone} title={message.title}>{message.detail}</Notice>}
    </Card>
  );
}
