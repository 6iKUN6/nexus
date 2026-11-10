import { useCallback, useEffect, useState } from 'react';

/**
 * Per-window view state that should survive a restart (plan M1 exit criteria):
 * open tabs, active tab, drafts and how far each conversation has been read.
 * Kept in localStorage for now; moves to core's ui_state table later.
 */
export type UiState = {
  openIds: string[];
  activeId: string | null;
  drafts: Record<string, string>;
  /** Highest event seq the user has seen per conversation (for unread). */
  seen: Record<string, number>;
  detailOpen: boolean;
};

const KEY = 'nexus.ui.v1';
const EMPTY: UiState = { openIds: [], activeId: null, drafts: {}, seen: {}, detailOpen: true };

function load(): UiState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<UiState>;
    return {
      openIds: Array.isArray(parsed.openIds)
        ? parsed.openIds.filter((x) => typeof x === 'string')
        : [],
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      detailOpen: parsed.detailOpen !== false,
    };
  } catch {
    return EMPTY;
  }
}

export function useUiState() {
  const [state, setState] = useState<UiState>(load);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        // storage full or unavailable; state still works for this session
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [state]);

  const update = useCallback((change: (s: UiState) => UiState) => setState(change), []);
  return [state, update] as const;
}
