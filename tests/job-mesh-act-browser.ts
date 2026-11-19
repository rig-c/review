/** Ordinary Nova browser proof, or an interactive loopback fixture with --serve. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {canonicalJson} from '../src/canonical-json.ts';
import {EMIT_UNPINNED_CREATE_FIELDS} from '../src/create-pin-gate.ts';
import {jobBodyLimit, jobHash, parseCommentsAct, parseMeshEditsAct} from '../src/job-api.ts';
import {JOB_API_SCHEMA, JOB_COMMENTS_ACT_SCHEMA} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const serving = Bun.argv.includes('--serve');
const gateIndex = Bun.argv.indexOf('--gate');
// --serve --gate off serves the real (gate-off) source; the default --serve keeps the gate-on shadow copy.
const servedGate = gateIndex < 0 ? 'on' : Bun.argv[gateIndex + 1];
if (servedGate !== 'on' && servedGate !== 'off') throw new Error('--gate takes on or off');
const outputIndex = Bun.argv.indexOf('--out');
const output = resolve(outputIndex < 0 ? 'artifacts/job-mesh-act-952' : Bun.argv[outputIndex + 1]!);

async function createFixture(largeCapture = false) {
  const fixture = await realJobWindowFixture();
  try {
    const path = join(fixture.input.root, 'out/skeleton.model.json');
    const model = await Bun.file(path).json();
    // Match the editor's crop mapping without mutating the checked-in viewport fixture.
    model.stage.x = -model.stage.width / 2;
    const bone = model.bones.find((item: {name: string}) => item.name === 'mesh');
    bone.y = 24;
    const entry = model.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh.mesh;
    if (largeCapture) {
      // A larger textured mesh makes the real fixed-camera still exceed 256 KiB.
      Object.assign(bone, {x: 0, y: 32});
      entry.vertices.xy = entry.vertices.xy.map((coordinate: number) => coordinate * 2.4);
      const size = 512, png = new PNG({width: size, height: size});
      let seed = 952;
      for (let i = 0; i < png.data.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        png.data[i] = i % 4 === 3 ? 255 : seed & 255;
      }
      const page = model.pages.find((row: {name: string}) => row.name === 'mesh.png');
      Object.assign(page, {width: size, height: size});
      Object.assign(page.regions[0], {width: size, height: size, originalWidth: size, originalHeight: size});
      await writeFile(join(fixture.input.root, 'out/mesh.png'), PNG.sync.write(png));
    }
    await writeFile(path, JSON.stringify(model));
    async function askForRig() {
      const publication = await fixture.publish();
      const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
        requestId: randomUUID(), verb: 'ask', expectedGeneration: fixture.host.session.status().generation,
        idempotencyKey: randomUUID(), publicationId: publication.publicationId,
        subject: {kind: 'review-verdict', stage: 'rig-review'}});
      const result = await response.json();
      assert.equal(result.ok, true, JSON.stringify(result));
      return publication;
    }
    const publication = await askForRig();
    const owner = (language: 'en' | 'ko') => {
      const url = new URL(fixture.host.ownerUrl);
      url.searchParams.set('lang', language);
      return url.href;
    };
    return {...fixture, owner, entry, publication, askForRig, stage: model.stage as {width: number; height: number}};
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

/** Gate off: a verdict with a held mesh draft, and the same steps without the draft (`-baseline`). */
const HELD_MODES = ['held-changes', 'held-changes-baseline', 'held-approve', 'held-approve-baseline'] as const;
type HeldMode = typeof HELD_MODES[number];
const isHeld = (mode: string): mode is HeldMode => (HELD_MODES as readonly string[]).includes(mode);

