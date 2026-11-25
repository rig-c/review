/** #1004 / #1101 / #1230 browser check: multi-set option-set record publications on the real job page.
 * Multi-set form submission and local form-pick draft cases were removed (#1230 removes the answer form).
 * Kept cases verify that several option images show through the view switcher and take pointed and general comments
 * submitted as rig-review/act@10, and that a multi-set publication bound to an accepted rig renders the rig and takes comments. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {optionSetsJobFixture} from './helpers/job-record-screen-fixture.ts';
import {SYNTHETIC_RIG_RGB} from './helpers/job-record-fixture.ts';
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {JOB_COMMENT_ONLY_ACT_SCHEMA} from '../src/job-contract.ts';
import {parseCommentOnlyAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
const output = resolve(arg('--out') ?? 'artifacts/job-option-sets-1004');
await mkdir(output, {recursive: true});
const rigOnly = Bun.argv.includes('--rig-only');
const noAskHeadline = "We're looking at the work together. Leave your thoughts as comments.";
const profile = await mkdtemp(join(tmpdir(), 'review-1004-browser-'));
const exceptions: unknown[] = [];
const consoleErrors: unknown[] = [];
const cases: unknown[] = [];
let page: InputCdpSession | undefined;

async function wait(expression: string, label: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await page!.evaluate<boolean>(expression)) return;
    await Bun.sleep(30);
  }
  throw new Error('1004_BROWSER_TIMEOUT ' + label);
}

async function addGeneralComment(text: string) {
  await click(page!, '[data-comment-general]');
  await wait(`!!document.querySelector('.stage-comment-composer input')`, 'general composer open');
  await page!.evaluate(`(() => {
    const f = document.querySelector('.stage-comment-composer');
    f.querySelector('input').value = ${JSON.stringify(text)};
    f.requestSubmit();
  })()`);
  await wait(`!document.querySelector('.stage-comment-composer')`, 'general composer saved');
}

async function multiSetImagesCase(language: 'en' | 'ko') {
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  const fixture = await optionSetsJobFixture({count: 4, distinctImages: true, subjectless: true});
  const out = join(output, 'multi-images', language);
  await mkdir(out, {recursive: true});
  const expectedRgba = [
    [40, 160, 220, 255],
    [220, 110, 40, 255],
    [60, 190, 90, 255],
    [190, 70, 190, 255],
  ];
  try {
    assert.equal(fixture.session.status().pending.length, 0);
    const url = new URL(fixture.ownerUrl);
    url.searchParams.set('lang', language);
    await page!.setViewport(1440, 900);
    await page!.goto('about:blank');
    await page!.goto(url.href, language);
    await wait(
      `document.documentElement.lang===${JSON.stringify(language)} &&
       document.body.dataset.ready==='true' &&
       document.querySelectorAll('#view-menu [data-view^="interview-image-"]').length===4 &&
       document.querySelector('#reference-content img')?.naturalWidth===64 &&
       !!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])') &&
       !document.getElementById('send-comments')?.hidden`,
      'four option images ready ' + language,
    );
    const shell = await page!.evaluate<{forms: number; headline: string; modes: string[]}>(`({
      forms: document.querySelectorAll('form[data-job-ask]').length,
      headline: document.getElementById('workspace-ask-headline')?.textContent ?? '',
      modes: [...document.querySelectorAll('#view-menu [data-view^="interview-image-"]')].map(b => b.dataset.view),
    })`);
    assert.equal(shell.forms, 0);
    assert.equal(shell.headline, catalog[noAskHeadline]);
    assert.deepEqual(shell.modes, ['interview-image-0', 'interview-image-1', 'interview-image-2', 'interview-image-3']);

    const readDrawnRgba = () => page!.evaluate<number[]>(`(() => {
      const img = document.querySelector('#reference-content img');
      if (!img?.complete || img.naturalWidth !== 64) return [];
      const c = document.createElement('canvas'); c.width = c.height = 2;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    })()`);
    const shownPixels: number[][] = [];
    for (let index = 0; index < 4; index++) {
      await click(page!, '#view-menu summary');
      await click(page!, `#view-menu [data-view="interview-image-${index}"]`);
      const targetR = expectedRgba[index]![0];
      await wait(
        `document.querySelector('#view-menu [data-view="interview-image-${index}"]')?.getAttribute('aria-pressed')==='true' &&
         (() => { const img = document.querySelector('#reference-content img'); if (!img?.complete || img.naturalWidth !== 64 || img.getBoundingClientRect().width <= 0) return false; const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[0] === ${targetR}; })()`,
        `option image ${index} selected`,
      );
      const rgba = await readDrawnRgba();
      assert.deepEqual(rgba, expectedRgba[index]);
      shownPixels.push(rgba);
    }

    // Select the second option image (inputs/reference-2.png), pin a point comment on it, add a general comment, and submit.
    await click(page!, '#view-menu summary');
    await click(page!, '#view-menu [data-view="interview-image-1"]');
    await wait(
      `document.querySelector('#view-menu [data-view="interview-image-1"]')?.getAttribute('aria-pressed')==='true' &&
       (() => { const img = document.querySelector('#reference-content img'); if (!img?.complete || img.naturalWidth !== 64 || img.getBoundingClientRect().width < 32) return false; const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[0] === 220; })()`,
      'second image active and drawn',
    );
    await page!.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    if (await page!.evaluate<boolean>(`!document.querySelector('#reference-viewport.stage-comment-mode')`)) {
      await click(page!, '#stage-comment');
    }
    await wait(`!!document.querySelector('#reference-viewport.stage-comment-mode')`, 'pin mode on second option image');
    const center = await page!.evaluate<{x: number; y: number}>(`(() => {
      const r = document.querySelector('#reference-content img').getBoundingClientRect();
      return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    })()`);
    await page!.mouse('mouseMoved', center.x, center.y);
    await page!.mouse('mousePressed', center.x, center.y);
    await page!.mouse('mouseReleased', center.x, center.y);
    await wait(`!!document.querySelector('.stage-comment-composer input')`, 'pin composer open');
    const pinText = `Pin on option 2 · ${language}`;
    await page!.evaluate(`(() => {
      const f = document.querySelector('.stage-comment-composer');
      f.querySelector('input').value = ${JSON.stringify(pinText)};
      f.requestSubmit();
    })()`);
    await wait(`!document.querySelector('.stage-comment-composer') && document.querySelectorAll('#stage-comment-list .stage-comment-item').length === 1`, 'pin saved');
    const generalText = `General multi-set comment · ${language}`;
    await addGeneralComment(generalText);
    await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length === 2 && !document.getElementById('send-comments').disabled`, 'both comments ready');
    await writeFile(join(out, 'before-send.png'), await page!.screenshot());

    await page!.evaluate(`document.getElementById('send-comments').click()`);
    await expectRecordActSubmitted(page!, wait, language, 'multi-set comments submitted ' + language);
    await writeFile(join(out, 'after-send.png'), await page!.screenshot());

    const events = await fixture.readEvents();
    const acts = events.events.flatMap(event => event.type === 'act' ? [event.act] : []);
    assert.equal(acts.length, 1);
    const act = parseCommentOnlyAct(acts[0]);
    assert.equal(act.schema, JOB_COMMENT_ONLY_ACT_SCHEMA);
    assert.equal(act.source.sourceHash, fixture.publication.source.sourceHash);
    assert.equal(act.value.comments.length, 2);
    const secondSeal = fixture.workspace.files.find(file => file.path === 'inputs/reference-2.png');
    assert.ok(secondSeal);
    const pinned = act.value.comments[0]!;
    assert.equal(pinned.text, pinText);
    assert.ok(pinned.anchor && 'target' in pinned.anchor);
    const pinComment = (pinned.anchor.context as {comment?: {referenceId?: string; referenceHash?: string}} | undefined)?.comment;
    assert.equal(pinComment?.referenceId, secondSeal.path);
    assert.equal(pinComment?.referenceHash, secondSeal.sha256);
    assert.equal(act.value.comments[1]?.text, generalText);

    const observation = {language, case: 'multi-images', modes: shell.modes, shownPixels, actId: act.actId, secondSeal};
    await writeFile(join(out, 'observations.json'), JSON.stringify(observation, null, 2) + '\n');
    console.log('1004_MULTI_IMAGES_PASS ' + JSON.stringify({language, modes: shell.modes.length, comments: act.value.comments.length}));
    await page!.goto('about:blank');
    return observation;
  } catch (error) {
    const diag = await page!.evaluate(`({draftState:document.getElementById('review-draft-state')?.textContent,reviewMsg:document.getElementById('review-message')?.textContent,reviewTitle:document.getElementById('review-message')?.title,footer:document.getElementById('message')?.textContent,rows:document.querySelectorAll('#stage-comment-list .stage-comment-item').length})`).catch(() => null);
    await writeFile(join(out, 'failure-diag.json'), JSON.stringify({error: String(error), diag}, null, 2) + '\n');
    await writeFile(join(out, 'failure.png'), await page!.screenshot()).catch(() => {});
    throw error;
  } finally {
    await fixture.close();
  }
}

async function groupedRigCase(language: 'en' | 'ko') {
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  const out = join(output, 'owner-look', language);
  await mkdir(out, {recursive: true});
  const fixture = await optionSetsJobFixture({count: 3, boundRig: true, subjectless: true});
  try {
    const url = new URL(fixture.ownerUrl);
    url.searchParams.set('lang', language);
    await page!.setViewport(1440, 900);
    await page!.goto('about:blank');
    await page!.goto(url.href, language);
    const refusal = '[role="status"][title="JOB_DISPLAY_MISMATCH"], #review-message[title="JOB_DISPLAY_MISMATCH"]';
    await wait(
      `!!document.querySelector(${JSON.stringify(refusal)}) || (document.body.dataset.ready==='true' &&
       document.querySelector('#player-state')?.textContent===${JSON.stringify(catalog['@rig-c/play · Actual rig'])} &&
       document.querySelector('#animation-select')?.value==='idle' && document.querySelector('#rig-empty')?.hidden===true &&
       !!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])') &&
       !document.getElementById('send-comments')?.hidden)`,
      'grouped rig ' + language,
    );
    const refusalCode = await page!.evaluate<string | null>(`document.querySelector(${JSON.stringify(refusal)})?.title ?? null`);
    assert.equal(refusalCode, null, `${language} grouped rig preparation refused: ${refusalCode}`);
    assert.equal(await page!.evaluate<number>(`document.querySelectorAll('form[data-job-ask]').length`), 0);

    const stage = await page!.evaluate<{left: number; top: number; right: number; bottom: number}>(`document.getElementById('rig-viewport').getBoundingClientRect().toJSON()`);
    const screen = await page!.screenshot();
    await writeFile(join(out, '01-open-rig.png'), screen);
    const png = PNG.sync.read(Buffer.from(screen));
    const scale = png.width / 1440;
    let paintedPixels = 0;
    for (let y = Math.max(0, Math.ceil(stage.top * scale)); y < Math.min(png.height, Math.floor(stage.bottom * scale)); y++) {
      for (let x = Math.max(0, Math.ceil(stage.left * scale)); x < Math.min(png.width, Math.floor(stage.right * scale)); x++) {
        const pixel = (y * png.width + x) * 4;
        if (SYNTHETIC_RIG_RGB.every((value, channel) => Math.abs(png.data[pixel + channel]! - value) <= 3)) paintedPixels++;
      }
    }
    assert.ok(paintedPixels >= 16, 'bound rig viewport renders the sealed mesh color');

    const commentText = `Grouped rig comment · ${language}`;
    await addGeneralComment(commentText);
    await click(page!, '#send-comments');
    await expectRecordActSubmitted(page!, wait, language, 'grouped rig comment submitted ' + language);
    await writeFile(join(out, '02-sent-rig.png'), await page!.screenshot());

    const {events} = await fixture.readEvents();
    const acts = events.flatMap(event => event.type === 'act' ? [event.act] : []);
    assert.equal(acts.length, 1);
    const act = parseCommentOnlyAct(acts[0]);
    assert.equal(act.schema, JOB_COMMENT_ONLY_ACT_SCHEMA);
    assert.equal(act.source.sourceHash, fixture.publication.source.sourceHash);
    assert.deepEqual(act.value.comments, [{text: commentText}]);

    const observation = {language, case: 'grouped-rig', paintedPixels, actId: act.actId, sets: fixture.workspace.result.sets?.length ?? 1};
    await writeFile(join(out, 'observations.json'), JSON.stringify(observation, null, 2) + '\n');
    console.log('1101_GROUPED_RIG_CASE ' + JSON.stringify(observation));
    return observation;
  } finally {
    await page!.goto('about:blank');
    await fixture.close();
  }
}

try {
  page = await launchCdpSession(profile, {
    sendDeadlineMs: 20_000,
    onEvent(event) {
      if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') consoleErrors.push(event.params);
      if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params);
    },
  });
  if (!rigOnly) {
    for (const language of ['en', 'ko'] as const) {
      cases.push(await multiSetImagesCase(language));
    }
  }
  const rigFailures: string[] = [];
  for (const language of ['en', 'ko'] as const) {
    try {
      cases.push(await groupedRigCase(language));
    } catch (error) {
      rigFailures.push(String(error));
      console.error('1101_GROUPED_RIG_RED ' + language + ' ' + String(error));
    }
  }
  assert.deepEqual(rigFailures, [], 'grouped rig browser scenario failed');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors));
  const result = {cases: cases.length, languages: ['en', 'ko'], exceptions: exceptions.length, consoleErrors: consoleErrors.length};
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('1004_BROWSER_PASS ' + JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({error: String(error), exceptions, consoleErrors, cases}, null, 2) + '\n');
  if (page) await writeFile(join(output, 'failure.png'), await page.screenshot()).catch(() => {});
  throw error;
} finally {
  await page?.close();
  await rm(profile, {recursive: true, force: true});
}
