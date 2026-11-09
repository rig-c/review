import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const observerEnv = 'REVIEW_562_STDERR_OBSERVER';

export interface ObserverScope {
  worker: string;
  stateDir: string;
  toolchainRoot: string;
  projectRoot: string;
  input: string;
  receiptDir: string;
  bins: string[];
  originalBunOptions: string | undefined;
}

function instrument(scope: ObserverScope): void {
  const spawn = Bun.spawn;
  const bins = new Set(scope.bins);
  let sequence = 0;
  const writeReceipt = (path: string, value: object) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  writeReceipt(join(scope.receiptDir, 'worker.json'), {
    instrumentation: 'review-562 test-only Bun.spawn raw stderr observation',
    pid: process.pid,
    argv: process.argv,
    request: process.argv[2],
    bins: scope.bins,
  });

  Bun.spawn = new Proxy(spawn, {
    apply(target, thisArg, args) {
      const [argv, options] = args;
      if (!Array.isArray(argv) || argv[0] !== process.execPath ||
        typeof argv[1] !== 'string' || options?.stderr !== 'pipe' ||
        !bins.has(argv[1])) {
        return Reflect.apply(target, thisArg, args);
      }

      const dir = join(scope.receiptDir, `process-${++sequence}`);
      mkdirSync(dir);
      const fd = openSync(join(dir, 'stderr.bin'), 'wx');
      let child: ReturnType<typeof spawn>;
      try {
        child = Reflect.apply(target, thisArg, args);
      } catch (error) {
        closeSync(fd);
        writeReceipt(join(dir, 'spawn-error.json'), { argv, cwd: options.cwd, error: String(error) });
        throw error;
      }

      const invocation = { argv, cwd: options.cwd, pid: child.pid };
      writeReceipt(join(dir, 'started.json'), invocation);
      const original = child.stderr as ReadableStream<Uint8Array>;
      const reader = original.getReader();
      let reads = 0;
      let closed = false;
      const close = () => {
        if (!closed) { closed = true; closeSync(fd); }
      };
      const stderr = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              close();
              const exitCode = await child.exited;
              writeReceipt(join(dir, 'result.json'), { ...invocation, reads, exitCode, stderr: 'stderr.bin' });
              controller.close();
              return;
            }
            reads++;
            for (let offset = 0; offset < value.length;) {
              offset += writeSync(fd, value, offset, value.length - offset);
            }
            controller.enqueue(value);
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        async cancel(reason) {
          close();
          await reader.cancel(reason);
        },
      }, { highWaterMark: 0 });

      return new Proxy(child, {
        get(target, key) {
          if (key === 'stderr') return stderr;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
}

const encoded = process.env[observerEnv];
if (encoded !== undefined) {
  const scope: ObserverScope = JSON.parse(encoded);
  delete process.env[observerEnv];
  if (scope.originalBunOptions === undefined) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = scope.originalBunOptions;

  if (process.argv[1] === scope.worker && process.cwd() === join(scope.stateDir, 'open')) {
    const request = process.argv[2];
    const spec = request && dirname(request) === process.cwd() && request.endsWith('.request.json')
      ? JSON.parse(readFileSync(request, 'utf8'))
      : null;
    if (spec?.schema !== 'rig-review-open-request/1' || spec.request !== request ||
      spec.stateDir !== scope.stateDir || spec.cwd !== scope.toolchainRoot ||
      spec.inputs?.project?.root !== scope.projectRoot || spec.inputs?.input !== scope.input ||
      request !== join(process.cwd(), `${spec.identity?.key}.${spec.identity?.nonce}.request.json`)) {
      throw new Error('TEST_STDERR_OBSERVER_SCOPE: unexpected owned worker request');
    }
    instrument(scope);
  }
}
