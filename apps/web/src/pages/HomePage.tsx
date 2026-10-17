/**
 * SHADOW SWAP — landing page.
 *
 * WHAT THIS PAGE IS FOR.
 *
 * A person who has never heard of this protocol lands here and has about fifteen
 * seconds. They need three things in that time: what it is, whether it costs them
 * anything to try, and what to press. Everything below serves those three.
 *
 * THE RULE THAT GOVERNS EVERY FIGURE ON THIS PAGE.
 *
 * No TVL. No APR. No volume. No user count. No "X trades". Not because they
 * would be unimpressive, but because there is NO HONEST SOURCE for any of them
 * on a testnet, and a landing page that prints invented numbers teaches a visitor
 * to trust this project's numbers. That is the opposite of what a protocol whose
 * entire claim is "trust nothing but the chain" should do.
 *
 * Every figure shown here is one of exactly three kinds:
 *
 *   1. A NETWORK CONSTANT — Esmeralda, byte 38. Checkable with curl.
 *   2. A READ-ONLY PROTOCOL PARAMETER — the 30 bps swap fee. On-chain.
 *   3. A LINK to the thing that reports it.
 *
 * The testnet badge is prominent and unmissable, not a footnote. A visitor who
 * mistakes a testnet for production loses real money, and no amount of visual
 * polish is worth that.
 *
 * ON THE ARTWORK: see `components/brand.tsx`. Every graphic on this page is
 * abstract geometry — market depth, a node graph, deterministic asset
 * fingerprints. There is no character, mascot, or figure anywhere.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../state/AppContext.js';
import { DepthField, FlowMark, WordmarkLockup } from '../components/brand.js';

const FEE_BPS = '30';
const ESMERALDA_NETWORK_BYTE = '38';

/**
 * The three things this protocol actually does. Each panel states what the user
 * does, what it costs, and who holds the funds — in that order, because that is
 * the order a sceptical reader wants them in.
 */
const FEATURES = [
  {
    tone: 'brand',
    title: 'Swap eligible assets',
    body:
      'Trade any pair the pool has been given, at a price taken from the reserves themselves. The 30 bps fee goes to the people who supplied that liquidity — not to a developer, not to a treasury. Your wallet signs; this site never takes custody.',
    href: '/pools',
    cta: 'Explore pools',
    icon: (
      <>
        <path d="M4 15c3.5 0 3.5-9 7-9s3.5 9 7 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        <circle cx="18" cy="15" r="2.4" fill="currentColor" />
      </>
    ),
  },
  {
    tone: 'teal',
    title: 'Provide liquidity',
    body:
      'Deposit both sides of a pair in its current ratio and you receive LP tokens. You earn the trading fee automatically, through the pool itself. Part of the LP supply is permanently locked, which raises the cost of the standard attack on an empty pool.',
    href: '/pools',
    cta: 'See pool details',
    icon: (
      <>
        <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </>
    ),
  },
  {
    tone: 'violet',
    title: 'Trade NFTs',
    body:
      'List an item at a price, make an offer for a specific one, or bid on a whole collection. Payment and item move through an escrow on-chain: either both settle or neither does, and an unsettled order refunds you.',
    href: '/nfts',
    cta: 'Open the market',
    icon: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="9" cy="11" r="1.8" fill="currentColor" />
        <path d="M5 18l5-5 3 3 3-3 3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </>
    ),
  },
] as const;

