/** Embedded job owner. Trusted callback registrations never cross a process boundary. */
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {buildWeb} from './build.ts';
import {jobBody, jobObject, sameCapability} from './job-api.ts';
import {JOB_API_SCHEMA, JOB_ACT_SCHEMA, JOB_CAPABILITIES, type JobCapabilities, type JobHostPorts, type JobReviewerBinding} from './job-contract.ts';
import {assertJobHostCompatible, createJobRequestContext, installJobWriterBinding, jobHostIdentity,
  jobWindowResources, type JobHostOptions, type JobHostReuseExpectation, type JobHostRecord} from './job-front.ts';
import {JobSession} from './job-session.ts';
import {captureJobRoot} from './job-source.ts';
import {JobError} from './job-store.ts';
import {acquireClaim, readOpenStatus, releaseClaim, running} from './open.ts';
import {assertPrivate, readPrivate, writePrivate} from './open-workspace-state.ts';
import {canonicalStatePath} from './state-dir.ts';

export interface JobHubOptions {
  readonly stateDir: string;
  readonly reviewer: JobReviewerBinding;
  readonly port?: number;
}
export type JobHubJobOptions = Omit<JobHostOptions, 'stateDir' | 'port' | 'reviewer' | 'reuseOnly'>;
export interface JobHubJob {
  readonly session: JobSession;
  readonly ports: JobHostPorts;
  readonly origin: string;
  readonly jobUrl: string;
  readonly reused: boolean;
  readonly attachment: JobHostReuseExpectation;
}
export interface JobOwnerHub {
  readonly origin: string;
  readonly ownerUrl: string;
  openJob(options: JobHubJobOptions): Promise<JobHubJob>;
  stop(): Promise<void>;
}

export const JOB_HUB_SUBJECT_KINDS = [
  'parts', 'interview', 'rig', 'direction', 'image-set', 'checkpoint', 'signoff', 'reopen', 'plan', 'package',
] as const;
export type JobHubSubjectKind = (typeof JOB_HUB_SUBJECT_KINDS)[number];

export interface JobHubRow {
  jobId: string;
  generation: number;
  status: 'active' | 'closed';
  publication: {publicationId: string; instanceKey: string; sourceHash: string; label: string} | null;
  pendingCount: number;
  subjectKind?: JobHubSubjectKind;
  answered?: boolean;
}
export interface JobHubList {
  schema: 'rig-review-job-hub/1';
  capabilities?: JobCapabilities;
  incarnation: string;
  limit: number;
  jobs: JobHubRow[];
}

function hubSubjectKind(status: ReturnType<JobSession['status']>): JobHubSubjectKind {
  const ask = status.pending[0]?.subject;
  if (ask) {
    if (ask.kind === 'parts-verdict') return 'parts';
    if (ask.kind === 'interview-picks') return 'interview';
    if (ask.kind === 'checkpoint' || ask.kind === 'signoff' || ask.kind === 'reopen') return ask.kind;
    return ask.stage === 'image-review' ? 'image-set' : ask.stage === 'direction-review' ? 'direction' : 'rig';
  }
  const source = status.publication?.source;
  if (!source) return 'package';
  if ('subject' in source && source.subject === 'image-set') return 'image-set';
  if ('subject' in source && source.subject === 'option-set') return 'interview';
  if ('subject' in source && source.subject === 'plan') return source.subjects[0]?.kind ?? 'plan';
  if (source.direction || source.selector?.kind === 'post') return 'direction';
  if (source.selector?.kind === 'draft' || source.parts && !source.model) return 'parts';
  if (source.optionSet && !source.model) return 'interview';
  if (source.plan && !source.model) return 'plan';
  if (source.model || source.selector?.kind === 'rig') return 'rig';
  return 'package';
}

const schema = 'rig-review-job-hub/1';
const maximumJobs = 32;
const responseHeaders = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
type HubCode = 'JOB_HUB_ALREADY_RUNNING' | 'JOB_HUB_EXTERNAL_HOST' | 'JOB_HUB_HOST_UNRESPONSIVE' |
  'JOB_HUB_CLOSED' | 'JOB_HUB_LIMIT' | 'JOB_HUB_STATE_INVALID';
