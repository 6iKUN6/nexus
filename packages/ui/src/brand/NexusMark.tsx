/**
 * The Nexus "Relay" mark: two rounded strokes forming an N, with the gap in
 * between standing for a task handoff. Paths are copied verbatim from
 * assets/logos/nexus-mark.svg (the source of truth); keep them in sync.
 *
 * Color comes from `currentColor` (or `accent` for the second stroke), so the
 * mark follows light/dark themes through text-color tokens.
 */
export function NexusMark({
  size = 20,
  accent,
  title,
  className,
}: {
  size?: number;
  /** CSS color for the right stroke; defaults to currentColor (single-color mark). */
  accent?: string;
  /** Accessible name; omit when the mark sits next to visible "Nexus" text. */
  title?: string;
  className?: string;
}) {
  // Decorative by default (sits next to the visible word "Nexus"); pass `title` to make it an image.
  const a11y = title ? { role: 'img' as const } : { 'aria-hidden': true as const };
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative unless `title` is passed, then <title> is rendered
    <svg width={size} height={size} viewBox="40 40 176 176" className={className} {...a11y}>
      {title && <title>{title}</title>}
      <g fill="none" strokeWidth={30} strokeLinecap="round" strokeLinejoin="round">
        <path stroke="currentColor" d="M64 192V64L112 112" />
        <path stroke={accent ?? 'currentColor'} d="M144 144L192 192V64" />
      </g>
    </svg>
  );
}

/** App-icon style tile (mint rounded square), for empty states and About. */
export function NexusAppIcon({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center bg-brand-mint text-brand-ink ${className ?? ''}`}
      style={{ width: size, height: size, borderRadius: size * 0.225 }}
    >
      {/* 0.535 reproduces the mark-to-tile ratio of assets/logos/nexus-app-icon.svg */}
      <NexusMark size={size * 0.535} />
    </span>
  );
}
