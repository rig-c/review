/**
 * Live review window WebSocket connection tracking and idle/close server lifecycle (#236).
 *
 * Each open review or compare page holds one WebSocket (`GET /api/live`) connection open.
 * - Why WebSocket: all managed `open` instances share the front origin (`127.0.0.1:4318`). Browsers cap HTTP/1.1
 *   connections at six per host, so holding one HTTP stream per tab starves requests at six windows. WebSockets sit
 *   outside the six-connection HTTP/1.1 pool and notify `onclose` immediately on drop so the client can reconnect
 *   within a couple hundred milliseconds rather than waiting on browser stream retry timers.
 * - Reload vs. close: closing a tab or killing the browser (`SIGKILL`) tears down the TCP socket immediately without
 *   needing `pagehide` or `sendBeacon`. A reload tears down the old socket and immediately issues document/API requests
 *   followed by a new `/api/live` WebSocket well within `DEFAULT_CLOSE_GRACE_MS` (measured 40-slot + video reload p50
 *   127.3ms, max 148.9ms; dual 40-slot compare p50 83.6ms, max 106.0ms -> 3,000ms grace gives >20x headroom, and
 *   incoming requests during the grace window reset the zero-connection clock).
 * - Second tab: each tab holds its own `/api/live` WebSocket (`connections === 2`); closing one leaves `connections === 1`.
 * - Quiet socket & machine sleep / background tab freeze: `idleTimeout` is disabled (`0`) and periodic server keepalive
 *   frames keep quiet sockets open; liveness is bound to the kernel loopback TCP socket rather than client JS timer
 *   heartbeats, and wall-clock sleep jumps reset any pending countdown on wake.
 * - Unopened server: if no page ever connects within `DEFAULT_UNOPENED_TIMEOUT_MS` (30 minutes, 1,800,000ms), or after
 *   an `open` reuse re-arms a windowless worker, the server exits 0.
 * - In-flight work: an active HTTP request or producer Apply/rebuild delays exit until it finishes, then re-checks the
 *   live connection count before flushing state, stopping the listener, printing one reason line, and exiting 0.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun';

export const LIVE_PATH = '/api/live';

/**
 * Measured heavy-package full browser reload (40-slot + multi-PNG + 313 frames + video reference):
 * single review p50 127.34ms / max 148.90ms; dual 40-slot compare p50 83.60ms / max 106.01ms.
 * 3,000ms provides >20x headroom over the heaviest reload while closing promptly after the last window shuts.
 */
export const DEFAULT_CLOSE_GRACE_MS = 3_000;

/**
 * Time a server that has not received a `/api/live` page connection waits before exiting (30 minutes).
 * Preserves links handed from `rig-review open` or foreground servers to a human who opens them minutes later,
 * while reaping unopened servers before the 45-minute stale threshold.
 */
export const DEFAULT_UNOPENED_TIMEOUT_MS = 30 * 60 * 1_000;

/** Wall-clock jump beyond the check interval that indicates machine sleep / process pause. */
const SLEEP_JUMP_THRESHOLD_MS = 2_000;
const KEEPALIVE_INTERVAL_MS = 5_000;

export type LiveExitReason = 'last-window-closed' | 'unopened-timeout';

export interface LiveExitInfo {
  reason: LiveExitReason;
  line: string;
}

export interface LiveSocketData {
  key?: string;
  release?: () => void;
}

export interface UpgradableServer {
  upgrade(req: Request, options: { data: LiveSocketData; headers?: HeadersInit }): boolean;
}

