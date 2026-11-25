'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  app, BrowserWindow, Menu, dialog, powerMonitor, powerSaveBlocker, session, shell,
} = require('electron');
const { loadConfig } = require('./config');

// Keep data (login session, config, log) in the same folder whether running
// from source or as the packaged "Penpot Awaker.app".
app.setPath('userData', path.join(app.getPath('appData'), 'penpot-electron-awaker'));

// --- Chromium switches: never throttle or freeze a hidden/occluded window ----
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', [
  'CalculateNativeWinOcclusion',
  'IntensiveWakeUpThrottling',
  'BackForwardCache',
].join(','));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const config = loadConfig(app.getPath('userData'));
const penpotOrigin = new URL(config.penpotUrl).origin;
const pluginOrigin = new URL(config.mcpPluginManifestUrl).origin;
const mcpSocket = new URL(config.mcpWebSocketUrl);
const stateFile = path.join(app.getPath('userData'), 'state.json');
const logFile = path.join(app.getPath('userData'), 'awaker.log');

/** @type {BrowserWindow | null} */
let win = null;
let pageTitle = 'Penpot';

const state = {
  autoRecoverMcp: config.autoOpenPlugin || config.autoConnectPlugin,
  missedHeartbeats: 0,
  checking: false,
  loadStartedAt: 0,
  ignoreGapUntil: 0,
  lastReloadAt: 0,
  reloadBackoffMs: config.minReloadIntervalMs,
  pendingReload: null,
  unresponsiveTimer: null,
  lastStatus: null,
  mcp: {
    connected: false,
    pluginOpen: false,
    everConnected: false,
    downSince: 0,
    lastActionAt: 0,
    failedActions: 0,
    serverUp: null,
  },
};

// --- logging ------------------------------------------------------------------

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile, 0);
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {}
}

// --- persisted state (last visited URL) --------------------------------------

function readSavedUrl() {
  try {
    const { lastUrl } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (lastUrl && new URL(lastUrl).origin === penpotOrigin) return lastUrl;
  } catch (_) {}
  return config.penpotUrl;
}

let saveTimer = null;
function rememberUrl(url) {
  try {
    if (new URL(url).origin !== penpotOrigin) return;
  } catch (_) {
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ lastUrl: url }, null, 2));
    } catch (err) {
      log('could not save state:', err.message);
    }
  }, 1000);
}

// --- helpers --------------------------------------------------------------------

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function isOnWorkspace(href) {
  return typeof href === 'string' && href.startsWith(penpotOrigin) && href.includes('workspace');
}

function isMcpSocket(url) {
  try {
    const u = new URL(url);
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/;
    const sameHost = u.hostname === mcpSocket.hostname
      || (loopback.test(u.hostname) && loopback.test(mcpSocket.hostname));
    return sameHost && u.port === mcpSocket.port;
  } catch (_) {
    return false;
  }
}

function isMcpServerUp() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: mcpSocket.hostname, port: Number(mcpSocket.port) || 80 });
    const done = (up) => { socket.destroy(); resolve(up); };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function probe(frame) {
  try {
    return await withTimeout(
      frame.executeJavaScript('window.__awaker ? window.__awaker.status() : null'),
      config.heartbeatTimeoutMs,
    );
  } catch (_) {
    return undefined; // frame gone or navigating
  }
}

function pluginFrames() {
  if (!win) return [];
  const main = win.webContents.mainFrame;
  return main.framesInSubtree.filter((f) => f !== main && !f.detached && f.origin === pluginOrigin);
}

// --- reload with back-off -----------------------------------------------------

