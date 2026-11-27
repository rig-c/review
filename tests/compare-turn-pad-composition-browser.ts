/** #1303. Run from the Review root with --out DIR. Requires Chromium and ffprobe. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { playBuildConditions } from '../src/build.ts';
import { loadCompare } from '../src/compare.ts';
import { createCompareRequestContext } from '../src/compare-server.ts';
import { loadReview } from '../src/manifest.ts';
import { createReviewRequestContext } from '../src/server.ts';
import { PROBE_MP4_BASE64 } from './compare-mode-browser.ts';
import { instrumentRigMount } from './helpers/mount-probe.ts';
import { turnPackage } from './helpers/turn-pad.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';

// Distinct test writes on the public model's existing bones, outside its pad channels.
const markers = [
  { lane: 'idle', bone: 'mesh', channel: 'y', read: 'y', value: 9 },
  { lane: 'dial', bone: 'root', channel: 'x', read: 'x', value: 7 },
  { lane: 'animation', bone: 'rigid', channel: 'rotation', read: 'rotationX', value: 28 },
] as const;
const markerJson = JSON.stringify(markers);
const clip = 'inspect';
const target = 0.25;
const reading = 'window.__turn1303?.read()';
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-5;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const helpers = `
const markers1303 = ${markerJson};
const pose1303 = player => player?.current ? ({
  clip: player.current, time: player.time, trackTime: player.entry(0).animationTime,
  yaw: player.bone('yaw_dial').rotationX,
  lanes: Object.fromEntries(markers1303.map(m => [m.lane, player.bone(m.bone)[m.read]])),
}) : null;
const pad1303 = pad => ({
  engaged: pad.state.engaged, releasing: pad.state.releasing, smoothing: pad.state.smoothing,
  yaw: Number(document.querySelector('[data-turn-axis="yaw"]').dataset.value),
});
function seed1303(receivers) {
  for (const {lane, bone, channel, value} of markers1303) {
    if (typeof receivers[lane] !== 'function') throw Error('Missing production preview receiver: ' + lane);
    receivers[lane](bones => { bones.bone(bone)[channel] = value; });
  }
}
`;
const receivers = `
const receivers1303 = {};
const capture1303 = (lane, callback) => { receivers1303[lane] = callback; return callback; };
`;
const rigProbe = `
${helpers}
window.__turn1303 = {
  seed: () => seed1303(receivers1303),
  read: () => !persistence || persistence.restoring() || !turnPad || !player?.current ? null : ({
    time, playing, model: stageModelHash, pose: pose1303(player), pad: pad1303(turnPad),
  }),
};
`;
const compareProbe = `
${helpers}
window.__turn1303 = {
  seed: () => seed1303(window.__pickedReceivers1303),
  read: () => {
    if (!ready || !persistence || persistence.restoring() || !turnPad || !pickedTools || !referenceFrames || !trace) return null;
    const drawn = presentation.snapshot().lastDrawn;
    if (!drawn) return null;
    const side = pickedTools.pickedSide();
    return {
      time: drawn.reference, playing: !video.paused, model: pickedTools.modelHashFor(side),
      pose: pose1303(players[side]), peer: pose1303(players[side === 'a' ? 'b' : 'a']),
      pad: pad1303(turnPad), mode: pickedTools.mode(), side, generation: latestSeek,
      decodedFrame: referenceFrameAtTime(referenceFrames, drawn.reference)?.index ?? null,
      source: drawn.source, settled: !seeking && !video.seeking,
    };
  },
};
`;

function replaceOnce(source: string, anchor: string, replacement: string) {
  if (source.split(anchor).length !== 2) throw new Error(`Missing or ambiguous probe anchor: ${anchor}`);
  return source.replace(anchor, () => replacement);
}

function captureReceiver(source: string, lane: string, start: string, end: string) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || source.indexOf(start, first + start.length) >= 0) {
    throw new Error(`Missing or ambiguous preview receiver: ${lane}`);
  }
  const callback = source.slice(first, last + 1);
  // Return the exact function that the panel receives.
  return source.slice(0, first) + `capture1303("${lane}", ${callback})` + source.slice(last + 1);
}

async function buildProbe() {
  const result = await Bun.build({
    entrypoints: ['web/main.ts'], target: 'browser', format: 'esm', conditions: playBuildConditions(),
    plugins: [{ name: 'observe-turn-pad-composition', setup(build) {
      build.onLoad({ filter: /\/web\/(main|compare|compare-picked-tools|turn-pad)\.ts$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        if (path.endsWith('/main.ts')) {
          source = replaceOnce(source, 'function setAdjust():void', receivers + 'function setAdjust():void');
          source = captureReceiver(source, 'idle', 'fn=>{idleAdjust=fn;', '},');
          source = captureReceiver(source, 'dial', 'fn=>{dialAdjust=fn', '},');
          source = captureReceiver(source, 'animation', 'fn=>{animAdjust=fn;', '},apply:ops=>stageApplyAnimation');
          source = instrumentRigMount(source, rigProbe);
        } else if (path.endsWith('/compare.ts')) {
          source = replaceOnce(source, '\nvoid start();', `\n${compareProbe}\nvoid start();`);
        } else if (path.endsWith('/compare-picked-tools.ts')) {
          source = replaceOnce(source, '  function setAdjust(side:',
            receivers + '\nwindow.__pickedReceivers1303 = receivers1303;\n  function setAdjust(side:');
          source = captureReceiver(source, 'idle', 'fn => { idleAdjust = fn;', '},');
          source = captureReceiver(source, 'dial', 'fn => { dialAdjust = fn', '},');
          source = captureReceiver(source, 'animation', 'fn => {\n      sides[pickedSide].animAdjust = fn;', '},');
        } else {
          source = replaceOnce(source, 'options.draw(state);render();',
            'options.draw(state);render();window.__afterTurnDraw1303?.();');
        }
        return { loader: 'ts', contents: source };
      });
    } }],
  });
  if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(log => log.message).join('\n'));
  return result.outputs[0];
}

type Pose = { clip: string; time: number; trackTime: number; yaw: number; lanes: Record<string, number> };
type Reading = {
  time: number; playing: boolean; model: string; pose: Pose; peer?: Pose;
  pad: { engaged: boolean; releasing: boolean; smoothing: number; yaw: number };
  mode?: string; side?: string; generation?: number; decodedFrame?: number; source?: string; settled?: boolean;
};
type Pointer = { x: number; y: number; trusted: boolean };
type Evidence = { natural?: Reading; before?: Reading; afterDraw?: Reading; pointer?: Pointer; screenshots: string[] };
type Key = { time: number; value: number };
type Fixture = { animations: Array<{ name: string; bones: Array<{ name: string; timelines: Array<{ name: string; keys: Key[] }> }> }> };

function requireSample(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

async function waitFor(page: InputCdpSession, label: string, condition: string): Promise<Reading> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await page.evaluate<Reading | null>(`(() => {const r = ${reading}; return r && (${condition}) ? r : null;})()`);
    if (value) return value;
    await Bun.sleep(25);
  }
  const context = await page.evaluate(`({reading:${reading}, message:document.querySelector('#message')?.textContent})`);
  throw new Error(`${label} timed out: ${JSON.stringify(context)}`);
}

function serve(context: Awaited<ReturnType<typeof createReviewRequestContext>>) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
    async fetch(request, listener) { return await context.handle(request, listener.port, listener) as Response; },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop() { context.stop(); server.stop(true); } };
}

function sameFrame(before: Reading, after: Reading, label: string) {
  requireSample(!after.playing && before.model === after.model && before.pose.clip === after.pose.clip &&
    close(before.time, after.time) && close(before.pose.time, after.pose.time) &&
    close(before.pose.trackTime, after.pose.trackTime) && before.generation === after.generation &&
    before.decodedFrame === after.decodedFrame, `${label}: changed frame or model`);
  if (before.peer) requireSample(after.peer && before.peer.clip === after.peer.clip &&
    close(before.peer.trackTime, after.peer.trackTime) && close(before.peer.time, after.peer.time),
  `${label}: changed peer frame`);
}

async function engage(page: InputCdpSession, viewport: string) {
  const point = await page.evaluate<{x: number; y: number}>(`(() => {
    const stage = document.querySelector(${JSON.stringify(viewport)});
    const box = stage.getBoundingClientRect();
    const x = Math.round(box.left + (box.width - 1) * .75), y = Math.round(box.top + (box.height - 1) / 2);
    if (!stage.contains(document.elementFromPoint(x,y))) throw Error('Pointer point missed the stage');
    stage.addEventListener('pointermove', event => {
      window.__pointer1303 = {x:event.clientX,y:event.clientY,trusted:event.isTrusted};
    }, {capture:true,once:true});
    window.__afterTurnDraw1303 = () => {
      if (!window.__pointer1303) return;
      window.__immediate1303 = window.__turn1303.read();
      delete window.__afterTurnDraw1303;
    };
    return {x,y};
  })()`);
  await page.mouse('mouseMoved', point.x, point.y);
  const { sample, pointer } = await page.evaluate<{sample: Reading | null; pointer: Pointer | null}>(
    '({sample:window.__immediate1303 ?? null,pointer:window.__pointer1303 ?? null})');
  requireSample(sample && pointer?.trusted && point.x === pointer.x && point.y === pointer.y,
    `${viewport}: no synchronous draw receipt for the trusted pointer`);
  return { sample, pointer };
}

async function run(out: string) {
  const report = {
    issue: 1303, status: 'harness-error', requestedCompareTime: target,
    errors: [] as string[], mismatches: [] as string[], browserExceptions: [] as unknown[],
    provenance: {
      fixture: 'Existing turnPackage({keyedYaw:true}); exact same model in Rig and both Compare sides',
      reference: 'tests/compare-mode-browser.ts PROBE_MP4_BASE64',
      input: 'Trusted CDP pointermove; synchronous bone reads after the real Turn pad draw, before any later seek',
      preview: 'Instrumented local writes supplied to the actual idle, Rig Fields dial and keyed animation preview callbacks. The public fixture has no producer preview handoff. Marker values are test inputs.',
      markers,
    },
    fixture: {} as Record<string, unknown>,
    cases: {} as Record<string, Evidence>,
  };
  let root: string | undefined;
  let page: InputCdpSession | undefined;
  const servers: ReturnType<typeof serve>[] = [];
  try {
    root = await mkdtemp(join(tmpdir(), 'compare-turn-pad-1303-'));
    const pkg = await turnPackage(join(root, 'package'), { keyedYaw: true });
    const modelPath = join(pkg, 'skeleton.model.json');
    const bytes = await readFile(modelPath);
    const model = JSON.parse(bytes.toString()) as Fixture;
    const reference = join(root, 'reference.mp4');
    await writeFile(reference, Buffer.from(PROBE_MP4_BASE64, 'base64'));
    const [bundle, rig, compare] = await Promise.all([
      buildProbe(), loadReview(pkg), loadCompare({ a: pkg, b: pkg, reference, animation: clip }),
    ]);
    const modelHash = hash(bytes);
    requireSample([rig, compare.a, compare.b].every(p => p.reviewedSource.rig?.sha256 === modelHash), 'Fixture hash mismatch');
    const dialBones = new Set(rig.feedbackCatalog.turnDials?.map(dial => dial.bone));
    requireSample(dialBones.has('yaw_dial') && markers.every(marker => !dialBones.has(marker.bone)),
      'Fixture must expose yaw and the preview markers must avoid pad bones');
    const idle = model.animations.find(animation => animation.name === 'idle');
    const idleDialTracks = idle?.bones.filter(bone => dialBones.has(bone.name) &&
      bone.timelines.some(timeline => timeline.keys.length > 0)).map(bone => bone.name) ?? [];
    const yawKeys = model.animations.find(animation => animation.name === clip)?.bones
      .find(bone => bone.name === 'yaw_dial')?.timelines.find(track => track.name === 'rotate')?.keys;
    const idleYawOverlap = idleDialTracks.includes('yaw_dial');
    report.fixture = {
      model: modelHash, package: rig.sourceHash, reference: compare.response.reference.sha256,
      clips: model.animations.map(animation => animation.name), dialBones: [...dialBones],
      idleClipPresent: !!idle, idleDialTracks, idleYawOverlap, yawKeys,
    };
    requireSample(!idleYawOverlap && yawKeys && yawKeys.length > 1, 'Unexpected public fixture yaw keys');
    const browser = page = await launchCdpSession(join(root, 'profile'), {
      sendDeadlineMs: 30_000, browserArgs: ['--renderer-process-limit=2'],
      onEvent(event) { if (event.method === 'Runtime.exceptionThrown') report.browserExceptions.push(event.params); },
    });
    await browser.setViewport(1440, 900);

    async function sample(surface: 'compare' | 'rig', matchedTime?: number) {
      const isCompare = surface === 'compare';
      const evidence: Evidence = { screenshots: [] };
      report.cases[surface] = evidence;
      const options = { bundle, stateDir: join(root!, surface) };
      const context = isCompare
        ? await createCompareRequestContext(compare, options)
        : await createReviewRequestContext(rig, { ...options, initialAnimation: clip, viewOnly: true });
      const server = serve(context);
      servers.push(server);
      await browser.mouse('mouseMoved', 5, 5);
      await browser.goto(server.url);
      const ready = '!r.playing && r.pose?.clip === "inspect" && !document.querySelector("#play").disabled';
      await waitFor(browser, `${surface} mount`, ready + (isCompare ? ' && r.settled && r.decodedFrame === 0' : ''));
      await browser.evaluate(`document.querySelector('.mode-switch [data-mode="playback"]').click()`);
      if (isCompare) {
        await browser.evaluate(`document.getElementById('time-input').value = '${target}'; document.getElementById('seek').click()`);
      } else {
        requireSample(matchedTime !== undefined, 'Rig needs the actual decoded Compare time');
        await browser.evaluate(`(() => {const scrub = document.getElementById('scrub'); scrub.value = '${matchedTime}';
          scrub.dispatchEvent(new Event('input', {bubbles:true}));})()`);
      }
      const done = isCompare
        ? `r.mode === "animate" && r.side === "a" && r.settled && r.source === "video-frame" &&
          r.decodedFrame > 0 && Math.abs(r.time - ${target}) < 0.08`
        : `Math.abs(r.time - ${matchedTime}) < 1e-5`;
      const positioned = await waitFor(browser, `${surface} seek`, `${ready} && ${done}`);
      requireSample(!positioned.pad.engaged && !positioned.pad.releasing, `${surface}: pad already touched`);
      // Switching smoothing commits a draw, so do it before sending any preview writes.
      await browser.evaluate(`document.querySelector('#turn-pad input[type=checkbox]').click()`);
      const natural = evidence.natural = await browser.evaluate<Reading>(reading);
      sameFrame(positioned, natural, `${surface} smoothing toggle`);
      requireSample(natural.model === modelHash && natural.pad.smoothing === 0 && !natural.pad.engaged &&
        close(natural.pose.time, natural.time) && close(natural.pose.trackTime, natural.time) &&
        (!isCompare || natural.peer && close(natural.peer.trackTime, natural.time)),
      `${surface}: missing untouched pad or synchronized fixture clock`);

      async function capture(phase: string, expected: Reading) {
        const name = `${surface}-${phase}.png`;
        await writeFile(join(out, name), await browser.screenshot());
        evidence.screenshots.push(name);
        const held = await browser.evaluate<Reading>(reading);
        requireSample(JSON.stringify(held) === JSON.stringify(expected), `${surface} ${phase}: pose changed across screenshot`);
      }
      await capture('natural', natural);
      await browser.evaluate('window.__turn1303.seed()');
      const before = evidence.before = await browser.evaluate<Reading>(reading);
      sameFrame(natural, before, `${surface} preview callbacks`);
      requireSample(!before.pad.engaged && !before.pad.releasing, `${surface}: pad changed during preview setup`);
      for (const { lane, value } of markers) {
        requireSample(!close(natural.pose.lanes[lane]!, value) && close(before.pose.lanes[lane]!, value),
          `${surface}: ${lane} callback did not establish a distinct pose before input`);
        if (natural.peer && before.peer) requireSample(close(natural.peer.lanes[lane]!, before.peer.lanes[lane]!),
          `${surface}: ${lane} marker contaminated the peer before input`);
      }
      await capture('before', before);

      const immediate = await engage(browser, isCompare ? '#a-viewport' : '#rig-viewport');
      const after = evidence.afterDraw = immediate.sample;
      evidence.pointer = immediate.pointer;
      sameFrame(before, after, `${surface} immediate pad draw`);
      requireSample(after.pad.engaged && !after.pad.releasing && Math.abs(after.pad.yaw - 20) < 0.25,
        `${surface}: pointer did not engage expected positive yaw`);
      await capture('after', after);
      return { natural, before, after };
    }

    const comparison = await sample('compare');
    const single = await sample('rig', comparison.natural.time);
    requireSample(close(comparison.natural.time, single.natural.time), 'Surfaces did not draw the same fixture time');
    requireSample(report.browserExceptions.length === 0, 'Unhandled browser exception; see browserExceptions');
    const time = comparison.natural.time;
    const end = yawKeys.findIndex(key => key.time >= time);
    const right = yawKeys[end], left = yawKeys[end - 1];
    requireSample(left && right && right.time > left.time, 'Decoded time falls outside public yaw keys');
    const naturalYaw = left.value + (right.value - left.value) * (time - left.time) / (right.time - left.time);
    report.fixture.expectedNaturalYaw = naturalYaw;
    for (const [surface, { natural, before, after }] of Object.entries({ compare: comparison, rig: single })) {
      if (!close(natural.pose.yaw, naturalYaw) || !close(before.pose.yaw, naturalYaw)) {
        report.mismatches.push(`${surface}: untouched yaw diverged from clip yaw ${naturalYaw}`);
      }
      if (!close(after.pose.yaw, after.pad.yaw)) {
        report.mismatches.push(`${surface}: engaged yaw ${after.pose.yaw}, expected ${after.pad.yaw}`);
      }
      for (const { lane } of markers) {
        const from = before.pose.lanes[lane]!, to = after.pose.lanes[lane]!;
        if (!close(from, to)) report.mismatches.push(`${surface}: ${lane} changed on pad draw from ${from} to ${to}`);
        if (before.peer && after.peer && !close(before.peer.lanes[lane]!, after.peer.lanes[lane]!)) {
          report.mismatches.push(`${surface}: peer ${lane} changed on pad draw`);
        }
      }
      if (before.peer && after.peer && (!close(before.peer.yaw, naturalYaw) || !close(after.peer.yaw, after.pad.yaw))) {
        report.mismatches.push(`${surface}: peer yaw failed the untouched/engaged control`);
      }
    }
    requireSample(hash(await readFile(modelPath)) === modelHash, 'Probe changed the public fixture model');
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
  try {
    const index = Bun.argv.indexOf('--out'), directory = Bun.argv[index + 1];
    if (index < 0 || !directory || directory.startsWith('--')) {
      throw new Error('Usage: bun tests/compare-turn-pad-composition-browser.ts --out DIR');
    }
    const out = resolve(directory);
    await mkdir(out, { recursive: true });
    const report = await run(out), path = join(out, 'report.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    if (report.status === 'harness-error') {
      console.error('HARNESS_ERROR', path, ...report.errors);
      process.exitCode = 2;
    } else if (report.status === 'mismatch') {
      console.error('MISMATCH', path, ...report.mismatches);
      process.exitCode = 1;
    } else console.log('PASS', path);
  } catch (error) {
    console.error('HARNESS_ERROR', error);
    process.exitCode = 2;
  }
}