class HubError extends Error {
  constructor(readonly code: HubCode) {super(code);}
}
interface HubRecord {
  schema: typeof schema;
  pid: number;
  origin: string;
  incarnation: string;
  capability: string;
}
interface Member {
  root: string;
  fingerprint: string;
  session: JobSession;
  context: ReturnType<typeof createJobRequestContext>;
  recordPath: string;
  ready: boolean;
}
function refused(code: string, status: number) {
  return Response.json({ok: false, error: {code, message: code}}, {status, headers: responseHeaders});
}
function hostRecord(value: unknown, jobId?: string): JobHostRecord {
  if (!value || typeof value !== 'object') throw new HubError('JOB_HUB_STATE_INVALID');
  const row = value as JobHostRecord;
  let origin: URL;
  try {origin = new URL(row.origin);} catch {throw new HubError('JOB_HUB_STATE_INVALID');}
  if (row.schema !== 'rig-review-job-host/1' || typeof row.jobId !== 'string' || jobId && row.jobId !== jobId ||
      typeof row.fingerprint !== 'string' || !Number.isSafeInteger(row.pid) || row.pid < 1 ||
      origin.origin !== row.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') {
    throw new HubError('JOB_HUB_STATE_INVALID');
  }
  return row;
}

export async function startJobHub(options: JobHubOptions): Promise<JobOwnerHub> {
  const reviewer = structuredClone(options.reviewer);
  if (!reviewer?.id || !['owner', 'delegate'].includes(reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  const stateDir = canonicalStatePath(options.stateDir);
  const directory = join(stateDir, 'job-hub'), control = join(stateDir, 'job-ui');
  for (const path of [directory, control]) {
    await mkdir(path, {recursive: true, mode: 0o700}); await assertPrivate(path, true);
  }
  const recordPath = join(directory, 'host.json'), incarnation = randomUUID();
  const capability = randomBytes(32).toString('hex');
  async function refuseLiveHub(): Promise<null> {
    const previous = await readPrivate(recordPath) as HubRecord | null;
    if (!previous) return null;
    if (previous.schema !== schema || !Number.isSafeInteger(previous.pid) || previous.pid < 1) {
      throw new HubError('JOB_HUB_STATE_INVALID');
    }
    if (running(previous.pid)) throw new HubError('JOB_HUB_ALREADY_RUNNING');
    return null;
  }
  await refuseLiveHub();
  const acquired = await acquireClaim(directory, 'hub', incarnation, refuseLiveHub,
    performance.now() + 20_000, 'JOB_HUB_ALREADY_RUNNING');
  if (!('claim' in acquired)) throw new HubError('JOB_HUB_ALREADY_RUNNING');
  const hubClaim = acquired.claim;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const members = new Map<string, Member>();
  let queue = Promise.resolve(), closing = false, requests = 0;
  let stopping: Promise<void> | undefined;
  const resources = jobWindowResources();
  let hubBundle: Promise<Blob> | undefined;
  async function removeOwned(path: string) {
    const value = await readPrivate(path) as {incarnation?: string; hubIncarnation?: string} | null;
    if (value?.incarnation === incarnation || value?.hubIncarnation === incarnation) {
      await unlink(path).catch(error => {if (error.code !== 'ENOENT') throw error;});
    }
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    closing = true;
    stopping = (async () => {
      await queue;
      for (const member of members.values()) member.context.stop();
      while (requests || [...members.values()].some(member => member.context.busy)) await Bun.sleep(10);
      await server?.stop(true);
      for (const member of members.values()) {
        member.session.dispose(); await removeOwned(member.recordPath);
      }
      members.clear();
      await removeOwned(recordPath);
      await releaseClaim(hubClaim, incarnation);
    })();
    return stopping;
  }
  try {
    await refuseLiveHub();
    server = Bun.serve({hostname: '127.0.0.1', port: options.port ?? 0, idleTimeout: 0,
      async fetch(request): Promise<Response> {
        if (closing) return refused('JOB_HUB_CLOSED', 503);
        requests++;
        try {
          const url = new URL(request.url);
          if (url.origin !== origin) return refused('JOB_LOOPBACK_REQUIRED', 403);
          const resource = url.pathname === '/hub/' ? 'index.html' : url.pathname === '/hub/main.js' ? 'main.js'
            : url.pathname === '/hub/styles.css' ? 'styles.css' : null;
          if (resource) {
            if (!['GET', 'HEAD'].includes(request.method)) return refused('JOB_REQUEST_INVALID', 405);
            if (request.headers.get('sec-fetch-site') === 'cross-site' ||
                request.headers.get('origin') !== null && request.headers.get('origin') !== origin) return refused('JOB_SAME_ORIGIN_REQUIRED', 403);
            if (resource === 'index.html') {
              if (url.searchParams.get('workspace') !== incarnation ||
                  [...url.searchParams.keys()].some(key => !['workspace', 'lang'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
                  url.searchParams.has('lang') && !['en', 'ko'].includes(url.searchParams.get('lang')!)) return refused('JOB_REQUEST_INVALID', 400);
            } else if (url.search) return refused('JOB_REQUEST_INVALID', 400);
            let body: BodyInit | null = null;
            if (request.method !== 'HEAD') {
              if (resource === 'main.js') body = await (hubBundle ??= buildWeb('job-hub'));
              else body = Bun.file(new URL('../web/' + resource, import.meta.url));
            }
            return new Response(body, {headers: {...responseHeaders,
              'Content-Type': resource.endsWith('.html') ? 'text/html; charset=utf-8' : resource.endsWith('.js') ? 'text/javascript' : 'text/css',
              'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
          }
          const selected = /^\/hub\/api\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/open$/.exec(url.pathname);
          if (url.pathname === '/hub/host' || url.pathname === '/hub/api/jobs' || selected) {
            if (request.method !== (selected ? 'POST' : 'GET') || url.search) return refused('JOB_REQUEST_INVALID', 400);
            if (request.headers.get('sec-fetch-site') === 'cross-site' ||
                request.headers.get('origin') !== null && request.headers.get('origin') !== origin) {
              return refused('JOB_SAME_ORIGIN_REQUIRED', 403);
            }
            if (!sameCapability(request.headers.get('X-Review-Capability'), capability)) {
              return refused('JOB_CAPABILITY_REQUIRED', 403);
            }
            if (selected) {
              if (request.headers.get('origin') !== origin) return refused('JOB_SAME_ORIGIN_REQUIRED', 403);
              try {
                const input = jobObject(await jobBody(request), ['schema', 'incarnation']);
                if (input.schema !== schema || input.incarnation !== incarnation) return refused('JOB_REQUEST_INVALID', 400);
              } catch (error) {return refused(error instanceof JobError ? error.code : 'JOB_REQUEST_INVALID',
                error instanceof JobError && error.code === 'JOB_BODY_LIMIT' ? 413 : 400);}
              const member = members.get(selected[1]!);
              if (!member?.ready) return refused('JOB_UNKNOWN', 404);
              if (member.session.status().status === 'closed') return refused('JOB_CLOSED', 409);
              return Response.json({schema, incarnation, jobId: selected[1],
                entry: `/jobs/${selected[1]}/?hub=${incarnation}`, capability: member.session.hostCredentials().ui}, {headers: responseHeaders});
            }
            if (url.pathname === '/hub/host') return Response.json({schema, incarnation, pid: process.pid,
              origin, apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA, capabilities: JOB_CAPABILITIES}, {headers: responseHeaders});
            return Response.json({schema, incarnation, capabilities: JOB_CAPABILITIES, limit: maximumJobs, jobs: [...members.values()].filter(member => member.ready).map(member => {
              const status = member.session.status();
              return {jobId: status.jobId, generation: status.generation, status: status.status,
                publication: status.publication && {publicationId: status.publication.publicationId,
                  instanceKey: status.publication.instanceKey, sourceHash: status.publication.source.sourceHash,
                  label: status.publication.label.slice(0, 512)}, pendingCount: status.pending.length,
                subjectKind: hubSubjectKind(status),
                answered: status.publication !== null && status.pending.length === 0 && status.generation > status.publication.generation};
            })}, {headers: responseHeaders});
          }
          const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\//.exec(url.pathname);
          const member = match && members.get(match[1]!);
          return member ? await member.context.fetch(request) : refused('JOB_UNKNOWN', 404);
        } finally {requests--;}
      },
    });
    const origin: string = `http://127.0.0.1:${server.port}`;
    const record: HubRecord = {schema, pid: process.pid, origin, incarnation, capability};
    await writePrivate(recordPath, record);
    async function register(input: JobHubJobOptions): Promise<JobHubJob> {
      if (closing) throw new HubError('JOB_HUB_CLOSED');
      if (!input || typeof input !== 'object' || 'reuseOnly' in (input as Record<string, unknown>)) {
        throw new JobError('JOB_REQUEST_INVALID');
      }
      const startup: JobHostOptions = {...input, stateDir, reviewer};
      const identity = jobHostIdentity(startup);
      const root = captureJobRoot(startup.root).path;
      if (members.size >= maximumJobs && ![...members.values()].some(member =>
          member.root === root && member.fingerprint === startup.fingerprint && member.session.status().status === 'active')) {
        throw new HubError('JOB_HUB_LIMIT');
      }
      const session = new JobSession(startup);
      let retained = false;
      let claim: string | undefined;
      let member: Member | undefined;
      const nonce = randomUUID();
      try {
        const existing = members.get(session.jobId);
        if (existing) {
          assertJobHostCompatible(existing.context.record, identity);
          await installJobWriterBinding(existing.session, startup, origin);
          return {session: existing.session, ports: existing.context.ports, origin,
            jobUrl: origin + `/jobs/${session.jobId}/#cap=${existing.session.hostCredentials().ui}`, reused: true, attachment: existing.context.ownerAttachment()};
        }
        if (members.size >= maximumJobs) throw new HubError('JOB_HUB_LIMIT');
        const path = join(control, session.jobId + '.json');
        async function refuseExternal(): Promise<null> {
          const value = await readPrivate(path);
          if (!value) return null;
          const row = hostRecord(value, session.jobId);
          if (row.fingerprint !== startup.fingerprint) throw new HubError('JOB_HUB_STATE_INVALID');
          if (!running(row.pid)) return null;
          let remote: JobHostRecord;
          try {
            const response = await fetch(row.origin + `/jobs/${session.jobId}/host`, {
              headers: {'X-Review-Capability': session.hostCredentials().ui}, redirect: 'error', signal: AbortSignal.timeout(1500),
            });
            if (!response.ok) {await response.body?.cancel(); throw new HubError('JOB_HUB_HOST_UNRESPONSIVE');}
            remote = hostRecord(await readOpenStatus(response, 1500), session.jobId);
            if (remote.origin !== row.origin || remote.pid !== row.pid || remote.fingerprint !== row.fingerprint) {
              throw new HubError('JOB_HUB_HOST_UNRESPONSIVE');
            }
          } catch {throw new HubError('JOB_HUB_HOST_UNRESPONSIVE');}
          assertJobHostCompatible(row, identity); assertJobHostCompatible(remote, identity);
          throw new HubError('JOB_HUB_EXTERNAL_HOST');
        }
        await refuseExternal();
        const acquiredJob = await acquireClaim(control, 'job-' + session.jobId, nonce, refuseExternal,
          performance.now() + 20_000, 'JOB_HUB_EXTERNAL_HOST');
        if (!('claim' in acquiredJob)) throw new HubError('JOB_HUB_EXTERNAL_HOST');
        claim = acquiredJob.claim;
        await refuseExternal();
        const context = createJobRequestContext(session, startup, origin, identity, resources, incarnation, incarnation, () => !closing && !!member?.ready);
        Object.assign(context.record, {hubIncarnation: incarnation});
        member = {root, fingerprint: startup.fingerprint, session, context, recordPath: path, ready: false};
        members.set(session.jobId, member);
        await installJobWriterBinding(session, startup, origin);
        if (closing) throw new HubError('JOB_HUB_CLOSED');
        await writePrivate(path, context.descriptor().record);
        context.publish();
        member.ready = true; retained = true;
        return {session, ports: context.ports, origin,
          jobUrl: origin + `/jobs/${session.jobId}/#cap=${session.hostCredentials().ui}`, reused: false, attachment: context.ownerAttachment()};
      } finally {
        if (!retained) {
          if (member) {
            members.delete(session.jobId); member.context.stop();
            while (member.context.busy) await Bun.sleep(10);
          }
          session.dispose();
        }
        if (claim) await releaseClaim(claim, nonce);
      }
    }
    return {origin, ownerUrl: origin + '/hub/?workspace=' + incarnation + '#cap=' + capability,
      openJob(input) {
        const startup = {...input};
        const task = queue.then(() => register(startup));
        queue = task.then(() => {}, () => {});
        return task;
      }, stop};
  } catch (error) {
    await stop(); throw error;
  }
}
