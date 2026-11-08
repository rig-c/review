import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobFixture, jobInputHashes } from './helpers/job-api-fixture.ts';
import type { ReplayRaceInput, ReplayRaceMessage } from './helpers/job-replay-race-worker.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';

function stored(f: Awaited<ReturnType<typeof jobFixture>>) {
  const database = new Database(join(f.state, 'jobs.sqlite'), { readonly: true });
  try {
    return {
      ...database.query<{ revision: number; active: number; document: string }, [string]>(
        'SELECT revision,active,document FROM jobs WHERE job_id=?').get(f.session.jobId)!,
      owners: database.query('SELECT * FROM job_snapshot_owners WHERE job_id=? ORDER BY publication_id').all(f.session.jobId),
    };
  } finally { database.close(); }
}

function worker(input: ReplayRaceInput) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/job-replay-race-worker.ts')], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, REVIEW540_RACE_INPUT: JSON.stringify(input) },
    // A watchdog bounds a broken harness. Only pipe messages establish ordering.
    timeout: 4_000,
  });
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffer = '', released = false;
  async function message(): Promise<ReplayRaceMessage> {
    while (!buffer.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('REPLAY_RACE_MESSAGE_MISSING ' + buffer);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const value: ReplayRaceMessage = JSON.parse(line);
    expect(value.pid).toBe(child.pid);
    return value;
  }
  return {
    pid: child.pid,
    message,
    release() { child.stdin.write('x'); child.stdin.end(); },
    async result() {
      const enter = await message(), result = await message();
      expect(enter.event).toBe('enter');
      expect(result.event).toBe('result');
      expect(await child.exited).toBe(0);
      expect(await errors).toBe('');
      expect(buffer).toBe('');
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
      released = true;
      return { enter, result };
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await child.exited;
      if (!released) { await reader.cancel(); reader.releaseLock(); }
      await errors;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof jobFixture>>;
type Operation = 'publish' | 'ask' | 'ui';

async function inputFor(f: Fixture, operation: Operation): Promise<ReplayRaceInput> {
  const common = {
    options: { root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: { id: 'declared-owner', role: 'owner' as const } },
    context: f.getContext(), gated: true,
  };
  if (operation === 'publish') {
    const request = await f.publishRequest('same-key-publish');
    if (request.verb !== 'publish') throw new Error('REPLAY_RACE_PUBLISH_REQUIRED');
    return { ...common, kind: 'agent', request };
  }
  const publication = await f.publish();
  if (operation === 'ask') {
    return { ...common, kind: 'agent', request: {
      ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'same-key-ask', publicationId: publication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'step-one' },
    } };
  }
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' });
  const page = await f.display(publication);
  return { ...common, kind: 'ui', request: {
    ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'same-ui-submission', kind: 'checkpoint',
    value: { checkpointId: 'step-one', outcome: 'pass', words: '' },
  } };
}

async function commit(input: ReplayRaceInput) {
  const child = worker({ ...input, gated: false });
  try {
    const result = await child.result();
    expect(result.result.outcome).toHaveProperty('value');
    return result;
  } finally { await child.stop(); }
}

async function race(f: Fixture, input: ReplayRaceInput, control: string, whileBlocked: () => Promise<unknown>) {
  const before = stored(f), child = worker(input);
  try {
    // READY follows the caller's last current() and blocks before real update.
    const ready = await child.message();
    expect(ready.event).toBe('ready');
    expect(ready.observedRevision).toBe(before.revision);
    if (input.kind === 'agent') expect(ready.expectedRevision).toBe(before.revision);
    expect(ready.replayProvided).toBe(true);
    expect(stored(f)).toEqual(before);
    const winner = await whileBlocked(), sealed = stored(f);
    // Winner completion and a fresh durable read precede this release byte.
    child.release();
    const caller = await child.result(), after = stored(f);
    expect(caller.enter.expectedRevision).toBe(ready.expectedRevision);
    expect(caller.enter.replayProvided).toBe(true);
    expect(caller.result.updateCalls).toBe(1);
    const publish = input.kind === 'agent' && input.request.verb === 'publish';
    expect(caller.result.readPublishedCalls).toBe(publish ? 1 : 0);
    expect(caller.result.snapshotCalls).toBe(publish ? 1 : 0);
    console.log(JSON.stringify({ control, ready, winner, caller,
      revisionBefore: before.revision, revisionSealed: sealed.revision, revisionAfter: after.revision,
      sealedDocumentSha256: createHash('sha256').update(sealed.document).digest('hex'),
      afterDocumentSha256: createHash('sha256').update(after.document).digest('hex') }));
    return { before, sealed, after, caller, winner };
  } finally { await child.stop(); }
}

function changed(input: ReplayRaceInput, scenario: 'conflict' | 'different-key'): ReplayRaceInput {
  if (input.kind === 'ui') {
    if (scenario === 'different-key') return { ...input, request: { ...input.request, submissionId: 'different-ui' } };
    if (input.request.kind !== 'checkpoint') throw new Error('REPLAY_RACE_CHECKPOINT_REQUIRED');
    return { ...input, request: { ...input.request, value: { ...input.request.value, words: 'changed payload' } } };
  }
  if (scenario === 'different-key') return { ...input, request: { ...input.request, idempotencyKey: 'different-agent' } };
  return input.request.verb === 'publish'
    ? { ...input, request: { ...input.request, freeze: { ...input.request.freeze, holdId: 'changed-hold' } } }
    : { ...input, request: { ...input.request, subject: { kind: 'signoff', stage: 'plan-approved' } } };
}

for (const scenario of ['same-capture', 'changed-capture'] as const) {
  test(`#557 backend independent-daemon ${scenario} preserves the first committed BLOB and act bytes`, async () => {
    const f = await jobFixture();
    try {
      const prepared = await rigStillInput(f);
      const input: ReplayRaceInput = {
        options: {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64), reviewer: {id: 'declared-owner', role: 'owner'}},
        context: f.getContext(), gated: true, kind: 'ui', request: prepared.input,
      };
      const contender: ReplayRaceInput = scenario === 'same-capture' ? input : {...input,
        request: {...prepared.input, capture: {...prepared.input.capture, frame: 0.5, animation: 'inspect'}}};
      let committed!: Awaited<ReturnType<typeof commit>>;
      const result = await race(f, contender, 'REVIEW557_' + scenario, async () => {
        committed = await commit(input);
        return committed;
      });
      expect(result.after).toEqual(result.sealed);
      if (scenario === 'same-capture') expect(result.caller.result.outcome).toEqual(committed.result.outcome);
      else expect(result.caller.result.outcome).toEqual({code: 'JOB_IDEMPOTENCY_CONFLICT'});
      const database = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
      try {
        const rows = database.query<{png: Uint8Array; act_bytes: Uint8Array}, []>('SELECT png,act_bytes FROM job_act_stills').all();
        expect(rows).toHaveLength(1);
        expect(Buffer.from(rows[0].png).equals(prepared.bytes)).toBe(true);
        expect(Buffer.from(rows[0].act_bytes).toString('utf8')).toBe(JSON.stringify(committed.result.outcome!.value));
      } finally { database.close(); }
    } finally { await f.close(); }
  });
}

for (const operation of ['publish', 'ask', 'ui'] as const) {
  for (const scenario of ['same-key', 'conflict', 'different-key'] as const) {
    test(`${operation} ${scenario} race resolves durable replay before CAS and preserves the committed row`, async () => {
      const f = await jobFixture();
      try {
        const hashes = await jobInputHashes(f.root), input = await inputFor(f, operation);
        let committed!: Awaited<ReturnType<typeof commit>>;
        const result = await race(f, scenario === 'same-key' ? input : changed(input, scenario),
          `REVIEW540_${operation}_${scenario}`, async () => { committed = await commit(input); return committed; });
        const before = JSON.parse(result.before.document), sealed = JSON.parse(result.sealed.document);
        expect(result.sealed.revision).toBe(result.before.revision + 1);
        expect(sealed.generation).toBe(before.generation + 1);
        expect(sealed.events).toHaveLength(before.events.length + 1);
        expect(Object.keys(sealed.replays)).toHaveLength(Object.keys(before.replays).length + 1);
        for (const [field, changedOperation] of [['publications', 'publish'], ['asks', 'ask'], ['acts', 'ui']] as const) {
          expect(Object.keys(sealed[field])).toHaveLength(Object.keys(before[field]).length + Number(operation === changedOperation));
        }
        expect(committed.result.updateCalls).toBe(1);
        expect(committed.result.readPublishedCalls).toBe(operation === 'publish' ? 1 : 0);
        expect(committed.result.snapshotCalls).toBe(operation === 'publish' ? 1 : 0);
        const replayKey = input.kind === 'agent' ? 'agent:' + input.request.idempotencyKey
          : `ui:${input.request.pageId}:${input.request.submissionId}`;
        expect(sealed.replays[replayKey].value).toEqual(committed.result.outcome!.value);
        expect(result.after).toEqual(result.sealed);
        expect(await jobInputHashes(f.root)).toEqual(hashes);
        if (scenario === 'same-key') expect(result.caller.result.outcome).toEqual(committed.result.outcome);
        else expect(result.caller.result.outcome).toEqual({ code: scenario === 'conflict'
          ? 'JOB_IDEMPOTENCY_CONFLICT' : operation === 'ui' ? 'JOB_ASK_SUPERSEDED' : 'JOB_GENERATION_STALE' });
      } finally { await f.close(); }
    });
  }

  test(`${operation} durable replay precedes changed original source and display freshness`, async () => {
    const f = await jobFixture();
    try {
      const input = await inputFor(f, operation);
      let committed!: Awaited<ReturnType<typeof commit>>;
      const result = await race(f, input, `REVIEW540_${operation}_replay-before-freshness`, async () => {
        committed = await commit(input);
        if (input.kind === 'ui') await f.display(f.session.status().publication!);
        await writeFile(join(f.root, 'record.json'), '{"syntheticPublication":"changed-after-winner"}\n');
        return committed;
      });
      expect(result.caller.result.outcome).toEqual(committed.result.outcome);
      expect(result.after).toEqual(result.sealed);
    } finally { await f.close(); }
  });

  test(`${operation} new mutation rehashes originals after the last current read`, async () => {
    const f = await jobFixture();
    try {
      const input = await inputFor(f, operation);
      const result = await race(f, input, `REVIEW540_${operation}_final-rehash`, async () => {
        await writeFile(join(f.root, 'record.json'), '{"syntheticPublication":"changed-before-lock"}\n');
      });
      expect(result.caller.result.outcome).toEqual({ code: 'JOB_RECORD_MOVED' });
      expect(result.after).toEqual(result.before);
    } finally { await f.close(); }
  });
}

for (const scenario of ['older-generation', 'future-generation', 'rotated-nonce', 'changed-source',
  'changed-head', 'answered-ask', 'unknown-ask', 'closed'] as const) {
  test(`UI ${scenario} is validated on the fresh locked row`, async () => {
    const f = await jobFixture();
    try {
      const input = await inputFor(f, 'ui');
      if (input.kind !== 'ui') throw new Error('REPLAY_RACE_UI_REQUIRED');
      if (scenario === 'future-generation') input.request = { ...input.request,
        expectedGeneration: input.request.expectedGeneration + 2 };
      if (scenario === 'unknown-ask') input.request = { ...input.request, askId: 'unknown-ask' };
      const publication = f.session.status().publication!;
      const result = await race(f, input, `REVIEW540_UI_${scenario}`, async () => {
        switch (scenario) {
          case 'older-generation':
          case 'future-generation':
            return f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
          case 'rotated-nonce': await f.display(publication); return;
          case 'changed-source': {
            const path = join(f.root, 'out/review.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
            await writeFile(path, JSON.stringify({ ...manifest, revision: 'changed-after-current' }));
            return;
          }
          case 'changed-head': return f.publish();
          case 'answered-ask': return f.session.commitUIAct({ ...input.request, submissionId: 'winning-other-submission' });
          case 'closed': return f.session.execute({ ...f.base(), verb: 'close',
            expectedGeneration: f.session.status().generation, idempotencyKey: 'close-during-ui', reason: 'control' },
            new AbortController().signal);
          case 'unknown-ask': return;
        }
      });
      if (scenario === 'older-generation') {
        expect(result.caller.result.outcome).toHaveProperty('value');
        expect(result.after.revision).toBe(result.sealed.revision + 1);
        const data = JSON.parse(result.after.document), before = JSON.parse(result.sealed.document);
        expect(data.generation).toBe(before.generation + 1);
        expect(Object.keys(data.acts)).toHaveLength(1);
        expect(data.asks[input.request.askId].status).toBe('answered');
        expect(Object.values<{ status: string }>(data.asks).filter(ask => ask.status === 'pending')).toHaveLength(1);
        expect(data.pages).toEqual(before.pages);
        expect(result.after.owners).toEqual(result.sealed.owners);
      } else {
        const codes = { 'future-generation': 'JOB_GENERATION_STALE', 'rotated-nonce': 'JOB_DISPLAY_MISMATCH',
          'changed-source': 'JOB_SOURCE_MISMATCH', 'changed-head': 'JOB_ACT_SOURCE_STALE',
          'answered-ask': 'JOB_ASK_SUPERSEDED', 'unknown-ask': 'JOB_ASK_INVALID', 'closed': 'JOB_CLOSED' };
        expect(result.caller.result.outcome).toEqual({ code: codes[scenario] });
        expect(result.after).toEqual(result.sealed);
      }
    } finally { await f.close(); }
  });
}