/** Act bytes with only the per-fixture identities (ids, time, reviewer) replaced, so two runs compare byte for byte. */
function fixtureNeutralAct(raw: string): string {
  const act = JSON.parse(raw) as {actId: string; jobId: string; askId: string; publicationId: string; at: string;
    authority: {reviewer: {id: string}}};
  const identities: [string, string][] = [[act.actId, 'ACT'], [act.jobId, 'JOB'], [act.askId, 'ASK'],
    [act.publicationId, 'PUBLICATION'], [act.at, 'AT'], [act.authority.reviewer.id, 'REVIEWER']];
  return identities.reduce((text, [value, token]) => text.split(JSON.stringify(value)).join(JSON.stringify('<' + token + '>')), raw);
}

async function runBrowser(language: 'en' | 'ko', mode: 'with-comment' | 'mesh-only' | 'gate-off' | 'no-mesh' | 'stale-draft' | HeldMode) {
  const largeCapture = mode === 'mesh-only';
  const held = isHeld(mode), approve = mode === 'held-approve' || mode === 'held-approve-baseline';
  const baseline = mode.endsWith('-baseline');
  const fixture = await createFixture(largeCapture);
  const profile = await mkdtemp(join(tmpdir(), 'review-952-chrome-'));
  const directory = join(output, language, mode === 'stale-draft' ? `stale-draft-${EMIT_UNPINNED_CREATE_FIELDS ? 'open' : 'closed'}` : mode);
  await mkdir(directory, {recursive: true});
  let page: InputCdpSession | undefined;
  try {
    let send: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
    page = await launchCdpSession(profile, {onEvent: (_event, command) => { send = command; }});
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
      throw new Error(expression + ' | ' + await screen.evaluate<string>("document.querySelector('#message')?.textContent ?? ''"));
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
    async function latestAct() {
      const response = await fixture.call({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
        requestId: randomUUID(), verb: 'next', after: null, waitMs: 0});
      const result = await response.json() as import('../src/job-contract.ts').JobResult<import('../src/job-contract.ts').JobNextValue>;
      assert.ok(result.ok);
      const acts = result.value.events.flatMap(event => event.type === 'act' ? [event.act] : []);
      assert.equal(acts.length, 1);
      const raw = fixture.host.session.readActExport(acts[0]!.actId, false).toString();
      assert.equal(raw, JSON.stringify(acts[0]));
      return raw;
    }
    if (mode === 'with-comment' || mode === 'no-mesh' || mode === 'stale-draft' || (held && !approve)) {
      await click(screen, '#stage-comment');
      await pointer('#rig-viewport');
      await wait("!!document.querySelector('.stage-comment-composer input')");
      await screen.evaluate<void>(`(()=>{const form=document.querySelector('.stage-comment-composer');
        form.querySelector('input').value='Adjust the mesh';form.requestSubmit();})()`);
      await wait("!document.querySelector('.stage-comment-composer') && !document.querySelector('#request-changes').disabled");
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
    if (mode !== 'no-mesh') {
      await click(screen, '[data-mode="rig"]');
      await wait("!!document.querySelector('[data-part-list] button[data-slot=mesh]')");
      await click(screen, '[data-part-list] button[data-slot=mesh]');
      await wait("!document.querySelector('#mesh-edit').hidden");
      await click(screen, '#mesh-edit');
      await wait("!document.querySelector('#mesh-editor-bar').hidden");
      assert.equal(await screen.evaluate<boolean>("document.querySelector('#mesh-apply').disabled"), true);
      const catalog = language === 'ko' ? koCatalog : enCatalog;
      const hint = catalog['In a job, press Request changes to send this edit; the producer rebuilds it.'];
      if (mode === 'stale-draft') {
        await wait(`document.querySelector('#mesh-editor-status').innerText.includes(${JSON.stringify(catalog['job.mesh.staleDraft'])})`);
      }
      const text = await screen.evaluate<string>("document.querySelector('#mesh-editor-status').innerText");
      assert.equal(text.includes(hint), Boolean(EMIT_UNPINNED_CREATE_FIELDS));
      assert.ok(!text.includes(catalog['job.submit.JOB_ACT_KIND_DISABLED']));
      if (mode === 'stale-draft') {
        assert.equal(await screen.evaluate<boolean>("document.querySelector('#mesh-undo').disabled"), true);
        await writeFile(join(directory, 'stale-status.json'), JSON.stringify({text}));
      } else {
        await click(screen, '#mesh-mode-create');
        if (!baseline) {
          await pointer('#rig-overlay');
          await wait("document.querySelector('#mesh-edit-draft').value.includes('\"op\":\"add\"')");
          await writeFile(join(directory, 'edited.png'), await screen.screenshot());
        }
      }
    }
    if (mode === 'gate-off') {
      const catalog = language === 'ko' ? koCatalog : enCatalog;
      await wait(`document.querySelector('#mesh-editor-status').innerText.includes(${JSON.stringify(catalog['job.submit.JOB_ACT_KIND_DISABLED'])})`);
      const bar = await screen.evaluate<{text: string; disabled: boolean}>(`({
        text:document.querySelector('#mesh-editor-status').innerText,disabled:document.querySelector('#request-changes').disabled})`);
      assert.equal(bar.disabled, true);
      assert.ok(bar.text.includes(catalog['job.submit.JOB_ACT_KIND_DISABLED']));
      assert.equal(Object.keys(fixture.host.session.status().pending.filter(ask => ask.status === 'answered')).length, 0);
      await writeFile(join(directory, 'refusal.json'), JSON.stringify(bar, null, 2));
    } else if (held) {
      // HQ ruling: with act@8 gated off, a held draft never blocks the verdict; it is not sent and stays in the page.
      const disabled = (language === 'ko' ? koCatalog : enCatalog)['job.submit.JOB_ACT_KIND_DISABLED'];
      const draft = "document.querySelector('#mesh-edit-draft').value";
      const status = "document.querySelector('#mesh-editor-status').innerText";
      if (!baseline) await wait(`${status}.includes(${JSON.stringify(disabled)})`);
      const before = await screen.evaluate<string>(draft);
      assert.equal(before.includes('"op":"add"'), !baseline);
      assert.equal((await screen.evaluate<string>(status)).includes(disabled), !baseline);
      const button = approve ? '#save' : '#request-changes';
      await wait(`!document.querySelector(${JSON.stringify(button)}).disabled`);
      await click(screen, button);
      await wait("document.querySelector('#workspace-act-row').hidden");
      const raw = await latestAct();
      assert.ok(!raw.includes('meshEdits'));
      const act = parseCommentsAct(JSON.parse(raw));
      assert.equal(act.schema, JOB_COMMENTS_ACT_SCHEMA);
      assert.equal(act.kind, 'review-verdict');
      assert.equal(act.value.verdict, approve ? 'approved' : 'changes-requested');
      assert.deepEqual(act.value.comments.map(comment => comment.text), approve ? [] : ['Adjust the mesh']);
      assert.equal(await screen.evaluate<string>(draft), before);
      if (!baseline && await screen.evaluate<boolean>("!document.querySelector('#mesh-editor-bar').hidden")) {
        assert.ok((await screen.evaluate<string>(status)).includes(disabled));
      }
      await writeFile(join(directory, 'act.json'), raw);
      await writeFile(join(directory, 'act-neutral.json'), fixtureNeutralAct(raw));
    } else {
      await wait("!document.querySelector('#request-changes').disabled");
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
      const raw = await latestAct();
      if (mode === 'no-mesh' || mode === 'stale-draft') {
        const act = parseCommentsAct(JSON.parse(raw));
        assert.equal(act.kind, 'review-verdict');
        assert.equal(act.value.comments[0]?.text, 'Adjust the mesh');
      } else {
        const act = parseMeshEditsAct(JSON.parse(raw));
        assert.deepEqual(act.value.comments.map(comment => comment.text), mode === 'with-comment' ? ['Adjust the mesh'] : []);
        assert.equal(act.value.meshEdits?.length, 1);
        const {edit, sha256} = act.value.meshEdits![0]!;
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
          const manifest = await Bun.file(path).json();
          await writeFile(path, JSON.stringify({...manifest, revision: 'same-mesh-next'}));
          const next = await fixture.askForRig();
          assert.notEqual(next.publicationId, fixture.publication.publicationId);
          assert.equal(next.source.model?.sha256, fixture.publication.source.model?.sha256);
          await wait("!!document.querySelector('#save:not([hidden]):not(:disabled)') && !document.querySelector('#workspace-act-row').hidden");
          assert.equal(await screen.evaluate<string>("document.querySelector('#mesh-edit-draft').value"), '');
          assert.equal(await screen.evaluate<boolean>("document.querySelector('#request-changes').disabled"), true);
        }
        await writeFile(join(directory, 'still-size.json'), JSON.stringify({bytes: png.byteLength}));
      }
      await writeFile(join(directory, 'act.json'), raw);
    }
    console.log('MESH_ACT_952_PASS', language, mode);
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

async function runWithFixtureGate() {
  const shadow = await mkdtemp(join(tmpdir(), 'review-952-gate-'));
  try {
    for (const directory of ['src', 'web', 'tests']) {
      await cp(join(repository, directory), join(shadow, directory), {recursive: true});
    }
    await symlink(join(repository, 'node_modules'), join(shadow, 'node_modules'), 'dir');
    await cp(join(repository, 'package.json'), join(shadow, 'package.json'));
    const gate = join(shadow, 'src/create-pin-gate.ts');
    const source = await readFile(gate, 'utf8');
    const off = 'export const EMIT_UNPINNED_CREATE_FIELDS = false;';
    assert.ok(source.includes(off));
    await writeFile(gate, source.replace(off, 'export const EMIT_UNPINNED_CREATE_FIELDS = true;'));
    const child = Bun.spawn([process.execPath, join(shadow, 'tests/job-mesh-act-browser.ts'), '--out', output,
      ...(serving ? ['--serve'] : [])], {cwd: shadow, stdout: 'inherit', stderr: 'inherit'});
    const stop = () => child.kill('SIGINT');
    if (serving) process.on('SIGINT', stop);
    try { assert.equal(await child.exited, 0); }
    finally { if (serving) process.off('SIGINT', stop); }
  } finally {
    await rm(shadow, {recursive: true, force: true});
  }
}

if (serving && (EMIT_UNPINNED_CREATE_FIELDS || servedGate === 'off')) {
  const fixture = await createFixture();
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  process.on('SIGINT', stop);
  try {
    console.log(EMIT_UNPINNED_CREATE_FIELDS ? 'GATE on (act@8 mesh edits are sent)' : 'GATE off (a held mesh draft is not sent)');
    console.log('EN ' + fixture.owner('en'));
    console.log('KO ' + fixture.owner('ko'));
    await stopped;
  } finally {
    try { await fixture.close(); } finally { process.off('SIGINT', stop); }
  }
} else if (EMIT_UNPINNED_CREATE_FIELDS) {
  for (const language of ['en', 'ko'] as const) {
    for (const mode of ['mesh-only', 'with-comment', 'stale-draft'] as const) await runBrowser(language, mode);
  }
} else {
  if (!serving) for (const language of ['en', 'ko'] as const) {
    for (const mode of ['no-mesh', 'gate-off', 'stale-draft', ...HELD_MODES] as const) await runBrowser(language, mode);
    for (const verdict of ['changes', 'approve'] as const) {
      const neutral = (mode: string) => readFile(join(output, language, mode, 'act-neutral.json'), 'utf8');
      assert.equal(await neutral(`held-${verdict}`), await neutral(`held-${verdict}-baseline`),
        `${language} ${verdict}: a held draft changed the act bytes`);
      console.log('MESH_ACT_952_HELD_EQUAL', language, verdict);
    }
  }
  await runWithFixtureGate();
}
