/** #896 browser regression. Run on ordinary Nova; only public synthetic assets. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {partsDifferenceJobFixture} from './helpers/parts-difference-job-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';

const outIndex = Bun.argv.indexOf('--out');
if (outIndex >= 0 && !Bun.argv[outIndex + 1]) throw new Error('--out requires a directory');
const output = resolve(outIndex < 0 ? 'artifacts/parts-difference-job-896' : Bun.argv[outIndex + 1]!);
await mkdir(output, {recursive: true});
const work = await mkdtemp(join(tmpdir(), 'parts-difference-job-896-'));
let page: InputCdpSession | undefined;
const report: Record<string, unknown> = {
  scope: 'Public synthetic parts job, EN/KO; browser HTTP and recovery regression',
  baseline: '5aba812: actual Difference request must fail 400 JOB_REQUEST_INVALID before the route',
  pngControl: 'Planted HTTP 400 UI boundary only; real decoder serialization is covered by tests/parts-difference-job.test.ts',
};
type DifferenceCall = {
  mode: string; url: string; query: [string, string][]; effectiveUrl: string;
  effectiveQuery: [string, string][]; status: number; contentType: string | null;
  body: string | null; code: string | null; bytes: number; png: boolean;
};
type ViewState = {
  selected: string[]; header: string; footer: string; timeOrigin: number;
  footerTitle: string; footerLine: {height: number; whiteSpace: string; clientHeight: number; scrollHeight: number};
  panes: {id: string; hidden: boolean; display: string; visibility: string; visible: boolean}[];
  canvases: {id: string; width: number; height: number; data: string; opaque: number; red: number}[];
};
async function wait(expression: string, name: string) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await page!.evaluate<boolean>(expression)) return;
    await Bun.sleep(50);
  }
  throw new Error('PARTS_DIFFERENCE_896_WAIT ' + name + ' ' + await page!.evaluate('document.body.innerText'));
}
// Same ready/busy contract and two painted frames as parts-setup-browser.ts.
async function settled() {
  await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`, 'paint');
  await page!.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function menu(view: 'compare' | 'rig' | 'difference') {
  if (!await page!.evaluate<boolean>(`document.querySelector('#view-menu').open`)) await click(page!, '#view-menu summary');
  await click(page!, '[data-view="' + view + '"]');
}
async function shot(name: string) {await writeFile(join(output, name + '.png'), await page!.screenshot());}
async function state() {
  return page!.evaluate<ViewState>(`(() => ({
    selected: [...document.querySelectorAll('#view-menu [data-view][aria-pressed="true"]')].map(n=>n.dataset.view),
    header: document.querySelector('#workspace-act-row #review-message').textContent,
    footer: document.querySelector('#message').textContent,
    footerTitle: document.querySelector('#message').title,
    footerLine: {
      height: document.querySelector('footer.status-bar').getBoundingClientRect().height,
      whiteSpace: getComputedStyle(document.querySelector('#message')).whiteSpace,
      clientHeight: document.querySelector('#message').clientHeight,
      scrollHeight: document.querySelector('#message').scrollHeight
    },
    timeOrigin: performance.timeOrigin,
    panes: ['reference-pane','rig-pane'].map(id=>{const n=document.getElementById(id),s=getComputedStyle(n),r=n.getBoundingClientRect();return {id,hidden:n.hidden,display:s.display,visibility:s.visibility,visible:!n.hidden&&s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};}),
    canvases: [...document.querySelectorAll('#parts-canvas,#reference-content canvas')].map(c=>{
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let opaque=0,red=0;
      for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]>0)opaque++;if(pixels[i]>0&&pixels[i+1]===0&&pixels[i+2]===0&&pixels[i+3]>0)red++;}
      return {id:c.id,width:c.width,height:c.height,data:c.toDataURL(),opaque,red};
    })
  }))()`);
}
function receipt(value: ViewState) {
  return {...value, canvases: value.canvases.map(({data, ...canvas}) => ({...canvas,
    sha256: createHash('sha256').update(data).digest('hex')}))};
}
async function calls() {return page!.evaluate<DifferenceCall[]>('window.__partsDifference896.calls');}
async function installFetchProbe() {
  // Install only after ready: no product source instrumentation or initial-load interception.
  await page!.evaluate(`(() => {
    const nativeFetch=window.fetch.bind(window);
    const probe=window.__partsDifference896={mode:'actual',calls:[]};
    window.fetch=async(input,init)=>{
      const original=new URL(input instanceof Request?input.url:String(input),location.href);
      if(!/\\/stage-parts\\/difference\\/\\d+$/.test(original.pathname))return nativeFetch(input,init);
      const mode=probe.mode,effective=new URL(original);
      if(mode==='unavailable')effective.pathname=effective.pathname.replace(/\\/\\d+$/,'/99');
      // Explicit planted HTTP boundary, NOT evidence of an actual decoder failure.
      const response=mode==='png-http'
        ?new Response(JSON.stringify({ok:false,error:{code:'PARTS_DIFFERENCE_PNG',message:'PARTS_DIFFERENCE_PNG'}}),{status:400,headers:{'Content-Type':'application/json'}})
        :await nativeFetch(mode==='unavailable'?(input instanceof Request?new Request(effective.href,input):effective.href):input,init);
      const bytes=new Uint8Array(await response.clone().arrayBuffer());
      const png=[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n);
      const body=png?null:new TextDecoder().decode(bytes);let code=null;
      if(body){try{code=JSON.parse(body).error?.code??null;}catch{}}
      probe.calls.push({mode,url:original.href,query:[...original.searchParams],effectiveUrl:effective.href,effectiveQuery:[...effective.searchParams],status:response.status,contentType:response.headers.get('content-type'),body,code,bytes:bytes.length,png});
      return response;
    };
    return true;
  })()`);
}
async function difference(mode: 'actual' | 'unavailable' | 'png-http', key: string) {
  const before = (await calls()).length;
  await page!.evaluate(`window.__partsDifference896.mode=${JSON.stringify(mode)}`);
  await menu('difference');
  await wait(`window.__partsDifference896.calls.length>${before}`, 'Difference response');
  await settled();
  const observed = await calls();
  report[key + '-requests'] = observed;
  const call = observed[before]!;
  assert.deepEqual(call.query, [['threshold', '0'], ['footprints', 'false']]);
  assert.equal(call.mode, mode);
  return call;
}
async function successfulDifference(key: string) {
  const call = await difference('actual', key);
  const painted = await state();
  report[key] = receipt(painted);
  await shot(key);
  // On 5aba812 this is RED with the captured real 400/JOB_REQUEST_INVALID.
  assert.equal(call.status, 200, JSON.stringify(call));
  assert.equal(call.contentType, 'image/png');
  assert.equal(call.png, true);
  assert.ok(call.bytes > 8);
  assert.deepEqual(painted.selected, ['difference']);
  const canvas = painted.canvases.find(c => c.id === 'parts-canvas');
  assert.ok(canvas && canvas.width > 0 && canvas.height > 0 && canvas.opaque > 0 && canvas.red > 0, 'Difference must draw nonblank red pixels');
}
async function declaredCase(lang: 'en' | 'ko') {
  const f = await partsDifferenceJobFixture();
  try {
    await f.ask(f.publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    await page!.goto(f.locator + '/?lang=' + lang + '#cap=' + f.credentials.ui);
    await settled();
    await installFetchProbe();
    await click(page!, '[data-part-list] button[data-slot="body"]');
    await settled();
    await menu('compare'); await settled();
    await successfulDifference(lang + '-actual');
    for (const mode of ['unavailable', 'png-http'] as const) {
      const key = lang + '-' + mode;
      await menu('compare'); await settled();
      const before = await state();
      assert.deepEqual(before.selected, ['compare']);
      assert.ok(before.panes.every(p => p.visible), 'both Side by side panes must be visible');
      assert.ok(before.canvases.length >= 2 && before.canvases.every(c => c.opaque > 0));
      report[key + '-before'] = receipt(before);
      await shot(key + '-before');
      const call = await difference(mode, key);
      const code = mode === 'unavailable' ? 'PARTS_DIFFERENCE_UNAVAILABLE' : 'PARTS_DIFFERENCE_PNG';
      assert.equal(call.status, 400);
      assert.equal(call.code, code);
      assert.deepEqual(JSON.parse(call.body!), {ok: false, error: {code, message: code}});
      if (mode === 'unavailable') assert.match(new URL(call.effectiveUrl).pathname, /\/difference\/99$/);
      await wait(`document.querySelector('#stage-layout').getAttribute('aria-busy')==='false' &&
        document.querySelector('#workspace-act-row:not([hidden]) #review-message.error')?.textContent===${JSON.stringify(code)}`, 'exact act-row refusal');
      const after = await state();
      report[key + '-after'] = receipt(after);
      await shot(key + '-after');
      assert.equal(after.header, code);
      assert.equal(after.footer, before.footer, 'failure must preserve footer status');
      assert.equal(after.footerTitle, before.footerTitle, 'failure must preserve footer tooltip');
      assert.equal(after.footerLine.height, before.footerLine.height);
      assert.equal(after.footerLine.whiteSpace, 'nowrap');
      assert.ok(after.footerLine.clientHeight > 0 && after.footerLine.scrollHeight <= after.footerLine.clientHeight + 1, 'footer status stays on one line');
      assert.deepEqual(after.selected, ['compare']);
      assert.deepEqual(after.canvases, before.canvases, 'failure must preserve exact toDataURL bytes and canvas pixels');
      assert.deepEqual(after.panes, before.panes, 'failure must preserve pane visibility');
      assert.equal(after.timeOrigin, before.timeOrigin, 'no reload during failure');
      // Exercise a real view transition, then return using the visible Side by side control.
      await menu('rig'); await settled();
      assert.deepEqual((await state()).selected, ['rig']);
      await menu('compare'); await settled();
      const restored = await state();
      assert.deepEqual(restored.selected, ['compare']);
      assert.deepEqual(restored.panes, before.panes);
      assert.deepEqual(restored.canvases, before.canvases);
      assert.equal(restored.timeOrigin, before.timeOrigin);
      report[key + '-restored'] = receipt(restored);
      await shot(key + '-restored');
      await successfulDifference(key + '-retry');
      assert.equal((await state()).timeOrigin, before.timeOrigin);
    }
    // A failed selection redraw must retain the identity attached to the held pixels.
    const held = await state(), count = (await calls()).length;
    await page!.evaluate(`window.__partsDifference896.mode='unavailable'`);
    await click(page!, '[data-part-list] button[data-slot="front"]');
    await wait(`window.__partsDifference896.calls.length>${count}`, 'selected part refusal');
    await settled();
    assert.equal(await page!.evaluate(`document.querySelector('[data-part-list] button[data-slot="body"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await page!.evaluate(`document.querySelector('[data-part-list] button[data-slot="front"]').getAttribute('aria-pressed')`), 'false');
    assert.deepEqual((await state()).canvases, held.canvases, 'held pixels keep their last drawn part identity');
    report[lang + '-selection-refusal'] = receipt(await state());
  } finally {await f.close();}
}
async function missingCase(lang: 'en' | 'ko') {
  const f = await partsDifferenceJobFixture({declared: false});
  try {
    await f.ask(f.publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    await page!.goto(f.locator + '/?lang=' + lang + '#cap=' + f.credentials.ui);
    await settled();
    await installFetchProbe();
    await click(page!, '[data-part-list] button[data-slot="body"]'); await settled();
    await click(page!, '#view-menu summary');
    const unavailable = await page!.evaluate<{disabled: boolean; reason: string; language: string}>(`(() => {const n=document.querySelector('[data-view="difference"]');return {disabled:n.disabled,reason:n.title,language:document.documentElement.lang};})()`);
    report[lang + '-missing-operand'] = unavailable;
    await shot(lang + '-missing-operand');
    assert.equal(unavailable.language, lang);
    assert.equal(unavailable.disabled, true);
    assert.match(unavailable.reason, /PARTS_DIFFERENCE_UNAVAILABLE/);
    assert.match(unavailable.reason, /painting_in_rig/);
    assert.deepEqual(await calls(), [], 'disabled Difference must not request a raster');
  } finally {await f.close();}
}
try {
  page = await launchCdpSession(join(work, 'profile'));
  await page.setViewport(1600, 1000);
  for (const lang of ['en', 'ko'] as const) {
    await declaredCase(lang);
    await missingCase(lang);
  }
  report.result = 'PASS';
  console.log('PARTS_DIFFERENCE_JOB_PASS languages=2 refusalControls=4 missingOperandControls=2 selectionRefusalControls=2');
} catch (error) {
  report.result = 'FAIL'; report.error = String(error);
  if (page) {
    try {report.lastRequests = await calls(); report.lastState = receipt(await state()); await shot('failure');}
    catch (captureError) {report.captureError = String(captureError);}
  }
  throw error;
} finally {
  try {await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
  finally {try {await page?.close();} finally {await rm(work, {recursive: true, force: true});}}
}
