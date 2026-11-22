/** #1074. Run on ordinary Nova with a generated public physics fixture. */
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {playBuildConditions} from '../src/build.ts';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {directionPhysicsModel} from './helpers/direction-playback.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';

const probe = `
Object.assign(window, {readAnimationSelection: () => player?.current && ({
 name: player.current, time, playerTime: player.time, playing,
 loop: player.entry(0)?.loop,
 wind: player.readPhysicsParameters('probe_physics').effective?.wind ?? null
})});
`;
const bundle = await Bun.build({
 entrypoints: ['web/main.ts'], target: 'browser', format: 'esm', conditions: playBuildConditions(),
 plugins: [{name: 'animation-selection-readback', setup(build) {
  build.onLoad({filter: /web\/main\.ts$/}, async ({path}) => ({
   loader: 'ts', contents: instrumentRigMount(await readFile(path, 'utf8'), probe),
  }));
 }}],
});
assert.ok(bundle.success, JSON.stringify(bundle.logs));

const root = await mkdtemp(join(tmpdir(), 'animation-selection-'));
const pkg = join(root, 'package');
const outFlag = Bun.argv.indexOf('--out');
const output = resolve(outFlag < 0 ? 'artifacts/animation-selection' : Bun.argv[outFlag + 1]!);
let closeServer: (() => void) | undefined;
let page: Awaited<ReturnType<typeof launchCdpSession>> | undefined;
interface Sample {
 name: string;
 time: number;
 playerTime: number;
 playing: boolean;
 loop: boolean;
 wind: number | null;
}

try {
 await mkdir(pkg);
 const model = await directionPhysicsModel();
 const idle = {...model.animations[0], name: 'idle'};
 const wind = {
  ...idle, name: 'wind', duration: 6, bones: [],
  constraints: {...idle.constraints, physics: [{name: 'probe_physics', timelines: [{
   name: 'wind', keys: [{time: 0, value: -3}, {time: 3, value: 3}, {time: 6, value: -3}],
  }]}]},
 };
 model.animations = [idle, wind];
 await writeFile(join(pkg, 'skeleton.model.json'), JSON.stringify(model));
 await copyFile('tests/fixtures/strip-probe/build/mesh.png', join(pkg, 'mesh.png'));
 await writeFile(join(pkg, 'review.json'), JSON.stringify({
  schema: 'rig-review/1', id: 'animation-selection', title: 'Animation selection', revision: '1',
  model: 'skeleton.model.json', animations: [{id: 'idle', label: 'Idle'}, {id: 'wind', label: 'Wind'}],
 }));
 const context = await createReviewRequestContext(await loadReview(pkg), {
  bundle: bundle.outputs[0]!, viewOnly: true, stateDir: join(root, 'state'),
 });
 const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
  async fetch(request, server) {
   return (await context.handle(request, server.port, server))!;
  },
 });
 closeServer = () => {context.stop(); server.stop(true);};
 page = await launchCdpSession(join(root, 'browser'), {browserArgs: ['--renderer-process-limit=2']});
 await page.goto(`http://127.0.0.1:${server.port}/`);
 const browser = page;
 const read = () => browser.evaluate<Sample | null>('window.readAnimationSelection?.() ?? null');
 const waitFor = async (label: string, predicate: (state: Sample) => boolean) => {
  const until = Date.now() + 18000;
  while (Date.now() < until) {
   const sample = await read();
   if (sample && predicate(sample)) return sample;
   await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await read())}`);
 };
 const select = (name: 'idle' | 'wind') => browser.evaluate<Sample>(`(() => {
  const select = document.querySelector('#animation-select');
  select.value = ${JSON.stringify(name)};
  select.dispatchEvent(new Event('change', {bubbles: true}));
  return window.readAnimationSelection();
 })()`);
 const play = () => browser.evaluate("document.querySelector('#play').click()");

 const opening = await waitFor('auto-playing idle', s => s.name === 'idle' && s.playing && s.time > 0);
 await browser.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
 const selected = await select('wind');
 // Collect the one-shot endpoint even against a baseline that requires an extra Play click.
 if (!selected.playing) await play();
 const midpoint = await waitFor('wind midpoint', s => s.name === 'wind' && s.time >= 3 && s.time < 4);
 const end = await waitFor('wind stops at 6s', s => s.name === 'wind' && !s.playing && s.time === 6);
 await Bun.sleep(250);
 const afterEnd = await read();

 const idleAfterEnd = await select('idle');
 if (!idleAfterEnd.playing) await play();
 await waitFor('manual idle playback', s => s.name === 'idle' && s.playing && s.time > 0);
 await play();
 const pausedWind = await select('wind');
 await Bun.sleep(250);
 const afterPause = await read();
 const pausedIdle = await select('idle');

 const result = {opening, selected, midpoint, end, afterEnd, idleAfterEnd, pausedWind, afterPause, pausedIdle};
 await mkdir(output, {recursive: true});
 await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
 console.log('ANIMATION_SELECTION_1074', JSON.stringify(result));

 const atRest = (s: Sample | null) => s !== null && !s.playing && s.time === 0 && s.playerTime === 0;
 assert.deepEqual({
  resumesFromZero: selected.playing && selected.time === 0 && selected.playerTime === 0,
  signedPhysics: selected.wind === -3 && midpoint.wind !== null && midpoint.wind > 0 && end.wind === -3,
  oneShot: !selected.loop && !end.loop && end.playerTime === 6 && afterEnd?.time === 6 && !afterEnd.playing,
  pausedWind: atRest(pausedWind) && atRest(afterPause),
  pausedIdle: atRest(idleAfterEnd) && atRest(pausedIdle),
 }, {resumesFromZero: true, signedPhysics: true, oneShot: true, pausedWind: true, pausedIdle: true});
} finally {
 await page?.close();
 closeServer?.();
 assert.ok(root.startsWith(join(tmpdir(), 'animation-selection-')));
 await rm(root, {recursive: true, force: true});
}
