import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  shell,
  type UtilityProcess,
  utilityProcess,
} from 'electron';

/**
 * Main process: windows and OS integration only. All product logic lives in
 * the core, which runs in a utility process and talks to each renderer over
 * a dedicated MessagePort (JSON-RPC). Main never relays RPC traffic.
 */

// One name everywhere, so dev and packaged builds share ~/Library/Application Support/Nexus.
app.setName('Nexus');
// NEXUS_USER_DATA_DIR isolates all state (SQLite, localStorage) — used by automated UI checks.
if (process.env.NEXUS_USER_DATA_DIR) app.setPath('userData', process.env.NEXUS_USER_DATA_DIR);

let core: UtilityProcess | null = null;
let quitting = false;

function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'core.js'), [], {
    serviceName: 'Nexus Core',
    stdio: 'inherit',
    env: {
      ...process.env,
      NEXUS_VERSION: app.getVersion(),
      NEXUS_DATA_DIR: app.getPath('userData'),
    },
  });
  child.on('exit', (code) => {
    if (core === child) core = null;
    if (!quitting) {
      console.error(`[main] core exited unexpectedly (code ${code}); restarting`);
      core = startCore();
      // Reloading re-runs did-finish-load, which hands each page a fresh port.
      // (M1: replace with in-place reconnection + event replay from the last seq.)
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
    }
  });
  return child;
}

function connectWindowToCore(win: BrowserWindow): void {
  if (!core) core = startCore();
  const { port1, port2 } = new MessageChannelMain();
  core.postMessage({ type: 'nexus:connect' }, [port1]);
  win.webContents.postMessage('nexus:core-port', null, [port2]);
}

// NEXUS_VIBRANCY=0 turns the translucent sidebar off (e.g. for CDP screenshots, which cannot capture it).
const useVibrancy = process.platform === 'darwin' && process.env.NEXUS_VIBRANCY !== '0';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Nexus',
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 15 },
    // macOS: translucent sidebar. The renderer keeps its content area opaque.
    ...(useVibrancy
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const }
      : {}),
    backgroundColor: useVibrancy ? '#00000000' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  // A fresh port on every load, including reloads during development.
  win.webContents.on('did-finish-load', () => connectWindowToCore(win));

  // The window may only show the app itself (reloads, dev-server HMR reloads);
  // any other navigation is blocked. External links open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const query = { vibrancy: useVibrancy ? '1' : '0' };
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(`${devServerUrl}?${new URLSearchParams(query)}`);
  } else {
    void win.loadFile(RENDERER_FILE, { query });
  }
  return win;
}

const THEME_SOURCES = new Set<typeof nativeTheme.themeSource>(['system', 'light', 'dark']);

const RENDERER_FILE = join(__dirname, '../renderer/index.html');

/** True for URLs that point at our own renderer (packaged file or dev server). */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    return parsed.origin === new URL(devServerUrl).origin;
  }
  return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname) === RENDERER_FILE;
}

/** Only our own app pages may call privileged IPC. */
function isTrustedSender(frameUrl: string | undefined): boolean {
  return isAppUrl(frameUrl);
}

ipcMain.handle('nexus:pick-directory', async (event) => {
  if (!isTrustedSender(event.senderFrame?.url)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: '选择工作目录',
    buttonLabel: '选择',
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('nexus:set-theme', (event, source: unknown) => {
  if (!isTrustedSender(event.senderFrame?.url)) return;
  if (typeof source !== 'string' || !THEME_SOURCES.has(source as typeof nativeTheme.themeSource)) {
    return;
  }
  nativeTheme.themeSource = source as typeof nativeTheme.themeSource;
});

app.whenReady().then(() => {
  // Packaged builds get the icon from the bundle (build/icon.icns). In dev the
  // Dock would show Electron's default icon, so set ours explicitly.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(join(__dirname, '../../build/icon.png'));
  }
  core = startCore();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !core) return;
  // Let core stop harness sessions (and their process trees) before exiting.
  // TODO(M1 polish): ask the user first when runs are active (plan §10.5).
  event.preventDefault();
  quitting = true;
  const child = core;
  const timer = setTimeout(() => child.kill(), 3_000);
  child.once('exit', () => {
    clearTimeout(timer);
    app.quit();
  });
  child.postMessage({ type: 'nexus:shutdown' });
});
