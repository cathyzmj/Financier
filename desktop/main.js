// Financier — Electron main process.
//
// Runs the normal Express server in-process and points a window at it. Nothing about
// the app changes: same API, same UI, same SQLite file format. What changes is that
// there's no terminal, no npm, and no port to remember.
//
// Security posture: the server binds 127.0.0.1 on a random free port and no password is
// set, so the login screen is skipped — on a desktop app the OS account is the boundary,
// and the data never leaves the machine. (server.js refuses to bind anything wider than
// loopback without a password, so this can't silently become network-exposed.)

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const net = require('net');
const url = require('url');

const isDev = !app.isPackaged;
// Inside an asar the server is at app.asar/server-bundle; __dirname points there either way.
const SERVER_ENTRY = path.join(__dirname, 'server-bundle', 'server.mjs');
const SCHEMA_PATH = path.join(__dirname, 'server-bundle', 'schema.sql');
const WEB_DIR = path.join(__dirname, 'web-dist');

let mainWindow = null;
let serverHandle = null;

// Ask the OS for a free port rather than hardcoding 8000 — a packaged app shouldn't
// fight with a dev server (or a second copy of itself) for a well-known port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startBackend() {
  const port = await freePort();
  // The server reads all of these; they're the same knobs the CLI version uses.
  process.env.FINANCIER_PORT = String(port);
  process.env.FINANCIER_HOST = '127.0.0.1';
  process.env.FINANCIER_DB_PATH = path.join(app.getPath('userData'), 'tracker.db');
  process.env.FINANCIER_SCHEMA_PATH = SCHEMA_PATH;
  process.env.FINANCIER_WEB_DIR = WEB_DIR;
  delete process.env.FINANCIER_PASSWORD; // desktop app: no login screen

  // server.js is ESM; this file is CommonJS, so import() it dynamically.
  const mod = await import(url.pathToFileURL(SERVER_ENTRY).href);
  serverHandle = mod.startServer();
  return port;
}

function buildMenu(port) {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Financier',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Financier',
            message: `Financier ${app.getVersion()}`,
            detail: [
              'A local-first personal finance tracker.',
              '',
              `Your data: ${app.getPath('userData')}`,
              `Local server: http://127.0.0.1:${port}`,
              '',
              'Nothing is sent anywhere except the price, FX and broker',
              'lookups the app makes on your behalf.',
            ].join('\n'),
          }),
        },
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/cathyzmj/Financier'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#faf6ec', // the app's paper colour, so launch doesn't flash white
    title: 'Financier',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // Anything that isn't our own origin opens in the real browser, not in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(`http://127.0.0.1:${port}`)) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// One instance only — two copies would open two windows onto the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      const port = await startBackend();
      buildMenu(port);
      createWindow(port);
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
      });
    } catch (err) {
      dialog.showErrorBox('Financier could not start',
        `The local server failed to start.\n\n${err && err.stack ? err.stack : err}`);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverHandle && serverHandle.close) serverHandle.close();
});
