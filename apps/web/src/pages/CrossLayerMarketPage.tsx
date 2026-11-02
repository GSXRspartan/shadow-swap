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
