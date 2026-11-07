import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createJobHostPorts, jobHash } from '../src/job-api.ts';
import { JobError } from '../src/job-store.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';

function isolationHole(detail: string): never {
  throw new JobError('JOB_AGENT_ISOLATION_HOLE', 'JOB_AGENT_ISOLATION_HOLE: ' + detail);
}

const requiredInCI = process.env.CI === 'true';
const daemonUid = process.getuid?.();
const asRoot = daemonUid === 0;
const identityCommand = asRoot ? ['id', '-u', 'nobody'] : ['sudo', '-n', '-u', 'nobody', 'id', '-u'];
let agentUid: number | undefined;
let launcherDetail = 'POSIX identity is unavailable';
if (daemonUid !== undefined) {
  try {
    const identity = Bun.spawn(identityCommand, { stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([
      identity.exited, new Response(identity.stdout).text(), new Response(identity.stderr).text(),
    ]);
    console.log(JSON.stringify({ mechanism: identityCommand.join(' '), daemonUid, exitCode: exit, stdout, stderr }));
    const candidate = Number(stdout.trim());
    if (exit === 0 && stdout.trim() && Number.isInteger(candidate) && candidate !== daemonUid) agentUid = candidate;
    launcherDetail = `${identityCommand.join(' ')} exited ${exit}: ${stderr.trim() || 'no different UID'}`;
  } catch {
    launcherDetail = 'The declared separate-UID launcher could not start';
  }
}
if (agentUid === undefined && !requiredInCI) {
  console.error(`JOB_AGENT_ISOLATION_HOLE — LOCAL SKIP — missing launcher — ${launcherDetail}. No isolation evidence or PASS.`);
}

/** Both positive and negative cases execute this same semantic client helper.
 * The negative uses the actual daemon UID and must stop at the identity/read
 * assertion before the live API flow. No simulated UID or chmod substitute.
 */
async function runFlow(ownUid: boolean) {
  const f = await jobFixture();
  const publicClient = await mkdtemp(join(realpathSync('/tmp'), 'review-job-public-client-'));
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let ports: ReturnType<typeof createJobHostPorts>;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch: request => ports.handleJobApi(request) });
  const origin = `http://127.0.0.1:${server.port}`;
  ports = createJobHostPorts(f.session, origin);
  const pendingAbort = new AbortController();
  try {
    // Only this disposable client directory becomes traversable. Actual daemon
    // state permissions stay unchanged, including for the own-UID negative.
    await chmod(publicClient, 0o755);
    const binary = join(publicClient, 'bun'), helper = join(publicClient, 'client.ts');
    await copyFile(process.execPath, binary);
    await chmod(binary, 0o755);
    await copyFile(join(import.meta.dir, 'helpers/job-agent-client.ts'), helper);
    await chmod(helper, 0o644);
    expect((await readFile(join(f.state, 'jobs.sqlite'))).length).toBeGreaterThan(0);
    const direct = ownUid || asRoot;
    const command = direct ? [binary, helper, 'agent'] : ['sudo', '-n', '-u', 'nobody', binary, helper, 'agent'];
    child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      ...(!ownUid && asRoot ? { uid: agentUid } : {}) });
    child.stdin.write(JSON.stringify({ origin, jobId: f.session.jobId, agentCapability: f.credentials.agent,
      daemonUid, stateDir: f.state,
      record: { path: 'record.json', sha256: jobHash(await readFile(join(f.root, 'record.json'))) } }));
    child.stdin.end();
    const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
    const pending = (async () => {
      for await (const event of ports.subscribeJob({ jobId: f.session.jobId, after: null,
        signal: AbortSignal.any([pendingAbort.signal, AbortSignal.timeout(10_000)]) })) {
        if (event.type === 'pending') return event.ask;
      }
      throw new Error('No pending UI act');
    })();
    const outcome = await Promise.race([
      pending.then(ask => ({ kind: 'pending' as const, ask })),
      child.exited.then(async exit => ({ kind: 'exited' as const, exit, stdout: await output, stderr: await errors })),
    ]);
    if (outcome.kind === 'pending') {
      const source = f.session.status().publication!;
      const ui = (path: string, body: unknown) => new Request(origin + `/jobs/${f.session.jobId}/ui/` + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui },
        body: JSON.stringify(body),
      });
      const displayed = await ports.ackDisplayed(f.session.jobId, ui('displayed', {
        publicationId: source.publicationId, pageId: 'isolated-page', sourceHash: source.source.sourceHash,
      }));
      expect(displayed.ok).toBe(true);
      if (!displayed.ok) throw new Error(displayed.error.code);
      const saved = await ports.commitUIAct(f.session.jobId, ui('acts', { ...displayed.value,
        askId: outcome.ask.askId, submissionId: 'isolated-ui', expectedGeneration: f.session.status().generation,
        kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: 'isolated exact words' } }));
      expect(saved.ok).toBe(true);
    }
    const [exit, stdout, stderr] = await Promise.all([child.exited, output, errors]);
    console.log(JSON.stringify({ ownUid, exitCode: exit }));
    console.log(stdout);
    if (stderr) console.error(stderr);
    const messages = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!messages.some(message => message.identity)) isolationHole('The selected UID could not start the semantic client');
    return { exit, stdout, stderr, messages, status: f.session.status().status };
  } finally {
    pendingAbort.abort();
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    server.stop(true);
    await f.close();
    await rm(publicClient, { recursive: true, force: true });
  }
}

test.skipIf(agentUid === undefined && !requiredInCI)(
  'a genuinely different UID drives semantic API with daemon state unreadable to that agent', async () => {
    if (agentUid === undefined) isolationHole(launcherDetail);
    const result = await runFlow(false);
    expect(result.stderr).toBe('');
    expect(result.exit).toBe(0);
    expect(result.messages.find(message => message.identity).identity).toEqual({
      uid: agentUid, daemonUid, directoryDenied: true, databaseDenied: true,
    });
    for (const verb of ['publish', 'ask', 'next', 'close']) {
      expect(result.messages.some(message => message.flow?.verb === verb && message.flow.ok)).toBe(true);
    }
    const received = result.messages.find(message => message.receivedAct)?.receivedAct;
    expect(received.actId).toBeTruthy();
    expect(received.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const completed = result.messages.find(message => message.completed);
    expect(completed.words).toBe('isolated exact words');
    expect(completed.firstPublication).not.toBe(completed.secondPublication);
    expect(result.status).toBe('closed');
  }, 30_000,
);

test.skipIf(daemonUid === undefined && !requiredInCI)('POSIX own-UID negative fails the same semantic client by JOB_AGENT_ISOLATION_HOLE', async () => {
  if (daemonUid === undefined) isolationHole('POSIX identity is unavailable for the required negative');
  const result = await runFlow(true);
  expect(result.exit).not.toBe(0);
  expect(result.stderr).toContain('JOB_AGENT_ISOLATION_HOLE');
  expect(result.messages.find(message => message.identity).identity).toEqual({
    uid: daemonUid, daemonUid, directoryDenied: false, databaseDenied: false,
  });
  expect(result.messages.some(message => message.flow || message.completed)).toBe(false);
}, 30_000);
