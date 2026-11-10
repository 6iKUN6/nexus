import '@nexus/ui/setup';

import { App, type Platform, type ThemePreference } from '@nexus/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connectToCore } from './coreConnection';

declare global {
  interface Window {
    nexusDesktop: {
      platform: string;
      setTheme(source: ThemePreference): void;
      pickDirectory(): Promise<string | null>;
    };
  }
}

const platform: Platform = {
  vibrancy: new URLSearchParams(window.location.search).get('vibrancy') === '1',
  setNativeTheme: (preference) => window.nexusDesktop.setTheme(preference),
  pickDirectory: () => window.nexusDesktop.pickDirectory(),
};

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App connect={connectToCore} platform={platform} />
  </StrictMode>,
);
