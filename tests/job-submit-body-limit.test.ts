import {expect, test} from 'bun:test';
import {jobFixture, growJobRigFixture} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {createJobFront} from '../src/job-front.ts';
import {createJobHostPorts, jobBodyLimit} from '../src/job-api.ts';
import {jobRigScreenDecisions} from '../web/job-rig-screen.ts';
import {PNG} from 'pngjs';

for (const ratio of [1, 2]) test(`#785 24-slot idle verdict with signoff pending and synthetic DPR ${ratio} capture through the owner front`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  let front: ReturnType<typeof createJobFront> | undefined;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: async request => await front?.fetch(request) ?? new Response(null, {status: 404})});
  const origin = server.url.origin;
  front = createJobFront({origin, ports: createJobHostPorts(f.session, origin), resource: async () => ''});
  try {
    const {bytes: painting, slots} = await growJobRigFixture(f, 1920, 1080);
    const {input, publication, ask} = await rigStillInput(f, 0, 'idle');
    const signoff = await f.ask(publication, {kind: 'signoff', stage: 'rig-review'});
    const decisions = jobRigScreenDecisions({status: 'approved', checkpoints: {}, feedback: []},
      [ask, signoff], publication.publicationId);
    expect(decisions.map(item => item.kind)).toEqual(['review-verdict']);
    // A synthetic uncompressed-detail bitmap at the owner's pane size, not a browser rendering claim.
    const width = 767 * ratio, height = 770 * ratio, pixels = new PNG({width, height});
    const original = PNG.sync.read(painting);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = ((y % original.height) * original.width + x % original.width) * 4;
      pixels.data.set(original.data.subarray(source, source + 4), (y * width + x) * 4);
    }
    const bytes = PNG.sync.write(pixels);
    const payload = {...input, expectedGeneration: f.session.status().generation, value: decisions[0]!.value, capture: {...input.capture,
      png: 'data:image/png;base64,' + bytes.toString('base64'), width, height}};
    const body = JSON.stringify(payload);
    expect(slots).toBe(24);
    expect(payload.value.words).toBe('');
    expect(Buffer.byteLength(body)).toBeGreaterThan(jobBodyLimit);
    const response = await fetch(origin + `/jobs/${f.session.jobId}/ui/acts`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui}, body});
    const result = await response.json();
    console.log(JSON.stringify({slots, ratio, width, height, comments: 0, pngBytes: bytes.length, bodyBytes: Buffer.byteLength(body),
      withoutCaptureBytes: Buffer.byteLength(JSON.stringify({...payload, capture: undefined})),
      actEventBytes: Buffer.byteLength(JSON.stringify({type: 'act', act: result.value, jobId: f.session.jobId,
        generation: f.session.status().generation, cursor: f.session.status().cursor})),
      status: response.status, ok: result.ok, error: result.error}));
    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('review-verdict');
    expect(result.value.value.comments).toEqual([]);
    expect(f.session.status().pending.some(item => item.askId === ask.askId)).toBe(false);
    expect(f.session.status().pending.map(item => item.askId)).toEqual([signoff.askId]);
    expect(JSON.parse(f.session.readActExport(result.value.actId, false).toString())).toEqual(result.value);
  } finally {
    front.stop(); await server.stop(true); await f.close();
  }
});
