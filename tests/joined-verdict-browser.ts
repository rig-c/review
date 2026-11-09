/** Ordinary Nova, after exact-head review. Uses retained Create checkpoints; no producer build. */
import {strict as assert} from 'node:assert';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportPartsVerdict} from '../src/parts-view.ts';
import {openReview} from '../src/open.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

export async function clickJoinedFrame(page:InputCdpSession,frameSelector:string,selector:string){
  const {x,y}=await page.evaluate<{x:number;y:number}>(`(()=>{
    const f=${frameSelector}, button=f.contentDocument.querySelector(${JSON.stringify(selector)});
    button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect(), b=f.getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    if(!r.width||!r.height||button.disabled||!button.contains(f.contentDocument.elementFromPoint(x,y)))throw Error('Save is not reachable');
    return {x:b.left+f.clientLeft+x,y:b.top+f.clientTop+y};
  })()`);
  await page.mouse('mouseMoved',x,y);await page.mouse('mousePressed',x,y);await page.mouse('mouseReleased',x,y);
}

/** The joined boundary exposes the named refusal through the existing comment control. */
export async function assertJoinedIssueUnsupported(page:InputCdpSession,frameSelector:string,message:string):Promise<void> {
  await clickJoinedFrame(page,frameSelector,'#stage-comment');
  const state=await page.evaluate<{reason:string;title:string;list:string;composer:boolean}>(`(()=>{
    const d=${frameSelector}.contentDocument;
    return {reason:d.getElementById('stage-comment-refusal').textContent,title:d.getElementById('stage-comment').title,
      list:d.getElementById('stage-comment-list').textContent,composer:!!d.querySelector('.stage-comment-composer')};
  })()`);
  assert.equal(state.reason,message);
  assert.equal(state.title,message);
  assert(state.list.includes(message));
  assert.equal(state.composer,false);
  await clickJoinedFrame(page,frameSelector,'#stage-comment');
}

