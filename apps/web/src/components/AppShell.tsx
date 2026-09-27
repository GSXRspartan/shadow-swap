/**
 * Application shell: top navigation, mobile navigation, network/testnet status,
 * market-data health, and the wallet control.
 */

import { useState, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useApp, type MarketDataState } from '../state/AppContext.js';
import { Badge, Notice, Dialog, type BadgeTone } from './primitives.js';
import { capabilityRows, atomicSwapAvailability, type SwapDirectionKind } from '../lib/capabilities.js';
import { FRONTEND_NETWORKS } from '../lib/networks.js';
import { formatAddress, UNAVAILABLE } from '../lib/format.js';
import { ProtocolMark } from './ProtocolMark.js';

const NAV_ITEMS = [
  { to: '/pools', label: 'Pools' },
  { to: '/nfts', label: 'NFTs' },
  { to: '/activity', label: 'Activity' },
] as const;

const HEALTH_TONE: Record<string, BadgeTone> = {
  SYNCED: 'ok',
  SYNCING: 'info',
  STALE: 'warn',
  DEGRADED: 'warn',
  UNAVAILABLE: 'danger',
};

function NetworkBadge() {
  const { config, wallet } = useApp();
  const network = FRONTEND_NETWORKS[config.network];
  const providerMismatch = wallet.networkId !== undefined && wallet.networkId !== config.network;
  const tone: BadgeTone = providerMismatch ? 'danger' : 'neutral';
  return (
    <span className="row" style={{ gap: 'var(--s-1)' }}>
      <Badge tone={tone} title={`Provider network: ${wallet.networkId ?? 'not connected'}`}>
        {network.displayName}
      </Badge>
      <Badge tone="testnet" title="This build is testnet-only. Mainnet is not selectable.">
        {network.badge}
      </Badge>
    </span>
  );
}

function HealthBadge() {
  const { market } = useApp();
  const tone = HEALTH_TONE[market.health.status] ?? 'neutral';
  return (
    <Badge tone={tone} title={market.health.detail}>
      Data: {market.health.label}
    </Badge>
  );
}

function WalletControl() {
  const { wallet, connect, disconnect } = useApp();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const label =
    wallet.status === 'CONNECTED'
      ? formatAddress(wallet.account, 6, 4)
      : wallet.status === 'CONNECTING'
        ? 'Connecting…'
        : wallet.status === 'UNAVAILABLE'
          ? 'No wallet'
          : 'Connect wallet';

  return (
    <>
      <div className="row" style={{ gap: 'var(--s-2)' }}>
        {wallet.status === 'CONNECTED' ? (
          <>
            <button type="button" className="btn btn--sm" onClick={() => setDetailsOpen(true)} aria-haspopup="dialog">
              <span className="sr-only">Open wallet details for </span>
              {label}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void connect()} disabled={wallet.status === 'CONNECTING' || wallet.status === 'UNAVAILABLE'}>
            {label}
          </button>
        )}
      </div>
      <WalletDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} />
    </>
  );
}

