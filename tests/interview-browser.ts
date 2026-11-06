/** Bounded Nova harness. Inputs come from pinned create's generator and public writers. */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setSystemTime } from 'bun:test';
import { digest } from '../src/interview-project.ts';
import { startInterviewServer } from '../src/interview-server.ts';
import { launchCdpSession } from './parts-explorer-browser.ts';

const [historyRoot, liveRoot, artifacts] = process.argv.slice(2);
if (!historyRoot || !liveRoot || !artifacts) throw Error('Supply generated history, registered live project and evidence directory');
const out = 'scratch/review-picks';
const seal = async (root: string) => {
  const paths = (await readdir(root,{recursive:true,withFileTypes:true})).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath,entry.name)).filter(path => !path.startsWith(join(root,out) + '/')).sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path.slice(root.length + 1),digest(await readFile(path))])));
};
const histories = await seal(historyRoot), liveInputs = await seal(liveRoot);
const capturedAt = '2026-11-15T11:03:00.000Z';
setSystemTime(new Date(capturedAt));
await mkdir(artifacts,{recursive:true});
const profile = await mkdtemp(join(tmpdir(),'iv368-'));
const browser = await launchCdpSession(join(profile,'p'));
const servers: Awaited<ReturnType<typeof startInterviewServer>>[] = [];
const until = async (expression: string) => {
  for (let i = 0; i < 180; i++) {
    if (await browser.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw Error('Interview browser condition unavailable: ' + expression);
};
const navigate = async (launch: string, lang: string, setId: string) => {
  const url = new URL(launch); url.searchParams.set('lang',lang);
  await browser.goto(url.href);
  await until('!!document.querySelector("main select")');
  await browser.evaluate(`(()=>{const s=document.querySelector('main select');s.selectedIndex=[...s.options].findIndex(o=>o.text.includes(${JSON.stringify(' · ' + setId)}));s.dispatchEvent(new Event('change'));})()`);
  await until('document.querySelector("aside img")?.naturalWidth > 0');
};
const selectTorso = async () => {
  await browser.evaluate(`[...document.querySelectorAll('aside button')].find(button=>button.textContent==='torso').click()`);
  await until('document.querySelector("aside img[alt=torso]")?.naturalWidth > 0');
};
const readSet = async (root: string, id: string) => {
  const bytes = await readFile(join(root,'evidence/interview',id+'.json'));
  return {snapshot:JSON.parse(bytes.toString('utf8')),sha256:digest(bytes)};
};
const verifyOptions = async (root: string, id: string) => {
  const {snapshot,sha256} = await readSet(root,id);
  const actual = await browser.evaluate(`[...document.querySelectorAll('fieldset fieldset')].map(group=>[...group.querySelectorAll('label.interview-option')].map(label=>({
    id:label.querySelector('input').value,label:label.querySelector('strong').textContent,effect:label.querySelector('span').textContent,
    reason:label.querySelector('b')?label.querySelectorAll('span')[1].textContent:null
  })))`);
  assert.deepEqual(actual,snapshot.asks.map((ask:{options:{id:string;label:string;effect:string;reason?:string}[]}) =>
    ask.options.map(option => ({id:option.id,label:option.label,effect:option.effect,reason:option.reason??null}))));
  const provenance = await browser.evaluate<string>('document.querySelector("form > p").textContent');
  assert(provenance.includes(snapshot.drafted_by) && provenance.includes(snapshot.drafted_at));
  assert((await browser.evaluate<string>('document.querySelector("form code").textContent')).includes(sha256));
  return {sha256, asks:snapshot.asks.length};
};
const results: unknown[] = [];
try {
  const history = await startInterviewServer(historyRoot,out,0);
  const live = await startInterviewServer(liveRoot,out,0);
  servers.push(history,live);
  await browser.setViewport(1360,950);
  for (const lang of ['en','ko']) {
    await navigate(history.url,lang,'example-bones');
    const options = await verifyOptions(historyRoot,'example-bones');
    const names = await browser.evaluate<string[]>('[...document.querySelectorAll("aside button")].map(button=>button.textContent)');
    const {snapshot} = await readSet(historyRoot,'example-bones');
    const parts = snapshot.context.parts as {path:string;files:{path:string;sha256:string}[]};
    const manifestPath = parts.path + '/parts.json';
    const manifestBytes = await readFile(join(historyRoot,manifestPath));
    assert.equal(digest(manifestBytes),parts.files.find(file=>file.path===manifestPath)?.sha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {parts:{name:string;w:number;h:number}[]};
    assert.deepEqual(names,manifest.parts.map(part=>part.name));
    const images = [];
    for (const {name,w,h} of manifest.parts) {
      await browser.evaluate(`[...document.querySelectorAll('aside button')].find(button=>button.textContent===${JSON.stringify(name)}).click()`);
      await until('document.querySelector("aside img")?.naturalWidth > 0');
      const src = await browser.evaluate<string>('document.querySelector("aside img").src');
      const served = digest(Buffer.from(await (await fetch(src)).arrayBuffer()));
      const partPath = parts.path + '/parts/' + name + '.png';
      assert.equal(served,parts.files.find(file=>file.path===partPath)?.sha256);
      assert.equal(served,digest(await readFile(join(historyRoot,partPath))));
      const size = await browser.evaluate<number[]>('(()=>{const img=document.querySelector("aside img");return [img.naturalWidth,img.naturalHeight];})()');
      assert.deepEqual(size,[w,h]);
      images.push({name,sha256:served,width:w,height:h});
    }
    assert.equal(await browser.evaluate('document.documentElement.lang'),lang);
    assert.equal(await browser.evaluate('document.querySelector(".interview-option b").textContent'),lang==='en'?'AI recommendation':'AI 추천');
    await selectTorso();
    await writeFile(join(artifacts,'historical-parts-'+lang+'.png'),await browser.screenshot());
    await navigate(history.url,lang,'example-reference');
    assert.equal(await browser.evaluate('document.querySelectorAll("aside button").length'),1);
    assert.equal(await browser.evaluate('document.querySelector("aside p").textContent'),lang==='en'?'This set has no bound separated parts.':'이 세트에 바인딩된 분리 파츠가 없습니다.');
    await writeFile(join(artifacts,'direction-source-'+lang+'.png'),await browser.screenshot());
    results.push({lang, ...options,images});
  }
  const liveCases = [{id:'live-bones',kind:'other',lang:'en'}, {id:'live-motion',kind:'auto',lang:'ko'}];
  const words = '다른 방향\nKeep the final spaces.  \ne\u0301';
  const note = 'note  \n끝';
  const expectedOutputs: string[] = [];
  for (const {id,kind,lang} of liveCases) {
    await navigate(live.url,lang,id);
    const {sha256} = await verifyOptions(liveRoot,id);
    assert.equal(await browser.evaluate('document.querySelectorAll("input:checked").length'),0);
    await browser.evaluate('document.querySelector("button[type=submit]").click()');
    assert.deepEqual(await readdir(join(liveRoot,out)),expectedOutputs);
    await browser.evaluate(`(()=>{
      const RealDate=Date;globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[${JSON.stringify(capturedAt)}]));}static now(){return Date.parse(${JSON.stringify(capturedAt)});}};
      const groups=[...document.querySelectorAll('fieldset fieldset')];
      groups.forEach((group,index)=>group.querySelector('input[value="'+(index===0?${JSON.stringify(kind)}:'keep')+'"]').click());
      const edit=(field,value)=>{field.value=value;field.dispatchEvent(new Event('input'));};
      if(${JSON.stringify(kind)}==='other')edit(groups[0].querySelector('textarea'),${JSON.stringify(words)});
      edit(document.querySelector('form > fieldset > label > textarea'),${JSON.stringify(note)});
      document.querySelector('button[type=submit]').click();
    })()`);
    await until('document.querySelector("form [role=status]").textContent.includes(' + JSON.stringify(lang==='en'?'Picks saved.':'선택 기록을 저장했습니다.') + ')');
    const filename = sha256 + '.json';
    expectedOutputs.push(filename);
    const saved = JSON.parse(await readFile(join(liveRoot,out,filename),'utf8'));
    assert.equal(saved.schema,'rig-review/interview-picks@1');
    assert.equal(saved.picks[0].option_id,kind);
    assert.equal(saved.picks[0].other_text,kind==='other'?words:undefined);
    assert.equal(saved.note,note);
    assert.equal(saved.at,capturedAt);
    await navigate(live.url,lang,id);
    assert.equal(await browser.evaluate('document.querySelector("input:checked").value'),kind);
    assert.equal(await browser.evaluate('document.querySelector("form > fieldset > label > textarea").value'),note);
    await selectTorso();
    await writeFile(join(artifacts,'live-'+kind+'-'+lang+'.png'),await browser.screenshot());
    results.push({id,kind,lang,filename,saved});
  }
  assert.deepEqual(await seal(historyRoot),histories);
  assert.deepEqual(await seal(liveRoot),liveInputs);
  await writeFile(join(artifacts,'report.json'),JSON.stringify({results,histories,liveInputs},null,2)+'\n');
  console.log('EN/KO fixture options, bound PNGs, explicit Other/Auto, reopen and immutable inputs passed');
} finally {
  await browser.close();
  for (const server of servers) server.stop();
  setSystemTime();
  await rm(profile,{recursive:true,force:true});
}
