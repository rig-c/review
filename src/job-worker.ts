import {randomUUID} from 'node:crypto';
import { createJobHostPorts } from './job-api.ts';
import { JobSession, type JobSessionOptions } from './job-session.ts';
import type { JobHostPorts } from './job-contract.ts';
import { JobError } from './job-store.ts';

export interface JobWorkerOptions extends JobSessionOptions {
  readonly port?: number;
  /** Trusted Create #184 adapter installs its private writer-owned sibling.
   * No project record key or binding-file format is defined by this callback.
   * Reusable owner-host attachment (`reuseOnly`) belongs to JobHostOptions.
   */
  readonly installWriterBinding?: (binding: {
    readonly jobId: string;
    readonly origin: string;
    readonly fetchCapability: string;
  }) => void | Promise<void>;
}

/** Backend host only. Lane B mounts these same ports in its managed front and
 * supplies the owner UI. This listener serves semantic API requests only and
 * never serves a private snapshot directory or starts a browser/producer.
 */
export async function startJobWorker(options: JobWorkerOptions): Promise<{
  readonly session: JobSession;
  readonly ports: JobHostPorts;
  readonly origin: string;
  readonly listenerIncarnation: string;
  stop(): void;
}> {
  const session = new JobSession(options);
  const listenerIncarnation = randomUUID();
  let ports: JobHostPorts;
  let stopped = false;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 0, idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/jobs/${session.jobId}/api`) return ports.handleJobApi(request);
      return Response.json({ error: 'JOB_REQUEST_INVALID' }, {
        status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  ports = createJobHostPorts(session, origin);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    session.dispose();
  };
  try {
    await options.installWriterBinding?.({ ...session.writerGrant(), origin });
    return { session, ports, origin, listenerIncarnation, stop };
  } catch {
    stop();
    throw new JobError('JOB_AUTHORITY_REFUSED', 'Writer binding installation failed');
  }
}
