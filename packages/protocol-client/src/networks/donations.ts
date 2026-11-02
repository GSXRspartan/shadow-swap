/**
 * Development donation destinations. A deliberately small, separate, reviewable module.
 *
 * WHY THIS IS ITS OWN MODULE AND TOUCHES NOTHING ELSE
 *
 * A donation address is the only address in this application that is a destination for value and
 * is NOT derived from the user, the chain, or a transaction the user is building. That makes it
 * the single most attractive thing to substitute: change one string and donations go elsewhere,
 * with no wallet compromised and nothing else visibly wrong.
 *
 * So it is isolated from every source an attacker can influence. The destinations below are
 * literals in reviewed source. They are not read from token metadata, a pool registry, a URL
 * parameter, a deployment manifest, a discovery service, a cached response, or the connected
 * account. `assertDonationIsolation` exists to make that property testable rather than merely
 * intended.
 *
 * WHAT IS CONFIGURED, AND WHAT IS NOT
 *
 *   * **XTM on Minotari L1 mainnet** — supplied and authorized by the operator for public use,
 *     and independently verified here: it parses as a dual mainnet address (network byte 0x00)
 *     with a valid DammSum checksum and the ONE_SIDED feature, which is what lets a donor send
 *     without an interactive exchange. The verification is a test, not a comment.
 *   * **TARI on Ootle L2** — not configured on any network. The operator has not supplied a
 *     permanent address, and this module will not invent one, derive one from a walletd account,
 *     or fall back to a testnet address. Every entry is `undefined`, and the UI shows an
 *     unavailable state with its reason.
 *
 * ADDING THE OOTLE ADDRESS LATER is one reviewed line in `OOTLE_DONATION_ADDRESSES`. It is
 * validated for the network it is listed under, so an Esmeralda address under `mainnet` is a
 * refusal rather than a silent substitution.
 *
 * DONATIONS ARE NOT FEES. Nothing here is referenced by a swap, a pool, an LP position, a
 * cross-layer trade or a fee calculation, and no transaction this application builds pays
 * anything to these addresses.
 */

import {
  type AddressLayer,
  type TariNetwork,
  isTestnet,
  parseMinotariAddress,
  parseOotleAddress,
  requireAddressFor,
} from './chainIdentity.js';

export class DonationConfigError extends Error {}

/**
 * The operator's public XTM donation address, on Minotari L1 MAINNET.
 *
 * Authorized by the operator for public display and reuse. It is a receive-only destination: no
 * key, seed or credential for it exists anywhere in this application, and nothing in this
 * repository can spend from it.
 */
/**
 * The L1 network XTM donations are solicited on, and it is always mainnet.
 *
 * Deliberately declared here rather than chosen by a UI: real XTM exists only on mainnet, so a
 * donation request for any other L1 network would be asking for worthless coins. It is also NOT
 * the network this build trades on — a donation address is not a trading destination, and the two
 * must not be derived from one another.
 */
export const XTM_DONATION_NETWORK: TariNetwork = 'mainnet';

export const XTM_DONATION_ADDRESS_MAINNET =
  '1259DG2v4nxMugUpj3pgSheEEhVZmoExr44GhpnC9FGVwiJscmwo2oYnzFTQWxcsHBYjmupCBaWUsNf5gDttKw2Xmg4';

/**
 * XTM destinations per L1 network. Only mainnet is configured, because only mainnet XTM is a
 * thing anyone would want to donate — and a testnet entry would be an invitation to send
 * worthless coins while believing otherwise.
 */
export const XTM_DONATION_ADDRESSES: Readonly<Partial<Record<TariNetwork, string>>> = {
  mainnet: XTM_DONATION_ADDRESS_MAINNET,
};

/**
 * TARI destinations per Ootle L2 network. NONE are configured.
 *
 * Mainnet is absent because the operator has not supplied one and Ootle mainnet has not launched.
 * Esmeralda is absent because a testnet donation is not a donation. Both are explicitly listed as
 * `undefined` rather than omitted, so the table itself records that the gap is intentional.
 */
export const OOTLE_DONATION_ADDRESSES: Readonly<Partial<Record<TariNetwork, string | undefined>>> = {
  mainnet: undefined,
  esmeralda: undefined,
};

/** Why a destination is unavailable, per network. Shown verbatim; never a generic message. */
export const OOTLE_DONATION_UNAVAILABLE_REASON: Readonly<Partial<Record<TariNetwork, string>>> = {
  mainnet:
    'No Ootle mainnet donation address has been supplied yet, and Ootle mainnet has not launched. A placeholder would be worse than nothing: a donation sent to a guessed address is gone. This will be enabled by a reviewed configuration change once the operator provides a permanent address.',
  esmeralda:
    'There is no Esmeralda donation address, and there will not be one: Esmeralda TARI is test currency with no value, so sending it would cost the donor effort and give nothing.',
};

export type DonationAsset = 'XTM' | 'TARI';

export interface DonationDestination {
  readonly asset: DonationAsset;
  readonly layer: AddressLayer;
  readonly network: TariNetwork;
  readonly address: string;
  /** What a donor must be told before sending. Shown with the address, not behind a disclosure. */
  readonly safetyNote: string;
  /** Short label for the network badge. */
  readonly networkLabel: string;
  /**
   * True when this destination is on a network carrying real value.
   *
   * Supplied here rather than left to a UI to infer from the network's name: a screen that
   * compares network strings to decide how loudly to warn is a screen where a renamed network
   * silently changes the warning.
   */
  readonly realValue: boolean;
}

