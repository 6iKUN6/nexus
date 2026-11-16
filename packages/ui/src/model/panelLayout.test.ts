import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN,
  clampWidth,
  DETAIL_DEFAULT,
  DETAIL_RANGE,
  detailNeedsOverlay,
  PREVIEW_DEFAULT,
  PREVIEW_RANGE,
  panelMaxWidth,
} from './panelLayout';

describe('clampWidth', () => {
  it('clamps into the range and rejects nonsense', () => {
    expect(clampWidth(500, DETAIL_RANGE)).toBe(DETAIL_RANGE.max);
    expect(clampWidth(100, DETAIL_RANGE)).toBe(DETAIL_RANGE.min);
    expect(clampWidth(260.6, DETAIL_RANGE)).toBe(261);
    expect(clampWidth(Number.NaN, DETAIL_RANGE)).toBe(DETAIL_RANGE.min);
  });
});

describe('detailNeedsOverlay', () => {
  it('fits exactly at chat minimum plus open panel widths', () => {
    const fit = CHAT_MIN + DETAIL_DEFAULT + PREVIEW_DEFAULT;
    expect(detailNeedsOverlay(fit, DETAIL_DEFAULT, PREVIEW_DEFAULT, true)).toBe(false);
    expect(detailNeedsOverlay(fit - 1, DETAIL_DEFAULT, PREVIEW_DEFAULT, true)).toBe(true);
  });

  it('a closed preview frees its width', () => {
    const row = CHAT_MIN + DETAIL_DEFAULT;
    expect(detailNeedsOverlay(row, DETAIL_DEFAULT, PREVIEW_DEFAULT, false)).toBe(false);
    expect(detailNeedsOverlay(row - 1, DETAIL_DEFAULT, PREVIEW_DEFAULT, false)).toBe(true);
  });

  it('narrower user-resized panels lower the overlay threshold', () => {
    const row = CHAT_MIN + DETAIL_RANGE.min + PREVIEW_RANGE.min;
    expect(detailNeedsOverlay(row, DETAIL_RANGE.min, PREVIEW_RANGE.min, true)).toBe(false);
  });
});

describe('panelMaxWidth', () => {
  it('is the row minus what everyone else needs, capped by the range', () => {
    expect(panelMaxWidth(2000, CHAT_MIN + DETAIL_DEFAULT, PREVIEW_RANGE)).toBe(PREVIEW_RANGE.max);
    expect(panelMaxWidth(1000, CHAT_MIN + DETAIL_DEFAULT, PREVIEW_RANGE)).toBe(300);
  });

  it('never drops below the range minimum even when the row is tiny', () => {
    expect(panelMaxWidth(500, CHAT_MIN + DETAIL_DEFAULT, PREVIEW_RANGE)).toBe(PREVIEW_RANGE.min);
  });
});
