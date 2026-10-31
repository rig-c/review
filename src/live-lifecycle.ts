/**
 * Live review window connection tracking and idle/close server lifecycle (#236).
 *
 * Each open review or compare page holds one Server-Sent Events (`GET /api/live`) stream open.
 * - Reload vs. close: closing a tab or killing the browser (`SIGKILL`) tears down the TCP socket immediately without
 *   needing `pagehide` or `sendBeacon`. A reload tears down the old stream and immediately issues document/API requests
 *   followed by a new `/api/live` stream well within `DEFAULT_CLOSE_GRACE_MS` (measured 40-slot + video reload p50
 *   127.3ms, max 148.9ms; dual 40-slot compare p50 83.6ms, max 106.0ms -> 3,000ms grace gives >20x headroom, and
 *   incoming requests during the grace window reset the zero-connection clock).
 * - Second tab: each tab holds its own `/api/live` stream (`connections === 2`); closing one leaves `connections === 1`.
 * - Machine sleep / background tab freeze: liveness is bound to the kernel loopback TCP socket rather than client JS
 *   timer heartbeats, and wall-clock sleep jumps reset any pending countdown on wake.
 * - Unopened server: if no page ever connects within `DEFAULT_UNOPENED_TIMEOUT_MS` (30 minutes, 1,800,000ms), or after
 *   an `open` reuse re-arms a windowless worker, the server exits 0.
 * - In-flight work: an active HTTP request or producer Apply/rebuild delays exit until it finishes, then re-checks the
 *   live connection count before flushing state, stopping the listener, printing one reason line, and exiting 0.
 */

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
  connect(req: Request, baseHeaders: Record<string, string>): Response;
  onRequestStart(pathname: string): void;
  onRequestEnd(pathname: string): void;
  rearmUnopened(): boolean;
  stop(): void;
  readonly connections: number;
  readonly everConnected: boolean;
  readonly exited: Promise<LiveExitInfo | null>;
}

const encoder = new TextEncoder();

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

  function connect(req: Request, baseHeaders: Record<string, string>): Response {
    if (stopped || closing) {
      return new Response('Server is closing', { status: 503, headers: baseHeaders });
    }
    let released = false;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
      connections = Math.max(0, connections - 1);
      if (connections === 0 && !stopped && !closing) {
        zeroSince = now();
        check();
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        connections += 1;
        everConnected = true;
        zeroSince = null;
        waitingForInFlight = false;
        try {
          controller.enqueue(encoder.encode(': live\n\n'));
        } catch {
          release();
          return;
        }
        keepalive = setInterval(() => {
          if (released || stopped || closing) return;
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            release();
          }
        }, KEEPALIVE_INTERVAL_MS);
        keepalive.unref?.();
        req.signal.addEventListener('abort', release, { once: true });
        if (req.signal.aborted) release();
      },
      cancel() {
        release();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
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
    resolveExited(null);
  }

  return {
    connect,
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
