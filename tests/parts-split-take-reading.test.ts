import { expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot } from '../src/build.ts';
import { resolveProducer } from '../src/producer.ts';
import { clothAssemblyChanges } from '../src/rebuild.ts';

/**
 * #1016: Parts 2.47.0 stamps an occluder-split take's donor `meta.json` as the indexed field `assemble.take[i].meta`.
 * The fixture is a real 2.47.0 assemble of public generated rectangles (its provenance file says how). Review reads the
 * stamp with the installed producer's `@rig-c/parts/assembly-reading`, and the producer's own manifest reader (what
 * `propose`, `rig` and `edited-part --parts` run) must accept the indexed name; 2.46.0 refused it as PARTS_FIELD_TYPE.
 */
const fixture = join(appRoot, 'tests', 'fixtures', 'parts-2.47.0-split-take');
const FIELD = 'assemble.take[1].meta';

function installedProducer() {
  const resolution = resolveProducer([appRoot]);
  if (!resolution.ok) throw new Error(resolution.error);
  return resolution.producer;
}

test('a 2.47.0 split-take stamp reads through Review\'s cloth path and the installed producer\'s manifest reader', async () => {
  const producer = installedProducer();
  const manifest = JSON.parse(await readFile(join(fixture, 'parts.json'), 'utf8')) as { assembly_config: { fields: { name: string }[] } };
  expect(manifest.assembly_config.fields.map(f => f.name)).toContain(FIELD);

  const requireProducer = createRequire(join(producer.root, 'package.json'));
  const { readPartsManifest } = requireProducer(requireProducer.resolve('@rig-c/parts/src/parts.ts')) as { readPartsManifest(path: string): unknown };
  expect(() => readPartsManifest(join(fixture, 'parts.json'))).not.toThrow();

  expect(clothAssemblyChanges(producer, join(fixture, 'config.json'), manifest)).toEqual([]);
  const pin = (JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies['@rig-c/parts'];
  expect(producer.version).toBe(pin!);
});

test('the indexed field is live: a changed split donor meta.json is named as the one changed assembly field', async () => {
  const producer = installedProducer();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'review-split-take-')));
  try {
    await cp(fixture, dir, { recursive: true });
    await writeFile(join(dir, 'split-donor', 'meta.json'), '{"prompt_id":"generated-changed","seed":43}');
    const manifest = JSON.parse(await readFile(join(dir, 'parts.json'), 'utf8')) as unknown;
    expect(clothAssemblyChanges(producer, join(dir, 'config.json'), manifest)).toEqual([FIELD]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
