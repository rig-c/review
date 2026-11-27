/**
 * Review #1306. Run from the Review root on the measurement host:
 * bun scripts/measure-compare-frame-1306.ts --fixture PATH --reference PATH --out DIR
 * Primary input: the family/luna Review package and a local reference covering idle (#361).
 * The default window is 10 seconds after warmup, DPR 2, five interleaved rounds.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appRoot, playBuildConditions } from '../src/build.ts';
import { instrumentRigMount } from '../tests/helpers/mount-probe.ts';
import type { createReviewRequestContext } from '../src/server.ts';
import type { InputCdpSession } from '../tests/parts-explorer-browser.ts';

const metrics = ['renderEnvironment', 'renderSchedule', 'worldFor', 'applyEnvironment', 'clipDuration fallback'] as const;
const arms = ['Rig Animate', 'Compare Animate', 'Compare default'] as const;
type Arm = typeof arms[number];
type Frame = {
  atMs: number; clipTime: number; frameMs: number; unionMs: number;
  inclusiveMs: number[]; calls: number[]; durationCalls: number; steps: number;
  presentedFrames: number | null;
};
type Capture = {
  elapsedMs: number; frames: Frame[]; outsideCalls: number[]; outsideDurationCalls: number;
  clockProbeMs: number[]; violations: string[];
};
type State = {
  ready: boolean; playing: boolean; mode: string; playEnabled: boolean; hidden: boolean;
  animation: string; playerClips: string[]; models: string[]; packages: string[];
  reference: string; referenceReady: boolean; decoded: boolean; referenceDuration: number;
  rendererKinds: string[]; time: number; duration: number; assetDurations: number[];
  side: string; applied: boolean; useWorld: boolean; settings: { breeze: boolean };
  gravity: number; world: string | null; dpr: number; viewport: number[]; browser: string;
};

// Serialized into the ephemeral bundle. Keep this function independent of the host module.
function installProbe(metricCount: number) {
  let active = false, captureStart = 0, frameStart = 0, depth = 0;
  let frame: Frame | null = null;
  let frames: Frame[] = [], outsideCalls: number[] = [], outsideDurationCalls = 0;
  let violations: string[] = [];
  function enter(metric: number) {
    if (!frame) {
      if (active) outsideCalls[metric]!++;
      return -1;
    }
    frame.calls[metric]!++;
    depth++;
    return performance.now();
  }
  function leave(metric: number, start: number) {
    if (start < 0) return;
    const elapsed = performance.now() - start;
    if (!frame || depth === 0) throw Error('FRAME1306_UNBALANCED_INTERVAL');
    frame.inclusiveMs[metric]! += elapsed;
    if (--depth === 0) frame.unionMs += elapsed;
  }
  return {
    state: null as (() => State | null) | null,
    environment: null as (() => unknown) | null,
    togglePlayback: null as (() => void) | null,
    enter, leave,
    fallback(read: () => number) {
      const start = enter(4);
      try { return read(); } finally { leave(4, start); }
    },
    duration() {
      if (frame) frame.durationCalls++;
      else if (active) outsideDurationCalls++;
    },
    step() { if (frame) frame.steps++; },
    begin() {
      if (!active) return false;
      if (frame || depth !== 0) throw Error('FRAME1306_REENTRANT_FRAME');
      frame = {
        atMs: performance.now() - captureStart, clipTime: 0, frameMs: 0, unionMs: 0,
        inclusiveMs: Array(metricCount).fill(0), calls: Array(metricCount).fill(0), durationCalls: 0, steps: 0,
        presentedFrames: null,
      };
      frameStart = performance.now();
      return true;
    },
    end(measured: boolean, clipTime: number, presentedFrames: number | null = null) {
      if (!measured) return;
      const elapsed = performance.now() - frameStart;
      if (!frame || depth !== 0) throw Error('FRAME1306_FRAME_SCOPE');
      frame.frameMs = elapsed;
      frame.clipTime = clipTime;
      frame.presentedFrames = presentedFrames;
      if (document.hidden) violations.push('Document hidden during a sampled callback');
      frames.push(frame);
      frame = null;
    },
    sample(ms: number): Promise<Capture> {
      if (active) throw Error('FRAME1306_OVERLAPPING_CAPTURE');
      const clockProbeMs = Array.from({ length: 256 }, () => {
        const start = performance.now();
        return performance.now() - start;
      });
      frames = [];
      outsideCalls = Array(metricCount).fill(0);
      outsideDurationCalls = 0;
      violations = [];
      captureStart = performance.now();
      active = true;
      return new Promise(resolve => setTimeout(() => {
        active = false;
        resolve({ elapsedMs: performance.now() - captureStart, frames, outsideCalls, outsideDurationCalls, clockProbeMs, violations });
      }, ms));
    },
  };
}

const probe = 'globalThis.__reviewFrame1306';
const commonState = `playEnabled: !button('play').disabled, hidden: document.hidden, dpr: devicePixelRatio,
  viewport: [innerWidth, innerHeight], browser: navigator.userAgent`;
const rendererKind = `renderer => renderer instanceof CanvasRenderer
  ? 'canvas/' + renderer.backendActive : renderer ? 'dom/' + renderer.meshBackendActive : null`;
const shownWorld = `el('environment-schedule').textContent`;
const rigState = `
${probe}.togglePlayback = () => button('play').click();
${probe}.state = () => {
  if (!ready1306 || !data || !player?.current || !persistence || !video) return null;
  const rendererKind1306 = ${rendererKind};
  return { ready: !persistence.restoring() && !seekingControl && !video.seeking, playing,
    mode: selectedInspector(document), animation, playerClips: [player.current],
    models: [stageModelHash], packages: [data.referenceBinding?.packageSourceHash],
    reference: data.explicitReference?.sha256, referenceReady: referenceInput.state === 'loaded' && video.readyState >= 2,
    decoded: typeof video.requestVideoFrameCallback === 'function', referenceDuration: video.duration,
    rendererKinds: [rendererKind1306(player.renderer)], time, duration, assetDurations: [assets?.animations.find(item => item.name === animation)?.duration],
    side: 'rig', applied: environmentApplied(), useWorld: useWorld(), settings: wind.snapshot(), gravity: gravityValue(),
    world: ${shownWorld}, ${commonState} };
};`;
const compareState = `
${probe}.togglePlayback = () => button('play').click();
${probe}.state = () => {
  if (!ready1306 || !ready || !domain || !pickedTools || !persistence || !players.a?.current || !players.b?.current) return null;
  const mode = pickedTools.mode();
  const rendererKind1306 = ${rendererKind};
  return { ready: !persistence.restoring() && !seeking && !loopRestarting && !video.seeking,
    playing: !video.paused, mode, animation: data.animation, playerClips: [players.a.current, players.b.current],
    models: [pickedTools.modelHashFor('a'), pickedTools.modelHashFor('b')], packages: [data.a.sourceHash, data.b.sourceHash],
    reference: data.reference.sha256, referenceReady: video.readyState >= 2,
    decoded: !!referenceFrames && lastPresented?.source === 'video-frame', referenceDuration: video.duration,
    rendererKinds: [rendererKind1306(players.a.renderer), rendererKind1306(players.b.renderer)],
    time: lastPresented?.time ?? 0, duration: domain.end, assetDurations: ['a','b'].map(side => assets[side]?.animations.find(item => item.name === data.animation)?.duration),
    side: pickedTools.pickedSide(), ...${probe}.environment(), world: mode === 'animate' ? ${shownWorld} : null,
    ${commonState} };
};`;
const compareEnvironment = `
${probe}.environment = () => ({
  applied: environmentApplied(), useWorld: useWorld(), settings: wind.snapshot(), gravity: gravityValue(),
});`;

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  requireCheck(source.split(anchor).length === 2, `FRAME1306_ANCHOR: ${anchor}`);
  return source.replace(anchor, () => replacement);
}

function before(source: string, anchor: string, snippet: string): string {
  return replaceOnce(source, anchor, snippet + '\n' + anchor);
}

function timeFunction(source: string, declaration: string, close: string, metric: number): string {
  requireCheck(source.split(declaration).length === 2, `FRAME1306_FUNCTION: ${declaration}`);
  const start = source.indexOf(declaration) + declaration.length;
  const end = source.indexOf(close, start);
  requireCheck(end > start, `FRAME1306_FUNCTION_END: ${declaration}`);
  return source.slice(0, start) + `const sample1306 = ${probe}.enter(${metric}); try {`
    + source.slice(start, end) + `} finally { ${probe}.leave(${metric}, sample1306); }` + source.slice(end);
}

function instrument(file: string, source: string): string {
  if (file === 'main.ts') {
    source = instrumentRigMount(source, rigState);
    source = replaceOnce(source, 'void start();', 'let ready1306 = false; void start().then(() => { ready1306 = true; });');
    source = replaceOnce(source,
      "if (playing) try { holdScrubBox(input('scrub')); tickPlaying(now,!previousBuildView?.active()); } finally { releaseScrubBox(); }",
      `if (playing) { const measured1306 = ${probe}.begin();
       try { holdScrubBox(input('scrub')); tickPlaying(now,!previousBuildView?.active()); }
       finally { releaseScrubBox(); ${probe}.end(measured1306, time); } }`);
    source = before(source, 'stepWorldEnvironment(dt,()=>player,pending=>{joltQueue=pending;});', `${probe}.step();`);
    source = replaceOnce(source,
      'function clipDuration(name:string):number{return assets?.animations.find(item=>item.name===name)?.duration??data.manifest.animations.find(item=>item.id===name)?.duration??0;}',
      `function clipDuration(name:string):number{${probe}.duration(); return assets?.animations.find(item=>item.name===name)?.duration
       ?? ${probe}.fallback(() => data.manifest.animations.find(item=>item.id===name)?.duration??0);}`);
    for (const [metric, declaration, close] of [
      [0, 'function renderEnvironment():void {', '\n}\n'],
      [1, 'function renderSchedule():void {', '\n}\n'],
      [2, 'function worldFor(name:string):WorldExport|{error:string} {', '\n}\n'],
      [3, 'function applyEnvironment():void {', '}\nfunction renderEnvironment'],
    ] as const) {
      // A wrapper must preserve the following function's unchanged declaration.
      source = timeFunction(source, declaration, close, metric);
    }
    return `${probe} = (${installProbe.toString()})(${metrics.length});\n${source}`;
  }
  if (file === 'compare.ts') {
    source = replaceOnce(source, '\nvoid start();', `\nlet ready1306 = false;
      void start().then(() => { ready1306 = true; });\n${compareState}`);
    const body = 'try{const state=presentation.present(sample,deadline,presentedFrames,';
    source = before(source, body,
      `const measured1306 = !video.paused && sample.source === 'video-frame' && ${probe}.begin();\n`);
    return replaceOnce(source, 'catch(error){failPair(error);renderPresentation(presentation.snapshot());}',
      `catch(error){failPair(error);renderPresentation(presentation.snapshot());}
       finally { ${probe}.end(measured1306, sample.time, presentedFrames); }`);
  }
  requireCheck(file === 'compare-picked-tools.ts', `FRAME1306_FILE: ${file}`);
  source = before(source, '  return {\n    mode: () => workspaceMode,', compareEnvironment);
  source = before(source, 'stepWorldEnvironment(dt, () => player, pending => { joltQueue = pending; });', `${probe}.step();`);
  source = replaceOnce(source, 'return host.assets[side]?.animations.find(item => item.name === name)?.duration ?? host.duration();',
    `${probe}.duration(); return host.assets[side]?.animations.find(item => item.name === name)?.duration
     ?? ${probe}.fallback(() => host.duration());`);
  for (const [metric, declaration] of [
    [0, 'function renderEnvironment(): void {'],
    [1, 'function renderSchedule(): void {'],
    [2, 'function worldFor(name: string, side: Side = pickedSide): WorldExport | { error: string } {'],
    [3, 'function applyEnvironment(): void {'],
  ] as const) {
    source = timeFunction(source, declaration, '\n  }\n', metric);
  }
  return source;
}

async function observedSources() {
  const files = ['main.ts', 'compare.ts', 'compare-picked-tools.ts'];
  return new Map(await Promise.all(files.map(async file => [
    file, instrument(file, await readFile(join(appRoot, 'web', file), 'utf8')),
  ] as const)));
}

async function browserBundle(sources: Map<string, string>) {
  const result = await Bun.build({
    entrypoints: [join(appRoot, 'web/main.ts')], target: 'browser', format: 'esm', conditions: playBuildConditions(),
    plugins: [{ name: 'review-frame-1306', setup(build) {
      build.onLoad({ filter: /[\\/]web[\\/](main|compare|compare-picked-tools)\.ts$/ }, ({ path }) => {
        const contents = sources.get(basename(path));
        requireCheck(contents, `FRAME1306_BUILD_SOURCE: ${path}`);
        return { loader: 'ts', contents };
      });
    } }],
  });
  const bundle = result.outputs.find(output => output.path.endsWith('.js'));
  requireCheck(result.success && bundle, result.logs.map(log => log.message).join('\n') || 'FRAME1306_NO_BUNDLE');
  return bundle;
}

function serve(context: Awaited<ReturnType<typeof createReviewRequestContext>>) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
    async fetch(request, listener) { return await context.handle(request, listener.port, listener) as Response; },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop() { try { context.stop(); } finally { server.stop(true); } },
  };
}

async function waitState(page: InputCdpSession, label: string, accept: (state: State) => boolean): Promise<State> {
  const until = Date.now() + 20_000;
  let state: State | null = null;
  while (Date.now() < until) {
    state = await page.evaluate<State | null>(`${probe}?.state?.()`);
    if (state && accept(state)) return state;
    await Bun.sleep(50);
  }
  const message = await page.evaluate("document.querySelector('#message')?.textContent");
  throw Error(`FRAME1306_STATE_TIMEOUT ${label}: ${JSON.stringify({ state, message })}`);
}

async function uptake(page: InputCdpSession, arm: Arm) {
  const mode = arm === 'Rig Animate' ? 'playback' : arm === 'Compare Animate' ? 'animate' : 'compare';
  const settled = (state: State) => state.ready && state.playEnabled && state.referenceReady && state.decoded;
  await waitState(page, `${arm} mount`, settled);
  if (arm !== 'Compare default') {
    await page.evaluate(`document.querySelector('.mode-switch [data-mode="playback"]').click()`);
  }
  const selected = await waitState(page, `${arm} mode`, state => settled(state) && state.mode === mode);
  if (selected.playing) await page.evaluate(`${probe}.togglePlayback()`);
  await waitState(page, `${arm} pause`, state => settled(state) && !state.playing);
  if (arm !== 'Compare default') {
    await page.evaluate(`(() => {
      for (const id of ['wind-breeze', 'environment-use']) {
        const field = document.getElementById(id);
        if (!field || field.disabled) throw Error('FRAME1306_ENV_CONTROL ' + id);
        field.checked = true;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await waitState(page, `${arm} engaged world`, state =>
      settled(state) && state.mode === mode && state.applied && state.useWorld && state.settings.breeze && !state.playing);
  } else {
    await page.evaluate(`(() => {
      document.getElementById('time-input').value = '0';
      document.getElementById('seek').click();
    })()`);
    await waitState(page, `${arm} reset`, state => settled(state) && !state.playing && state.time === 0);
  }
  await page.evaluate(`${probe}.togglePlayback()`);
  await waitState(page, `${arm} play`, state => settled(state) && state.mode === mode && state.playing);
}

function hostLoad() {
  const result = Bun.spawnSync(['uptime'], { stdout: 'pipe', stderr: 'pipe' });
  requireCheck(result.exitCode === 0, `FRAME1306_UPTIME: ${result.stderr.toString().trim()}`);
  return { at: new Date().toISOString(), uptime: result.stdout.toString().trim() };
}

function stats(values: number[]) {
  requireCheck(values.length, 'FRAME1306_EMPTY_SAMPLE');
  const sorted = values.toSorted((a, b) => a - b);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: sorted[Math.ceil(.95 * sorted.length) - 1]!,
  };
}

function summarize(capture: Capture) {
  const { frames } = capture;
  return {
    frames: frames.length, advanceFrames: frames.filter(frame => frame.steps > 0).length,
    clipDurationCalls: frames.reduce((sum, frame) => sum + frame.durationCalls, 0),
    callbackMs: stats(frames.map(frame => frame.frameMs)),
    unionMs: stats(frames.map(frame => frame.unionMs)),
    pairs: Object.fromEntries(metrics.map((name, index) => {
      const active = frames.filter(frame => frame.calls[index]! > 0);
      return [name, {
        calls: active.reduce((sum, frame) => sum + frame.calls[index]!, 0), framesWithCalls: active.length,
        perFrameMs: stats(frames.map(frame => frame.inclusiveMs[index]!)),
        calledFramesMs: active.length ? stats(active.map(frame => frame.inclusiveMs[index]!)) : null,
        outsideFrameCalls: capture.outsideCalls[index],
      }];
    })),
  };
}

function validateFrames(capture: Capture, arm: Arm, duration: number) {
  const { frames } = capture;
  requireCheck(!capture.violations.length && frames.length >= 10 &&
    new Set(frames.map(frame => frame.clipTime)).size >= 5, `FRAME1306_NO_LIVE_SAMPLE: ${arm}`);
  for (const frame of frames) {
    requireCheck([frame.atMs, frame.clipTime, frame.frameMs, frame.unionMs, ...frame.inclusiveMs]
      .every(value => Number.isFinite(value) && value >= 0) &&
      frame.clipTime <= duration + .001 && frame.unionMs <= frame.frameMs + .001 &&
      frame.inclusiveMs.every(value => value <= frame.unionMs + .001) &&
      frame.unionMs <= frame.inclusiveMs.reduce((sum, value) => sum + value, 0) + .001,
    `FRAME1306_ATTRIBUTION: ${arm} ${JSON.stringify(frame)}`);
    const [environment, schedule, world, apply, fallback] = frame.calls as [number, number, number, number, number];
    requireCheck(frame.calls.every(value => Number.isSafeInteger(value) && value >= 0) &&
      environment === frame.steps + apply && schedule === environment &&
      world >= schedule && frame.durationCalls >= world && fallback <= frame.durationCalls &&
      (arm === 'Rig Animate' ? frame.presentedFrames === null : Number.isSafeInteger(frame.presentedFrames)),
    `FRAME1306_CALL_TREE: ${arm} ${JSON.stringify(frame)}`);
  }
  requireCheck(arm === 'Compare default' ? frames.every(frame => frame.durationCalls === 0) :
    frames.some(frame => frame.steps > 0 && frame.calls[2]! > 0), `FRAME1306_WRONG_PLAYBACK_BRANCH: ${arm}`);
}

type Trial = {
  arm: Arm; uptimeBefore?: ReturnType<typeof hostLoad>; uptimeAfter?: ReturnType<typeof hostLoad>;
  before?: State; after?: State; capture?: Capture; summary?: ReturnType<typeof summarize>;
};
type Round = {
  number: number; order: Arm[]; uptimeBefore: ReturnType<typeof hostLoad>;
  uptimeAfter?: ReturnType<typeof hostLoad>; trials: Trial[];
};

function spread(values: number[]) {
  return { values, min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) };
}

type Stats = ReturnType<typeof stats>;
function repeatSpread(rounds: Round[]) {
  const spreadStats = (values: Stats[]) => ({ mean: spread(values.map(v => v.mean)), p95: spread(values.map(v => v.p95)) });
  const byArm = (arm: Arm) => rounds.map(round => round.trials.find(trial => trial.arm === arm)!.summary!);
  const a = byArm('Rig Animate'), b = byArm('Compare Animate');
  const difference = (read: (row: typeof a[number]) => Stats) => spreadStats(b.map((row, i) => ({
    mean: read(row).mean - read(a[i]!).mean, p95: read(row).p95 - read(a[i]!).p95,
  })));
  const spreadArm = (samples: typeof a) => ({
    frames: spread(samples.map(row => row.frames)),
    callbackMs: spreadStats(samples.map(row => row.callbackMs)),
    unionMs: spreadStats(samples.map(row => row.unionMs)),
    pairs: Object.fromEntries(metrics.map(name => [name, {
      calls: spread(samples.map(row => row.pairs[name]!.calls)),
      perFrameMs: spreadStats(samples.map(row => row.pairs[name]!.perFrameMs)),
    }])),
  });
  return {
    byArm: { 'Rig Animate': spreadArm(a), 'Compare Animate': spreadArm(b) },
    compareMinusRig: {
      unionMs: difference(row => row.unionMs),
      pairs: Object.fromEntries(metrics.map(name => [name, difference(row => row.pairs[name]!.perFrameMs)])),
    },
  };
}

async function run(options: { fixture: string; reference: string; out: string; rounds: number; seconds: number }) {
  const report = {
    schema: 'review-compare-frame-measurement/1', issue: 1306, status: 'incomplete',
    settings: { ...options, clip: 'idle', dpr: 2, windowArgument: [1440, 900], warmupMs: 1500, metrics },
    fixture: {} as Record<string, unknown>,
    machine: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model, bun: Bun.version },
    notes: [
      'A is the Rig Animate requestAnimationFrame callback. B is the Compare Animate accepted requestVideoFrameCallback sample. Their frame cadence and rendering workload differ.',
      'Compare mounts the same package for sides A and B and uses A for Animate. Rig and Compare both bind the same local reference.',
      'Timing covers synchronous elapsed time in each named function. The union counts nested intervals once. Callback-body totals include probe work, with Compare starting after its admission guards.',
      'The clipDuration metric times only the actual nullish fallback; durationCalls counts the entire dispatcher. All-frame means and nearest-rank p95 include zero-call callbacks. Called-frame statistics are separate.',
      'Off-frame entries during the capture window are counted without timing. Clip wraps and Compare loop seeks can happen outside the accepted frame scope. Warmup and setup calls are excluded.',
      'Zero calls show absence in the measured path. The samples include timer/probe overhead and any interruptions; async observers, later layout, GPU/compositor work and unaccepted frames are outside this scope.',
      'Per-round differences describe the two live surfaces and their different call rates. They do not isolate the effect of any proposed change and cannot be subtracted from the #361 historical Chrome trace.',
      'The CDP helper uses software ANGLE/SwiftShader. Each arm navigates the same browser to a fresh origin with isolated state. The default Compare control keeps the default world. The two playback drivers can reach different clip phases at capture start.',
    ],
    rounds: [] as Round[], defaultControl: null as Trial | null, repeatSpread: null as ReturnType<typeof repeatSpread> | null,
    errors: [] as string[], browserExceptions: [] as unknown[],
  };
  await mkdir(options.out, { recursive: true });
  const receipt = join(options.out, 'review-compare-frame-1306.json');
  const save = () => writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
  await writeFile(receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  let root: string | undefined;
  let page: InputCdpSession | undefined;
  try {
    const [{ loadReferencedReview, referenceBinding }, { loadCompare }, { createReviewRequestContext },
      { createCompareRequestContext }, { launchCdpSession, findBrowserBinary }] = await Promise.all([
      import('../src/reference.ts'), import('../src/compare.ts'), import('../src/server.ts'),
      import('../src/compare-server.ts'), import('../tests/parts-explorer-browser.ts'),
    ]);
    const [bundle, rig, compare] = await Promise.all([
      browserBundle(await observedSources()), loadReferencedReview(options.fixture, options.reference),
      loadCompare({ a: options.fixture, b: options.fixture, reference: options.reference, animation: 'idle' }),
    ]);
    const binding = referenceBinding(rig);
    const model = rig.reviewedSource.rig?.sha256, source = binding?.packageSourceHash;
    const reference = compare.response.reference.sha256;
    requireCheck(model && source && binding?.reference.sha256 === reference &&
      [compare.a, compare.b].every(side => side.sourceHash === source && side.reviewedSource.rig?.sha256 === model),
    'FRAME1306_SOURCE_MISMATCH');
    report.fixture = {
      id: rig.manifest.id, revision: rig.manifest.revision, manifest: rig.manifestPath, model, source,
      rigBinding: rig.sourceHash, compareBinding: compare.response.sourceHash, referencePath: compare.referencePath,
      reference, runtime: rig.reviewedSource.runtimeVersion, chromium: findBrowserBinary(),
      bundle: createHash('sha256').update(Buffer.from(await bundle.arrayBuffer())).digest('hex'),
    };
    root = await mkdtemp(join(tmpdir(), 'review-frame-1306-'));
    page = await launchCdpSession(join(root, 'profile'), {
      sendDeadlineMs: Math.max(30_000, options.seconds * 1000 + 10_000),
      browserArgs: ['--force-device-scale-factor=2', '--window-size=1440,900'],
      onEvent(event) { if (event.method === 'Runtime.exceptionThrown') report.browserExceptions.push(event.params); },
    });
    const baselines = new Map<Arm, State>();
    function checkState(state: State, arm: Arm) {
      const isRig = arm === 'Rig Animate', count = isRig ? 1 : 2;
      const same = <T>(values: T[], value: T) => values.length === count && values.every(item => item === value);
      requireCheck(state.ready && state.playing && !state.hidden && state.playEnabled && state.referenceReady && state.decoded && state.dpr === 2 &&
        state.animation === 'idle' && same(state.playerClips, 'idle') && same(state.models, model) &&
        same(state.packages, source) && state.reference === reference &&
        state.side === (isRig ? 'rig' : 'a') &&
        state.mode === (isRig ? 'playback' : arm === 'Compare Animate' ? 'animate' : 'compare') &&
        state.duration > 0 && same(state.assetDurations, state.duration) &&
        state.rendererKinds.length === count && state.rendererKinds.every(kind => /^(canvas|dom)\/(canvas2d|webgl)$/.test(kind)),
      `FRAME1306_LIVE_CONTENT: ${arm} ${JSON.stringify(state)}`);
      requireCheck(arm === 'Compare default' ? !state.applied && !state.useWorld :
        state.applied && state.useWorld && state.settings.breeze && !!state.world && /sha256 [a-f0-9]{16}/.test(state.world),
      `FRAME1306_LIVE_WORLD: ${arm} ${JSON.stringify(state)}`);
      const prior = baselines.get(arm);
      const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      if (prior) requireCheck(equal(prior.rendererKinds, state.rendererKinds) &&
        equal(prior.settings, state.settings) && prior.world === state.world && prior.gravity === state.gravity &&
        prior.duration === state.duration && prior.referenceDuration === state.referenceDuration &&
        equal(prior.viewport, state.viewport) && prior.browser === state.browser, `FRAME1306_ARM_DRIFT: ${arm}`);
      else baselines.set(arm, state);
      const a = baselines.get('Rig Animate'), b = baselines.get('Compare Animate');
      if (a && b) requireCheck(equal(a.settings, b.settings) && a.world === b.world && a.gravity === b.gravity &&
        a.duration === b.duration && a.referenceDuration === b.referenceDuration && equal(a.viewport, b.viewport) &&
        a.browser === b.browser && a.rendererKinds[0] === b.rendererKinds[0], 'FRAME1306_PAIRED_CONTENT_MISMATCH');
    }

    async function trial(row: Trial, name: string, seconds: number) {
      const browser = page!;
      const setup = { bundle, stateDir: join(root!, name) };
      const context = row.arm === 'Rig Animate'
        ? await createReviewRequestContext(rig, { ...setup, initialAnimation: 'idle', viewOnly: true })
        : await createCompareRequestContext(compare, setup);
      const server = serve(context);
      try {
        await browser.goto(server.url + '?lang=en', 'en');
        await uptake(browser, row.arm);
        await Bun.sleep(report.settings.warmupMs);
        const ready = (state: State) => state.ready && state.playing && state.referenceReady;
        row.before = await waitState(browser, `${row.arm} warmup`, ready);
        checkState(row.before, row.arm);
        row.uptimeBefore = hostLoad();
        try {
          row.capture = await browser.evaluate<Capture>(`${probe}.sample(${seconds * 1000})`);
        } finally {
          row.uptimeAfter = hostLoad();
        }
        row.after = await waitState(browser, `${row.arm} post-capture`, ready);
        checkState(row.after, row.arm);
        validateFrames(row.capture, row.arm, row.before.duration);
        row.summary = summarize(row.capture);
        requireCheck(!report.browserExceptions.length, 'FRAME1306_BROWSER_EXCEPTION');
      } finally {
        try { await browser.goto('about:blank'); } finally { server.stop(); }
      }
    }

    for (let number = 1; number <= options.rounds; number++) {
      const order = [arms[0], arms[1]];
      const round: Round = { number, order, uptimeBefore: hostLoad(), trials: [] };
      report.rounds.push(round);
      try {
        for (const [index, arm] of order.entries()) {
          const row = { arm };
          round.trials.push(row);
          await trial(row, `round-${number}-${index}`, options.seconds);
          await save();
        }
      } finally {
        round.uptimeAfter = hostLoad();
        await save();
      }
      console.log(`Round ${number} ${order.join(' / ')} complete`);
    }
    const control: Trial = { arm: 'Compare default' };
    report.defaultControl = control;
    await trial(control, 'default-control', 2);
    report.repeatSpread = repeatSpread(report.rounds);
    report.status = 'complete';
  } catch (error) {
    report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    try {
      await page?.close();
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      report.errors.push(String(error));
    }
    if (report.errors.length) report.status = 'failed';
    await save();
    console.log(receipt);
  }
  requireCheck(report.status === 'complete', report.errors.join('\n'));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    fixture: { type: 'string' }, reference: { type: 'string' }, out: { type: 'string' },
    rounds: { type: 'string', default: '5' }, seconds: { type: 'string', default: '10' },
    'check-anchors': { type: 'boolean' },
  } });
  if (values['check-anchors']) {
    const sources = await observedSources();
    const parser = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
    for (const [file, source] of sources) {
      parser.transformSync(source);
      console.log(`Anchors and syntax pass: ${file}`);
    }
  } else {
    const { fixture, reference, out } = values, rounds = Number(values.rounds), seconds = Number(values.seconds);
    requireCheck(fixture && reference && out, 'Usage: bun scripts/measure-compare-frame-1306.ts --fixture PATH --reference PATH --out DIR [--rounds N] [--seconds N]');
    requireCheck(Number.isSafeInteger(rounds) && rounds >= 5 && Number.isSafeInteger(seconds) && seconds >= 2,
      'FRAME1306_USAGE: at least five rounds and two seconds per arm');
    await run({ fixture: resolve(fixture), reference: resolve(reference), out: resolve(out), rounds, seconds });
  }
}
