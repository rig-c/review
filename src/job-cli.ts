import { randomUUID } from 'node:crypto';
import { JOB_API_SCHEMA, type JobAgentRequest } from './job-contract.ts';
import { assertJobApiSchema, jobFailure, parseJobRequest } from './job-api.ts';
import { JobError } from './job-store.ts';

export interface JobCLIOptions {
  readonly agentCapability?: string;
  /** Lane B owns managed-front startup and the owner link. The host binds the
   * reviewer identity and separately delivers credentials. No registry read or
   * consumer grant is exposed by this agent-facing CLI.
   */
  readonly open?: (root: string) => Promise<{ readonly ownerUrl: string }>;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
}

const commonFlags = ['generation', 'key', 'request-id'];
const verbFlags: Record<string, readonly string[]> = {
  publish: [...commonFlags, 'result', 'selector', 'freeze-hold', 'record', 'record-hash'],
  ask: [...commonFlags, 'publication', 'subject'],
  next: ['after', 'wait-ms', 'request-id'],
  close: [...commonFlags, 'reason'],
};

function flags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    if (!args[index]?.startsWith('--') || !name || !allowed.includes(name) || result.has(name) || args[index + 1] === undefined) {
      throw new JobError('JOB_REQUEST_INVALID');
    }
    result.set(name, args[index + 1]);
  }
  return result;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new JobError('JOB_REQUEST_INVALID');
  return value;
}

function semanticJSON(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new JobError('JOB_REQUEST_INVALID'); }
}

/** Public semantic request construction only. There is no act-writing or
 * consumer-fetch verb, no internal JSON input file and no Review state access.
 */
export function parseJobCLI(args: readonly string[]): { readonly endpoint: string; readonly request: JobAgentRequest } {
  const [verb, locator, ...rest] = args;
  if (!verbFlags[verb]) throw new JobError('JOB_REQUEST_INVALID');
  let url: URL;
  try { url = new URL(locator); }
  catch { throw new JobError('JOB_REQUEST_INVALID'); }
  const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !match) {
    throw new JobError('JOB_LOOPBACK_REQUIRED');
  }
  const values = flags(rest, verbFlags[verb]);
  const base = { schema: JOB_API_SCHEMA, verb, jobId: match[1], requestId: values.get('request-id') ?? randomUUID() };
  let payload: unknown;
  if (verb === 'next') {
    payload = { ...base, after: values.get('after') ?? null, waitMs: Number(values.get('wait-ms') ?? '0') };
  } else {
    const mutation = { ...base, expectedGeneration: Number(required(values, 'generation')), idempotencyKey: required(values, 'key') };
    switch (verb) {
      case 'publish': {
        const recordPath = values.get('record'), recordHash = values.get('record-hash');
        if ((recordPath === undefined) !== (recordHash === undefined)) throw new JobError('JOB_REQUEST_INVALID');
        payload = { ...mutation, result: { path: required(values, 'result'), selector: semanticJSON(values.get('selector') ?? 'null') },
          freeze: { kind: 'producer-held', holdId: required(values, 'freeze-hold'),
            record: recordPath === undefined ? null : { path: recordPath, sha256: recordHash } } };
        break;
      }
      case 'ask':
        payload = { ...mutation, publicationId: required(values, 'publication'), subject: semanticJSON(required(values, 'subject')) };
        break;
      case 'close':
        payload = { ...mutation, reason: required(values, 'reason') };
        break;
    }
  }
  const request = parseJobRequest(payload);
  if (request.verb === 'fetch-act') throw new JobError('JOB_AUTHORITY_REFUSED');
  return { endpoint: `${url.origin}/jobs/${match[1]}/api`, request };
}

export async function jobCommand(args: readonly string[], options: JobCLIOptions = {}): Promise<void> {
  const write = options.write ?? (text => console.log(text));
  if (args[0] === 'open') {
    if (args.length !== 2 || !options.open) throw new JobError('JOB_AUTHORITY_REFUSED', 'Managed job opening requires the Review host');
    write((await options.open(args[1])).ownerUrl);
    return;
  }
  const input = parseJobCLI(args);
  const capability = options.agentCapability ?? process.env.RIG_REVIEW_JOB_AGENT_CAPABILITY;
  if (!capability) throw new JobError('JOB_CAPABILITY_REQUIRED');
  const response = await (options.fetch ?? fetch)(input.endpoint, {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + capability },
    body: JSON.stringify(input.request),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new JobError('JOB_REQUEST_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        try { void reader.cancel().catch(() => {}); } catch {}
        throw new JobError('JOB_BODY_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new JobError('JOB_REQUEST_INVALID'); }
  assertJobApiSchema(value !== null && typeof value === 'object' ? (value as { schema?: unknown }).schema : undefined);
  write(JSON.stringify(value));
  if (!response.ok) process.exitCode = 1;
}

if (import.meta.main) {
  jobCommand(Bun.argv.slice(2)).catch(error => {
    console.error(JSON.stringify(jobFailure(error)));
    process.exitCode = 1;
  });
}
