/**
 * Minotari L1 -> Ootle L2 conversion (burn and claim).
 *
 * This is a SEPARATE interface from trading, because it is a different kind of operation: a
 * one-way, multi-stage conversion whose first step is irreversible, not a trade that either
 * settles or does not. The panel never calls it atomic and never offers to undo a burn.
 *
 * What this app does and does not do is stated on the page, because the honest division of
 * labour is unusual: Shadow Swap gives the correct destination, checks a burn proof against
 * the connected account and the chain's epoch, and confirms receipt from an authoritative
 * read. The CLAIM is performed by the user's own wallet, because the claim transaction is
 * signed by a key derived from the account's secret and no browser wallet exposes it
 * (packages/protocol-client/src/crossLayer/burnClaim.ts has the evidence).
 *
 * Nothing secret is stored: the durable record holds a commitment, a value, a block hash and
 * an epoch, all public chain data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_BURN_PROOF_CHARS,
  accountOwnerPublicKey,
  marketplaceCurrentEpoch,
  restoreCrossLayer,
  serializeCrossLayer,
  claimBurnInstructions,
  confirmClaimReceipt,
  describeCrossLayer,
  parseBurnClaimProof,
  readAccountInventory,
  reportClaimSubmitted,
  revealedBalance,
  startCrossLayer,
  verifyBurnClaim,
  withBurnProof,
  type BurnClaimVerdict,
  type CrossLayerRecord,
} from '@tari-ootle/protocol-client';
import { useApp } from '../state/AppContext.js';
import { CANONICAL_TARI } from '../lib/routeResolver.js';
import { formatAddress } from '../lib/format.js';
import { Badge, Card, CardHeader, DataRow, Notice } from './primitives.js';

const STORE_KEY = 'shadowswap.crosslayer.v1';

// The policy for both directions lives in protocol-client (`restoreCrossLayer` /
// `serializeCrossLayer`) so it is unit-tested rather than only exercised by rendering: a user
// who reloads after an irreversible burn depends on it. These wrappers only touch storage,
// which is unavailable in a private window or with site data blocked.
function load(network: string, account: string): CrossLayerRecord | undefined {
  try {
    return restoreCrossLayer(window.localStorage.getItem(STORE_KEY), { network, account });
  } catch {
    return undefined;
  }
}

function save(record: CrossLayerRecord): void {
  try {
    window.localStorage.setItem(STORE_KEY, serializeCrossLayer(record));
  } catch {
    /* a recovery aid only; chain state is the record */
  }
}

