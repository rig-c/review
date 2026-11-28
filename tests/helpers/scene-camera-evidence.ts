import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';

export type Point = {x: number; y: number};
export type Rect = Point & {width: number; height: number};
export type Stage = Rect;
export type Sample = {
  frame?: number;
  authored_time: number;
  compiled_time: number;
  pan: [number, number];
  zoom: number;
  view: [number, number, number, number];
  backdrop_quad: [number, number][];
  figures: {id: string; bounds: number[] | null}[];
};
type Track = {duration: number; compiled_duration: number; loop: boolean; frames: Sample[]};
type Oracle = {tracks: Record<string, {samples: Record<string, Sample>}>};
type ProducerRow = {
  path: string;
  frame: number;
  authoredSeconds: number;
  compiledSeconds: number;
  zoom: number;
  pan: [number, number];
  view: {minX: number; minY: number; maxX: number; maxY: number; scale: number; width: number; height: number};
  sha256: string;
};

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const model = 'skeleton.model.json';
const page = 'skeleton.png';
const report = 'report.json';
const oracle = 'expected.json';
const expectedHashes = {
  [model]: '04320a757a66b3b5423bdda00851713655b14c1d27170971e883d38dae0eb169',
  [page]: '94682feeb2cab2f945d4eb85a309b2519ba483c63ffeaecb8971a5c9cbe0a843',
  [report]: 'ef38a1f4c5b9df73aa563ec1830982458347f286e578ad5a17df593b30dc33c5',
  [oracle]: 'c5feebc9ee278a3a8d159f6695ce3bbc6d5a60ad90ce0f1fdcce44fc9200489e',
};
const producerPhases = [0, 0.5, 1, 2];

export async function readSceneCameraInputs(fixture: string, producerPngs: string) {
  const paths = [model, page, report, oracle] as const;
  const bytes = await Promise.all(paths.map(path => readFile(join(fixture, path))));
  for (const [i, path] of paths.entries()) assert.equal(sha256(bytes[i]!), expectedHashes[path], path);
  const packed = JSON.parse(bytes[0]!.toString()) as {stage: Stage};
  const camera = JSON.parse(bytes[2]!.toString()).camera as {model_sha256: string; tracks: Record<string, Track>};
  const offGrid = JSON.parse(bytes[3]!.toString()) as Oracle;
  const receipt = JSON.parse(await readFile(join(producerPngs, 'frames.json'), 'utf8')) as {
    producer: string; modelSha256: string; reportSha256: string; rows: ProducerRow[];
  };
  assert.equal(camera.model_sha256, expectedHashes[model]);
  assert.deepEqual([receipt.producer, receipt.modelSha256, receipt.reportSha256],
    ['Parts 2.63.0 / Core 3.11.0', expectedHashes[model], expectedHashes[report]]);
  const frames = await Promise.all(producerPhases.map(async time => {
    const path = `idle-${time}.png`;
    const rows = receipt.rows.filter(row => row.path === path);
    assert.equal(rows.length, 1, path);
    const row = rows[0]!;
    const sample = camera.tracks.idle.frames[time * 12]!;
    const {x, y, width, height} = packed.stage;
    const [left, top, right, bottom] = sample.view;
    assert.deepEqual([row.frame, row.authoredSeconds, row.compiledSeconds, row.pan, row.zoom],
      [sample.frame, sample.authored_time, sample.compiled_time, sample.pan, sample.zoom]);
    const {view} = row;
    const values = [view.minX, view.minY, view.maxX, view.maxY, view.scale, view.width, view.height];
    const expected = [left + x, y + height - bottom, right + x, y + height - top, sample.zoom, width, height];
    values.forEach((value, i) => near(value, expected[i]!, 1e-10, path));
    const png = await readFile(join(producerPngs, path));
    assert.equal(sha256(png), row.sha256, path);
    const pixels = PNG.sync.read(png);
    assert.deepEqual([pixels.width, pixels.height], [width, height], path);
    return {row, sample, png, pixels};
  }));
  return {packed, camera, offGrid, frames, receipt, hashes: expectedHashes};
}

export async function writeSceneCameraPackage(root: string, fixture: string, kind: 'direction' | 'rig' | 'legacy') {
  await mkdir(root);
  await Promise.all([model, page, ...(kind === 'legacy' ? [] : [report])].map(path =>
    copyFile(join(fixture, path), join(root, path))));
  const manifest = {
    schema: 'rig-review/1', id: 'scene-camera-eased', revision: '1', title: 'Eased scene camera',
    model,
    animations: [{id: 'idle', label: 'Idle'}, {id: 'shot', label: 'Shot'}],
    ...(kind === 'legacy' ? {} : {sceneReport: {path: report, sha256: expectedHashes[report]}}),
    ...(kind === 'direction' ? {direction: 'direction.json'} : {}),
  };
  if (kind === 'direction') await writeFile(join(root, 'direction.json'), JSON.stringify({
    schema: 'rig-create/direction@3',
    rig: {version: 1, acceptance: {signoff: {}, verdict: {}, review_package: {}}},
    compose: {out: 'outputs/v1/compose'},
    model: {path: model, sha256: expectedHashes[model]},
    take: {duration: 4, loop: true},
    citations: {camera: 'Public eased example', timing: 'Public eased example', composition: 'Public eased example'},
  }));
  await writeFile(join(root, 'review.json'), JSON.stringify(manifest));
}

export function near(actual: number, expected: number, tolerance: number, label: string) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, saw ${actual}`);
}

/** Read the compositor at the centre of each authored output pixel. */
export function displayPixels(image: PNG, rect: Rect, width: number, height: number, scale = 1): PNG {
  const output = new PNG({width, height});
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.floor((rect.x + (x + 0.5) * rect.width / width) * scale);
    const sy = Math.floor((rect.y + (y + 0.5) * rect.height / height) * scale);
    assert.ok(sx >= 0 && sy >= 0 && sx < image.width && sy < image.height, 'outside compositor capture');
    const offset = (sy * image.width + sx) * 4;
    image.data.copy(output.data, (y * width + x) * 4, offset, offset + 4);
  }
  return output;
}

function delta(a: PNG, aOffset: number, b: PNG, bOffset: number): number {
  return Math.max(...[0, 1, 2, 3].map(channel => Math.abs(a.data[aOffset + channel]! - b.data[bOffset + channel]!)));
}

/** Core and Chromium use different texture filters. Compare flat interiors and retain a full RGB difference image. */
export function compareSceneCameraPixels(actual: PNG, expected: PNG) {
  const {width, height} = expected;
  assert.deepEqual([actual.width, actual.height], [width, height]);
  const difference = new PNG({width, height});
  let stable = 0, matching = 0, totalDelta = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const error = delta(actual, offset, expected, offset);
    totalDelta += error;
    difference.data.fill(error, offset, offset + 3);
    difference.data[offset + 3] = 255;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
    const neighbours = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
    if (neighbours.some(step => delta(expected, offset, expected, offset + step * 4) > 3)) continue;
    stable++;
    if (error <= 12) matching++;
  }
  return {stable, matching, meanMaxChannelDelta: totalDelta / (width * height), difference};
}
