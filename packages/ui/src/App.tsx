import type { RpcClient } from '@nexus/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CoreStore } from './model/coreStore';
import { type ThemePreference, useThemePreference } from './theme/themePreference';
import { Workspace } from './workspace/Workspace';

/** What the hosting shell (Electron today, a browser later) offers the UI. */
export type Platform = {
  /** Native translucent sidebar is available (macOS Electron). */
  vibrancy: boolean;
  /** Aligns native chrome with the in-app appearance choice. */
  setNativeTheme?: (preference: ThemePreference) => void;
  /** Native folder picker; absent in shells without one (users type the path). */
  pickDirectory?: () => Promise<string | null>;
};

export type AppProps = {
  /** Resolves once the core connection is ready. */
  connect: () => Promise<RpcClient>;
  platform: Platform;
};

export function App({ connect, platform }: AppProps) {
  const { preference, setPreference } = useThemePreference(platform.setNativeTheme);
  const [store] = useState(() => new CoreStore(connect));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    void store.start();
  }, [store]);

  useEffect(() => {
    if (platform.vibrancy) document.documentElement.setAttribute('data-vibrancy', '');
    return () => document.documentElement.removeAttribute('data-vibrancy');
  }, [platform.vibrancy]);

  return (
    <Workspace
      store={store}
      snapshot={snapshot}
      pickDirectory={platform.pickDirectory ?? null}
      theme={preference}
      onThemeChange={setPreference}
    />
  );
}
