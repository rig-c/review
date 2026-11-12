/**
 * Install smoke: what an agent gets from `npm i -D @rig-c/review`, not what a checkout has.
 * Packs this tree by default, or installs a published --spec from the registry
 * without packing the checkout. Installs the selected package into an empty project, then runs the installed bin:
 * help, `check` on the bundled demo, and a served page whose browser bundle is built from the
 * installed `web/` against the installed `@rig-c/play`. A file missing from `files` fails here.
 * Internal packs skip lifecycle scripts and override inherited dry-run, as does the empty install.
 * Registry, authentication and cache settings stay with the caller.
 * CI publishes this output, so every line goes through `log`, which redacts the `#cap=` value.
 */
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import {leaksCapability,redactCapability} from './redact.ts';
import {createHash} from 'node:crypto';
import {installedWorkspaceSmoke} from './installed-workspace-smoke.ts';
import {installedJobHubSmoke} from './installed-job-hub-smoke.ts';
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--spec' || !/^@rig-c\/review@[^\s/:]+$/.test(args[1]!))) {
 console.error('SMOKE_SPEC_INVALID: expected --spec @rig-c/review@<version-or-tag>');process.exit(1);
}
const spec=args[1];
const root=new URL('..',import.meta.url).pathname,work=await mkdtemp(join(tmpdir(),'rig-review-smoke-')),app=join(work,'app');
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {name:string;bin:Record<string,string>;devDependencies:{typescript:string;'@types/bun':string}};
let failed=false;const printed:string[]=[];let servedCapability='';
/** The one writer of this script's stdout. */
function log(line:string){const safe=redactCapability(line);printed.push(safe);console.log(safe);}
interface PackResult {filename:string;files:{path:string}[]}
/** npm <= 11 prints an array of results; npm 12 prints an object keyed by package name. Anything else is refused by name. */
function packResult(value:unknown,name:string):PackResult{
 const entry=Array.isArray(value)?(value.length===1?value[0]:undefined):value&&typeof value==='object'?(value as Record<string,unknown>)[name]:undefined;
 const result=entry as Partial<PackResult>|undefined;
 if(!result||typeof result.filename!=='string'||!Array.isArray(result.files))throw new Error(`SMOKE_PACK_JSON: unrecognised npm pack --json output: ${JSON.stringify(value).slice(0,200)}`);
 return result as PackResult;
}
function step(name:string,ok:boolean,detail=''){log(`${ok?'ok  ':'FAIL'} ${name}${detail?' · '+detail:''}`);if(!ok)failed=true;return ok;}
async function run(cmd:string[],cwd:string,extra:Record<string,string>={}){const child=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state'),...extra}});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}
function firstLine(stream: Readable): Promise<string> {
 return new Promise((resolve,reject)=>{
  let text='';
  const finish=(error?:Error)=>{
   clearTimeout(timer);stream.off('data',data);stream.off('end',ended);stream.off('error',failed);
   if(error)reject(error);else resolve(text.slice(0,text.indexOf('\n')).trim());
  };
  const data=(chunk:Buffer)=>{text+=chunk.toString('utf8');if(text.includes('\n'))finish();};
  const ended=()=>finish(new Error('SMOKE_SESSION_START'));
  const failed=(error:Error)=>finish(error);
  const timer=setTimeout(()=>finish(new Error('SMOKE_SESSION_TIMEOUT')),30_000);
  stream.on('data',data);stream.once('end',ended);stream.once('error',failed);
 });
}

/** Compiled and executed from the empty installed project through the public specifier. */
const publicHostConsumer = `
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {PNG} from 'pngjs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {
 startJobHost, assertJobImageSetCapability, JOB_CAPABILITIES, JOB_API_SCHEMA, JOB_ACT_SCHEMA, JOB_PARTS_ENUMERATOR_RANGE, JOB_ENABLED_ACT_KINDS,
 JOB_RESERVED_ACT_KINDS, JOB_PLAN_BOUND_SIGNOFF_STAGES, JOB_CONSUMER_AUTH_MODE, JOB_ERROR_CODES,
 type JobHostOptions, type JobOwnerHost, type JobSessionOptions, type JobSession, type JobWorkerOptions,
 type JobHostListenerIncarnation, type JobHostReuseBinding, type JobHostReuseExpectation, type JobHostAttachField, type JobHostAttachFailure,
 type JobPublicationReader, type JobPublishedContext, type JobCapabilities, type JobImageSetInput,
 type JobImageSet, type JobImageSourceBinding, type JobModelSourceBinding, type JobModelReviewValue, type JobImageReviewValue,
 type JobEnabledActKind, type JobReservedActKind, type JobActKind, type JobSha256,
 type JobId, type JobPublicationId, type JobAskId, type JobActId, type JobCursor,
 type JobFileIdentity, type JobPlanStepIdentity, type JobPlanIdentity,
 type JobPartsManifestPath, type JobPartImagePath, type JobPartsIdentity,
 type JobPartsRole, type JobPartsFileReference, type JobPartsEnumerator, type JobSelector,
 type JobSourceBinding, type JobReviewerBinding, type JobHumanAuthority, type JobVerdict,
 type JobPartOutcome, type JobReviewStage, type JobActValues, type JobUIActValues,
 type JobActSources, type JobAct, type JobSubject, type JobPendingAsk,
 type JobInterviewJson, type JobInterviewRecord, type JobInterviewDiagnostic, type JobInterviewDiagnostics,
 type JobPublication,
 type JobStatus, type JobPublishRequest, type JobAskRequest, type JobNextRequest,
 type JobCloseRequest, type JobAgentRequest, type JobFetchActRequest, type JobErrorCode,
 type JobFailure, type JobResult, type JobEvent, type JobNextValue, type JobResponseValues,
 type JobApiResponse, type JobUISubmission, type JobDisplayAcknowledgment, type JobDisplayReceipt,
 type JobDisplayPublication, type JobHostPorts, type JobConsumerGrant,
 type JobRecordAct, type JobActV3, type JobPlanSource, type JobFetchActRequestV3, type JobRecordHostHooks,
 type JobRecordReopenSubject, type JobRecordReopenValue, type JobUISubmissionV3,
 type RecordSignoffStage, type JobRecordSignoffSubject, type JobRecordSignoffValue,
 type JobComment, type JobCommentAnchor, type JobCommentFeedbackAnchor, type JobCommentPartsAnchor, type JobCommentImageAnchor,
 type JobCommentsAct, type JobCommentsActValues, type ReviewCommentsSession, type CompareCommentsSession, type PartsCommentsVerdict,
 type JobCommentContext, type JobContextComment, type JobContextCommentsAct,
} from '@rig-c/review/job-host';
import * as publicHost from '@rig-c/review/job-host';

export type PublicTypes = [
 JobHostOptions, JobOwnerHost, JobSessionOptions, JobSession, JobWorkerOptions,
 JobHostListenerIncarnation, JobHostReuseBinding, JobHostReuseExpectation, JobHostAttachField, JobHostAttachFailure,
 JobPublicationReader, JobPublishedContext, JobCapabilities, JobImageSetInput, JobImageSet,
 JobImageSourceBinding, JobModelSourceBinding, JobModelReviewValue, JobImageReviewValue,
 JobEnabledActKind, JobReservedActKind, JobActKind, JobSha256, JobId, JobPublicationId,
 JobAskId, JobActId, JobCursor, JobFileIdentity, JobPlanStepIdentity, JobPlanIdentity,
 JobPartsManifestPath, JobPartImagePath, JobPartsIdentity, JobPartsRole, JobPartsFileReference, JobPartsEnumerator, JobSelector, JobSourceBinding,
 JobReviewerBinding, JobHumanAuthority, JobVerdict, JobPartOutcome, JobReviewStage,
 JobActValues, JobUIActValues, JobActSources, JobAct, JobSubject, JobPendingAsk,
 JobInterviewJson, JobInterviewRecord, JobInterviewDiagnostic, JobInterviewDiagnostics,
 JobPublication, JobStatus, JobPublishRequest, JobAskRequest, JobNextRequest,
 JobCloseRequest, JobAgentRequest, JobFetchActRequest, JobErrorCode, JobFailure,
 JobResult<JobStatus>, JobEvent, JobNextValue, JobResponseValues, JobApiResponse,
 JobUISubmission, JobDisplayAcknowledgment, JobDisplayReceipt, JobDisplayPublication,
 JobHostPorts, JobConsumerGrant,
 JobRecordAct, JobActV3, JobPlanSource, JobFetchActRequestV3, JobRecordHostHooks,
 JobRecordReopenSubject, JobRecordReopenValue, JobUISubmissionV3,
 JobComment, JobCommentAnchor, JobCommentFeedbackAnchor, JobCommentPartsAnchor, JobCommentImageAnchor,
 JobCommentsAct, JobCommentsActValues, ReviewCommentsSession, CompareCommentsSession, PartsCommentsVerdict,
 JobCommentContext, JobContextComment, JobContextCommentsAct,
];
// Review #713: JobAct admits fresh act@6 comments acts from the UI writers.
export type JobActAdmitsComments = JobCommentsAct extends JobAct ? true : never;
const jobActAdmitsComments: JobActAdmitsComments = true;
function assert(ok: unknown, name: string): asserts ok {
 if (!ok) throw new Error('SMOKE_PUBLIC_HOST_' + name);
}
assert(jobActAdmitsComments, 'JOB_ACT_ADMITS_COMMENTS');
const expectedExports = ['assertJobImageSetCapability', 'JOB_CAPABILITIES', 'startJobHost', 'startJobHub', 'JOB_API_SCHEMA', 'JOB_API_V3_SCHEMA', 'JOB_ACT_SCHEMA', 'JOB_RECORD_ACT_SCHEMA', 'JOB_RECORD_READER_ID', 'JOB_PARTS_ENUMERATOR_RANGE',
 'JOB_ENABLED_ACT_KINDS', 'JOB_RESERVED_ACT_KINDS', 'JOB_PLAN_BOUND_SIGNOFF_STAGES',
 'JOB_CONSUMER_AUTH_MODE', 'JOB_ERROR_CODES', 'parseRecordAct', 'prepareJobRecordAct', 'prepareJobRecordSource',
 'JOB_COMMENTS_ACT_SCHEMA', 'REVIEW_COMMENTS_SESSION_SCHEMA', 'REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA',
 'PARTS_COMMENTS_VERDICT_SCHEMA', 'parseCommentsAct', 'projectComments', 'parseCommentsSession',
 'parseCommentsCompareSession', 'parseCommentsPartsVerdict', 'projectSelectedCommentsFeedback',
 'JOB_COMMENT_CONTEXT_ACT_SCHEMA', 'parseContextCommentsAct'];
assert(JSON.stringify(Object.keys(publicHost).sort()) === JSON.stringify(expectedExports.sort()), 'EXPORTS');
assert(JOB_API_SCHEMA === 'rig-review/job-api@2' && JOB_ACT_SCHEMA === 'rig-review/act@2' &&
 JOB_PARTS_ENUMERATOR_RANGE === '>=2.25.0 <3.0.0', 'SCHEMAS');
assert(JOB_ENABLED_ACT_KINDS.length === 5 && JOB_RESERVED_ACT_KINDS.length === 2 &&
 JOB_PLAN_BOUND_SIGNOFF_STAGES.length === 3 && JOB_CONSUMER_AUTH_MODE === 'writer-owned-sibling-fetch-capability' &&
 JOB_ERROR_CODES.includes('JOB_CLOSED'), 'CONTRACT');
// Package plan binding stays at three; record ask/value types admit all four stages.
const recordSignoffStages = ['plan-approved', 'rigging-interview', 'post-interview', 'direction-review'] as const satisfies readonly RecordSignoffStage[];
const recordStagesComplete: Exclude<RecordSignoffStage, typeof recordSignoffStages[number]> extends never ? true : never = true;
const directionRecordAsk: JobRecordSignoffSubject = {kind: 'signoff', stage: 'direction-review'};
const directionRecordValue: JobRecordSignoffValue = {stage: 'direction-review', decision: 'approved', words: ''};
assert(recordStagesComplete && recordSignoffStages.length === 4 && directionRecordAsk.stage === directionRecordValue.stage,
 'RECORD_SIGNOFF_STAGES');
assert(JSON.stringify(JOB_PLAN_BOUND_SIGNOFF_STAGES) === JSON.stringify(recordSignoffStages.slice(0, 3)), 'PACKAGE_SIGNOFF_STAGES');

const input = join(process.cwd(), 'public-host-input');
await cp('node_modules/@rig-c/review/examples/demo', input, {recursive: true});
const bytes = '{"syntheticPublication":1}\\n';
await writeFile(join(input, 'record.json'), bytes);
const record: JobFileIdentity = {path: 'record.json', sha256: createHash('sha256').update(bytes).digest('hex')};
// Explicit synthetic injected enumeration for the installed host seam.
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = new PNG({width: 1, height: 1});
image.data.fill(255);
const imageBytes = PNG.sync.write(image);
await mkdir(join(input, 'parts'));
await writeFile(join(input, 'parts/smoke.png'), imageBytes);
const manifestBytes = Buffer.from(JSON.stringify({rig_size: [1, 1], scale_rig_per_source: 1,
 parts: [{name: 'smoke', from: 'painting:smoke', x: 0, y: 0, w: 1, h: 1}]}));
await writeFile(join(input, 'parts.json'), manifestBytes);
const role: JobPartsRole = 'part';
const references: readonly JobPartsFileReference[] = [{path: 'parts/smoke.png', role}];
const parts: JobPartsIdentity = {enumeratorVersion: '2.25.1',
 manifest: {path: 'parts.json', sha256: sha256(manifestBytes)},
 images: references.map(row => ({...row, sha256: sha256(imageBytes)}))};
let enumeratorReads = 0;
const partsEnumerator: JobPartsEnumerator = {version: parts.enumeratorVersion, enumerate: dir => {
 assert(dir !== input && sha256(readFileSync(join(dir, 'parts.json'))) === parts.manifest.sha256,
  'ENUMERATOR_RETAINED_MANIFEST');
 enumeratorReads++;
 return references;
}};
let context: JobPublishedContext = {selector: null, plan: {steps: [{id: 'public-step', hash: '1'.repeat(64)}]},
 parts, subjects: [{kind: 'checkpoint', checkpointId: 'public-step'}], partIds: ['smoke'], files: []};
let reads = 0;
const readPublished: JobPublicationReader = async value => {
 assert(value.root === input && value.record.path === record.path && value.record.sha256 === record.sha256 &&
  value.result.path === 'review.json' && value.result.selector === null, 'READER_INPUT');
 reads++;
 return context;
};
let binding: Parameters<NonNullable<JobHostOptions['installWriterBinding']>>[0] | undefined;
const sessionOptions: JobSessionOptions = {root: input, stateDir: join(process.cwd(), 'public-host-state'),
 fingerprint: 'f'.repeat(64), reviewer: {id: 'installed-public-owner', role: 'owner'}, readPublished, partsEnumerator};
const workerOptions: JobWorkerOptions = {...sessionOptions, port: 0,
 installWriterBinding: value => {binding = value;}};
const options: JobHostOptions = {...workerOptions,
 readerId: 'installed-public-reader/1', bindingId: 'installed-public-binding/1',
 partsEnumeratorId: 'installed-synthetic-enumerator/1'};
const start: (options: JobHostOptions) => Promise<JobOwnerHost> = startJobHost;
const host: JobOwnerHost = await start(options);
try {
 const attachment: JobHostReuseExpectation | null = host.attachment;
 assert(attachment, 'ATTACHMENT_AVAILABLE');
 const incarnation: JobHostListenerIncarnation = attachment.listenerIncarnation;
 const reuseBinding: JobHostReuseBinding = attachment.binding;
 const field: JobHostAttachField = 'listenerIncarnation';
 const refused: JobHostAttachFailure = {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance'};
 assert(incarnation.length === 36 && reuseBinding.root === input && field === 'listenerIncarnation' &&
  refused.reason === 'stopped', 'ATTACH_TYPES');
 const strict = await start({...options, port: Number(new URL(attachment.origin).port || '80'), reuseOnly: {expected: attachment}});
 try {assert(strict.reused && JSON.stringify(strict.attachment) === JSON.stringify(attachment), 'STRICT_ATTACH');}
 finally {strict.stop();}
 const session: JobSession = host.session;
 const ports: JobHostPorts = host.ports;
 assert(binding && binding.jobId === session.jobId && binding.origin === host.origin &&
  /^[a-f0-9]{64}$/.test(binding.fetchCapability), 'WRITER_BINDING');
 const owner = new URL(host.ownerUrl);
 assert(owner.origin === host.origin && owner.hostname === '127.0.0.1' &&
  owner.pathname === '/jobs/' + binding.jobId + '/' && /^[a-f0-9]{64}$/.test(owner.hash.slice(5)), 'OWNER_URL');
 for (const [path, type] of [['', 'text/html'], ['job.js', 'text/javascript'], ['styles.css', 'text/css']]) {
  const response = await fetch(host.origin + owner.pathname + path);
  const body = await response.text();
  assert(response.ok && response.headers.get('content-type')?.includes(type!) && body.length > 0, 'OWNER_RESOURCE');
  if (!path) assert(body.includes('data-job-window'), 'FULL_OWNER_WINDOW');
 }
 const reused = await start({...options, partsEnumerator: {...partsEnumerator, enumerate: dir => partsEnumerator.enumerate(dir)}, readPublished: async value => readPublished(value),
  installWriterBinding: value => {binding = value;}});
 try {assert(reused.reused && reused.ownerUrl === host.ownerUrl, 'REUSE');}
 finally {reused.stop();}
 const base = {schema: JOB_API_SCHEMA, jobId: session.jobId};
 async function call(request: JobAgentRequest | JobFetchActRequest, consumer = false): Promise<JobApiResponse> {
  const token = consumer ? binding!.fetchCapability : session.hostCredentials().agent;
  const response = await ports.handleJobApi(new Request(host.origin + owner.pathname + 'api', {
   method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
   body: JSON.stringify(request),
  }));
  return response.json();
 }
 for (const schema of ['rig-review/job-api@1', 'rig-review/job-api@unsupported']) {
  const schemaMismatch = await ports.handleJobApi(new Request(host.origin + owner.pathname + 'api', {
   method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.hostCredentials().agent},
   body: JSON.stringify({...base, schema, verb: 'next', requestId: 'public-schema-mismatch', after: null, waitMs: 0}),
  }));
  const schemaFailure: JobApiResponse = await schemaMismatch.json();
  assert(schemaMismatch.status === 400 && !schemaFailure.ok && schemaFailure.error.code === 'JOB_REQUEST_INVALID' &&
   schemaFailure.error.message === 'JOB_API_SCHEMA_MISMATCH' && schemaFailure.schema === JOB_API_SCHEMA &&
   session.status().generation === 0, 'SCHEMA_MISMATCH_REFUSED');
 }
 const published = await call({...base, verb: 'publish', requestId: 'public-publish', expectedGeneration: 0,
  idempotencyKey: 'public-publish', result: {path: 'review.json', selector: null},
  freeze: {kind: 'producer-held', holdId: 'public-smoke-held', record}});
 assert(published.ok && published.verb === 'publish' && reads === 1 && published.value.visual.status === 'available', 'PUBLISH');
 assert(enumeratorReads === 1 && JSON.stringify(published.value.source.parts) === JSON.stringify(parts),
  'ENUMERATOR_VERSION_ROLE_CARRIAGE');
 const display = await ports.readPublication(base.jobId, published.value.publicationId);
 assert(display.ok && display.value.publication.source.sourceHash === published.value.source.sourceHash, 'DISPLAY');
 const metadata = await fetch(host.origin + display.value.routes.apiBase + 'review');
 const data = await metadata.json();
 assert(metadata.ok && data.sourceHash === published.value.source.sourceHash, 'RETAINED_METADATA');
 const model = await fetch(host.origin + display.value.routes.assetsBase + data.manifest.model);
 assert(model.ok && (await model.text()).length > 0, 'RETAINED_MODEL');
 const next = await call({...base, verb: 'next', requestId: 'public-next', after: null, waitMs: 0});
 assert(next.ok && next.verb === 'next' && next.value.events[0]?.type === 'published', 'NEXT');
 assertJobImageSetCapability(next.value.capabilities);
 assert(JOB_CAPABILITIES.imageSetVerdict === true, 'IMAGE_CAPABILITY');
 const fetched = await call({...base, verb: 'fetch-act', requestId: 'public-fetch', actId: 'absent'}, true);
 assert(!fetched.ok && fetched.error.code === 'JOB_ACT_UNKNOWN', 'CONSUMER_AUTH');
 await writeFile(join(input, 'plate.png'), imageBytes);
 await writeFile(join(input, 'review.json'), JSON.stringify({schema: 'rig-review/1', id: 'installed-image-set',
  title: 'Synthetic installed image comparison', revision: 'one', references: []}));
 const imageInput: JobImageSetInput = {purpose: 'plate-adoption', images: [
  {role: 'source', name: 'Source painting', path: 'parts/smoke.png', sha256: sha256(imageBytes)},
  {role: 'candidate', name: 'Generated plate', path: 'plate.png'}]};
 context = {selector: null, plan: null, parts: null, subjects: [], partIds: [], files: [], imageSet: imageInput};
 const imagePublished = await call({...base, verb: 'publish', requestId: 'image-publish',
  expectedGeneration: session.status().generation, idempotencyKey: 'image-publish',
  result: {path: 'review.json', selector: null}, freeze: {kind: 'producer-held', holdId: 'image-held', record}});
 assert(imagePublished.ok && imagePublished.verb === 'publish' && imagePublished.value.source.subject === 'image-set', 'IMAGE_PUBLISH');
 const imageSource: JobImageSourceBinding = imagePublished.value.source;
 assert(!Object.hasOwn(imageSource, 'model') && !Object.hasOwn(imageSource, 'selector'), 'IMAGE_ABSENT_MODEL_SELECTOR');
 assert(imageSource.imageSetDigest === sha256(Buffer.from(JSON.stringify(imageSource.imageSet.images.map(
  ({role, name, sha256}) => ({role, name, sha256}))))), 'IMAGE_DIGEST');
 assert(JSON.stringify(imageSource.duplicateHashes) === JSON.stringify([
  {names: ['Source painting', 'Generated plate'], sha256: sha256(imageBytes)}]), 'IMAGE_DUPLICATES');
 const imageAsk = await call({...base, verb: 'ask', requestId: 'image-ask', expectedGeneration: session.status().generation,
  idempotencyKey: 'image-ask', publicationId: imagePublished.value.publicationId,
  subject: {kind: 'review-verdict', stage: 'image-review'}});
 assert(imageAsk.ok && imageAsk.verb === 'ask', 'IMAGE_ASK');
 const imageDisplay = await ports.readPublication(base.jobId, imagePublished.value.publicationId);
 assert(imageDisplay.ok, 'IMAGE_DISPLAY');
 for (let index = 0; index < imageSource.imageSet.images.length; index++) {
  const response = await fetch(host.origin + imageDisplay.value.routes.apiBase + 'image-set/' + index);
  assert(response.ok && sha256(new Uint8Array(await response.arrayBuffer())) === imageSource.imageSet.images[index]!.sha256,
   'IMAGE_RETAINED_BYTES');
 }
 const uiHeaders = {'Content-Type': 'application/json', Origin: host.origin,
  'X-Review-Capability': session.hostCredentials().ui};
 const displayed = await ports.ackDisplayed(base.jobId, new Request(host.origin + owner.pathname + 'ui/displayed', {
  method: 'POST', headers: uiHeaders, body: JSON.stringify({publicationId: imagePublished.value.publicationId,
   pageId: 'installed-image-page', sourceHash: imageSource.sourceHash})}));
 assert(displayed.ok, 'IMAGE_UI_RECEIPT');
 const imageValue: JobImageReviewValue = {stage: 'image-review', verdict: 'approved', words: '  exact words  ',
  imageNotes: [{name: 'Generated plate', words: '  exact image note  '}]};
 const imageAct = await ports.commitUIAct(base.jobId, new Request(host.origin + owner.pathname + 'ui/acts', {
  method: 'POST', headers: uiHeaders, body: JSON.stringify({...displayed.value, askId: imageAsk.value.askId,
   expectedGeneration: session.status().generation, submissionId: 'installed-image-submit', kind: 'review-verdict', value: imageValue})}));
 assert(imageAct.ok && imageAct.value.kind === 'review-verdict', 'IMAGE_UI_ACT');
 assert(imageAct.value.schema === JOB_ACT_SCHEMA, 'IMAGE_ACT_STAYS_AT_2');
 assert(JSON.stringify(imageAct.value.source) === JSON.stringify(imageSource) &&
  JSON.stringify(imageAct.value.value) === JSON.stringify(imageValue), 'IMAGE_SOURCE_WORDS_EXACT');
 const imageFetched = await call({...base, verb: 'fetch-act', requestId: 'image-fetch', actId: imageAct.value.actId}, true);
 assert(imageFetched.ok && imageFetched.verb === 'fetch-act' &&
  JSON.stringify(imageFetched.value) === JSON.stringify(imageAct.value), 'IMAGE_CONSUMER_FETCH');
 const closed = await call({...base, verb: 'close', requestId: 'public-close', expectedGeneration: session.status().generation,
  idempotencyKey: 'public-close', reason: 'installed public host smoke complete'});
 assert(closed.ok && closed.verb === 'close' && closed.value.status === 'closed', 'CLOSE');
 const afterClose = await call({...base, verb: 'fetch-act', requestId: 'public-fetch-closed', actId: 'absent'}, true);
 assert(!afterClose.ok && afterClose.error.code === 'JOB_CLOSED', 'GRANT_LIFETIME');
} finally {host.stop();}
`;

async function publicHostSmoke(): Promise<void> {
 // The consumer declares its own toolchain using this package's existing devDependency ranges.
 const toolchain = ['typescript@' + manifest.devDependencies.typescript, '@types/bun@' + manifest.devDependencies['@types/bun']];
 const prepared = await run(['npm', 'i', '-D', '--dry-run=false', '--no-audit', '--no-fund', ...toolchain], app);
 if (!step('empty consumer installs its declared TypeScript and Bun types', prepared.exit === 0,
  toolchain.join(' · ') + (prepared.stderr.trim() ? ' · ' + prepared.stderr.trim() : '')))
  throw new Error('SMOKE_PUBLIC_HOST_TOOLCHAIN');
 const consumer = join(app, 'public-host.ts');
 await writeFile(consumer, publicHostConsumer);
 const typed = await run([process.execPath, join(app, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
  '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM,DOM.Iterable', '--allowImportingTsExtensions', '--types', 'bun', consumer], app);
 if (!step('installed public job-host type surface', typed.exit === 0, typed.stdout.trim() || typed.stderr.trim()))
  throw new Error('SMOKE_PUBLIC_HOST_TYPES');
 const runtime = await run([process.execPath, consumer], app);
 if (!step('installed public job-host full owner window, A ports and hooks', runtime.exit === 0,
  runtime.stdout.trim() || runtime.stderr.trim())) throw new Error('SMOKE_PUBLIC_HOST_RUNTIME');

 // Planned RED. Only the disposable installed manifest is mutated, then byte-restored.
 const manifestPath = join(app, 'node_modules/@rig-c/review/package.json');
 const original = await readFile(manifestPath);
 const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
 const hash = sha256(original);
 const probe = join(app, 'public-import.ts');
 await writeFile(probe, "import {startJobHost} from '@rig-c/review/job-host';\nvoid startJobHost;\n");
 const mutant = JSON.parse(original.toString('utf8'));
 delete mutant.exports['./job-host'];
 try {
  await writeFile(manifestPath, JSON.stringify(mutant) + '\n');
  const removed = await run([process.execPath, probe], app);
  const output = removed.stdout + removed.stderr;
  if (!step('planned RED missing public job-host subpath', removed.exit !== 0 &&
   /(?:ERR_PACKAGE_PATH_NOT_EXPORTED|not exported|No matching export|Cannot find module [\'"]@rig-c\/review\/job-host[\'"])/i.test(output) && output.includes('job-host'),
   'exit ' + removed.exit + ' · ' + output.trim())) throw new Error('SMOKE_PUBLIC_EXPORT_MUTANT');
 } finally {
  await writeFile(manifestPath, original);
  const restored = await readFile(manifestPath);
  if (!step('public export mutant restored bytes and SHA-256', original.equals(restored) && sha256(restored) === hash, hash))
   throw new Error('SMOKE_PUBLIC_EXPORT_RESTORE');
 }
 const restoredImport = await run([process.execPath, probe], app);
 if (!step('restored installed public job-host import', restoredImport.exit === 0,
  restoredImport.stdout.trim() || restoredImport.stderr.trim())) throw new Error('SMOKE_PUBLIC_EXPORT_REIMPORT');
}

try{
 let target=spec;
 let files:string[]=[];
 if(!spec){
 const packed=await run(['npm','pack','--json','--ignore-scripts','--dry-run=false','--pack-destination',work],root);
 if(!step('npm pack',packed.exit===0,packed.stderr.trim().split('\n').at(-1)))throw new Error('pack');
 const info=packResult(JSON.parse(packed.stdout),manifest.name);files=info.files.map(f=>f.path);target=join(work,info.filename);
 }else log('SKIP npm pack · SMOKE_REGISTRY_SPEC: installing published '+spec);
 await Bun.$`mkdir -p ${app}`;await writeFile(join(app,'package.json'),JSON.stringify({name:'rig-review-smoke',private:true})+'\n');
 const installed=await run(['npm','i','-D','--dry-run=false','--no-audit','--no-fund',target!],app);
 if(!step(spec?'npm i -D '+spec+' from registry':'npm i -D <tarball> into an empty project',installed.exit===0,installed.stderr.trim()))throw new Error(spec?'SMOKE_REGISTRY_INSTALL: '+spec:'install');
 if(spec)files=[...new Bun.Glob('**/*').scanSync({cwd:join(app,'node_modules/@rig-c/review'),onlyFiles:true,dot:true})].map(f=>f.replaceAll('\\','/'));
 step('tarball carries the bin, public host, stability reference, web, demo and licence',['src/entry.ts','src/cli.ts','src/job-host.ts','src/job-front.ts','src/job-session.ts','src/job-contract.ts','src/job-image-set.ts','src/job-hub.ts','web/job-hub.ts','docs/STABILITY.md','web/job-session.ts','web/main.ts','web/index.html','examples/demo/review.json','LICENSE'].every(f=>files.includes(f)),`${files.length} files`);
 step('tarball carries no tests or fixtures',!files.some(f=>f.startsWith('tests/')||f.startsWith('node_modules/')));
 await writeFile(join(app,'node_modules/.metadata_never_index'),'');
 await installedWorkspaceSmoke({app, work, fixtureRoot:join(root,'tests/fixtures/strip-probe'), foreground:true, log});
 await publicHostSmoke();
 await installedJobHubSmoke({app, work, log});
 const help=await run(['npx','--no-install','rig-review','--help'],app);step('npx rig-review --help',help.exit===0&&help.stdout.includes('Usage'));
 if(!spec){
 const development=await run([process.execPath,'src/entry.ts','--help'],root);
 const legacy=await run([process.execPath,'src/cli.ts','--help'],root);
 step('installed/development/legacy help parity',development.exit===help.exit&&legacy.exit===help.exit&&development.stdout===help.stdout&&legacy.stdout===help.stdout);
 const sessionHelp=await run(['npx','--no-install','rig-review','session','--help'],app);
 const developmentSession=await run([process.execPath,'src/entry.ts','session','--help'],root);
 step('installed/development session entry parity',sessionHelp.exit===0&&developmentSession.exit===0&&sessionHelp.stdout===developmentSession.stdout&&sessionHelp.stdout.includes('session publish'));
 }else{
  log('SKIP installed/development/legacy help parity · SMOKE_REGISTRY_TREE_UNBOUND: registry spec is not bound to this working tree');
  const sessionHelp=await run(['npx','--no-install','rig-review','session','--help'],app);
  step('installed session entry help',sessionHelp.exit===0&&sessionHelp.stdout.includes('session publish'));
  log('SKIP installed/development session entry parity · SMOKE_REGISTRY_TREE_UNBOUND: registry spec is not bound to this working tree');
 }
 if(spec)log('SKIP working-tree bin manifest equality · SMOKE_REGISTRY_TREE_UNBOUND: registry spec is not bound to this working tree');
 const installedManifest=JSON.parse(await readFile(join(app,'node_modules/@rig-c/review/package.json'),'utf8'));
 step('installed bin maps to the thin entry',installedManifest.bin['rig-review']==='src/entry.ts'&&(!!spec||manifest.bin['rig-review']==='src/entry.ts'));
 const openHelp=await run(['npx','--no-install','rig-review','open','--help'],app);step('npx rig-review open --help',openHelp.exit===0&&openHelp.stdout.includes('rig-review open <dir>'));
 const demo=join(app,'node_modules/@rig-c/review/examples/demo/review.json');
 const check=await run(['npx','--no-install','rig-review','check',demo],app);step('rig-review check <bundled demo>',check.exit===0&&check.stdout.includes('Package valid'),check.stdout.split('\n')[0]||check.stderr.trim());
 const server=Bun.spawn([join(app,'node_modules/.bin/rig-review'),demo,'--port','0'],{cwd:app,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state')}});
 try{
  const reader=server.stdout.getReader(),decoder=new TextDecoder(),deadline=Date.now()+30000;let out='';
  while(!/Review ready: (\S+)/.test(out)&&Date.now()<deadline){const {value,done}=await reader.read();if(done)break;out+=decoder.decode(value);}
  const ready=/Review ready: (\S+)/.exec(out);
  if(step('installed bin serves the demo on loopback',!!ready,ready?.[1]??(await new Response(server.stderr).text()).trim())){
   servedCapability=new URL(ready![1]!).hash.slice(5);
   step('installed bin prints a write capability in its handoff URL',/^[a-f0-9]{64}$/.test(servedCapability),'value redacted in this log');
   const origin=new URL(ready![1]!).origin;
   for(const [path,type] of [['/','text/html'],['/styles.css','text/css'],['/main.js','text/javascript'],['/api/review','application/json']] as const){const r=await fetch(origin+path);const body=await r.text();step(`GET ${path}`,r.ok&&(r.headers.get('content-type')??'').includes(type)&&body.length>0,`${r.status} · ${body.length} bytes`);}
  }
 }finally{server.kill();await server.exited;}
 const job=spawn(join(app,'node_modules/.bin/rig-review'),['session','open',dirname(demo)],{
  cwd:app,stdio:['ignore','pipe','pipe','pipe'],env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'job-state'),
   RIG_REVIEW_JOB_REVIEWER_ID:'install-smoke-owner',RIG_REVIEW_JOB_REVIEWER_ROLE:'owner',RIG_REVIEW_JOB_AGENT_FD:'3'},
 });
 const jobExited=new Promise<void>(resolve=>job.once('exit',()=>resolve()));
 let jobErrors='';job.stderr!.on('data',chunk=>{jobErrors+=chunk.toString('utf8');});
 try{
  const [ownerLine,privateLine]=await Promise.all([firstLine(job.stdout!),firstLine(job.stdio[3] as Readable)]);
  const owner=new URL(ownerLine),bootstrap=JSON.parse(privateLine);
  const locator=owner.origin+'/jobs/'+bootstrap.jobId;
  const agentEnv={RIG_REVIEW_JOB_AGENT_CAPABILITY:bootstrap.agentCapability};
  step('installed session opens one standing owner window',owner.pathname==='/jobs/'+bootstrap.jobId+'/'&&owner.origin===bootstrap.origin&&/^[a-f0-9]{64}$/.test(owner.hash.slice(5)));
  const publish=await run(['npx','--no-install','rig-review','session','publish',locator,'--generation','0','--key','installed-smoke','--result','review.json','--freeze-hold','installed-smoke-held'],app,agentEnv);
  const publication=JSON.parse(publish.stdout);
  if(!step('installed semantic entry publishes the immutable bundled demo',publish.exit===0&&publication.ok===true))throw new Error('SMOKE_SESSION_PUBLISH');
  const descriptor=await (await fetch(locator+'/publications/'+publication.value.publicationId)).json();
  const data=await (await fetch(owner.origin+descriptor.value.routes.apiBase+'review')).json();
  step('installed job metadata stays bound to the displayed source',data.sourceHash===publication.value.source.sourceHash);
  const model=await fetch(owner.origin+descriptor.value.routes.assetsBase+data.manifest.model);
  step('installed job serves its retained model',model.ok&&(await model.text()).length>0);
  for(const path of ['', 'job.js','styles.css']){
   const response=await fetch(locator+'/'+path);const body=await response.text();
   step('installed standing owner resource '+(path||'page'),response.ok&&body.length>0);
  }
  const close=await run(['npx','--no-install','rig-review','session','close',locator,'--generation',String(publication.generation),'--key','installed-close','--reason','install smoke complete'],app,agentEnv);
  step('installed session closes explicitly',close.exit===0&&JSON.parse(close.stdout).value.status==='closed');
  await jobExited;
 }catch(error){if(jobErrors)log(jobErrors.trim());throw error;}finally{if(job.exitCode===null){job.kill('SIGTERM');await jobExited;}}
}catch(error){if(!failed)step('smoke',false,error instanceof Error?error.message:String(error));}
finally{await rm(work,{recursive:true,force:true});}
log(`bun ${Bun.version}`);
{const text=printed.join('\n');step('smoke output carries no capability value',!leaksCapability(text)&&!(servedCapability&&text.includes(servedCapability)));}
process.exit(failed?1:0);
