/** Review #1154. Run with `bun tests/direction-stage-minimum-browser.ts`. */
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseStageComment} from '../src/stage-comment.ts';
import {jobSourceDraftId} from '../web/job-session.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const metrics = {width: 1024, height: 768, deviceScaleFactor: 2, mobile: false};
const minimumHeight = 180;
const summary = 'Direction stage point';
type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Point = {x: number; y: number};
type StageReadback = {
  window: {width: number; height: number; dpr: number};
  directionOpen: boolean;
  commentsOpen: boolean;
  captureEnabled: boolean;
  height: number;
  point: Point;
  hit: {id: string; tag: string} | null;
};
type PointerReadback = {trusted: boolean; targetId: string | null};
type DraftReadback = {
  publicationId: string;
  sourceHash: string;
  comments: {id: string; summary: string; context?: {comment?: unknown}}[];
};

async function waitFor(page: InputCdpSession, expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(expression)) return;
    await Bun.sleep(25);
  }
  const notice = await page.evaluate<string>(`document.querySelector('#review-message')?.textContent ?? ''`);
  throw new Error(`DIRECTION_STAGE_WAIT ${label}: ${notice}`);
}

// Serialized into Chromium. getBoundingClientRect reports CSS pixels even at DPR 2.
async function readStage(): Promise<StageReadback> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const viewport = document.getElementById('rig-viewport')!;
  const {left, top, width, height} = viewport.getBoundingClientRect();
  const point = {x: left + width / 2, y: top + height / 2};
  const hit = document.elementFromPoint(point.x, point.y);
  const direction = document.querySelector<HTMLDetailsElement>('#direction-panel')!;
  const comments = document.querySelector('#inspector-feedback #stage-comment-list');
  return {
    window: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
    directionOpen: direction.open && direction.checkVisibility(),
    commentsOpen: comments?.checkVisibility() === true && comments.getBoundingClientRect().height > 0,
    captureEnabled: viewport.classList.contains('stage-comment-mode'),
    height, point, hit: hit ? {id: hit.id, tag: hit.tagName} : null,
  };
}

const scratch = await mkdtemp(join(tmpdir(), 'review-1154-'));
let fixture: Awaited<ReturnType<typeof scriptedJobWindowFixture>> | undefined;
let browser: InputCdpSession | undefined;
try {
  fixture = await scriptedJobWindowFixture({scratchParent: scratch});
  const publication = await fixture.publish('direction');
  await fixture.ask(publication, {kind: 'review-verdict', stage: 'direction-review'});
  const url = new URL(fixture.host.ownerUrl);
  url.searchParams.set('lang', 'en');

  const cdp: {send?: Send} = {};
  const page = browser = await launchCdpSession(join(scratch, 'profile'), {
    sendDeadlineMs: 10_000,
    onEvent(event, send) {
      if (event.sessionId) cdp.send = send;
    },
  });
  assert.ok(cdp.send, 'CDP attached to the page');
  await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
  await page.goto(url.href, 'en');
  await waitFor(page, `document.body.dataset.ready === 'true' && !document.body.inert &&
    !!document.querySelector('#direction-panel:not([hidden])') &&
    !!document.querySelector('#save:not(:disabled)') && !!document.querySelector('#rig-root canvas')`, 'live Direction verdict');

  const initial = await page.evaluate<StageReadback>(`(${readStage})()`);
  assert.equal(initial.directionOpen, false, 'Direction starts collapsed');
  await click(page, '#direction-panel > summary');
  await click(page, '#stage-comment');
  const stage = await page.evaluate<StageReadback>(`(${readStage})()`);
  console.log('DIRECTION_STAGE_MINIMUM', JSON.stringify({initial, expandedWithComments: stage}));
  assert.deepEqual(stage.window, {width: metrics.width, height: metrics.height, dpr: metrics.deviceScaleFactor});
  assert.ok(stage.directionOpen && stage.commentsOpen && stage.captureEnabled, 'Direction and Comments are open with rig pin capture active');
  assert.ok(stage.height >= minimumHeight,
    `DIRECTION_STAGE_MINIMUM: expected #rig-viewport >= ${minimumHeight} CSS px, got ${stage.height}`);
  assert.equal(stage.hit?.id, 'rig-viewport', 'the stage center hit-tests to #rig-viewport');

  await page.evaluate<void>(`document.addEventListener('pointerdown', event => {
    window.review1154Pointer = {trusted: event.isTrusted, targetId: event.target?.id ?? null};
  }, {capture: true, once: true})`);
  const {x, y} = stage.point;
  await page.mouse('mouseMoved', x, y);
  await page.mouse('mousePressed', x, y);
  await page.mouse('mouseReleased', x, y);
  const pointer = await page.evaluate<PointerReadback | undefined>('window.review1154Pointer');
  assert.deepEqual(pointer, {trusted: true, targetId: 'rig-viewport'});

  const composer = '#rig-viewport .stage-comment-composer';
  await waitFor(page, `!!document.querySelector('${composer} input:not(:disabled)')`, 'pin composer');
  await page.evaluate<void>(`(() => {
    const form = document.querySelector('${composer}');
    form.querySelector('input').value = ${JSON.stringify(summary)};
    form.requestSubmit();
  })()`);
  await waitFor(page, `!document.querySelector('${composer}') &&
    document.querySelector('#rig-viewport .stage-comment-pin')?.title === ${JSON.stringify(summary)}`, 'saved rig pin');

  const {source} = publication;
  const key = `rig-review-record-comments/1:${fixture.host.session.jobId}:${jobSourceDraftId(source)}:${source.sourceHash}`;
  const draft = await page.evaluate<DraftReadback | null>(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
  assert.ok(draft, 'the Direction comment draft was saved');
  assert.equal(draft.publicationId, publication.publicationId);
  assert.equal(draft.sourceHash, source.sourceHash);
  assert.deepEqual(draft.comments.map(row => row.summary), [summary]);
  const saved = draft.comments[0]!;
  const mark = parseStageComment(saved.context?.comment);
  assert.equal(mark.viewport, 'rig', 'the saved mark anchors to the rig');
  assert.deepEqual({width: mark.screen.width, height: mark.screen.height}, {width: 0, height: 0});
  console.log('DIRECTION_STAGE_PIN', JSON.stringify({pointer, id: saved.id, viewport: mark.viewport, screen: mark.screen}));
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await fixture?.close();
    } finally {
      await rm(scratch, {recursive: true, force: true});
    }
  }
}
