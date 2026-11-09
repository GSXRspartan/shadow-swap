/**
 * The cross-layer market page: exchange existing L2 TARI for existing L1 XTM, and the reverse.
 *
 * Kept separate from `/cross-layer` (the official one-way burn-and-claim conversion) because the
 * two are different operations with different risks, and a user reaching for one when they meant
 * the other would be an expensive mistake. Nothing here falls back to the burn route.
 *
 * Two sides, one page, and deliberately not one form. A taker checks a counterparty's escrow
 * against chain before committing; a maker accounts for coins they hold and promises them to one
 * named taker at a time. Sharing the controls would blur which side's funds are at risk at each
 * step, so the two surfaces are switched between rather than merged.
 */
import { useState } from 'react';
import { CrossLayerMarketPanel } from '../components/CrossLayerMarketPanel.js';
import { MakerInventoryPanel } from '../components/MakerInventoryPanel.js';
import { SegmentedControl } from '../components/primitives.js';

type Side = 'TAKE' | 'MAKE';

export function CrossLayerMarketPage() {
  const [side, setSide] = useState<Side>('TAKE');
  return (
    <div className="page-stack">
      <header
        style={{
          display: 'grid',
          gap: 'var(--s-4)',
          alignItems: 'center',
          gridTemplateColumns: 'minmax(0, 1fr) 220px',
          padding: 'var(--s-5)',
          borderRadius: 'var(--r-xl)',
          border: '1px solid var(--line-1)',
          background:
            'radial-gradient(300px 200px at 85% 50%, rgba(224,164,79,0.12), transparent 70%), var(--surface-2)',
        }}
      >
        <div className="stack" style={{ gap: 'var(--s-2)', minWidth: 0 }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.02em' }}>TARI ⇄ XTM</h1>
          <p className="hint" style={{ maxWidth: '52ch' }}>
            An atomic exchange between Minotari L1 and Ootle L2 — not a bridge. The two sides below share the same
            escrow &amp; claim logic; only the counterparty differs.
          </p>
          <span className="hint" style={{ fontSize: 'var(--text-xs)' }}>
            The L1 browser signer is still upstream-blocked (see the readiness card below). No fake “swap now” control
            is offered until a wallet can sign the L1 leg.
          </span>
        </div>
        <img
          src="/assets/cross-chain-sculpture/thumbnail.png"
          alt="Cross-chain sculpture: two glowing spheres joined by a golden ring"
          loading="lazy"
          decoding="async"
          style={{ width: '100%', aspectRatio: '1', objectFit: 'contain', borderRadius: 'var(--r-lg)', border: '1px solid var(--line-1)' }}
        />
      </header>
      <SegmentedControl<Side>
        label="Which side of the market you are on"
        value={side}
        options={[
          { value: 'TAKE', label: 'Take an offer', title: "Check a counterparty's escrow against chain, then trade" },
          { value: 'MAKE', label: 'Provide liquidity', title: 'Quote prices against coins you already hold' },
        ]}
        onChange={setSide}
      />
      {side === 'TAKE' ? <CrossLayerMarketPanel /> : <MakerInventoryPanel />}
    </div>
  );
}
