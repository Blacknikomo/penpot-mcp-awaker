# Penpot MCP Awaker

Electron shell around [penpot.app](https://design.penpot.app) whose job is simple: keep a Penpot
workspace and the [Penpot MCP plugin](https://github.com/penpot/penpot-mcp) alive long enough to
be reliably used by an MCP client.

## The pain we wanted to solve

Using Penpot through the browser worked until it sat in the background for a while.

- Penpot or the plugin iframe could be throttled once the window was hidden or occluded.
- The MCP plugin connection could silently drop while the Penpot page still looked "open".
- After the machine slept or the renderer stalled, the MCP tool would appear dead until you
  manually refreshed Penpot, reopened the plugin, and clicked **Connect** again.

That was fine for casual browsing, but painful for an MCP workflow where the tool is expected to
stay available in the background and recover on its own.

## How we approached it

The app combines three ideas:

### 1. Keep Electron and Chromium from treating the app as backgrounded

- `powerSaveBlocker('prevent-app-suspension')` prevents idle sleep of the app process.
- Optional `prevent-display-sleep` can keep the display awake too.
- Chromium background throttling and renderer backgrounding are disabled.
- The BrowserWindow also has `backgroundThrottling: false`.

This reduces the chance that timers, rendering, or plugin activity get deprioritized just because
the window is not frontmost.

### 2. Make the page and plugin think they are always visible

A preload runs in the main frame and plugin iframes before page code:

- overrides `document.hidden` and `visibilityState`,
- blocks `visibilitychange` and `freeze` events,
- installs a small agent that tracks timer gaps and open WebSockets.

That means Penpot and the MCP plugin do not observe the normal "hidden tab" lifecycle and are much
less likely to pause themselves.

### 3. Watch health continuously and recover automatically

The main process periodically probes the page agent and MCP-related frames:

- if the renderer crashes, hangs, or stops heartbeating, the page is reloaded;
- if the page was frozen for too long, it is reloaded;
- if the MCP WebSocket is down but the local MCP server is reachable, the app tries to recover by
  reopening the plugin and clicking **Connect** automatically;
- if recovery keeps failing, it reloads with exponential backoff instead of thrashing.

The result is not just "stay awake", but "notice failure quickly and self-heal".

## What the app does in practice

- opens Penpot in a dedicated persistent Electron session;
- remembers the last Penpot URL you visited;
- shows MCP connection state in the window title;
- provides an **Awaker** menu with status, manual reload, plugin open/connect actions, and config
  and log shortcuts.

## Development

```sh path=null start=null
npm install
npm start
```

Run a syntax check:

```sh path=null start=null
npm run check
```

## Build a standalone app

```sh path=null start=null
npm run dist
```

Build artifacts are written to `dist/` and are intentionally not tracked by git.

## Configuration

Create `config.json` in the app user-data folder:

- macOS: `~/Library/Application Support/penpot-electron-awaker/config.json`

You can also open that folder from **Awaker → Open Config Folder**.

Example:

```json path=null start=null
{
  "penpotUrl": "https://design.penpot.app/",
  "mcpPluginManifestUrl": "http://localhost:4400/manifest.json",
  "mcpWebSocketUrl": "ws://localhost:4402",
  "autoOpenPlugin": true,
  "autoConnectPlugin": true,
  "preventDisplaySleep": false
}
```

Defaults and timing parameters live in `src/config.js`. Environment overrides are also supported:
`PENPOT_URL`, `MCP_PLUGIN_MANIFEST_URL`, `MCP_WEBSOCKET_URL`, `AUTO_OPEN_PLUGIN`,
`AUTO_CONNECT_PLUGIN`, and `PREVENT_DISPLAY_SLEEP`.

## Recovery rules

- renderer crash or unresponsive renderer → reload;
- repeated missed heartbeats → reload;
- long timer gap indicating a frozen page → reload;
- stuck page load → reload;
- disconnected MCP plugin with reachable MCP server → reopen and reconnect plugin;
- repeated failed MCP recovery → reload with backoff.

## Caveats

- Auto-reopen uses Penpot's internal plugin loading API and assumes the plugin UI still exposes a
  connect button the app can find.
- Idle sleep can be prevented, but closing the laptop lid will still sleep the machine.
- If the MCP server itself is not running, the app waits instead of endlessly reloading the page.
