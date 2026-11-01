/**
 * The cross-layer market page: exchange existing L2 TARI for existing L1 XTM, and the reverse.
 *
 * Kept separate from `/cross-layer` (the official one-way burn-and-claim conversion) because the
 * two are different operations with different risks, and a user reaching for one when they meant
 * the other would be an expensive mistake. Nothing here falls back to the burn route.
 */
import { CrossLayerMarketPanel } from '../components/CrossLayerMarketPanel.js';

export function CrossLayerMarketPage() {
  return <CrossLayerMarketPanel />;
}
