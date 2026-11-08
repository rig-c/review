import { randomUUID } from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import { JOB_API_SCHEMA, JOB_ACT_SCHEMA, JOB_RIG_REVIEW_ACT_SCHEMA, jobRawActMediaType, jobStillByteLimit,
  type JobAct, type JobAgentRequest } from './job-contract.ts';
import { assertJobApiSchema, jobFailure, jobHash, jobId, jobObject, parseJobRequest } from './job-api.ts';
import { JobError } from './job-store.ts';
import {validatePngBytes} from './comment-crops.ts';
import {destinationDirectory} from './destination-directory.ts';

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
  /** Trusted in-process consumer adapter only. Production consumers pipe the same grant on stdin. */
  readonly consumerCapability?: string;
  readonly consumerInput?: ReadableStream<Uint8Array>;
  /** Checked partial writes for consumer stdout and disposable output-fault controls. */
  readonly writeBytes?: (bytes: Uint8Array) => number;
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
  const {url, job} = jobLocator(locator);
  const values = flags(rest, verbFlags[verb]);
  const base = { schema: JOB_API_SCHEMA, verb, jobId: job, requestId: values.get('request-id') ?? randomUUID() };
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
  return { endpoint: `${url.origin}/jobs/${job}/api`, request };
}

function jobLocator(locator: string): {url: URL; job: string} {
  let url: URL;
  try { url = new URL(locator); }
  catch { throw new JobError('JOB_REQUEST_INVALID'); }
  const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !match) {
    throw new JobError('JOB_LOOPBACK_REQUIRED');
  }
  return {url, job: match[1]};
}

async function consumerBytes(stream: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  if (!stream) throw new JobError('JOB_REQUEST_INVALID');
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new JobError('JOB_REQUEST_INVALID'));
    timer = setTimeout(abort, 10_000);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const {done, value} = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new JobError('JOB_BODY_LIMIT');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_REQUEST_INVALID');
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function parseConsumerAct(bytes: Buffer, job: string, actId: string): JobAct {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new JobError('JOB_REQUEST_INVALID'); }
  const act = jobObject(value, ['schema', 'actId', 'jobId', 'askId', 'publicationId', 'kind', 'authority', 'at', 'source', 'value', 'still']);
  if (act.jobId !== job || act.actId !== actId || (act.schema !== JOB_ACT_SCHEMA && act.schema !== JOB_RIG_REVIEW_ACT_SCHEMA)) {
    throw new JobError('JOB_ACT_INVALID');
  }
  if (act.schema === JOB_RIG_REVIEW_ACT_SCHEMA) {
    if (act.kind !== 'review-verdict' || (act.value as {stage?: unknown})?.stage !== 'rig-review') throw new JobError('JOB_ACT_INVALID');
    const still = jobObject(act.still, ['path', 'sha256', 'camera', 'frame', 'animation']);
    if (typeof still.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(still.sha256) ||
        still.path !== still.sha256 + '.png' || still.camera !== 'fixed' ||
        (still.frame === 'setup' ? still.animation !== undefined :
          typeof still.frame !== 'number' || !Number.isFinite(still.frame) || still.frame < 0 ||
          typeof still.animation !== 'string' || !still.animation)) throw new JobError('JOB_ACT_INVALID');
  } else if (act.still !== undefined) throw new JobError('JOB_ACT_INVALID');
  return act as unknown as JobAct;
}

function unlinkOwned(path: string, identity: {dev: number; ino: number}): void {
  try {
    const info = lstatSync(path);
    if (info.dev === identity.dev && info.ino === identity.ino) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new JobError('JOB_STILL_OUTPUT_FAILED');
  }
}

