/**
 * Become a cross-layer liquidity provider: publish prices, match takers, and account honestly
 * for coins you actually hold.
 *
 * THE ONE FACT THAT SHAPES THIS WHOLE SCREEN. A cross-layer escrow names its claimant when it
 * is funded, and a claim takes the whole escrow. So there is no pool of pre-funded escrows
 * waiting for whoever turns up, and no partial fill of one. What you publish here is an
 * ADVERTISEMENT; an escrow comes into existence only after a specific taker is matched, and it
 * is claimable by that taker alone.
 *
 * WHAT THIS PANEL REFUSES TO DO
 *
 *   * It never takes your word for your own balance. Inventory is a chain read or it is unknown,
 *     and unknown is printed as unknown rather than as a zero or an estimate.
 *   * It never lets you advertise more than the last read showed. An advertised figure that
 *     nothing backs is the exact lie this whole subsystem exists to avoid.
 *   * It never promises the same coins to two takers: `commit` in `makerBook` is the only way a
 *     promise is made, and it refuses anything the last read cannot cover.
 *   * It never returns an expired escrow to available inventory. Those coins are on chain behind
 *     a refund branch, and nothing returns them until a refund transaction is signed and lands.
 *   * It never calls an exit bonus a yield. It is a worse price you pay out of your own coins,
 *     for one trade, and `BONUS_IS_NOT_YIELD` says so wherever a bonus is shown.
 *   * It signs nothing by itself and holds no keys.
 *
 * WHY THE EXIT DIRECTION IS BLOCKED HERE. Paying out XTM on Minotari L1 means reading an L1
 * balance and building an L1 hash-time-locked output, and a browser can do neither: no dApp API
 * expresses a TariScript, and no browser wallet serves an L1 balance. So an exit offer can be
 * drafted and priced on this screen but not published, because publishing it would mean
 * advertising inventory nothing has verified. That needs the local wallet companion.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BONUS_IS_NOT_YIELD,
  chainSummary,
  commit as commitInventory,
  decodeCrossLayerEscrow,
  describeOfferForMaker,
  displayState,
  emptyBook,
  lapseExpired,
  makerEscrowChain,
  marketplaceCurrentEpoch,
  observeInventory,
  publishOffer,
  quote,
  readAccountInventory,
  recordEscrow,
  recoverable,
  restoreBook,
  revealedBalance,
  serializeBook,
  setOfferAvailability,
  settleCommitment,
  signOffer,
  type Chain,
  type MakerBook,
  type MakerPricing,
  type MakerState,
  type OfferDisplayState,
  type QuoteResult,
  type SwapDirection,
} from '@tari-ootle/protocol-client';
import { useApp } from '../state/AppContext.js';
import { CANONICAL_TARI } from '../lib/routeResolver.js';
import { normalizeError } from '../lib/errorMessage.js';
import { formatAddress } from '../lib/format.js';
import { Badge, Card, CardHeader, DataRow, Notice, type BadgeTone } from './primitives.js';

const STORE_KEY = 'shadowswap.xlayer.maker.v1';

/** How many epochs ahead a new advertisement runs by default. ~40 min each on Esmeralda. */
const DEFAULT_OFFER_EPOCHS = 12;
/** How long a promise stands before it lapses and its inventory is free again. */
const DEFAULT_COMMITMENT_EPOCHS = 2;

const TONE_FOR_STATE: Readonly<Record<OfferDisplayState, BadgeTone>> = {
  INDICATIVE: 'neutral',
  SIGNED: 'info',
  RESERVED: 'warn',
  FUNDED: 'ok',
  COMPLETED: 'ok',
  EXPIRED: 'warn',
  REFUNDED: 'neutral',
  PAUSED: 'warn',
  WITHDRAWN: 'danger',
};

