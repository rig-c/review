import { LIVE_PATH } from '../src/live-lifecycle.ts';
import type { InstanceAccess } from './instance-access.ts';

const RECONNECT_DELAY_MS = 200;
const MAX_RECONNECT_ATTEMPTS = 20;

function toWebSocketUrl(routePath: string): string {
  if (/^wss?:\/\//i.test(routePath)) return routePath;
  if (/^https?:\/\//i.test(routePath)) return routePath.replace(/^http/i, 'ws');
  const base = typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/';
  const resolved = new URL(routePath, base);
  resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:';
  return resolved.href;
}

/**
 * Holds one persistent WebSocket connection (`/api/live`) per open review or compare window (#236).
 * WebSockets sit outside the browser's six-connection HTTP/1.1 pool per origin (shared by all managed front
 * instances on `127.0.0.1:4318`) and report drops immediately via `onclose`/`onerror` so the window can
 * reconnect well inside the 3-second close grace period. Closing a tab or killing the browser (`SIGKILL`)
 * tears down the loopback TCP socket in the OS kernel immediately without `pagehide` or `sendBeacon`.
 */
export function connectLiveWindow(access: Pick<InstanceAccess, 'route'>): () => void {
  if (typeof WebSocket === 'undefined') return () => {};
  const wsUrl = toWebSocketUrl(access.route(LIVE_PATH));
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let disposed = false;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
    attempts += 1;
    reconnectTimer = setTimeout(open, RECONNECT_DELAY_MS);
  };

  const open = () => {
    if (disposed) return;
    clearReconnect();
    const prev = socket;
    socket = null;
    if (prev) {
      prev.onopen = null;
      prev.onclose = null;
      prev.onerror = null;
      try {
        prev.close();
      } catch {}
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    let disconnected = false;
    const onDisconnect = () => {
      if (disposed || disconnected || socket !== ws) return;
      disconnected = true;
      scheduleReconnect();
    };
    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      attempts = 0;
    };
    ws.onerror = onDisconnect;
    ws.onclose = onDisconnect;
  };

  const onVisibilityChange = () => {
    if (disposed || document.visibilityState !== 'visible') return;
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      attempts = 0;
      open();
    }
  };

  reconnectTimer = setTimeout(open, 0);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    disposed = true;
    clearReconnect();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    const prev = socket;
    socket = null;
    if (prev) {
      prev.onopen = null;
      prev.onclose = null;
      prev.onerror = null;
      try {
        prev.close();
      } catch {}
    }
  };
}
