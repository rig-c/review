import { LIVE_PATH } from '../src/live-lifecycle.ts';
import type { InstanceAccess } from './instance-access.ts';

const RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_ATTEMPTS = 20;

/**
 * Holds one persistent Server-Sent Events connection (`/api/live`) per open review or compare window (#236).
 * Does not use `pagehide` or `sendBeacon`: closing a tab or killing the browser (`SIGKILL`) closes the underlying
 * loopback TCP socket in the OS kernel immediately.
 */
export function connectLiveWindow(access: Pick<InstanceAccess, 'route'>): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const url = access.route(LIVE_PATH);
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let disposed = false;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const open = () => {
    if (disposed) return;
    clearReconnect();
    try {
      source?.close();
    } catch {}
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      attempts = 0;
    };
    es.onerror = () => {
      if (disposed) return;
      if (es.readyState === EventSource.CLOSED) {
        if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
        attempts += 1;
        clearReconnect();
        reconnectTimer = setTimeout(open, RECONNECT_DELAY_MS);
      }
    };
  };

  const onVisibilityChange = () => {
    if (disposed || document.visibilityState !== 'visible') return;
    if (!source || source.readyState === EventSource.CLOSED) {
      attempts = 0;
      open();
    }
  };

  const scheduleInitialOpen = () => {
    if (disposed) return;
    clearReconnect();
    reconnectTimer = setTimeout(open, 0);
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.readyState !== 'complete') {
    window.addEventListener('load', scheduleInitialOpen, { once: true });
  } else {
    scheduleInitialOpen();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    disposed = true;
    clearReconnect();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    try {
      source?.close();
    } catch {}
    source = null;
  };
}
