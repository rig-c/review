/** #551 / PR556 accepted P2 controls, frozen before baseline measurement.
 * The archive is a genuine Create-writer history of a synthetic example.
 * Extraction, answer selection and later-scene/answer mutations below are
 * labelled SYNTHETIC controls, not new producer or human-review evidence.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest, readProject} from '../src/interview-project.ts';
import {interviewRoutes} from '../src/interview-routes.ts';

const fixtures = join(import.meta.dir, 'fixtures/scene-interview-551');
const results = resolve(import.meta.dir, '../.review-551-result/ai-p2');
const origin = 'http://127.0.0.1:19484';
const setPath = 'evidence/interview/review551-scene-current.json';
const output = 'synthetic-ai-p2-picks';
const record = 'interview.post.items[0]';
const cleanups: Array<() => void> = [];
const load = (root: string, path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const save = (root: string, path: string, value: unknown) =>
  writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');

function seal(root: string, prefix = ''): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(hashes, seal(root, path + '/'));
    else hashes[path] = digest(readFileSync(join(root, path)));
  }
  return hashes;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function historyFixture(name: string) {
  mkdirSync(join(results, 'runtime'), {recursive: true});
  const root = mkdtempSync(join(results, 'runtime', name + '-'));
  const evidence: Record<string, any> = {label: 'SYNTHETIC controlled copy of genuine writer-history archive'};
  const originals = new Map<string, Buffer>();
  cleanups.push(() => {
    try {
      for (const [path, bytes] of originals) writeFileSync(join(root, path), bytes);
      rmSync(join(root, 'evidence/scene/s2.json'), {force: true});
      rmSync(join(root, output), {recursive: true, force: true});
      evidence.restored = seal(root);
      evidence.restorationEqual = JSON.stringify(evidence.restored) === JSON.stringify(evidence.extracted);
      save(results, name + '.json', evidence);
      if (evidence.extracted) expect(evidence.restored).toEqual(evidence.extracted);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  const archive = join(fixtures, 'writer-history.tar.gz');
  evidence.archiveSHA256 = digest(readFileSync(archive));
  expect(evidence.archiveSHA256).toBe(load(fixtures, 'provenance.json').archives['writer-history.tar.gz']);
  const command = ['tar', '-xzf', archive, '-C', root];
  const extracted = spawnSync(command[0]!, command.slice(1), {encoding: 'utf8'});
  evidence.setup = {command, exit: extracted.status, signal: extracted.signal,
    error: extracted.error?.message, stdout: extracted.stdout, stderr: extracted.stderr};
  save(results, name + '.json', evidence);
  expect(extracted.error).toBeUndefined();
  expect(extracted.status).toBe(0);
  evidence.extracted = seal(root);
  for (const path of ['project.json', setPath]) originals.set(path, readFileSync(join(root, path)));
  const project = load(root, 'project.json');
  const selected = project.interview.post.items.find((item: any) => item.id === 'post_composition');
  const answer = selected.history.find((entry: any) => entry.choice?.set?.path === setPath);
  expect(answer).toBeDefined();
  // SYNTHETIC extraction isolates one genuine writer answer without rewriting it.
  project.interview.framing = [];
  project.interview.waypoints = [];
  project.interview.post.items = [selected];
  delete selected.pending_options;
  delete selected.guide;
  selected.history = [answer];
  mkdirSync(join(root, output));
  return {root, project, selected, answer, evidence};
}

async function get(route: ReturnType<typeof interviewRoutes>, path = '/api/interview') {
  const response = await route(new Request(origin + path), origin);
  expect(response).toBeDefined();
  return response!;
}

test('P2 request-time SYNTHETIC changed or deleted retained set cannot serve clean cached history with unchanged project bytes', async () => {
  const {root, project, answer, evidence} = historyFixture('request-time');
  save(root, 'project.json', project);
  const before = readProject(root);
  expect(before.diagnostics).toEqual([]);
  expect(before.questions[0]!.answer).toEqual(answer);
  evidence.prepared = seal(root);
  // Actual standalone handler, opened before either evidence mutation.
  const route = interviewRoutes(root, output, 'synthetic-ai-p2-capability');
  const initial = await get(route);
  const initialBody = await initial.json();
  expect(initial.status).toBe(200);
  expect(initialBody.diagnostics).toEqual([]);
  expect(initialBody.questions[0].answer).toEqual(answer);
  const originalSet = readFileSync(join(root, setPath));
  const outcomes = [];
  evidence.requests = [];
  for (const mutation of ['changed', 'deleted']) {
    const requestEvidence: Record<string, any> = {mutation};
    evidence.requests.push(requestEvidence);
    try {
      if (mutation === 'changed') writeFileSync(join(root, setPath), '{}\n');
      else rmSync(join(root, setPath));
      const mutated = seal(root);
      const fresh = readProject(root);
      const expectedDiagnostic = {code: 'INTERVIEW_OPTIONS_STALE' as const, question: 'post_composition',
        record: record + '.history[0]', ref: answer.choice.set, at: answer.at};
      expect(fresh.hash).toBe(before.hash);
      expect(fresh.diagnostics).toEqual([expectedDiagnostic]);
      expect(fresh.historical[0]!.answer).toEqual(answer);
      const response = await get(route);
      const body = await response.json();
      const namedRecord = response.status === 200 && body.diagnostics?.some((entry: any) =>
        JSON.stringify(entry) === JSON.stringify(expectedDiagnostic));
      const namedInvalidation = response.status === 409 && body.error === 'INTERVIEW_OPTIONS_STALE';
      Object.assign(requestEvidence, {mutated, projectSHA256: fresh.hash,
        freshDiagnostics: fresh.diagnostics, status: response.status, body});
      outcomes.push({mutation, namedIssue: namedRecord || namedInvalidation});
    } finally {
      writeFileSync(join(root, setPath), originalSet);
      const restored = seal(root);
      requestEvidence.restored = restored;
      expect(restored).toEqual(evidence.prepared);
    }
  }
  expect(outcomes).toEqual([
    {mutation: 'changed', namedIssue: true},
    {mutation: 'deleted', namedIssue: true},
  ]);
});

test('P2 repeated-set SYNTHETIC stale current occurrence preserves valid historical image URLs and raw SHA binding', async () => {
  const {root, project, selected, answer, evidence} = historyFixture('repeated-set');
  const laterScene = load(root, 'evidence/scene/s1.json');
  laterScene.n = 2;
  save(root, 'evidence/scene/s2.json', laterScene);
  // SYNTHETIC later scene plus a later answer to the same unchanged set.
  project.scenes.push({n: 2, path: 'evidence/scene/s2.json',
    sha256: digest(readFileSync(join(root, 'evidence/scene/s2.json'))),
    at: '2026-11-08T12:00:03.500Z', by: 'synthetic-control'});
  selected.guide = structuredClone(answer);
  selected.guide.at = '2026-11-08T12:00:04.000Z';
  selected.guide.verbatim = 'SYNTHETIC later answer to the same retained set';
  save(root, 'project.json', project);
  const before = readProject(root);
  const occurrences = before.questions.filter(question => question.ref.sha256 === answer.choice.set.sha256);
  expect(occurrences).toHaveLength(2);
  expect(occurrences[0]!.images).toEqual([]);
  expect(occurrences[0]!.answer).toEqual(selected.guide);
  expect(occurrences[1]!.answer).toEqual(answer);
  expect(occurrences[1]!.images.length).toBeGreaterThan(0);
  expect(before.diagnostics).toEqual([{code: 'INTERVIEW_OPTIONS_STALE', question: 'post_composition',
    record: record + '.guide', ref: answer.choice.set, at: selected.guide.at}]);
  evidence.prepared = seal(root);
  const route = interviewRoutes(root, output, 'synthetic-ai-p2-capability');
  const response = await get(route);
  const body = await response.json();
  evidence.interview = {status: response.status, body};
  expect(response.status).toBe(200);
  expect(body.diagnostics).toEqual(before.diagnostics);
  const served = body.questions.filter((question: any) => question.ref.sha256 === answer.choice.set.sha256);
  expect(served).toHaveLength(2);
  expect(served[0].images).toEqual([]);
  expect(served[1].answer).toEqual(answer);
  expect(served[1].images).toHaveLength(occurrences[1]!.images.length);
  const outcomes = [];
  evidence.images = [];
  for (const [index, image] of occurrences[1]!.images.entries()) {
    const advertised = served[1].images[index];
    const original = readFileSync(join(root, image.ref.path));
    expect(digest(original)).toBe(image.ref.sha256);
    const asset = await get(route, advertised.url);
    const bytes = Buffer.from(await asset.arrayBuffer());
    let changedStatus: number;
    let changedBody: unknown;
    try {
      writeFileSync(join(root, image.ref.path), Buffer.concat([original, Buffer.from('SYNTHETIC raw-byte mutation')]));
      const changed = await get(route, advertised.url);
      changedStatus = changed.status;
      changedBody = await changed.json();
      evidence.images.push({url: advertised.url, ref: image.ref, status: asset.status,
        contentType: asset.headers.get('content-type'), responseSHA256: digest(bytes),
        changed: {status: changedStatus, body: changedBody, hashes: seal(root)}});
    } finally {
      writeFileSync(join(root, image.ref.path), original);
      expect(seal(root)).toEqual(evidence.prepared);
    }
    outcomes.push({status: asset.status, rawHashMatches: digest(bytes) === image.ref.sha256,
      contentType: asset.headers.get('content-type'), changedStatus, changedBody});
  }
  evidence.afterRequests = seal(root);
  expect(evidence.afterRequests).toEqual(evidence.prepared);
  expect(outcomes).toEqual(occurrences[1]!.images.map(() => ({status: 200, rawHashMatches: true,
    contentType: 'image/png', changedStatus: 409, changedBody: {error: 'INTERVIEW_OPTIONS_STALE'}})));
});