function WalletDetails({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallet, config, realSubmit } = useApp();
  const rows = capabilityRows(wallet.capabilities);
  const availability = atomicSwapAvailability('XTM_TO_TARI' as SwapDirectionKind, wallet.capabilities);

  return (
    <Dialog open={open} title="Wallet" onClose={onClose}>
      <div className="stack">
        <div className="spread">
          <span className="label">Status</span>
          <Badge tone={wallet.status === 'CONNECTED' ? 'ok' : wallet.status === 'ERROR' ? 'danger' : 'neutral'}>{wallet.status}</Badge>
        </div>
        <div className="spread">
          <span className="label">Account</span>
          <span className="mono truncate">{wallet.account ?? UNAVAILABLE}</span>
        </div>
        <div className="spread">
          <span className="label">Network</span>
          <span className="num">{wallet.networkId ?? UNAVAILABLE}</span>
        </div>
        <div className="spread">
          <span className="label">Expected network</span>
          <span className="num">{FRONTEND_NETWORKS[config.network].displayName}</span>
        </div>
        <div className="spread">
          <span className="label">Real cross-chain submit</span>
          <Badge tone={realSubmit.enabled ? 'warn' : 'neutral'} title={realSubmit.reason}>
            {realSubmit.enabled ? 'GATE OPEN' : 'GATED OFF'}
          </Badge>
        </div>

        <hr className="divider" />

        <div className="stack" style={{ gap: 'var(--s-1)' }}>
          <span className="label">Advertised capabilities</span>
          {wallet.capabilities === undefined ? (
            <p className="hint">
              The provider did not advertise a capability set. Anything requiring a specific capability is refused rather than assumed.
            </p>
          ) : (
            <ul className="stack" style={{ gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((row) => (
                <li key={row.key} className="spread">
                  <span className="hint">
                    {row.leg} · {row.label}
                    {row.requiredFor.length > 0 && <span className="muted"> · required for {row.requiredFor.join(', ')}</span>}
                  </span>
                  <Badge tone={row.available ? 'ok' : 'danger'}>{row.available ? 'yes' : 'no'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <hr className="divider" />

        <Notice tone={availability.available ? 'info' : 'warn'} title={availability.headline}>
          {availability.reason} {availability.remedy}
        </Notice>

        {wallet.error !== undefined && (
          <Notice tone="danger" title="Wallet error">
            {wallet.error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Global outage surface (mission §35).
 *
 * Discovery and market-data health are global states. Without this banner a
 * user has to infer an outage from every table being empty, which is exactly
 * the failure mode where "the endpoint never answered" and "there are zero
 * pools" are indistinguishable. The reason text comes from the discovery layer
 * verbatim; nothing here is synthesised, and execution is unaffected because it
 * always performs an authoritative reread.
 *
 * Exported as its own component so the state machine that decides *when* to say
 * this is testable without running an effect.
 */
export function OutageNotice({ state }: { state: MarketDataState }) {
  if (state.loading) return null;
  if (state.health.status !== 'UNAVAILABLE') return null;
  if (state.discovery.unavailableReason === undefined) return null;
  return (
    <div style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-4) var(--s-4) 0', width: '100%' }}>
      <Notice tone="warn" title="Market data is unavailable">
        {state.discovery.unavailableReason} Nothing is being fabricated to fill the gap: no pools, trades, candles, or collections are shown unless they
        were actually read. Wallet signing and authoritative rereads are separate from this discovery path and are unaffected.
      </Notice>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { config, wallet, market } = useApp();
  const walletError = wallet.status === 'ERROR' ? wallet.error : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          borderBottom: '1px solid var(--line-1)',
          background: 'color-mix(in srgb, var(--surface-0) 88%, transparent)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div
          className="row"
          style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: '0 var(--s-4)', minHeight: 'var(--nav-h)', gap: 'var(--s-4)' }}
        >
          <Link to="/pools" className="row" style={{ gap: 'var(--s-2)', flex: 'none' }} aria-label="Tari Ootle Liquidity Protocol — pools">
            <ProtocolMark />
            {/* Hidden below 1024px by the stylesheet: on a narrow header the
                wordmark is what overflows under wider font metrics, and the
                mark + wordmark pair keeps its identity through the link's
                aria-label. */}
            <span className="shell-header-branding" style={{ fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
              Ootle Liquidity
            </span>
          </Link>

          <nav aria-label="Primary" className="row" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `btn btn--sm ${isActive ? '' : 'btn--ghost'}`.trim()}
                /* The active route is one of the few places the lime accent is
                   used: it marks "where you are" and nothing else. */
                style={({ isActive }) =>
                  isActive ? { background: 'var(--surface-3)', color: 'var(--text-1)', boxShadow: 'inset 0 -2px 0 var(--accent)' } : undefined
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="row" style={{ gap: 'var(--s-2)', flex: 'none' }}>
            <span className="hide-sm">
              <HealthBadge />
            </span>
            <span className="hide-sm">
              <NetworkBadge />
            </span>
            <WalletControl />
          </div>
        </div>

        <div className="row hide-lg" style={{ padding: '0 var(--s-4) var(--s-2)', gap: 'var(--s-2)', maxWidth: 'var(--shell-max)', margin: '0 auto' }}>
          <NetworkBadge />
          <HealthBadge />
        </div>
      </header>

      {config.blocking.length > 0 && (
        <div style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-4) var(--s-4) 0', width: '100%' }}>
          <Notice tone="danger" title="Configuration blocked">
            <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
              {config.blocking.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {/*
        Global outage surface. The rendering decision lives in `OutageNotice`
        above so it is testable without running effects in a server render.
      */}
      <OutageNotice state={market} />

      {config.developmentReason !== undefined && (
        <div style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-4) var(--s-4) 0', width: '100%' }}>
          <Notice tone="warn" title="Development mode">
            Running with {config.developmentReason}. Anything shown as data in this build is not real chain data and must not be treated as settlement
            evidence.
          </Notice>
        </div>
      )}

      {/*
        A refused connection must explain itself in the page, not only inside the
        wallet-details dialog. Silently refusing a mainnet provider looks like a
        broken button, and invites the user to switch networks without ever
        learning why the request was rejected.
      */}
      {walletError !== undefined && (
        <div style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-4) var(--s-4) 0', width: '100%' }}>
          <Notice tone="danger" title="Wallet connection refused">
            {walletError}
          </Notice>
        </div>
      )}

      <main id="main" style={{ flex: 1, width: '100%', maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-4)' }}>
        {children}
      </main>

      <footer style={{ borderTop: '1px solid var(--line-1)', marginTop: 'var(--s-8)' }}>
        <div
          className="stack"
          style={{ maxWidth: 'var(--shell-max)', margin: '0 auto', padding: 'var(--s-5) var(--s-4)', gap: 'var(--s-2)' }}
        >
          <p className="hint">
            Experimental software on a test network. Not audited, not a guaranteed legal safe harbour, and not a place to hold value you cannot afford to
            lose. Pool reserves are public by design.
          </p>
          <p className="hint">
            Charts by{' '}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener">
              TradingView Lightweight Charts™
            </a>{' '}
            — Copyright 2023 TradingView, Inc., Apache 2.0. See{' '}
            <a href="https://github.com/tradingview/lightweight-charts" target="_blank" rel="noreferrer noopener">
              the library licence
            </a>
            .
          </p>
          <p className="hint">
            Liquidity provider fees go entirely to liquidity providers. Provider spread belongs to the cross-layer provider. There is no developer trading
            fee.
          </p>
        </div>
      </footer>
    </div>
  );
}
