import assert from 'node:assert/strict';
import {join} from 'node:path';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {createJobHostPorts} from '../src/job-api.ts';
import {createJobFront, jobWindowResources, retainedPublicationRoutes} from '../src/job-front.ts';

const fixture = await jobFixture();
let front: ReturnType<typeof createJobFront>;
const statuses: number[] = [];
const server = Bun.serve({hostname:'127.0.0.1', port:0, idleTimeout:0, async fetch(request) {
  if (new URL(request.url).pathname === '/deny-storage')
    return new Response('storage disabled for this fixture', {headers:{'Set-Cookie':'denyStorage=1; Path=/; SameSite=Strict'}});
  const response = await front.fetch(request) ?? new Response(null, {status:404});
  if (new URL(request.url).pathname.endsWith('/ui/displayed')) statuses.push(response.status);
  return response;
}});
const origin = `http://127.0.0.1:${server.port}`;
const resource = jobWindowResources();
front = createJobFront({origin, ports:createJobHostPorts(fixture.session, origin), async resource(name) {
  const bytes = await resource(name);
  if (name !== 'main.js') return bytes;
  return new Blob([`if (document.cookie.includes('denyStorage=1')) Object.defineProperty(window, 'sessionStorage', {
    get() { throw new DOMException('Fixture denied session storage', 'SecurityError'); }
  });\n`, bytes as Blob]);
}, publication:retainedPublicationRoutes(fixture.session)});
const stripped = `${origin}/jobs/${fixture.session.jobId}/?lang=ko`;
const original = `${stripped}#cap=${fixture.credentials.ui}`;
const pages: InputCdpSession[] = [];
async function open(name: string) {
  const page = await launchCdpSession(join(fixture.scratch, name));
  pages.push(page);
  return page;
}
async function measure(page:InputCdpSession, name:string, url:string, expected:number, notice:string|null, reload = false) {
  const before = statuses.length;
  if (reload) await page.evaluate<void>('void setTimeout(() => location.reload(), 50)');
  else await page.goto(url);
  const deadline = Date.now() + 12000;
  let result: {stripped:boolean; notice:string|null} | undefined;
  do {
    result = await page.evaluate<{stripped:boolean; notice:string|null}>(`({
      stripped: !location.hash,
      notice: document.querySelector('[role="status"][title="JOB_CAPABILITY_REQUIRED"], [role="status"][title="JOB_CAPABILITY_LINK_LOST"]')?.textContent ?? null
    })`);
    if (statuses.slice(before).includes(expected) && result.stripped && result.notice === notice) break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  console.log(JSON.stringify({name,statuses:statuses.slice(before),...result}));
  assert.ok(statuses.slice(before).includes(expected));
  assert.deepEqual(result,{stripped:true,notice});
}
try {
  const publication = await fixture.publish();
  await fixture.ask(publication, {kind:'checkpoint', checkpointId:'step-one'});
  const expired = '이 페이지의 접근 권한이 만료됐어요. 에이전트에게 작업을 다시 열어 달라고 요청해 주세요.';
  const missing = '이 페이지가 접근 링크를 잃었어요. 처음 받은 링크를 다시 열어 주세요.';
  const first = await open('first');
  await measure(first,'initial handoff',original,200,null);
  await measure(first,'same-tab reload',stripped,200,null,true);
  const fresh = await open('fresh');
  await measure(fresh,'fresh tab on stripped URL',stripped,403,missing);
  const denied = await open('denied');
  await denied.goto(origin + '/deny-storage');
  await measure(denied,'storage-denied handoff',original,200,null);
  assert.equal(await denied.evaluate<boolean>(`(() => { try { sessionStorage.setItem('probe','1'); return false; } catch { return true; } })()`),true);
  await measure(denied,'storage-denied reload',stripped,403,missing,true);
  await fresh.goto('about:blank');
  await measure(fresh,'host-refused capability',`${stripped}#cap=${'0'.repeat(64)}`,403,expired);
} finally {
  await Promise.allSettled(pages.map(page=>page.close()));
  front.stop();
  await server.stop(true);
  await fixture.close();
}
