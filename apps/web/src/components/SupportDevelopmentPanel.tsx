/**
 * Support Shadow Swap Development: a receive-only page, and nothing more.
 *
 * WHAT THIS SCREEN DOES NOT DO, which is most of what makes it trustworthy:
 *
 *   * It prepares no transaction. Opening it builds nothing, signs nothing and asks no wallet for
 *     anything. There is no amount field, because there is nothing to submit.
 *   * It needs no wallet. The addresses are public receive-only configuration, so a visitor can
 *     read and copy them with nothing connected. Requiring a connection to view a donation
 *     address would be a reason to be suspicious of the address.
 *   * It takes no address from anywhere but the reviewed donation module.
 *     `assertDonationIsolation` is called before anything is rendered, so a value arriving from
 *     token metadata, a URL parameter, a deployment manifest or the connected account cannot be
 *     displayed here even if some future caller passes one in.
 *   * It never falls back across networks. An unconfigured destination shows an unavailable state
 *     with its reason; it does not quietly show another network's address, which would turn a
 *     mainnet donor's intent into a transfer to a worthless testnet destination.
 *   * It deducts nothing. A donation is separate from exchange fees, and no transaction this
 *     application builds pays anything to these addresses.
 *
 * The QR code is a convenience. The full address is always shown as text with a copy control,
 * because a QR a scanner cannot read is an inconvenience while an address a user cannot see is a
 * reason to leave.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DONATION_DISCLOSURE,
  XTM_DONATION_NETWORK,
  assertDonationIsolation,
  donationDestinations,
  type DonationStatus,
  type TariNetwork,
} from '@tari-ootle/protocol-client';
import { QR_QUIET_ZONE, encodeQr, qrSvgPath, qrViewBox } from '../lib/qr.js';
import { Badge, Card, CardHeader, Notice } from './primitives.js';
import { normalizeError } from '../lib/errorMessage.js';

/** How long the "copied" acknowledgement stays up. Long enough to notice, short enough to forget. */
const COPIED_MS = 2200;

function QrFigure({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return undefined;
    }
  }, [value]);

  if (matrix === undefined) {
    return (
      <p className="hint">
        This address could not be rendered as a QR code. Use the address text above — it is the
        authoritative form, and the QR is only a convenience.
      </p>
    );
  }
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-1)', alignItems: 'flex-start' }}>
      <svg
        viewBox={qrViewBox(matrix)}
        role="img"
        aria-label={label}
        width="200"
        height="200"
        style={{ width: 'min(200px, 60vw)', height: 'auto', background: '#ffffff', borderRadius: 4, padding: 0 }}
        shapeRendering="crispEdges"
      >
        <rect
          x={-QR_QUIET_ZONE}
          y={-QR_QUIET_ZONE}
          width={matrix.size + QR_QUIET_ZONE * 2}
          height={matrix.size + QR_QUIET_ZONE * 2}
          fill="#ffffff"
        />
        <path d={qrSvgPath(matrix)} fill="#000000" />
      </svg>
      <figcaption className="hint">
        QR version {matrix.version}, error correction level M. Scan it or copy the address text —
        both carry the same address.
      </figcaption>
    </figure>
  );
}

