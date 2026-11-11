import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {checkedJobHubLocation, checkedJobHubList, jobHubMessageMatches, JOB_HUB_READY, JOB_HUB_VISIBILITY,
  type JobHubBinding} from '../web/job-hub.ts';
import {hashCapabilityAccess} from '../web/hash-capability.ts';
import type {JobHubList} from '../src/job-hub.ts';

const incarnation = '12345678-1234-1234-1234-123456789abc';
const origin = 'http://127.0.0.1:4318';
const source = {} as Window;
const binding: JobHubBinding = {incarnation, jobId: 'synthetic-job', publicationId: 'synthetic-publication', sourceHash: 'a'.repeat(64)};

test('hub owner access is incarnation-scoped and strips the grant before subsequent requests', () => {
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}};
  const access = (href: string, storage: Parameters<typeof hashCapabilityAccess>[2], replace: (href: string) => void) => {
    const {url, incarnation} = checkedJobHubLocation(href);
    return {incarnation, capability: hashCapabilityAccess(url, 'rig-review-job-hub/1:' + url.origin + ':' + incarnation,
      storage, replace, 'validate')};
  };
  let address = '';
  const url = origin + '/hub/?workspace=' + incarnation;
  expect(access(url + '#cap=' + 'c'.repeat(64), () => storage, value => {address = value;}))
    .toEqual({incarnation, capability: 'c'.repeat(64)});
  expect(address).toBe(url);
  expect(access(url, () => storage, () => {}).capability).toBe('c'.repeat(64));
  const next = 'abcdefab-1234-1234-1234-123456789abc';
  expect(access(origin + '/hub/?workspace=' + next, () => storage, () => {}).capability).toBe('');
  for (const query of ['', '?workspace=' + incarnation + '&workspace=' + incarnation, '?workspace=' + incarnation + '&extra=1',
    '?workspace=' + incarnation + '&lang=other']) expect(() => access(origin + '/hub/' + query, () => storage, () => {})).toThrow('JOB_REQUEST_INVALID');
});

test('visibility and ready messages bind origin, exact window, job, publication, source and incarnation', () => {
  const data = {...binding, schema: JOB_HUB_VISIBILITY, visible: false, language: 'ko'};
  expect(jobHubMessageMatches({origin, source, data}, origin, source, binding, 'visibility')).toBe(true);
  for (const event of [
    {origin: origin + '1', source, data}, {origin, source: {} as Window, data},
    ...[{incarnation: 'other'}, {jobId: 'other'}, {publicationId: 'other'}, {sourceHash: 'b'.repeat(64)},
      {visible: 'false'}, {language: 'other'}, {extra: true}].map(change => ({origin, source, data: {...data, ...change}})),
  ]) expect(jobHubMessageMatches(event, origin, source, binding, 'visibility')).toBe(false);
  expect(jobHubMessageMatches({origin, source, data: {...binding, schema: JOB_HUB_READY}}, origin, source, binding, 'ready')).toBe(true);
  expect(jobHubMessageMatches({origin, source: null, data}, origin, null, binding, 'visibility')).toBe(false);
});

test('every admitted row is selectable under the same advertised frame bound and malformed lists refuse', () => {
  const jobs = Array.from({length: 32}, (_, index) => ({jobId: 'synthetic-' + index, generation: 0,
    status: 'active' as const, publication: null, pendingCount: 0}));
  const list: JobHubList = {schema: 'rig-review-job-hub/1', incarnation, limit: 32, jobs};
  expect(checkedJobHubList(list, incarnation).jobs).toHaveLength(32);
  for (const value of [{...list, incarnation: 'other'}, {...list, limit: 9}, {...list, limit: 33},
    {...list, jobs: [...jobs, {...jobs[0]!, jobId: 'synthetic-33'}]}, {...list, jobs: [jobs[0]!, jobs[0]!]}]) {
    expect(() => checkedJobHubList(value, incarnation)).toThrow('JOB_HUB_STATE_INVALID');
  }
});

test('retained frame geometry and child visibility integration preserve inspection ownership', async () => {
  const css = await readFile(new URL('../web/job-hub.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.hub-stage iframe\[hidden\]\s*\{[^}]*display:\s*block\s*!important;[^}]*visibility:\s*hidden/);
  expect(css).toMatch(/\.hub-header select\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*6rem;[^}]*max-width:\s*12rem/);
  const owner = await readFile(new URL('../web/job-hub.ts', import.meta.url), 'utf8');
  expect(owner).toContain('limit: () => current!.limit');
  expect(owner).toContain('!current || retained.atLimit()');
  expect(owner).toContain("row.status === 'closed'");
  const shared = await readFile(new URL('../web/retained-frame-stage.ts', import.meta.url), 'utf8');
  expect(shared).toContain('entry.frame.inert = entry.frame.hidden');
  expect(owner).toContain('createRetainedFrameStage<Frame>');
  expect(owner).not.toContain('connectLiveWindow');
  const child = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
  const start = child.indexOf('    const hubVisibility =');
  const handler = child.slice(start, child.indexOf('    };', start) + '    };'.length);
  expect(handler).toContain("globalThis.parent, hubBinding(), 'visibility'");
  expect(handler).toContain('pauseHiddenHubFrame()');
  for (const forbidden of ['saveDraft(', 'fitCamera(', 'window.stop(', 'pose(', 'time =', 'panel =', 'selectedPart =']) {
    expect(handler).not.toContain(forbidden);
  }
});
