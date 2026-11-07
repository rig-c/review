/** Disposable child. Register the source loader before importing any Review module. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';

const mode = Bun.argv[2];
const variant = Bun.argv[3];
assert.ok(mode === 'referenced' || mode === 'retained');
assert.ok(variant === 'guarded' || variant === 'bypass');
const sourcePath = fileURLToPath(new URL('../../src/job-source.ts', import.meta.url));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(sourcePath, 'utf8');
const originalSha256 = hash(original);
const limit = 128 * 1024;
let loads = 0;
let transformedSha256 = '';
Bun.plugin({name: 'aggregate-limit-child-only', setup(builder) {
  builder.onLoad({filter: /\/src\/job-source\.ts$/}, ({path}) => {
    assert.equal(path, sourcePath);
    loads++;
    const declaration = 'const maxSourceBytes = 256 * 1024 * 1024;';
    assert.equal(original.split(declaration).length, 2);
    let contents = original.replace(declaration, `const maxSourceBytes = ${limit};`);
    if (variant === 'bypass') {
      for (const predicate of ['total > maxSourceBytes', 'size > maxSourceBytes']) {
        assert.equal(contents.split(predicate).length, 2);
        contents = contents.replace(predicate, 'false');
      }
    }
    assert.ok(contents.includes('const maxFileBytes = 64 * 1024 * 1024;'));
    assert.ok(contents.includes('width > Math.floor(maxFileBytes / 4 / height)'));
    transformedSha256 = hash(contents);
    console.log(JSON.stringify({stage: 'target-loaded', mode, variant, sourcePath,
      originalSha256, transformedSha256, loweredLimit: limit}));
    return {contents, loader: 'ts'};
  });
}});

// Dynamic import is deliberately after registration. This helper reaches JobSession's normal API.
const {jobFixture, jobInputHashes} = await import('./job-api-fixture.ts');
assert.equal(loads, 1, 'AGGREGATE_TARGET_NOT_LOADED');
const f = await jobFixture();
try {
  const png = new PNG({width: 128, height: 128});
  let random = 501;
  for (let i = 0; i < png.data.length; i++) {
    if (i % 4 === 3) {png.data[i] = 255; continue;}
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    png.data[i] = random & 255;
  }
  const image = PNG.sync.write(png);
  const manifest = '{"syntheticAggregate":1}\n';
  assert.ok(manifest.length + 2 * image.length < limit);
  assert.ok(manifest.length + 3 * image.length > limit);
  assert.ok(image.length < 64 * 1024 * 1024);
  await mkdir(join(f.root, 'aggregate/parts'), {recursive: true});
  await writeFile(join(f.root, 'aggregate/parts.json'), manifest);
  for (const name of ['a', 'b', 'c']) await writeFile(join(f.root, `aggregate/parts/${name}.png`), image);
  const extra = Buffer.alloc(limit, 42);
  await writeFile(join(f.root, 'retained-extra.bin'), extra);
  const rows = ['a', 'b', 'c'].map(name => ({path: `parts/${name}.png`, role: 'part', sha256: hash(image)}));
  const parts = {enumeratorVersion: f.partsEnumerator.version,
    manifest: {path: 'aggregate/parts.json', sha256: hash(manifest)}, images: rows.slice(0, 1)};
  f.setPartsReferences(parts.images.map(({path, role}) => ({path, role})));
  f.setContext({...f.getContext(), parts});
  const publication = await f.publish();
  const baseline = f.session.status();
  const inputHashes = await jobInputHashes(f.root);
  const retained = f.session.retainedSource(publication.publicationId);
  let baselineBytes = 0;
  for (const row of retained.seals) baselineBytes += (await readFile(join(f.root, row.path))).length;
  assert.ok(baselineBytes < limit, 'AGGREGATE_BASELINE_MUST_FIT');
  if (mode === 'referenced') {
    f.setPartsReferences(rows.map(({path, role}) => ({path, role})));
    f.setContext({...f.getContext(), parts: {...parts, images: rows}});
  } else {
    assert.ok(manifest.length + image.length < limit);
    f.setContext({...f.getContext(), files: [{path: 'retained-extra.bin', sha256: hash(extra)}]});
  }
  const response = await f.call(await f.publishRequest());
  const result = await response.json();
  const headUnchanged = JSON.stringify(f.session.status()) === JSON.stringify(baseline);
  assert.deepEqual(await jobInputHashes(f.root), inputHashes, 'AGGREGATE_INPUT_BYTES_CHANGED');
  console.log(JSON.stringify({stage: 'result', mode, variant, result, status: response.status,
    baselineBytes, imageBytes: image.length, manifestBytes: manifest.length,
    referencedBytes: manifest.length + image.length * (mode === 'referenced' ? 3 : 1),
    retainedBytes: baselineBytes + (mode === 'retained' ? extra.length : image.length * 2),
    headUnchanged, originalSha256, transformedSha256, loads}));
  assert.equal(result.ok, false, 'AGGREGATE_REFUSAL_REQUIRED');
  assert.equal(response.status, 409);
  assert.deepEqual(result.error, {code: 'JOB_SOURCE_UNRETAINABLE', message: mode === 'referenced'
    ? 'PARTS_REFERENCE_LIMIT row=2 role=part path="parts/c.png"' : 'JOB_SOURCE_UNRETAINABLE'});
  assert.equal(headUnchanged, true, 'AGGREGATE_HEAD_CHANGED');
} finally {
  await f.close();
  const restoredSha256 = hash(await readFile(sourcePath));
  console.log(JSON.stringify({stage: 'source-unchanged', originalSha256, restoredSha256}));
  assert.equal(restoredSha256, originalSha256);
}
