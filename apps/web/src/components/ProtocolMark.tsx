/**
 * Protocol mark.
 *
 * Two liquidity curves converging on a single priced point, above a market-depth
 * ladder. Inline SVG so there is no network fetch and no external asset to trust.
 * `aria-hidden` because the wordmark next to it already names the app.
 *
 * ABSTRACT BY CONSTRAINT, not by taste. There is no character, no animal, no
 * face, no silhouette, and nothing that could be read as one. The literal
 * reading — two sides of a pool meeting at one price — is also the only honest
 * visual claim this protocol can make about itself.
 */
export function ProtocolMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" style={{ flex: 'none', display: 'block' }}>
      <defs>
        <linearGradient id="pm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--teal)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--surface-2)" stroke="var(--line-2)" strokeWidth="1.25" />
      <path d="M6 20c4 0 4-9.5 8-9.5s4 9.5 8 9.5" stroke="url(#pm-g)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22" cy="20" r="2.8" fill="var(--brand)" />
      <g opacity="0.6">
        <rect x="6" y="24.5" width="4" height="1.8" rx="0.9" fill="var(--teal)" />
        <rect x="12" y="24.5" width="6" height="1.8" rx="0.9" fill="var(--teal)" />
        <rect x="20" y="24.5" width="6" height="1.8" rx="0.9" fill="var(--brand)" />
      </g>
    </svg>
  );
}
