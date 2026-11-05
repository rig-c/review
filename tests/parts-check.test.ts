import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkFlags } from '../src/parts-view.ts';
import { flagLabel } from '../web/parts-flags.ts';
import { t } from '../web/i18n.ts';

const names = new Set(['front', 'back_defect', 'back_control']);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parts-check-380.json', import.meta.url), 'utf8'));

test('#380 public typed-shape fixture retains unavailable support, pair and part rows without classification', () => {
  const before = JSON.stringify(fixture), flags = checkFlags(fixture, names);
  expect(flags).toHaveLength(11);
  expect(flags.filter(f => f.item === 'front').map(f => f.id)).toEqual([
    'check:PART_SUPPORT_REPORT.pairs[0]', 'check:PART_SUPPORT_REPORT.pairs[1]', 'check:PART_SUPPORT_REPORT.raw_pairs[0]',
    'check:SEAM_OVER_MOTION.pairs[0]', 'check:SEAM_OVER_MOTION.pairs[1]',
  ]);
  const unavailable = flags.find(f => f.id === 'check:PART_SUPPORT_REPORT.pairs[0]' && f.item === 'back_defect');
  expect(unavailable).toMatchObject({ status: 'WARN', entry: fixture.PART_SUPPORT_REPORT.pairs[0] });
  if (unavailable?.kind !== 'check') throw new Error('missing public unavailable row');
  expect(unavailable.entry).toBe(fixture.PART_SUPPORT_REPORT.pairs[0]);
  expect(flags.find(f => f.id === 'check:LIMB_ONE_BONE.parts[0]')).toMatchObject({ item: 'back_defect', status: 'FAIL', entry: fixture.LIMB_ONE_BONE.parts[0] });
  expect(JSON.stringify(fixture)).toBe(before);
});

test('#380 concrete pair headlines name root, path and both identities, in English and Korean', () => {
  const flags = checkFlags(fixture, names).filter(f => f.item === 'front');
  for (const lang of ['en', 'ko'] as const) {
    const translate = (key: string, params?: Readonly<Record<string, string | number>>) => t(key, params, lang);
    const labels = flags.map(f => flagLabel(f, translate));
    expect(new Set(labels).size).toBe(5);
    expect(labels[0]).toContain('PART_SUPPORT_REPORT · PART_SUPPORT_REPORT.pairs[0]');
    expect(labels[0]).toContain('back: "back_defect"');
    expect(labels[0]).toContain('status: "unavailable"');
    expect(labels[1]).toContain('back: "back_control"');
    expect(labels[3]).toContain('SEAM_OVER_MOTION · SEAM_OVER_MOTION.pairs[0]');
    expect(labels[3]).toContain('pair: "front|back_defect"');
    expect(labels[4]).toContain('SEAM_OVER_MOTION.pairs[1]');
    expect(labels[4]).toContain('pair: "front|back_control"');
  }
});

test('#380 unknown roots and fields survive; identical sparse rows still have exact producer paths', () => {
  // A data negative against code-name special casing: neither name exists in the producer-code catalogue.
  const doc = { UNFAMILIAR: { status: 'WARN', rows: [{ part: 'front', witness: 'one' }, { part: 'front', witness: 'two' }, { part: 'front' }, { part: 'front' }] } };
  const flags = checkFlags(doc, names);
  expect(flags).toHaveLength(4);
  const labels = flags.map(f => flagLabel(f, t));
  expect(new Set(labels).size).toBe(4);
  expect(labels[0]).toContain('UNFAMILIAR · UNFAMILIAR.rows[0]');
  expect(labels[0]).toContain('witness: "one"');
  expect(labels[1]).toContain('witness: "two"');
  expect(labels[2]).toContain('UNFAMILIAR.rows[2]');
  expect(labels[3]).toContain('UNFAMILIAR.rows[3]');
});