function DestinationCard({ status, assetLabel }: { status: DonationStatus; assetLabel: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const address = status.configured ? status.destination.address : undefined;

  const copy = useCallback(async () => {
    if (address === undefined) return;
    setCopyError(undefined);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch (error) {
      // A clipboard refusal is normal in some browsers and over plain HTTP. Say so, and leave the
      // address selectable so the user can copy it by hand.
      setCopyError(
        `This browser would not let the page write to the clipboard (${normalizeError({ error }).message}). Select the address above and copy it manually.`,
      );
    }
  }, [address]);

  if (!status.configured) {
    return (
      <Card>
        <CardHeader
          title={assetLabel}
          actions={<Badge tone="warn">Not available yet</Badge>}
        />
        <Notice tone="info" title="No address is configured for this network">
          {status.reason}
        </Notice>
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--sm" disabled aria-disabled="true">
            Copy address
          </button>
          <button type="button" className="btn btn--sm" disabled aria-disabled="true">
            Show QR code
          </button>
        </div>
        <p className="hint">
          Both controls are disabled because there is nothing to copy. No other network&apos;s
          address is shown in its place.
        </p>
      </Card>
    );
  }

  const destination = status.destination;
  // The guarantee the donation module makes, enforced at the point of display.
  assertDonationIsolation(destination.address);

  return (
    <Card>
      <CardHeader
        title={assetLabel}
        actions={<Badge tone={destination.realValue ? 'ok' : 'testnet'}>{destination.networkLabel}</Badge>}
      />
      <Notice tone="warn" title={`Send only ${destination.asset} on ${destination.networkLabel}`}>
        {destination.safetyNote}
      </Notice>

      <div className="field">
        <span className="label" id={`addr-label-${destination.asset}`}>
          Address
        </span>
        <code
          className="mono"
          aria-labelledby={`addr-label-${destination.asset}`}
          style={{ display: 'block', wordBreak: 'break-all', userSelect: 'all', padding: 'var(--s-2)', border: '1px solid var(--line-1)', borderRadius: 4, fontSize: 'var(--text-sm)' }}
        >
          {destination.address}
        </code>
      </div>

      <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void copy()}>
          Copy address
        </button>
        <span role="status" aria-live="polite" className="hint">
          {copied ? '✓ Address copied' : ''}
        </span>
      </div>
      {copyError !== undefined && (
        <Notice tone="info" title="Could not copy for you">
          {copyError}
        </Notice>
      )}

      <QrFigure value={destination.address} label={`QR code for the ${destination.asset} donation address on ${destination.networkLabel}`} />
    </Card>
  );
}

export function SupportDevelopmentPanel({ l2Network }: { l2Network: TariNetwork }) {
  let destinations: readonly DonationStatus[];
  try {
    destinations = donationDestinations(XTM_DONATION_NETWORK, l2Network);
  } catch (error) {
    // A configuration that does not validate is shown as a refusal rather than rendered. An
    // address that fails its own network check must never reach a donor.
    return (
      <Card>
        <CardHeader title={DONATION_DISCLOSURE.heading} />
        <Notice tone="danger" title="Donation configuration is not valid">
          {normalizeError({ error }).message} No address is shown. This is a configuration problem
          in this build, not a problem with your wallet.
        </Notice>
      </Card>
    );
  }

  const [xtm, tari] = destinations;

  return (
    <div className="page-stack">
      <Card>
        <CardHeader title={DONATION_DISCLOSURE.heading} />
        <p>{DONATION_DISCLOSURE.body}</p>
        <Notice tone="info" title="Entirely optional">
          {DONATION_DISCLOSURE.optional}
        </Notice>
        <p className="hint">{DONATION_DISCLOSURE.notFees}</p>
        <p className="hint">{DONATION_DISCLOSURE.noWallet}</p>
      </Card>

      {xtm !== undefined && <DestinationCard status={xtm} assetLabel="XTM (Minotari L1)" />}
      {tari !== undefined && <DestinationCard status={tari} assetLabel="TARI (Ootle L2)" />}

      <Card>
        <CardHeader title="What a donation is, and is not" />
        <p className="hint">
          It is a transfer you make from your own wallet to the address above, in your own time,
          for whatever amount you choose. Nothing on this page initiates it.
        </p>
        <p className="hint">
          It buys no privilege: no fee discount, no priority, no special access to liquidity, no
          share of trading fees, and no claim on the project. Liquidity provider fees go entirely
          to liquidity providers, and that is unaffected by anything here.
        </p>
        <p className="hint">
          It is not refundable and not a payment for a service. Send only what you would be content
          to have given away.
        </p>
      </Card>
    </div>
  );
}
