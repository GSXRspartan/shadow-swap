/**
 * NFT card.
 *
 * Renders only what discovery returned, with the exact identities always
 * reachable. Handles a missing image, a broken image, and hostile metadata
 * without breaking the layout: media is optional, the fallback is a neutral
 * placeholder, and every string is sanitised upstream.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadNftMetadata, type NftMetadata } from '../services/nftMetadata.js';
import { formatUnits, UNAVAILABLE } from '../lib/format.js';
import { safeLabel } from '../lib/sanitize.js';
import { Badge } from './primitives.js';

export interface NftCardInput {
  collectionResource: string;
  nftId: string;
  label: string;
  metadataUri?: string;
  priceRaw?: string;
  priceDecimals?: string;
  priceSymbol?: string;
  bestOfferRaw?: string;
  to: string;
}

export function NftCard({ item }: { item: NftCardInput }) {
  const [metadata, setMetadata] = useState<NftMetadata | undefined>(undefined);
  const [imageBroken, setImageBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMetadata(undefined);
    setImageBroken(false);
    if (item.metadataUri === undefined) return;
    void loadNftMetadata(item.metadataUri, item.label).then((loaded) => {
      if (!cancelled) setMetadata(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [item.metadataUri, item.label]);

  const collectionName = safeLabel(item.label, 48) || 'Unknown collection';
  const name = metadata?.name ?? `Item ${item.nftId}`;
  const showImage = metadata?.image !== undefined && !imageBroken;
  const price = formatUnits(item.priceRaw, item.priceDecimals ?? '0', { maxFractionDigits: 4 });
  const offer = formatUnits(item.bestOfferRaw, item.priceDecimals ?? '0', { maxFractionDigits: 4 });

  return (
    <Link
      to={item.to}
      className="card"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)', padding: 'var(--s-3)', textDecoration: 'none', color: 'inherit' }}
    >
      <div
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          borderRadius: 'var(--r-md)',
          background: 'var(--surface-2)',
          border: '1px solid var(--line-1)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {showImage ? (
          <img
            src={metadata?.image}
            alt={`Media for ${name}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            decoding="async"
            onError={() => setImageBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span className="hint" style={{ padding: 'var(--s-2)', textAlign: 'center' }}>
            {imageBroken ? 'Image could not be loaded' : 'No media supplied'}
          </span>
        )}
      </div>

      <div className="stack" style={{ gap: 2 }}>
        <span className="truncate" style={{ fontWeight: 600 }} title={name}>
          {name}
        </span>
        <span className="hint truncate" title={collectionName}>
          {collectionName}
        </span>
      </div>

      <div className="spread">
        <span className="num" style={{ fontWeight: 600 }}>
          {price === UNAVAILABLE ? UNAVAILABLE : `${price} ${item.priceSymbol ?? ''}`.trim()}
        </span>
        {offer !== UNAVAILABLE && <Badge tone="info">Best offer {offer}</Badge>}
      </div>

      <span className="hint mono truncate" title={`${item.collectionResource} / ${item.nftId}`}>
        {item.nftId}
      </span>
    </Link>
  );
}