interface PricingForm {
  referenceRatioNum: string;
  referenceRatioDen: string;
  baseSpreadBps: string;
  fixedNetworkCostRaw: string;
  variableCostBps: string;
  exitBonusBps: string;
  maxSubsidyRaw: string;
  perTradeMaxRaw: string;
  minOrderRaw: string;
  maxOrderRaw: string;
  maxDailyVolumeRaw: string;
  minMakerProceedsRaw: string;
  maxExposurePerCounterpartyRaw: string;
  advertisedInventoryRaw: string;
  sampleAmountRaw: string;
}

const INITIAL_FORM: PricingForm = {
  referenceRatioNum: '1',
  referenceRatioDen: '1',
  baseSpreadBps: '30',
  fixedNetworkCostRaw: '0',
  variableCostBps: '0',
  exitBonusBps: '0',
  maxSubsidyRaw: '0',
  perTradeMaxRaw: '1000000',
  minOrderRaw: '1000',
  maxOrderRaw: '500000',
  maxDailyVolumeRaw: '5000000',
  minMakerProceedsRaw: '0',
  maxExposurePerCounterpartyRaw: '1000000',
  advertisedInventoryRaw: '',
  sampleAmountRaw: '100000',
};

function toPricing(form: PricingForm, committedInventoryRaw: string): MakerPricing {
  const int = (value: string): number => {
    const n = Number(value);
    return Number.isInteger(n) ? n : NaN;
  };
  return {
    referenceRatioNum: form.referenceRatioNum,
    referenceRatioDen: form.referenceRatioDen,
    baseSpreadBps: int(form.baseSpreadBps),
    fixedNetworkCostRaw: form.fixedNetworkCostRaw,
    variableCostBps: int(form.variableCostBps),
    exitBonusBps: int(form.exitBonusBps),
    maxSubsidyRaw: form.maxSubsidyRaw,
    perTradeMaxRaw: form.perTradeMaxRaw,
    minOrderRaw: form.minOrderRaw,
    maxOrderRaw: form.maxOrderRaw,
    committedInventoryRaw,
    maxDailyVolumeRaw: form.maxDailyVolumeRaw,
    minMakerProceedsRaw: form.minMakerProceedsRaw,
    maxExposurePerCounterpartyRaw: form.maxExposurePerCounterpartyRaw,
  };
}