async function main(){
  const root=await mkdtemp(join(await realpath(tmpdir()),'rv436-'));
  const artifacts=join(process.cwd(),'artifacts','joined-verdict');
  await mkdir(artifacts,{recursive:true});
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
  const frontPort=probe.port!;probe.stop(true);
  const previousState=process.env.RIG_REVIEW_STATE_DIR;
  process.env.RIG_REVIEW_STATE_DIR=join(root,'state');
  const launchOptions={stateDir:join(root,'state'),frontPort,frontIdleMs:1200,graceMs:400,idleMs:15000};
  const state=[];
  const wrapOnly=process.env.RV436_WRAP_ONLY==='1';
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

  try{
    await page.setViewport(1440,1050);
    for(const lang of ['en','ko']){
      const catalog=lang==='en'?enCatalog:koCatalog;
      const fixture=await joinedVerdictFixture(join(root,'parts-'+lang));
      const opened=await openReview({input:fixture.input,project:fixture.project},launchOptions);
      await navigate(opened.url,lang);
      assert.equal(await page.evaluate(`document.documentElement.dataset.inspectionStage`),'1');
      assert.deepEqual(await readdir(fixture.output),[]);
      await page.evaluate(`(()=>{const d=${frame}.contentDocument;d.addEventListener('click',e=>{if(e.target.id==='pv-save')d.body.dataset.trustedSave=String(e.isTrusted);},true);})()`);
      await assertJoinedIssueUnsupported(page,frame,catalog['PARTS_JOINED_ISSUE_UNSUPPORTED']!);
      assert.deepEqual(await readdir(fixture.output),[]);
      const mesh=await page.evaluate<string>(`${frame}.contentDocument.querySelector('#pv-corrections').textContent`);
      assert.match(mesh,/torso.*v 30 t 40/);
      const saveLabel=await page.evaluate<string>(`${frame}.contentDocument.querySelector('#pv-save').textContent`);
      assert.equal(saveLabel,catalog['Save sign-off']);
      await clickJoinedFrame(page,frame,'#pv-save');
      await until(`${frame}.contentDocument.querySelector('#pv-save-status').dataset.result==='saved'`);
      assert.equal(await page.evaluate(`${frame}.contentDocument.body.dataset.trustedSave`),'true');
      const names=await readdir(fixture.output);assert.equal(names.length,1);
      const filename=names[0]!,bytes=await readFile(join(fixture.output,filename));
      const verdict=JSON.parse(bytes.toString());
      assert.equal(verdict.schema,'rig-review-parts-verdict/4');
      assert.equal(verdict.status,'approved');
      assert.deepEqual(verdict.issues,[]);
      const prefix=new URL(opened.url).pathname;
      const exported=await fetch(new URL(prefix+'api/stage-parts/export/json',opened.url));
      assert.equal(exported.status,200);assert.equal(await exported.text(),exportPartsVerdict(verdict,'json'));
      assert.deepEqual(await readFile(join(fixture.output,filename)),bytes);
      await writeFile(join(artifacts,lang+'-'+filename),bytes);
      await page.setViewport(780,1050);
      const wrap=await page.evaluate<{
        text:string;rule:string;current:{statusClientWidth:number;statusScrollWidth:number;workspaceClientWidth:number;workspaceScrollWidth:number;lines:number};
        withoutWrap:{statusClientWidth:number;statusScrollWidth:number;workspaceClientWidth:number;workspaceScrollWidth:number;lines:number};
      }>(`(()=>{
        const d=${frame}.contentDocument,status=d.getElementById('pv-save-status'),side=status.closest('[data-parts-stage]');
        const read=()=>{
          const range=d.createRange();range.selectNodeContents(status);
          const lines=new Set([...range.getClientRects()].map(rect=>rect.top)).size;
          return {statusClientWidth:status.clientWidth,statusScrollWidth:status.scrollWidth,
            workspaceClientWidth:side.clientWidth,workspaceScrollWidth:side.scrollWidth,lines};
        };
        const rule=d.defaultView.getComputedStyle(status).overflowWrap,current=read(),before=status.style.overflowWrap;
        let withoutWrap;
        try{status.style.overflowWrap='normal';withoutWrap=read();}
        finally{status.style.overflowWrap=before;}
        return {text:status.textContent,rule,current,withoutWrap};
      })()`);
      await writeFile(join(artifacts,lang+'-verdict.png'),await page.screenshot());
      await writeFile(join(artifacts,lang+'-wrap.json'),JSON.stringify(wrap,null,2)+'\n');
      assert(wrap.text.includes(filename),'Saved status must retain the full filename');
      assert.equal(wrap.rule,'anywhere');
      assert(wrap.current.statusScrollWidth<=wrap.current.statusClientWidth,'Saved status overflows horizontally');
      assert(wrap.current.workspaceScrollWidth<=wrap.current.workspaceClientWidth,'Parts workspace overflows horizontally');
      assert(wrap.current.lines>1,'Expected wrapped status text');
      assert(wrap.withoutWrap.statusScrollWidth>wrap.withoutWrap.statusClientWidth&&
        wrap.withoutWrap.workspaceScrollWidth>wrap.withoutWrap.workspaceClientWidth,'Removing only wrapping must reproduce the overflow');
      await page.setViewport(1440,1050);
      if(wrapOnly){
        await chooseStage(3);
        const reason=await page.evaluate<string>(`document.querySelector('.review-stage-panel > [role=status]').textContent`);
        const partsFrameVisible=await page.evaluate<boolean>(`!!${frame}`);
        await writeFile(join(artifacts,lang+'-stage3.png'),await page.screenshot());
        await writeFile(join(artifacts,lang+'-stage3.json'),JSON.stringify({reason,partsFrameVisible},null,2)+'\n');
        assert.equal(reason,catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']);
        assert.equal(partsFrameVisible,false);
        await fixture.assertFixture();
        state.push({lang,filename,wrap,stage3:reason});
        continue;
      }
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
      assert.equal(await page.evaluate(`${frame}.contentDocument.querySelector('#parts-actions').hidden`),true);

      const second=await joinedVerdictFixture(join(root,'interview-'+lang),'2-rigging-answers');
      const stage2=await openReview({input:second.input,project:second.project},launchOptions);
      await navigate(stage2.url,lang);await chooseStage(2);
      await until(`!!${interview}?.contentDocument?.querySelector('main select')`);
      await page.evaluate(`(()=>{
        const d=${interview}.contentDocument,s=d.querySelector('main select');
        s.selectedIndex=[...s.options].findIndex(o=>o.text.includes('chain-bones'));s.dispatchEvent(new Event('change'));
        for(const choice of d.querySelectorAll('form input[value=keep]'))choice.click();
      })()`);
      await clickJoinedFrame(page,interview,'form button[type=submit]');
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
    if(previousState===undefined)delete process.env.RIG_REVIEW_STATE_DIR;else process.env.RIG_REVIEW_STATE_DIR=previousState;
  }

}

if(import.meta.main)await main();
