import type {JobErrorCode} from './job-contract.ts';

export class JobError extends Error {
  constructor(readonly code: JobErrorCode, message: string = code, readonly byteLimit?: number) {
    super(message);
    this.name = 'JobError';
  }
}

export function jobText(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  return value;
}

export function jobId(value: unknown): string {
  const id = jobText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new JobError('JOB_REQUEST_INVALID');
  return id;
}

export function jobSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new JobError('JOB_REQUEST_INVALID');
  return value;
}

export function jobPath(value: unknown): string {
  const path = jobText(value, 4096);
  if (path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:%?#]/.test(path)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  return path;
}
