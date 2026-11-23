import { app, BrowserWindow, Menu, session, shell, type WebContents } from 'electron';
import path from 'node:path';
import { navigationVerdict, parseConfig, permissionAllowed, SECURE_WEB_PREFERENCES, type ShellConfig } from './policy';

/**
 * PUET.Pulse for Windows, macOS and Linux: a hardened Electron window around
 * the web client of one server. No Node in the page, OS sandbox, context
 * isolation, a navigation allowlist, and a permission handler that grants
 * only what calls and notifications need. Sessions stay in the server's
 * HttpOnly cookie; E2EE keys stay in the page's IndexedDB as in a browser.
 */

let cfg: ShellConfig;
try {
  cfg = parseConfig(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

// One instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();

app.enableSandbox();

function guard(contents: WebContents) {
  contents.on('will-navigate', (event, url) => {
    const v = navigationVerdict(url, cfg);
    if (v === 'allow') return;
    event.preventDefault();
    if (v === 'external') void shell.openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (navigationVerdict(url, cfg) !== 'allow') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Downloads and verification pages open in the system browser; nothing opens a second app window.
    if (navigationVerdict(url, cfg) !== 'deny') void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'PUET.Pulse',
    backgroundColor: '#163C56',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(__dirname, 'preload.js') },
  });
  guard(win.webContents);
  void win.loadURL(`${cfg.origin}/`);
  return win;
}

app.on('web-contents-created', (_e, contents) => guard(contents));

app.whenReady().then(() => {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((wc, permission, callback) => callback(permissionAllowed(permission, wc.getURL(), cfg)));
  s.setPermissionCheckHandler((_wc, permission, origin) => permissionAllowed(permission, origin, cfg));
  // The server's own headers (CSP, HSTS) apply; certificate errors are never overridden.
  app.on('certificate-error', (event, _wc, _url, _err, _cert, callback) => {
    event.preventDefault();
    callback(false);
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const win = createWindow();
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