export interface LiveLifecycleOptions {
  label?: string;
  graceMs?: number;
  unopenedTimeoutMs?: number;
  busy?: () => boolean;
  flush?: () => void | Promise<void>;
  stopServer?: () => void | Promise<void>;
  onClose?: (info: LiveExitInfo) => void | Promise<void>;
  exitOnClose?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export interface LiveLifecycle {
  upgrade(req: Request, srv: UpgradableServer, baseHeaders: Record<string, string>, key?: string): Response | undefined;
  readonly websocket: WebSocketHandler<LiveSocketData>;
  attachSocket(): { close(): void };
  dropSockets(): number;
  onRequestStart(pathname: string): void;
  onRequestEnd(pathname: string): void;
  rearmUnopened(): boolean;
  stop(): void;
  readonly connections: number;
  readonly everConnected: boolean;
  readonly exited: Promise<LiveExitInfo | null>;
}

function isIgnoredActivityPath(pathname: string): boolean {
  return pathname === LIVE_PATH;
}

export function formatExitLine(label: string, reason: LiveExitReason, graceMs: number, unopenedTimeoutMs: number): string {
  if (reason === 'last-window-closed') {
    return `${label}: exiting — last review window closed (0 live connections for ${graceMs}ms).`;
  }
  return `${label}: exiting — no review window connected within ${unopenedTimeoutMs}ms.`;
}

export function createLiveLifecycle(options: LiveLifecycleOptions = {}): LiveLifecycle {
  const label = options.label ?? 'review';
  const graceMs = Math.max(10, options.graceMs ?? DEFAULT_CLOSE_GRACE_MS);
  const unopenedTimeoutMs = Math.max(10, options.unopenedTimeoutMs ?? DEFAULT_UNOPENED_TIMEOUT_MS);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));

  let connections = 0;
  let everConnected = false;
  let inFlightRequests = 0;
  let startedAt = now();
  let zeroSince: number | null = null;
  let stopped = false;
  let closing = false;
  let waitingForInFlight = false;
  const activeSockets = new Set<ServerWebSocket<LiveSocketData>>();

  let resolveExited!: (info: LiveExitInfo | null) => void;
  const exited = new Promise<LiveExitInfo | null>(resolve => {
    resolveExited = resolve;
  });

  const checkIntervalMs = Math.min(50, Math.max(10, Math.floor(Math.min(graceMs, unopenedTimeoutMs) / 4)));
  let lastTickAt = now();

  function isBusy(): boolean {
    return inFlightRequests > 0 || Boolean(options.busy?.());
  }

  async function triggerExit(reason: LiveExitReason): Promise<void> {
    if (stopped || closing) return;
    closing = true;
    const line = formatExitLine(label, reason, graceMs, unopenedTimeoutMs);
    const info: LiveExitInfo = { reason, line };
    try {
      await options.flush?.();
    } catch { /* best-effort state flush */ }
    // Re-check connection count if a page connected or new work arrived while flushing.
    if (connections > 0 || isBusy()) {
      closing = false;
      if (connections > 0) zeroSince = null;
      return;
    }
    clearInterval(timer);
    clearInterval(keepaliveTimer);
    try {
      await options.onClose?.(info);
    } catch { /* best-effort close hook */ }
    try {
      await options.stopServer?.();
    } catch { /* best-effort server stop */ }
    stopped = true;
    log(line);
    resolveExited(info);
    if (options.exitOnClose) {
      process.exit(0);
    }
  }

  function check(): void {
    if (stopped || closing) return;
    if (connections > 0) {
      zeroSince = null;
      waitingForInFlight = false;
      return;
    }
    const current = now();
    let reason: LiveExitReason | null = null;
    if (everConnected) {
      if (zeroSince === null) zeroSince = current;
      if (current - zeroSince >= graceMs) reason = 'last-window-closed';
    } else {
      if (current - startedAt >= unopenedTimeoutMs) reason = 'unopened-timeout';
    }
    if (!reason) return;
    if (isBusy()) {
      waitingForInFlight = true;
      return;
    }
    if (waitingForInFlight) {
      waitingForInFlight = false;
      // Re-check connection count right after in-flight work completes.
      if (connections > 0) {
        zeroSince = null;
        return;
      }
    }
    void triggerExit(reason);
  }

  const timer = setInterval(() => {
    if (stopped || closing) return;
    const current = now();
    const delta = current - lastTickAt;
    lastTickAt = current;
    if (delta > checkIntervalMs + SLEEP_JUMP_THRESHOLD_MS) {
      if (zeroSince !== null) zeroSince = current;
      if (!everConnected) startedAt = current;
      return;
    }
    check();
  }, checkIntervalMs);
  timer.unref?.();

  const keepaliveTimer = setInterval(() => {
    if (stopped || closing || activeSockets.size === 0) return;
    for (const ws of [...activeSockets]) {
      try {
        ws.send('keepalive');
        ws.ping?.();
      } catch {
        ws.data?.release?.();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref?.();

  function attachSocket(): { close(): void } {
    connections += 1;
    everConnected = true;
    zeroSince = null;
    waitingForInFlight = false;
    let released = false;
    return {
      close() {
        if (released) return;
        released = true;
        connections = Math.max(0, connections - 1);
        if (connections === 0 && !stopped && !closing) {
          zeroSince = now();
          check();
        }
      },
    };
  }

  function upgrade(req: Request, srv: UpgradableServer, baseHeaders: Record<string, string>, key?: string): Response | undefined {
    if (stopped || closing) {
      return new Response('Server is closing', { status: 503, headers: baseHeaders });
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426, headers: baseHeaders });
    }
    const upgraded = srv.upgrade(req, {
      data: { key },
      headers: baseHeaders,
    });
    if (upgraded) return undefined;
    return new Response('WebSocket upgrade failed', { status: 400, headers: baseHeaders });
  }

  const websocket: WebSocketHandler<LiveSocketData> = {
    idleTimeout: 0,
    open(ws) {
      if (stopped || closing) {
        try { ws.close(); } catch {}
        return;
      }
      const handle = attachSocket();
      activeSockets.add(ws);
      ws.data = {
        ...ws.data,
        release: () => {
          activeSockets.delete(ws);
          handle.close();
        },
      };
      try {
        ws.send(ws.data.key ? JSON.stringify({ type: 'live', key: ws.data.key }) : 'live');
      } catch {
        ws.data.release?.();
      }
    },
    message() {},
    close(ws) {
      ws.data?.release?.();
    },
  };

  function dropSockets(): number {
    const list = [...activeSockets];
    for (const ws of list) {
      try {
        ws.close(1012, 'dropped');
      } catch {}
      ws.data?.release?.();
    }
    return list.length;
  }

  function onRequestStart(pathname: string): void {
    if (isIgnoredActivityPath(pathname)) return;
    inFlightRequests += 1;
    if (stopped || closing) return;
    const current = now();
    if (everConnected && connections === 0) {
      zeroSince = current;
    } else if (!everConnected) {
      startedAt = current;
    }
  }

  function onRequestEnd(pathname: string): void {
    if (isIgnoredActivityPath(pathname)) return;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
    if (inFlightRequests === 0 && !stopped && !closing) {
      check();
    }
  }

  function rearmUnopened(): boolean {
    if (stopped || closing) return false;
    const current = now();
    startedAt = current;
    waitingForInFlight = false;
    if (connections === 0) {
      everConnected = false;
      zeroSince = null;
    }
    return true;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    closing = false;
    clearInterval(timer);
    clearInterval(keepaliveTimer);
    for (const ws of [...activeSockets]) {
      try { ws.close(); } catch {}
    }
    activeSockets.clear();
    resolveExited(null);
  }

  return {
    upgrade,
    websocket,
    attachSocket,
    dropSockets,
    onRequestStart,
    onRequestEnd,
    rearmUnopened,
    stop,
    get connections() {
      return connections;
    },
    get everConnected() {
      return everConnected;
    },
    exited,
  };
}
