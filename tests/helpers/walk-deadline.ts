import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';

// #1152: local macOS remesh runs both input and revision checks before the
// browser can reload. Those checks saturated the old 30 s Apply budget under load.
export const PRODUCER_APPLY_DEADLINE_MS = process.platform === 'darwin' ? 60_000 : 30_000;

export class WalkDeadlineError extends Error {
  constructor(key: string, ms: number) {
    super(`WALK_DEADLINE: ${key} (${ms}ms)`);
  }
}

export async function withDeadline<T>(key: string, ms: number, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new WalkDeadlineError(key, ms);
        reject(error);
        controller.abort(error);
      }, ms);
    });
    return await Promise.race([deadline, op(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

export function walkCheckpoint(path: string): (key: string, detail?: {
  step?: string; pathname?: string | null; loaderId?: string | null; ariaLabel?: string;
}) => void {
  let seq = 0;
  const start = performance.now();
  return (key, detail) => {
    const fd = openSync(path, 'a', 0o600);
    try {
      appendFileSync(fd, JSON.stringify({seq: ++seq, monotonicms: performance.now() - start, key, ...detail}) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}
