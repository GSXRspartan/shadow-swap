/**
 * The cross-layer page: converting Minotari (L1) to Ootle (L2), and why the reverse does not
 * exist. Deliberately its OWN page rather than a tab on Swap, because an irreversible one-way
 * conversion must not sit behind the same button as a trade that either settles or does not.
 */
import { CrossLayerPanel } from '../components/CrossLayerPanel.js';

export function CrossLayerPage() {
  return (
    <div className="page-stack">
      <CrossLayerPanel />
    </div>
  );
}