function reloadPage(reason, { kill = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  const earliest = state.lastReloadAt + state.reloadBackoffMs;
  if (now < earliest) {
    if (!state.pendingReload) {
      log(`reload requested (${reason}); waiting ${Math.round((earliest - now) / 1000)}s (back-off)`);
      state.pendingReload = setTimeout(() => {
        state.pendingReload = null;
        reloadPage(reason, { kill });
      }, earliest - now);
    }
    return;
  }

  clearTimeout(state.pendingReload);
  state.pendingReload = null;
  state.lastReloadAt = now;
  state.reloadBackoffMs = Math.min(state.reloadBackoffMs * 2, config.maxReloadBackoffMs);
  state.missedHeartbeats = 0;
  state.mcp.failedActions = 0;
  state.mcp.downSince = 0;
  log(`RELOAD: ${reason}`);

  const wc = win.webContents;
  if (kill) {
    try { wc.forcefullyCrashRenderer(); } catch (_) {}
  }
  const url = wc.getURL() || readSavedUrl();
  if (kill || !url.startsWith(penpotOrigin)) wc.loadURL(url.startsWith(penpotOrigin) ? url : readSavedUrl());
  else wc.reload();
}

// --- MCP plugin recovery --------------------------------------------------------

async function openPlugin() {
  const code = `(() => {
    const load = globalThis['ɵloadPluginByUrl'];
    if (typeof load !== 'function') return 'no-plugin-api';
    load(${JSON.stringify(config.mcpPluginManifestUrl)});
    return 'ok';
  })()`;
  try {
    return await withTimeout(win.webContents.mainFrame.executeJavaScript(code, true), 5000);
  } catch (err) {
    return `error: ${err.message}`;
  }
}

async function clickConnect(frame) {
  const code = `(() => {
    const label = (el) => (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
    const candidates = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')];
    const btn = candidates.find((el) => !el.disabled && /connect/i.test(label(el)) && !/disconnect/i.test(label(el)));
    if (!btn) return 'no-connect-button';
    btn.click();
    return 'clicked "' + label(btn) + '"';
  })()`;
  try {
    return await withTimeout(frame.executeJavaScript(code, true), 5000);
  } catch (err) {
    return `error: ${err.message}`;
  }
}

async function superviseMcp(mainStatus, pluginStatuses) {
  const mcp = state.mcp;
  const sockets = [mainStatus, ...pluginStatuses].flatMap((s) => (s ? s.sockets : []));
  const connected = sockets.some((s) => isMcpSocket(s.url) && s.readyState === 1);
  mcp.pluginOpen = pluginStatuses.length > 0;

  if (connected !== mcp.connected) log(`MCP plugin ${connected ? 'connected' : 'disconnected'}`);
  mcp.connected = connected;

  const now = Date.now();
  if (connected) {
    mcp.everConnected = true;
    mcp.downSince = 0;
    mcp.failedActions = 0;
    return;
  }
  if (!state.autoRecoverMcp || !isOnWorkspace(mainStatus.href)) {
    mcp.downSince = 0;
    return;
  }
  if (!mcp.downSince) mcp.downSince = now;
  if (now - mcp.downSince < config.mcpGraceMs) return;
  if (now - mcp.lastActionAt < 2 * config.heartbeatIntervalMs) return;

  const serverUp = await isMcpServerUp();
  if (serverUp !== mcp.serverUp) {
    log(`MCP server at ${mcpSocket.host} is ${serverUp ? 'up' : 'down'}`);
    mcp.serverUp = serverUp;
  }
  if (!serverUp) return; // nothing to connect to; don't churn the page

  mcp.lastActionAt = now;
  if (mcp.failedActions >= 6) {
    reloadPage('MCP plugin could not reconnect');
    return;
  }
  mcp.failedActions += 1;

  const frames = pluginFrames();
  if (frames.length === 0) {
    if (config.autoOpenPlugin) log(`opening MCP plugin: ${await openPlugin()}`);
    else mcp.failedActions = 0;
  } else if (config.autoConnectPlugin) {
    for (const frame of frames) log(`MCP plugin connect: ${await clickConnect(frame)}`);
  } else {
    reloadPage('MCP plugin disconnected');
  }
}

// --- heartbeat ------------------------------------------------------------------

async function heartbeat() {
  if (!win || win.isDestroyed() || state.checking) return;
  const wc = win.webContents;
  if (wc.isCrashed()) {
    reloadPage('renderer crashed', { kill: true });
    return;
  }
  if (wc.isLoading()) {
    if (state.loadStartedAt && Date.now() - state.loadStartedAt > 120_000) reloadPage('page stuck loading');
    return;
  }

  state.checking = true;
  try {
    const status = await probe(wc.mainFrame);
    if (!status) {
      state.missedHeartbeats += 1;
      log(`heartbeat missed (${state.missedHeartbeats}/${config.maxMissedHeartbeats})`);
      if (state.missedHeartbeats >= config.maxMissedHeartbeats) reloadPage('page not responding', { kill: true });
      return;
    }
    state.missedHeartbeats = 0;
    state.lastStatus = status;

    if (status.maxGap > config.frozenThresholdMs && Date.now() > state.ignoreGapUntil) {
      reloadPage(`page was frozen for ${Math.round(status.maxGap / 1000)}s`);
      return;
    }
    if (Date.now() - state.lastReloadAt > 5 * 60_000) state.reloadBackoffMs = config.minReloadIntervalMs;

    const pluginStatuses = (await Promise.all(pluginFrames().map(probe))).filter(Boolean);
    await superviseMcp(status, pluginStatuses);
  } finally {
    state.checking = false;
    updateTitle();
  }
}

// --- window -------------------------------------------------------------------

function updateTitle() {
  if (!win || win.isDestroyed()) return;
  let mcp = '';
  if (state.mcp.connected) mcp = ' — MCP ● connected';
  else if (state.mcp.pluginOpen || state.mcp.everConnected) mcp = ' — MCP ○ disconnected';
  win.setTitle(`${pageTitle}${mcp}`);
}

function isTrustedOrigin(url) {
  try {
    const { origin } = new URL(url);
    return origin === penpotOrigin || origin === pluginOrigin;
  } catch (_) {
    return false;
  }
}

function createWindow() {
  const ses = session.fromPartition('persist:penpot');
  ses.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    callback(isTrustedOrigin(details.requestingUrl || ''));
  });
  ses.setPermissionCheckHandler((_wc, _permission, requestingOrigin) => isTrustedOrigin(requestingOrigin));

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: pageTitle,
    backgroundColor: '#18181a',
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // run the preload in plugin iframes too
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);

  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(penpotOrigin)) wc.loadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    pageTitle = title || 'Penpot';
    updateTitle();
  });

  wc.on('did-start-loading', () => { state.loadStartedAt = Date.now(); });
  wc.on('did-stop-loading', () => { state.loadStartedAt = 0; });
  wc.on('did-navigate', (_e, url) => rememberUrl(url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) rememberUrl(url); });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (e.g. replaced by another navigation)
    log(`load failed: ${code} ${description} (${url})`);
    reloadPage(`load failed: ${description}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    log(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason !== 'clean-exit') setTimeout(() => reloadPage(`renderer ${details.reason}`), 1000);
  });
  wc.on('unresponsive', () => {
    log('renderer unresponsive');
    clearTimeout(state.unresponsiveTimer);
    state.unresponsiveTimer = setTimeout(() => reloadPage('renderer unresponsive', { kill: true }), config.unresponsiveTimeoutMs);
  });
  wc.on('responsive', () => {
    log('renderer responsive again');
    clearTimeout(state.unresponsiveTimer);
  });

  win.on('closed', () => { win = null; });
  wc.loadURL(readSavedUrl());
}

function showStatus() {
  const s = state.lastStatus;
  const lines = [
    `Page: ${s ? s.href : 'n/a'}`,
    `Last heartbeat: ${s ? new Date(s.now).toLocaleTimeString() : 'n/a'}`,
    `Missed heartbeats: ${state.missedHeartbeats}`,
    `Last reload: ${state.lastReloadAt ? new Date(state.lastReloadAt).toLocaleString() : 'never'}`,
    '',
    `MCP plugin open: ${state.mcp.pluginOpen}`,
    `MCP connected: ${state.mcp.connected}`,
    `MCP server reachable: ${state.mcp.serverUp === null ? 'not checked yet' : state.mcp.serverUp}`,
    `Auto-recover MCP: ${state.autoRecoverMcp}`,
    '',
    `Config: ${config.configFile}`,
    `Log: ${logFile}`,
  ];
  dialog.showMessageBox(win, { type: 'info', message: 'Penpot Awaker status', detail: lines.join('\n') });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Awaker',
      submenu: [
        { label: 'Status…', click: showStatus },
        { type: 'separator' },
        {
          label: 'Reload Penpot Now',
          click: () => { state.lastReloadAt = 0; reloadPage('manual'); },
        },
        { label: 'Open MCP Plugin', click: async () => log(`opening MCP plugin: ${await openPlugin()}`) },
        {
          label: 'Connect MCP Plugin',
          click: async () => { for (const f of pluginFrames()) log(`MCP plugin connect: ${await clickConnect(f)}`); },
        },
        {
          label: 'Auto-recover MCP Plugin',
          type: 'checkbox',
          checked: state.autoRecoverMcp,
          click: (item) => { state.autoRecoverMcp = item.checked; log(`auto-recover MCP: ${item.checked}`); },
        },
        { type: 'separator' },
        { label: 'Open Log File', click: () => shell.openPath(logFile) },
        { label: 'Open Config Folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- app lifecycle ------------------------------------------------------------

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  // Some sign-in providers reject UAs that advertise Electron.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s*Electron\/\S+/, '')
    .replace(new RegExp(`\\s*${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '');

  powerSaveBlocker.start('prevent-app-suspension');
  if (config.preventDisplaySleep) powerSaveBlocker.start('prevent-display-sleep');

  powerMonitor.on('suspend', () => log('system suspending'));
  powerMonitor.on('resume', () => {
    log('system resumed');
    // Timers did not run while the machine slept; that's not a page freeze.
    state.ignoreGapUntil = Date.now() + 3 * config.heartbeatIntervalMs;
    state.mcp.downSince = 0;
    setTimeout(heartbeat, 5000);
  });
  powerMonitor.on('unlock-screen', () => setTimeout(heartbeat, 2000));

  buildMenu();
  createWindow();
  setInterval(heartbeat, config.heartbeatIntervalMs);
  log(`started; penpot=${config.penpotUrl} plugin=${config.mcpPluginManifestUrl} ws=${config.mcpWebSocketUrl}`);
});

app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => app.quit());
