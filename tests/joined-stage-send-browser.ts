/** #1318. Run with the ordinary Nova Chromium pool. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {loadOpenPackage} from '../src/open.ts';
import {parseOpenInputs} from '../src/cli.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const output = Bun.argv[2] ?? 'artifacts/joined-stage-send';
const scratch = await mkdtemp(join(tmpdir(), 'review-1318-'));
const controls = ['save', 'request-changes', 'send-comments'] as const;
type Control = typeof controls[number];
type ButtonState = {id: Control; visible: boolean; disabled: boolean; text: string};
type WireRequest = {requestId: string; method: string; path: string; kind?: string; status?: number};
const observations: unknown[] = [];
const buttonStates = `(${JSON.stringify(controls)}).map(id=>{
  const button=document.getElementById(id);
  return {id,visible:!!button?.checkVisibility({visibilityProperty:true}),disabled:button?.disabled??true,text:button?.textContent.trim()??''};
})`;

async function wait(page: InputCdpSession, expression: string) {
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate<boolean>(expression)) return;
    await Bun.sleep(100);
  }
  throw Error('JOINED_SEND_WAIT: ' + expression);
}

async function compose(page: InputCdpSession, pin: boolean, parts: boolean) {
  if (pin) {
    await click(page, '#stage-comment');
    const points = await page.evaluate<{x: number; y: number}[]>(`(()=>{
      const canvas=document.getElementById('${parts ? 'parts-canvas' : 'rig-viewport'}');
      const rect=canvas.getBoundingClientRect();
      const points=${parts ? '[[8.25,5.25],[12.75,8.75]]' : '[[.54,.49],[.54,.49]]'};
      return points.map(([x,y])=>({x:rect.left+x*rect.width/${parts ? 'canvas.width' : '1'},y:rect.top+y*rect.height/${parts ? 'canvas.height' : '1'}}));
    })()`);
    const [from, to] = points;
    await page.mouse('mouseMoved', from!.x, from!.y);
    await page.mouse('mousePressed', from!.x, from!.y);
    await page.mouse('mouseMoved', to!.x, to!.y);
    await page.mouse('mouseReleased', to!.x, to!.y);
  } else {
    if (!await page.evaluate<boolean>("!!document.querySelector('[data-comment-general]')?.checkVisibility()")) {
      await click(page, '#stage-comment');
    }
    await wait(page, "!!document.querySelector('[data-comment-general]')?.checkVisibility()");
    await page.evaluate(`document.querySelector('[data-comment-general]').scrollIntoView({block:'nearest'})`);
    await click(page, '[data-comment-general]');
  }
  await wait(page, "!!document.querySelector('.stage-comment-composer input')");
  await page.evaluate(`(()=>{
    const form=document.querySelector('.stage-comment-composer');
    form.querySelector('input').value='Public fixture comment for #1318';
    form.requestSubmit();
  })()`);
  await wait(page, "!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-summary').length>0");
  await closeDrawer(page);
}

async function closeDrawer(page: InputCdpSession) {
  if (await page.evaluate<boolean>('!!document.querySelector("dialog.workspace-drawer[open]")')) {
    await click(page, 'dialog.workspace-drawer[open] .workspace-drawer-close');
  }
}

const verdictWrite = (request: WireRequest) => request.method === 'POST' && new URL(request.path, 'http://fixture.invalid').pathname.endsWith('/api/stage-parts/verdict');

async function witness(name: string, url: string, action: Control | null, expected: string, parts = false) {
  const requests: WireRequest[] = [];
  let enableNetwork: (() => Promise<unknown>) | undefined;
  const page = await launchCdpSession(join(scratch, name), {onEvent(event, send) {
    if (event.sessionId && !enableNetwork) {
      const command = send as (method: string, params: object, sessionId: string) => Promise<unknown>;
      enableNetwork = () => command('Network.enable', {}, event.sessionId!);
    }
    if (event.method === 'Network.requestWillBeSent') {
      const {requestId, request} = event.params as {requestId: string; request: {method: string; url: string; postData?: string}};
      const path = new URL(request.url);
      let kind: string | undefined;
      if (request.postData) {
        try {kind = JSON.parse(request.postData).kind;} catch { /* The wire may carry other formats. */ }
      }
      requests.push({requestId, method: request.method, path: path.pathname + path.search, kind});
    }
    if (event.method === 'Network.responseReceived') {
      const {requestId, response} = event.params as {requestId: string; response: {status: number}};
      const request = requests.findLast(row => row.requestId === requestId);
      if (request) request.status = response.status;
    }
  }});
  try {
    assert.ok(enableNetwork);
    await enableNetwork();
    await page.setViewport(1440, 900);
    await page.goto(url, 'en');
    const local = expected === '/api/session';
    await wait(page, local
      ? '!!document.getElementById("stage-comment-list") && !!document.getElementById("package-title").textContent.trim()'
      : 'document.body.dataset.ready==="true" && !document.body.inert');
    await closeDrawer(page);
    if (action === null) {
      const stage = await page.evaluate<{status: number; readOnly: boolean; binding?: string}>(`(async()=>{
        const response=await fetch('/api/stage-parts');
        const data=await response.json();
        return {status:response.status,readOnly:data.readOnly,binding:data.joinedVerdictBinding};
      })()`);
      assert.equal(stage.status, 200);
      assert.equal(stage.readOnly, false);
      assert.match(stage.binding ?? '', /^[a-f0-9]{64}$/);
      const before = await page.evaluate<ButtonState[]>(buttonStates);
      assert.ok(before.every(button => !button.visible), 'local joined draft hides all verdict and send controls');
      const observation = {name, action, before, stage, wire: [], hitsJoinedVerdict: false};
      observations.push(observation);
      await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
      console.log('JOINED_SEND', JSON.stringify(observation));
      return;
    }
    await wait(page, `document.getElementById('${action}')?.checkVisibility()`);
    const before = await page.evaluate<ButtonState[]>(buttonStates);
    if (action !== 'save') await compose(page, action === 'request-changes', parts);
    await wait(page, `!document.getElementById('${action}').disabled`);
    const atClick = await page.evaluate<ButtonState[]>(buttonStates);
    const screen = await page.screenshot();
    const start = requests.length;
    await click(page, '#' + action);
    const until = Date.now() + 10000;
    while (Date.now() < until && !requests.slice(start).some(row =>
      ((row.method === (expected === '/api/session' ? 'PUT' : 'POST') && row.path.endsWith(expected)) || verdictWrite(row)) && row.status !== undefined)) await Bun.sleep(50);
    await Bun.sleep(1250);
    const wire = requests.slice(start);
    const hitsJoinedVerdict = wire.some(verdictWrite);
    const observation = {name, action, before, atClick, stagePartsBeforeClick: requests.slice(0, start).filter(row => row.path.includes('/stage-parts')), wire, hitsJoinedVerdict};
    observations.push(observation);
    await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    console.log('JOINED_SEND', JSON.stringify(observation));
    if (hitsJoinedVerdict) {
      await writeFile(join(output, name + '.png'), screen);
      throw Error('JOINED_SEND_VISIBLE_CALLER: ' + name);
    }
    assert.ok(wire.some(row => row.method === (expected === '/api/session' ? 'PUT' : 'POST') && row.path.endsWith(expected) && row.status === 200), name + ': successful submission');
  } catch (error) {
    await writeFile(join(output, name + '-screen.txt'), await page.evaluate<string>('document.body.innerText'));
    throw error;
  } finally {
    await page.close();
  }
}

