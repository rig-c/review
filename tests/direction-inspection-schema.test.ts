import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readDirectionInspection } from '../src/direction-inspection.ts';

const v1Path = 'tests/fixtures/direction-inspection/evidence/direction/v2.json';
const v1Sha256 = '9bec50f753d4790ee0d9dde824a612126ed37e7b0e63d393505ac836118c50a4';
const v2Path = 'tests/fixtures/create-direction-v2.json';
const v2Sha256 = '516987b49d9c032883406e1fe5e3b27658c252ffebc5cde340ffba5f60cf3de7';

test('readDirectionInspection preserves rig-create/direction@1 acceptance and invalid schema/mismatch refusals', async () => {
  const v1Bytes = await readFile(v1Path);
  expect(createHash('sha256').update(v1Bytes).digest('hex')).toBe(v1Sha256);
  const v1Doc = JSON.parse(v1Bytes.toString('utf8'));
  const v1File = { path: 'evidence/direction/v2.json', sha256: v1Sha256 };
  expect(readDirectionInspection(v1Doc, v1File, v1Doc.rig.model)).toEqual({
    file: v1File,
    model: v1Doc.rig.model,
    rigVersion: 1,
    camera: v1Doc.camera,
    take: v1Doc.take,
    timing: v1Doc.timing.keys,
  });

  for (const schema of ['rig-create/direction@0', 'rig-create/direction@3', 'rig-create/scene@1', undefined]) {
    expect(() => readDirectionInspection({ ...v1Doc, schema }, v1File, v1Doc.rig.model)).toThrow('DIRECTION_SCHEMA');
  }
  expect(() => readDirectionInspection(v1Doc, v1File, null)).toThrow('DIRECTION_MODEL_MISMATCH');
  expect(() => readDirectionInspection(v1Doc, v1File, { ...v1Doc.rig.model, sha256: '0'.repeat(64) })).toThrow('DIRECTION_MODEL_MISMATCH');
  expect(() => readDirectionInspection(v1Doc, v1File, { ...v1Doc.rig.model, path: 'other.model.json' })).toThrow('DIRECTION_MODEL_MISMATCH');
});

test('readDirectionInspection accepts rig-create/direction@2 with unchanged inspection subset and retains the scene reference', async () => {
  const v2Bytes = await readFile(v2Path);
  expect(createHash('sha256').update(v2Bytes).digest('hex')).toBe(v2Sha256);
  const v2Doc = JSON.parse(v2Bytes.toString('utf8'));
  expect(v2Doc.schema).toBe('rig-create/direction@2');
  expect(v2Doc.scene).toEqual({
    n: 1,
    path: 'evidence/scene/s1.json',
    sha256: 'dc524f2f4b7bc56c1a93bd71d4d80f99b300f07c8920adcb298d8b4d25a5bc29',
  });
  const v2File = { path: 'evidence/direction/v2.json', sha256: v2Sha256 };
  const v2Inspected = readDirectionInspection(v2Doc, v2File, v2Doc.rig.model);
  expect(v2Inspected).toEqual({
    file: v2File,
    model: v2Doc.rig.model,
    scene: v2Doc.scene,
    rigVersion: 1,
    camera: v2Doc.camera,
    take: v2Doc.take,
    timing: v2Doc.timing.keys,
  });
  expect(v2Inspected.scene).toEqual(v2Doc.scene);
  expect(() => readDirectionInspection(v2Doc, v2File, null)).toThrow('DIRECTION_MODEL_MISMATCH');
  expect(() => readDirectionInspection(v2Doc, v2File, { ...v2Doc.rig.model, sha256: '0'.repeat(64) })).toThrow('DIRECTION_MODEL_MISMATCH');
  expect(() => readDirectionInspection(v2Doc, v2File, { ...v2Doc.rig.model, path: 'other.model.json' })).toThrow('DIRECTION_MODEL_MISMATCH');
});