export function HomePage() {
  const { wallet, connect, config } = useApp();
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    document.title = 'Shadow Swap — Liquidity & NFT Markets on Tari';
  }, []);

  // A click on "Connect" is a click, not a navigation. The user stays on the page
  // and sees the account appear in the header, which is a less jarring outcome
  // than being thrown into the pools list mid-decision.
  const onConnect = async () => {
    if (connecting || wallet.status === 'CONNECTED') return;
    setConnecting(true);
    try {
      await connect();
    } catch {
      // The provider surfaces its own state; the header renders the failure.
      // Swallowing here is deliberate — an unhandled rejection on a landing page
      // is a broken page, and there is nothing useful to add to what is shown.
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 0 }}>
      {/* ---------------------------------------------------------------- HERO */}
      <section className="ss-hero">
        <div className="ss-hero__grid" aria-hidden="true" />

        {/*
          The hero field.

          Original abstract artwork: thin liquidity curves converging on one
          priced node, over depth-of-market ladders and a node lattice. It is
          decoration behind text that already states everything it depicts, so it
          is `aria-hidden` and carries no meaning a screen reader would need.

          It replaces the previous `NodeField` SVG backdrop rather than stacking
          with it: two competing lattices read as visual noise, and the raster has
          the depth the inline one could not.

          A CSS background-image, not an `<img>`: the artwork is decorative, is
          already `aria-hidden`, and an empty alt text node would add nothing.
          `background-size: cover` + a left-to-right scrim keep the copy legible
          at every viewport, and the scrim is what makes the headline's contrast
          independent of whatever the image does on a given screen.
        */}
        <div className="ss-hero__art" aria-hidden="true" />

        <div className="ss-hero__inner">
          <div className="stack" style={{ gap: 'var(--s-5)', minWidth: 0 }}>
            <span className="ss-eyebrow">
              <span
                aria-hidden="true"
                style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }}
              />
              {config.network === 'esmeralda' ? 'Esmeralda testnet' : config.network} · not mainnet
            </span>

            <h1 className="ss-display">
              Liquidity and NFT markets,
              <br />
              <em>on Tari</em>
            </h1>

            <p className="ss-lede">
              Shadow Swap is an open-source, noncustodial liquidity and NFT trading protocol for compatible assets on Tari's Ootle
              network. Trading and liquidity interactions use on-chain smart contracts and your own wallet — this site never holds your
              funds and cannot move them.
            </p>

            <div className="ss-actions">
              {wallet.status === 'CONNECTED' ? (
                <Link className="ss-btn ss-btn--primary ss-btn--lg" to="/pools">
                  Start trading
                </Link>
              ) : (
                <button
                  type="button"
                  className="ss-btn ss-btn--primary ss-btn--lg"
                  onClick={() => void onConnect()}
                  disabled={connecting || wallet.status === 'UNAVAILABLE' || wallet.status === 'PROVIDER_UNAVAILABLE'}
                >
                  {connecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
              <Link className="ss-btn ss-btn--ghost ss-btn--lg" to="/pools">
                Explore pools
              </Link>
              <Link className="ss-btn ss-btn--ghost ss-btn--lg" to="/nfts">
                NFT market
              </Link>
            </div>

            {wallet.status !== 'CONNECTED' && (
              <p className="hint" style={{ maxWidth: '52ch' }}>
                Connecting asks your wallet for permission to show your accounts and balances. It does not authorise any transaction —
                every trade is signed separately, and you can refuse any of them.
              </p>
            )}
          </div>

          {/* Depth field: the product's one honest metaphor, drawn as data. */}
          <div className="stack" style={{ gap: 'var(--s-4)', minWidth: 0 }}>
            <div className="ss-card ss-glass ss-card--lit" style={{ padding: 'var(--s-5)' }}>
              <div className="spread" style={{ marginBottom: 'var(--s-4)', alignItems: 'center' }}>
                <span className="label">Market depth</span>
                <span className="ss-chip ss-chip--teal">authoritative reserves</span>
              </div>
              <DepthField />
              <p className="hint" style={{ marginTop: 'var(--s-3)' }}>
                Illustrative geometry. Every number this app shows a user is read from the chain first — the diagram above carries no
                price, because there is no honest one to put on a landing page.
              </p>
            </div>

            <div className="ss-card" style={{ padding: 'var(--s-4)' }}>
              <div className="ss-metrics-2">
                <div className="ss-metric">
                  <span className="ss-metric__label">Swap fee</span>
                  <span className="ss-metric__value">{FEE_BPS} bps</span>
                  <span className="ss-metric__sub">goes to liquidity providers</span>
                </div>
                <div className="ss-metric">
                  <span className="ss-metric__label">Network</span>
                  <span className="ss-metric__value">Esmeralda</span>
                  <span className="ss-metric__sub">byte {ESMERALDA_NETWORK_BYTE}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- FACTS */}
      {/*
        Four figures, every one of them independently checkable, and none of them
        derived from a background job.

        This band deliberately does NOT show a pool count. An earlier draft rendered
        `market.discovery.pools.length`, which reads "0" until discovery finishes and
        stays "0" on every error path — so the page asserted a false negative about a
        pool this repository has verified on-chain. A statistic that is wrong while
        loading is worse than no statistic, and it is precisely the habit this project
        argues against.

        What replaces it: protocol constants, and a published-template count that
        `GET /templates/{address}` answers for all four of this project's templates.
      */}
      <section style={{ padding: '0 var(--s-4) var(--s-10)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="ss-stats">
            <div className="ss-stat">
              <div className="ss-stat__value">{FEE_BPS} bps</div>
              <div className="ss-stat__label">Swap fee, retained by liquidity providers</div>
            </div>
            <div className="ss-stat">
              <div className="ss-stat__value">0</div>
              <div className="ss-stat__label">Admin or developer keys in the published pool</div>
            </div>
            <div className="ss-stat">
              <div className="ss-stat__value">4</div>
              <div className="ss-stat__label">Contract templates published on Esmeralda</div>
            </div>
            <div className="ss-stat">
              <div className="ss-stat__value">{ESMERALDA_NETWORK_BYTE}</div>
              <div className="ss-stat__label">Network byte · Esmeralda testnet</div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- FEATURES */}
      <section style={{ padding: '0 var(--s-4) var(--s-12)' }}>
        <div className="stack" style={{ maxWidth: 1180, margin: '0 auto', gap: 'var(--s-6)' }}>
          <div className="stack" style={{ gap: 'var(--s-2)', maxWidth: '62ch' }}>
            <h2 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.03em' }}>Three things you can do</h2>
            <p className="hint">
              All three are real, live, and settle through contracts you can read on-chain. None of them requires trusting this
              website.
            </p>
          </div>

          <div className="ss-features">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="ss-feature">
                <div
                  className="ss-feature__icon"
                  style={{
                    color: `var(--${feature.tone})`,
                    borderColor: `var(--${feature.tone}-line)`,
                    background: `var(--${feature.tone}-wash)`,
                  }}
                  aria-hidden="true"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    {feature.icon}
                  </svg>
                </div>
                <h3 className="ss-feature__title">{feature.title}</h3>
                <p className="ss-feature__body">{feature.body}</p>
                <Link className="ss-btn ss-btn--sm ss-btn--ghost" to={feature.href} style={{ alignSelf: 'flex-start' }}>
                  {feature.cta} →
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- HOW IT WORKS */}
      <section style={{ padding: '0 var(--s-4) var(--s-12)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="ss-card ss-card--liquidity" style={{ padding: 'var(--s-6)' }}>
            <div className="spread" style={{ flexWrap: 'wrap', marginBottom: 'var(--s-5)' }}>
              <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                <h2 style={{ fontSize: 'var(--text-2xl)', letterSpacing: '-0.025em' }}>Where liquidity fees actually go</h2>
                <p className="hint" style={{ maxWidth: '64ch' }}>
                  This is the question most trading interfaces answer badly, so here is the whole mechanism.
                </p>
              </div>
              <span className="ss-chip ss-chip--teal">no developer fee · no treasury</span>
            </div>

            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: 'var(--s-4)',
                gridTemplateColumns: 'minmax(0, 1fr)',
              }}
              className="ss-features"
            >
              {[
                {
                  n: '01',
                  t: 'You trade',
                  d: `A swap moves ${FEE_BPS} bps of the input into the pool's reserve for the output asset. That number is a read-only parameter of the contract — it is not set by this website and cannot be changed after deployment, because the pool has no owner.`,
                },
                {
                  n: '02',
                  t: 'The fee stays in the pool',
                  d: 'It is not skimmed, batched, or sent anywhere. It simply stays in the reserves, so the pool is slightly larger than it was before your trade.',
                },
                {
                  n: '03',
                  t: 'LP tokens own that surplus',
                  d: 'Because supply of LP tokens is fixed relative to reserves, every holder — including you, if you have any — owns the same fraction of the pool, and therefore of the fee.',
                },
              ].map((step) => (
                <li key={step.n} className="stack" style={{ gap: 'var(--s-2)' }}>
                  <span className="mono" style={{ color: 'var(--teal)', fontSize: 'var(--text-sm)', letterSpacing: '0.1em' }}>
                    {step.n}
                  </span>
                  <span style={{ fontWeight: 650, color: 'var(--text-1)' }}>{step.t}</span>
                  <span className="hint" style={{ lineHeight: 1.6 }}>
                    {step.d}
                  </span>
                </li>
              ))}
            </ol>

            <div className="divider" />

            <div className="stack" style={{ gap: 'var(--s-3)' }}>
              <span className="label">Fees you will actually see</span>
              <div className="ss-metrics-2">
                <div className="ss-metric">
                  <span className="ss-metric__label">LP trading fee</span>
                  <span className="ss-metric__value">{FEE_BPS} bps</span>
                  <span className="ss-metric__sub">
                    paid to liquidity providers, not deducted on top and not paid to anyone else
                  </span>
                </div>
                <div className="ss-metric">
                  <span className="ss-metric__label">Network fee</span>
                  <span className="ss-metric__value">not zero</span>
                  <span className="ss-metric__sub">
                    every transaction costs a small on-chain fee in tTARI, set by the network and shown before you sign
                  </span>
                </div>
              </div>
              <p className="hint">
                Transactions are <strong>not</strong> free. The trading fee is one cost; the network fee is a second, separate one.
                Both are shown before you approve anything.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- BRAND */}
      <footer style={{ borderTop: '1px solid var(--line-1)', padding: 'var(--s-8) var(--s-4)' }}>
        <div
          style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 'var(--s-4)', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <WordmarkLockup />
          <div className="row" style={{ gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <span className="hint">Open source · MIT</span>
            <span className="hint">
              Network: {config.network} (byte {ESMERALDA_NETWORK_BYTE}) ·{' '}
              <Link to="/activity">Activity</Link>
            </span>
          </div>
        </div>
        <p className="hint" style={{ maxWidth: 1180, margin: 'var(--s-4) auto 0', textAlign: 'center' }}>
          Experimental software on a test network. Not audited. Not for mainnet. Do not use funds you cannot afford to lose.
        </p>
      </footer>
    </div>
  );
}

/** Exported for the not-found route so it shares the landing page's chrome. */
export { FlowMark };
