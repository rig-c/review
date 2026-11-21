/** Ordinary Nova browser proof, or an interactive loopback fixture with --serve. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {canonicalJson} from '../src/canonical-json.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {jobBodyLimit, jobHash, parseChestLandmarksAct, parseContextCommentsAct, parseMeshEditsAct} from '../src/job-api.ts';
import {JOB_API_SCHEMA, JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_MESH_EDITS_ACT_SCHEMA,
  type JobChestLandmarkValue, type JobPublishedChestLandmark, type JobResponseValues, type JobResult} from '../src/job-contract.ts';
import type {ReviewManifest} from '../src/manifest.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {boxesIntersect, placeLabels} from '../web/label-placement.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const serving = Bun.argv.includes('--serve');
if (Bun.argv.includes('--gate')) throw new Error('--gate has been removed. This fixture uses the production writer.');
const outputIndex = Bun.argv.indexOf('--out');
const output = resolve(outputIndex < 0 ? 'artifacts/job-mesh-act-952' : Bun.argv[outputIndex + 1]!);

type BrowserMode = 'with-comment' | 'mesh-only' | 'no-mesh' | 'stale-draft' | 'chest-only' | 'chest-optional' | 'chest-readonly';
type BrowserFixtureModel = {
  stage: {x: number; y: number; width: number; height: number};
  bones: {name: string; parent?: string; x?: number; y?: number}[];
  skins: {name: string; attachments: {mesh: {mesh: {vertices: {xy: number[]}}}}}[];
  pages: {name: string; regions: object[]}[];
  animations: {name: string; bones: {name: string; timelines: {name: string; keys: {time: number; value: number}[]}[]}[]}[];
};

const chestPoseX = 7;
const correctedApex: [number, number] = [49, 41];

async function createFixture(mode: BrowserMode) {
  const seededChest = mode === 'chest-only' || mode === 'chest-optional';
  let fetchCapability: string | undefined;
  const fixture = await realJobWindowFixture(seededChest ? {
    installWriterBinding: binding => { fetchCapability = binding.fetchCapability; },
  } : {});
  try {
    const path = join(fixture.input.root, 'out/skeleton.model.json');
    const model: BrowserFixtureModel = await Bun.file(path).json();
    // Match the editor's crop mapping without mutating the checked-in viewport fixture.
    model.stage.x = -model.stage.width / 2;
    const bone = model.bones.find(item => item.name === 'mesh');
    assert.ok(bone);
    bone.y = 24;
    const entry = model.skins.find(skin => skin.name === 'default')?.attachments.mesh.mesh;
    assert.ok(entry);
    if (mode === 'mesh-only') {
      // A larger textured mesh makes the real fixed-camera still exceed 256 KiB.
      Object.assign(bone, {x: 0, y: 32});
      entry.vertices.xy = entry.vertices.xy.map(coordinate => coordinate * 2.4);
      const size = 512, png = new PNG({width: size, height: size});
      let seed = 952;
      for (let i = 0; i < png.data.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        png.data[i] = i % 4 === 3 ? 255 : seed & 255;
      }
      const page = model.pages.find(row => row.name === 'mesh.png');
      assert.ok(page?.regions[0]);
      Object.assign(page, {width: size, height: size});
      Object.assign(page.regions[0], {width: size, height: size, originalWidth: size, originalHeight: size});
      await writeFile(join(fixture.input.root, 'out/mesh.png'), PNG.sync.write(png));
    }
    const {width, height} = model.stage;
    let chestSeed: JobPublishedChestLandmark | undefined;
    if (seededChest) {
      // The carrier moves with a chest bone by a known amount at the paused inspection frame.
      model.bones.splice(model.bones.indexOf(bone), 0, {name: 'chest', parent: 'root'});
      bone.parent = 'chest';
      const inspect = model.animations.find(animation => animation.name === 'inspect');
      assert.ok(inspect);
      inspect.bones.push({name: 'chest', timelines: [{name: 'translatex', keys: [{time: 0, value: 0},
        {time: 0.5, value: chestPoseX}, {time: 1, value: 0}]}]});
      const bust: JobPublishedChestLandmark['bust'] = {apex_r: [50.25, 39.5], apex_l: [66.5, 39.5],
        ...(mode === 'chest-only' ? {cleavage: [58.5, 38.25]} : {}), alpha: 0.46, clearance: 2.6};
      const configPath = 'out/mesh-config.json';
      const config = JSON.stringify({meshes: {mesh: {contour: {bust}}}});
      const configHash = jobHash(config);
      await writeFile(join(fixture.input.root, configPath), config);
      chestSeed = {slot: 'mesh', skin: 'default', attachment: 'mesh', basis: 'setup',
        source: {hash: jobHash(JSON.stringify(entry)), frame: {width, height}, configHash}, bust};
      const context = fixture.input.getContext();
      fixture.input.setContext({...context, files: [...context.files, {path: configPath, sha256: configHash}],
        chestLandmarks: [chestSeed]});
    }
    await writeFile(path, JSON.stringify(model));
    async function askForRig() {
      const publication = await fixture.publish();
      const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
        requestId: randomUUID(), verb: 'ask', expectedGeneration: fixture.host.session.status().generation,
        idempotencyKey: randomUUID(), publicationId: publication.publicationId,
        subject: {kind: 'review-verdict', stage: 'rig-review'}});
      const result: JobResult<JobResponseValues['ask']> = await response.json();
      assert.equal(result.ok, true, JSON.stringify(result));
      return publication;
    }
    const publication = await askForRig();
    assert.deepEqual(publication.chestLandmarks, chestSeed ? [chestSeed] : undefined);
    const owner = (language: 'en' | 'ko') => {
      const url = new URL(fixture.host.ownerUrl);
      url.searchParams.set('lang', language);
      return url.href;
    };
    return {...fixture, owner, entry, publication, askForRig, stage: model.stage, chestSeed, fetchCapability};
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

type LandmarkFields = {
  apex_r: [string, string]; apex_l: [string, string]; cleavage: [string, string];
  alpha: string; clearance: string;
};

function readLandmarkFields(screen: InputCdpSession): Promise<LandmarkFields> {
  return screen.evaluate<LandmarkFields>(`(() => {
    const value = id => document.getElementById('lm-' + id).value;
    const point = key => [value(key + '-x'), value(key + '-y')];
    return {apex_r: point('apex_r'), apex_l: point('apex_l'), cleavage: point('cleavage'),
      alpha: value('alpha'), clearance: value('clearance')};
  })()`);
}

async function placePosedApex(screen: InputCdpSession, stage: BrowserFixtureModel['stage']) {
  await click(screen, '[data-mode="playback"]');
  await screen.evaluate<void>(`(() => {
    const animation = document.querySelector('#animation-select');
    animation.value = 'inspect';
    animation.dispatchEvent(new Event('change', {bubbles: true}));
    const scrub = document.querySelector('#scrub');
    scrub.value = '0.5';
    scrub.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await click(screen, '[data-landmark="apex_r"]');
  const {animation, time, camera, overlay} = await screen.evaluate<{
    animation: string; time: number; camera: ControlNumericCamera | null;
    overlay: {left: number; top: number; width: number; height: number};
  }>(`(() => ({animation: document.querySelector('#animation-select').value,
    time: Number(document.querySelector('#scrub').value),
    camera: JSON.parse(document.querySelector('#view-coordinates').textContent).cameras.rig,
    overlay: document.querySelector('#rig-overlay').getBoundingClientRect().toJSON()}))()`);
  assert.equal(animation, 'inspect');
  assert.equal(time, 0.5);
  assert.equal(camera?.space, 'world');
  // Project the known setup point plus the fixture's independently authored pose translation.
  const scale = camera.viewport.width / camera.visible.width;
  const worldX = stage.x + correctedApex[0] + chestPoseX;
  const worldY = stage.y + stage.height - correctedApex[1];
  const x = overlay.left + camera.viewport.width / 2 + (worldX - camera.center.x) * scale;
  const y = overlay.top + camera.viewport.height / 2 - (worldY - camera.center.y) * scale;
  assert.ok(x > overlay.left && x < overlay.left + overlay.width && y > overlay.top && y < overlay.top + overlay.height);
  await screen.mouse('mouseMoved', x, y);
  await screen.mouse('mousePressed', x, y);
  await screen.mouse('mouseReleased', x, y);
}

async function runBrowser(language: 'en' | 'ko', mode: BrowserMode) {
  const largeCapture = mode === 'mesh-only';
  const fixture = await createFixture(mode);
  const {chestSeed} = fixture;
  const chestCase = !!chestSeed || mode === 'chest-readonly';
  const profile = await mkdtemp(join(tmpdir(), 'review-952-chrome-'));
  const directory = join(output, language, mode);
  await mkdir(directory, {recursive: true});
  let page: InputCdpSession | undefined;
  try {
    let send: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
    const dialogs: {type: string; message: string; accepted: boolean}[] = [];
    let acceptNextDialog = true;
    const catalog = language === 'ko' ? koCatalog : enCatalog;
    const expectedConfirm = catalog['Send this Request changes with {0} mesh edit(s) to the producer?']!.replace('{0}', '1');
    page = await launchCdpSession(profile, {onEvent: (event, command) => {
      send = command;
      if (event.method === 'Page.javascriptDialogOpening') {
        const accept = acceptNextDialog;
        dialogs.push({type: String(event.params?.type ?? ''), message: String(event.params?.message ?? ''), accepted: accept});
        return command('Page.handleJavaScriptDialog', {accept}).then(() => {});
      }
    }});
    const screen = page;
    await screen.setViewport(largeCapture ? 2200 : 1440, largeCapture ? 1750 : 1000);
    if (mode === 'with-comment') {
      await screen.goto('about:blank');
      assert.ok(send);
      await send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
        const original=window.fetch;
        window.fetch=(input,init)=>{
          if(window.__refuseMeshOnce &&
             new URL(input instanceof Request?input.url:input, location.href).pathname.endsWith('/ui/acts')){
            window.__refuseMeshOnce=false;
            return Promise.resolve(Response.json({ok:false,error:{code:'JOB_ACT_INVALID',message:'JOB_ACT_INVALID'}},{status:400}));
          }
          return original(input,init);
        };
      })()`});
    }
    await screen.goto(fixture.owner(language), language);
    async function wait(expression: string) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await screen.evaluate<boolean>(expression)) return;
        await Bun.sleep(40);
      }
      const message = await screen.evaluate<{text: string; title: string}>(`(() => {
        const node = document.querySelector('#message');
        return {text: node?.textContent ?? '', title: node?.title ?? ''};
      })()`);
      throw new Error(`${language} ${mode}: timed out waiting for ${expression} | ${message.text} | ${message.title}`);
    }
    async function point(selector: string) {
      return screen.evaluate<{x: number; y: number}>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x:r.left+r.width*.54,y:r.top+r.height*.49};})()`);
    }
    async function pointer(selector: string) {
      const {x, y} = await point(selector);
      await screen.mouse('mouseMoved', x, y);
      await screen.mouse('mousePressed', x, y);
      await screen.mouse('mouseReleased', x, y);
    }
    await wait("!!document.querySelector('#rig-root canvas') && !!document.querySelector('#save:not([hidden]):not(:disabled)')");
    assert.equal(await screen.evaluate<string>('document.documentElement.lang'), language);
    assert.equal(await screen.evaluate<boolean>("document.querySelector('#request-changes').disabled"), true);
    const inputHashes = chestCase ? await jobInputHashes(fixture.input.root) : null;
    async function latestAct() {
      const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
        requestId: randomUUID(), verb: 'next', after: null, waitMs: 0});
      const result: JobResult<JobResponseValues['next']> = await response.json();
      assert.ok(result.ok, JSON.stringify(result));
      const acts = result.value.events.flatMap(event => event.type === 'act' ? [event.act] : []);
      assert.equal(acts.length, 1, `${language} ${mode}: expected one finalized act`);
      const act = acts[0]!;
      const raw = fixture.host.session.readActExport(act.actId, false).toString();
      assert.equal(raw, JSON.stringify(act));
      return {act, raw};
    }
    async function selectCarrier() {
      await click(screen, '[data-mode="rig"]');
      const carrier = '[data-part-list] button[data-slot=mesh]';
      await wait(`!!document.querySelector(${JSON.stringify(carrier)})`);
      await click(screen, carrier);
    }
    if (chestCase) {
      await selectCarrier();
      const requestDisabled = "document.querySelector('#request-changes').disabled";
      if (chestSeed) {
        await wait("!!document.querySelector('#chest-edit:not([hidden]):not(:disabled)')");
        await click(screen, '#chest-edit');
        await wait("!!document.querySelector('#chest-editor-bar:not([hidden]) [data-bust-mode=landmarks][aria-pressed=true]')");
        const controls = await screen.evaluate<{
          applyDisabled: boolean; circlesDisabled: boolean; status: string; readout: string; readoutError: boolean;
        }>(`({
          applyDisabled: document.querySelector('#bust-apply').disabled,
          circlesDisabled: document.querySelector('[data-bust-mode=circles]').disabled,
          status: document.querySelector('#chest-editor-status').innerText,
          readout: document.querySelector('#lm-derived').textContent,
          readoutError: document.querySelector('#lm-derived').classList.contains('error')
        })`);
        assert.equal(controls.applyDisabled, true);
        assert.equal(controls.circlesDisabled, true);
        assert.ok(controls.status.includes(catalog['job.chest.sendHint']), controls.status);
        if (!chestSeed.bust.cleavage) {
          assert.equal(controls.readout, '', 'Omitting cleavage leaves the derived-circle readout empty');
          assert.equal(controls.readoutError, false);
        }
        const seeded = await readLandmarkFields(screen);
        assert.deepEqual(seeded, {apex_r: ['50.25', '39.5'], apex_l: ['66.5', '39.5'],
          cleavage: chestSeed.bust.cleavage ? ['58.5', '38.25'] : ['', ''], alpha: '0.46', clearance: '2.6'});
        assert.equal(await screen.evaluate<boolean>(requestDisabled), true, 'Published points alone are not a correction');
        await writeFile(join(directory, 'seeded.png'), await screen.screenshot());
        if (chestSeed.bust.cleavage) {
          const landmarkTags = [
            catalog["Right apex (character's right, image left)"],
            catalog["Left apex (character's left, image right)"],
            catalog['Cleavage'],
          ];
          const overlayRead = await screen.evaluate<{
            width: number; height: number;
            points: {x: number; y: number}[];
            widths: number[];
          }>(`(() => {
            const canvas = document.querySelector('#rig-overlay');
            const ctx = canvas.getContext('2d');
            ctx.font = '600 11px ui-monospace, monospace';
            const camera = JSON.parse(document.querySelector('#view-coordinates').textContent).cameras.rig;
            const stage = ${JSON.stringify(fixture.stage)};
            const scale = camera.viewport.width / camera.visible.width;
            const project = ([cx, cy]) => {
              const wx = stage.x + cx, wy = stage.y + stage.height - cy;
              return {
                x: camera.viewport.width / 2 + (wx - camera.center.x) * scale,
                y: camera.viewport.height / 2 - (wy - camera.center.y) * scale,
              };
            };
            const pts = [[50.25, 39.5], [66.5, 39.5], [58.5, 38.25]].map(project);
            const tags = ${JSON.stringify(landmarkTags)};
            return {
              width: canvas.clientWidth,
              height: canvas.clientHeight,
              points: pts,
              widths: tags.map(tag => ctx.measureText(tag).width + 8),
            };
          })()`);
          const obstacles = overlayRead.points.map(at => ({x: at.x - 6.5, y: at.y - 6.5, w: 13, h: 13}));
          const placed = placeLabels(
            overlayRead.points.map((at, i) => ({at, width: overlayRead.widths[i]!})),
            {gap: 10, rise: 3, bounds: {width: overlayRead.width, height: overlayRead.height}, obstacles},
          );
          await writeFile(join(directory, 'overlay-labels.json'), JSON.stringify({overlayRead, placed}, null, 2) + '\n');
          assert.equal(placed.every(p => p.visible), true, `${language} chest landmark labels all visible`);
          for (let i = 0; i < placed.length; i++) {
            for (let j = i + 1; j < placed.length; j++) {
              assert.equal(boxesIntersect(placed[i]!.box, placed[j]!.box), false,
                `${language} landmark labels ${i} and ${j} do not intersect`);
            }
            for (const obstacle of obstacles) {
              assert.equal(boxesIntersect(placed[i]!.box, obstacle), false,
                `${language} landmark label ${i} clears marker obstacles`);
            }
          }
          const [rightApexBox, leftApexBox] = [placed[0]!.box, placed[1]!.box];
          assert.ok(rightApexBox.x + rightApexBox.w <= leftApexBox.x,
            `${language} F08 apex labels do not overlap horizontally: right=${JSON.stringify(rightApexBox)} left=${JSON.stringify(leftApexBox)}`);
        }
        await placePosedApex(screen, fixture.stage);
        const edited = await readLandmarkFields(screen);
        assert.deepEqual(edited, {...seeded, apex_r: correctedApex.map(String)});
        await wait(`!(${requestDisabled})`);
        await writeFile(join(directory, 'posed-edited.png'), await screen.screenshot());
        await writeFile(join(directory, 'landmarks.json'), JSON.stringify({controls, seeded, edited}));
      } else {
        await wait("!!document.querySelector('#chest-edit:not([hidden]):disabled')");
        const readOnly = await screen.evaluate<{
          reason: string; notice: string; editorHidden: boolean; applyDisabled: boolean;
        }>(`({
          reason: document.querySelector('#chest-edit').title,
          notice: document.querySelector('#chest-unavailable').textContent,
          editorHidden: document.querySelector('#chest-editor-bar').hidden,
          applyDisabled: document.querySelector('#bust-apply').disabled
        })`);
        assert.equal(readOnly.reason, catalog['job.chest.unpublished']);
        assert.equal(readOnly.notice, readOnly.reason);
        assert.equal(readOnly.editorHidden, true);
        assert.equal(readOnly.applyDisabled, true);
        const fields = await readLandmarkFields(screen);
        assert.deepEqual(fields.apex_r, ['', '']);
        assert.deepEqual(fields.apex_l, ['', '']);
        assert.deepEqual(fields.cleavage, ['', '']);
        assert.equal(await screen.evaluate<boolean>(requestDisabled), true);
        await writeFile(join(directory, 'read-only.png'), await screen.screenshot());
        await writeFile(join(directory, 'read-only.json'), JSON.stringify({readOnly, fields}));
      }
    }
    if (mode === 'with-comment' || mode === 'no-mesh' || mode === 'stale-draft' || mode === 'chest-readonly') {
      await click(screen, '#stage-comment');
      await pointer('#rig-viewport');
      await wait("!!document.querySelector('.stage-comment-composer input')");
      await screen.evaluate<void>(`(()=>{const form=document.querySelector('.stage-comment-composer');
        form.querySelector('input').value='Adjust the mesh';form.requestSubmit();})()`);
      await wait("!document.querySelector('.stage-comment-composer') && !document.querySelector('#request-changes').disabled");
      if (mode === 'with-comment') {
        const commentVisuals = await screen.evaluate<{
          lineHeight: string;
          lineHeightPx: number;
          themes: Record<'dark' | 'light', {bg: string; fg: string; stage: string; pinOnStage: number; numberOnPin: number}>;
        }>(`(() => {
          const parseRgb = (str) => {
            const m = str.match(/\\d+(\\.\\d+)?/g);
            return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
          };
          const lum = (rgb) => {
            const [r, g, b] = rgb.map(v => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ratio = (a, b) => {
            const la = lum(parseRgb(a)), lb = lum(parseRgb(b));
            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
          };
          const rowBtn = document.querySelector('.stage-comment-item > button:first-child');
          const pin = document.querySelector('.stage-comment-pin');
          const pane = document.querySelector('#rig-pane');
          const lineHeight = getComputedStyle(rowBtn).lineHeight;
          const prevTheme = document.documentElement.dataset.theme;
          const themes = {};
          for (const theme of ['dark', 'light']) {
            document.documentElement.dataset.theme = theme;
            const ps = getComputedStyle(pin), stage = getComputedStyle(pane).backgroundColor;
            themes[theme] = {
              bg: ps.backgroundColor,
              fg: ps.color,
              stage,
              pinOnStage: Number(ratio(ps.backgroundColor, stage).toFixed(2)),
              numberOnPin: Number(ratio(ps.color, ps.backgroundColor).toFixed(2)),
            };
          }
          if (prevTheme) document.documentElement.dataset.theme = prevTheme;
          else delete document.documentElement.dataset.theme;
          return {lineHeight, lineHeightPx: Number.parseFloat(lineHeight), themes};
        })()`);
        await screen.evaluate<void>("document.documentElement.dataset.theme = 'dark'");
        await writeFile(join(directory, 'comments-pins-dark.png'), await screen.screenshot());
        await screen.evaluate<void>("document.documentElement.dataset.theme = 'light'");
        await writeFile(join(directory, 'comments-pins-light.png'), await screen.screenshot());
        await screen.evaluate<void>("delete document.documentElement.dataset.theme");
        await writeFile(join(directory, 'comment-visuals.json'), JSON.stringify(commentVisuals, null, 2) + '\n');
        assert.ok(commentVisuals.lineHeightPx >= 20,
          `${language} F04 comment row line-height expected >=20px, got ${commentVisuals.lineHeight}`);
        for (const theme of ['dark', 'light'] as const) {
          const t = commentVisuals.themes[theme];
          assert.ok(t.pinOnStage >= 3,
            `${language} F06 ${theme} pin/stage contrast expected >=3, got ${t.pinOnStage} (${t.bg} on ${t.stage})`);
          assert.ok(t.numberOnPin >= 4.5,
            `${language} F06 ${theme} number/pin contrast expected >=4.5, got ${t.numberOnPin} (${t.fg} on ${t.bg})`);
        }
      }
      if (await screen.evaluate<boolean>("document.querySelector('#stage-comment').getAttribute('aria-pressed')==='true'")) {
        await click(screen, '#stage-comment');
      }
    }
    if (mode === 'stale-draft') {
      await screen.evaluate<void>(`(() => {
        const draft=document.querySelector('#mesh-edit-draft');
        draft.value=JSON.stringify({schema:'rig-review-mesh-edit-draft/2',entries:{
          'default/mesh/mesh':{hash:'0'.repeat(64),ops:[{op:'add',at:[52,42]}]}
        }});
        draft.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
    }
    if (!chestCase && mode !== 'no-mesh') {
      await selectCarrier();
      await wait("!document.querySelector('#mesh-edit').hidden");
      await click(screen, '#mesh-edit');
      await wait("!document.querySelector('#mesh-editor-bar').hidden");
      assert.equal(await screen.evaluate<boolean>("document.querySelector('#mesh-apply').disabled"), true);
      const hint = catalog['In a job, press Request changes to send this edit; the producer rebuilds it.'];
      if (mode === 'stale-draft') {
        await wait(`document.querySelector('#mesh-editor-status').innerText.includes(${JSON.stringify(catalog['job.mesh.staleDraft'])})`);
      }
      const text = await screen.evaluate<string>("document.querySelector('#mesh-editor-status').innerText");
      assert.ok(text.includes(hint), `${language} ${mode}: expected the mesh submission hint, read ${text}`);
      assert.ok(!text.includes(catalog['job.submit.JOB_ACT_KIND_DISABLED']));
      if (mode === 'stale-draft') {
        assert.equal(await screen.evaluate<boolean>("document.querySelector('#mesh-undo').disabled"), true);
        await writeFile(join(directory, 'stale-status.json'), JSON.stringify({text}));
      } else {
        await click(screen, '#mesh-mode-create');
        await pointer('#rig-overlay');
        await wait("document.querySelector('#mesh-edit-draft').value.includes('\"op\":\"add\"')");
        await writeFile(join(directory, 'edited.png'), await screen.screenshot());
      }
    }
    await wait("!document.querySelector('#request-changes').disabled");
    const meshExpected = mode === 'mesh-only' || mode === 'with-comment';
    if (meshExpected) {
      const before = await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value");
      assert.ok(before);
      acceptNextDialog = false;
      await click(screen, '#request-changes');
      await wait("!document.querySelector('#request-changes').disabled");
      assert.deepEqual(dialogs, [{type: 'confirm', message: expectedConfirm, accepted: false}]);
      await writeFile(join(directory, 'confirm.png'), await screen.screenshot());
      await writeFile(join(directory, 'confirm.json'), JSON.stringify(dialogs[0], null, 2) + '\n');
      assert.equal(await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value"), before);
      assert.equal(await screen.evaluate<boolean>("document.querySelector('#message').classList.contains('error')"), false);
      const pending = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
        requestId: randomUUID(), verb: 'next', after: null, waitMs: 0});
      const pendingResult: JobResult<JobResponseValues['next']> = await pending.json();
      assert.ok(pendingResult.ok, JSON.stringify(pendingResult));
      assert.deepEqual(pendingResult.value.events.filter(event => event.type === 'act'), []);
      acceptNextDialog = true;
    }
    if (mode === 'with-comment') {
      const before = await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value");
      assert.ok(before);
      await screen.evaluate<void>("void(window.__refuseMeshOnce=true)");
      await click(screen, '#request-changes');
      await wait("document.querySelector('#message').title.includes('JOB_ACT_INVALID') && !document.querySelector('#request-changes').disabled");
      assert.equal(await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value"), before);
    }
    await click(screen, '#request-changes');
    await wait("document.querySelector('#workspace-act-row').hidden");
    assert.deepEqual(dialogs, meshExpected ? [
      {type: 'confirm', message: expectedConfirm, accepted: false},
      ...(mode === 'with-comment' ? [{type: 'confirm', message: expectedConfirm, accepted: true}] : []),
      {type: 'confirm', message: expectedConfirm, accepted: true},
    ] : []);
    const {act: finalized, raw} = await latestAct();
    const expectedSchema = chestSeed ? JOB_CHEST_LANDMARKS_ACT_SCHEMA : meshExpected ? JOB_MESH_EDITS_ACT_SCHEMA : JOB_COMMENT_CONTEXT_ACT_SCHEMA;
    assert.equal(finalized.schema, expectedSchema,
      `${language} ${mode}: unexpected schema from the production writer`);
    if (chestSeed) {
      assert.ok(fixture.fetchCapability);
      const response = await fetch(fixture.locator + '/api', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.fetchCapability},
        body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId, requestId: randomUUID(),
          verb: 'fetch-act', actId: finalized.actId}),
      });
      const fetched: JobResult<JobResponseValues['fetch-act']> = await response.json();
      assert.ok(fetched.ok, JSON.stringify(fetched));
      assert.deepEqual(fetched.value, finalized);
      assert.throws(() => parseMeshEditsAct(fetched.value), /JOB_ACT_INVALID/);
      const act = parseChestLandmarksAct(fetched.value);
      assert.equal(act.kind, 'review-verdict');
      assert.equal(act.value.stage, 'rig-review');
      assert.equal(act.value.verdict, 'changes-requested');
      assert.deepEqual(act.value.comments, []);
      assert.equal(act.value.meshEdits, undefined);
      assert.equal(act.publicationId, fixture.publication.publicationId);
      assert.equal(act.source.sourceHash, fixture.publication.source.sourceHash);
      assert.deepEqual(act.source.model, fixture.publication.source.model);
      const {hash, frame} = chestSeed.source;
      const edit: JobChestLandmarkValue = {...chestSeed, source: {hash, frame}, bust: {...chestSeed.bust, apex_r: correctedApex}};
      assert.deepEqual(act.value.chestLandmarks, [{edit, sha256: jobHash(canonicalJson(edit))}]);
      await writeFile(join(directory, 'submitted.png'), await screen.screenshot());
    } else if (meshExpected) {
      const act = parseMeshEditsAct(finalized);
      assert.equal(act.kind, 'review-verdict');
      assert.equal(act.value.stage, 'rig-review');
      assert.equal(act.value.verdict, 'changes-requested');
      assert.deepEqual(act.value.comments.map(comment => comment.text), mode === 'with-comment' ? ['Adjust the mesh'] : []);
      if (mode === 'with-comment') assert.equal(act.value.comments[0]?.context?.subject?.sourceHash, act.source.sourceHash);
      assert.ok(act.value.meshEdits, `${language} ${mode}: finalized act@8 is missing meshEdits`);
      assert.equal(act.value.meshEdits.length, 1);
      const {edit, sha256} = act.value.meshEdits[0]!;
      const expected = largeCapture ? [[16, 56], [16, 8], [64, 8], [64, 56]] :
        [[48, 50], [48, 30], [68, 30], [68, 50]];
      assert.equal(edit.source.positions.length, expected.length);
      for (const [index, position] of edit.source.positions.entries()) {
        for (const axis of [0, 1] as const) assert.ok(Math.abs(position[axis] - expected[index]![axis]!) < 1e-3);
      }
      assert.deepEqual(edit.source.frame, {width: fixture.stage.width, height: fixture.stage.height});
      assert.equal(edit.source.hash, jobHash(JSON.stringify(fixture.entry)));
      assert.equal(edit.ops.length, 1);
      assert.equal(edit.ops[0]?.op, 'add');
      assert.equal(sha256, jobHash(canonicalJson(edit)));
      await wait("document.querySelector('#mesh-edit-draft').value === ''");
      const png = fixture.host.session.readActExport(act.actId, true);
      if (largeCapture) {
        assert.ok(png.byteLength > jobBodyLimit, `still is only ${png.byteLength} bytes`);
        const path = join(fixture.input.root, 'out/review.json');
        const manifest: ReviewManifest = await Bun.file(path).json();
        await writeFile(path, JSON.stringify({...manifest, revision: 'same-mesh-next'}));
        const next = await fixture.askForRig();
        assert.notEqual(next.publicationId, fixture.publication.publicationId);
        assert.equal(next.source.model?.sha256, fixture.publication.source.model?.sha256);
        await wait("!!document.querySelector('#save:not([hidden]):not(:disabled)') && !document.querySelector('#workspace-act-row').hidden");
        assert.equal(await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value"), '');
        assert.equal(await screen.evaluate<boolean>("document.querySelector('#request-changes').disabled"), true);
        await click(screen, '#save');
        await wait("document.querySelector('#workspace-act-row').hidden");
        assert.equal(dialogs.length, 2);
      }
      await writeFile(join(directory, 'still-size.json'), JSON.stringify({bytes: png.byteLength}));
    } else {
      const act = parseContextCommentsAct(finalized);
      assert.equal(act.kind, 'review-verdict');
      assert.equal(act.value.stage, 'rig-review');
      assert.equal(act.value.verdict, 'changes-requested');
      assert.deepEqual(act.value.comments.map(comment => comment.text), ['Adjust the mesh']);
      assert.equal(act.value.comments[0]?.context?.subject?.sourceHash, act.source.sourceHash);
    }
    if (inputHashes) assert.deepEqual(await jobInputHashes(fixture.input.root), inputHashes, 'Owner actions preserve source bytes');
    await writeFile(join(directory, 'act.json'), raw);
    console.log(chestCase ? 'CHEST_ACT_990_PASS' : 'MESH_ACT_952_PASS', language, mode);
  } catch (error) {
    if (page) await writeFile(join(directory, 'failure.png'), await page.screenshot()).catch(() => {});
    throw error;
  } finally {
    try { await page?.close(); } finally {
      await fixture.close();
      await rm(profile, {recursive: true, force: true});
    }
  }
}

if (serving) {
  const fixture = await createFixture('chest-only');
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  process.on('SIGINT', stop);
  try {
    console.log('EN ' + fixture.owner('en'));
    console.log('KO ' + fixture.owner('ko'));
    await stopped;
  } finally {
    try { await fixture.close(); } finally { process.off('SIGINT', stop); }
  }
} else {
  const modesIndex = Bun.argv.indexOf('--modes');
  const requestedModes = modesIndex >= 0 ? Bun.argv[modesIndex + 1]!.split(',') as BrowserMode[] :
    ['mesh-only', 'with-comment', 'no-mesh', 'stale-draft', 'chest-only', 'chest-optional', 'chest-readonly'] as const;
  for (const language of ['en', 'ko'] as const) {
    for (const mode of requestedModes) {
      await runBrowser(language, mode);
    }
  }
}
