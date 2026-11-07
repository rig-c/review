import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_API_SCHEMA, type JobAgentRequest, type JobPublication, type JobSubject } from '../../src/job-contract.ts';
import { createJobHostPorts, jobHash } from '../../src/job-api.ts';
import { JobSession } from '../../src/job-session.ts';
import type { JobPublishedContext } from '../../src/job-source.ts';

/** All metadata here is explicitly synthetic trusted-host fixture data. It
 * establishes no Create #184 producer path or Parts #1163 acceptance evidence.
 * Runtime capabilities stay in disposable private state and are never printed.
 */
export async function jobFixture(options: {
  afterSnapshot?: (root: string) => void | Promise<void>;
  afterDirectorySync?: (path: string) => void;
  plain?: boolean;
} = {}) {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-job-'));
  const root = join(scratch, 'input'), state = join(scratch, 'state');
  await mkdir(root);
  await cp(new URL('../fixtures/viewport-387/package', import.meta.url), join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'record.json'), '{"syntheticPublication":1}\n');
  let context: JobPublishedContext = {
    selector: { kind: 'rig', version: 1 },
    plan: { steps: [{ id: 'step-one', hash: '1'.repeat(64) }] },
    parts: null,
    subjects: [
      { kind: 'checkpoint', checkpointId: 'step-one' },
      { kind: 'signoff', stage: 'plan-approved' },
      { kind: 'signoff', stage: 'rigging-interview' },
      { kind: 'signoff', stage: 'post-interview' },
    ],
    partIds: [], files: [],
  };
  const session = new JobSession({
    root, stateDir: state, fingerprint: 'f'.repeat(64), reviewer: { id: 'declared-owner', role: 'owner' },
    ...(options.plain ? {} : { readPublished: async () => structuredClone(context) }),
    afterSnapshot: () => options.afterSnapshot?.(root),
    afterDirectorySync: options.afterDirectorySync,
  });
  const origin = 'http://127.0.0.1:19484', ports = createJobHostPorts(session, origin);
  const credentials = session.hostCredentials();
  let sequence = 0;
  let recordPath = 'record.json';
  const base = () => ({ schema: JOB_API_SCHEMA, jobId: session.jobId, requestId: `request-${++sequence}` });
  async function call(request: unknown, token = credentials.agent, signal?: AbortSignal) {
    return ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(request), signal,
    }));
  }
  async function publishRequest(key = `publish-${++sequence}`): Promise<JobAgentRequest> {
    return {
      ...base(), verb: 'publish', expectedGeneration: session.status().generation, idempotencyKey: key,
      result: { path: 'out', selector: context.selector },
      freeze: { kind: 'producer-held', holdId: 'synthetic-held-freeze',
        record: { path: recordPath, sha256: jobHash(await readFile(join(root, recordPath))) } },
    };
  }
  async function publish(): Promise<JobPublication> {
    const response = await call(await publishRequest());
    const result = await response.json();
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  }
  async function ask(publication: JobPublication, subject: JobSubject) {
    const response = await call({ ...base(), verb: 'ask', expectedGeneration: session.status().generation,
      idempotencyKey: `ask-${++sequence}`, publicationId: publication.publicationId, subject });
    const result = await response.json();
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value as import('../../src/job-contract.ts').JobPendingAsk;
  }
  async function display(publication: JobPublication) {
    const response = await ports.ackDisplayed(session.jobId, new Request(origin + `/jobs/${session.jobId}/ui/displayed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': credentials.ui },
      body: JSON.stringify({ publicationId: publication.publicationId, pageId: 'page-one', sourceHash: publication.source.sourceHash }),
    }));
    if (!response.ok) throw new Error(JSON.stringify(response));
    return response.value;
  }
  function uiRequest(value: unknown, token = credentials.ui, sentOrigin = origin) {
    return new Request(origin + `/jobs/${session.jobId}/ui/acts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: sentOrigin, 'X-Review-Capability': token },
      body: JSON.stringify(value),
    });
  }
  return {
    scratch, root, state, session, ports, origin, credentials, base, call, publishRequest, publish, ask, display, uiRequest,
    setContext(value: JobPublishedContext) { context = value; },
    setRecordPath(value: string) { recordPath = value; },
    getContext() { return structuredClone(context); },
    async close() { session.dispose(); await rm(scratch, { recursive: true, force: true }); },
  };
}

/** Opaque synthetic manifest plus a predeclared trusted-reader result. This
 * fixture does not implement or establish Parts' public enumerator contract.
 */
export async function syntheticJobParts(f: Awaited<ReturnType<typeof jobFixture>>, options: {
  project?: boolean;
  painting?: boolean;
} = {}) {
  await mkdir(join(f.root, 'out/parts'));
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  const paths = ['out/parts/base.png', 'out/parts/alternate.png', 'out/parts/depth.png'];
  if (options.painting) paths.push('out/painting_in_rig.png');
  paths.sort();
  for (const path of paths) await writeFile(join(f.root, path), bytes);
  const manifestPath = 'out/parts.json';
  await writeFile(join(f.root, manifestPath), '{"syntheticFixture":"opaque parts source"}\n');
  const parts = {
    manifest: { path: manifestPath as 'out/parts.json', sha256: jobHash(await readFile(join(f.root, manifestPath))) },
    images: paths.map(path => ({ path: path as import('../../src/job-contract.ts').JobPartImagePath, sha256: jobHash(bytes) })),
  };
  const context = f.getContext();
  if (options.project) {
    await writeFile(join(f.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{}}\n');
    f.setRecordPath('project.json');
    f.setContext({ ...context, selector: { kind: 'draft', id: 'synthetic-draft' }, parts,
      subjects: [{ kind: 'parts-verdict', draftId: 'synthetic-draft' }], partIds: ['body', 'head'] });
  } else f.setContext({ ...context, parts });
  return parts;
}

export async function jobInputHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(prefix: string): Promise<void> {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path);
      else hashes[path] = jobHash(await readFile(join(root, path)));
    }
  }
  await visit('');
  return hashes;
}
