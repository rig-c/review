import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interviewRoutes } from '../src/interview-routes.ts';
import { projectFixture } from './interview-project.test.ts';
import { digest } from '../src/interview-project.ts';

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

test('a consumed set ignores stale review output and preserves the historical answer', async () => {
  const fixture = projectFixture();
  try {
    const choice = {spec:'rig-create/interview-choice@1',set:fixture.set,
      picks:[{ask:'reference',option_id:'a'}],note:'Historical note'};
    const answer = {at:'2020-01-03T00:00:00Z',choice};
    const project = {...fixture.project,interview:{...fixture.project.interview,framing:[{id:'reference',answer}]}};
    writeFileSync(join(fixture.root,'project.json'),JSON.stringify(project));
    writeFileSync(join(fixture.root,'picks',fixture.set.sha256+'.json'),JSON.stringify({
      schema:'rig-review/interview-picks@1',set:fixture.set,picks:[{ask:'reference',option_id:'b'}],note:'Stale note',
      by:'user',at:answer.at,
    }));
    const origin = 'http://127.0.0.1:4321';
    const route = interviewRoutes(fixture.root,'picks','a'.repeat(64));
    const response = await route(new Request(origin+'/api/interview'),origin);
    const {questions:[question]} = await response!.json();
    expect(question.editable).toBe(false);
    expect(question.saved).toBeNull();
    expect(question.answer).toEqual(answer);
  } finally {fixture.dispose();}
});


for (const adopted of [false, true]) {
 test(`interview routes preserve the unsupported scene code for ${adopted ? 'adopted' : 'legacy'} post contexts`, async () => {
  const fixture = projectFixture();
  const origin = 'http://127.0.0.1:4321';
  const capability = 'a'.repeat(64);
  try {
   const route = interviewRoutes(fixture.root, 'picks', capability);
   const option = {...fixture.option, question: 'post_composition', stage: 'post-interview',
    context: {kind: 'scene', scene: {n: 1, path: 'evidence/unsupported-scene.json', sha256: digest('{}')}}};
   const bytes = JSON.stringify(option);
   writeFileSync(join(fixture.root, fixture.set.path), bytes);
   const set = {path: fixture.set.path, sha256: digest(bytes)};
   writeFileSync(join(fixture.root, 'project.json'), JSON.stringify({...fixture.project,
    interview: {...(adopted ? {order: fixture.project.interview.order} : {}),
     post: {items: [{id: 'post_composition', pending_options: set}]}},
   }));
   for (const request of [new Request(origin + '/api/interview'), new Request(origin + '/api/interview/picks', {
    method: 'POST', headers: {origin, 'X-Review-Capability': capability, 'Content-Type': 'application/json'}, body: '{}',
   })]) {
    const response = await route(request, origin);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({error: 'INTERVIEW_CONTEXT_KIND_UNSUPPORTED'});
   }
  } finally {fixture.dispose();}
 });
}
