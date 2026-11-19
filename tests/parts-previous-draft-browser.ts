/** #914 owner flow on ordinary Nova with original public synthetic inputs. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {JOB_COMMENTS_ACT_SCHEMA} from '../src/job-contract.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {
  partsDifferenceJobFixture, partsDifferenceOwnerUrl, previousDraftRasterProbes, previousDraftRasterSize,
} from './helpers/parts-difference-job-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

type Language = 'en' | 'ko';
type Fixture = Awaited<ReturnType<typeof partsDifferenceJobFixture>>;
type Case = 'both' | 'painting-only' | 'previous-only';
type OperandControl = {
  value: string;
  visible: boolean;
  disabled: boolean;
  accessibleLabels: string[];
  title: string;
  parentIsOperandRow: boolean;
  sameRowAsOperandControls: boolean;
  options: {value: string; label: string; title: string; disabled: boolean}[];
};
type DifferenceReadback = {
  path: string; operand: string | null; threshold: string | null; footprints: string | null;
  status: number; contentType: string | null; figures: (string | null)[]; bytes: number[];
};
type CommentReadback = {status: number; comment?: PartsIssue; error?: unknown};
type RasterReadback = {width: number; height: number; samples: number[][]};
type Point = {x: number; y: number};

const operandSelector = '.workspace-secondary-toolbar select#parts-difference-operand';
const readingPoints = previousDraftRasterProbes.map(({x, y}) => [x, y]);
const outIndex = Bun.argv.indexOf('--out');
if (outIndex >= 0 && !Bun.argv[outIndex + 1]) throw new Error('--out requires a directory');
const output = resolve(outIndex < 0 ? 'artifacts/parts-previous-draft-914' : Bun.argv[outIndex + 1]!);
await mkdir(output, {recursive: true});
const work = await mkdtemp(join(tmpdir(), 'parts-previous-draft-914-'));
const report: Record<string, unknown> = {};
let browser: InputCdpSession | undefined;

async function wait(page: InputCdpSession, expression: string, label: string) {
  const deadline = Date.now() + 15_000;
  do {
    if (await page.evaluate<boolean>(expression)) return;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(label + ': ' + await page.evaluate<string>('document.body.innerText'));
}

async function settled(page: InputCdpSession) {
  await wait(page, `document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0
    &&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`, 'parts paint');
  await page.evaluate<void>('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
}

async function differenceView(page: InputCdpSession) {
  if (!await page.evaluate<boolean>(`document.querySelector('#view-menu').open`)) await click(page, '#view-menu summary');
  await click(page, '[data-view="difference"]');
  await settled(page);
  assert.ok(await page.evaluate<boolean>(`document.querySelector('[data-view="difference"]').getAttribute('aria-pressed')==='true'`));
}

function operandControl(page: InputCdpSession) {
  return page.evaluate<OperandControl | null>(`(() => {
    const node = document.querySelector(${JSON.stringify(operandSelector)});
    if (!node) return null;
    const labels = [...node.labels];
    const row = document.querySelector('.workspace-secondary-toolbar');
    const controlLabel = node.parentElement;
    const overlayLabel = document.getElementById('parts-overlay')?.parentElement;
    const opacityLabel = document.getElementById('parts-opacity')?.parentElement;
    const rect = controlLabel?.getBoundingClientRect();
    const peerRects = [overlayLabel, opacityLabel].map(peer => peer?.getBoundingClientRect()).filter(Boolean);
    return {value:node.value, visible:node.checkVisibility(), disabled:node.disabled,
      accessibleLabels:labels.map(label=>{
        const copy=label.cloneNode(true);
        copy.querySelector('select')?.remove();
        return copy.textContent.trim();
      }),
      title:node.title,
      parentIsOperandRow:!!row && controlLabel?.parentElement === row
        && overlayLabel?.parentElement === row && opacityLabel?.parentElement === row,
      sameRowAsOperandControls:!!rect && peerRects.length === 2
        && peerRects.every(peer => Math.abs((peer.top + peer.height / 2) - (rect.top + rect.height / 2)) <= 4),
      options:[...node.options].map(option=>({value:option.value,label:option.label,title:option.title,disabled:option.disabled}))};
  })()`);
}

function thresholdControls(page: InputCdpSession) {
  return page.evaluate<number>(`[...document.querySelectorAll('input,select')].filter(node=>
    node.checkVisibility() && (/threshold/i.test(node.id) ||
      [node.getAttribute('aria-label'), ...[...node.labels??[]].map(label=>label.textContent)]
        .some(label=>/^(Threshold|임계값)$/i.test(label?.trim()??'')))).length`);
}

function assertPaintingReads(reads: DifferenceReadback[]) {
  assert.ok(reads.length > 0, 'painting Difference must request a raster');
  for (const read of reads) {
    assert.equal(read.status, 200);
    assert.equal(read.operand, null);
    assert.equal(read.threshold, '0');
  }
}

function assertPreviousIdentity(control: OperandControl, fixture: Fixture, lang: Language) {
  assert.equal(control.parentIsOperandRow, true, 'operand control must sit directly in the existing operand row');
  assert.equal(control.sameRowAsOperandControls, true, 'operand control must share the operand row with Overlay and opacity');
  assert.deepEqual(control.accessibleLabels, [lang === 'ko' ? '비교 대상' : 'Compare with']);
  const choice = control.options.find(option => option.value === 'previous-draft');
  assert.ok(choice && !choice.disabled, 'the previous draft option is available');
  const draft = fixture.previousDraft?.draft;
  assert.ok(draft);
  const previous = lang === 'ko' ? '이전 승인 초안' : 'Previous accepted draft';
  assert.equal(choice.label, `${previous} · ${draft.id}`);
  assert.equal(choice.label.includes(draft.revision.slice(0, 12)), false, 'option label must not carry the hash prefix');
  assert.equal(choice.title, `${draft.id} · ${draft.revision}`);
  assert.equal(control.title, `${draft.id} · ${draft.revision}`);
  assert.equal(control.title.includes(draft.revision.slice(0, 12)), true, 'tooltip must carry the hash prefix');
}

async function selectPrevious(page: InputCdpSession) {
  await page.evaluate<void>(`(() => {
    const node = document.querySelector(${JSON.stringify(operandSelector)});
    node.value = 'previous-draft';
    node.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
}

async function installReadbacks(page: InputCdpSession) {
  // Observe the real response to the UI fetch without replacing its URL or bytes.
  await page.evaluate<void>(`(() => {
    const nativeFetch = window.fetch.bind(window);
    const reads = window.__previousDraft914 = {differences:[], comments:[]};
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (/\\/stage-parts\\/difference\\/\\d+$/.test(url.pathname)) {
        reads.differences.push({path:url.pathname,operand:url.searchParams.get('operand'),
          threshold:url.searchParams.get('threshold'),footprints:url.searchParams.get('footprints'),
          status:response.status,contentType:response.headers.get('content-type'),
          figures:['Count','Covered','Compared'].map(key=>response.headers.get('X-Difference-'+key)),
          bytes:[...new Uint8Array(await response.clone().arrayBuffer())]});
      } else if (url.pathname.endsWith('/stage-parts/comment')) {
        reads.comments.push({status:response.status,...await response.clone().json()});
      }
      return response;
    };
  })()`);
}

function differenceReads(page: InputCdpSession) {
  return page.evaluate<DifferenceReadback[]>('window.__previousDraft914.differences');
}

async function assertPreviousRaster(page: InputCdpSession, reads: DifferenceReadback[], key: string) {
  const response = reads.at(-1);
  assert.ok(response, 'Previous accepted draft must request a raster');
  const {bytes, ...wire} = response;
  report[key + '-wire'] = wire;
  assert.match(wire.path, /\/stage-parts\/difference\/0$/);
  assert.equal(wire.operand, 'previous-draft');
  assert.equal(wire.threshold, '0');
  assert.equal(wire.footprints, 'false');
  assert.equal(wire.status, 200);
  assert.equal(wire.contentType, 'image/png');
  assert.deepEqual(wire.figures, [null, null, null]);

  const decoded = PNG.sync.read(Buffer.from(bytes));
  const native: RasterReadback = {
    width: decoded.width, height: decoded.height,
    samples: previousDraftRasterProbes.map(({x, y}) => {
      const offset = (y * decoded.width + x) * 4;
      return [...decoded.data.subarray(offset, offset + 4)];
    }),
  };
  const drawn = await page.evaluate<RasterReadback>(`(() => {
    const canvas = document.getElementById('parts-canvas');
    const ctx = canvas.getContext('2d');
    return {width:canvas.width,height:canvas.height,
      samples:${JSON.stringify(readingPoints)}.map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};
  })()`);
  report[key + '-raster'] = {probes: previousDraftRasterProbes, native, drawn};
  const expected = {...previousDraftRasterSize, samples: previousDraftRasterProbes.map(({rgba}) => [...rgba])};
  assert.deepEqual(native, expected, 'sealed composites must produce the expected native RGBA');
  assert.deepEqual(drawn, expected, 'assembled canvas must paint those native cells');
}

function assertComment(issue: PartsIssue, fixture: Fixture, words: string) {
  assert.equal(issue.summary, words);
  assert.equal(issue.sourceHash, fixture.publication.source.sourceHash);
  assert.deepEqual(issue.parts.map(part => part.name), ['body']);
  assert.equal(issue.view.mode, 'assembled');
  assert.equal(issue.imageRegion, null);
  assert.ok(issue.rigRegion.width > 0 && issue.rigRegion.height > 0);
  assert.match(issue.crop.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(issue.view.comparison, {mode: 'difference', opacity: 0.5, threshold: 0, operand: 'previous-draft'});
}

async function pinComment(page: InputCdpSession, fixture: Fixture, lang: Language) {
  await click(page, '#stage-comment');
  await wait(page, `document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`, 'point mode');
  const [from, to] = await page.evaluate<[Point, Point]>(`(() => {
    const canvas = document.getElementById('parts-canvas');
    const rect = canvas.getBoundingClientRect();
    return [[8.25,5.25],[12.75,8.75]].map(([x,y])=>({
      x:rect.left+x*rect.width/canvas.width, y:rect.top+y*rect.height/canvas.height,
    }));
  })()`);
  await page.mouse('mouseMoved', from.x, from.y);
  await page.mouse('mousePressed', from.x, from.y);
  await page.mouse('mouseMoved', to.x, to.y);
  await page.mouse('mouseReleased', to.x, to.y);
  await wait(page, `!!document.querySelector('.stage-comment-composer input')`, 'pointed comment composer');
  const words = lang === 'ko' ? '이전 초안 어깨 차이' : 'Previous draft shoulder change';
  await page.evaluate<void>(`(() => {
    const form = document.querySelector('.stage-comment-composer');
    form.querySelector('input').value = ${JSON.stringify(words)};
    form.requestSubmit();
  })()`);
  await wait(page, `!document.querySelector('.stage-comment-composer')&&window.__previousDraft914.comments.length===1`, 'pointed comment accepted');
  const [read] = await page.evaluate<CommentReadback[]>('window.__previousDraft914.comments');
  assert.equal(read?.status, 200, JSON.stringify(read?.error));
  const pinned = read?.comment;
  assert.ok(pinned, 'server returns the bound pointed comment');
  assertComment(pinned, fixture, words);
  assert.ok(await page.evaluate<boolean>(`[...document.querySelectorAll('.stage-comment-summary')].some(node=>node.textContent.includes(${JSON.stringify(words)}))`));
  return pinned;
}

async function finalize(page: InputCdpSession, fixture: Fixture, pinned: PartsIssue, askId: string, key: string) {
  await wait(page, `document.querySelector('#request-changes')?.checkVisibility()&&!document.querySelector('#request-changes').disabled`, 'parts verdict ready');
  await click(page, '#request-changes');
  const deadline = Date.now() + 15_000;
  do {
    const event = (await fixture.next()).events.find(e => e.type === 'act' && e.act.askId === askId);
    if (event?.type === 'act') {
      const act = event.act;
      assert.equal(act.schema, JOB_COMMENTS_ACT_SCHEMA);
      assert.equal(act.kind, 'parts-verdict');
      assert.equal(act.value.verdict, 'changes-requested');
      assert.equal(act.publicationId, fixture.publication.publicationId);
      assert.equal(act.source.sourceHash, fixture.publication.source.sourceHash);
      assert.deepEqual('previousDraft' in act.source ? act.source.previousDraft : undefined, fixture.previousDraft);
      assert.equal(act.value.comments.length, 1);
      const comment = act.value.comments[0]!;
      const {summary, ...anchor} = pinned;
      assert.deepEqual(comment, {text: summary, anchor}, 'finalized consumer act preserves the pointed comment');
      report[key + '-act'] = {schema: act.schema, kind: act.kind, verdict: act.value.verdict,
        sourceHash: act.source.sourceHash, previousDraft: fixture.previousDraft, commentId: pinned.id,
        comparison: pinned.view.comparison, cropSha256: pinned.crop.sha256};
      return;
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error('No finalized parts-verdict act: ' + await page.evaluate<string>('document.body.innerText'));
}

async function runCase(page: InputCdpSession, lang: Language, variant: Case) {
  const key = lang + '-' + variant;
  const fixture = await partsDifferenceJobFixture({
    previousDraft: variant !== 'painting-only', declared: variant !== 'previous-only', scratchParent: work,
  });
  const shot = async (suffix: string) => writeFile(join(output, key + '-' + suffix + '.png'), await page.screenshot());
  try {
    const ask = await fixture.ask(fixture.publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    await page.goto(partsDifferenceOwnerUrl(fixture, lang));
    await settled(page);
    assert.equal(await page.evaluate<string>('document.documentElement.lang'), lang);
    assert.equal((await operandControl(page))?.visible ?? false, false, 'operand is hidden outside Difference');
    await installReadbacks(page);
    await differenceView(page);
    const control = await operandControl(page);
    report[key + '-initial-control'] = control;
    const painting = (await differenceReads(page)).filter(read => read.operand === null);

    if (variant === 'painting-only') {
      assert.equal(control?.visible ?? false, false, 'no operand choice without the declaration');
      assertPaintingReads(await differenceReads(page));
      assert.equal('previousDraft' in fixture.publication.source, false);
      await shot('difference');
      return;
    }

    // The same files publish on pre-feature main. It must fail here for the missing UI.
    assert.ok(control?.visible, 'assembled Difference is missing the Previous accepted draft operand control');
    assert.deepEqual('previousDraft' in fixture.publication.source ? fixture.publication.source.previousDraft : undefined, fixture.previousDraft);
    assert.equal(await thresholdControls(page), 0, 'Parts Difference keeps the fixed threshold without an input');

    if (variant === 'both') {
      assert.equal(control.parentIsOperandRow, true, 'operand control must sit directly in the existing operand row');
      assert.equal(control.sameRowAsOperandControls, true, 'operand control must share the operand row with Overlay and opacity');
      assert.equal(control.value, 'painting');
      assert.equal(control.disabled, false);
      assert.equal(control.title, '');
      assertPaintingReads(await differenceReads(page));
      const before = (await differenceReads(page)).length;
      await selectPrevious(page);
      await wait(page, `window.__previousDraft914.differences.length>${before}`, 'previous-draft raster request');
      await settled(page);
      const selected = await operandControl(page);
      assert.ok(selected);
      assert.equal(selected.value, 'previous-draft');
      report[key + '-selected-control'] = selected;
      assertPreviousIdentity(selected, fixture, lang);
      const newReads = (await differenceReads(page)).slice(before);
      assert.equal(newReads.length, 1, 'previous-draft uses one whole-canvas request');
      await assertPreviousRaster(page, newReads, key);
    } else {
      assert.equal(control.value, 'previous-draft', 'assembled Difference falls back when painting_in_rig is absent');
      assertPreviousIdentity(control, fixture, lang);
      assert.equal(control.options.find(option => option.value === 'painting')?.disabled ?? true, true);
      assert.equal(painting.length, 0);
      await assertPreviousRaster(page, await differenceReads(page), key);
    }

    await shot('previous');
    if (variant === 'both') {
      const pinned = await pinComment(page, fixture, lang);
      report[key + '-pinned'] = {id: pinned.id, region: pinned.rigRegion, comparison: pinned.view.comparison, cropSha256: pinned.crop.sha256};
      await shot('pinned');
      await click(page, '[data-part-list] button[data-slot="body"]');
      await settled(page);
      const before = (await differenceReads(page)).length;
      await click(page, '[data-part-solo]');
      await settled(page);
      assert.ok(await page.evaluate<boolean>(`document.querySelector('[data-part-solo]').checked`));
      assert.equal((await operandControl(page))?.visible ?? false, false, 'solo Difference must hide the operand control');
      const soloReads = (await differenceReads(page)).slice(before);
      assertPaintingReads(soloReads);
      await shot('solo');
      await finalize(page, fixture, pinned, ask.askId, key);
    }
  } catch (error) {
    try {await shot('failure');} catch (captureError) {report[key + '-capture-error'] = String(captureError);}
    throw error;
  } finally {
    await fixture.close();
  }
}

try {
  browser = await launchCdpSession(join(work, 'profile'));
  await browser.setViewport(1600, 1000);
  for (const lang of ['en', 'ko'] as const) {
    for (const variant of ['both', 'painting-only', 'previous-only'] as const) await runCase(browser, lang, variant);
  }
  report.result = 'PASS';
  console.log('PARTS_PREVIOUS_DRAFT_914_PASS languages=2 variants=3 rasterProbes=6 finalizedActs=2');
} catch (error) {
  report.result = 'FAIL';
  report.error = String(error);
  throw error;
} finally {
  try {await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
  finally {
    try {await browser?.close();}
    finally {await rm(work, {recursive: true, force: true});}
  }
}
