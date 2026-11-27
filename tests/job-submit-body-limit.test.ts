import {expect, test} from 'bun:test';
import {jobFixture, growJobRigFixture} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {createJobFront} from '../src/job-front.ts';
import {createJobHostPorts, jobBodyLimit} from '../src/job-api.ts';
import {jobCaptureBodyLimit} from '../src/job-contract.ts';
import {PNG} from 'pngjs';

// The 10.8 MB DPR 2 case took up to twice as long as DPR 1 on Nova.
// CI's 2.8 s DPR 1 result puts the DPR 2 estimate at 5.6 s before headroom.
const dpr2TimeoutMs = 8_000;

for (const ratio of [1, 2]) test(`#785 24-slot legacy rig input with synthetic DPR ${ratio} capture reaches the verdict refusal through the owner front`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  let front: ReturnType<typeof createJobFront> | undefined;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: async request => await front?.fetch(request) ?? new Response(null, {status: 404})});
  const origin = server.url.origin;
  front = createJobFront({origin, ports: createJobHostPorts(f.session, origin), resource: async () => ''});
  try {
    const {bytes: painting, slots} = await growJobRigFixture(f, 1920, 1080);
    const {input} = await rigStillInput(f, 0, 'idle');
    const before = f.session.status();
    // A synthetic uncompressed-detail bitmap at the owner's pane size, not a browser rendering claim.
    const width = 767 * ratio, height = 770 * ratio, pixels = new PNG({width, height});
    const original = PNG.sync.read(painting);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = ((y % original.height) * original.width + x % original.width) * 4;
      pixels.data.set(original.data.subarray(source, source + 4), (y * width + x) * 4);
    }
    const bytes = PNG.sync.write(pixels);
    const payload = {...input, expectedGeneration: f.session.status().generation, value: {...input.value, words: ''}, capture: {...input.capture,
      png: 'data:image/png;base64,' + bytes.toString('base64'), width, height}};
    const body = JSON.stringify(payload);
    expect(slots).toBe(24);
    expect(payload.value.words).toBe('');
    expect(Buffer.byteLength(body)).toBeGreaterThan(jobBodyLimit);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(jobCaptureBodyLimit);
    const response = await fetch(origin + `/jobs/${f.session.jobId}/ui/acts`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui}, body});
    const result = await response.json();
    console.log(JSON.stringify({slots, ratio, width, height, comments: 0, pngBytes: bytes.length, bodyBytes: Buffer.byteLength(body),
      withoutCaptureBytes: Buffer.byteLength(JSON.stringify({...payload, capture: undefined})),
      status: response.status, ok: result.ok, error: result.error}));
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
    expect(f.session.status()).toEqual(before);
  } finally {
    front.stop(); await server.stop(true); await f.close();
  }
}, ratio === 2 ? dpr2TimeoutMs : undefined);
