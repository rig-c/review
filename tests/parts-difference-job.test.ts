import {expect, spyOn, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {differencePixels} from '../src/parts-comparison.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {partsDifferenceJobFixture} from './helpers/parts-difference-job-fixture.ts';

test('#896 parts job admits only Difference queries and compares decoded bound RGB edited parts', async () => {
  const f = await partsDifferenceJobFixture();
  try {
    const before = await jobInputHashes(f.input.root);
    const response = await fetch(f.api + 'stage-parts/difference/0?threshold=0&footprints=false');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const actual = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    const expected = differencePixels(f.part, f.source.body, f.source.painting, [], 0, false);
    expect(actual.data).toEqual(Buffer.from(expected.data));
    expect(response.headers.get('x-difference-count')).toBe(String(expected.count));
    expect(f.operand[25]).toBe(2);
    expect(await readFile(join(f.packageRoot, 'edited/body.png'))).toEqual(f.operand);
    const retained = f.host.session.retainedSource(f.publication.publicationId);
    expect(retained.seals.some(file => file.path === 'out/edited/body.png')).toBe(true);
    for (const path of ['stage-parts', 'stage-parts/image/0', 'review', 'stage-parts/difference/00']) {
      const denied = await fetch(f.api + path + '?threshold=0&footprints=false');
      expect(denied.status).toBe(400);
      expect((await denied.json()).error.code).toBe('JOB_REQUEST_INVALID');
    }
    for (const query of ['threshold=0', 'threshold=1000&footprints=false', 'threshold=0&footprints=no']) {
      const denied = await fetch(f.api + 'stage-parts/difference/0?' + query);
      expect(denied.status).toBe(400);
      expect((await denied.json()).error.code).toBe('JOB_REQUEST_INVALID');
    }
    // Unrelated comparison validation errors retain the existing generic path.
    const unrelated = await fetch(f.api + 'stage-parts/difference/0?threshold=256&footprints=false');
    expect(unrelated.status).toBe(409);
    expect((await unrelated.json()).error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(await jobInputHashes(f.input.root)).toEqual(before);
  } finally {await f.close();}
});

test('#896 internal page responses preserve only the named Difference refusals', async () => {
  for (const options of [{declared: false}, {}]) {
    const f = await partsDifferenceJobFixture(options);
    try {
      const metadata = await (await fetch(f.api + 'stage-parts')).json();
      expect(metadata.differenceAvailable).toBe(options.declared !== false);
      const index = options.declared === false ? 0 : 99;
      const response = await fetch(f.api + `stage-parts/difference/${index}?threshold=0&footprints=false`);
      expect(response.status).toBe(400);
      const code = 'PARTS_DIFFERENCE_UNAVAILABLE';
      expect(await response.json()).toEqual({ok: false, error: {code, message: code}});
    } finally {await f.close();}
  }
});

test('#896 decoder failure remains a named internal PNG refusal without changing source bytes', async () => {
  const f = await partsDifferenceJobFixture();
  try {
    // Publication admission already validates every part PNG. Plant a decode failure
    // after admission, rather than weakening its source and seal checks with bad bytes.
    await (await fetch(f.api + 'stage-parts')).json();
    const read = PNG.sync.read;
    const decode = spyOn(PNG.sync, 'read').mockImplementation((bytes, options) => {
      if (bytes.equals(f.operand)) throw new Error('planted decoder failure');
      return read(bytes, options);
    });
    try {
      const response = await fetch(f.api + 'stage-parts/difference/0?threshold=0&footprints=false');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ok: false, error: {code: 'PARTS_DIFFERENCE_PNG', message: 'PARTS_DIFFERENCE_PNG'}});
    } finally {decode.mockRestore();}
    expect(await readFile(join(f.packageRoot, 'parts/body.png'))).toEqual(f.operand);
  } finally {await f.close();}
});
