'use strict';

const fs = require('fs');
const path = require('path');

// Defaults. Every key can be overridden by <userData>/config.json or by an
// environment variable (see ENV_MAP).
const DEFAULTS = {
  // Where Penpot lives. The last visited Penpot URL is restored on start-up.
  penpotUrl: 'https://design.penpot.app/',

  // Penpot MCP plugin (https://github.com/penpot/penpot-mcp).
  mcpPluginManifestUrl: 'http://localhost:4400/manifest.json',
  // WebSocket the plugin uses to talk to the MCP server. Sockets on this port
  // identify the MCP link; the port is also probed to see if the server is up.
  mcpWebSocketUrl: 'ws://localhost:4402',
  // Re-open the plugin automatically when it is gone after a reload.
  autoOpenPlugin: true,
  // Click "Connect to MCP server" in the plugin UI automatically.
  autoConnectPlugin: true,

  // How often the page is probed, and how long a probe may take.
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  // Consecutive failed probes before the page is reloaded.
  maxMissedHeartbeats: 3,
  // If the page's own 1s timer stalls for this long, the page was frozen.
  frozenThresholdMs: 45_000,
  // How long the MCP socket may stay down before recovery kicks in.
  mcpGraceMs: 20_000,
  // "unresponsive" renderer -> kill + reload after this long.
  unresponsiveTimeoutMs: 30_000,

  // Reload back-off (to avoid reload loops when e.g. the network is down).
  minReloadIntervalMs: 30_000,
  maxReloadBackoffMs: 10 * 60_000,

  // Keep the screen on too (not only the app). Off by default.
  preventDisplaySleep: false,
};

const ENV_MAP = {
  PENPOT_URL: 'penpotUrl',
  MCP_PLUGIN_MANIFEST_URL: 'mcpPluginManifestUrl',
  MCP_WEBSOCKET_URL: 'mcpWebSocketUrl',
  AUTO_OPEN_PLUGIN: 'autoOpenPlugin',
  AUTO_CONNECT_PLUGIN: 'autoConnectPlugin',
  PREVENT_DISPLAY_SLEEP: 'preventDisplaySleep',
};

function coerce(value, like) {
  if (typeof like === 'boolean') return /^(1|true|yes|on)$/i.test(String(value));
  if (typeof like === 'number') return Number(value);
  return value;
}

function loadConfig(userDataDir) {
  const config = { ...DEFAULTS };
  const file = path.join(userDataDir, 'config.json');
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[awaker] ignoring invalid ${file}:`, err.message);
  }
  for (const [env, key] of Object.entries(ENV_MAP)) {
    if (process.env[env] !== undefined) config[key] = coerce(process.env[env], DEFAULTS[key]);
  }
  config.configFile = file;
  return config;
}

module.exports = { loadConfig, DEFAULTS };
