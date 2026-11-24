/** #1159: the shared verdict controls explain the zero-comment refusal in EN and KO. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl as click,type PartsViewRect} from './helpers/parts-view-shots.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

type Box=PartsViewRect;
type Reading={
 width:number;dpr:number;row:Box;headline:Box;approve:Box;changes:Box;status:Box|null;reason:Box|null;reasonText:Box|null;
 text:string;title:string;notice:string;state:string;disabled:boolean;oneLine:boolean;describedBy:string|null;
};
const readback=`(()=>{
 const byId=id=>document.getElementById(id);
 const box=node=>node?.getClientRects().length?node.getBoundingClientRect().toJSON():null;
 const changes=byId('request-changes'),reason=byId('request-changes-reason'),range=document.createRange();
 if(reason)range.selectNodeContents(reason);
 return {width:innerWidth,dpr:devicePixelRatio,row:box(byId('workspace-act-row')),headline:box(byId('workspace-ask-headline')),
  approve:box(byId('save')),changes:box(changes),status:box(byId('review-draft-state')),reason:box(reason),
  reasonText:reason?.checkVisibility()?range.getBoundingClientRect().toJSON():null,
  text:reason?.textContent??'',title:changes.title,notice:byId('review-message').textContent,
  state:byId('review-draft-state').textContent,disabled:changes.disabled,describedBy:changes.getAttribute('aria-describedby'),
  oneLine:!!reason&&range.getClientRects().length===1&&range.getBoundingClientRect().width<=reason.clientWidth+1};
})()`;
const outIndex=Bun.argv.indexOf('--out');
const output=resolve(outIndex<0?'artifacts/request-changes-reason':Bun.argv[outIndex+1]!);
await mkdir(output,{recursive:true});
const failures:string[]=[];
const cases:readonly {lang:'en'|'ko';width:number;stage:'direction'|'rig'|'parts';close?:boolean}[]=[
 ...(['en','ko'] as const).flatMap(lang=>[390,1024,1440].map(width=>({lang,width,stage:'direction' as const}))),
 {lang:'en',width:390,stage:'rig'},
 {lang:'ko',width:390,stage:'rig'},
 {lang:'en',width:1024,stage:'parts'},
 {lang:'en',width:1024,stage:'direction',close:true},
];

async function wait(page:InputCdpSession,expression:string) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(40);}
 throw Error('REQUEST_CHANGES_WAIT '+expression);
}
async function closeDrawer(page:InputCdpSession) {
 const drawer='dialog.workspace-drawer[open]';
 if(!await page.evaluate<boolean>(`!!document.querySelector('${drawer}')`))return;
 await click(page,drawer+' .workspace-drawer-close');
 await wait(page,`!document.querySelector('${drawer}')`);
}
function verifyGeometry(reading:Reading, label:string) {
 const {reason,approve,changes,row,headline,status}=reading;
 if(!reason)return;
 assert.ok(reading.oneLine,label+' reason fits on a single line');
 assert.ok(reason.left>=row.left&&reason.right<=row.right&&reason.top>=row.top&&reason.bottom<=row.bottom,label+' reason inside the act row');
 for(const other of [approve,changes,headline,status]){
  if(!other)continue;
  assert.ok(reason.right<=other.left+.5||reason.left>=other.right-.5||reason.bottom<=other.top+.5||reason.top>=other.bottom-.5,label+' reason does not overlap act content');
 }
 if(reading.width===390){
  assert.ok(reason.top>=changes.bottom-.5,label+' narrow reason below the controls');
  assert.ok(reading.reasonText&&Math.abs(reading.reasonText.right-changes.right)<=1,label+' narrow reason text right-aligned');
 }else{
  assert.ok(approve.right<=reason.left&&reason.right<=changes.left&&reason.top<changes.bottom&&reason.bottom>changes.top,label+' wide reason between the buttons');
 }
}

for(const {lang,width,stage,close} of cases){
 const label=`${stage}-${lang}-${width}${close?'-close':''}`;
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});
 const profile=await mkdtemp(join(output,'chrome-'));
 let page:InputCdpSession|undefined;
 try{
  const publication=await fixture.publish(stage);
  await fixture.ask(publication,stage==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:
   {kind:'review-verdict',stage:stage==='rig'?'rig-review':'direction-review'});
  const target=new URL(fixture.host.ownerUrl);target.searchParams.set('lang',lang);
  let send:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
  page=await launchCdpSession(profile,{onEvent:(event,control)=>{if(event.sessionId)send=control;}});
  assert.ok(send);
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:2,mobile:false});
  await page.goto(target.href,lang);
  await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.querySelector('#request-changes')?.checkVisibility()`);
  await closeDrawer(page);
  const capture=async(name:string)=>{
   await page!.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const reading=await page!.evaluate<Reading>(readback);
   await writeFile(join(output,label+'-'+name+'.json'),JSON.stringify(reading,null,2)+'\n');
   if(stage==='direction')await writeFile(join(output,label+'-'+name+'.png'),await page!.screenshot());
   return reading;
  };
  const initial=await capture('before');
  const catalog=lang==='en'?enCatalog:koCatalog;
  const key=stage==='rig'?'Add a comment or an edit where changes are needed.':'Add a comment where changes are needed.';
  assert.equal(initial.width,width);assert.equal(initial.dpr,2);
  assert.equal(initial.disabled,true);assert.equal(initial.title,catalog[key]);
  const x=initial.changes.left+initial.changes.width/2,y=initial.changes.top+initial.changes.height/2;
  await page.mouse('mousePressed',x,y);
  await page.mouse('mouseReleased',x,y);
  assert.deepEqual(await page.evaluate<Reading>(readback),initial,label+' disabled click leaves the act bar unchanged');
  if(!initial.reason)failures.push(label+' missing visible zero-comment reason');
  else{
   assert.equal(initial.text,catalog[key]);
   assert.equal(initial.describedBy,'request-changes-reason');
   verifyGeometry(initial,label);
  }
  if(close){
   await fixture.finish();
   await wait(page,`document.querySelector('#review-message.error')?.textContent===${JSON.stringify(catalog['job.closed'])}`);
   const closed=await capture('after');
   assert.equal(closed.reason,null);
   assert.equal(closed.describedBy,null);
   console.log('REQUEST_CHANGES_CASE',label,JSON.stringify({notice:closed.notice,state:closed.state}));
   continue;
  }
  const pin=stage==='direction'&&width===1440;
  if(pin){
   await click(page,'#stage-comment');
   const point=await page.evaluate<{x:number;y:number}>(`(()=>{
    const r=document.getElementById('rig-viewport').getBoundingClientRect();
    return {x:r.left+r.width*.54,y:r.top+r.height*.49};
   })()`);
   await page.mouse('mouseMoved',point.x,point.y);
   await page.mouse('mousePressed',point.x,point.y);
   await page.mouse('mouseReleased',point.x,point.y);
  }else{
   if(!await page.evaluate<boolean>(`document.querySelector('[data-comment-general]')?.checkVisibility()===true`))await click(page,'#stage-comment');
   await click(page,'[data-comment-general]');
  }
  await wait(page,`!!document.querySelector('.stage-comment-composer input')`);
  await page.evaluate<void>(`(()=>{
   const form=document.querySelector('.stage-comment-composer');
   form.querySelector('input').value='Public fixture comment';
   form.requestSubmit();
  })()`);
  await wait(page,`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-summary').length===1`);
  await closeDrawer(page);
  const after=await capture(pin?'after-pin':'after-comment');
  assert.equal(after.reason,null);assert.equal(after.describedBy,null);
  assert.equal(after.disabled,stage==='parts','a Parts general comment still needs a part pin');
  if(stage==='parts'){
   assert.equal(after.title,catalog['Request changes needs at least one comment pinned to a part.']);
   assert.equal(after.notice,after.title);
  }
  console.log('REQUEST_CHANGES_CASE',label,pin?'pin':'general',JSON.stringify({reason:!!initial.reason,title:initial.title,afterDisabled:after.disabled,afterNotice:after.notice}));
 }finally{
  try{await page?.close();}finally{await fixture.close();await rm(profile,{recursive:true,force:true});}
 }
}
assert.deepEqual(failures,[],'visible reason on every zero-comment verdict');
console.log('REQUEST_CHANGES_REASON_PASS',cases.length);
