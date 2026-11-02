/**
 * The cross-layer market: exchange EXISTING L2 TARI for EXISTING L1 XTM, and the reverse.
 *
 * A SEPARATE SURFACE FROM `/cross-layer`, deliberately. That page is the official one-way
 * burn-and-claim conversion, whose first step is irreversible and which mints rather than
 * trades. This is a liquidity-backed exchange against a counterparty's existing coins. Mixing
 * them in one screen would invite a user to reach for a burn when they wanted a trade, so the
 * two never share a control and this panel never falls back to the burn route.
 *
 * WHAT THIS PANEL REFUSES TO DO, which is most of what makes it honest:
 *
 *   * It never shows an advertised price as available liquidity. A quote is offered only when a
 *     maker's escrow has been READ FROM CHAIN (`verifyCrossLayerInvitation` returns the chain's
 *     terms, never the invitation's).
 *   * It never presents a route as executable when a required wallet cannot sign it. The L1 legs
 *     need a local wallet; `planSigners` decides, and an incomplete plan is shown with the exact
 *     missing operations rather than a disabled-looking button.
 *   * It never auto-signs. Every transaction goes through the wallet's own approval.
 *   * It never claims the exchange is atomic. The disclosure says four transactions across two
 *     chains, and that an escrow is recoverable only AFTER its deadline.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CROSS_LAYER_INVITATION_MAX_CHARS,
  SWAP_STAGES,
  accountOwnerPublicKey,
  capabilityGaps,
  decodeCrossLayerEscrow,
  describeSwap,
  escrowAsFundedLeg,
  escrowChainForOffer,
  nextAction,
  parseCrossLayerInvitation,
  planSigners,
  restoreSwap,
  serializeSwap,
  verifyCrossLayerInvitation,
  type CrossLayerInvitation,
  type CrossLayerSwapRecord,
  type CrossLayerVerdict,
  type FundedLegState,
  type SwapDirection,
  type WalletKind,
} from '@tari-ootle/protocol-client';
import { useApp } from '../state/AppContext.js';
import { activeDeployment, crossLayerAvailability, isTrustedCrossLayerTemplate } from '../services/protocolDeployment.js';
import { formatAddress } from '../lib/format.js';
import { normalizeError } from '../lib/errorMessage.js';
import { Badge, Card, CardHeader, DataRow, Notice } from './primitives.js';

const STORE_KEY = 'shadowswap.xlayer.swap.v1';

/** Both legs must be signable before a trade is offered, refunds included. */
function availableWallets(l2Connected: boolean): WalletKind[] {
  // The L2 provider is whatever `window.tari` is — Sapient's extension form or Universe's
  // embedded form. A dApp never detects which, and it does not need to: the capability set is
  // the same. The local L1 wallet is NOT auto-detected, because a browser cannot see it.
  return l2Connected ? ['UNIVERSE_CONNECTOR'] : [];
}

