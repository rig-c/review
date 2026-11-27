import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {partsIssueSubmission} from './helpers/parts-comments-package.ts';
import {afterAll, afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {LOCAL_COMMENTS_ROUTE} from '../src/local-comments.ts';
import {loadPartsView, readVerdict, exportPartsVerdict, verdictSource} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {writePartsPackage} from './helpers/parts-package.ts';
import {seedPartsVerdictFixture} from './helpers/parts-verdict-fixture.ts';

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const scratchRoot = await realpath(await mkdtemp(join(tmpdir(), 'review-568-')));
const receiptDirectory = join(scratchRoot, 'children', `${Date.now()}-${process.pid}`);
await mkdir(receiptDirectory, {recursive: true});
let childSequence = 0;
const input = {status: 'approved', issues: []};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
afterAll(async () => {
  await rm(scratchRoot, {recursive: true, force: true});
});
async function fixture() {
  await mkdir(receiptDirectory, {recursive: true});
  const root = await mkdtemp(join(scratchRoot, 'provenance-'));
  roots.push(root);
  await writePartsPackage(root);
  return loadPartsView(root);
}
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, 'src/entry.ts', 'parts', ...args], {stdout: 'pipe', stderr: 'pipe', env: {...process.env}});
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const artifact = join(receiptDirectory, 'child-' + ++childSequence);
  await writeFile(artifact + '.stdout', stdout);
  await writeFile(artifact + '.stderr', stderr);
  await writeFile(artifact + '.json', JSON.stringify({command: ['src/entry.ts', 'parts', ...args], exit}) + '\n');
  return {stdout, stderr, exit};
}

async function probe(script: string) {
  const child = Bun.spawn([process.execPath, '-e', script], {stdout: 'pipe', stderr: 'pipe', env: {...process.env}});
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const artifact = join(receiptDirectory, 'child-' + ++childSequence);
    await writeFile(artifact + '.stdout', stdout);await writeFile(artifact + '.stderr', stderr);
    await writeFile(artifact + '.json', JSON.stringify({command: [process.execPath, '-e', script], exit}) + '\n');
    return {stdout, stderr, exit};
  } finally { clearTimeout(timer); }
}

