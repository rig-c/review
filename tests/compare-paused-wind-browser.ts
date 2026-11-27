/** #1301. Run from the Review root with --out DIR. Requires Chromium and ffprobe. */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { playBuildConditions } from '../src/build.ts';
import { loadCompare } from '../src/compare.ts';
import { createCompareRequestContext } from '../src/compare-server.ts';
import { breezeAt, type WindReading } from '../src/environment.ts';
import { loadReview } from '../src/manifest.ts';
import { createReviewRequestContext } from '../src/server.ts';
import { PROBE_MP4_BASE64 } from './compare-mode-browser.ts';
import { directionPhysicsModel } from './helpers/direction-playback.ts';
import { instrumentRigMount } from './helpers/mount-probe.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';

const rigProbe = `
window.__wind1301 = () => !persistence || persistence.restoring() || !rebuildStatus || !player?.current ? null : ({
  time, playing, animation: player.current, model: stageModelHash,
  playerTime: player.time, frame: frameAtTime(activeFrameClock(), time),
  wind: wind.read(), vector: player.environment().wind, applied: environmentApplied(),
  vertices: Array.from(parts?.frame('single')?.order.find(part => part.kind === 'mesh')?.vertices ?? []),
});`;
const compareProbe = `
window.__wind1301 = () => {
  const side = pickedTools?.pickedSide(), player = side && players[side];
  if (!ready || !persistence || persistence.restoring() || !player?.current || !referenceFrames) return null;
  const drawn = presentation.snapshot().lastDrawn;
  if (!drawn) return null;
  return {
    time: drawn.reference, playing: !video.paused, animation: player.current,
    model: pickedTools.modelHashFor(side), playerTime: player.time,
    frame: currentReviewFrame(side), decodedFrame: referenceFrameAtTime(referenceFrames, drawn.reference)?.index ?? null,
    source: drawn.source, mode: pickedTools.mode(), side, generation: latestSeek,
    seekMode: seekMode1301, settled: !seeking && !video.seeking && !!trace,
    ...window.__pickedWind1301?.(),
    vertices: Array.from(parts?.frame(side)?.order.find(part => part.kind === 'mesh')?.vertices ?? []),
  };
};`;
const pickedProbe = `
window.__pickedWind1301 = () => ({
  wind: wind.read(), vector: currentPlayer()?.environment().wind, applied: environmentApplied(),
});`;

function insertBefore(source: string, anchor: string, probe: string) {
  if (source.split(anchor).length !== 2) throw new Error(`Probe anchor missing or ambiguous: ${anchor}`);
  return source.replace(anchor, `${probe}\n${anchor}`);
}

async function buildInstrumentedWeb() {
  const result = await Bun.build({
    entrypoints: ['web/main.ts'], target: 'browser', format: 'esm', conditions: playBuildConditions(),
    plugins: [{ name: 'observe-paused-wind', setup(build) {
      build.onLoad({ filter: /\/web\/(main|compare|compare-picked-tools)\.ts$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        if (path.endsWith('/main.ts')) source = instrumentRigMount(source, rigProbe);
        else if (path.endsWith('/compare.ts')) {
          source = insertBefore(source, 'const inspected=presentation.inspect(', 'seekMode1301 = seekMode;');
          source = insertBefore(source, '\nvoid start();', `let seekMode1301 = null;\n${compareProbe}`);
        } else {
          source = insertBefore(source, '  return {\n    mode: () => workspaceMode,', pickedProbe);
        }
        return { loader: 'ts', contents: source };
      });
    } }],
  });
  if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(log => log.message).join('\n'));
  return result.outputs[0];
}

type Reading = {
  time: number; playerTime: number; frame: number | null; playing: boolean;
  animation: string; model: string; wind: WindReading; vector: [number, number]; applied: boolean;
  vertices: number[];
  mode?: string; side?: string; generation?: number; settled?: boolean; seekMode?: string;
  decodedFrame?: number | null; source?: string;
};
type Surface = 'compare' | 'rig';
const epsilon = 1e-9;
const target = 0.76;
const historicPause = 0.26;
const read = 'window.__wind1301?.()';

function requireSample(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

async function waitFor(page: InputCdpSession, label: string, condition: string): Promise<Reading> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await page.evaluate<Reading | null>(`(() => {const r = ${read}; return r && (${condition}) ? r : null;})()`);
    if (value) return value;
    await Bun.sleep(25);
  }
  const state = await page.evaluate(`({reading:${read}, message:document.querySelector('#message')?.textContent,
    frameIndex:document.querySelector('#frame-index-status')?.textContent})`);
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
}

function serve(context: Awaited<ReturnType<typeof createReviewRequestContext>>) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
    async fetch(request, listener) { return await context.handle(request, listener.port, listener) as Response; },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop() { context.stop(); server.stop(true); } };
}

