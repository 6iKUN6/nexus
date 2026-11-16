/**
 * Width budget for the workspace's three columns (chat / detail / preview).
 * Pure functions so the drag handles, the overlay fallback and persistence
 * validation all clamp the same way.
 */

/** Below this the chat column stops being readable; panels must yield. */
export const CHAT_MIN = 440;
export const DETAIL_DEFAULT = 260;
export const DETAIL_RANGE = { min: 200, max: 420 } as const;
export const PREVIEW_DEFAULT = 400;
export const PREVIEW_RANGE = { min: 300, max: 760 } as const;
/** Detail panel width when it degrades to a slide-over (not draggable). */
export const DETAIL_OVERLAY_WIDTH = 320;

export function clampWidth(width: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(width)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(width)));
}

/**
 * The detail inspector stays an inline third column only while the chat
 * column keeps its readable width; otherwise it degrades to a slide-over.
 */
export function detailNeedsOverlay(
  rowWidth: number,
  detailWidth: number,
  previewWidth: number,
  previewOpen: boolean,
): boolean {
  return rowWidth < CHAT_MIN + detailWidth + (previewOpen ? previewWidth : 0);
}

/**
 * Largest width a panel may take right now: the row minus the space everyone
 * else needs. When even the range minimum doesn't fit, the minimum is
 * returned and the overlay fallback takes over instead of overflowing.
 */
export function panelMaxWidth(
  rowWidth: number,
  reserved: number,
  range: { min: number; max: number },
): number {
  return Math.max(range.min, Math.min(range.max, rowWidth - reserved));
}
