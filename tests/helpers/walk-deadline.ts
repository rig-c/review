import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';

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

export function walkCheckpoint(path: string): (key: string) => void {
  let seq = 0;
  const start = performance.now();
  return key => {
    const fd = openSync(path, 'a', 0o600);
    try {
      appendFileSync(fd, JSON.stringify({seq: ++seq, monotonicms: performance.now() - start, key}) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}
