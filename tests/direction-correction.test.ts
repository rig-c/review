import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';
import { freshSession, sessionFile } from '../src/session.ts';
import { timeOnlyBasis } from '../src/stage-comment.ts';

test('authored direction correction exports the inspected bindings and exact marked region through the public CLI', async () => {
  const state = await mkdtemp(join(tmpdir(), 'direction-correction-'));
  const pkg = await loadReview('tests/fixtures/direction-inspection');
  const server = await startServer(pkg, { port: 0, stateDir: state });
  try {
    const baseline = freshSession(pkg);
    const model = pkg.reviewedSource.rig!;
    const direction = pkg.direction!.file;
    const camera = { space: 'world', center: { x: 0, y: 0 }, zoom: 1,
      viewport: { width: 100, height: 100 }, visible: { x: -50, y: -50, width: 100, height: 100 } };
    const region = { viewport: 'rig', screen: { x: 46, y: 42, width: 6, height: 5 },
      world: { x: -4, y: 3, width: 6, height: 5 } };
    const time = 0.53125;
    const animation = 'turn';
    // A real 1×1 crop used by the time-only comment validation controls.
    const cropBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
    const cropHash = createHash('sha256').update(Buffer.from(cropBytes, 'base64')).digest('hex');
    const verbatim = '  카메라를 좁히고 이 구간을 늘려 주세요.\r\nKeep the hand in frame.  \n';
    const item = {
      id: 'direction-request', frameStart: null, frameEnd: null, target: { kind: 'rig', name: pkg.manifest.id },
      category: 'quality', summary: verbatim,
      context: { time, frame: null, animation, interval: null, comment: {
        schema: 'rig-review-comment/1', mode: 'animate', frame: null, timeBasis: timeOnlyBasis,
        time, animation, sourceHash: pkg.sourceHash, modelHash: model.sha256, referenceId: null, referenceHash: null,
        camera, ...region, slots: [],
        crop: { path: `comment-crops/${cropHash}.png`, sha256: cropHash, png: 'data:image/png;base64,' + cropBytes, width: 1, height: 1 },
        bookmark: { schema: 'rig-review-inspection/1', binding: { mode: 'single', sourceHash: pkg.sourceHash, rigs: [model.sha256] },
          time, animation, theme: 'light', layers: { images: true, meshes: false, bones: false },
          view: { schema: 'rig-review-view/1', cameras: { rig: camera, a: null, b: null, reference: null } },
          selection: { inspector: 'playback' } },
      }, correction: { path: 'described', selector: { stage: 'direction-review', kind: 'post', version: 2, modelFile: model.path } } },
    };
    const origin = `http://127.0.0.1:${server.port}`;
    const submit = () => fetch(origin + '/api/session', {
      method: 'PUT', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseline, feedback: [item] }),
    });
    item.context.correction.selector.modelFile = direction.path;
    const refused = await submit();
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain('CORRECTION_DIRECTION_SOURCE');
    item.context.correction.selector.modelFile = model.path;
    const saved = await submit();
    expect(saved.ok, await saved.text()).toBe(true);

    const run = (format: string) => Bun.spawnSync([process.execPath, 'src/cli.ts', 'feedback', pkg.root,
      '--correction', item.id, '--format', format], { env: { ...process.env, RIG_REVIEW_STATE_DIR: state } });
    const json = run('json');
    expect(json.exitCode, json.stderr.toString()).toBe(0);
    expect(json.stdout).toEqual(await readFile(sessionFile(pkg, state)));
    expect(JSON.parse(json.stdout.toString()).status).toBe('pending');

    const issue = run('issue');
    expect(issue.exitCode, issue.stderr.toString()).toBe(0);
    const handoff = JSON.parse(issue.stdout.toString().split('\n').slice(5, -2).join('\n'));
    expect(handoff.verbatim).toBe(verbatim);
    expect(handoff.selectorArgs).toEqual(['--version', '2', '--model-file', model.path]);
    expect(JSON.parse(handoff.createSource)).toEqual({
      source: { id: pkg.manifest.id, revision: pkg.manifest.revision, sourceHash: pkg.sourceHash, reviewedSource: pkg.reviewedSource },
      post: 2, model, direction, animation, time, frame: null, interval: null, target: item.target,
      camera, region, reference: { id: null, sha256: null },
    });
  } finally {
    server.stop(true);
    await rm(state, { recursive: true, force: true });
  }
});