function validate(reading: Reading, model: string) {
  requireSample(reading.applied && reading.wind?.breeze && !reading.wind.repeat, 'Breeze must be the applied world');
  requireSample(reading.model === model && reading.animation === 'inspect', 'Unexpected stage model or animation');
  requireSample([reading.time, reading.playerTime, reading.wind.time, ...reading.vector].every(Number.isFinite), 'Clock or vector missing');
  requireSample(reading.vertices.length > 0 && reading.vertices.every(Number.isFinite), 'No drawn fixture mesh');
}

async function run(out: string) {
  const report = {
    issue: 1301, requestedCompareTime: target, status: 'harness-error', errors: [] as string[],
    mismatches: [] as string[], browserExceptions: [] as unknown[], fixture: {} as Record<string, string>,
    cases: {} as Record<string, { initial: Reading; playback?: Reading; beforeSeek?: Reading; final?: Reading; capture?: string }>,
    deltas: {} as Record<string, { clock: number; vector: number; maxVertexComponent: number }>,
  };
  let root: string | undefined;
  let page: InputCdpSession | undefined;
  const servers: ReturnType<typeof serve>[] = [];
  try {
    root = await mkdtemp(join(tmpdir(), 'compare-paused-wind-1301-'));
    const pkg = join(root, 'package'), reference = join(root, 'reference.mp4');
    await mkdir(pkg);
    await Promise.all([
      writeFile(join(pkg, 'skeleton.model.json'), JSON.stringify(await directionPhysicsModel())),
      copyFile('tests/fixtures/strip-probe/build/mesh.png', join(pkg, 'mesh.png')),
      writeFile(reference, Buffer.from(PROBE_MP4_BASE64, 'base64')),
      writeFile(join(pkg, 'review.json'), JSON.stringify({
        schema: 'rig-review/1', id: 'paused-wind-1301', title: 'Paused wind fixture', revision: '1',
        model: 'skeleton.model.json', report: 'report.json', animations: [{ id: 'inspect', label: 'Inspect' }],
      })),
      writeFile(join(pkg, 'report.json'), JSON.stringify({
        spec: 'rig-pose-report/1', animation: 'inspect', frameTimes: Array.from({ length: 48 }, (_, frame) => frame / 24),
      })),
    ]);
    const [bundle, rig, compare] = await Promise.all([
      buildInstrumentedWeb(), loadReview(pkg), loadCompare({ a: pkg, b: pkg, reference, animation: 'inspect' }),
    ]);
    const model = rig.reviewedSource.rig?.sha256;
    requireSample(model, 'Fixture has no bound model');
    report.fixture = { model, package: rig.sourceHash, reference: compare.response.reference.sha256 };
    page = await launchCdpSession(join(root, 'profile'), {
      sendDeadlineMs: 30_000, browserArgs: ['--renderer-process-limit=2'],
      onEvent(event) { if (event.method === 'Runtime.exceptionThrown') report.browserExceptions.push(event.params); },
    });
    await page.setViewport(1440, 900);

    async function sample(surface: Surface, historic: boolean, baseline?: Reading): Promise<Reading> {
      const browser = page!;
      const name = `${surface}-${historic ? 'history' : 'fresh'}`;
      // Each case gets a separate origin and state directory, so draft restoration cannot seed it.
      const options = { bundle, stateDir: join(root!, name) };
      const context = surface === 'compare'
        ? await createCompareRequestContext(compare, options)
        : await createReviewRequestContext(rig, { ...options, initialAnimation: 'inspect', viewOnly: true });
      const server = serve(context);
      servers.push(server);
      await browser.goto(server.url);
      const isCompare = surface === 'compare';
      const ready = '!r.playing && !document.querySelector("#play").disabled';
      await waitFor(browser, `${name} mount`, `${ready} ${isCompare ? '&& r.settled && r.decodedFrame === 0' : ''}`);
      await browser.evaluate(`document.querySelector('.mode-switch [data-mode="playback"]').click()`);
      await browser.evaluate(`(() => {
        const breeze = document.getElementById('wind-breeze');
        if (breeze.disabled) throw Error('Breeze control disabled');
        breeze.checked = true;
        breeze.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const initial = await waitFor(browser, `${name} world`, `${ready} && r.applied && r.wind?.breeze ${isCompare ? '&& r.mode === "animate" && r.side === "a" && r.settled' : ''}`);
      const evidence: (typeof report.cases)[string] = { initial };
      report.cases[name] = evidence;
      validate(initial, model!);
      requireSample(initial.time === 0 && initial.wind.time === 0, `${name} did not start at a fresh clock`);
      let before = initial;
      if (historic) {
        await browser.evaluate(`document.getElementById('play').click()`);
        evidence.playback = await waitFor(browser, `${name} playback`, `r.playing && r.time >= ${historicPause} && r.wind.time >= 0.20`);
        await browser.evaluate(`document.getElementById('play').click()`);
        before = await waitFor(browser, `${name} pause`, `${ready} ${isCompare ? '&& r.settled' : ''}`);
        requireSample(before.time > 0.2 && before.wind.time > 0.2 && (baseline?.time ?? target) - before.playerTime > 0.25,
          `${name} needs a stepped history more than 0.25 s before the target: ${JSON.stringify(before)}`);
      }
      evidence.beforeSeek = before;

      if (isCompare) {
        await browser.evaluate(`(() => {
          document.getElementById('time-input').value = ${JSON.stringify(String(target))};
          document.getElementById('seek').click();
        })()`);
      } else {
        requireSample(baseline?.decodedFrame != null, 'Missing decoded Compare frame for Rig seek');
        await browser.evaluate(`(() => {
          const scrub = document.getElementById('scrub');
          scrub.value = ${JSON.stringify(String(baseline.time))};
          scrub.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      }
      const done = isCompare
        ? `${ready} && r.settled && r.generation > ${before.generation} && r.time > 0.6`
        : `${ready} && r.time > 0.6`;
      const final = evidence.final = await waitFor(browser, `${name} explicit seek`, done);
      validate(final, model!);
      requireSample(Math.abs(final.playerTime - final.time) <= epsilon, `${name} has no synchronized drawn frame`);
      if (isCompare) requireSample(final.seekMode === 'seek' && final.source === 'video-frame' && final.decodedFrame != null,
        `${name} did not take the decoded, non-settle seek path`);
      if (baseline) requireSample(Math.abs(final.time - baseline.time) <= epsilon &&
        (!isCompare || final.decodedFrame === baseline.decodedFrame), `${name} did not draw the same frame as Compare fresh`);
      const capture = `${name}.png`;
      await writeFile(join(out, capture), await browser.screenshot());
      evidence.capture = capture;
      const held = await browser.evaluate<Reading>(read);
      requireSample(!held.playing && held.time === final.time && held.playerTime === final.playerTime && held.wind.time === final.wind.time,
        `${name} moved while capturing the paused frame`);
      return final;
    }

    const compareFresh = await sample('compare', false);
    const compareHistory = await sample('compare', true, compareFresh);
    const rigFresh = await sample('rig', false, compareFresh);
    const rigHistory = await sample('rig', true, compareFresh);
    requireSample(Math.abs(breezeAt(compareFresh.time)) > 0.1, 'Target does not exercise a nontrivial Breeze vector');
    requireSample(report.browserExceptions.length === 0, 'Unhandled browser exception; see browserExceptions');

    for (const [name, reading] of Object.entries({ compareFresh, compareHistory, rigFresh, rigHistory })) {
      const expectedX = reading.wind.base + breezeAt(reading.time);
      if (Math.abs(reading.wind.time - reading.time) > epsilon) report.mismatches.push(`${name}: wind clock ${reading.wind.time}, expected ${reading.time}`);
      if (Math.hypot(reading.vector[0] - expectedX, reading.vector[1]) > epsilon) {
        report.mismatches.push(`${name}: player wind [${reading.vector}], expected [${expectedX},0]`);
      }
    }
    for (const [surface, fresh, history] of [['compare', compareFresh, compareHistory], ['rig', rigFresh, rigHistory]] as const) {
      requireSample(fresh.vertices.length === history.vertices.length, `${surface}: inconsistent fixture mesh`);
      const clock = Math.abs(fresh.wind.time - history.wind.time);
      const vector = Math.hypot(fresh.vector[0] - history.vector[0], fresh.vector[1] - history.vector[1]);
      const maxVertexComponent = Math.max(...fresh.vertices.map((value, index) => Math.abs(value - history.vertices[index]!)));
      report.deltas[surface] = { clock, vector, maxVertexComponent };
      if (clock > epsilon || vector > epsilon) report.mismatches.push(`${surface}: same-frame history delta, clock ${clock}, wind vector ${vector}`);
    }
    report.status = report.mismatches.length ? 'mismatch' : 'pass';
  } catch (error) {
    report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => { await page?.close(); })(),
      ...servers.map(server => (async () => server.stop())()),
    ]);
    if (root) cleanup.push(...await Promise.allSettled([rm(root, { recursive: true, force: true })]));
    for (const result of cleanup) if (result.status === 'rejected') report.errors.push(String(result.reason));
    if (report.errors.length) report.status = 'harness-error';
  }
  return report;
}

if (import.meta.main) {
  // Exit 1 is a measured mismatch. Exit 2 is a harness failure.
  try {
    const index = Bun.argv.indexOf('--out'), directory = Bun.argv[index + 1];
    if (index < 0 || !directory || directory.startsWith('--')) throw new Error('Usage: bun tests/compare-paused-wind-browser.ts --out DIR');
    const out = resolve(directory);
    await mkdir(out, { recursive: true });
    const report = await run(out), path = join(out, 'report.json');
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'harness-error') { console.error('HARNESS_ERROR', path, ...report.errors); process.exitCode = 2; }
    else if (report.status === 'mismatch') {
      console.error('MISMATCH', path, ...report.mismatches);
      process.exitCode = 1;
    } else console.log('PASS', path);
  } catch (error) {
    console.error('HARNESS_ERROR', error);
    process.exitCode = 2;
  }
}