function outputConsumerAct(actBytes: Buffer, png: Buffer | undefined, act: JobAct, destination: string | undefined, options: JobCLIOptions): void {
  let temporary: string | undefined;
  let temporaryIdentity: {dev: number; ino: number} | undefined;
  let installed: string | undefined;
  let installedIdentity: {dev: number; ino: number} | undefined;
  let lock: string | undefined;
  let lockDescriptor: number | undefined;
  let emitted = 0;
  try {
    if (png && destination && act.schema === JOB_RIG_REVIEW_ACT_SCHEMA) {
      const directory = destinationDirectory(destination, 'JOB_STILL_OUTPUT_FAILED', false);
      const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW);
      try {
        const directoryIdentity = fstatSync(directoryDescriptor);
        if (!directoryIdentity.isDirectory()) throw new JobError('JOB_STILL_OUTPUT_FAILED');
        lock = join(directory, '.rig-review-still.lock');
        try {
          lockDescriptor = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new JobError('JOB_STILL_OUTPUT_FAILED',
              `JOB_STILL_OUTPUT_FAILED: retained lock ${lock} already exists; wait for another writer to finish or remove ${lock} if a killed process left it`);
          }
          throw error;
        }
        const target = join(directory, act.still.path);
        let existing = false;
        try {
          const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = fstatSync(descriptor);
            if (!info.isFile() || info.size > jobStillByteLimit || jobHash(readFileSync(descriptor)) !== act.still.sha256) {
              throw new JobError('JOB_STILL_OUTPUT_FAILED');
            }
            existing = true;
          } finally { closeSync(descriptor); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!existing) {
          temporary = join(directory, '.rig-review-still-' + randomUUID() + '.tmp');
          const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try {
            const owned = fstatSync(descriptor);
            temporaryIdentity = {dev: owned.dev, ino: owned.ino};
            let offset = 0;
            while (offset < png.byteLength) {
              const written = writeSync(descriptor, png, offset, png.byteLength - offset);
              if (written <= 0) throw new JobError('JOB_STILL_OUTPUT_FAILED');
              offset += written;
            }
            fsyncSync(descriptor);
            const info = fstatSync(descriptor);
            installedIdentity = {dev: info.dev, ino: info.ino};
          } finally { closeSync(descriptor); }
          renameSync(temporary, target);
          temporary = undefined;
          installed = target;
        }
        const currentDirectory = lstatSync(directory);
        if (currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) {
          throw new JobError('JOB_STILL_OUTPUT_FAILED');
        }
        fsyncSync(directoryDescriptor);
      } finally { closeSync(directoryDescriptor); }
    }
    if (options.write && !options.writeBytes) {
      // A legacy callback cannot report partial progress, so preserve an installed PNG on a thrown write.
      emitted = actBytes.byteLength;
      options.write(actBytes.toString('utf8'));
    } else {
      const write = options.writeBytes ?? (bytes => writeSync(1, bytes));
      while (emitted < actBytes.byteLength) {
        const written = write(actBytes.subarray(emitted));
        if (!Number.isSafeInteger(written) || written <= 0 || written > actBytes.byteLength - emitted) throw new JobError('JOB_STILL_OUTPUT_FAILED');
        emitted += written;
      }
    }
  } catch (error) {
    if (emitted === 0 && installed && installedIdentity) {
      unlinkOwned(installed, installedIdentity);
    }
    throw error instanceof JobError ? error : new JobError('JOB_STILL_OUTPUT_FAILED');
  } finally {
    if (temporary && temporaryIdentity) unlinkOwned(temporary, temporaryIdentity);
    if (lockDescriptor !== undefined) {
      const owned = fstatSync(lockDescriptor);
      closeSync(lockDescriptor);
      unlinkOwned(lock!, owned);
    }
  }
}

async function fetchActCommand(args: readonly string[], options: JobCLIOptions): Promise<void> {
  const {url, job} = jobLocator(args[1]);
  const rest = args.slice(2);
  const stdinFlags = rest.filter(value => value === '--consumer-capability-stdin').length;
  if (stdinFlags > 1 || (stdinFlags === 0 && !options.consumerCapability) || (stdinFlags && options.consumerCapability)) throw new JobError('JOB_REQUEST_INVALID');
  const values = flags(rest.filter(value => value !== '--consumer-capability-stdin'), ['act', 'still-out', 'request-id']);
  const actId = jobId(required(values, 'act'));
  const input = options.consumerCapability ?? (await consumerBytes(options.consumerInput ?? Bun.stdin.stream(), 4096, options.signal)).toString('utf8');
  const capability = input.replace(/\r?\n$/, '');
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new JobError('JOB_CAPABILITY_REQUIRED');
  const request = {schema: JOB_API_SCHEMA, verb: 'fetch-act', jobId: job, actId, requestId: values.get('request-id') ?? randomUUID()};
  async function read(accept: string, maximum: number): Promise<Buffer> {
    const response = await (options.fetch ?? fetch)(`${url.origin}/jobs/${job}/api`, {
      method: 'POST', redirect: 'error', signal: options.signal,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability, Accept: accept},
      body: JSON.stringify(request),
    });
    const bytes = await consumerBytes(response.body, maximum, options.signal);
    if (!response.ok) {
      let failure: unknown;
      try { failure = JSON.parse(bytes.toString('utf8')); } catch {}
      const code = (failure as {error?: {code?: unknown}})?.error?.code;
      throw new JobError('JOB_REQUEST_INVALID', typeof code === 'string' && /^JOB_[A-Z_]+$/.test(code) ? code : 'JOB_REQUEST_INVALID');
    }
    if (response.headers.get('content-type')?.split(';')[0] !== accept) throw new JobError('JOB_REQUEST_INVALID');
    return bytes;
  }
  const bytes = await read(jobRawActMediaType, 512 * 1024);
  const act = parseConsumerAct(bytes, job, actId);
  const destination = values.get('still-out');
  if (act.schema === JOB_RIG_REVIEW_ACT_SCHEMA && destination === undefined) throw new JobError('JOB_STILL_OUTPUT_FAILED');
  let png: Buffer | undefined;
  if (destination !== undefined) {
    if (act.schema !== JOB_RIG_REVIEW_ACT_SCHEMA) throw new JobError('JOB_STILL_UNAVAILABLE');
    png = await read('image/png', jobStillByteLimit);
    try {
      if (png.length < 33 || jobHash(png) !== act.still.sha256) throw new Error('hash');
      validatePngBytes(png, png.readUInt32BE(16), png.readUInt32BE(20));
    } catch { throw new JobError('JOB_STILL_CAPTURE_FAILED'); }
  }
  outputConsumerAct(bytes, png, act, destination, options);
}

export async function jobCommand(args: readonly string[], options: JobCLIOptions = {}): Promise<void> {
  if (args[0] === 'fetch-act') return fetchActCommand(args, options);
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
