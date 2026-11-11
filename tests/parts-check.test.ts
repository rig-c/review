import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkFlags } from '../src/parts-view.ts';
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
