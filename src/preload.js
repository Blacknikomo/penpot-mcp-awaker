'use strict';

// Runs in every frame (Penpot itself and the plugin iframes) before any page
// script. It installs a small agent in the page's main world that:
//   - pretends the page is always visible (no visibilitychange / freeze), so
//     neither Penpot nor the plugin pauses itself when the window is hidden;
//   - ticks once a second, so the main process can detect a frozen page;
//   - tracks WebSockets, so the main process can see whether the MCP plugin
//     is still connected.
// The main process reads it with `window.__awaker.status()`.

const { contextBridge, webFrame } = require('electron');

function agent() {
  if (window.__awaker) return;

  const startedAt = Date.now();
  let lastTick = startedAt;
  let maxGap = 0;
  const sockets = [];

  setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
  }, 1000);

  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: () => false });
  } catch (_) {}
  for (const type of ['visibilitychange', 'webkitvisibilitychange', 'freeze']) {
    window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
    document.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    class TrackedWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        const entry = { url: String(args[0]), ws: this, createdAt: Date.now(), openedAt: 0, closedAt: 0 };
        this.addEventListener('open', () => { entry.openedAt = Date.now(); });
        this.addEventListener('close', () => { entry.closedAt = Date.now(); });
        sockets.push(entry);
        if (sockets.length > 30) sockets.shift();
      }
    }
    window.WebSocket = TrackedWebSocket;
  }

  Object.defineProperty(window, '__awaker', {
    value: Object.freeze({
      status() {
        const gap = maxGap;
        maxGap = 0;
        return {
          href: location.href,
          origin: location.origin,
          now: Date.now(),
          startedAt,
          lastTick,
          maxGap: gap,
          sockets: sockets.map((s) => ({
            url: s.url,
            readyState: s.ws.readyState,
            createdAt: s.createdAt,
            openedAt: s.openedAt,
            closedAt: s.closedAt,
          })),
        };
      },
    }),
  });
}

try {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func: agent });
  } else {
    webFrame.executeJavaScript(`(${agent.toString()})()`);
  }
} catch (err) {
  console.error('[awaker] failed to install page agent', err);
}
