import {expect, test} from 'bun:test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {JOB_PREVIOUS_DRAFT_SCHEMA} from '../src/job-contract.ts';
import {preparePartsComment, validateStoredPartsComment} from '../src/parts-comment-crops.ts';
import {differencePixels, parsePartsComparison} from '../src/parts-comparison.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {candidate, commentFixture} from './helpers/parts-comments-package.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const grid = {x:0, y:0, w:3, h:2};
const raster = (data: number[]) => ({width:grid.w, height:grid.h, data:Uint8Array.from(data)});
const current = raster([
  11, 22, 33, 0,     44, 55, 66, 98,    70, 80, 90, 4,
  90, 80, 70, 0,     43, 32, 21, 1,     10, 20, 30, 255,
]);
const previous = raster([
  11, 22, 33, 50,    44, 55, 66, 0,     70, 80, 90, 1,
  255, 0, 0, 0,      43, 39, 21, 1,     10, 20, 30, 255,
]);

test('#914 compares whole native cells across removed coverage, added coverage, alpha and straight RGB', () => {
  expect(differencePixels(current, grid, previous, [], 0, false, 'previous-draft')).toEqual(raster([
    50, 0, 0, 255,   98, 0, 0, 255,    3, 0, 0, 255,
    0, 0, 0, 0,     7, 0, 0, 255,     0, 0, 0, 255,
  ]));
  expect(differencePixels(current, grid, previous, [], 7, false, 'previous-draft')).toEqual(raster([
    50, 0, 0, 255,   98, 0, 0, 255,    0, 0, 0, 255,
    0, 0, 0, 0,     0, 0, 0, 255,     0, 0, 0, 255,
  ]));
});

test('#914 rejects offset grids, mismatched PNG extents and invalid thresholds', () => {
  expect(() => differencePixels(current, {...grid, x:1}, previous, [], 0, false, 'previous-draft'))
    .toThrow('PARTS_DIFFERENCE_ALIGNMENT');
  expect(() => differencePixels(current, grid, {...previous, width:2}, [], 0, false, 'previous-draft'))
    .toThrow('PARTS_DIFFERENCE_ALIGNMENT');
  expect(() => differencePixels(current, grid, previous, [], 256, false, 'previous-draft'))
    .toThrow('PARTS_COMPARISON_INVALID');
});

test('#914 preserves the legacy painting raster bytes and counts at the same threshold', () => {
  expect(differencePixels(current, grid, previous, [], 0, false)).toEqual({
    ...raster([
      0, 0, 0, 0,     0, 0, 0, 255,     0, 0, 0, 255,
      0, 0, 0, 0,     7, 0, 0, 255,     0, 0, 0, 255,
    ]),
    count:1, covered:0, compared:4,
  });
});

test('#914 accepts only the signed operand on Difference comparison settings', () => {
  const legacy = {mode:'difference', opacity:.5, threshold:7} as const;
  const signed = {...legacy, operand:'previous-draft'} as const;
  expect(parsePartsComparison(legacy)).toBe(legacy);
  expect(parsePartsComparison(signed)).toBe(signed);
  for (const bad of [
    {...legacy, operand:'painting'},
    {...legacy, operand:undefined},
    {...signed, extra:true},
    {mode:'part', opacity:.5, operand:'previous-draft'},
    {mode:'overlay', opacity:.5, operand:'previous-draft'},
  ]) expect(() => parsePartsComparison(bad)).toThrow('PARTS_COMPARISON_INVALID');
});

test('#914 keeps the pinned crop for an admitted assembled comparison without painting', async () => {
  const root = join(process.env.RIG_REVIEW_STATE_DIR!, 'parts');
  await mkdir(root);
  const pkg = await commentFixture(root);
  expect(pkg.paintingInRig).toBeUndefined();
  const item = candidate(pkg);
  const sourceHash = 'a'.repeat(64);
  const view = {...item.view, footprints:false,
    comparison:{mode:'difference', opacity:.5, threshold:7, operand:'previous-draft'}} as const;
  const assembled: PartsIssue = {...item, sourceHash, imageRegion:null,
    rigRegion:{x:2,y:11,width:8,height:9}, view:{...view, mode:'assembled'}};
  const binding = {sourceHash, previousDraft:{
    schema:JOB_PREVIOUS_DRAFT_SCHEMA, draft:{id:'previous', revision:'b'.repeat(64)},
    composites:{
      current:{path:'current.png', sha256:'c'.repeat(64)},
      previous:{path:'previous.png', sha256:'d'.repeat(64)},
    },
  }} as const;
  const saved = await preparePartsComment(pkg, assembled, false, binding);
  expect(saved.crop).toEqual(item.crop);
  expect(saved.nativeCrop).toBeNull();
  expect(await validateStoredPartsComment(pkg, saved, false, binding)).toEqual(saved);
  await expect(preparePartsComment(pkg, assembled, false, {sourceHash}))
    .rejects.toThrow('PARTS_DIFFERENCE_UNAVAILABLE');
  await expect(preparePartsComment(pkg, {...item, sourceHash, view}, false, binding))
    .rejects.toThrow('PARTS_COMPARISON_INVALID');
  await expect(preparePartsComment(pkg, {...assembled, view:{...assembled.view, footprints:true}}, false, binding))
    .rejects.toThrow('PARTS_COMPARISON_INVALID');
});
