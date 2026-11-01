/**
 * Peer-to-peer escrow offers (templates/p2p_offer) on the Swap page.
 *
 *   Create   escrow an asset and name exactly what you want back; share the invitation.
 *   Import   paste an invitation; the OFFER IS RE-READ FROM CHAIN and only chain terms are
 *            shown, reviewed and signed. A forged or stale invitation is refused with the
 *            exact differences; no centralized matching is involved at any point.
 *   Mine     offers created from this browser: status from chain; claim proceeds or cancel.
 *
 * Available only when a SwapOffer template is RECORDED for the verified network generation
 * (services/protocolDeployment.ts). None is recorded today, so in production this panel
 * explains why nothing can be created or filled.
 *
 * Execution reuses the same review -> submit-once pipeline as every other trade.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeSwapOffer,
  encodeInvitation,
  ownedNfts,
  readAccountInventory,
  revealedBalance,
  ownsNft,
  type AccountInventory,
  invitationFromChain,
  marketplaceCurrentEpoch,
  parseInvitation,
  verifyInvitation,
  INVITATION_MAX_CHARS,
  type InvitationVerdict,
  type SwapOfferInvitation,
  type SwapOfferState,
} from '@tari-ootle/protocol-client';
import {
  buildCancelSwapOfferIntent,
  buildClaimSwapOfferIntent,
  buildCreateSwapOfferIntent,
  buildFillSwapOfferIntent,
  type OfferAsset,
  type SwapOfferTransactionIntent,
} from '@tari-ootle/wallet-adapter';
import { useApp } from '../state/AppContext.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { executeSwap, newOperationId, type ExecutionWallets } from '../services/execution.js';
import { stealthInputFor } from '../services/stealthWithdraw.js';
import { reviewFromSwapOfferIntent } from '../lib/review.js';
import { parseDecimalToRaw } from '../lib/amountInput.js';
import { formatAddress, formatUnits } from '../lib/format.js';
import { normalizeError } from '../lib/errorMessage.js';
import { Badge, Card, CardHeader, DataRow, Notice } from './primitives.js';

const MAX_EPOCH = '18446744073709551615';
const MINE_KEY = 'shadowswap.p2p.myOffers.v1';
const HEX64 = /^[0-9a-f]{64}$/;

type Msg = { tone: 'info' | 'warn' | 'danger'; title: string; detail: string };
interface MyOffer {
  network: string;
  generation: string;
  transactionId: string;
  component?: string;
}

function loadMine(): MyOffer[] {
  try {
    const raw = window.localStorage.getItem(MINE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((x) => typeof x === 'object' && x !== null && typeof (x as MyOffer).transactionId === 'string') as MyOffer[]) : [];
  } catch {
    return [];
  }
}

function saveMine(list: MyOffer[]): void {
  try {
    window.localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(-50)));
  } catch {
    /* a convenience list only; chain state is the record */
  }
}

