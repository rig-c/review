import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {partsIssueSubmission} from './helpers/parts-comments-package.ts';
import {afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {resolve, join, dirname} from 'node:path';
import {loadPartsView, readVerdict, saveVerdict, saveVerdictWithReceipt, exportPartsVerdict} from '../src/parts-view.ts';
import {startPartsServer, type PartsSavedEvent, type PartsServerOptions} from '../src/parts-server.ts';
import {writePartsPackage} from './helpers/parts-package.ts';

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const receiptDirectory = resolve('.review-568-result/implementation/continuation-v4/children', `${Date.now()}-${process.pid}`);
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
async function fixture() {
  const base = resolve('.review-568-input');
  await mkdir(base, {recursive: true});
  await mkdir(receiptDirectory, {recursive: true});
  const root = await mkdtemp(join(await realpath(base), 'provenance-'));
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

async function launch(args: string[], bootstrap?: string) {
  const command = bootstrap ? ['-e', bootstrap] : ['src/entry.ts', 'parts', ...args];
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

function post(origin: string, capability: string, body: unknown = input) {
  return fetch(origin + '/api/parts/verdict', {method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-Review-Capability': capability,
  }, body: JSON.stringify(body)});
}
function records(stdout: string): PartsSavedEvent[] {
  return stdout.split('\n').filter(line => line.startsWith('RIG_REVIEW_PARTS_SAVED '))
    .map(line => JSON.parse(line.slice('RIG_REVIEW_PARTS_SAVED '.length)));
}
async function serve(pkg: Awaited<ReturnType<typeof fixture>>, options: PartsServerOptions = {}) {
  const capability = 'a'.repeat(64);
  const server = await startPartsServer(pkg, {port: 0, capability, ...options});
  const origin = `http://127.0.0.1:${server.port}`;
  return {server, origin, save: (body: unknown = input) => post(origin, capability, body)};
}

test('#568 default JSON reads the ordinary verdict plus null attribution and the raw saved digest', async () => {
  const pkg = await fixture();
  const saved = await saveVerdict(pkg, input);
  const bytes = await readFile(pkg.verdictPath);
  const result = await cli([pkg.root, '--format', 'json']);
  expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(result.stdout)).toEqual({...saved, by: null, savedFileSha256: digest(bytes)});
  expect(await readFile(pkg.verdictPath)).toEqual(bytes);
});

test('#568 historical /1 and /2 ignored extensions and /3 named provenance remain immutable', async () => {
  const pkg = await fixture();
  const core = await saveVerdict(pkg, input);
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

test('#568 named launch owns attribution, shared HTTP uses /4, and an unnamed explicit save clears it', async () => {
  const pkg = await fixture(), by = '  나루 \"declared\"\u2028\u2029  ';
  const named = await serve(pkg, {by});
  try {
    const response = await named.save({...input, by: 'browser has no authority'});
    expect(response.status).toBe(200);
    const {verdict} = await response.json();
    const bytes = await readFile(pkg.verdictPath);
    expect(JSON.parse(bytes.toString())).toEqual({...verdict, schema: 'rig-review-parts-verdict/4', by});
    const shared = await readVerdict(pkg);
    expect(shared).toEqual({verdict, stale: null});
    const view = await (await fetch(named.origin + '/api/parts')).json();
    expect(view.verdict).toEqual(verdict);
    const exported = await (await fetch(named.origin + '/api/parts/export?format=json')).json();
    expect(exported).toEqual(verdict);
    const result = await cli([pkg.root, '--format', 'json']);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({...verdict, by, savedFileSha256: digest(bytes)});
    expect(await readFile(pkg.verdictPath)).toEqual(bytes);
    const issue = await cli([pkg.root, '--format', 'issue']);
    expect(issue.exit).toBe(0);
    expect(issue.stdout).toBe(exportPartsVerdict(verdict, 'issue'));
  } finally { named.server.stop(true); }
  const unnamed = await serve(pkg);
  try {
    expect((await unnamed.save({...input, by})).status).toBe(200);
    const stored = JSON.parse(await readFile(pkg.verdictPath, 'utf8'));
    expect(stored.schema).toBe('rig-review-parts-verdict/4');
    expect(Object.hasOwn(stored, 'by')).toBe(false);
    expect(JSON.parse((await cli([pkg.root, '--format', 'json'])).stdout).by).toBeNull();
  } finally { unnamed.server.stop(true); }
});

test('#568 malformed named records retain PARTS_VERDICT_INVALID and cannot be reset by save', async () => {
  const pkg = await fixture(), core = await saveVerdict(pkg, input);
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
      await expect(saveVerdict(pkg, input)).rejects.toThrow('PARTS_VERDICT_INVALID');
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
    const result = await cli([resolve('.review-568-input/does-not-exist'), ...args]);
    expect({exit: result.exit, stdout: result.stdout}).toEqual({exit: 1, stdout: ''});
    expect(result.stderr).toContain('--by');
    expect(result.stderr).not.toContain('PARTS_VIEW_INPUT_MISSING');
  }
});

test('#568 actual CLI emits exactly three framed saves including identical saves and resets count on restart', async () => {
  const pkg = await fixture();
  const verdict = join(pkg.root, 'save-"\\\r\n\u2028\u2029.json');
  const args = [pkg.root, '--port', '0', '--verdict', verdict, '--by', '--declared-name'];
  const launched = await launch(args);
  const expected: PartsSavedEvent[] = [];
  try {
    const fixes = await partsIssueSubmission(pkg);
    for (const body of [input, input, fixes]) {
      const response = await post(launched.origin, launched.capability, body);
      expect(response.status).toBe(200);
      await response.json();
      expected.push({verdictPath: verdict, sha256: digest(await readFile(verdict)), status: body.status as PartsSavedEvent['status'], saveCount: expected.length + 1});
    }
  } finally {
    const result = await launched.stop();
    expect(result.exit).toBe(0);
    expect(records(result.stdout)).toEqual(expected);
    const prefix = 'RIG_REVIEW_PARTS_SAVED ';
    const eventLines = result.stdout.split('\n').filter(line => line.startsWith(prefix));
    expect(eventLines).toHaveLength(3);
    for (const [index, line] of eventLines.entries()) {
      expect(line).not.toContain('\u2028');
      expect(line).not.toContain('\u2029');
      expect(line).toContain('\\u2028');
      expect(line).toContain('\\u2029');
      expect(line).toBe(prefix + JSON.stringify(expected[index]).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
      expect(result.stdout).toContain(line + '\n');
    }
  }
  const restarted = await launch(args);
  try { expect((await post(restarted.origin, restarted.capability)).status).toBe(200); }
  finally {
    const result = await restarted.stop();
    expect(result.exit).toBe(0);
    expect(records(result.stdout).map(record => record.saveCount)).toEqual([1]);
  }
});

test('#568 normal SIGTERM preserves the legacy stdout shutdown line and successful save framing', async () => {
  const pkg = await fixture(), launched = await launch([pkg.root, '--port', '0']);
  let expected: PartsSavedEvent | undefined;
  try {
    const response = await post(launched.origin, launched.capability);
    expect(response.status).toBe(200);await response.json();
    expected = {verdictPath: pkg.verdictPath, sha256: digest(await readFile(pkg.verdictPath)), status: 'approved', saveCount: 1};
  } finally {
    const result = await launched.stop();
    expect(result.exit).toBe(0);
    expect(records(result.stdout)).toEqual([expected!]);
    const eventLine = 'RIG_REVIEW_PARTS_SAVED ' + JSON.stringify(expected) + '\n';
    expect(result.stdout).toContain(eventLine);
    expect(result.stdout.endsWith('review parts: exiting — received SIGTERM.\n')).toBe(true);
    expect(result.stderr).toBe('');
  }
});

test('#568 concurrent saves serialize validation through notification and shutdown drains queued commits', async () => {
  const pkg = await fixture(), events: PartsSavedEvent[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier; });
  let entered!: () => void;
  const firstNotification = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const serving = await serve(pkg, {onSaved: async event => {
    events.push(event);
    expect(digest(await readFile(pkg.verdictPath))).toBe(event.sha256);
    if (event.saveCount === 1) { entered(); await barrier; }
  }});
  const fixes = await partsIssueSubmission(pkg);
  const requests = [serving.save(input), serving.save(fixes), serving.save(input)];
  try {
    await firstNotification;
    // Every request reached the queue before graceful shutdown begins.
    await Bun.sleep(20);
    expect(events.length).toBe(1);
    const stopping = serving.server.shutdown();
    release();
    const responses = await Promise.all(requests);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    await Promise.all(responses.map(response => response.json()));
    await stopping;
    expect(events.map(event => event.saveCount)).toEqual([1, 2, 3]);
    expect(events.map(event => event.status).sort()).toEqual(['approved', 'approved', 'changes-requested']);
    expect(digest(await readFile(pkg.verdictPath))).toBe(events[2]!.sha256);
  } finally { release(); serving.server.stop(true); }
});

test('#568 a committed notification failure preserves the file and prevents queued commits or replay', async () => {
  const pkg = await fixture(), attempts: PartsSavedEvent[] = [], failures: string[] = [];
  const serving = await serve(pkg, {
    onSaved: async event => { attempts.push(event); throw Object.assign(new Error('planted EPIPE'), {code: 'EPIPE'}); },
    onNotifyFailure: error => { failures.push(error.message); },
  });
  try {
    const response = await serving.save();
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('PARTS_VERDICT_NOTIFY_FAILED');
    const committed = await readFile(pkg.verdictPath);
    expect(attempts).toEqual([{verdictPath: pkg.verdictPath, sha256: digest(committed), status: 'approved', saveCount: 1}]);
    const second = await serving.save(await partsIssueSubmission(pkg));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toContain('PARTS_VERDICT_NOTIFY_FAILED');
    expect(attempts.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(await readFile(pkg.verdictPath)).toEqual(committed);
  } finally { serving.server.stop(true); }
});

test('#568 actual CLI broken pipe reports notification failure, exits 1 and preserves its durable save', async () => {
  const pkg = await fixture(), launched = await launch([pkg.root, '--port', '0', '--by', 'pipe reviewer']);
  launched.child.stdout.destroy();
  const response = await post(launched.origin, launched.capability);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('PARTS_VERDICT_NOTIFY_FAILED');
  const result = await launched.done;
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain('PARTS_VERDICT_NOTIFY_FAILED');
  expect(records(result.stdout)).toEqual([]);
  const bytes = await readFile(pkg.verdictPath);
  const stored = JSON.parse(bytes.toString());
  expect(stored).toMatchObject({schema: 'rig-review-parts-verdict/4', by: 'pipe reviewer', status: 'approved'});
  expect(JSON.parse((await cli([pkg.root, '--format', 'json'])).stdout).savedFileSha256).toBe(digest(bytes));
});

test('#568 missing, corrupt, invalid-date, stale files and stale flags keep existing CLI failure behavior', async () => {
  const pkg = await fixture();
  let result = await cli([pkg.root, '--format', 'json']);
  expect(result.exit).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('PARTS_VERDICT_UNAVAILABLE');
  const core = await saveVerdict(pkg, input);
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

test('#568 shared durable writer returns a normalized core and an independently hashed named-buffer receipt', async () => {
  const pkg = await fixture();
  const {verdict, receipt} = await saveVerdictWithReceipt(pkg, {...input, by: 'ignored'}, undefined, ' reviewer ');
  const bytes = await readFile(pkg.verdictPath);
  expect(receipt).toEqual({verdictPath: pkg.verdictPath, sha256: digest(bytes), status: 'approved'});
  expect(verdict.schema).toBe('rig-review-parts-verdict/4');
  expect(verdict.by).toBe(' reviewer ');
  expect(JSON.parse(bytes.toString()).by).toBe(' reviewer ');
});

test('#568 default CLI parses and hashes one saved snapshot and rechecks input freshness', async () => {
  const pkg = await fixture();
  await saveVerdictWithReceipt(pkg, input, undefined, 'snapshot A');
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

test('#568 filesystem write, file-fsync, rename and directory-fsync failures retain named errors and cleanup', async () => {
  const pkg = await fixture(), original = await saveVerdict(pkg, input);
  const bytes = await readFile(pkg.verdictPath);
  const fixes = await partsIssueSubmission(pkg);
  for (const phase of ['mkdir', 'open', 'write', 'file-fsync', 'rename', 'directory-fsync']) {
    await writeFile(pkg.verdictPath, bytes);
    const result = await probe(`
      import {mock} from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalOpen = fs.open, originalRename = fs.rename, originalMkdir = fs.mkdir;
      const phase = ${JSON.stringify(phase)};
      const destination = ${JSON.stringify(pkg.verdictPath)}, destinationParent = ${JSON.stringify(dirname(pkg.verdictPath))};
      const fail = () => {throw Object.assign(new Error('planted ENOSPC'), {code: 'ENOSPC'});};
      mock.module('node:fs/promises', () => ({...fs,
        mkdir: async (path, ...args) => {if (phase === 'mkdir' && String(path) === destinationParent) fail();return originalMkdir(path, ...args);},
        rename: async (from, to) => {if (phase === 'rename' && String(to) === destination) fail();return originalRename(from, to);},
        open: async (path, ...args) => {
          const temporary = String(path).startsWith(destination + '.') && String(path).endsWith('.tmp');
          const directory = String(path) === destinationParent;
          if (temporary && phase === 'open') fail();
          const handle = await originalOpen(path, ...args);
          if (!temporary && !directory) return handle;
          return {
            writeFile: async (...args) => {if (temporary && phase === 'write') fail();return handle.writeFile(...args);},
            sync: async () => {
              if (temporary && phase === 'file-fsync' || directory && phase === 'directory-fsync') fail();
              return handle.sync();
            },
            close: () => handle.close(),
          };
        },
      }));
      const {loadPartsView, saveVerdict} = await import(${JSON.stringify(resolve('src/parts-view.ts'))});
      const pkg = await loadPartsView(${JSON.stringify(pkg.root)});
      try {await saveVerdict(pkg, ${JSON.stringify(fixes)});throw new Error('fault did not fire');}
      catch (error) {console.log(JSON.stringify({error: error.message}));}
      console.log(JSON.stringify({temporaryFiles: (await fs.readdir(pkg.root)).filter(name => name.endsWith('.tmp'))}));
    `);
    expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
    const rows = result.stdout.trim().split('\n').map(row => JSON.parse(row));
    expect(rows[0].error).toContain('PARTS_VERDICT_WRITE_FAILED:');
    expect(rows[0].error).toContain('ENOSPC');
    expect(rows[1].temporaryFiles).toEqual([]);
    if (phase === 'directory-fsync') {
      expect(JSON.parse(await readFile(pkg.verdictPath, 'utf8')).status).toBe('changes-requested');
    } else expect(await readFile(pkg.verdictPath)).toEqual(bytes);
  }
  expect(original.status).toBe('approved');
});

test('#568 a failed second CLI write emits zero records for that save and cannot relabel prior success', async () => {
  const pkg = await fixture();
  const fixes = await partsIssueSubmission(pkg);
  const bootstrap = `
    import {mock} from 'bun:test';
    import * as fs from 'node:fs/promises';
    const rename = fs.rename;
    let calls = 0;
    mock.module('node:fs/promises', () => ({...fs, rename: async (...args) => {
      if (String(args[1]) === ${JSON.stringify(pkg.verdictPath)} && ++calls === 2) throw Object.assign(new Error('planted ENOSPC'), {code: 'ENOSPC'});
      return rename(...args);
    }}));
    const {main} = await import(${JSON.stringify(resolve('src/cli.ts'))});
    await main(['parts', ${JSON.stringify(pkg.root)}, '--port', '0']);
  `;
  const launched = await launch([], bootstrap);
  try {
    expect((await post(launched.origin, launched.capability)).status).toBe(200);
    const before = await readFile(pkg.verdictPath);
    const failed = await post(launched.origin, launched.capability, fixes);
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toContain('PARTS_VERDICT_WRITE_FAILED');
    expect(await readFile(pkg.verdictPath)).toEqual(before);
    expect((await post(launched.origin, launched.capability, fixes)).status).toBe(200);
  } finally {
    const result = await launched.stop();
    expect(result.exit).toBe(0);
    expect(records(result.stdout).map(row => [row.status, row.saveCount])).toEqual([['approved', 1], ['changes-requested', 2]]);
    expect(result.stderr).toContain('PARTS_VERDICT_WRITE_FAILED');
  }
});

test('#568 safe-integer exhaustion refuses before committing in an isolated counter-boundary copy', async () => {
  const pkg = await fixture(), bytes = await readFile(resolve('src/parts-server.ts'));
  const source = bytes.toString();
  expect(source.includes('saveCount = 0')).toBe(true);
  const copy = join(pkg.root, 'counter-boundary.ts');
  const isolated = source.replace('saveCount = 0', 'saveCount = Number.MAX_SAFE_INTEGER')
    .replace(/from '(\.\/[^']+)'/g, (_match, path: string) => `from ${JSON.stringify(resolve('src', path))}`);
  await writeFile(copy, isolated);
  const result = await probe(`
    const {loadPartsView} = await import(${JSON.stringify(resolve('src/parts-view.ts'))});
    const {startPartsServer} = await import(${JSON.stringify(copy)});
    const pkg = await loadPartsView(${JSON.stringify(pkg.root)});
    const events = [];
    const server = await startPartsServer(pkg, {port: 0, onSaved: async event => {events.push(event);}});
    try {
      const origin = 'http://127.0.0.1:' + server.port;
      const response = await fetch(origin + '/api/parts/verdict', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: ${JSON.stringify(JSON.stringify(input))}});
      console.log(JSON.stringify({status: response.status, body: await response.json(), events, saved: (await import('node:fs')).existsSync(pkg.verdictPath)}));
    } finally {server.stop(true);}
  `);
  expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(result.stdout)).toEqual({status: 400, body: {error: 'PARTS_VERDICT_WRITE_FAILED: save count exhausted'}, events: [], saved: false});
  expect(digest(await readFile(resolve('src/parts-server.ts')))).toBe(digest(bytes));
});

test('#568 CLI awaits real Writable backpressure and split pipe writes before the next commit', async () => {
  const pkg = await fixture();
  const fixes = await partsIssueSubmission(pkg);
  const bootstrap = `
    import {Writable} from 'node:stream';
    import {readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const writeToPipe = process.stdout.write.bind(process.stdout);
    const prefix = 'RIG_REVIEW_PARTS_SAVED ';
    const stream = new Writable({highWaterMark: 1, write(chunk, encoding, callback) {
      const event = JSON.parse(chunk.toString().slice(prefix.length));
      const middle = Math.floor(chunk.length / 2);
      writeToPipe(chunk.subarray(0, middle), error => {
        if (error) {callback(error);return;}
        setTimeout(() => writeToPipe(chunk.subarray(middle), error => {
          const sha256 = createHash('sha256').update(readFileSync(event.verdictPath)).digest('hex');
          console.error('BACKPRESSURE_COMPLETE ' + JSON.stringify({saveCount: event.saveCount, stableRawDigest: sha256 === event.sha256}));
          callback(error);
        }), 25);
      });
    }});
    process.stdout.write = function(chunk, ...args) {
      if (!String(chunk).startsWith(prefix)) return writeToPipe(chunk, ...args);
      const accepted = stream.write(chunk, ...args);
      console.error('BACKPRESSURE_RETURN ' + accepted);
      return accepted;
    };
    const {main} = await import(${JSON.stringify(resolve('src/cli.ts'))});
    await main(['parts', ${JSON.stringify(pkg.root)}, '--port', '0']);
  `;
  const launched = await launch([], bootstrap);
  try {
    const responses = await Promise.all([
      post(launched.origin, launched.capability),
      post(launched.origin, launched.capability, fixes),
      post(launched.origin, launched.capability),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    await Promise.all(responses.map(response => response.json()));
  } finally {
    const result = await launched.stop();
    expect(result.exit).toBe(0);
    expect(records(result.stdout).map(event => event.saveCount)).toEqual([1, 2, 3]);
    const lines = result.stderr.split('\n');
    expect(lines.filter(line => line === 'BACKPRESSURE_RETURN false')).toHaveLength(3);
    const completions = lines.filter(line => line.startsWith('BACKPRESSURE_COMPLETE '))
      .map(line => JSON.parse(line.slice('BACKPRESSURE_COMPLETE '.length)));
    expect(completions).toEqual([1, 2, 3].map(saveCount => ({saveCount, stableRawDigest: true})));
  }
});

test('#568 native fsync order covers the saved file and every newly created directory entry', async () => {
  const pkg = await fixture(), destination = join(pkg.root, 'new-output', 'nested', 'verdict.json');
  const result = await probe(`
    import {mock} from 'bun:test';
    import * as fs from 'node:fs/promises';
    const originalOpen = fs.open, originalRename = fs.rename;
    const operations = [];
    mock.module('node:fs/promises', () => ({...fs,
      open: async (path, ...args) => {
        const handle = await originalOpen(path, ...args);
        return {
          writeFile: (...args) => handle.writeFile(...args),
          sync: async () => {await handle.sync();operations.push(String(path).endsWith('.tmp') ? 'file fsync' : String(path));},
          close: () => handle.close(),
        };
      },
      rename: async (...args) => {await originalRename(...args);operations.push('rename');},
    }));
    const {loadPartsView, saveVerdictWithReceipt} = await import(${JSON.stringify(resolve('src/parts-view.ts'))});
    const pkg = await loadPartsView(${JSON.stringify(pkg.root)}, {verdict: ${JSON.stringify(destination)}});
    const saved = await saveVerdictWithReceipt(pkg, ${JSON.stringify(input)});
    console.log(JSON.stringify({operations, receipt: saved.receipt}));
  `);
  expect({exit: result.exit, stderr: result.stderr}).toEqual({exit: 0, stderr: ''});
  const output = JSON.parse(result.stdout);
  expect(output.operations).toEqual(['file fsync', 'rename', join(pkg.root, 'new-output', 'nested'), join(pkg.root, 'new-output'), pkg.root]);
  expect(output.receipt).toEqual({verdictPath: destination, sha256: digest(await readFile(destination)), status: 'approved'});
});

test('#568 nonblank reviewer names retain their original string beyond unrelated manifest string bounds', async () => {
  const pkg = await fixture(), by = '  ' + '나루'.repeat(6000) + '  ';
  const launched = await launch([pkg.root, '--port', '0', '--by', by]);
  try {
    const response = await post(launched.origin, launched.capability);
    expect(response.status).toBe(200);await response.json();
  } finally { expect((await launched.stop()).exit).toBe(0); }
  const bytes = await readFile(pkg.verdictPath);
  expect(JSON.parse(bytes.toString()).by).toBe(by);
  const read = await cli([pkg.root, '--format', 'json']);
  expect({exit: read.exit, stderr: read.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(read.stdout)).toMatchObject({by, savedFileSha256: digest(bytes)});
});

test('#568 filesystem-limit destination still saves and emits one complete record without an event-size cap', async () => {
  const pkg = await fixture(), suffix = '.00000000-0000-0000-0000-000000000000.tmp';
  expect(Buffer.byteLength(suffix)).toBe(41);
  const probeTemporary = async (path: string) => {
    const handle = await open(path + suffix, 'wx');
    await handle.close();await rm(path + suffix);
  };
  let directory = join(pkg.root, 'path-boundary');
  await mkdir(directory);
  let directoryBound = false;
  for (let depth = 0; depth < 128; depth++) {
    const next = join(directory, '\x01'.repeat(120));
    try {await mkdir(next);await probeTemporary(join(next, 'v'));directory = next;}
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
      directoryBound = true;break;
    }
  }
  expect(directoryBound).toBe(true);
  let destination = '', firstRejectedBytes = 0;
  for (let length = 1; length <= 4096; length++) {
    const candidate = join(directory, '\x01'.repeat(length));
    try {await probeTemporary(candidate);destination = candidate;}
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
      firstRejectedBytes = Buffer.byteLength(candidate + suffix);break;
    }
  }
  expect(destination.length).toBeGreaterThan(0);
  expect(firstRejectedBytes).toBe(Buffer.byteLength(destination + suffix) + 1);
  const launched = await launch([pkg.root, '--port', '0', '--verdict', destination]);
  try {
    const response = await post(launched.origin, launched.capability);
    expect(response.status).toBe(200);await response.json();
  } finally {
    const result = await launched.stop();
    expect(result.exit).toBe(0);
    const expected: PartsSavedEvent = {verdictPath: destination, sha256: digest(await readFile(destination)), status: 'approved', saveCount: 1};
    expect(records(result.stdout)).toEqual([expected]);
    const line = 'RIG_REVIEW_PARTS_SAVED ' + JSON.stringify(expected) + '\n';
    expect(result.stdout).toContain(line);
    console.log(JSON.stringify({control: 'filesystem-limit-event', pathBytes: Buffer.byteLength(destination),
      temporaryPathBytes: Buffer.byteLength(destination + suffix), firstRejectedBytes, eventBytes: Buffer.byteLength(line)}));
  }
  const read = await cli([pkg.root, '--verdict', destination, '--format', 'json']);
  expect({exit: read.exit, stderr: read.stderr}).toEqual({exit: 0, stderr: ''});
  expect(JSON.parse(read.stdout)).toMatchObject({by: null, savedFileSha256: digest(await readFile(destination))});
});
