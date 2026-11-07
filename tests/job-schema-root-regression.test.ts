/** HQ 2b84f847 canonical-root schema guard and preserved fingerprint partitions. */
import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {JobSession} from '../src/job-session.ts';
import {JobError, JobStore} from '../src/job-store.ts';
import {JOB_API_SCHEMA, JOB_ACT_SCHEMA} from '../src/job-contract.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

test('old API/act state refuses a changed fingerprint on the same root without creating a parallel row', async () => {
  const f = await jobFixture();
  const database = new Database(join(f.state, 'jobs.sqlite'));
  let opened: JobSession | undefined;
  try {
    const read = database.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?');
    const old = JSON.parse(read.get(f.session.jobId)!.document);
    old.apiSchema = 'rig-review/job-api@1';
    old.actSchema = 'rig-review/act@1';
    const oldDocument = JSON.stringify(old);
    database.query('UPDATE jobs SET document=? WHERE job_id=?').run(oldDocument, f.session.jobId);
    const count = () => database.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count;
    const before = count();
    const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner' as const},
      readPublished: async () => f.getContext(), partsEnumerator: f.partsEnumerator};
    let sameFingerprintFailure: {code: string; message: string} | null = null;
    try {opened = new JobSession(options);}
    catch (error) {
      if (!(error instanceof JobError)) throw error;
      sameFingerprintFailure = {code: error.code, message: error.message};
    }
    opened?.dispose();
    opened = undefined;
    const afterSameFingerprint = count();
    let changedFingerprintFailure: {code: string; message: string} | null = null;
    try {opened = new JobSession({...options, fingerprint: 'e'.repeat(64)});}
    catch (error) {
      if (!(error instanceof JobError)) throw error;
      changedFingerprintFailure = {code: error.code, message: error.message};
    }
    const afterChangedFingerprint = count();
    const newDocument = opened ? JSON.parse(read.get(opened.jobId)!.document) : null;
    const oldDocumentUnchanged = read.get(f.session.jobId)!.document === oldDocument;
    console.log(JSON.stringify({control: 'old-schema-same-root-changed-fingerprint',
      before, afterSameFingerprint, afterChangedFingerprint, sameFingerprintFailure, changedFingerprintFailure,
      oldDocumentUnchanged, sameCanonicalRoot: newDocument ? newDocument.root.path === old.root.path : null,
      newApiSchema: newDocument?.apiSchema ?? null, newActSchema: newDocument?.actSchema ?? null,
      newJobIdDifferent: opened ? opened.jobId !== f.session.jobId : null}));
    const required = {code: 'JOB_SOURCE_UNRETAINABLE', message:
      `JOB_STORED_SCHEMA_MISMATCH root=${JSON.stringify(old.root.path)} storedApi="rig-review/job-api@1" storedAct="rig-review/act@1" currentApi=${JSON.stringify(JOB_API_SCHEMA)} currentAct=${JSON.stringify(JOB_ACT_SCHEMA)}. Close the old job with the matching older installation.`};
    expect(before).toBe(1);
    expect({failure: sameFingerprintFailure, rows: afterSameFingerprint}).toEqual({failure: required, rows: before});
    expect(oldDocumentUnchanged).toBe(true);
    expect({failure: changedFingerprintFailure, rows: afterChangedFingerprint}).toEqual({failure: required, rows: before});
  } finally {
    opened?.dispose();
    database.close();
    await f.close();
  }
});