export function CrossLayerMarketPanel() {
  const { config, wallet, walletBridge } = useApp();
  const [direction, setDirection] = useState<SwapDirection>('L2_TO_L1');
  const [invitationText, setInvitationText] = useState('');
  const [invitation, setInvitation] = useState<CrossLayerInvitation | undefined>(undefined);
  const [verdict, setVerdict] = useState<CrossLayerVerdict | undefined>(undefined);
  const [record, setRecord] = useState<CrossLayerSwapRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [l1WalletPresent, setL1WalletPresent] = useState(false);

  const deployment = activeDeployment(config.network);
  const availability = deployment === undefined
    ? { available: false as const, reason: 'The network generation has not been verified in this session, so no cross-layer template is trusted yet.', kind: 'NOT_RECORDED' as const }
    : crossLayerAvailability(deployment);

  // Recovery: a browser closing must never destroy the ability to recover funds. The record
  // holds only non-secret identifiers; the preimage's home is the local companion.
  useEffect(() => {
    const account = wallet.account;
    if (account === undefined) return;
    try {
      const restored = restoreSwap(window.localStorage.getItem(STORE_KEY), { network: config.network, l2Account: account });
      if (restored !== undefined) setRecord(restored);
    } catch {
      /* a recovery aid only; chain state is the record */
    }
  }, [wallet.account, config.network]);

  const persist = useCallback((next: CrossLayerSwapRecord) => {
    setRecord(next);
    try {
      window.localStorage.setItem(STORE_KEY, serializeSwap(next));
    } catch {
      /* unavailable in a private window; the chain remains the record */
    }
  }, []);

  const wallets = useMemo(() => {
    const list = availableWallets(wallet.status === 'CONNECTED');
    return l1WalletPresent ? [...list, 'LOCAL_WALLETD_GRPC' as WalletKind] : list;
  }, [wallet.status, l1WalletPresent]);

  const plan = useMemo(() => planSigners(direction, wallets), [direction, wallets]);
  const gaps = useMemo(() => capabilityGaps(wallets), [wallets]);

  const importInvitation = useCallback(async () => {
    setError(undefined);
    setVerdict(undefined);
    setInvitation(undefined);
    let parsed: CrossLayerInvitation;
    try {
      parsed = parseCrossLayerInvitation(invitationText);
    } catch (e) {
      setError(normalizeError({ error: e }).message);
      return;
    }
    if (parsed.direction !== direction) {
      setError(`This invitation is for ${parsed.direction === 'L2_TO_L1' ? 'TARI → XTM' : 'XTM → TARI'}; you have the other direction selected.`);
      return;
    }
    setInvitation(parsed);

    // An invitation is untrusted input, so the maker's funded leg is read from chain and THAT is
    // what a verdict is formed against. Only one direction's maker leg lives on L2 and is
    // therefore readable here; the other needs a local wallet (escrowChainForOffer says which).
    const where = escrowChainForOffer(parsed.direction);
    if (!where.browserVerifiable) return;
    if (parsed.fundedLeg === undefined) return;
    const bridge = walletBridge();
    const deployed = activeDeployment(config.network);
    const account = wallet.account;
    if (bridge === undefined || deployed === undefined || account === undefined) {
      setError('Connect a wallet first: the maker\'s escrow is read through it, not from the invitation.');
      return;
    }
    const reader = bridge.substateReader('DISPLAY');
    const readRaw = reader.readRaw;
    if (readRaw === undefined) {
      setError('This wallet cannot serve raw substate reads, so the maker\'s escrow cannot be verified. Without that read there is no offer to act on.');
      return;
    }
    const read = (address: string): Promise<unknown> => readRaw.call(reader, address);
    try {
      const escrow = await decodeCrossLayerEscrow({ read }, parsed.fundedLeg);
      // The escrow must be an instance of a RECORDED template, or it is some other component
      // that merely decodes like one.
      if (!isTrustedCrossLayerTemplate(deployed, escrow.templateAddress)) {
        setError(`That escrow is template ${formatAddress(escrow.templateAddress)}, which is not a recorded Shadow Swap cross-layer template on this network generation.`);
        return;
      }
      // The taker's own key is CHAIN data: it comes from the account component's owner rule, not
      // from anything the wallet asserts. That is what makes "could you actually claim this?" a
      // checkable question rather than a hopeful one.
      const takerKey = accountOwnerPublicKey(await read(account));
      const next = verifyCrossLayerInvitation(parsed, escrowAsFundedLeg(escrow), {
        network: config.network,
        generation: deployed.generation,
        takerL2PublicKey: takerKey,
      });
      setVerdict(next);
      // Only a verified offer becomes a recoverable record. An unverified one is deliberately
      // left unpersisted: there is nothing to recover, and storing it would imply otherwise.
      if (next.actionable) {
        persist({
          swapId: parsed.swapId,
          direction: parsed.direction,
          network: config.network,
          stage: 'QUOTED',
          role: 'USER',
          l2Account: account,
          l1Address: '',
          counterpartyL2PublicKey: parsed.makerL2PublicKey,
          counterpartyL1Address: parsed.makerL1Address,
          hashLockHex: escrow.hashLockHex,
          l2ResourceAddress: escrow.resourceAddress,
          l2RawAmount: parsed.l2RawAmount,
          l1MicroAmount: parsed.l1MicroAmount,
          l2ExpiresAtEpoch: escrow.expiresAtEpoch,
          l1RefundHeight: parsed.l1RefundHeight,
          l2EscrowComponent: escrow.component,
          updatedAtUnixMs: Date.now(),
        });
      }
    } catch (e) {
      setError(`The maker's escrow could not be read: ${normalizeError({ error: e }).message}`);
    }
  }, [invitationText, direction, walletBridge, config.network, wallet.account, persist]);

  const action = useMemo(
    () => (record === undefined ? undefined : nextAction(record, { l2CurrentEpoch: 0, l1TipHeight: 0 })),
    [record],
  );

  return (
    <div className="page-stack">
      <Card>
        <CardHeader title="Cross-layer market" />
        <Notice tone="warn" title="This is an exchange, not a swap in one transaction">
          You and a counterparty each fund an escrow on a different chain. Settlement takes four
          transactions across two chains, and both amounts, both accounts and the timing are
          public on both chains. If your counterparty does not complete, you recover your own
          escrow only <strong>after its deadline</strong> — never before. This is not the official
          burn-and-claim conversion, which is one-way and irreversible and lives on its own page.
        </Notice>

        {!availability.available && (
          <Notice tone={availability.kind === 'INCOMPATIBLE_GENERATION' ? 'danger' : 'warn'} title={availability.kind === 'INCOMPATIBLE_GENERATION' ? 'Not available on this network' : 'Not available yet'}>
            {availability.reason}
          </Notice>
        )}

        <div className="form-grid">
          <label className="field">
            <span className="field-label">Direction</span>
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as SwapDirection)} aria-label="Exchange direction">
              <option value="L2_TO_L1">TARI → XTM (leave L2)</option>
              <option value="L1_TO_L2">XTM → TARI (enter L2)</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Local Minotari wallet</span>
            <select className="input" value={l1WalletPresent ? 'yes' : 'no'} onChange={(e) => setL1WalletPresent(e.target.value === 'yes')} aria-label="Local L1 wallet available">
              <option value="no">Not connected</option>
              <option value="yes">Connected over local gRPC</option>
            </select>
          </label>
        </div>

        <h3>Required wallet permissions</h3>
        {plan.ok ? (
          <>
            <DataRow label="Signer plan" value={plan.summary} />
            {plan.needsLocalWallet && (
              <Notice tone="info" title="A browser alone cannot finish this trade">
                The Minotari L1 legs are signed by your own wallet over local gRPC. No browser
                wallet can build an L1 hash-time-locked output: that needs a TariScript, which no
                dApp API expresses. Your L2 legs are signed in the browser as usual.
              </Notice>
            )}
          </>
        ) : (
          <Notice tone="warn" title="This route cannot be completed with the wallets available">
            {plan.reason}
          </Notice>
        )}
        {gaps.length > 0 && (
          <DataRow label="Operations nothing available can sign" value={gaps.join(', ')} tone="warn" />
        )}
      </Card>

      <Card>
        <CardHeader title="Import a maker offer" />
        <Notice tone="info" title="An advertised price is not available liquidity">
          An invitation is whatever its sender chose to write. Shadow Swap reads the maker&apos;s
          escrow from chain and shows you <strong>the chain&apos;s</strong> terms, never the
          invitation&apos;s. An offer with no funded escrow is never offered as tradeable.
        </Notice>
        <label className="field">
          <span className="field-label">Invitation text</span>
          <textarea
            className="input"
            rows={4}
            maxLength={CROSS_LAYER_INVITATION_MAX_CHARS}
            value={invitationText}
            onChange={(e) => setInvitationText(e.target.value)}
            placeholder="shadowswap-xlayer:v1:…"
            aria-label="Cross-layer invitation"
          />
        </label>
        <button type="button" className="button" onClick={() => void importInvitation()} disabled={invitationText.trim().length === 0}>
          Check this offer
        </button>
        {error !== undefined && <Notice tone="danger" title="Cannot use this invitation">{error}</Notice>}

        {invitation !== undefined && (
          <>
            <h3>Offer terms, as written by the maker</h3>
            <DataRow label="Swap id" value={invitation.swapId} />
            <DataRow label="Direction" value={invitation.direction === 'L2_TO_L1' ? 'TARI → XTM' : 'XTM → TARI'} />
            <DataRow label="You pay" value={invitation.direction === 'L2_TO_L1' ? `${invitation.l2RawAmount} (raw L2 TARI)` : `${invitation.l1MicroAmount} µXTM`} />
            <DataRow label="You receive" value={invitation.direction === 'L2_TO_L1' ? `${invitation.l1MicroAmount} µXTM` : `${invitation.l2RawAmount} (raw L2 TARI)`} />
            <DataRow label="Trade size" value={`${invitation.minFillRaw} – ${invitation.maxFillRaw}`} />
            <DataRow label="L2 deadline" value={`epoch ${invitation.l2ExpiresAtEpoch}`} />
            <DataRow label="L1 refund height" value={String(invitation.l1RefundHeight)} />
            <DataRow label="Maker (L2)" value={formatAddress(invitation.makerL2PublicKey)} />
            <DataRow label="Maker (L1)" value={formatAddress(invitation.makerL1Address)} />
            <DataRow
              label="Funded escrow"
              value={invitation.fundedLeg === undefined ? 'none — indicative only' : formatAddress(invitation.fundedLeg)}
              tone={invitation.fundedLeg === undefined ? 'warn' : undefined}
            />
            <DataRow label="Signed by maker" value={invitation.signature === undefined ? 'no' : 'yes'} tone={invitation.signature === undefined ? 'warn' : undefined} />
            {verdict === undefined ? (
              <Notice tone="warn" title="Not verified against chain — no quote is offered">
                These are the maker&apos;s own words, and an invitation is whatever its sender
                chose to write. {escrowChainForOffer(invitation.direction).reason}
              </Notice>
            ) : verdict.actionable ? (
              <Notice tone="info" title="Verified against chain">{describeVerdict(verdict)}</Notice>
            ) : (
              <Notice tone="danger" title="This offer does not match chain state">
                {[...verdict.mismatches, ...verdict.blockers].join(' ')}
              </Notice>
            )}
          </>
        )}
      </Card>

      <Card>
        <CardHeader title="Settlement progress" />
        {record === undefined ? (
          <Notice tone="info" title="No exchange in progress">
            A trade in progress is recovered here after a reload. Only non-secret identifiers are
            stored: a hash lock, amounts, deadlines and chain references. The secret that opens
            an escrow is never written to this browser &mdash; it stays with the wallet that
            produced it.
          </Notice>
        ) : (
          <>
            <Badge tone={record.stage === 'SETTLED' ? 'ok' : record.stage === 'BLOCKED' || record.stage === 'UNKNOWN' ? 'warn' : 'neutral'}>
              {record.stage}
            </Badge>
            <DataRow label="Swap id" value={record.swapId} />
            <DataRow label="Stage" value={describeSwap(record, { l2CurrentEpoch: 0, l1TipHeight: 0 })} />
            {action !== undefined && <DataRow label="Next action" value={`${action.action}: ${action.reason}`} />}
            <DataRow label="Stages" value={SWAP_STAGES.join(' → ')} />
            {record.stage === 'UNKNOWN' && (
              <Notice tone="warn" title="A submission's outcome is unknown">
                This is recorded as UNKNOWN, not failed, because it may have committed. Read the
                chain for this escrow before retrying: a retry could fund or claim a second time.
              </Notice>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function describeVerdict(verdict: CrossLayerVerdict): string {
  const chain: FundedLegState = verdict.chain;
  return `The maker's ${chain.chain} escrow holds ${chain.amountRaw} against hash ${formatAddress(chain.hashLockHex)}. ${verdict.warnings.join(' ')}`;
}