async function live(stage: 'parts' | 'rig' | 'direction', action: Control, pending = true) {
  const fixture = await scriptedJobWindowFixture({c5Parts: 'mesh', scratchParent: scratch});
  try {
    const publication = await fixture.publish(stage);
    if (pending) await fixture.ask(publication, stage === 'parts' ? {kind: 'parts-verdict', draftId: 'synthetic-parts'}
      : {kind: 'review-verdict', stage: stage === 'rig' ? 'rig-review' : 'direction-review'});
    await witness(stage + '-' + action + (pending ? '' : '-no-ask'), fixture.host.ownerUrl, action, '/ui/acts', stage === 'parts');
  } finally {
    await fixture.close();
  }
}

try {
  await mkdir(output, {recursive: true});
  for (const stage of ['parts', 'rig', 'direction'] as const) {
    for (const action of controls) await live(stage, action);
  }
  await live('parts', 'send-comments', false);
  for (const picture of ['parts', true] as const) {
    const fixture = await recordScreenFixture('option-set', picture);
    try {
      await witness('record-' + (picture === true ? 'rig' : picture), fixture.ownerUrl, 'send-comments', '/ui/acts');
    } finally {
      await fixture.close();
    }
  }
  const root = join(scratch, 'project');
  await mkdir(root);
  const extract = Bun.spawnSync(['tar', '-xzf', join(import.meta.dir, 'fixtures/create-reopened-v2/project.tar.gz'), '-C', root]);
  assert.equal(extract.exitCode, 0, extract.stderr.toString());
  await mkdir(join(root, 'reviewer-picks'));
  const opened = await loadOpenPackage(parseOpenInputs([join(root, 'derived/review/v2/out'),
    '--project', root, '--project-version', '2', '--picks-dir', 'reviewer-picks']));
  assert.ok(opened.mode === 'single' && opened.joined);
  for (const action of ['save', 'request-changes'] as const) {
    const capability = 'b'.repeat(64);
    const server = await startServer(opened.p, {port: 0, joined: opened.joined, capability, stateDir: join(scratch, 'local-state-' + action)});
    try {
      await witness('local-joined-' + action, 'http://127.0.0.1:' + server.port + '/#cap=' + capability, action, '/api/session');
    } finally {
      server.stop(true);
    }
  }
  const draft = await joinedVerdictFixture(join(scratch, 'editable-draft'));
  const capability = 'b'.repeat(64);
  const server = await startServer(draft.p, {port: 0, joined: draft.joined, capability, stateDir: join(scratch, 'draft-state')});
  try {
    await witness('local-editable-joined-draft', 'http://127.0.0.1:' + server.port + '/#cap=' + capability, null, '/api/session');
    await draft.assertFixture();
  } finally {
    server.stop(true);
  }
  console.log('JOINED_SEND_PASS', observations.length);
} finally {
  await rm(scratch, {recursive: true, force: true});
}
