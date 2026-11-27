/** #1159/#1232: the shared action row keeps Send comments and no verdict controls in EN and KO. */
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
 width:number;dpr:number;row:Box;headline:Box;send:Box;status:Box|null;
 headlineText:string;sendText:string;notice:string;state:string;disabled:boolean;primary:boolean;verdictVisible:boolean;
};
const readback=`(()=>{
 const byId=id=>document.getElementById(id);
 const box=node=>node?.checkVisibility()?node.getBoundingClientRect().toJSON():null;
 const send=byId('send-comments'),headline=byId('workspace-ask-headline');
 return {width:innerWidth,dpr:devicePixelRatio,row:box(byId('workspace-act-row')),headline:box(headline),
  send:box(send),status:box(byId('review-draft-state')),headlineText:headline.textContent,sendText:send.textContent,
  notice:document.querySelector('#review-message.error')?.textContent??'',state:byId('review-draft-state').textContent,
  disabled:send.disabled,primary:send.classList.contains('primary'),
  verdictVisible:['save','request-changes','request-changes-reason'].some(id=>!!box(byId(id)))};
})()`;
const outIndex=Bun.argv.indexOf('--out');
const output=resolve(outIndex<0?'artifacts/request-changes-reason':Bun.argv[outIndex+1]!);
await mkdir(output,{recursive:true});
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
 const {send,row,headline,status}=reading;
 assert.ok(send.left>=row.left&&send.right<=row.right&&send.top>=row.top&&send.bottom<=row.bottom,label+' Send comments inside the act row');
 for(const other of [headline,status]){
  if(!other)continue;
  assert.ok(send.right<=other.left+.5||send.left>=other.right-.5||send.bottom<=other.top+.5||send.top>=other.bottom-.5,label+' Send comments does not overlap act content');
 }
}

for(const {lang,width,stage,close} of cases){
 const label=`${stage}-${lang}-${width}${close?'-close':''}`;
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});
 const profile=await mkdtemp(join(output,'chrome-'));
 let page:InputCdpSession|undefined;
 try{
  await fixture.publish(stage);
  const target=new URL(fixture.host.ownerUrl);target.searchParams.set('lang',lang);
  let send:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
  page=await launchCdpSession(profile,{onEvent:(event,control)=>{if(event.sessionId)send=control;}});
  assert.ok(send);
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:2,mobile:false});
  await page.goto(target.href,lang);
  await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.querySelector('#send-comments')?.checkVisibility()`);
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
  assert.equal(initial.width,width);assert.equal(initial.dpr,2);
  assert.equal(initial.disabled,true);assert.equal(initial.primary,true);assert.equal(initial.verdictVisible,false);
  assert.equal(initial.headlineText,catalog["We're looking at the work together. Leave your thoughts as comments."]);
  assert.equal(initial.sendText,catalog['Send comments']);
  verifyGeometry(initial,label);
  const x=initial.send.left+initial.send.width/2,y=initial.send.top+initial.send.height/2;
  await page.mouse('mousePressed',x,y);
  await page.mouse('mouseReleased',x,y);
  assert.deepEqual(await page.evaluate<Reading>(readback),initial,label+' disabled click leaves the act bar unchanged');
  if(close){
   await fixture.finish();
   await wait(page,`document.querySelector('#review-message.error')?.textContent===${JSON.stringify(catalog['job.closed'])}`);
   const closed=await capture('after');
   assert.equal(closed.verdictVisible,false);
   assert.equal(closed.send,null);
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
  assert.equal(after.verdictVisible,false);
  assert.equal(after.disabled,false,'a general or pinned comment can be sent on every live screen');
  assert.equal(after.primary,true);
  assert.equal(after.notice,'','general Parts comments need no pin');
  verifyGeometry(after,label);
  console.log('SEND_COMMENTS_CASE',label,pin?'pin':'general',JSON.stringify({disabled:after.disabled,notice:after.notice}));
 }finally{
  try{await page?.close();}finally{await fixture.close();await rm(profile,{recursive:true,force:true});}
 }
}
console.log('SEND_COMMENTS_LAYOUT_PASS',cases.length);
