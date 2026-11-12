/** Direct Bun script (not bun-test discovery). Run on ordinary Nova only, after implementation freeze.
 * Synthetic producer input; real owner UI, displayed acknowledgment, SQLite act and semantic next.
 * EN/KO run sequentially in fresh profiles. No producer/compiler acceptance claim.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {JOB_API_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, type JobNextValue, type JobPendingAsk} from '../src/job-contract.ts';
import {parseCommentsAct} from '../src/job-api.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import type {LocalInspectionDraft} from '../web/inspection-persistence.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline, walkCheckpoint} from './helpers/walk-deadline.ts';
import {freshWalkReopen} from './helpers/walk-reopen.ts';
import {fullyVisible, visibilityGeometry} from './helpers/walk-visibility.ts';

const argument = (key: string) => {const at = Bun.argv.indexOf(key); return at < 0 ? undefined : Bun.argv[at + 1];};
const autoStill=Bun.argv.includes('--auto-still');
const verdict=(argument('--verdict')??'approved') as 'approved'|'changes-requested';
const language = argument('--lang') ?? 'both';
assert.ok(language === 'both' || language === 'en' || language === 'ko');
const output = resolve(argument('--out') ?? 'artifacts/job-rig-screen-709');
await mkdir(output, {recursive: true});

// Read only the public numeric observation. No internal screen state, altered bundle or act injection.
const cameraExpression = `JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig`;
const draftExpression = `Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-draft/1:'))
  .map(([key,value])=>({key,draft:JSON.parse(value)}))`;
const readyExpression = `!document.body.inert && !!document.querySelector('#stage-comment-list') &&
  !!document.querySelector('#rig-root canvas') && !!document.querySelector('#save:not(:disabled)') &&
  !!document.querySelector('#view-coordinates')?.textContent &&
  !!JSON.parse(document.querySelector('#view-coordinates').textContent).cameras.rig`;

async function run(lang: 'en' | 'ko') {
  const out = join(output, lang);
  await mkdir(out, {recursive: true});
  const mark = walkCheckpoint(join(out, 'checkpoints.jsonl'));
  const observations: Record<string, unknown> = {language: lang, fixture: 'synthetic trusted-host job window, static idle'};
  const catalog = lang === 'ko' ? koCatalog : enCatalog;
  const fixture = await realJobWindowFixture();
  const profile = await mkdtemp(join(tmpdir(), 'review-709-browser-'));
  let page: InputCdpSession | undefined;
  let unexpectedDialog: string | undefined;
  let pageCommand: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
  let loadEvents = 0;
  const documentLoads: {loaderId: string; frameId: string}[] = [];
  const record = async (key: string, value: unknown) => {
    observations[key] = value;
    await writeFile(join(out, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    mark(key);
    console.log('job-rig-screen-709 ' + lang + ' ' + key);
  };
  async function wait(expression: string, name: string) {
    await withDeadline('709.' + lang + '.' + name, 20_000, async signal => {
      while (!signal.aborted) {
        assert.equal(unexpectedDialog, undefined, 'view-only navigation must not open an unsaved-review dialog');
        if (await page!.evaluate<boolean>(expression)) return;
        await Bun.sleep(25);
      }
      throw signal.reason;
    });
  }
  const camera = () => page!.evaluate<ControlNumericCamera>(cameraExpression);
  function sameCamera(actual: ControlNumericCamera, expected: ControlNumericCamera, name: string) {
    assert.equal(actual.space, expected.space, name + ' space');
    assert.ok(Math.abs(actual.zoom - expected.zoom) < 1e-7, name + ' zoom');
    assert.ok(Math.abs(actual.center.x - expected.center.x) < 1e-7 &&
      Math.abs(actual.center.y - expected.center.y) < 1e-7, name + ' center');
    assert.deepEqual(actual.viewport, expected.viewport, name + ' viewport');
  }
  async function settled(name: string) {
    await wait(readyExpression, name + '.ready');
    // Sample across deferred persistence, ResizeObserver and animation frames, not just navigation completion.
    const samples: ControlNumericCamera[] = [];
    for (let index = 0; index < 16; index++) {
      samples.push(await camera());
      await Bun.sleep(100);
    }
    for (const sample of samples.slice(4)) sameCamera(sample, samples[4]!, name + '.stable');
    await record(name, {samples});
    return samples.at(-1)!;
  }
  async function screen(name: string) {
    const state = await page!.evaluate<{
      language: string; counts: Record<string, number>; title: string; rigHash: string; fullRigHash: string | null; sourceHash: string;
      status: string; selectedLabel: string; actInHeading: boolean; actVisible: boolean;
      actGeometry: unknown; inspectorHeight: number; controls: string[];
    }>(`(()=>{
      const visible=${fullyVisible.toString()}, geometry=${visibilityGeometry.toString()};
      const act=document.querySelector('.workspace-act-bar'),status=document.getElementById('review-status');
      const provenance=JSON.parse(document.getElementById('provenance-full').textContent);
      return {language:document.documentElement.lang,
        counts:Object.fromEntries(['#app','.topbar','.layout','#rig-viewport','#zoom-in','#zoom-out','#fit','#native-one','#view-menu','#save','#review-status','.workspace-act-bar']
          .map(selector=>[selector,document.querySelectorAll(selector).length])),
        title:document.getElementById('package-title').textContent,
        rigHash:document.getElementById('provenance-rig').textContent,
        fullRigHash:provenance.reviewedSource?.rig?.sha256??null,sourceHash:provenance.sourceHash,
        status:status.value,selectedLabel:status.selectedOptions[0].textContent,
        actInHeading:!!act?.closest('.inspector-heading'),actVisible:!!act&&visible(act),
        actGeometry:act?geometry(act):null,inspectorHeight:document.querySelector('.inspector').getBoundingClientRect().height,
        controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>node.id)};
    })()`);
    await record(name, state);
    assert.equal(state.language, lang);
    for (const [selector, count] of Object.entries(state.counts)) assert.equal(count, 1, 'single shared screen ' + selector);
    assert.deepEqual(state.controls, ['zoom-in', 'zoom-out', 'fit', 'native-one', 'view-menu']);
    assert.equal(state.actInHeading, true, 'the decision and submit act bar stays in the bottom heading');
    assert.equal(state.actVisible, true, 'the complete act bar stays visible');
    if (Bun.argv.includes('--assert-default262')) assert.ok(Math.abs(state.inspectorHeight - 262) <= 1, 'default bottom height 262');
    await writeFile(join(out, name + '.png'), await page!.screenshot());
    return state;
  }
  async function next() {
    const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
      requestId: randomUUID(), verb: 'next', after: null, waitMs: 0});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    return body.value as JobNextValue;
  }
  try {
    // Modify only disposable synthetic input, before publication/freeze. The source fixture stays unchanged.
    const modelPath = join(fixture.input.root, 'out/skeleton.model.json');
    const manifestPath = join(fixture.input.root, 'out/review.json');
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const still = structuredClone(model.animations.find((item: {name: string}) => item.name === 'still'));
    assert.ok(still, 'existing public fixture supplies a static clip');
    model.animations.push({...still, name: 'idle'});
    if (model.editorOrder?.animations) model.editorOrder.animations.push('idle');
    manifest.animations.push({id: 'idle', label: 'Synthetic static idle'});
    await writeFile(modelPath, JSON.stringify(model));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const publication = await fixture.publish();
    const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
      requestId: randomUUID(), verb: 'ask', expectedGeneration: fixture.host.session.status().generation,
      idempotencyKey: '709-rig-' + lang, publicationId: publication.publicationId,
      subject: {kind: 'review-verdict', stage: 'rig-review'}});
    assert.equal(response.status, 200);
    const asked = await response.json();
    assert.equal(asked.ok, true);
    const ask = asked.value as JobPendingAsk;
    const before = await jobInputHashes(fixture.input.root);
    const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
    const retainedBefore = await jobInputHashes(retained.snapshotRoot);
    await record('publication', {publication, ask, before, retainedBefore});
    page = await launchCdpSession(profile, {sendDeadlineMs: 20_000, async onEvent(event, send) {
      pageCommand = send;
      if (event.method === 'Page.loadEventFired') loadEvents++;
      if (event.method === 'Page.frameNavigated') {
        const frame = event.params?.frame as {id?: string; loaderId?: string; parentId?: string} | undefined;
        if (frame?.loaderId && frame.id && !frame.parentId) documentLoads.push({loaderId: frame.loaderId, frameId: frame.id});
      }
      if (event.method !== 'Page.javascriptDialogOpening') return;
      unexpectedDialog = String(event.params?.type ?? 'dialog');
      // Dismiss rather than approve a departure. This is a test failure, including after view-only edits.
      await send('Page.handleJavaScriptDialog', {accept: false});
    }});
    await page.setViewport(1440, 1000);
    if(autoStill&&pageCommand)await pageCommand('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:2,mobile:false});
    const owner = new URL(fixture.host.ownerUrl);
    owner.searchParams.set('lang', lang);
    await page.goto(owner.href, lang);
    const fresh = await settled('fresh-fit');
    const initial = await screen('fresh-screen');
    assert.equal(initial.status, 'pending');
    assert.equal(initial.selectedLabel, catalog['Pending']);
    assert.equal(initial.rigHash, publication.source.model!.sha256.slice(0, 12) + '…');
    assert.equal(initial.fullRigHash, publication.source.model!.sha256);
    assert.equal(initial.sourceHash, publication.source.sourceHash);
    assert.equal((await next()).events.filter(event => event.type === 'act').length, 0, 'opening never answers the pending ask');
    await click(page, '#fit');
    const explicitFit = await settled('explicit-fit');
    sameCamera(fresh, explicitFit, 'fresh open equals actual Fit');
    await click(page, '#zoom-in');
    await wait(`Math.abs((${cameraExpression}).zoom-${JSON.stringify(explicitFit.zoom)})>1e-5`, 'zoom-changed');
    const zoomed = await camera();
    await wait(`(${draftExpression}).some(({draft})=>draft.sourceHash===${JSON.stringify(publication.source.sourceHash)}&&
      Math.abs(draft.bookmark.view.cameras.rig.zoom-${JSON.stringify(zoomed.zoom)})<1e-7)`, 'zoom-bookmark-saved');
    const drafts = await page.evaluate<{key: string; draft: LocalInspectionDraft}[]>(draftExpression);
    const saved = drafts.find(item => item.draft.sourceHash === publication.source.sourceHash)!;
    assert.equal(saved.draft.reviewDirty, false, 'camera-only work is not an unsaved review');
    await record('saved-zoom-bookmark', {zoomed, saved});
    const savedUrl = await page.evaluate<string>('location.href');
    assert.ok(new URL(savedUrl).hash.startsWith('#review='), 'the real persistence path generated the bookmark URL');
    // Literal browser Reload while the current URL and local draft still contain the actual saved zoom.
    assert.ok(pageCommand, 'the existing CDP event hook exposes the page-scoped sender');
    const beforeReload = {loadEvents, document: documentLoads.at(-1)};
    assert.ok(beforeReload.document, 'initial top-level loader observed');
    await page.evaluate(`window.__jobRig709BeforeReload=true`);
    await pageCommand('Page.reload', {ignoreCache: false});
    await withDeadline('709.' + lang + '.reload-load-event', 20_000, async signal => {
      while (!signal.aborted) {
        assert.equal(unexpectedDialog, undefined, 'view-only Reload must not open an unsaved-review dialog');
        if (loadEvents > beforeReload.loadEvents) return;
        await Bun.sleep(25);
      }
      throw signal.reason;
    });
    await wait(`!Object.hasOwn(window,'__jobRig709BeforeReload') && (${readyExpression})`, 'reload-new-document');
    const reloaded = await settled('actual-reload-fit');
    sameCamera(reloaded, explicitFit, 'actual Reload of saved zoom settles at Fit');
    assert.ok(Math.abs(reloaded.zoom - zoomed.zoom) > 1e-5, 'Reload did not retain the saved zoom');
    assert.notEqual(documentLoads.at(-1)?.loaderId, beforeReload.document.loaderId, 'Reload replaced the document loader');
    await record('actual-reload', {command: 'Page.reload', before: beforeReload, after: {loadEvents, document: documentLoads.at(-1)}});
    assert.equal((await screen('reloaded-screen')).status, 'pending');
    assert.equal((await next()).events.filter(event => event.type === 'act').length, 0, 'Reload does not submit');
    // Fresh document at the actual saved link; no fabricated bookmark or localStorage writes.
    await freshWalkReopen(page, savedUrl, lang, '709.' + lang + '.bookmark-reopen', 1, mark, mark);
    const reopened = await settled('bookmark-reopened-fit');
    sameCamera(reopened, explicitFit, 'saved zoom must settle at Fit on hosted opening');
    assert.ok(Math.abs(reopened.zoom - zoomed.zoom) > 1e-5, 'reopen did not retain the old zoom');
    const afterReopen = await screen('reopened-screen');
    assert.equal(afterReopen.status, 'pending');
    assert.equal((await next()).events.filter(event => event.type === 'act').length, 0, 'reopen does not submit');
    let beforeSubmit:unknown;
    const inspectionExpression=`({camera:JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig,
      selected:[...document.querySelectorAll('[data-part-list] button[aria-pressed="true"]')].map(n=>({slot:n.dataset.slot,side:n.dataset.side})),
      time:document.getElementById('scrub')?.value,mode:document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode})`;
    if(autoStill){
      await page.evaluate(`(()=>{document.querySelector('[data-mode="playback"]').click();
        document.querySelector('[data-part-list] button[data-slot]').click();
        const scrub=document.getElementById('scrub');scrub.value='0.375';scrub.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click(page,'#zoom-in');
      beforeSubmit=await page.evaluate(inspectionExpression);
      assert.equal((beforeSubmit as any).mode,'playback');
      assert.equal((beforeSubmit as any).selected.length,1);
      assert.ok((beforeSubmit as any).camera.zoom>1);
      assert.equal(Number((beforeSubmit as any).time),0.375);
      await record('788-before-submit',beforeSubmit);
    }
    // Use the screen's actual select, change handler and trusted pointer submit. No /ui/acts call here.
    await click(page, '#review-status');
    await page.evaluate(`(()=>{const select=document.getElementById('review-status');select.value=${JSON.stringify(verdict)};
      select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.evaluate('document.activeElement?.blur()');
    await wait(`document.getElementById('review-status').value===${JSON.stringify(verdict)}&&!document.getElementById('save').disabled`, 'decision-ready');
    await screen('decision-screen');
    await click(page, '#save');
    let finalized: JobNextValue | undefined;
    await withDeadline('709.' + lang + '.recorded-act', 20_000, async signal => {
      while (!signal.aborted) {
        finalized = await next();
        if (finalized.events.some(event => event.type === 'act' && event.act.askId === ask.askId)) return;
        await Bun.sleep(50);
      }
      throw signal.reason;
    });
    const acts = finalized!.events.filter(event => event.type === 'act' && event.act.askId === ask.askId);
    assert.equal(acts.length, 1, 'exactly one actual finalized verdict');
    const event = acts[0]!;
    assert.ok(event.type === 'act' && event.act.kind === 'review-verdict');
    await writeFile(join(out, 'recorded-act.json'), JSON.stringify(event.act, null, 2) + '\n');
    const act = parseCommentsAct(event.act);
    assert.ok(act.kind === 'review-verdict');
    assert.ok(act.still);
    assert.equal(act.schema, JOB_COMMENTS_ACT_SCHEMA);
    assert.equal(act.publicationId, publication.publicationId);
    assert.equal(act.source.sourceHash, publication.source.sourceHash);
    assert.equal(act.authority.actor, 'human');
    assert.equal(act.authority.channel, 'review-ui');
    assert.equal(act.value.stage, 'rig-review');
    assert.equal(act.value.verdict, verdict);
    assert.deepEqual(act.value.comments, []);
    assert.equal(act.still.camera, 'fixed');
    assert.match(act.still.sha256, /^[a-f0-9]{64}$/);
    assert.equal(act.still.path, act.still.sha256 + '.png');
    await wait(`document.getElementById('dirty')?.classList.contains('dirty')===false`, 'submitted-clean');
    await screen('submitted-screen');
    if(autoStill){
      const after=await page.evaluate(inspectionExpression);
      assert.deepEqual(after,beforeSubmit,'Submit preserves camera, selection, time and mode');
      await record('788-after-submit',{after,still:act.still});
    }
    assert.deepEqual(await jobInputHashes(fixture.input.root), before);
    assert.deepEqual(await jobInputHashes(retained.snapshotRoot), retainedBefore);
    assert.equal(unexpectedDialog, undefined);
    await record('result', {status: 'PASS', askId: ask.askId, actId: act.actId, sourceUnchanged: true,
      browser: await page.evaluate('navigator.userAgent'), bun: Bun.version,
      limits: 'EN then KO, one browser at a time, no worker pool/producer; stage3 wrapper unsets DISPLAY/WAYLAND_DISPLAY, sets NODE_OPTIONS=--max-old-space-size=4096 and timeout 600; no hard total Bun/Chromium 6 GiB cgroup enforcement',
      scope: 'synthetic retained rig; actual human UI submission; no upstream producer or owner R0 ruling claim'});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record('failure', {status: 'FAIL', message: message.replace(/#cap=[a-f0-9]+/gi, '#cap=REDACTED'), unexpectedDialog});
    if (page) await writeFile(join(out, 'failure.png'), await page.screenshot()).catch(() => {});
    throw error;
  } finally {
    await page?.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
  }
}

const languages: ('en' | 'ko')[] = language === 'en' ? ['en'] : language === 'ko' ? ['ko'] : ['en', 'ko'];
for (const lang of languages) await run(lang);