export function MakerInventoryPanel() {
  const { config, wallet, walletBridge } = useApp();
  const [direction, setDirection] = useState<SwapDirection>('L1_TO_L2');
  const [form, setForm] = useState<PricingForm>(INITIAL_FORM);
  const [book, setBook] = useState<MakerBook>(() => emptyBook(config.network));
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [taker, setTaker] = useState({ l2: '', l1: '', sizeRaw: '' });
  const [escrowForm, setEscrowForm] = useState({ leg: '', deadline: '' });
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const account = wallet.account;
  const payOutChain: Chain = makerEscrowChain(direction);

  // The current L2 epoch as the VERIFIED indexer reported it. Without it nothing here can act:
  // every deadline in this subsystem is an absolute epoch, and a browser clock is not one.
  const currentEpoch = useMemo(() => {
    const epoch = marketplaceCurrentEpoch();
    return /^\d+$/.test(epoch) && epoch !== '0' ? Number(epoch) : undefined;
  }, [wallet.identityEpoch]);

  const position = useMemo(
    // There is no L1 tip in the browser. Zero is honest here: it makes every L1 escrow read as
    // not yet recoverable, which is the conservative answer, and the companion supplies the real
    // height when it exists.
    () => ({ l2CurrentEpoch: currentEpoch ?? 0, l1TipHeight: 0 }),
    [currentEpoch],
  );

  useEffect(() => {
    try {
      const restored = restoreBook(window.localStorage.getItem(STORE_KEY), { network: config.network });
      if (restored !== undefined) setBook(restored);
    } catch (e) {
      // A maker whose stored book cannot be validated has to be told: those promises may still
      // be live on chain, and an empty book would imply they are not.
      setError(`Your stored offers could not be validated and have not been loaded: ${normalizeError({ error: e }).message} Any escrow you funded is still on chain and still recoverable by its own refund.`);
    }
  }, [config.network]);

  const persist = useCallback((next: MakerBook) => {
    setBook(next);
    try {
      window.localStorage.setItem(STORE_KEY, serializeBook(next));
    } catch {
      /* unavailable in a private window, or over the size bound; the chain remains the record */
    }
  }, []);

  /** Reads the L2 balance of canonical TARI and records it as an observation. */
  const readL2Inventory = useCallback(async () => {
    setError(undefined);
    setNote(undefined);
    setBusy(true);
    try {
      if (account === undefined) throw new Error('Connect a wallet: inventory is read from your account, never typed in.');
      if (currentEpoch === undefined) throw new Error('The current epoch is not known from a verified indexer yet, so a read cannot be dated.');
      const bridge = walletBridge();
      const readRaw = bridge?.substateReader('EXECUTION').readRaw;
      if (readRaw === undefined) throw new Error('This wallet cannot serve substate reads, so your balance cannot be read authoritatively.');
      const inventory = await readAccountInventory({ read: (id: string) => readRaw(id) }, account);
      const balanceRaw = revealedBalance(inventory, CANONICAL_TARI);
      const result = observeInventory(book, {
        chain: 'L2',
        reference: `${account} / ${CANONICAL_TARI}`,
        balanceRaw,
        readAtEpoch: currentEpoch,
      });
      if (!result.ok) throw new Error(result.refusal);
      persist(result.book);
      setNote(`Read ${balanceRaw} raw TARI from your account at epoch ${currentEpoch}. This is spendable balance, not escrowed inventory: you can still spend it yourself at any time.`);
    } catch (e) {
      setError(normalizeError({ error: e }).message);
    } finally {
      setBusy(false);
    }
  }, [account, currentEpoch, walletBridge, book, persist]);

  const summary = useMemo(() => chainSummary(book, payOutChain, position), [book, payOutChain, position]);
  const available = summary.availableRaw;

  const makerState: MakerState = useMemo(
    () => ({
      filledTodayRaw: '0',
      subsidySpentRaw: '0',
      exposureByCounterparty: {},
      // The quote engine's inventory is the SAME figure the book derives, so a quote can never
      // be formed against inventory the book would refuse to promise.
      availableInventoryRaw: available ?? '0',
      paused: available === undefined,
    }),
    [available],
  );

  const preview: QuoteResult | { ok: false; refusal: string } = useMemo(() => {
    try {
      return quote(toPricing(form, available ?? '0'), makerState, {
        direction,
        amountInRaw: form.sampleAmountRaw,
        counterpartyId: 'preview',
      });
    } catch (e) {
      return { ok: false as const, refusal: normalizeError({ error: e }).message };
    }
  }, [form, makerState, direction, available]);

  const set = (field: keyof PricingForm) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [field]: event.target.value }));

  const publish = () => {
    setError(undefined);
    setNote(undefined);
    if (currentEpoch === undefined) {
      setError('The current epoch is not known from a verified indexer, so an offer cannot be given an absolute deadline.');
      return;
    }
    if (available === undefined) {
      setError(
        payOutChain === 'L1'
          ? 'Your L1 XTM balance cannot be read from a browser, so an exit offer cannot be published here: publishing it would mean advertising inventory nothing has verified. This needs the local wallet companion.'
          : 'Read your balance first. An advertised figure that no chain read backs is exactly what this screen refuses to publish.',
      );
      return;
    }
    const advertised = form.advertisedInventoryRaw.trim() === '' ? available : form.advertisedInventoryRaw.trim();
    if (!/^\d+$/.test(advertised)) {
      setError('The inventory to advertise must be a raw integer.');
      return;
    }
    if (BigInt(advertised) > BigInt(available)) {
      setError(`You cannot advertise ${advertised} when the last read showed ${available} unpromised. Advertising more than you hold is the one thing this screen will not do.`);
      return;
    }
    if (account === undefined) {
      setError('Connect a wallet: an offer names your own L2 account.');
      return;
    }
    const result = publishOffer(book, {
      offerId: `offer-${Date.now().toString(36)}`,
      direction,
      network: config.network,
      inventoryRaw: advertised,
      minFillRaw: form.minOrderRaw,
      maxFillRaw: form.maxOrderRaw,
      makerL1Address: taker.l1.trim() === '' ? 'unset' : taker.l1.trim(),
      makerL2PublicKey: account,
      expiresAtEpoch: currentEpoch + DEFAULT_OFFER_EPOCHS,
    });
    if (!result.ok) {
      setError(result.refusal);
      return;
    }
    persist(result.book);
    setNote('Published as an advertisement. Nothing is escrowed: an escrow exists only once a specific taker is matched, and it names that taker.');
  };

  const match = () => {
    setError(undefined);
    setNote(undefined);
    if (selected === undefined || currentEpoch === undefined) {
      setError('Select an offer, and wait for the current epoch to be known.');
      return;
    }
    const result = commitInventory(
      book,
      {
        commitmentId: `match-${Date.now().toString(36)}`,
        offerId: selected,
        takerL2PublicKey: taker.l2.trim(),
        takerL1Address: taker.l1.trim(),
        payOutRaw: taker.sizeRaw.trim(),
        takeInRaw: taker.sizeRaw.trim(),
        expiresAtEpoch: currentEpoch + DEFAULT_COMMITMENT_EPOCHS,
      },
      position,
    );
    if (!result.ok) {
      setError(result.refusal);
      return;
    }
    persist(result.book);
    setNote(`Promised ${result.commitment.payOutRaw} to ${formatAddress(result.commitment.takerL2PublicKey)} until epoch ${result.commitment.expiresAtEpoch}. The coins have NOT moved: they are still yours to spend, which is why this promise lapses rather than binding you for ever.`);
  };

  /** Records a funded escrow, read from chain, against one promise. */
  const confirmEscrow = async (commitmentId: string) => {
    setError(undefined);
    setNote(undefined);
    setBusy(true);
    try {
      const bridge = walletBridge();
      const reader = bridge?.substateReader('EXECUTION');
      const readRaw = reader?.readRaw;
      if (readRaw === undefined || reader === undefined) {
        throw new Error('This wallet cannot serve substate reads, so an escrow cannot be verified. Nothing is recorded without that read.');
      }
      if (currentEpoch === undefined) throw new Error('The current epoch is not known, so an escrow read cannot be dated.');
      const leg = escrowForm.leg.trim();
      if (leg === '') throw new Error('Give the escrow component to read.');
      const escrow = await decodeCrossLayerEscrow({ read: (id: string) => readRaw.call(reader, id) }, leg);
      const result = recordEscrow(book, {
        commitmentId,
        evidence: {
          leg: escrow.component,
          // The LIVE balance, not the amount the escrow remembers being funded with.
          escrowedRaw: escrow.balanceRaw,
          chain: 'L2',
          boundClaimant: escrow.claimantPublicKeyHex,
          readAtEpoch: currentEpoch,
        },
        escrowedAtEpoch: currentEpoch,
        escrowDeadline: escrow.expiresAtEpoch,
      });
      if (!result.ok) throw new Error(result.refusal);
      persist(result.book);
      setNote(`Escrow ${formatAddress(escrow.component)} recorded: it holds ${escrow.balanceRaw} and is claimable only by ${formatAddress(escrow.claimantPublicKeyHex)} until epoch ${escrow.expiresAtEpoch}.`);
    } catch (e) {
      setError(normalizeError({ error: e }).message);
    } finally {
      setBusy(false);
    }
  };

  const sweep = () => {
    persist(lapseExpired(book, position));
    setNote('Expired promises have been swept. A promise that lapsed never moved any coins, so its inventory is free again. An expired ESCROW is different: it is listed below and needs its own refund transaction.');
  };

  const recordRefund = (commitmentId: string, evidence: string) => {
    const result = settleCommitment(book, commitmentId, 'REFUNDED', evidence, position);
    if (!result.ok) {
      setError(result.refusal);
      return;
    }
    persist(result.book);
  };

  const entries = book.entries;
  const live = book.commitments.filter((c) => c.state === 'COMMITTED' || c.state === 'ESCROWED');
  const toRecover = recoverable(book, position);

  return (
    <div className="page-stack">
      <Card>
        <CardHeader title="Provide cross-layer liquidity" />
        <Notice tone="warn" title="Publishing an offer escrows nothing">
          A cross-layer escrow names its claimant when it is funded, and a claim takes the whole
          escrow — so there is no pre-funded escrow waiting for whoever turns up, and no partial
          fill of one. What you publish here is an advertisement. An escrow exists only once a
          specific taker is matched, for exactly that taker, for exactly one trade. Until then
          the coins stay in your wallet and remain yours to spend.
        </Notice>
        <Notice tone="danger" title="Nothing here guarantees you a return">
          You are quoting a price between two separate assets. Nothing in either chain fixes a
          rate between L1 XTM and L2 TARI, so the price is yours and so is the risk. There is no
          yield, no APY and no automatic access to anything you hold. A trade you have matched can
          still fail, and a failed trade costs you the time your escrow is locked.
        </Notice>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">Direction you are quoting</span>
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as SwapDirection)} aria-label="Direction">
              <option value="L1_TO_L2">Takers bring XTM, you pay TARI (you escrow on L2)</option>
              <option value="L2_TO_L1">Takers bring TARI, you pay XTM (you escrow on L1)</option>
            </select>
          </label>
          <DataRow label="You pay out on" value={payOutChain === 'L1' ? 'Minotari L1 (XTM)' : 'Ootle L2 (TARI)'} />
        </div>

        {payOutChain === 'L1' && (
          <Notice tone="warn" title="The exit direction cannot be published from a browser">
            Paying out XTM means reading an L1 balance and building an L1 hash-time-locked output.
            A browser can do neither: no dApp API expresses a TariScript, and no browser wallet
            serves an L1 balance. You can price and inspect an exit offer here, but publishing it
            would mean advertising inventory nothing has verified, so it is refused until the
            local wallet companion is connected.
          </Notice>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Inventory"
          actions={
            <button type="button" className="btn btn--sm" onClick={() => void readL2Inventory()} disabled={busy || payOutChain === 'L1'}>
              Read my L2 balance
            </button>
          }
        />
        <DataRow label="Current epoch (verified indexer)" value={currentEpoch === undefined ? 'unknown' : String(currentEpoch)} tone={currentEpoch === undefined ? 'warn' : undefined} />
        <DataRow
          label={`${payOutChain} balance, last read`}
          value={summary.observation === undefined ? 'never read — unknown' : `${summary.observation.balanceRaw} at epoch ${summary.observation.readAtEpoch}`}
          tone={summary.observation === undefined ? 'warn' : undefined}
        />
        <DataRow label="Unpromised (available to quote)" value={available ?? 'unknown'} tone={available === undefined ? 'warn' : undefined} />
        <DataRow label="Promised, not yet escrowed" value={summary.committedRaw} />
        <DataRow label="Escrowed on chain" value={summary.escrowedRaw} />
        <DataRow label="Escrowed and past its deadline" value={summary.recoverableRaw} tone={summary.recoverableRaw === '0' ? undefined : 'warn'} />
        <DataRow label="Paid out to takers" value={summary.paidOutRaw} />
        <DataRow label="Recovered by refund" value={summary.refundedRaw} />
        {summary.readIsStale && (
          <Notice tone="warn" title="This balance read is too old to promise from">
            You can spend your own balance at any moment, so a read from more than one epoch ago
            is not evidence of anything. Read it again before matching a taker.
          </Notice>
        )}
        {note !== undefined && <Notice tone="info" title="Recorded">{note}</Notice>}
        {error !== undefined && <Notice tone="danger" title="Refused">{error}</Notice>}
      </Card>

      <Card>
        <CardHeader title="Price" />
        <p className="muted">
          There is no default rate between L1 XTM and L2 TARI: they are separate assets and
          nothing in either chain fixes a price between them. The ratio below is yours, as an
          exact fraction so no rounding is hidden, and every figure is a raw integer in the
          asset&apos;s smallest unit.
        </p>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Output units per input unit — numerator</span>
            <input className="input" value={form.referenceRatioNum} onChange={set('referenceRatioNum')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">… denominator</span>
            <input className="input" value={form.referenceRatioDen} onChange={set('referenceRatioDen')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Your spread (bps)</span>
            <input className="input" value={form.baseSpreadBps} onChange={set('baseSpreadBps')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Variable cost (bps)</span>
            <input className="input" value={form.variableCostBps} onChange={set('variableCostBps')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Fixed network cost (raw, per trade)</span>
            <input className="input" value={form.fixedNetworkCostRaw} onChange={set('fixedNetworkCostRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Minimum order (raw)</span>
            <input className="input" value={form.minOrderRaw} onChange={set('minOrderRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Maximum order (raw)</span>
            <input className="input" value={form.maxOrderRaw} onChange={set('maxOrderRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Per-trade payout cap (raw)</span>
            <input className="input" value={form.perTradeMaxRaw} onChange={set('perTradeMaxRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Daily payout cap (raw)</span>
            <input className="input" value={form.maxDailyVolumeRaw} onChange={set('maxDailyVolumeRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Per-counterparty cap (raw)</span>
            <input className="input" value={form.maxExposurePerCounterpartyRaw} onChange={set('maxExposurePerCounterpartyRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Least you will accept per trade (raw, may be negative)</span>
            <input className="input" value={form.minMakerProceedsRaw} onChange={set('minMakerProceedsRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Exit bonus, TARI → XTM only (bps)</span>
            <input className="input" value={form.exitBonusBps} onChange={set('exitBonusBps')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Total bonus budget (raw)</span>
            <input className="input" value={form.maxSubsidyRaw} onChange={set('maxSubsidyRaw')} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Inventory to advertise (raw; blank = all unpromised)</span>
            <input className="input" value={form.advertisedInventoryRaw} onChange={set('advertisedInventoryRaw')} inputMode="numeric" placeholder={available ?? 'unknown'} />
          </label>
        </div>

        {Number(form.exitBonusBps) > 0 && (
          <Notice tone="warn" title="An exit bonus is not a yield">
            {BONUS_IS_NOT_YIELD}
            {' '}
            A bonus bigger than your spread means you lose money on every trade it applies to;
            your budget is what bounds the total, and when it runs out the bonus stops rather
            than quietly continuing at a rate nobody is funding.
          </Notice>
        )}

        <h3>What one trade would price at</h3>
        <label className="field">
          <span className="field-label">Sample taker input (raw)</span>
          <input className="input" value={form.sampleAmountRaw} onChange={set('sampleAmountRaw')} inputMode="numeric" />
        </label>
        {preview.ok ? (
          <>
            <DataRow label="Taker receives" value={preview.breakdown.netOutRaw} />
            <DataRow label="You keep" value={preview.breakdown.makerProceedsRaw} tone={BigInt(preview.breakdown.makerProceedsRaw) < 0n ? 'down' : 'up'} />
            <DataRow label="Bonus you fund" value={preview.breakdown.bonusRaw} />
            <DataRow label="Effective rate (bps of your ratio)" value={preview.effectiveRateBps} />
            <details>
              <summary>The arithmetic, step by step</summary>
              <ul className="hint">
                {preview.breakdown.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <Notice tone="info" title="No quote at this size">{preview.refusal}</Notice>
        )}

        <button type="button" className="button" onClick={publish} disabled={payOutChain === 'L1' || available === undefined}>
          Publish this advertisement
        </button>
      </Card>

      <Card>
        <CardHeader
          title="My offers"
          actions={
            <button type="button" className="btn btn--sm" onClick={sweep} disabled={book.commitments.length === 0}>
              Sweep expired promises
            </button>
          }
        />
        {entries.length === 0 ? (
          <Notice tone="info" title="No offers yet">
            An offer here is an advertisement of a price. It moves nothing and escrows nothing.
          </Notice>
        ) : (
          entries.map((entry) => {
            const id = entry.offer.terms.offerId;
            const state = displayState(book, id, position) ?? 'INDICATIVE';
            return (
              <div key={id} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
                <div className="spread">
                  <Badge tone={TONE_FOR_STATE[state]}>{state}</Badge>
                  <button type="button" className="btn btn--sm" onClick={() => setSelected(selected === id ? undefined : id)} aria-pressed={selected === id}>
                    {selected === id ? 'Selected' : 'Select'}
                  </button>
                </div>
                <DataRow label="Offer" value={id} />
                <DataRow label="Advertised inventory" value={entry.offer.terms.inventoryRaw} />
                <DataRow label="Fill size" value={`${entry.offer.terms.minFillRaw} – ${entry.offer.terms.maxFillRaw}`} />
                <DataRow label="Runs to" value={`epoch ${entry.offer.terms.expiresAtEpoch}`} />
                <p className="hint">{describeOfferForMaker(book, id, position)}</p>
                <div className="row" style={{ gap: 'var(--s-1)', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const r = signOffer(book, id, `maker-${id}`);
                      if (!r.ok) setError(r.refusal);
                      else persist(r.book);
                    }}
                    disabled={entry.offer.state !== 'INDICATIVE'}
                    title="Marks these as your own terms. It still escrows nothing."
                  >
                    Sign terms
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const r = setOfferAvailability(book, id, { paused: !entry.paused });
                      if (!r.ok) setError(r.refusal);
                      else persist(r.book);
                    }}
                  >
                    {entry.paused ? 'Resume quoting' : 'Pause quoting'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const r = setOfferAvailability(book, id, { withdrawn: true });
                      if (!r.ok) setError(r.refusal);
                      else persist(r.book);
                    }}
                    disabled={entry.withdrawn}
                    title="Takes the advertisement down. Promises you have already made and escrows you have already funded are untouched."
                  >
                    Withdraw
                  </button>
                </div>
              </div>
            );
          })
        )}
      </Card>

      <Card>
        <CardHeader title="Match a taker" />
        <Notice tone="info" title="A promise is checked against your last balance read">
          Matching a taker promises them a payout out of coins you still hold. It is refused if
          the last read cannot cover it once everything already promised is subtracted — that
          refusal is the only thing standing between two takers and the same coins.
        </Notice>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Taker&apos;s L2 account public key</span>
            <input className="input" value={taker.l2} onChange={(e) => setTaker((p) => ({ ...p, l2: e.target.value }))} placeholder="64 hex" />
          </label>
          <label className="field">
            <span className="field-label">Taker&apos;s Minotari L1 address</span>
            <input className="input" value={taker.l1} onChange={(e) => setTaker((p) => ({ ...p, l1: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Payout to promise (raw)</span>
            <input className="input" value={taker.sizeRaw} onChange={(e) => setTaker((p) => ({ ...p, sizeRaw: e.target.value }))} inputMode="numeric" />
          </label>
        </div>
        <button type="button" className="button" onClick={match} disabled={selected === undefined}>
          Promise this payout
        </button>

        <h3>Live promises</h3>
        {live.length === 0 ? (
          <p className="hint">Nothing promised. Your whole read balance is yours to quote.</p>
        ) : (
          live.map((c) => (
            <div key={c.commitmentId} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
              <div className="spread">
                <Badge tone={c.state === 'ESCROWED' ? 'ok' : 'warn'}>{c.state}</Badge>
                <span className="hint">{c.commitmentId}</span>
              </div>
              <DataRow label="Taker" value={formatAddress(c.takerL2PublicKey)} />
              <DataRow label="You pay out" value={`${c.payOutRaw} on ${c.payOutChain}`} />
              <DataRow label="Lapses at" value={c.state === 'COMMITTED' ? `epoch ${c.expiresAtEpoch}` : '—'} />
              <DataRow label="Escrow" value={c.escrow === undefined ? 'not funded' : formatAddress(c.escrow.leg)} />
              <DataRow label="Escrow deadline" value={c.escrowDeadline === undefined ? '—' : String(c.escrowDeadline)} />
              {c.state === 'COMMITTED' && (
                <>
                  <label className="field">
                    <span className="field-label">Escrow component you funded for this taker</span>
                    <input className="input" value={escrowForm.leg} onChange={(e) => setEscrowForm((p) => ({ ...p, leg: e.target.value }))} placeholder="component_…" />
                  </label>
                  <button type="button" className="btn btn--sm" onClick={() => void confirmEscrow(c.commitmentId)} disabled={busy}>
                    Verify it against chain
                  </button>
                  <p className="hint">
                    This reads the escrow and refuses it unless it names <strong>this</strong>{' '}
                    taker as its claimant and holds at least what you promised. An escrow bound to
                    another key pays a stranger and cannot be redirected.
                  </p>
                </>
              )}
            </div>
          ))
        )}
      </Card>

      <Card>
        <CardHeader title="Escrows to recover" />
        {toRecover.length === 0 ? (
          <Notice tone="info" title="Nothing to recover">
            An escrow past its deadline appears here. Note what it does <em>not</em> do: it does
            not return to your available inventory. Those coins are on chain behind a refund
            branch, and nothing returns them until a refund transaction is signed and lands.
            {payOutChain === 'L1' && ' An L1 escrow’s deadline is a block height, and a browser cannot read the L1 tip, so L1 escrows never appear here — the companion is what reports them.'}
          </Notice>
        ) : (
          toRecover.map((c) => (
            <div key={c.commitmentId} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
              <DataRow label="Escrow" value={c.escrow === undefined ? '—' : formatAddress(c.escrow.leg)} />
              <DataRow label="Holds" value={c.payOutRaw} />
              <DataRow label="Deadline passed at" value={String(c.escrowDeadline ?? 0)} />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => recordRefund(c.commitmentId, `Refund observed: escrow ${c.escrow?.leg ?? ''} read as Refunded after deadline ${c.escrowDeadline ?? 0}.`)}
              >
                I have refunded this and read it back
              </button>
              <p className="hint">
                Record this only once you have read the escrow&apos;s own status back as refunded.
                A transaction id proves a submission, not an arrival.
              </p>
            </div>
          ))
        )}
      </Card>

      <Card>
        <CardHeader title="Settlement history" />
        {book.history.length === 0 ? (
          <p className="hint">Nothing has settled yet.</p>
        ) : (
          [...book.history].reverse().map((h, index) => (
            <div key={`${h.commitmentId}-${index}`} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
              <div className="spread">
                <Badge tone={h.outcome === 'SETTLED' ? 'ok' : h.outcome === 'REFUNDED' ? 'neutral' : 'warn'}>{h.outcome}</Badge>
                <span className="hint">epoch {h.atEpoch}</span>
              </div>
              <DataRow label="Payout" value={`${h.payOutRaw} on ${h.payOutChain}`} />
              <p className="hint">{h.evidence}</p>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
