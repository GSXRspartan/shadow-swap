/**
 * SHADOW SWAP — BRAND GEOMETRY.
 *
 * Every mark in this file is ABSTRACT. There is no character, no animal, no
 * face, no silhouette, and nothing derived from any figure. That is a deliberate
 * design constraint, not a stylistic accident — see `styles/tokens.css` for why a
 * mascot would be actively wrong for a protocol whose whole claim is that no
 * party stands behind it holding anything.
 *
 * The visual language is INFRASTRUCTURE: flow, depth, depth-of-market, and
 * connectivity. Each mark below is a diagram of something the product does.
 */

/**
 * The wordmark glyph: two liquidity curves converging on a single priced point.
 *
 * The reading is literal and is the only metaphor used anywhere in the brand:
 * two sides of a pool, one shared price. The bright node is where they meet.
 *
 * Deliberately NOT drawn: anything with a front, a profile, an eye, or a
 * recognisable outline. A mark that could be mistaken for a face is a different
 * mark.
 */
export function FlowMark({ size = 28, tone = 'brand' }: { size?: number; tone?: 'brand' | 'current' }) {
  const stroke = tone === 'current' ? 'currentColor' : 'var(--brand)';
  const partner = tone === 'current' ? 'currentColor' : 'var(--teal)';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Shadow Swap"
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <linearGradient id="ss-flow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={stroke} />
          <stop offset="100%" stopColor={partner} />
        </linearGradient>
      </defs>
      {/* The converging price curve: bid side rising into the mid. */}
      <path d="M3 22c4.5 0 4.5-11 9-11s4.5 11 9 11 4.5-6 8-6" stroke="url(#ss-flow)" strokeWidth="2.4" strokeLinecap="round" />
      {/* The priced point both sides meet at. */}
      <circle cx="21" cy="22" r="3" fill={stroke} />
      {/* The depth bar, below: a market ladder rather than a decoration. */}
      <g opacity="0.55">
        <rect x="3" y="27.5" width="4" height="2" rx="1" fill={partner} />
        <rect x="9" y="27.5" width="7" height="2" rx="1" fill={partner} />
        <rect x="18" y="27.5" width="11" height="2" rx="1" fill={stroke} />
      </g>
    </svg>
  );
}

/**
 * The lockup: glyph + wordmark + subtitle.
 *
 * The subtitle is the PUBLIC product descriptor and is always present on the
 * lockup, because the product name alone does not say what it is. On very narrow
 * viewports the shell drops the whole thing rather than shrinking it into
 * illegibility — the header keeps a single-word fallback instead.
 */
export function WordmarkLockup({ compact = false }: { compact?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-3)', minWidth: 0 }}>
      <FlowMark size={compact ? 26 : 30} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1, minWidth: 0 }}>
        <span
          style={{
            fontWeight: 700,
            fontSize: 'var(--text-lg)',
            letterSpacing: '-0.02em',
            color: 'var(--text-1)',
            whiteSpace: 'nowrap',
          }}
        >
          Shadow Swap
        </span>
        {!compact && (
          <span
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-3)',
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}
          >
            Liquidity &amp; NFT Markets on Tari
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The hero field.
 *
 * A market-depth visualisation: a descending ladder of depth on one side, a
 * rising one on the other, and the priced spread between them. Pure geometry
 * over a soft gradient — no figure, no silhouette, no character reference.
 *
 * It is `aria-hidden` throughout: it is decoration behind text that already
 * states everything it depicts, so a screen reader gains nothing from it.
 */
export function DepthField({ className }: { className?: string }) {
  // Deterministic. A random or hand-tuned "organic" curve would render
  // differently on every machine and could not be reviewed in a diff.
  const leftDepth = [30, 24, 19, 15, 12, 10, 8, 7, 6, 5];
  const rightDepth = [5, 6, 7, 8, 10, 12, 15, 19, 24, 30];
  const h = 120;
  const w = 320;
  const maxBar = h * 0.62;

  return (
    <svg viewBox={`0 0 ${w} ${h + 34}`} className={className} role="presentation" aria-hidden="true" focusable="false" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="ss-depth-l" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="ss-depth-r" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="ss-mid" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--brand)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Depth ladders. */}
      {leftDepth.map((value, index) => {
        const barH = (value / 30) * maxBar;
        return <rect key={`l${index}`} x={index * 15} y={h - barH} width="9" height={barH} rx="1.5" fill="url(#ss-depth-l)" />;
      })}
      {rightDepth.map((value, index) => {
        const barH = (value / 30) * maxBar;
        return (
          <rect key={`r${index}`} x={w - index * 15 - 9} y={h - barH} width="9" height={barH} rx="1.5" fill="url(#ss-depth-r)" />
        );
      })}

      {/* The spread: the single price at which both sides meet. */}
      <line x1="0" y1={h + 6} x2={w} y2={h + 6} stroke="url(#ss-mid)" strokeWidth="1.5" />
      <circle cx={w / 2} cy={h + 6} r="3.5" fill="var(--brand)" />
      <text
        x={w / 2}
        y={h + 28}
        textAnchor="middle"
        fontSize="9"
        fill="var(--text-3)"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        priced spread
      </text>
    </svg>
  );
}

