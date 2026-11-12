import type {JobSessionOptions} from './job-session.ts';

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
