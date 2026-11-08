import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_API_SCHEMA, JOB_ACT_SCHEMA, type JobErrorCode, type JobEvent } from './job-contract.ts';

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
  readonly closure?: JobClosure;
}

export interface JobClosure {
  readonly generation: number;
  readonly event: JobEvent;
  readonly replayKey: string;
  readonly replay: { readonly digest: string; readonly value: unknown };
}

export interface JobSnapshotOwner {
  readonly publicationId: string;
  readonly snapshotHash: string;
  readonly snapshotRoot: string;
  readonly dev: number;
  readonly ino: number;
}

export interface JobSnapshotTombstone {
  readonly publicationId: string;
  readonly snapshotHash: string;
  readonly reclaimedAt: string;
  readonly reason: 'closed' | 'superseded';
}

export interface JobStoredStill {
  readonly actId: string;
  readonly pageId: string;
  readonly submissionId: string;
  readonly sha256: string;
  readonly binding: string;
  readonly png: Uint8Array;
  readonly actBytes: Uint8Array;
}

interface JobRow {
  job_id: string;
  root_key: string;
  revision: number;
  active: number;
  document: string;
  closure?: string | null;
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
      ...(row.closure ? { closure: JSON.parse(row.closure) as JobClosure } : {}),
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
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_root ON jobs(root_key) WHERE active=1;
      CREATE INDEX IF NOT EXISTS jobs_active_canonical_root
        ON jobs(json_extract(document, '$.root.path')) WHERE active=1;
      CREATE TABLE IF NOT EXISTS job_closures (
        job_id TEXT PRIMARY KEY, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_snapshot_owners (
        job_id TEXT NOT NULL, publication_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        snapshot_root TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL,
        PRIMARY KEY(job_id, publication_id)
      );
      CREATE TABLE IF NOT EXISTS job_snapshot_reads (
        read_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, snapshot_root TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_snapshot_tombstones (
        job_id TEXT NOT NULL, publication_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        reclaimed_at TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('closed','superseded')),
        PRIMARY KEY(job_id, publication_id)
      );
      CREATE TABLE IF NOT EXISTS job_act_stills (
        job_id TEXT NOT NULL, act_id TEXT NOT NULL, page_id TEXT NOT NULL, submission_id TEXT NOT NULL,
        sha256 TEXT NOT NULL, binding TEXT NOT NULL, png BLOB NOT NULL, act_bytes BLOB NOT NULL,
        PRIMARY KEY(job_id, act_id), UNIQUE(job_id, page_id, submission_id)
      );`);
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
    const row = this.db.query<JobRow, [string]>(`SELECT jobs.*, job_closures.document AS closure
      FROM jobs LEFT JOIN job_closures USING(job_id) WHERE job_id=?`).get(jobId);
    if (!row) throw new JobError('JOB_UNKNOWN');
    return decode<Data>(row);
  }

  open(rootKey: string, initialize: (jobId: string) => Data, canonicalRoot?: string): StoredJob<Data> {
    return this.transaction(() => {
      if (canonicalRoot !== undefined) {
        // Inspect only bounded scalar details. The guard and allocation share
        // this IMMEDIATE transaction, including across different fingerprints.
        const incompatible = this.db.query<{api_schema: string; act_schema: string}, [string, string, string]>(`
          SELECT substr(json_quote(json_extract(document, '$.apiSchema')), 1, 160) AS api_schema,
                 substr(json_quote(json_extract(document, '$.actSchema')), 1, 160) AS act_schema
          FROM jobs
          WHERE active=1 AND json_extract(document, '$.root.path')=?
            AND (json_extract(document, '$.apiSchema') IS NOT ? OR json_extract(document, '$.actSchema') IS NOT ?)
          LIMIT 1
        `).get(canonicalRoot, JOB_API_SCHEMA, JOB_ACT_SCHEMA);
        if (incompatible) {
          throw new JobError('JOB_SOURCE_UNRETAINABLE',
            `JOB_STORED_SCHEMA_MISMATCH root=${JSON.stringify(canonicalRoot)} storedApi=${incompatible.api_schema} storedAct=${incompatible.act_schema} currentApi=${JSON.stringify(JOB_API_SCHEMA)} currentAct=${JSON.stringify(JOB_ACT_SCHEMA)}. Close the old job with the matching older installation.`);
        }
      }
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
   * together. A durable replay returns before CAS without rewriting the row.
   * A null revision delegates freshness to the UI's in-transaction predicates.
   * Closing releases the active-root slot in the same commit.
   */
  update(jobId: string, expectedRevision: number | null, operation: (current: StoredJob<Data>) => {
    readonly data: Data;
    readonly active?: boolean;
    readonly snapshot?: JobSnapshotOwner;
    readonly still?: JobStoredStill;
  }, replay?: (current: StoredJob<Data>) => boolean): StoredJob<Data> {
    return this.transaction(() => {
      const current = this.get(jobId);
      if (replay?.(current)) return current;
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new JobError('JOB_GENERATION_STALE');
      const next = operation(current);
      const active = next.active ?? current.active;
      const document = encode(next.data);
      if (next.snapshot) {
        const snapshot = next.snapshot;
        this.db.query(`INSERT INTO job_snapshot_owners
          (job_id,publication_id,snapshot_hash,snapshot_root,dev,ino) VALUES(?,?,?,?,?,?)`)
          .run(jobId, snapshot.publicationId, snapshot.snapshotHash, snapshot.snapshotRoot, snapshot.dev, snapshot.ino);
      }
      if (next.still) {
        const still = next.still;
        this.db.query(`INSERT INTO job_act_stills
          (job_id,act_id,page_id,submission_id,sha256,binding,png,act_bytes) VALUES(?,?,?,?,?,?,?,?)`)
          .run(jobId, still.actId, still.pageId, still.submissionId, still.sha256, still.binding, still.png, still.actBytes);
      }
      this.db.query('UPDATE jobs SET revision=?,active=?,document=? WHERE job_id=?')
        .run(current.revision + 1, active ? 1 : 0, document, jobId);
      return this.get(jobId);
    });
  }

  readStill(jobId: string, actId: string): Pick<JobStoredStill, 'sha256' | 'png' | 'actBytes'> | null {
    return this.db.query<{sha256: string; png: Uint8Array; actBytes: Uint8Array}, [string, string]>(
      'SELECT sha256,png,act_bytes AS actBytes FROM job_act_stills WHERE job_id=? AND act_id=?',
    ).get(jobId, actId);
  }

  /** Close never grows or rewrites the bounded historical document. */
  sealClose(jobId: string, expectedRevision: number,
    replay: (current: StoredJob<Data>) => Pick<JobClosure, 'replay'> | null,
    prepare: (current: StoredJob<Data>) => JobClosure): Pick<JobClosure, 'replay'> {
    return this.transaction(() => {
      const current = this.get(jobId);
      const previous = replay(current);
      if (previous) return previous;
      if (current.revision !== expectedRevision) throw new JobError('JOB_GENERATION_STALE');
      if (!current.active) throw new JobError('JOB_CLOSED');
      const closure = prepare(current), document = encode(closure);
      this.db.query('INSERT INTO job_closures(job_id,document) VALUES(?,?)').run(jobId, document);
      this.db.query('UPDATE jobs SET revision=revision+1,active=0 WHERE job_id=?').run(jobId);
      return closure;
    });
  }

  snapshotOwner(jobId: string, publicationId: string): JobSnapshotOwner | null {
    return this.db.query<JobSnapshotOwner, [string, string]>(`SELECT publication_id AS publicationId,
      snapshot_hash AS snapshotHash, snapshot_root AS snapshotRoot, dev, ino
      FROM job_snapshot_owners WHERE job_id=? AND publication_id=?`).get(jobId, publicationId);
  }

  snapshotTombstone(jobId: string, publicationId: string): JobSnapshotTombstone | null {
    return this.db.query<JobSnapshotTombstone, [string, string]>(`SELECT publication_id AS publicationId,
      snapshot_hash AS snapshotHash, reclaimed_at AS reclaimedAt, reason
      FROM job_snapshot_tombstones WHERE job_id=? AND publication_id=?`).get(jobId, publicationId);
  }

  snapshotReferenced(snapshotRoot: string, except?: { jobId: string; publicationId: string }): boolean {
    return this.db.query<{ present: number }, [string, string, string]>(`SELECT 1 AS present FROM jobs,
      json_each(jobs.document, '$.publications') AS publication
      WHERE json_extract(publication.value, '$.retained.snapshotRoot')=?
        AND NOT (jobs.job_id=? AND publication.key=?) LIMIT 1`)
      .get(snapshotRoot, except?.jobId ?? '', except?.publicationId ?? '') !== null;
  }

  /** These are internal file-I/O counts, never a consumer grant or a lease.
   * Only explicit completion removes a count. A crashed reader pins its bytes.
   */
  beginSnapshotRead(jobId: string, publicationId: string, snapshotHash: string,
    snapshotRoot: string): string {
    return this.transaction(() => {
      if (this.snapshotTombstone(jobId, publicationId)) throw new JobError('JOB_SNAPSHOT_RECLAIMED');
      if (!this.get(jobId).active) throw new JobError('JOB_CLOSED');
      const owner = this.snapshotOwner(jobId, publicationId);
      if (owner && (owner.snapshotHash !== snapshotHash || owner.snapshotRoot !== snapshotRoot)) {
        throw new JobError('JOB_SOURCE_MISMATCH');
      }
      const readId = randomUUID();
      this.db.query('INSERT INTO job_snapshot_reads(read_id,job_id,snapshot_root) VALUES(?,?,?)')
        .run(readId, jobId, snapshotRoot);
      return readId;
    });
  }

  endSnapshotRead(readId: string): void {
    this.transaction(() => {
      this.db.query('DELETE FROM job_snapshot_reads WHERE read_id=?').run(readId);
    });
  }

  markSnapshotReclaimed(jobId: string, publicationId: string, snapshotHash: string,
    finalized: (data: Data) => boolean): JobSnapshotOwner | null {
    return this.transaction(() => {
      const current = this.get(jobId), owner = this.snapshotOwner(jobId, publicationId);
      if (!owner) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership is unavailable');
      if (owner.snapshotHash !== snapshotHash) throw new JobError('JOB_SOURCE_MISMATCH');
      const reading = this.db.query<{ present: number }, [string]>(
        'SELECT 1 AS present FROM job_snapshot_reads WHERE snapshot_root=? LIMIT 1').get(owner.snapshotRoot);
      if (current.active || finalized(current.data) || reading ||
          this.snapshotReferenced(owner.snapshotRoot, {jobId, publicationId})) return null;
      this.db.query(`INSERT OR IGNORE INTO job_snapshot_tombstones
        (job_id,publication_id,snapshot_hash,reclaimed_at,reason) VALUES(?,?,?,?,?)`)
        .run(jobId, publicationId, snapshotHash, new Date().toISOString(), 'closed');
      return owner;
    });
  }

  close(): void {
    this.db.close();
  }
}
