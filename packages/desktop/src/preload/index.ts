import { contextBridge, ipcRenderer } from 'electron';

/**
 * The preload exposes no Node or Electron APIs to the page. Its only jobs:
 * 1. forward the core MessagePort from main to the page (MessagePorts cannot
 *    cross contextBridge, so we use window.postMessage with a transfer list);
 * 2. expose a few static facts and narrowly-scoped desktop capabilities.
 */

ipcRenderer.on('nexus:core-port', (event) => {
  // '*' is safe: the target is this same window (navigation is blocked in main), and
  // file:// pages have an opaque origin that cannot be used as targetOrigin.
  window.postMessage({ type: 'nexus:core-port' }, '*', event.ports);
});

const THEME_SOURCES = new Set(['system', 'light', 'dark']);

contextBridge.exposeInMainWorld('nexusDesktop', {
  platform: process.platform,
  /** Native folder picker. Resolves with an absolute path, or null if cancelled. */
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('nexus:pick-directory');
  },
  setTheme(source: unknown) {
    if (typeof source === 'string' && THEME_SOURCES.has(source)) {
      void ipcRenderer.invoke('nexus:set-theme', source);
    }
  },
});
