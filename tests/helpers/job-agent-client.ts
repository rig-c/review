/** Disposable process controls. Store modes run as trusted daemon test children.
 * The agent mode uses only semantic HTTP after proving a different UID cannot
 * read the actual daemon state. It never opens an internal Review document.
 */
import { readFile, readdir } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { join } from 'node:path';

const mode = Bun.argv[2];

if (mode === 'sqlite-crash') {
  const { Database } = await import('bun:sqlite');
  const database = new Database(join(Bun.argv[3], 'jobs.sqlite'));
  database.exec('PRAGMA synchronous=FULL; PRAGMA cache_size=1; BEGIN IMMEDIATE;');
  const row = database.query<{ document: string }, [string]>('SELECT document FROM jobs WHERE job_id=?').get(Bun.argv[4])!;
  const data = JSON.parse(row.document);
  data.events = ['uncommitted'];
  data.receipt = 'x'.repeat(100_000);
  database.query('UPDATE jobs SET document=? WHERE job_id=?').run(JSON.stringify(data), Bun.argv[4]);
  writeSync(1, 'SQL_WRITE_BEFORE_SIGKILL\n');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'commit-act-crash') {
  const { JobSession } = await import('../../src/job-session.ts');
  const input = JSON.parse(await Bun.stdin.text());
  const session = new JobSession(input.options);
  const act = await session.commitUIAct(input.submission);
  writeSync(1, JSON.stringify({ committedActId: act.actId }) + '\n');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'subscription-server') {
  const { JobSession } = await import('../../src/job-session.ts');
  const input = JSON.parse(await Bun.stdin.text());
  const session = new JobSession(input.options);
  let cancellations = 0, completions = 0;
  const encoder = new TextEncoder();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/events') {
      const abort = new AbortController();
      const cancel = () => { if (!abort.signal.aborted) { cancellations++; abort.abort(); } };
      request.signal.addEventListener('abort', cancel, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Deliberately unhandled if the iterator wrongly rejects ordinary
          // disconnect. The parent must observe actual process survival.
          void (async () => {
            for await (const event of session.subscribe({ jobId: session.jobId,
              after: session.status().cursor, signal: abort.signal })) {
              controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
            }
            completions++;
            writeSync(1, 'SUBSCRIPTION_COMPLETED\n');
            if (!abort.signal.aborted) controller.close();
          })();
          controller.enqueue(encoder.encode(': connected\n\n'));
        },
        cancel,
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path === '/health') return Response.json({ alive: true, cancellations, completions });
    if (path === '/shutdown') {
      setTimeout(() => { server.stop(true); session.dispose(); }, 10);
      return Response.json({ stopping: true });
    }
    return new Response(null, { status: 404 });
  } });
  writeSync(1, JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }) + '\n');
} else if (mode === 'agent') {
  const input = JSON.parse(await Bun.stdin.text());
  const denied = async (operation: () => Promise<unknown>) => {
    try { await operation(); return false; }
    catch (error) { return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''); }
  };
  const uid = process.getuid!();
  const directoryDenied = await denied(() => readdir(input.stateDir));
  const databaseDenied = await denied(() => readFile(join(input.stateDir, 'jobs.sqlite')));
  writeSync(1, JSON.stringify({ identity: { uid, daemonUid: input.daemonUid, directoryDenied, databaseDenied } }) + '\n');
  if (uid === input.daemonUid || !directoryDenied || !databaseDenied) {
    writeSync(2, JSON.stringify({ error: { code: 'JOB_AGENT_ISOLATION_HOLE' } }) + '\n');
    process.exit(3);
  }
  let request = 0;
  const invoke = async (value: Record<string, unknown>) => {
    const response = await fetch(input.origin + '/jobs/' + input.jobId + '/api', {
      method: 'POST', redirect: 'error', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + input.agentCapability,
      }, body: JSON.stringify({ schema: 'rig-review/job-api@2', jobId: input.jobId, requestId: 'agent-' + (++request), ...value }),
    });
    const result = await response.json();
    writeSync(1, JSON.stringify({ flow: { verb: value.verb, ok: result.ok, generation: result.generation } }) + '\n');
    if (!result.ok) throw new Error(result.error.code);
    return result;
  };
  const publish = (generation: number, key: string) => invoke({ verb: 'publish', expectedGeneration: generation,
    idempotencyKey: key, result: { path: 'out', selector: { kind: 'rig', version: 1 } },
    freeze: { kind: 'producer-held', holdId: 'agent-fixture-freeze', record: input.record } });
  const first = await publish(0, 'agent-first');
  const asked = await invoke({ verb: 'ask', expectedGeneration: first.generation, idempotencyKey: 'agent-ask',
    publicationId: first.value.publicationId, subject: { kind: 'checkpoint', checkpointId: 'step-one' } });
  let next = await invoke({ verb: 'next', after: null, waitMs: 0 });
  let event = next.value.events.find((event: { type: string }) => event.type === 'act');
  while (!event) {
    next = await invoke({ verb: 'next', after: next.value.cursor, waitMs: 30_000 });
    event = next.value.events.find((event: { type: string }) => event.type === 'act');
  }
  writeSync(1, JSON.stringify({ receivedAct: { actId: event.act.actId, kind: event.act.kind,
    sourceHash: event.act.source.sourceHash, authority: event.act.authority } }) + '\n');
  const second = await publish(next.generation, 'agent-second');
  await invoke({ verb: 'close', expectedGeneration: second.generation, idempotencyKey: 'agent-close', reason: 'explicit completion' });
  writeSync(1, JSON.stringify({ completed: true, actId: event.act.actId, schema: event.act.schema,
    texts: event.act.value.comments.map((comment: {text: string}) => comment.text),
    firstPublication: first.value.publicationId, secondPublication: second.value.publicationId, askId: asked.value.askId }) + '\n');
} else throw new Error('Unknown process control mode');