async function sha256Hex(hex: string): Promise<string> {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function currentEpoch(): string | undefined {
  const e = marketplaceCurrentEpoch();
  return e === '0' ? undefined : e;
}

export function P2POfferPanel(props: { offeredResource?: string; requestedResource?: string }) {
  const { config, wallet, executionWallets, walletBridge, liveExecutionIdentity } = useApp();
  const deployment = activeDeployment(config.network);
  const template = deployment?.offerTemplates[0];
  const generation = deployment?.generation === 'V048_RESET' ? 'v048' : 'pre-v048';
  const network = wallet.networkId ?? config.network;
  const [tab, setTab] = useState<'create' | 'import' | 'mine'>('create');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | undefined>(undefined);
  const [inventory, setInventory] = useState<AccountInventory | undefined>(undefined);
  const guard = useRef(false);

  const decimalsOf = useCallback((r: string) => wallet.balances.find((b) => b.resourceAddress === r)?.divisibility ?? 0, [wallet.balances]);
  const labelOf = useCallback((r: string) => wallet.balances.find((b) => b.resourceAddress === r)?.symbol ?? formatAddress(r), [wallet.balances]);
  const describe = useCallback((a: OfferAsset) => (a.kind === 'fungible' ? `${formatUnits(a.amount, decimalsOf(a.resource))} ${labelOf(a.resource)}` : `NFT ${a.nftId} (${labelOf(a.resource)})`), [decimalsOf, labelOf]);

  const reader = useCallback(() => {
    const bridge = walletBridge();
    const raw = bridge?.substateReader('EXECUTION').readRaw;
    return raw === undefined ? undefined : { read: (id: string) => raw(id) };
  }, [walletBridge]);

  // What this account actually holds, from its own vaults. The wallet's balance list carries
  // no NFT ids, so the item picker and the ownership/balance checks read chain state instead.
  const account = wallet.account;
  useEffect(() => {
    const r = reader();
    if (r === undefined || account === undefined || wallet.status !== 'CONNECTED') {
      setInventory(undefined);
      return;
    }
    let cancelled = false;
    void readAccountInventory(r, account)
      .then((inv) => {
        if (!cancelled) setInventory(inv);
      })
      .catch(() => {
        if (!cancelled) setInventory(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [reader, account, wallet.status, wallet.identityEpoch]);

  /** Review -> submit-once, shared by every P2P action. */
  const run = useCallback(
    async (intent: SwapOfferTransactionIntent, kind: 'P2P_OFFER_CREATE' | 'P2P_OFFER_FILL' | 'P2P_OFFER_CLAIM' | 'P2P_OFFER_CANCEL', chainReceive: OfferAsset | undefined, label: string) => {
      const wallets = executionWallets();
      const bridge = walletBridge();
      const identity = liveExecutionIdentity();
      if (wallets === undefined || bridge === undefined || identity === undefined) throw new Error('Connect a wallet first.');
      const stealthInput = stealthInputFor(intent.instructions, wallet);
      const review = reviewFromSwapOfferIntent({ intent, operationId: newOperationId('p2p'), network, identity, maxEpochRaw: MAX_EPOCH, ...(chainReceive !== undefined ? { chainReceive } : {}), ...(stealthInput !== undefined ? { stealthInput } : {}) });
      const assets = [intent.spends?.resource, chainReceive?.resource, intent.terms?.requested.resource].filter((x): x is string => x !== undefined);
      const amounts: Record<string, string> = {};
      if (intent.spends?.kind === 'fungible') amounts[intent.spends.resource] = intent.spends.amount;
      return executeSwap<SwapOfferTransactionIntent>(wallets as ExecutionWallets, {
        resolvedIntent: intent,
        recordInput: {
          operationId: review.operationId,
          operationKind: kind,
          componentOrOrderId: intent.target,
          resources: assets,
          amounts,
          lastReadback: { source: 'WALLET_PROVIDER', identity: { stateIdentity: `${kind}@${intent.target}`, readAtUnixMs: Date.now() } },
        },
        toPreview: (i) => ({ componentAddress: i.target, method: kind, args: [...i.instructions], resourcesInvolved: assets, estimatedOutputs: [], fee: 0, maxEpoch: 0, privacyDisclosure: i.privacyDisclosure, networkName: network }),
        context: { assets: assets.length > 0 ? assets : [intent.target], operation: label, network, poolOrDestination: intent.target, privacyDisclosure: intent.privacyDisclosure },
        identity,
        liveIdentity: await bridge.liveIdentity(identity.nonce),
        review,
      });
    },
    [executionWallets, walletBridge, liveExecutionIdentity, wallet, network],
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

  if (template === undefined) {
    return (
      <Card>
        <CardHeader title="P2P offers" />
        <Notice tone="info" title="P2P offers are unavailable on this network">
          {`No SwapOffer template is published and recorded for the ${generation} ${config.network} deployment, so offers cannot be created, imported or filled here. The escrow is engine-verified (audit_engine_tests/tests/p2p_offer_routes.rs); publishing it is an operator decision.`}
        </Notice>
        <ImportOnly />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="P2P offers" />
      <p className="muted">Escrow an asset at your own price, or accept someone's offer. Invitations are shared directly between people; this app never matches or stores orders.</p>
      <div className="button-row" role="tablist" aria-label="P2P offer actions">
        {(['create', 'import', 'mine'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`button${tab === t ? ' button-primary' : ''}`} onClick={() => setTab(t)}>
            {t === 'create' ? 'Create offer' : t === 'import' ? 'Import invitation' : 'My offers'}
          </button>
        ))}
      </div>
      {tab === 'create' && <CreateForm template={template} busy={busy} describe={describe} defaults={props} {...(inventory !== undefined ? { inventory } : {})} onSubmit={(intent) => guarded(async () => {
        const result = await run(intent, 'P2P_OFFER_CREATE', undefined, 'Create a P2P offer');
        if (result.outcome === 'SUBMITTED') {
          saveMine([...loadMine(), { network, generation, transactionId: result.transactionId }]);
          setMsg({ tone: 'info', title: 'Offer submitted', detail: `Transaction ${result.transactionId}. Its invitation appears under "My offers" once the offer is on-chain.` });
          setTab('mine');
        } else if (result.outcome === 'UNKNOWN') setMsg({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} It will not be retried automatically.` });
        else setMsg({ tone: 'danger', title: 'Offer failed', detail: result.reason });
      })} />}
      {tab === 'import' && <ImportForm template={template} generation={generation} network={network} reader={reader} busy={busy} describe={describe} balances={wallet.balances} {...(inventory !== undefined ? { inventory } : {})} onFill={(verdict, preimage) => guarded(async () => {
        const s = verdict.chain;
        const payment: OfferAsset = s.requested.nftId !== null ? { kind: 'nft', resource: s.requested.resource, nftId: s.requested.nftId } : { kind: 'fungible', resource: s.requested.resource, amount: s.requested.amount };
        const receive = escrowAsset(s);
        if (receive === undefined) throw new Error('The escrow holds more than one NFT; this app fills single-asset offers only.');
        const intent = buildFillSwapOfferIntent({ offerComponent: s.component, accountAddress: wallet.account ?? '', payment, preimage, maxEpoch: MAX_EPOCH, operationId: newOperationId('p2p-fill') });
        const result = await run(intent, 'P2P_OFFER_FILL', receive, 'Fill a P2P offer');
        if (result.outcome === 'SUBMITTED') setMsg({ tone: 'info', title: 'Fill submitted', detail: `Transaction ${result.transactionId}. ${describe(receive)} is deposited into your account when it commits.` });
        else if (result.outcome === 'UNKNOWN') setMsg({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} It will not be retried automatically.` });
        else setMsg({ tone: 'danger', title: 'Fill failed', detail: result.reason });
      })} />}
      {tab === 'mine' && <MyOffers template={template} generation={generation} network={network} reader={reader} busy={busy} describe={describe} onAct={(s, action) => guarded(async () => {
        const account = wallet.account ?? '';
        const intent = action === 'claim'
          ? buildClaimSwapOfferIntent({ offerComponent: s.component, accountAddress: account, maxEpoch: MAX_EPOCH, operationId: newOperationId('p2p-claim') })
          : buildCancelSwapOfferIntent({ offerComponent: s.component, accountAddress: account, maxEpoch: MAX_EPOCH, operationId: newOperationId('p2p-cancel') });
        const release = action === 'claim' ? proceedsAsset(s) : escrowAsset(s);
        if (release === undefined) throw new Error(action === 'claim' ? 'Nothing to claim yet.' : 'The escrow is empty.');
        const result = await run(intent, action === 'claim' ? 'P2P_OFFER_CLAIM' : 'P2P_OFFER_CANCEL', release, action === 'claim' ? 'Claim P2P offer proceeds' : 'Cancel a P2P offer');
        if (result.outcome === 'SUBMITTED') setMsg({ tone: 'info', title: action === 'claim' ? 'Claim submitted' : 'Cancel submitted', detail: `Transaction ${result.transactionId}. ${describe(release)} returns to your account when it commits.` });
        else if (result.outcome === 'UNKNOWN') setMsg({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} It will not be retried automatically.` });
        else setMsg({ tone: 'danger', title: 'Not completed', detail: result.reason });
      })} />}
      {msg !== undefined && <Notice tone={msg.tone} title={msg.title}>{msg.detail}</Notice>}
    </Card>
  );
}

function escrowAsset(s: SwapOfferState): OfferAsset | undefined {
  if (s.offered.containerKind === 'NonFungible') return s.offered.tokenIds.length === 1 ? { kind: 'nft', resource: s.offered.resourceAddress, nftId: s.offered.tokenIds[0]! } : undefined;
  return s.offered.amount === '0' ? undefined : { kind: 'fungible', resource: s.offered.resourceAddress, amount: s.offered.amount };
}

function proceedsAsset(s: SwapOfferState): OfferAsset | undefined {
  if (s.proceeds.containerKind === 'NonFungible') return s.proceeds.tokenIds.length === 1 ? { kind: 'nft', resource: s.proceeds.resourceAddress, nftId: s.proceeds.tokenIds[0]! } : undefined;
  return s.proceeds.amount === '0' ? undefined : { kind: 'fungible', resource: s.proceeds.resourceAddress, amount: s.proceeds.amount };
}

/** Shown when P2P is unavailable: an invitation can still be parsed, clearly UNVERIFIED. */
function ImportOnly() {
  const [text, setText] = useState('');
  let parsed: SwapOfferInvitation | undefined;
  let error: string | undefined;
  if (text.trim() !== '') {
    try {
      parsed = parseInvitation(text);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return (
    <details>
      <summary>Inspect an invitation (unverified)</summary>
      <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Invitation to inspect" />
      {error !== undefined && <Notice tone="warn" title="Not a valid invitation">{error}</Notice>}
      {parsed !== undefined && (
        <Notice tone="warn" title="UNVERIFIED: as written in the invitation">
          {`Offer ${formatAddress(parsed.component)} on ${parsed.network} (${parsed.generation}). These are the invitation's claims only; with no SwapOffer template recorded here, nothing can be verified on-chain or filled.`}
        </Notice>
      )}
    </details>
  );
}

function AssetFields(props: {
  prefix: string;
  value: { kind: 'fungible' | 'nft'; resource: string; amount: string; nftId: string };
  onChange: (v: { kind: 'fungible' | 'nft'; resource: string; amount: string; nftId: string }) => void;
  resources: ReadonlyArray<{ resourceAddress: string; label: string }>;
  /**
   * NFTs the account provably holds, read from its own vaults on chain. Present for the side
   * the user PAYS, so an owner picks an item instead of transcribing an engine id. Absent for
   * the side they want: that item belongs to someone else, so it is named, not picked.
   */
  ownNfts?: ReadonlyArray<{ resource: string; nftId: string }>;
  /** Exact revealed balance of a resource this account holds, for the "you have" hint. */
  held?: (resource: string) => string;
}) {
  const v = props.value;
  const own = props.ownNfts;
  const label = (r: string) => props.resources.find((x) => x.resourceAddress === r)?.label ?? formatAddress(r);
  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">{props.prefix} type</span>
        <select className="input" value={v.kind} onChange={(e) => props.onChange({ ...v, kind: e.target.value as 'fungible' | 'nft', resource: '', amount: '', nftId: '' })} aria-label={`${props.prefix} type`}>
          <option value="fungible">Amount of a token</option>
          <option value="nft">One specific NFT</option>
        </select>
      </label>
      {v.kind === 'nft' && own !== undefined ? (
        <label className="field">
          <span className="field-label">{props.prefix} item</span>
          <select
            className="input"
            value={v.resource === '' ? '' : `${v.resource}|${v.nftId}`}
            onChange={(e) => {
              const [resource, nftId] = e.target.value.split('|');
              props.onChange({ ...v, resource: resource ?? '', nftId: nftId ?? '' });
            }}
            aria-label={`${props.prefix} item`}
          >
            <option value="">{own.length === 0 ? 'No NFTs in this account' : 'Select an item you own'}</option>
            {own.map((n) => (
              <option key={`${n.resource}|${n.nftId}`} value={`${n.resource}|${n.nftId}`}>{`${n.nftId} — ${label(n.resource)}`}</option>
            ))}
          </select>
          {own.length === 0 && <span className="hint">This account holds no non-fungible tokens, read from its own vaults on chain.</span>}
        </label>
      ) : (
        <>
          <label className="field">
            <span className="field-label">{props.prefix} resource</span>
            <input className="input mono" list={`${props.prefix}-resources`} value={v.resource} onChange={(e) => props.onChange({ ...v, resource: e.target.value.trim() })} aria-label={`${props.prefix} resource`} placeholder="resource_…" />
            <datalist id={`${props.prefix}-resources`}>
              {props.resources.map((r) => <option key={r.resourceAddress} value={r.resourceAddress}>{r.label}</option>)}
            </datalist>
            {props.held !== undefined && v.resource !== '' && <span className="hint">{`You hold ${props.held(v.resource)} (revealed, raw units).`}</span>}
          </label>
          {v.kind === 'fungible' ? (
            <label className="field"><span className="field-label">{props.prefix} amount</span><input className="input" inputMode="decimal" value={v.amount} onChange={(e) => props.onChange({ ...v, amount: e.target.value })} aria-label={`${props.prefix} amount`} /></label>
          ) : (
            <label className="field"><span className="field-label">{props.prefix} NFT id</span><input className="input mono" value={v.nftId} onChange={(e) => props.onChange({ ...v, nftId: e.target.value.trim() })} aria-label={`${props.prefix} NFT id`} placeholder="str_… / u64_… / uuid_…" /></label>
          )}
        </>
      )}
    </div>
  );
}

function CreateForm(props: { template: string; busy: boolean; describe: (a: OfferAsset) => string; defaults: { offeredResource?: string; requestedResource?: string }; inventory?: AccountInventory; onSubmit: (intent: SwapOfferTransactionIntent) => void }) {
  const { wallet } = useApp();
  const own = useMemo(() => (props.inventory === undefined ? undefined : ownedNfts(props.inventory)), [props.inventory]);
  const held = useCallback((r: string) => (props.inventory === undefined ? '0' : revealedBalance(props.inventory, r)), [props.inventory]);
  const resources = useMemo(() => wallet.balances.map((b) => ({ resourceAddress: b.resourceAddress, label: `${b.symbol ?? formatAddress(b.resourceAddress)} (${b.resourceType})` })), [wallet.balances]);
  const [offered, setOffered] = useState({ kind: 'fungible' as 'fungible' | 'nft', resource: props.defaults.offeredResource ?? '', amount: '', nftId: '' });
  const [requested, setRequested] = useState({ kind: 'fungible' as 'fungible' | 'nft', resource: props.defaults.requestedResource ?? '', amount: '', nftId: '' });
  const [taker, setTaker] = useState('');
  const [preimage, setPreimage] = useState('');
  const [hashLock, setHashLock] = useState<string | null>(null);
  const [expiryEpochs, setExpiryEpochs] = useState('0');
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => setOffered((o) => ({ ...o, resource: props.defaults.offeredResource ?? o.resource })), [props.defaults.offeredResource]);
  useEffect(() => setRequested((o) => ({ ...o, resource: props.defaults.requestedResource ?? o.resource })), [props.defaults.requestedResource]);
  useEffect(() => {
    let live = true;
    if (preimage === '') setHashLock(null);
    else if (/^(?:[0-9a-f]{2}){16,128}$/.test(preimage)) void sha256Hex(preimage).then((h) => live && setHashLock(h));
    else setHashLock(null);
    return () => {
      live = false;
    };
  }, [preimage]);
  const decimals = (r: string) => wallet.balances.find((b) => b.resourceAddress === r)?.divisibility ?? 0;
  const typeOf = (r: string) => wallet.balances.find((b) => b.resourceAddress === r)?.resourceType;

  const build = (): SwapOfferTransactionIntent => {
    const asset = (v: typeof offered, field: string): OfferAsset =>
      v.kind === 'fungible' ? { kind: 'fungible', resource: v.resource, amount: parseDecimalToRaw(v.amount.trim(), decimals(v.resource), field).raw } : { kind: 'nft', resource: v.resource, nftId: v.nftId };
    if (taker !== '' && !HEX64.test(taker)) throw new Error('A designated taker must be their 64-hex account public key (ask them for it), or left empty for anyone.');
    if (preimage !== '' && hashLock === null) throw new Error('A preimage must be 16 to 128 bytes of lowercase hex.');
    const epoch = currentEpoch();
    const n = expiryEpochs.trim() === '' ? 0n : BigInt(expiryEpochs.trim());
    if (n > 0n && epoch === undefined) throw new Error('The current epoch is unknown, so an expiry cannot be set. Leave expiry at 0 (never) or retry after the network status loads.');
    const t = typeOf(offered.resource);
    if (offered.kind === 'nft' && t !== undefined && t !== 'non_fungible') throw new Error('The offered resource is not an NFT collection in your wallet.');
    if (offered.kind === 'fungible' && t === 'non_fungible') throw new Error('The offered resource is an NFT collection; choose "One specific NFT".');
    // Checked against the account's OWN vaults on chain, so an item that was already sold or
    // transferred cannot be escrowed, and an amount beyond the revealed balance is refused
    // before the wallet is asked to sign something that must fail.
    if (props.inventory !== undefined) {
      if (offered.kind === 'nft' && !ownsNft(props.inventory, offered.resource, offered.nftId)) {
        throw new Error(`This account does not currently hold ${offered.nftId} of that collection, so it cannot be escrowed.`);
      }
      if (offered.kind === 'fungible') {
        const want = parseDecimalToRaw(offered.amount.trim(), decimals(offered.resource), 'offered amount').raw;
        const have = revealedBalance(props.inventory, offered.resource);
        if (BigInt(have) < BigInt(want)) throw new Error(`This account holds ${have} revealed raw units of that resource, which is less than the ${want} you are offering.`);
      }
    }
    return buildCreateSwapOfferIntent({
      offerTemplateAddress: props.template,
      accountAddress: wallet.account ?? '',
      offered: asset(offered, 'offered amount'),
      requested: asset(requested, 'requested amount'),
      designatedTaker: taker === '' ? null : taker,
      hashLock,
      expiresAtEpoch: n === 0n ? '0' : String(BigInt(epoch!) + n),
      maxEpoch: MAX_EPOCH,
      operationId: newOperationId('p2p-create'),
    });
  };
  let preview: SwapOfferTransactionIntent | undefined;
  let previewError: string | undefined;
  try {
    preview = offered.resource !== '' && requested.resource !== '' ? build() : undefined;
  } catch (e) {
    previewError = (e as Error).message;
  }
  const offeredType = typeOf(offered.resource);
  return (
    <div>
      <AssetFields prefix="You offer" value={offered} onChange={setOffered} resources={resources} {...(own !== undefined ? { ownNfts: own } : {})} held={held} />
      {(offeredType === 'stealth' || offeredType === 'confidential') && (
        <Notice tone="warn" title="Privacy for this amount is given up">The offered amount is withdrawn from your REVEALED balance and is visible in escrow. The asset keeps its type; the taker receives the same resource.</Notice>
      )}
      <AssetFields prefix="You want" value={requested} onChange={setRequested} resources={resources} />
      <div className="form-grid">
        <label className="field"><span className="field-label">Only this taker (optional)</span><input className="input mono" value={taker} onChange={(e) => setTaker(e.target.value.trim().toLowerCase())} aria-label="Designated taker public key" placeholder="64-hex public key, or empty for anyone" /></label>
        <label className="field">
          <span className="field-label">Hash lock preimage (optional)</span>
          <input className="input mono" value={preimage} onChange={(e) => setPreimage(e.target.value.trim().toLowerCase())} aria-label="Hash lock preimage" placeholder="hex secret" />
          <button type="button" className="button" onClick={() => setPreimage(randomHex(32))}>Generate</button>
        </label>
        <label className="field"><span className="field-label">Expires after (epochs, 0 = never)</span><input className="input" inputMode="numeric" value={expiryEpochs} onChange={(e) => setExpiryEpochs(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Expiry in epochs" /></label>
      </div>
      {hashLock !== null && <Notice tone="warn" title="Keep the preimage">{`Hash lock ${hashLock}. The preimage is not stored by this app and is never put in the invitation. Whoever fills must supply it, and it becomes public when they do. A hash lock alone is not a complete cross-chain HTLC protocol.`}</Notice>}
      {previewError !== undefined && <Notice tone="warn" title="Check the offer">{previewError}</Notice>}
      {error !== undefined && <Notice tone="danger" title="Not submitted">{error}</Notice>}
      {preview?.terms !== undefined && (
        <>
          <DataRow label="You escrow" value={props.describe(preview.terms.offered)} />
          <DataRow label="You receive when filled" value={props.describe(preview.terms.requested)} />
          <DataRow label="Taker" value={preview.terms.designatedTaker ?? 'anyone'} />
          <DataRow label="Expiry" value={preview.terms.expiresAtEpoch === '0' ? 'never' : `epoch ${preview.terms.expiresAtEpoch}`} />
          <p className="muted">One transaction escrows your asset. You can cancel any time before it is filled; after a fill, you claim the proceeds.</p>
          <button type="button" className="button button-primary" disabled={props.busy || wallet.status !== 'CONNECTED'} onClick={() => {
            setError(undefined);
            try {
              props.onSubmit(build());
            } catch (e) {
              setError((e as Error).message);
            }
          }}>{props.busy ? 'Waiting for wallet…' : 'Review and create offer'}</button>
        </>
      )}
    </div>
  );
}

function ImportForm(props: {
  template: string;
  generation: string;
  network: string;
  reader: () => { read: (id: string) => Promise<unknown> } | undefined;
  busy: boolean;
  describe: (a: OfferAsset) => string;
  balances: ReadonlyArray<{ resourceAddress: string; amount: string; resourceType: string }>;
  inventory?: AccountInventory;
  onFill: (verdict: InvitationVerdict, preimage: string | null) => void;
}) {
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<InvitationVerdict | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [preimage, setPreimage] = useState('');
  const verify = async () => {
    setVerdict(undefined);
    setError(undefined);
    try {
      const invitation = parseInvitation(text);
      const r = props.reader();
      if (r === undefined) throw new Error('Connect a wallet: the offer is read from chain through your wallet before anything is shown as fact.');
      const chain = await decodeSwapOffer(r, invitation.component, [props.template]);
      setVerdict(verifyInvitation(invitation, chain, { network: props.network, generation: props.generation, ...(currentEpoch() !== undefined ? { currentEpoch: currentEpoch()! } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const s = verdict?.chain;
  const want: OfferAsset | undefined = s === undefined ? undefined : s.requested.nftId !== null ? { kind: 'nft', resource: s.requested.resource, nftId: s.requested.nftId } : { kind: 'fungible', resource: s.requested.resource, amount: s.requested.amount };
  // The payment check uses the account's own vaults when they have been read (exact, and the
  // only place an NFT id can be confirmed); the wallet's balance list is the fallback.
  const insufficient = (() => {
    if (want === undefined) return false;
    if (props.inventory !== undefined) {
      return want.kind === 'nft' ? !ownsNft(props.inventory, want.resource, want.nftId) : BigInt(revealedBalance(props.inventory, want.resource)) < BigInt(want.amount);
    }
    if (want.kind !== 'fungible') return false;
    const have = props.balances.find((b) => b.resourceAddress === want.resource);
    return have === undefined || !/^\d+$/.test(have.amount) || BigInt(have.amount) < BigInt(want.amount);
  })();
  const releases = s === undefined ? undefined : escrowAsset(s);
  return (
    <div>
      <label className="field">
        <span className="field-label">Invitation</span>
        <textarea className="input mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Invitation code" placeholder="shadowswap-offer:v1:…" />
      </label>
      <div className="button-row">
        <button type="button" className="button" disabled={text.trim() === ''} onClick={() => void verify()}>Verify on-chain</button>
        <label className="button">
          Open a file
          <input
            type="file"
            accept=".txt,.json,text/plain,application/json"
            style={{ display: 'none' }}
            aria-label="Invitation file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file === undefined) return;
              if (file.size > INVITATION_MAX_CHARS * 2) {
                setError('That file is far larger than any invitation; nothing was read from it.');
                return;
              }
              setError(undefined);
              setVerdict(undefined);
              void file
                .text()
                .then((t) => setText(t.trim()))
                .catch(() => setError('That file could not be read as text.'));
            }}
          />
        </label>
      </div>
      {error !== undefined && <Notice tone="danger" title="Cannot use this invitation">{error}</Notice>}
      {verdict !== undefined && s !== undefined && (
        <>
          <h3>On-chain terms <Badge tone={verdict.fillable ? 'ok' : 'warn'}>{verdict.fillable ? 'verified' : 'not fillable'}</Badge></h3>
          <DataRow label="Offer" value={s.component} />
          <DataRow label="Status" value={s.status} />
          <DataRow label="You receive" value={releases === undefined ? 'nothing (escrow empty)' : `${props.describe(releases)} (${s.offered.containerKind})`} />
          {want !== undefined && <DataRow label="You pay" value={props.describe(want)} />}
          <DataRow label="Maker key" value={s.maker} />
          <DataRow label="Taker" value={s.designatedTaker ?? 'anyone'} />
          <DataRow label="Expiry" value={s.expiresAtEpoch === '0' ? 'never' : `epoch ${s.expiresAtEpoch}`} />
          {verdict.mismatches.length > 0 && <Notice tone="danger" title="The invitation does not match the chain">{`${verdict.mismatches.join('. ')}. Only the on-chain terms above are real; this invitation cannot be used.`}</Notice>}
          {verdict.blockers.length > 0 && <Notice tone="warn" title="Cannot fill now">{verdict.blockers.join('. ')}</Notice>}
          {verdict.warnings.length > 0 && <Notice tone="info" title="Before you fill">{verdict.warnings.join('. ')}</Notice>}
          {insufficient && (
            <Notice tone="warn" title={want?.kind === 'nft' ? 'You do not hold the requested item' : 'Insufficient balance'}>
              {want?.kind === 'nft'
                ? `This offer wants NFT ${want.nftId}, which this account does not currently hold.`
                : 'This account does not hold enough of the requested asset to pay for this offer.'}
            </Notice>
          )}
          {verdict.fillable && (
            <>
              {verdict.requiresPreimage && <label className="field"><span className="field-label">Preimage (from the maker)</span><input className="input mono" value={preimage} onChange={(e) => setPreimage(e.target.value.trim().toLowerCase())} aria-label="Fill preimage" /></label>}
              <button type="button" className="button button-primary" disabled={props.busy || insufficient || (verdict.requiresPreimage && !/^(?:[0-9a-f]{2})+$/.test(preimage))} onClick={() => props.onFill(verdict, verdict.requiresPreimage ? preimage : null)}>
                {props.busy ? 'Waiting for wallet…' : 'Review and fill'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MyOffers(props: { template: string; generation: string; network: string; reader: () => { read: (id: string) => Promise<unknown> } | undefined; busy: boolean; describe: (a: OfferAsset) => string; onAct: (s: SwapOfferState, action: 'claim' | 'cancel') => void }) {
  const { walletBridge } = useApp();
  const [rows, setRows] = useState<Array<{ entry: MyOffer; state?: SwapOfferState; error?: string; code?: string }>>([]);
  const refresh = useCallback(async () => {
    const r = props.reader();
    const bridge = walletBridge();
    const list = loadMine().filter((x) => x.network === props.network && x.generation === props.generation);
    const out: Array<{ entry: MyOffer; state?: SwapOfferState; error?: string; code?: string }> = [];
    let changed = false;
    for (const entry of list) {
      try {
        if (entry.component === undefined && bridge !== undefined) {
          const created = await bridge.createdComponents(entry.transactionId, props.template.replace(/^template_/, ''));
          if (created !== undefined && created.length === 1) {
            entry.component = created[0];
            changed = true;
          }
        }
        if (entry.component === undefined || r === undefined) {
          out.push({ entry, error: 'Waiting for the transaction to commit.' });
          continue;
        }
        const state = await decodeSwapOffer(r, entry.component, [props.template]);
        let code: string | undefined;
        try {
          code = state.status === 'OPEN' ? encodeInvitation(invitationFromChain(state, { network: props.network, generation: props.generation })) : undefined;
        } catch {
          code = undefined;
        }
        out.push({ entry, state, ...(code !== undefined ? { code } : {}) });
      } catch (e) {
        out.push({ entry, error: (e as Error).message });
      }
    }
    if (changed) {
      const all = loadMine();
      for (const e of list) {
        const i = all.findIndex((x) => x.transactionId === e.transactionId);
        if (i >= 0) all[i] = e;
      }
      saveMine(all);
    }
    setRows(out);
  }, [props.reader, props.network, props.generation, props.template, walletBridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (rows.length === 0) return <p className="muted">No offers created from this browser on this network. (The list is a local convenience; every status below is read from chain.)</p>;
  return (
    <ul className="route-list" aria-label="My offers">
      {rows.map(({ entry, state, error, code }) => (
        <li key={entry.transactionId} className="route-option">
          <DataRow label="Transaction" value={entry.transactionId} />
          {entry.component !== undefined && <DataRow label="Offer" value={entry.component} />}
          {error !== undefined && <p className="muted">{error}</p>}
          {state !== undefined && (
            <>
              <DataRow label="Status" value={state.status} />
              {code !== undefined && (
                <label className="field">
                  <span className="field-label">Invitation (share it with your counterparty)</span>
                  <textarea className="input mono" readOnly rows={3} value={code} aria-label="Offer invitation" />
                  <div className="button-row">
                    <button type="button" className="button" onClick={() => void navigator.clipboard?.writeText(code)}>Copy</button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        // A plain text file, so an invitation can be sent the same way as any
                        // other message. It carries no secret (never the hash-lock preimage).
                        const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `shadow-swap-offer-${entry.component?.slice(-8) ?? 'pending'}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Save as file
                    </button>
                  </div>
                </label>
              )}
              {state.status === 'FILLED' && !state.proceeds.empty && <button type="button" className="button button-primary" disabled={props.busy} onClick={() => props.onAct(state, 'claim')}>Claim proceeds</button>}
              {state.status === 'OPEN' && <button type="button" className="button" disabled={props.busy} onClick={() => props.onAct(state, 'cancel')}>Cancel and refund</button>}
            </>
          )}
        </li>
      ))}
      <li><button type="button" className="button" onClick={() => void refresh()}>Refresh from chain</button></li>
    </ul>
  );
}