export type DonationStatus =
  | { readonly configured: true; readonly destination: DonationDestination }
  | { readonly configured: false; readonly asset: DonationAsset; readonly network: TariNetwork; readonly reason: string };

/**
 * The XTM destination for a network, with its address re-verified on every call.
 *
 * Re-verifying is not paranoia about this module's own constant: it is what makes a future edit
 * safe. The next person to touch `XTM_DONATION_ADDRESSES` gets a refusal rather than a quietly
 * broken address, because the check is in the read path and not only in a test.
 */
export function xtmDonation(network: TariNetwork): DonationStatus {
  const address = XTM_DONATION_ADDRESSES[network];
  if (address === undefined) {
    return {
      configured: false,
      asset: 'XTM',
      network,
      reason:
        network === 'mainnet'
          ? 'No XTM donation address is configured.'
          : `No XTM donation address is configured for ${network}, and none will be: a donation of test currency has no value to the project and costs the donor their time.`,
    };
  }
  const match = requireAddressFor(address, { layer: 'L1_MINOTARI', network });
  if (!match.ok) {
    throw new DonationConfigError(
      `The configured XTM donation address for ${network} is not valid for that network: ${match.reason} Refusing to display it.`,
    );
  }
  const parsed = parseMinotariAddress(address);
  return {
    configured: true,
    destination: {
      asset: 'XTM',
      layer: 'L1_MINOTARI',
      network,
      address,
      networkLabel: network === 'mainnet' ? 'Minotari L1 Mainnet' : `Minotari L1 ${network}`,
      realValue: !isTestnet(network),
      safetyNote: parsed.features.includes('ONE_SIDED')
        ? 'Send only XTM on the Minotari base layer (L1) to this address. It is not an Ootle (L2) address and cannot receive Ootle TARI. It accepts one-sided (non-interactive) payments, so an ordinary send from a Minotari wallet works.'
        : 'Send only XTM on the Minotari base layer (L1) to this address. It is not an Ootle (L2) address and cannot receive Ootle TARI.',
    },
  };
}

/**
 * The Ootle TARI destination for a network, or an unavailable status with its reason.
 *
 * Never falls back to another network. That is the single most important line in this file: a
 * mainnet donor shown a testnet address would send real intent to a worthless destination, and
 * the fallback would look like a feature.
 */
export function ootleDonation(network: TariNetwork): DonationStatus {
  const address = OOTLE_DONATION_ADDRESSES[network];
  if (address === undefined || address === '') {
    return {
      configured: false,
      asset: 'TARI',
      network,
      reason:
        OOTLE_DONATION_UNAVAILABLE_REASON[network] ??
        `No Ootle donation address is configured for ${network}, and no other network's address is ever used in its place.`,
    };
  }
  const match = requireAddressFor(address, { layer: 'L2_OOTLE', network });
  if (!match.ok) {
    throw new DonationConfigError(
      `The configured Ootle donation address for ${network} is not valid for that network: ${match.reason} Refusing to display it.`,
    );
  }
  const parsed = parseOotleAddress(address);
  return {
    configured: true,
    destination: {
      asset: 'TARI',
      layer: 'L2_OOTLE',
      network,
      address: parsed.bech32,
      networkLabel: network === 'mainnet' ? 'Ootle L2 Mainnet' : `Ootle L2 ${network}`,
      realValue: !isTestnet(network),
      safetyNote:
        'Send only Ootle TARI (L2) to this address. It is not a Minotari base-layer address and cannot receive XTM; the two are different assets on different networks.',
    },
  };
}

/** Both destinations for a network pairing, in the order a UI shows them. */
export function donationDestinations(l1Network: TariNetwork, l2Network: TariNetwork): readonly DonationStatus[] {
  return [xtmDonation(l1Network), ootleDonation(l2Network)];
}

/**
 * The guarantee this module makes to the rest of the application, as a checkable assertion.
 *
 * Throws if a candidate destination did not come from this module's own tables. Called wherever a
 * donation address is about to be DISPLAYED, so a value that arrived from metadata, a URL, a
 * manifest or a connected account cannot be rendered as a donation destination even if some
 * future caller passes it in.
 */
export function assertDonationIsolation(address: string): void {
  const configured = [
    ...Object.values(XTM_DONATION_ADDRESSES),
    ...Object.values(OOTLE_DONATION_ADDRESSES),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!configured.includes(address)) {
    throw new DonationConfigError(
      'Refusing to present an address as a donation destination unless it is one of the destinations configured in this module. A donation address never comes from token metadata, a pool registry, a URL parameter, a deployment manifest or the connected account.',
    );
  }
}

/** The copy the UI must carry. Here so it is reviewed alongside the addresses it describes. */
export const DONATION_DISCLOSURE = {
  heading: 'Support Shadow Swap Development',
  body:
    'Shadow Swap is a public, noncustodial exchange. If you\'d like to support ongoing development, infrastructure, security testing, and maintenance, you can make a voluntary donation.',
  optional: 'Donations are optional and are not required to trade, provide liquidity, or withdraw funds.',
  notFees:
    'A donation is separate from exchange fees. No transaction this application builds pays anything to these addresses, and nothing is deducted from a trade, a liquidity position or a withdrawal.',
  noWallet: 'No wallet connection is needed to view or copy these addresses, and opening this panel prepares no transaction.',
} as const;