test('either missing or old schema marker blocks changed-fingerprint allocation without rewriting the row', async () => {
  for (const markers of [{apiSchema: 'rig-review/job-api@1'}, {actSchema: 'rig-review/act@1'},
    {apiSchema: undefined}, {actSchema: undefined}]) {
    const f = await jobFixture();
    const db = new Database(join(f.state, 'jobs.sqlite'));
    try {
      const read = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?');
      const data = {...JSON.parse(read.get(f.session.jobId)!.document), ...markers};
      const frozen = JSON.stringify(data);
      db.query('UPDATE jobs SET document=? WHERE job_id=?').run(frozen, f.session.jobId);
      expect(() => new JobSession({root: f.root + '/../input', stateDir: f.state, fingerprint: 'e'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner'}})).toThrow('JOB_STORED_SCHEMA_MISMATCH');
      expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count).toBe(1);
      expect(read.get(f.session.jobId)!.document).toBe(frozen);
    } finally {db.close(); await f.close();}
  }
});

test('current schemas keep different-fingerprint partition behavior and closed old schemas do not block', async () => {
  for (const closedOld of [false, true]) {
    const f = await jobFixture();
    const db = new Database(join(f.state, 'jobs.sqlite'));
    let opened: JobSession | undefined;
    try {
      const read = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?');
      let frozen = read.get(f.session.jobId)!.document;
      if (closedOld) {
        const data = JSON.parse(frozen);
        frozen = JSON.stringify({...data, apiSchema: 'rig-review/job-api@1', actSchema: 'rig-review/act@1'});
        db.query('UPDATE jobs SET active=0, document=? WHERE job_id=?').run(frozen, f.session.jobId);
      }
      opened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'e'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner'}});
      expect(opened.jobId).not.toBe(f.session.jobId);
      expect(JSON.parse(read.get(opened.jobId)!.document)).toMatchObject({apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA});
      expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count).toBe(2);
      expect(read.get(f.session.jobId)!.document).toBe(frozen);
      console.log(JSON.stringify({control: closedOld ? 'closed-old-schema' : 'current-schema-partition', rows: 2, oldDocumentUnchanged: true}));
    } finally {opened?.dispose(); db.close(); await f.close();}
  }
});

test('guard-to-allocation transaction blocks a real concurrent old-schema writer', async () => {
  const f = await jobFixture();
  const dbPath = join(f.state, 'jobs.sqlite');
  const db = new Database(dbPath);
  const store = new JobStore<Record<string, unknown>>(f.state);
  try {
    const original = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document;
    const current = JSON.parse(original);
    const old = JSON.stringify({root: current.root, apiSchema: 'rig-review/job-api@1', actSchema: 'rig-review/act@1'});
    let writerBlocked = false;
    const opened = store.open('concurrent-current-key', () => {
      // This independent writer attempts insertion after the guard, before allocation.
      const program = `import {Database} from 'bun:sqlite';
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec('PRAGMA busy_timeout=50');
        try {
          db.exec('BEGIN IMMEDIATE');
          db.query('INSERT INTO jobs(job_id,root_key,revision,active,document) VALUES(?,?,0,1,?)')
            .run('racing-old-job', 'racing-old-key', ${JSON.stringify(old)});
          db.exec('COMMIT');
          console.log(JSON.stringify({blocked:false,code:null}));
        } catch (error) {
          if (error.code !== 'SQLITE_BUSY') throw error;
          console.log(JSON.stringify({blocked:true,code:error.code}));
        } finally {db.close();}`;
      const child = Bun.spawnSync([process.execPath, '-e', program], {stdout: 'pipe', stderr: 'pipe'});
      expect(child.exitCode).toBe(0);
      expect(new TextDecoder().decode(child.stderr)).toBe('');
      const result = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(result).toEqual({blocked: true, code: 'SQLITE_BUSY'});
      writerBlocked = result.blocked;
      return {...current, fingerprint: 'concurrent-current'};
    }, current.root.path);
    expect(writerBlocked).toBe(true);
    expect(opened.active).toBe(true);
    expect(db.query<{count: number}, []>("SELECT COUNT(*) AS count FROM jobs WHERE job_id='racing-old-job'").get()!.count).toBe(0);
    expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count).toBe(2);
    expect(db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document).toBe(original);
    console.log(JSON.stringify({control: 'same-transaction-concurrent-writer', writerBlocked, code: 'SQLITE_BUSY', racingOldRows: 0, currentRows: 2, originalDocumentUnchanged: true}));
  } finally {store.close(); db.close(); await f.close();}
});

test('actual canonical-root guard uses a nonunique partial expression-index SEARCH', async () => {
  const f = await jobFixture();
  const db = new Database(join(f.state, 'jobs.sqlite'));
  let reopened: JobStore<unknown> | undefined;
  try {
    const frozen = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document;
    const root = JSON.parse(frozen).root.path;
    const source = await readFile(new URL('../src/job-store.ts', import.meta.url), 'utf8');
    const guard = source.split('const incompatible =');
    expect(guard).toHaveLength(2);
    const statement = guard[1].split('`');
    const sql = statement[1];
    expect(statement[2]).toStartWith(').get(canonicalRoot, JOB_API_SCHEMA, JOB_ACT_SCHEMA);');
    const explain = () => db.prepare<{detail: string}, [string, string, string]>(
      'EXPLAIN QUERY PLAN ' + sql).all(root, JOB_API_SCHEMA, JOB_ACT_SCHEMA).map(row => row.detail);
    // Simulate the pre-index store in this disposable database, preserving its row.
    db.exec('DROP INDEX jobs_active_canonical_root');
    const before = explain();
    expect(before.some(detail => detail.includes('jobs_active_canonical_root'))).toBe(false);
    reopened = new JobStore(f.state);
    const index = db.query<{name: string; unique: number; partial: number}, []>("PRAGMA index_list('jobs')").all()
      .find(row => row.name === 'jobs_active_canonical_root');
    expect(index).toMatchObject({unique: 0, partial: 1});
    const after = explain();
    const originalDocumentUnchanged = db.query<{document: string}, [string]>(
      'SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document === frozen;
    const rowCount = db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count;
    console.log(JSON.stringify({control: 'actual-root-guard-query-plan', before, after,
      nonUnique: index?.unique === 0, partial: index?.partial === 1, rows: rowCount, originalDocumentUnchanged}));
    expect(after.some(detail => /^SEARCH jobs USING INDEX jobs_active_canonical_root\b/.test(detail))).toBe(true);
    expect(after.some(detail => /^SCAN jobs\b/.test(detail))).toBe(false);
    expect(db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document).toBe(frozen);
    expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM jobs').get()!.count).toBe(1);
  } finally {reopened?.close(); db.close(); await f.close();}
});