async function launch(args: string[]) {
  const command = ['src/entry.ts', 'parts', ...args];
  const child = spawn(process.execPath, command, {stdio: 'pipe'});
  children.add(child);
  let stdout = '', stderr = '';
  const stdoutChunkLengths: number[] = [];
  child.stdout.on('data', chunk => { stdout += chunk.toString(); stdoutChunkLengths.push(chunk.length); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const artifact = join(receiptDirectory, 'child-' + ++childSequence);
  const done = new Promise<{stdout: string; stderr: string; exit: number | null}>(resolveDone => {
    child.once('close', async exit => {
      clearTimeout(timer);
      children.delete(child);
      await writeFile(artifact + '.stdout', stdout);
      await writeFile(artifact + '.stderr', stderr);
      await writeFile(artifact + '.json', JSON.stringify({command, exit, stdoutChunkLengths}) + '\n');
      resolveDone({stdout, stderr, exit});
    });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const ready = await new Promise<RegExpMatchArray>((resolveReady, reject) => {
    const check = () => {
      const match = stdout.match(/Parts view ready: (http:\/\/127\.0\.0\.1:\d+)\/#cap=([a-f0-9]+)/);
      if (match) { child.stdout.removeListener('data', check); resolveReady(match); }
    };
    child.stdout.on('data', check);
    child.once('close', () => reject(new Error('CLI exited before startup: ' + stderr)));
    child.once('error', reject);
    check();
  });
  return {child, done, origin: ready[1]!, capability: ready[2]!, stop: async () => {
    child.kill('SIGTERM');
    return done;
  }};
}

test('#568 default JSON reads the ordinary verdict plus null attribution and the raw saved digest', async () => {
  const pkg = await fixture();
  const saved = await seedPartsVerdictFixture(pkg, input);
  const bytes = await readFile(pkg.verdictPath);
  const stored = JSON.parse(bytes.toString());
  expect(stored.schema).toBe('rig-review-parts-verdict/4');
  expect(Object.hasOwn(stored, 'by')).toBe(false);
  const result = await cli([pkg.root, '--format', 'json']);
  expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(result.stdout)).toEqual({...saved, by: null, savedFileSha256: digest(bytes)});
  expect(await readFile(pkg.verdictPath)).toEqual(bytes);
});

test('#568 historical /1 and /2 ignored extensions and /3 named provenance remain immutable', async () => {
  const pkg = await fixture();
  const core = await seedPartsVerdictFixture(pkg, input);
  const {issues: _issues, ...legacyCore} = core;
  const parts = Object.fromEntries(pkg.items.map(item => [item.name, {outcome: 'clean', note: 'checked', flags: pkg.flags.filter(flag => flag.item === item.name).map(flag => flag.id)}]));
  for (const schema of ['rig-review-parts-verdict/1', 'rig-review-parts-verdict/2']) {
    for (const by of ['old extension', null, 42, {name: 'ignored'}]) {
      const bytes = Buffer.from(JSON.stringify({...legacyCore, schema, parts, comments: [], by}, null, 1) + '\n\n');
      await writeFile(pkg.verdictPath, bytes);
      const result = await cli([pkg.root, '--format', 'json']);
      expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
      expect(JSON.parse(result.stdout)).toEqual({...core, by: null, savedFileSha256: digest(bytes)});
      expect(await readVerdict(pkg)).toEqual({verdict: core, stale: null});
      expect(await readFile(pkg.verdictPath)).toEqual(bytes);
    }
  }
  const by = ' historical reviewer ';
  const bytes = Buffer.from(JSON.stringify({...legacyCore, schema: 'rig-review-parts-verdict/3', parts, comments: [], by}, null, 1) + '\n\n');
  await writeFile(pkg.verdictPath, bytes);
  const result = await cli([pkg.root, '--format', 'json']);
  expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(result.stdout)).toEqual({...core, by, savedFileSha256: digest(bytes)});
  expect(await readVerdict(pkg)).toEqual({verdict: {...core, by}, stale: null});
  expect(await readFile(pkg.verdictPath)).toEqual(bytes);
});

test('#568 named /4 verdicts retain attribution in HTTP and CLI reads', async () => {
  const pkg = await fixture(), by = '  나루 "declared"\u2028\u2029  ';
  const verdict = await seedPartsVerdictFixture(pkg, input, by);
  const bytes = await readFile(pkg.verdictPath);
  const server = await startPartsServer(pkg, {port: 0});
  try {
    expect(JSON.parse(bytes.toString())).toEqual({...verdict, schema: 'rig-review-parts-verdict/4', by});
    expect(await readVerdict(pkg)).toEqual({verdict, stale: null});
    const origin = 'http://127.0.0.1:' + server.port;
    const view = await (await fetch(origin + '/api/parts')).json();
    expect(view.verdict).toEqual(verdict);
    const exported = await (await fetch(origin + '/api/parts/export?format=json')).json();
    expect(exported).toEqual(verdict);
    const result = await cli([pkg.root, '--format', 'json']);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({...verdict, by, savedFileSha256: digest(bytes)});
    expect(await readFile(pkg.verdictPath)).toEqual(bytes);
    const issue = await cli([pkg.root, '--format', 'issue']);
    expect(issue.exit).toBe(0);
    expect(issue.stdout).toBe(exportPartsVerdict(verdict, 'issue'));
  } finally { server.stop(true); }
});

test('#568 malformed named records retain PARTS_VERDICT_INVALID and their original bytes', async () => {
  const pkg = await fixture(), core = await seedPartsVerdictFixture(pkg, input);
  const {issues: _issues, ...legacyCore} = core;
  const parts = Object.fromEntries(pkg.items.map(item => [item.name, {outcome: 'clean', note: 'checked', flags: pkg.flags.filter(flag => flag.item === item.name).map(flag => flag.id)}]));
  for (const schema of ['rig-review-parts-verdict/3', 'rig-review-parts-verdict/4']) {
    const names = schema.endsWith('/3') ? [undefined, null, 2, '', ' \t\n'] : [null, 2, '', ' \t\n'];
    for (const by of names) {
      const record = schema.endsWith('/3') ? {...legacyCore, schema, parts, comments: [], by} : {...core, by};
      const bytes = Buffer.from(JSON.stringify(record));
      await writeFile(pkg.verdictPath, bytes);
      const result = await cli([pkg.root, '--format', 'json']);
      expect({exit: result.exit, stdout: result.stdout}).toEqual({exit: 1, stdout: ''});
      expect(result.stderr).toContain('PARTS_VERDICT_INVALID');
      expect(await readFile(pkg.verdictPath)).toEqual(bytes);
    }
  }
});

test('#568 --by rejects duplicate, missing, blank, export and correction conflicts before reading input', async () => {
  const cases = [
    ['--by'], ['--by', ''], ['--by', ' \t\n'], ['--by', 'A', '--by', 'B'],
    ['--by', 'A', '--format', 'json'], ['--format', 'issue', '--by', 'A'],
    ['--by', 'A', '--correction', 'c'], ['--by', 'A', '--parts-file', 'inventory'],
    ['--by', 'A', '--part-note', 'part'],
  ];
  for (const args of cases) {
    const result = await cli([join(scratchRoot, 'does-not-exist'), ...args]);
    expect({exit: result.exit, stdout: result.stdout}).toEqual({exit: 1, stdout: ''});
    expect(result.stderr).toContain('--by');
    expect(result.stderr).not.toContain('PARTS_VIEW_INPUT_MISSING');
  }
});

test('#1233 parts CLI sends attributed local comments without a standalone verdict or stdout save receipt', async () => {
  const pkg = await fixture(), by = '  나루 "declared"\u2028\u2029  ';
  const launched = await launch([pkg.root, '--port', '0', '--by', by]);
  try {
    const headers = {Origin: launched.origin, 'Content-Type': 'application/json', 'X-Review-Capability': launched.capability};
    const removed = await fetch(launched.origin + '/api/parts/verdict', {
      method: 'POST', headers, body: JSON.stringify(input),
    });
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({error: 'Not found'});
    const sendId = crypto.randomUUID(), value = {comments: [{text: 'Inspect the edge'}]};
    const sent = await fetch(launched.origin + LOCAL_COMMENTS_ROUTE, {
      method: 'POST', headers, body: JSON.stringify({sendId, value, sourceHash: verdictSource(pkg).sha256}),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({sendId, at: expect.any(String)});
    expect(await Bun.file(pkg.verdictPath).exists()).toBe(false);
    const read = await cli([pkg.root, '--format', 'json']);
    expect({exit: read.exit, stderr: read.stderr}).toEqual({exit: 0, stderr: ''});
    expect(JSON.parse(read.stdout).localComments.sends).toMatchObject([{sendId, value, by}]);
  } finally {
    const result = await launched.stop();
    expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
    expect(result.stdout).toContain('review parts: exiting — received SIGTERM.');
    expect(result.stdout).not.toContain('RIG_REVIEW_PARTS_SAVED ');
  }
});

test('#568 missing, corrupt, invalid-date, stale files and stale flags keep existing CLI failure behavior', async () => {
  const pkg = await fixture();
  let result = await cli([pkg.root, '--format', 'json']);
  expect(result.exit).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('PARTS_VERDICT_UNAVAILABLE');
  const core = await seedPartsVerdictFixture(pkg, input);
  for (const [text, code] of [
    ['{', 'PARTS_VERDICT_INVALID'],
    [JSON.stringify({...core, updatedAt: 'invalid date'}), 'PARTS_VERDICT_INVALID'],
    [JSON.stringify({...core, source: {...core.source, sha256: '0'.repeat(64)}}), 'PARTS_VERDICT_UNAVAILABLE'],
    [JSON.stringify({...core, source: {...core.source, flags: []}}), 'PARTS_VERDICT_UNAVAILABLE'],
  ]) {
    await writeFile(pkg.verdictPath, text!);
    result = await cli([pkg.root, '--format', 'json']);
    expect(result.exit).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain(code!);
    expect(await readFile(pkg.verdictPath, 'utf8')).toBe(text!);
  }
});

test('#568 default CLI parses and hashes one saved snapshot and rechecks input freshness', async () => {
  const pkg = await fixture();
  await seedPartsVerdictFixture(pkg, input, 'snapshot A');
  const bytes = await readFile(pkg.verdictPath), other = JSON.parse(bytes.toString());
  other.by = 'snapshot B';Object.assign(other, await partsIssueSubmission(pkg));
  const replacement = Buffer.from(JSON.stringify(other)).toString('base64');
  const script = (changeSource: boolean) => `
    import {mock} from 'bun:test';
    import * as fs from 'node:fs/promises';
    const originalRead = fs.readFile, originalWrite = fs.writeFile;
    const target = ${JSON.stringify(pkg.verdictPath)};
    let reads = 0;
    mock.module('node:fs/promises', () => ({...fs, readFile: async (file, ...args) => {
      const bytes = await originalRead(file, ...args);
      if (String(file) === target) {
        reads++;
        if (reads === 1) {
          await originalWrite(target, Buffer.from(${JSON.stringify(replacement)}, 'base64'));
          ${changeSource ? `await originalWrite(${JSON.stringify(pkg.imagePaths[0])}, 'changed source');` : ''}
        }
      }
      return bytes;
    }}));
    const {main} = await import(${JSON.stringify(resolve('src/cli.ts'))});
    try { await main(['parts', ${JSON.stringify(pkg.root)}, '--format', 'json']); }
    catch (error) {console.error(error.message);process.exitCode = 1;}
    console.error('SAVED_SNAPSHOT_READS=' + reads);
  `;
  const result = await probe(script(false));
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe('SAVED_SNAPSHOT_READS=1\n');
  expect(JSON.parse(result.stdout)).toMatchObject({by: 'snapshot A', status: 'approved', savedFileSha256: digest(bytes)});
  expect(JSON.parse(await readFile(pkg.verdictPath, 'utf8')).by).toBe('snapshot B');
  await writeFile(pkg.verdictPath, bytes);
  const stale = await probe(script(true));
  expect(stale.exit).toBe(1);expect(stale.stdout).toBe('');
  expect(stale.stderr).toContain('PARTS_VIEW_SOURCE_CHANGED');
  expect(stale.stderr).toContain('SAVED_SNAPSHOT_READS=1');
});

test('#568 historical /4 reads preserve long nonblank reviewer names and the raw digest', async () => {
  const pkg = await fixture(), by = '  ' + '나루'.repeat(6000) + '  ';
  await seedPartsVerdictFixture(pkg, input, by);
  const bytes = await readFile(pkg.verdictPath);
  expect(JSON.parse(bytes.toString()).by).toBe(by);
  const read = await cli([pkg.root, '--format', 'json']);
  expect({exit: read.exit, stderr: read.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(read.stdout)).toMatchObject({by, savedFileSha256: digest(bytes)});
});

test('#568 CLI reads a historical verdict near the filesystem path limit and hashes its raw bytes', async () => {
  const pkg = await fixture(), suffix = '.00000000-0000-0000-0000-000000000000.tmp';
  // Leave the filename headroom that a historically saved verdict needed.
  const probeLegacyPath = async (path: string) => {
    const handle = await open(path + suffix, 'wx');
    await handle.close();await rm(path + suffix);
  };
  let directory = join(pkg.root, 'path-boundary');
  await mkdir(directory);
  let directoryBound = false;
  for (let depth = 0; depth < 128; depth++) {
    const next = join(directory, '\x01'.repeat(120));
    try {await mkdir(next);await probeLegacyPath(join(next, 'v'));directory = next;}
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
      directoryBound = true;break;
    }
  }
  expect(directoryBound).toBe(true);
  let destination = '', firstRejectedBytes = 0;
  for (let length = 1; length <= 4096; length++) {
    const candidate = join(directory, '\x01'.repeat(length));
    try {await probeLegacyPath(candidate);destination = candidate;}
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
      firstRejectedBytes = Buffer.byteLength(candidate + suffix);break;
    }
  }
  expect(destination.length).toBeGreaterThan(0);
  expect(firstRejectedBytes).toBe(Buffer.byteLength(destination + suffix) + 1);
  const view = await loadPartsView(pkg.root, {verdict: destination});
  expect(view.verdictPath).toBe(destination);
  const saved = await seedPartsVerdictFixture(view, input);
  const bytes = await readFile(destination);
  console.log(JSON.stringify({control: 'filesystem-limit-destination', pathBytes: Buffer.byteLength(destination),
    legacyPathBytes: Buffer.byteLength(destination + suffix), firstRejectedBytes}));
  const read = await cli([pkg.root, '--verdict', destination, '--format', 'json']);
  expect({exit: read.exit, stderr: read.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(read.stdout)).toEqual({...saved, by: null, savedFileSha256: digest(bytes)});
  expect(await readFile(destination)).toEqual(bytes);
});
