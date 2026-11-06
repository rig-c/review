/** Ordinary Nova, after exact-head review. Uses retained Create checkpoints; no producer build. */
import {strict as assert} from 'node:assert';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReview} from '../src/open.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const root=await mkdtemp(join(await realpath(tmpdir()),'rv436-'));
const artifacts=join(process.cwd(),'artifacts','joined-verdict');
await mkdir(artifacts,{recursive:true});
const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const frontPort=probe.port!;probe.stop(true);
const launchOptions={stateDir:join(root,'state'),frontPort,frontIdleMs:1200,graceMs:400,idleMs:15000};
const state=[];
const page=await launchCdpSession(join(root,'browser'));
const frame="document.querySelector('.review-stage-panel iframe:not([hidden]):not(.review-interview-frame)')";
const interview="document.querySelector('.review-interview-frame:not([hidden])')";
async function until(expression:string){
  for(let i=0;i<300;i++){
    if(await page.evaluate<boolean>(expression))return;
    await Bun.sleep(30);
  }
  throw new Error('BROWSER_WAIT '+expression+' '+await page.evaluate("document.querySelector('.review-stage-panel')?.textContent"));
}
async function navigate(url:string,lang:string){
  const link=new URL(url);link.searchParams.set('lang',lang);
  await page.goto(link.href);
  await until(`${frame}?.contentDocument?.body.dataset.ready==='true'`);
}
async function chooseStage(stage:number){
  await page.evaluate(`document.querySelector('[data-review-stage="${stage}"]').click()`);
}
async function clickFrame(frameSelector:string,selector:string){
  const {x,y}=await page.evaluate<{x:number;y:number}>(`(()=>{
    const f=${frameSelector}, button=f.contentDocument.querySelector(${JSON.stringify(selector)});
    button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect(), b=f.getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    if(!r.width||!r.height||button.disabled||!button.contains(f.contentDocument.elementFromPoint(x,y)))throw Error('Save is not reachable');
    return {x:b.left+f.clientLeft+x,y:b.top+f.clientTop+y};
  })()`);
  await page.mouse('mouseMoved',x,y);await page.mouse('mousePressed',x,y);await page.mouse('mouseReleased',x,y);
}
try{
  await page.setViewport(1440,1050);
  for(const lang of ['en','ko']){
    const catalog=lang==='en'?enCatalog:koCatalog;
    const fixture=await joinedVerdictFixture(join(root,'parts-'+lang));
    const note=lang==='en'?'  Check the torso seam.\nKeep this wording.  ':'  몸통 이음새 확인.\n이 문구를 유지해 주세요.  ';
    const opened=await openReview({input:fixture.input,project:fixture.project},launchOptions);
    await navigate(opened.url,lang);
    assert.equal(await page.evaluate(`document.documentElement.dataset.inspectionStage`),'1');
    assert.deepEqual(await readdir(fixture.output),[]);
    await page.evaluate(`(()=>{
      const d=${frame}.contentDocument;
      for(const item of d.querySelectorAll('[data-pv-item]')){
        item.click();d.querySelector('[data-pv-outcome][value=clean]').click();
        const mesh=d.querySelector('#pv-mesh-panel select');
        if(mesh){mesh.value='clean';mesh.dispatchEvent(new Event('change'));}
        if(item.dataset.pvItem==='torso'){
          const field=d.getElementById('pv-note');field.value=${JSON.stringify(note)};field.dispatchEvent(new Event('input'));
        }
      }
      d.querySelector('[data-pv-item=torso]').click();d.getElementById('pv-overall').value='approved';
      d.addEventListener('click',e=>{if(e.target.id==='pv-save')d.body.dataset.trustedSave=String(e.isTrusted);},true);
    })()`);
    assert.deepEqual(await readdir(fixture.output),[]);
    const mesh=await page.evaluate<string>(`${frame}.contentDocument.querySelector('#pv-corrections').textContent`);
    assert.match(mesh,/torso.*v 30 t 40/);
    const saveLabel=await page.evaluate<string>(`${frame}.contentDocument.querySelector('#pv-save').textContent`);
    assert.equal(saveLabel,catalog['Save sign-off']);
    await clickFrame(frame,'#pv-save');
    await until(`${frame}.contentDocument.querySelector('#pv-save-status').dataset.result==='saved'`);
    assert.equal(await page.evaluate(`${frame}.contentDocument.body.dataset.trustedSave`),'true');
    await writeFile(join(artifacts,lang+'-verdict.png'),await page.screenshot());
    const names=await readdir(fixture.output);assert.equal(names.length,1);
    const filename=names[0]!,bytes=await readFile(join(fixture.output,filename));
    const verdict=JSON.parse(bytes.toString());
    assert.equal(verdict.schema,'rig-review-parts-verdict/2');
    assert.equal(verdict.status,'approved');assert.equal(verdict.parts.torso.note,note);
    assert.equal(verdict.parts.torso.mesh.outcome,'clean');
    const prefix=new URL(opened.url).pathname;
    const exported=await fetch(new URL(prefix+'api/stage-parts/export/json',opened.url));
    assert.equal(exported.status,200);assert.equal(await exported.text(),bytes.toString());
    await writeFile(join(artifacts,lang+'-'+filename),bytes);
    const refusals=[];
    for(const [stage,reason] of [[3,'RIG_VERSION_UNAVAILABLE'],[4,'DIRECTION_VERSION_UNAVAILABLE']] as const){
      await chooseStage(stage);
      const text=await page.evaluate<string>(`document.querySelector('.review-stage-panel > [role=status]').textContent`);
      assert.match(text,new RegExp('^'+reason));refusals.push(text);
      assert.equal(await page.evaluate(`!!${frame}`),false);
    }
    await writeFile(join(artifacts,lang+'-refusal.png'),await page.screenshot());
    await fixture.assertFixture();

    const {partsVerdictDir:_,...project}=fixture.project;
    const readonly=await openReview({input:fixture.input,project},launchOptions);
    await navigate(readonly.url,lang);
    const readOnlyReason=await page.evaluate<string>(`${frame}.contentDocument.querySelector('#pv-load').textContent`);
    assert.match(readOnlyReason,/^PARTS_VERDICT_READ_ONLY/);
    assert.equal(await page.evaluate(`${frame}.contentDocument.querySelector('.pv-verdict').hidden`),true);

    const second=await joinedVerdictFixture(join(root,'interview-'+lang),'2-rigging-answers');
    const stage2=await openReview({input:second.input,project:second.project},launchOptions);
    await navigate(stage2.url,lang);await chooseStage(2);
    await until(`!!${interview}?.contentDocument?.querySelector('main select')`);
    await page.evaluate(`(()=>{
      const d=${interview}.contentDocument,s=d.querySelector('main select');
      s.selectedIndex=[...s.options].findIndex(o=>o.text.includes('chain-bones'));s.dispatchEvent(new Event('change'));
      for(const choice of d.querySelectorAll('form input[value=keep]'))choice.click();
    })()`);
    await clickFrame(interview,'form button[type=submit]');
    await until(`${interview}.contentDocument.querySelector('form [role=status]').textContent===${JSON.stringify(catalog['interview.saved'])}`);
    await writeFile(join(artifacts,lang+'-picks.png'),await page.screenshot());
    const picks=join(second.project.root,second.project.picksDir);
    const picked=JSON.parse(await readFile(join(picks,(await readdir(picks))[0]!),'utf8'));
    assert.equal(picked.picks.length,3);assert(picked.picks.every((choice:{option_id:string})=>choice.option_id==='keep'));
    assert.deepEqual(await readdir(second.output),[]);await second.assertFixture();
    state.push({lang,filename,mesh,saveLabel,refusals,readOnlyReason,picked,source:verdict.source});
  }
  await writeFile(join(artifacts,'receipt.json'),JSON.stringify(state,null,2)+'\n');
}finally{
  await page.close();
  await Bun.sleep(2200);
  await rm(root,{recursive:true,force:true});
}
