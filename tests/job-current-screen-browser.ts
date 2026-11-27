/** #1267 part B: EN and KO whole-screen pair captures and visible-text diffs for current/parts, current/rig and current/direction. */
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {jobHash} from '../src/job-api.ts';
import type {JobPublication, JobSelector} from '../src/job-contract.ts';
import {jobSourceDraftId} from '../web/job-session.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

type OutputKind = 'parts' | 'rig' | 'direction';
type Language = 'en' | 'ko';
type Side = 'current' | 'numbered';

const at = Bun.argv.indexOf('--out');
const output = resolve(at < 0 ? 'artifacts/current-screen-1267' : Bun.argv[at + 1]!);
await mkdir(output, {recursive: true});
const profile = await mkdtemp(join(tmpdir(), 'review1267-current-'));
const errors: unknown[] = [];
let page: InputCdpSession | undefined;
let command: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function wait(expression: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await page!.evaluate(expression)) return;
    await Bun.sleep(25);
  }
  throw new Error('CURRENT_SCREEN_WAIT ' + expression);
}

async function setupOutputHost(kind: OutputKind, side: Side) {
  const h = await realJobWindowFixture();
  const projectText = '{"schema":"rig-create/project@0","interview":{}}\n';
  await writeFile(join(h.input.root, 'project.json'), projectText);
  h.input.setRecordPath('project.json');
  const record = jobHash(projectText);
  const pkgRoot = join(h.input.root, 'out');
  const manifestPath = join(pkgRoot, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.id = 'create';
  manifest.title = `Create 1267 ${kind}`;
  manifest.revision = record.slice(0, 12);
  const selector: JobSelector = side === 'current'
    ? {kind: 'current', output: kind, record}
    : kind === 'parts' ? {kind: 'draft', id: 'draft-parts-1'}
    : kind === 'rig' ? {kind: 'rig', version: 2}
    : {kind: 'post', version: 3, rigVersion: 2};
  if (kind === 'parts') {
    await writeComparisonPackage(pkgRoot, true);
    await writeFile(join(pkgRoot, 'config.json'), JSON.stringify({key: 'synthetic-1267-parts'}));
    await unlink(join(pkgRoot, 'skeleton.model.json'));
    delete manifest.model;
    manifest.animations = [];
    manifest.checkpoints = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const refs = [{path: 'painting.png', role: 'painting'}, {path: 'parts/body.png', role: 'part'}, {path: 'parts/front.png', role: 'part'}];
    const images = await Promise.all(refs.map(async r => ({...r, sha256: jobHash(await readFile(join(pkgRoot, r.path)))})));
    h.input.setPartsReferences(refs);
    h.input.setContext({
      selector, plan: null, subjects: [], partIds: ['body', 'front'],
      parts: {enumeratorVersion: h.input.partsEnumerator.version, manifest: {path: 'out/parts.json', sha256: jobHash(await readFile(join(pkgRoot, 'parts.json')))}, images},
      files: [{path: 'out/rig.json', sha256: jobHash(await readFile(join(pkgRoot, 'rig.json')))}],
    });
  } else {
    if (kind === 'direction') {
      const createFixtureDir = 'tests/fixtures/create-example-current';
      for (const stale of ['rigid.png', 'report.json']) {
        await unlink(join(pkgRoot, stale)).catch(() => {});
      }
      for (const name of ['skeleton.model.json', 'skeleton.atlas', 'skeleton.png']) {
        await cp(join(createFixtureDir, name), join(pkgRoot, name));
      }
      if (side === 'current') {
        await cp(join(createFixtureDir, 'direction.json'), join(pkgRoot, 'direction.json'));
      } else {
        const modelSha = jobHash(await readFile(join(pkgRoot, 'skeleton.model.json')));
        await writeFile(join(pkgRoot, 'direction.json'), JSON.stringify({
          schema: 'rig-create/direction@3',
          model: {path: 'skeleton.model.json', sha256: modelSha},
          rig: {version: 2, model: {path: 'skeleton.model.json', sha256: modelSha}},
          take: {duration: 4, loop: true},
        }, null, 2) + '\n');
      }
      manifest.model = 'skeleton.model.json';
      manifest.direction = 'direction.json';
      manifest.references = [];
      manifest.authoring = [];
      manifest.animations = [{id: 'idle', label: 'Idle', duration: 4}];
      manifest.checkpoints = [];
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    h.input.setContext({selector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  }
  return {h, record, title: manifest.title as string};
}

function lineDiff(currentText: string, numberedText: string) {
  const a = currentText.split('\n'), b = numberedText.split('\n');
  const max = Math.max(a.length, b.length);
  const diff: {line: number; current: string | null; numbered: string | null}[] = [];
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) diff.push({line: i + 1, current: a[i] ?? null, numbered: b[i] ?? null});
  }
  return diff;
}

try {
  page = await launchCdpSession(profile, {
    sendDeadlineMs: 10_000,
    onEvent(event, send) {
      command = send;
      if (event.method === 'Runtime.exceptionThrown' || event.method === 'Page.javascriptDialogOpening') errors.push(event.params);
    },
  });
  await page.setViewport(1440, 900);
  assert.ok(command);
  await command('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});

  for (const language of ['en', 'ko'] as const) {
    for (const kind of ['parts', 'rig', 'direction'] as const) {
      const currentSetup = await setupOutputHost(kind, 'current');
      const numberedSetup = await setupOutputHost(kind, 'numbered');
      try {
        const currentHashes = await jobInputHashes(join(currentSetup.h.input.root, 'out'));
        const numberedHashes = await jobInputHashes(join(numberedSetup.h.input.root, 'out'));
        if (kind === 'direction') {
          const withoutDirection = (rows: Record<string, string>) =>
            Object.fromEntries(Object.entries(rows).filter(([k]) => k !== 'direction.json'));
          assert.deepEqual(
            withoutDirection(currentHashes),
            withoutDirection(numberedHashes),
            `${language}/direction: identical package bytes on both sides excluding direction.json`,
          );
          assert.notEqual(currentHashes['direction.json'], numberedHashes['direction.json']);
        } else {
          assert.deepEqual(
            currentHashes,
            numberedHashes,
            `${language}/${kind}: identical package bytes on both sides`,
          );
        }
        const currentPub = await currentSetup.h.publish();
        const numberedPub = await numberedSetup.h.publish();
        const captures: Record<Side, {png: string; text: string; pub: JobPublication}> = {} as never;

        for (const [side, setup, pub] of [['current', currentSetup, currentPub], ['numbered', numberedSetup, numberedPub]] as const) {
          const url = new URL(setup.h.host.ownerUrl);
          url.searchParams.set('lang', language);
          await page.goto(url.href, language);
          const stageReady = kind === 'parts'
            ? `Number(document.querySelector('#parts-canvas')?.width)>0`
            : kind === 'direction'
              ? `!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#direction-panel')`
              : `!!document.querySelector('#rig-root canvas')`;
          await wait(`document.body.dataset.ready==='true'&&!document.body.inert&&document.querySelector('#send-comments')?.checkVisibility()===true&&document.querySelector('#save')?.hidden===true&&document.querySelector('#message')?.textContent===${JSON.stringify(setup.title)}&&${stageReady}`);
          if (kind === 'direction') {
            await page.evaluate(`(()=>{const d=document.querySelector('#direction-panel');if(d&&!d.open)d.querySelector('summary').click();})()`);
            await wait(`!!document.querySelector('#direction-panel')?.open&&document.querySelectorAll('#direction-panel li').length>0`);
          }
          await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
          assert.equal(await page.evaluate(`document.documentElement.lang`), language);
          const expectedBadge = (language === 'en' ? 'source ' : '소스 ') + pub.source.sourceHash.slice(0, 12);
          assert.equal(await page.evaluate<string>(`document.querySelector('#source-hash')?.textContent??''`), expectedBadge);
          const png = `${language}-${kind}-${side}.png`;
          await writeFile(join(output, png), await page.screenshot());
          const text = await page.evaluate<string>(`document.body.innerText`);
          captures[side] = {png, text, pub};

          if (side === 'current') {
            if (!await page.evaluate<boolean>(`!!document.querySelector('[data-comment-general]')?.checkVisibility()`)) {
              await page.evaluate(`document.querySelector('#stage-comment').click()`);
            }
            await wait(`!!document.querySelector('[data-comment-general]')?.checkVisibility()`);
            await page.evaluate(`document.querySelector('[data-comment-general]').click()`);
            await wait(`!!document.querySelector('.stage-comment-composer input')`);
            await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Current draft key check';f.requestSubmit();})()`);
            await wait(`!document.querySelector('.stage-comment-composer')`);
            const prefix = kind === 'direction' ? 'rig-review-record-comments/1:' : 'rig-review-verdict-comments/1:';
            const expectedDraftId = `create:current:${kind}:${setup.record}`;
            assert.equal(jobSourceDraftId(pub.source), expectedDraftId);
            const storageKey = `${prefix}${setup.h.host.session.jobId}:${expectedDraftId}:${pub.source.sourceHash}`;
            const saved: {comments: {summary: string}[]} | null = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
            assert.deepEqual(saved?.comments.map((c: {summary: string}) => c.summary), ['Current draft key check']);
          }
          await page.goto('about:blank');
        }

        const currentNorm = captures.current.text
          .replaceAll(currentPub.source.sourceHash, '<sourceHash64>')
          .replaceAll(currentPub.source.sourceHash.slice(0, 12), '<sourceHash12>');
        const numberedNorm = captures.numbered.text
          .replaceAll(numberedPub.source.sourceHash, '<sourceHash64>')
          .replaceAll(numberedPub.source.sourceHash.slice(0, 12), '<sourceHash12>');
        const diff = lineDiff(currentNorm, numberedNorm);
        const rawDiff = lineDiff(captures.current.text, captures.numbered.text);

        if (kind === 'direction') {
          const currentDirSha = currentHashes['direction.json']!;
          const numberedDirSha = numberedHashes['direction.json']!;
          const currentSummary = language === 'en' ? 'Direction · 4 s · loop' : '연출 · 4초 · 반복';
          const numberedSummary = language === 'en' ? 'Direction v3 · 4 s · loop' : '연출 v3 · 4초 · 반복';
          const currentAuthored = language === 'en'
            ? `Authored direction · direction.json · SHA-256 ${currentDirSha}`
            : `작성된 연출 · direction.json · SHA-256 ${currentDirSha}`;
          const numberedAuthored = language === 'en'
            ? `Authored direction · rig v2 · direction.json · SHA-256 ${numberedDirSha}`
            : `작성된 연출 · 리그 v2 · direction.json · SHA-256 ${numberedDirSha}`;
          assert.ok(!captures.current.text.includes('undefined'), `${language}/direction: no undefined in current text`);
          assert.ok(!captures.current.text.includes('rig v'), `${language}/direction: no rig version in current text`);
          assert.ok(!captures.current.text.includes('리그 v'), `${language}/direction: no KO rig version in current text`);
          assert.ok(currentNorm.includes(currentSummary), `${language}/direction current summary`);
          assert.ok(numberedNorm.includes(numberedSummary), `${language}/direction numbered summary`);
          assert.ok(currentNorm.includes(currentAuthored), `${language}/direction current authored row`);
          assert.ok(numberedNorm.includes(numberedAuthored), `${language}/direction numbered authored row`);
          assert.equal(
            numberedNorm.replace(numberedSummary, currentSummary).replace(numberedAuthored, currentAuthored),
            currentNorm,
            `${language}/direction: only omitted version labels and direction.json sha256 differ`,
          );
          assert.deepEqual(diff.map(({current, numbered}) => ({current, numbered})), [
            {current: currentSummary, numbered: numberedSummary},
            {current: currentAuthored, numbered: numberedAuthored},
          ]);
        } else {
          assert.equal(currentNorm, numberedNorm, `${language}/${kind}: visible text equal across pair`);
          assert.deepEqual(diff, []);
        }

        await writeFile(join(output, `${language}-${kind}-diff.json`), JSON.stringify({
          language,
          output: kind,
          pngs: {current: captures.current.png, numbered: captures.numbered.png},
          omittedVersionLabel: kind === 'direction' ? ' v3' : null,
          omittedRigVersionLabel: kind === 'direction' ? (language === 'en' ? 'rig v2 · ' : '리그 v2 · ') : null,
          diff,
          rawLineDiff: rawDiff,
          sourceHashes: {current: currentPub.source.sourceHash, numbered: numberedPub.source.sourceHash},
          ...(kind === 'direction' ? {directionHashes: {current: currentHashes['direction.json'], numbered: numberedHashes['direction.json']}} : {}),
        }, null, 2) + '\n');
      } finally {
        await currentSetup.h.close();
        await numberedSetup.h.close();
      }
    }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) {
    await writeFile(join(output, 'failure.png'), await page.screenshot()).catch(() => {});
    await writeFile(join(output, 'failure-state.json'), await page.evaluate<string>(`JSON.stringify({text:document.body.innerText,ready:document.body.dataset.ready})`)).catch(() => {});
  }
  await writeFile(join(output, 'failure-error.json'), JSON.stringify({error: String(error), stack: error instanceof Error ? error.stack : undefined, errors}, null, 2)).catch(() => {});
  throw error;
} finally {
  await page?.close();
  await rm(profile, {recursive: true, force: true});
}
