import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_API_SCHEMA, type JobAgentRequest, type JobPartsEnumerator, type JobPartsFileReference, type JobPublication, type JobPublicationV3, type JobSubject } from '../../src/job-contract.ts';
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
  partsEnumerator?: JobPartsEnumerator;
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
  let references: readonly JobPartsFileReference[] = [];
  const partsEnumerator = options.partsEnumerator ?? {
    version: '2.25.1', enumerate: () => structuredClone(references),
  };
  const session = new JobSession({
    root, stateDir: state, fingerprint: 'f'.repeat(64), reviewer: { id: 'declared-owner', role: 'owner' },
    ...(options.plain ? {} : { readPublished: async () => structuredClone(context) }),
    partsEnumerator,
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
  async function ask(publication: JobPublication | JobPublicationV3, subject: JobSubject) {
    const response = await call({ ...base(), verb: 'ask', expectedGeneration: session.status().generation,
      idempotencyKey: `ask-${++sequence}`, publicationId: publication.publicationId, subject });
    const result = await response.json();
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value as import('../../src/job-contract.ts').JobPendingAsk;
  }
  async function display(publication: JobPublication | JobPublicationV3) {
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
    scratch, root, state, session, ports, origin, credentials, partsEnumerator, base, call, publishRequest, publish, ask, display, uiRequest,
    setPartsReferences(value: readonly JobPartsFileReference[]) { references = structuredClone(value); },
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
  if (options.project) paths.push('out/parts/body.png', 'out/parts/head.png');
  if (options.painting) paths.push('out/painting_in_rig.png');
  paths.sort();
  for (const path of paths) await writeFile(join(f.root, path), bytes);
  const manifestPath = 'out/parts.json';
  await writeFile(join(f.root, manifestPath), '{"syntheticFixture":"opaque parts source"}\n');
  const parts = {
    enumeratorVersion: f.partsEnumerator.version,
    manifest: { path: manifestPath as 'out/parts.json', sha256: jobHash(await readFile(join(f.root, manifestPath))) },
    images: paths.map(path => ({ path: path.slice('out/'.length),
      role: path.includes('alternate') ? 'alternate' : path.includes('depth') ? 'depth' :
        path.endsWith('painting_in_rig.png') ? 'painting' : 'part', sha256: jobHash(bytes) })),
  };
  f.setPartsReferences(parts.images.map(({path, role}) => ({path, role})));
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

/** Fixed-input canonical regression sample. Expected bytes were captured at release 8e1e3387. */
export async function collect606Canonical() {
  const {setSystemTime, spyOn} = await import('bun:test');
  const crypto = await import('node:crypto');
  const {captureJobRoot, prepareJobRecordSource} = await import('../../src/job-source.ts');
  const {bindJobAsk, finalizeJobAct} = await import('../../src/job-act.ts');
  const {serializeRecordSourceDigestPayload} = await import('../../src/job-api.ts');
  const {loadReview} = await import('../../src/manifest.ts');
  const {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader, makeSyntheticPngBytes,
    writeWorkspaceFile} = await import('./job-record-fixture.ts');
  const samples: Record<string, {sourceBytes:string; preimage:string; sourceHash:string; actBytes:string;durableActBytes:string;replayActBytes:string;reopenedActBytes:string;durableSourceBytes:string}> = {};
  const at = '2026-11-01T00:00:00.000Z';
  setSystemTime(new Date(at));
  try {
    for (const kind of ['package', 'record'] as const) {
      for (const withEvidence of [false, true]) {
        const f = await jobFixture();
        try {
          let retained: import('../../src/job-source.ts').JobRetainedSourceV3;
          let context: any = f.getContext();
          let recordFixture: ReturnType<typeof createSyntheticPlanRecordWorkspace> | undefined;
          if (kind === 'record') {
            const recordRoot = join(f.scratch, 'record');
            await mkdir(recordRoot);
            recordFixture = createSyntheticPlanRecordWorkspace(recordRoot);
            context = recordFixture.context;
          }
          const inputRoot = recordFixture?.root ?? f.root;
          const checkpointId = kind === 'record' ? 'step_layout' : 'step-one';
          if (withEvidence) {
            const tile = writeWorkspaceFile(inputRoot, 'evidence/golden.png', makeSyntheticPngBytes(10, 100, 200));
            const table = writeWorkspaceFile(inputRoot, 'evidence/golden.json',
              '{"schema":"rig-review-checkpoint-table/1","columns":["Exact"],"rows":[["한글\\nvalue"]]}');
            context = {...context, files:[...context.files, tile, table].sort((a:any,b:any) => a.path < b.path ? -1 : 1),
              checkpointEvidence:[{schema:'rig-review-checkpoint-evidence/1', checkpointId, planStepId:checkpointId,
                tiles:[{id:'tile',label:'Exact tile',...tile}],table,
                routesText:'Pass or fail',recommendationText:'Exact recommendation'}]};
          }
          if (kind === 'record') {
            const {reader} = createSyntheticRecordReader({onPlan:() => structuredClone(context)});
            retained = await prepareJobRecordSource({root:captureJobRoot(inputRoot), stateRoot:f.state,
              fingerprint:'golden-record', request:{freeze:{kind:'producer-held',holdId:'golden',record:recordFixture!.record},
                result:recordFixture!.result}, readRecordPublished:reader});
          } else {
            f.setContext(context);
            const publication = await f.publish();
            retained = f.session.retainedSource(publication.publicationId);
          }
          const source = retained.source;
          let preimage: string;
          if (kind === 'record') preimage = serializeRecordSourceDigestPayload(source as any);
          else {
            const review = await loadReview(join(f.root, 'out'));
            preimage = JSON.stringify({schema:'rig-review-job-source/2',packageSourceHash:review.sourceHash,
              record:retained.record,selector:context.selector,plan:context.plan,parts:source.parts,files:retained.seals,
              ...(withEvidence ? {checkpointEvidence:context.checkpointEvidence} : {})});
          }
          const subject = {kind:'checkpoint' as const,checkpointId};
          const ask = {askId:'golden-ask',publicationId:'golden-publication',subject,
            source:bindJobAsk(subject,retained),status:'pending' as const};
          const submission = {kind:'checkpoint' as const,publicationId:ask.publicationId,askId:ask.askId,
            pageId:'golden-page',displayedNonce:'golden-nonce',expectedGeneration:2,submissionId:'golden-submission',
            value:{checkpointId,outcome:'pass' as const,words:'  Exact 한글\n'}};
          const fixedId = '12345678-1234-4abc-8def-123456789abc';
          const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(fixedId);
          let act: ReturnType<typeof finalizeJobAct>;
          let durable: Awaited<ReturnType<typeof collect606Durable>>;
          try {
            act = finalizeJobAct({jobId:'golden-job',submission,ask,retained,
              reviewer:{id:'owner',role:'owner'},actId:fixedId,at});
            durable = await collect606Durable(f,kind,context,recordFixture);
          } finally {uuid.mockRestore();}
          if (act.actId !== fixedId || act.at !== at) throw new Error('Golden runtime variables were not fixed');
          samples[kind + (withEvidence ? '-evidence' : '-absent')] = {
            sourceBytes:JSON.stringify(source),preimage,sourceHash:source.sourceHash,actBytes:JSON.stringify(act),...durable!};
        } finally {await f.close();}
      }
    }
    return {samples,publicExports:Object.keys(await import('../../src/job-host.ts')).sort()};
  } finally {setSystemTime();}
}

async function collect606Durable(f: Awaited<ReturnType<typeof jobFixture>>, kind:'package'|'record', context:any,
  recordFixture: {root:string;record:{path:'project.json';sha256:string};result:{kind:'plan'}} | undefined) {
  const {JobSession} = await import('../../src/job-session.ts');
  const {createJobHostPorts, jobHash} = await import('../../src/job-api.ts');
  const {JOB_RECORD_READER_ID} = await import('../../src/job-contract.ts');
  const {Database} = await import('bun:sqlite');
  const inputRoot = recordFixture?.root ?? f.root;
  const stateDir = join(f.scratch,'durable-state');
  const options = {root:inputRoot,stateDir,fingerprint:'fixed-durable',reviewer:{id:'owner',role:'owner' as const},
    ...(kind === 'record' ? {recordReaderId:JOB_RECORD_READER_ID,publicationMode:'record-and-package' as const,
      readRecordPublished:(() => structuredClone(context)) as any} : {readPublished:async() => structuredClone(context)})};
  const session = new JobSession(options);
  let reopened: InstanceType<typeof JobSession> | undefined;
  try {
    const origin = 'http://127.0.0.1:19484';
    const ports = createJobHostPorts(session,origin), credentials = session.hostCredentials();
    const schema = kind === 'record' ? 'rig-review/job-api@3' : 'rig-review/job-api@2';
    const call = async (request:any) => {
      const response = await ports.handleJobApi(new Request(origin+'/jobs/'+session.jobId+'/api',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credentials.agent},
        body:JSON.stringify({schema,jobId:session.jobId,...request})}));
      const result = await response.json();
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    };
    const record = recordFixture?.record ?? {path:'record.json',sha256:jobHash(await readFile(join(f.root,'record.json')))};
    const publication = await call({requestId:'publish',verb:'publish',expectedGeneration:0,idempotencyKey:'publish',
      freeze:{kind:'producer-held',holdId:'golden',record},result:recordFixture?.result ?? {path:'out',selector:context.selector}});
    const {retainedPublicationRoutes} = await import('../../src/job-front.ts');
    const metadata = await retainedPublicationRoutes(session)(session.jobId,publication.publicationId,
      publication.instanceKey,'api/review',new Request(origin+'/api/review'));
    if (metadata.status !== 200) throw new Error('Golden metadata read failed: '+await metadata.text());
    await metadata.text();
    const checkpointId = kind === 'record' ? 'step_layout' : 'step-one';
    const ask = await call({requestId:'ask',verb:'ask',expectedGeneration:1,idempotencyKey:'ask',
      publicationId:publication.publicationId,subject:{kind:'checkpoint',checkpointId}});
    const displayed = await ports.ackDisplayed(session.jobId,new Request(origin+'/jobs/'+session.jobId+'/ui/displayed',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':credentials.ui},
      body:JSON.stringify({publicationId:publication.publicationId,pageId:'page',sourceHash:publication.source.sourceHash})}));
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));
    const submission = {kind:'checkpoint',publicationId:publication.publicationId,askId:ask.askId,pageId:'page',
      displayedNonce:displayed.value.displayedNonce,expectedGeneration:2,submissionId:'fixed-submission',
      value:{checkpointId,outcome:'pass',words:'  Exact 한글\n'}};
    const commit = () => ports.commitUIAct(session.jobId,new Request(origin+'/jobs/'+session.jobId+'/ui/acts',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':credentials.ui},body:JSON.stringify(submission)}));
    const act = await commit();
    if (!act.ok) throw new Error(JSON.stringify(act));
    const replay = await commit();
    if (!replay.ok) throw new Error(JSON.stringify(replay));
    const db = new Database(join(stateDir,'jobs.sqlite'),{readonly:true});
    let document:any;
    try {document = JSON.parse((db.query('SELECT document FROM jobs WHERE job_id=?').get(session.jobId) as any).document);}
    finally {db.close();}
    const durableActBytes = JSON.stringify(document.acts[act.value.actId]);
    const durableSourceBytes = JSON.stringify(document.publications[publication.publicationId].retained.source);
    session.dispose();
    reopened = new JobSession(options);
    return {durableActBytes,durableSourceBytes,replayActBytes:JSON.stringify(replay.value),
      reopenedActBytes:reopened.readActExport(act.value.actId,false).toString()};
  } finally {reopened?.dispose();session.dispose();}
}
