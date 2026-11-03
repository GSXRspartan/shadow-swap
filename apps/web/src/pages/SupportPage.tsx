/**
 * The Support Development page.
 *
 * A page rather than a modal that interrupts: nothing about a donation is time-sensitive, and a
 * dialog over a trade screen would be exactly the kind of interruption the brief rules out.
 */
import { SupportDevelopmentPanel } from '../components/SupportDevelopmentPanel.js';
import { useApp } from '../state/AppContext.js';
import { toTariNetwork } from '../lib/networks.js';

export function SupportPage() {
  const { config } = useApp();
  // The L2 donation destination is looked up for the network this build is configured for, so an
  // Esmeralda build sees Esmeralda's (absent) entry rather than mainnet's.
  return <SupportDevelopmentPanel l2Network={toTariNetwork(config.network)} />;
}
