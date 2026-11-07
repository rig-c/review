import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { JobErrorCode } from './job-contract.ts';

export class JobError extends Error {
  constructor(readonly code: JobErrorCode, message: string = code) {
    super(message);
    this.name = 'JobError';
  }
}

export interface StoredJob<Data> {
  readonly jobId: string;
  readonly rootKey: string;
  readonly revision: number;
  readonly active: boolean;
  readonly data: Data;
}

interface JobRow {
  job_id: string;
  root_key: string;
  revision: number;
  active: number;
  document: string;
}

const maximumDocumentBytes = 16 * 1024 * 1024;

function encode(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) {
        throw new JobError('JOB_STORAGE_FAILED');
      }
      return item;
    });
    if (text === undefined || Buffer.byteLength(text) > maximumDocumentBytes) {
      throw new JobError('JOB_STORAGE_FAILED');
    }
    return text;
  } catch {
    throw new JobError('JOB_STORAGE_FAILED', 'Job state could not be serialized within its bound');
  }
}

function decode<Data>(row: JobRow): StoredJob<Data> {
  try {
    if (Buffer.byteLength(row.document) > maximumDocumentBytes || !Number.isSafeInteger(row.revision) ||
        row.revision < 0 || ![0, 1].includes(row.active)) throw new Error('Invalid row');
    return {
      jobId: row.job_id,
      rootKey: row.root_key,
      revision: row.revision,
      active: row.active === 1,
      data: JSON.parse(row.document) as Data,
    };
  } catch {
    throw new JobError('JOB_STORAGE_FAILED', 'Stored job state is invalid');
  }
}

function privateEntry(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if (!(directory ? info.isDirectory() : info.isFile()) || (info.mode & 0o077) !== 0 ||
      (!directory && info.nlink !== 1) || typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new JobError('JOB_STORAGE_FAILED', 'Job state requires private owned regular storage');
  }
}

/** One SQLite transaction seals the entire job, including its events, acts and
 * idempotency receipts. IMMEDIATE transactions serialize independent daemons.
 * FULL synchronous durability and the rollback journal survive process death.
 * Callbacks are synchronous and must not perform external writes.
 */
export class JobStore<Data> {
  readonly root: string;
  private readonly db: Database;

  constructor(directory: string) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateEntry(directory, true);
      this.root = realpathSync(directory);
      const file = join(this.root, 'jobs.sqlite');
      try { privateEntry(file, false); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.db = new Database(file, { create: true });
      chmodSync(file, 0o600);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        root_key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        document TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_root ON jobs(root_key) WHERE active=1;`);
    } catch {
      throw new JobError('JOB_STORAGE_FAILED', 'Private job storage could not be opened');
    }
  }

  private transaction<Value>(operation: () => Value): Value {
    try { return this.db.transaction(operation).immediate(); }
    catch (error) {
      if (typeof (error as { code?: unknown }).code === 'string' &&
          String((error as { code: string }).code).startsWith('SQLITE_')) {
        throw new JobError('JOB_STORAGE_FAILED', 'Job transaction could not be committed');
      }
      throw error;
    }
  }

  get(jobId: string): StoredJob<Data> {
    const row = this.db.query<JobRow, [string]>('SELECT * FROM jobs WHERE job_id=?').get(jobId);
    if (!row) throw new JobError('JOB_UNKNOWN');
    return decode<Data>(row);
  }

  open(rootKey: string, initialize: (jobId: string) => Data): StoredJob<Data> {
    return this.transaction(() => {
      const current = this.db.query<JobRow, [string]>(
        'SELECT * FROM jobs WHERE root_key=? AND active=1',
      ).get(rootKey);
      if (current) return decode<Data>(current);
      const jobId = randomUUID();
      const document = encode(initialize(jobId));
      this.db.query('INSERT INTO jobs(job_id,root_key,revision,active,document) VALUES(?,?,0,1,?)')
        .run(jobId, rootKey, document);
      return this.get(jobId);
    });
  }

  /** Re-read under the write transaction. A callback failure rolls everything
   * back. A successful callback publishes its complete data and replay receipt
   * together. Closing releases the active-root slot in the same commit.
   */
  update(jobId: string, expectedRevision: number, operation: (current: StoredJob<Data>) => {
    readonly data: Data;
    readonly active?: boolean;
  }): StoredJob<Data> {
    return this.transaction(() => {
      const current = this.get(jobId);
      if (current.revision !== expectedRevision) throw new JobError('JOB_GENERATION_STALE');
      const next = operation(current);
      const active = next.active ?? current.active;
      const document = encode(next.data);
      this.db.query('UPDATE jobs SET revision=?,active=?,document=? WHERE job_id=?')
        .run(current.revision + 1, active ? 1 : 0, document, jobId);
      return this.get(jobId);
    });
  }

  close(): void {
    this.db.close();
  }
}
