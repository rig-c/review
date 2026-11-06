import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interviewRoutes } from '../src/interview-routes.ts';
import { projectFixture } from './interview-project.test.ts';

test('interview routes bind image indices and refuse forged, oversized and stale writes', async () => {
  const fixture = projectFixture();
  const origin = 'http://127.0.0.1:4321';
  const capability = 'a'.repeat(64);
  try {
    const route = interviewRoutes(fixture.root,'picks',capability);
    const payload = {schema:'rig-review/interview-picks@1',set:fixture.set,
      picks:[{ask:'reference',option_id:'auto'}],by:'user',at:'2020-01-03T00:00:00Z'};
    const post = (data: unknown, requestOrigin = origin, key = capability) => route(new Request(origin+'/api/interview/picks',{
      method:'POST',headers:{origin:requestOrigin,'X-Review-Capability':key,'Content-Type':'application/json'},body:JSON.stringify(data),
    }),origin);
    expect((await post(payload,'https://example.test'))?.status).toBe(403);
    expect((await post(payload,origin,''))?.status).toBe(403);
    expect((await post({...payload,note:'x'.repeat(256*1024)}))?.status).toBe(400);
    expect((await post({...payload,set:{...fixture.set,sha256:'0'.repeat(64)}}))?.status).toBe(409);
    expect((await post({...payload,picks:[{ask:'reference',option_id:'forged'}]}))?.status).toBe(400);
    expect(readdirSync(join(fixture.root,'picks'))).toEqual([]);
    const list = await route(new Request(origin+'/api/interview'),origin);
    const {questions:[item]} = await list!.json();
    const image = await route(new Request(origin+item.images[0].url),origin);
    expect(image?.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(await image?.text()).toContain('<svg');
    expect((await post(payload))?.status).toBe(200);
    const before = readdirSync(join(fixture.root,'picks'));
    writeFileSync(join(fixture.root,'project.json'),JSON.stringify({...fixture.project,notes:['new revision']}));
    expect((await post(payload))?.status).toBe(409);
    expect(readdirSync(join(fixture.root,'picks'))).toEqual(before);
  } finally {fixture.dispose();}
});
