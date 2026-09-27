/**
 * Protocol mark.
 *
 * A restrained geometric glyph — two interlocking pool sides — rather than a
 * mascot. Inline SVG so there is no network fetch and no external asset to
 * trust. `aria-hidden` because the wordmark next to it already names the app.
 */
export function ProtocolMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" stroke="var(--line-strong)" strokeWidth="1.5" />
      <path d="M6 15.5c2.2 0 2.2-7 4.4-7s2.2 7 4.4 7 2.2-4 3.2-4" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="6" cy="15.5" r="1.6" fill="var(--accent)" />
      <circle cx="18" cy="11.5" r="1.6" fill="var(--text-2)" />
    </svg>
  );
}
