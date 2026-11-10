import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'nexus.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (theme === 'dark') document.body.setAttribute('arco-theme', 'dark');
  else document.body.removeAttribute('arco-theme');
}

/** Applies the stored preference before the first render to avoid a light flash. */
export function applyStoredThemeEarly(): void {
  const preference = readThemePreference();
  const dark = preference === 'dark' || (preference === 'system' && matchMedia(DARK_QUERY).matches);
  applyResolvedTheme(dark ? 'dark' : 'light');
}

function subscribeToSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const systemIsDark = () => window.matchMedia(DARK_QUERY).matches;

/**
 * Light / dark / follow-system preference, persisted locally.
 * `onNativeTheme` lets the desktop shell align native chrome (vibrancy,
 * traffic lights, context menus) with the in-app choice.
 */
export function useThemePreference(onNativeTheme?: (preference: ThemePreference) => void) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const systemDark = useSyncExternalStore(subscribeToSystem, systemIsDark);
  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => applyResolvedTheme(resolved), [resolved]);
  useEffect(() => onNativeTheme?.(preference), [onNativeTheme, preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode); the choice still applies for this session
    }
  }, []);

  return { preference, resolved, setPreference };
}