/**
 * A per-resource deterministic glyph.
 *
 * TOKENS ON THIS APP HAVE NO CANONICAL ICONS. There is no registry of token
 * artwork in the Ootle protocol, and inventing one would mean drawing a logo for
 * an asset the protocol knows nothing about.
 *
 * What this produces instead is a DETERMINISTIC ABSTRACT IDENTIFIER derived from
 * the resource address: the same resource always gets the same mark, different
 * resources almost always get different marks, and the mark makes no claim about
 * what the asset is. It is a fingerprint, not a logo — and it is honest about
 * that, which a fabricated token logo would not be.
 *
 * It is also what keeps the NFT placeholder from being mistaken for artwork: it
 * is unmistakably generated geometry, never a picture of something.
 */
export function ResourceGlyph({
  resourceAddress,
  size = 32,
  label,
}: {
  resourceAddress: string;
  size?: number;
  /** Short text drawn inside the ring, typically the ticker or the first hex pair. */
  label?: string;
}) {
  // FNV-1a over the address. Deterministic, fast, and has no dependency, so the
  // mark a user sees is byte-identical on every device and every rebuild — which
  // is what makes it usable as an identity rather than as decoration.
  let hash = 0x811c9dc5;
  for (let index = 0; index < resourceAddress.length; index += 1) {
    hash ^= resourceAddress.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  const rotation = (hash >> 9) % 360;
  const variant = hash % 4;
  const hue2 = (hue + 40 + (hash % 60)) % 360;
  const gid = `ss-rg-${hash.toString(36)}`;

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={label ?? 'Asset'} style={{ display: 'block', flex: 'none' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 62% 58%)`} />
          <stop offset="100%" stopColor={`hsl(${hue2} 58% 44%)`} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill={`hsl(${hue} 30% 12%)`} />
      <g transform={`rotate(${rotation} 20 20)`} fill="none" stroke={`url(#${gid})`} strokeLinecap="round">
        {variant === 0 && <path d="M8 24c4-10 6 2 10-6s6 8 14-2" strokeWidth="2.6" />}
        {variant === 1 && (
          <>
            <circle cx="20" cy="20" r="9" strokeWidth="2.4" />
            <path d="M20 5v6M20 29v6M5 20h6M29 20h6" strokeWidth="2.4" />
          </>
        )}
        {variant === 2 && <path d="M11 29V13l9 10 9-10v16" strokeWidth="2.6" />}
        {variant === 3 && (
          <>
            <path d="M9 27l11-18 11 18" strokeWidth="2.6" />
            <path d="M14 21h12" strokeWidth="2.4" />
          </>
        )}
      </g>
      <circle cx="20" cy="20" r="19" fill="none" stroke={`hsl(${hue} 40% 34%)`} strokeWidth="1.25" />
    </svg>
  );
}

/**
 * Middle-truncate to `budget` visible characters, ellipsis included.
 *
 * A resource address is distinguished by its TAIL, so a head-truncation that drops
 * the end would make two different collections render identically — and worse, it
 * renders as a typo rather than as a truncation. Keeping the last characters and
 * marking the cut with a single leading ellipsis makes both facts visible.
 */
function truncateMiddle(value: string, budget: number): string {
  if (value.length <= budget) return value;
  return `…${value.slice(-(budget - 1))}`;
}

/**
 * The empty-market placeholder for an NFT with no artwork.
 *
 * WHAT THIS IS NOT: it is not a mascot, a character, a silhouette, a stock
 * illustration, or generated art. Showing a picture here would be the single most
 * dishonest thing this app could do, because the user would read it as the item
 * they own. The Esmeralda collections are test assets; giving them a face would
 * assert an identity that does not exist.
 *
 * WHAT IT IS: a fingerprint. The item's REAL resource address and REAL item id,
 * rendered legibly, over generated geometry derived from that same address. It
 * answers "which item is this?" honestly, at a glance, with no fabrication.
 */
export function NftIdentityPlaceholder({
  nftId,
  collectionResource,
  label,
  size = '100%',
}: {
  nftId: string;
  collectionResource: string;
  label?: string;
  size?: number | string;
}) {
  let hash = 0x811c9dc5;
  for (const char of `${collectionResource}/${nftId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  const gid = `ss-nft-${hash.toString(36)}`;
  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label={`No artwork supplied for item ${nftId}`}
      style={{ width: size, height: size, display: 'block' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue} 48% 22%)`} />
          <stop offset="100%" stopColor={`hsl(${(hue + 50) % 360} 40% 12%)`} />
        </linearGradient>
        <pattern id={`${gid}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0v20" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="200" height="200" fill={`hsl(${hue} 30% 9%)`} />
      <rect width="200" height="200" fill={`url(#${gid}-grid)`} />
      <rect width="200" height="200" fill={`url(#${gid})`} />
      <g transform={`rotate(${(hash % 90) - 45} 100 100)`} fill="none" stroke={`hsl(${hue} 55% 62%)`} strokeWidth="1.5" opacity="0.5">
        <circle cx="100" cy="100" r="54" />
        <circle cx="100" cy="100" r="34" strokeDasharray="4 6" />
        <path d="M46 100h108M100 46v108" strokeDasharray="2 8" />
      </g>
      <text
        x="100"
        y="96"
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="15"
        fontWeight="600"
        fill="rgba(255,255,255,0.92)"
      >
        {nftId.length > 14 ? `${nftId.slice(0, 13)}…` : nftId}
      </text>
      <text x="100" y="118" textAnchor="middle" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="10" fill="rgba(255,255,255,0.55)">
        {truncateMiddle(collectionResource, 13)}
      </text>
      <text x="100" y="184" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="10" fill="rgba(255,255,255,0.4)">
        {label ?? 'no artwork supplied'}
      </text>
    </svg>
  );
}