export function CrossLayerPanel() {
  const { config, wallet, walletBridge, market } = useApp();
  const [record, setRecord] = useState<CrossLayerRecord | undefined>(undefined);
  const [ownerKey, setOwnerKey] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<BurnClaimVerdict | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const account = wallet.account;
  const network = wallet.networkId ?? config.network;

  // The current L2 epoch, as the VERIFIED indexer reported it (the marketplace service records
  // it from that identity). Without it a claim cannot be judged claimable, which is a refusal
  // rather than an assumption: a claim submitted before the burn's epoch is permanently
  // rejected and the burn is already irreversible.
  const currentEpoch = useMemo(() => {
    const epoch = marketplaceCurrentEpoch();
    return /^\d+$/.test(epoch) && epoch !== '0' ? epoch : undefined;
  }, [market.discovery, wallet.identityEpoch]);

  const reader = useCallback(() => {
    const raw = walletBridge()?.substateReader('EXECUTION').readRaw;
    return raw === undefined ? undefined : { read: (id: string) => raw(id) };
  }, [walletBridge]);

  // The burn destination is the connected account's OWN public key, read from its component.
  useEffect(() => {
    const r = reader();
    if (r === undefined || account === undefined || wallet.status !== 'CONNECTED') {
      setOwnerKey(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const substate = await r.read(account);
        if (cancelled) return;
        const key = accountOwnerPublicKey(substate);
        setOwnerKey(key);
        setRecord((previous) => previous ?? load(network, account) ?? startCrossLayer(network, account, key));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reader, account, wallet.status, wallet.identityEpoch, network]);

  useEffect(() => {
    if (record !== undefined) save(record);
  }, [record]);

  const loadProof = (raw: string) => {
    setError(undefined);
    setVerdict(undefined);
    try {
      if (ownerKey === undefined || account === undefined) throw new Error('Connect a wallet: the proof is checked against your own account, read from chain.');
      const facts = parseBurnClaimProof(raw);
      const v = verifyBurnClaim(facts, { accountOwnerPublicKey: ownerKey, ...(currentEpoch === undefined ? {} : { currentEpoch }) });
      setVerdict(v);
      setRecord((previous) => {
        const base = previous ?? startCrossLayer(network, account, ownerKey);
        return withBurnProof(base, v, undefined);
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Receipt is confirmed ONLY by an authoritative balance read of the claimed resource.
  const checkReceipt = async () => {
    if (guard.current || record === undefined || account === undefined) return;
    guard.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const r = reader();
      if (r === undefined) throw new Error('Connect a wallet to read your balance authoritatively.');
      const inventory = await readAccountInventory(r, account);
      const balance = revealedBalance(inventory, CANONICAL_TARI);
      setRecord((previous) => {
        if (previous === undefined) return previous;
        const withBaseline = previous.baselineBalance === undefined ? { ...previous, baselineBalance: balance } : previous;
        return confirmClaimReceipt(withBaseline, balance);
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  };

  const call = record === undefined ? undefined : claimBurnInstructions(record);

  return (
    <Card>
      <CardHeader title="Convert Minotari (L1) to Ootle (L2)" />
      <Notice tone="warn" title="This is a one-way conversion, not a swap">
        Burning on the base layer is irreversible the moment it confirms. The later steps can be delayed or fail, and nothing here can return burned XTM. It is not an atomic swap, and Shadow Swap never holds your funds at any point.
      </Notice>
      <p className="muted">
        Shadow Swap gives you the correct destination, checks the burn proof against this account and the network&apos;s epoch, and confirms the funds once they arrive. <strong>The claim itself happens in your own wallet</strong>: a claim is signed by a key derived from your account secret, and no browser wallet exposes it.
      </p>

      {wallet.status !== 'CONNECTED' && <Notice tone="info" title="Connect a wallet">The destination and every check come from your account&apos;s own on-chain state.</Notice>}

      {ownerKey !== undefined && (
        <>
          <h3>1. Burn on the base layer, to this account</h3>
          <DataRow label="L2 account" value={account ?? ''} />
          <DataRow label="Burn destination (L2 account public key)" value={ownerKey} />
          <p className="hint">
            Read from this account&apos;s own component on chain, so there is nothing to transcribe. Your base-layer wallet needs this key to make the burn claimable by this account; a burn to any other key cannot be claimed here.
          </p>
          <DataRow label="Network" value={`${network}${currentEpoch === undefined ? ' (current epoch unknown)' : ` (epoch ${currentEpoch})`}`} tone={currentEpoch === undefined ? 'warn' : undefined} />
        </>
      )}

      <h3>2. Load the proof the burn produced</h3>
      <label className="field">
        <span className="field-label">Burn proof (JSON)</span>
        <textarea className="input mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Burn proof" placeholder='{"claim_proof":{…},"encrypted_data":"…","mined_in_epoch":…}' />
      </label>
      <div className="button-row">
        <button type="button" className="button" disabled={text.trim() === '' || ownerKey === undefined} onClick={() => loadProof(text)}>Check this proof</button>
        <label className="button">
          Open a file
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            aria-label="Burn proof file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file === undefined) return;
              if (file.size > MAX_BURN_PROOF_CHARS) {
                setError('That file is larger than any burn proof walletd would accept; nothing was read from it.');
                return;
              }
              void file
                .text()
                .then((t) => {
                  setText(t.trim());
                  loadProof(t);
                })
                .catch(() => setError('That file could not be read as text.'));
            }}
          />
        </label>
      </div>
      {error !== undefined && <Notice tone="danger" title="Cannot use this proof">{error}</Notice>}

      {verdict !== undefined && (
        <>
          <h3>What the proof says <Badge tone={verdict.claimable ? 'ok' : 'warn'}>{verdict.claimable ? 'claimable' : 'not claimable yet'}</Badge></h3>
          <DataRow label="Burned value" value={`${verdict.facts.value} (base-layer smallest units)`} />
          <DataRow label="Made out to" value={verdict.facts.burnPublicKey} tone={verdict.intendedForThisAccount ? undefined : 'warn'} />
          <DataRow label="Commitment" value={verdict.facts.commitment} />
          <DataRow label="L1 block" value={`${verdict.facts.blockHeight} (${formatAddress(verdict.facts.blockHash)})`} />
          <DataRow label="Claimable from L1 epoch" value={verdict.facts.minedInEpoch} />
          {verdict.blockers.length > 0 && <Notice tone="danger" title="Cannot claim">{verdict.blockers.join(' ')}</Notice>}
          {verdict.warnings.length > 0 && <Notice tone="warn" title="Before you claim">{verdict.warnings.join(' ')}</Notice>}
          <p className="hint">
            Only the structure and the destination are checked here. The ownership proof and the base-layer inclusion proof are verified by the L2 engine when your wallet submits the claim; this app cannot verify them and does not claim to.
          </p>
        </>
      )}

      {record !== undefined && (
        <>
          <h3>3. Claim it in your own wallet</h3>
          <DataRow label="Status" value={record.stage.replace(/_/g, ' ').toLowerCase()} />
          <p className="muted">{describeCrossLayer(record)}</p>
          {record.stage === 'CLAIM_READY' && call !== undefined && (
            <>
              <p className="muted">Run this against your own walletd — dry run first, then with <code>dry_run: false</code>:</p>
              <pre className="mono" aria-label="Claim command">{JSON.stringify({ jsonrpc: '2.0', id: 1, method: call.method, params: call.params }, null, 2)}</pre>
              <p className="hint">{call.note}</p>
              <button type="button" className="button" onClick={() => setRecord((p) => (p === undefined ? p : reportClaimSubmitted(p)))}>
                I have submitted the claim
              </button>
            </>
          )}
          <h3>4. Confirm the funds arrived</h3>
          <p className="muted">Checked by reading this account&apos;s own balance on chain. Nothing else counts as confirmation.</p>
          <button type="button" className="button" disabled={busy || wallet.status !== 'CONNECTED'} onClick={() => void checkReceipt()}>
            {busy ? 'Reading your balance…' : 'Check for the claimed funds'}
          </button>
          {record.stage === 'CLAIMED_CONFIRMED_ON_CHAIN' && (
            <Notice tone="info" title="Conversion complete">
              The claimed XTR is in your account and can be traded by any ordinary route on the Swap page. This was a conversion, not a trade: there is nothing to reverse.
            </Notice>
          )}
        </>
      )}

      <h3>Ootle (L2) back to Minotari (L1)</h3>
      <Notice tone="info" title="No such route exists">
        The v0.48 protocol has no L2-to-L1 withdrawal. Its complete instruction set contains a one-way <code>ClaimBurn</code> and nothing that burns or exits on L2, and the base layer has no verifier that would accept an L2 proof. Shadow Swap will not offer a bridge that depends on an operator holding the L1 funds, so this direction stays disabled until both primitives exist upstream.
      </Notice>
    </Card>
  );
}
