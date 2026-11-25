/** #1172: the shared toolbar wraps whole controls without changing the control set. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PNG} from 'pngjs';
import {parseOpenInputs} from '../src/cli.ts';
import {loadOpenPackage} from '../src/open.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl as click, type PartsViewRect} from './helpers/parts-view-shots.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const arg=(name:string)=>{const at=Bun.argv.indexOf(name);return at<0?undefined:Bun.argv[at+1];};
const output=resolve(arg('--out')??'artifacts/view-toolbar-wrap');
const baselineCss=arg('--baseline-css');
const directionOnly=Bun.argv.includes('--direction-only');
const languages=['en','ko'] as const;
const order=['zoom-in','zoom-out','fit','native-one','view-menu'];
const settle='new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))';
const standaloneReady='!document.body.inert && !!document.querySelector("#stage-comment-list")';
const jobReady='document.body.dataset.ready==="true" && !document.body.inert && !!document.querySelector("#view-menu")';

type Reading={
 width:number;lang:string;dpr:number;bar:PartsViewRect;client:number;scroll:number;order:string[];clipped:string[];
 menu:PartsViewRect|null;summary:PartsViewRect;
};
type ReadingRow={name:string;state:string;reading:Reading};
type Target={screen:string;url:string;ready:string;widths:number[]};
const readback=`(()=>{
 const bar=document.querySelector('.workspace-main-toolbar'), bounds=bar.getBoundingClientRect();
 const visible=node=>node.checkVisibility();
 const within=(r,edge)=>r.left>=edge.left-.5&&r.right<=edge.right+.5;
 const controls=[...bar.querySelectorAll('button,summary,output,input[type=checkbox],select')].filter(visible);
 const id=node=>node.id||node.dataset.view||node.parentElement.id;
 const clipped=controls.filter(node=>{
  const r=node.getBoundingClientRect();
  if(!within(r,bounds)||!within(r,{left:0,right:innerWidth})||r.top<0||r.bottom>innerHeight)return true;
  for(let parent=node.parentElement;parent;parent=parent.parentElement){
   if(!/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX))continue;
   const left=parent.getBoundingClientRect().left+parent.clientLeft;
   if(!within(r,{left,right:left+parent.clientWidth}))return true;
  }
  return false;
 });
 const list=bar.querySelector('#view-menu[open] .view-menu-list');
 return {width:innerWidth,lang:document.documentElement.lang,dpr:devicePixelRatio,
  bar:bounds.toJSON(),client:bar.clientWidth,scroll:bar.scrollWidth,
  order:[...bar.querySelector('.zoom-controls').children].map(id).filter(id=>${JSON.stringify(order)}.includes(id)),
  clipped:clipped.map(id),menu:list?.getBoundingClientRect().toJSON()??null,
  summary:bar.querySelector('#view-menu summary').getBoundingClientRect().toJSON()};
})()`;
const observations:ReadingRow[]=[], errors:string[]=[];
const pixelControls:string[]=[];
const cleanup:(()=>unknown)[]=[];
await mkdir(output,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'review-toolbar-wrap-'));
const baseline=baselineCss?await readFile(baselineCss,'utf8'):null;

async function wait(page:InputCdpSession,expression:string) {
 const deadline=Date.now()+15_000;
 while(Date.now()<deadline){
  if(await page.evaluate<boolean>(expression))return;
  await Bun.sleep(35);
 }
 throw new Error('TOOLBAR_READY '+expression);
}

async function record(page:InputCdpSession,name:string,state:string) {
 await page.evaluate(settle);
 const reading=await page.evaluate<Reading>(readback);
 observations.push({name,state,reading});
 return reading;
}

function assertFits(reading:Reading,name:string,width:number,lang:string) {
 assert.equal(reading.width,width,name);
 assert.equal(reading.lang,lang,name);
 assert.equal(reading.dpr,2,name);
 assert.deepEqual(reading.order,order,name+' control order');
 assert.ok(reading.scroll<=reading.client,`${name} toolbar scrollWidth/clientWidth ${reading.scroll}/${reading.client}`);
 assert.deepEqual(reading.clipped,[],name+' clipped controls');
}

function menuFits(reading:Reading,name:string) {
 const {menu,bar,summary}=reading;
 assert.ok(menu,name+' menu opened');
 assert.ok(menu.left>=bar.left-.5&&menu.right<=bar.right+.5&&menu.top>=0&&menu.bottom<=900,name+' menu inside the stage and viewport');
 const rightAlignedWouldClip=summary.right-(menu.right-menu.left)<bar.left-.5;
 assert.ok(Math.abs((rightAlignedWouldClip?menu.left:menu.right)-(rightAlignedWouldClip?summary.left:summary.right))<=1,name+' preserves right alignment when it fits');
}

async function wideControl(page:InputCdpSession,name:string,reading:Reading,css:string) {
 const clip={x:Math.floor(reading.bar.left),y:Math.floor(reading.bar.top),
  width:Math.ceil(reading.bar.right)-Math.floor(reading.bar.left),
  height:Math.ceil(reading.bar.bottom)-Math.floor(reading.bar.top)};
 const after=await page.screenshot(clip);
 await page.evaluate(`(()=>{
  const original=[...document.querySelectorAll('link[rel=stylesheet]')].find(link=>new URL(link.href).pathname.endsWith('/styles.css'));
  if(!original)throw Error('BASELINE_STYLESHEET_MISSING');
  const style=document.createElement('style');
  style.textContent=${JSON.stringify(css)};
  original.replaceWith(style);
 })()`);
 await page.evaluate('document.fonts.ready.then(()=>true)');
 const before=await record(page,name,'baseline-css');
 assert.deepEqual(before.bar,reading.bar,name+' identical toolbar bounds');
 const old=await page.screenshot(clip);
 await writeFile(join(output,name+'-baseline.png'),old);
 await writeFile(join(output,name+'-head.png'),after);
 assert.ok(PNG.sync.read(old).data.equals(PNG.sync.read(after).data),name+' identical toolbar pixels');
 pixelControls.push(name);
}

async function runCase(target:Target,width:number,lang:'en'|'ko') {
 const name=`${target.screen}-${lang}-${width}`;
 let send:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 const profile=await mkdtemp(join(scratch,'chrome-'));
 const page=await launchCdpSession(profile,{onEvent:(event,control)=>{if(event.sessionId)send=control;}});
 try{
  assert.ok(send);
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:2,mobile:false});
  const url=new URL(target.url);url.searchParams.set('lang',lang);
  await page.goto(url.href,lang);
  await wait(page,target.ready);
  await page.evaluate(`document.querySelectorAll('dialog.workspace-drawer[open]').forEach(node=>node.close())`);
  await page.evaluate('document.fonts.ready.then(()=>true)');
  const closed=await record(page,name,'closed');
  if(width===390&&target.screen==='direction')await writeFile(join(output,name+'-closed.png'),await page.screenshot());
  assertFits(closed,name,width,lang);
  if(width===768)assert.equal(closed.client,240,name+' exercises the 240 px stage');
  await click(page,'#view-menu summary');
  await wait(page,`!!document.querySelector('#view-menu[open] .view-menu-list')?.checkVisibility()`);
  const opened=await record(page,name,'open');
  assertFits(opened,name+' open',width,lang);menuFits(opened,name);
  if(target.screen==='direction'&&width===390||target.screen==='job'&&width===768){
   await writeFile(join(output,name+'-open.png'),await page.screenshot());
  }
  if(width===390&&target.screen==='direction'){
   await click(page,'#view-menu [data-view="reference"]');
   await wait(page,`!document.querySelector('#view-menu[open]') && document.querySelector('#view-menu [data-view="reference"]').getAttribute('aria-pressed')==='true'`);
  }
  if(width>=1280&&baseline){
   await click(page,'#view-menu summary');
   await wait(page,`!document.querySelector('#view-menu[open]')`);
   await wideControl(page,name,await record(page,name,'wide-head'),baseline);
  }
 }finally{
  await page.close();
  await rm(profile,{recursive:true,force:true});
 }
}

try{
 const targets:Target[]=[];
 for(const screen of directionOnly?['direction'] as const:['direction','rig','parts'] as const){
  const fixture=await scriptedJobWindowFixture({c5Parts:'mesh',scratchParent:scratch});
  cleanup.push(()=>fixture.close());
  const publication=await fixture.publish(screen);
  await fixture.ask(publication,screen==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:
   {kind:'review-verdict',stage:screen==='rig'?'rig-review':'direction-review'});
  targets.push({screen,url:fixture.host.ownerUrl,ready:jobReady,widths:baseline&&screen!=='parts'?[390,1280,1440]:[390]});
 }
 if(!directionOnly){
  const manifest=await loadReview(resolve(import.meta.dir,'../examples/demo/review.json'));
  const pkg=await startServer(manifest,{port:0,stateDir:join(scratch,'package'),viewOnly:true,graceMs:180_000});
  cleanup.push(()=>pkg.stop(true));
  targets.push({screen:'package',url:`http://127.0.0.1:${pkg.port}/`,ready:standaloneReady,widths:[390]});

  const fixture=await interviewOpenFixture();
  cleanup.push(()=>fixture.close());
  const opened=await loadOpenPackage(parseOpenInputs([fixture.root,'--project',fixture.root,'--picks-dir','picks']));
  assert.equal(opened.mode,'interview');
  const capability=randomBytes(32).toString('hex');
  const interview=await startServer(null,{port:0,stateDir:fixture.stateDir,joined:opened.joined,capability,graceMs:180_000});
  cleanup.push(()=>interview.stop(true));
  targets.push({screen:'interview',url:`http://127.0.0.1:${interview.port}/#cap=${capability}`,
   ready:'document.body.dataset.ready==="true" && !!document.querySelector("#view-menu [data-view^=interview-image]")',widths:[390,768]});

  // #1228: a displayed record publication with no ask holds the right panel open, so the 768 px stage stays 240 px.
  const job=await recordScreenFixture('checkpoint',true,undefined,'plan-approved',false,true,undefined,false,true);
  job.fake.publish(job.display);
  cleanup.push(()=>job.close());
  targets.push({screen:'job',url:job.ownerUrl,ready:jobReady+' && !!document.querySelector("#reference-content img")?.naturalWidth',widths:[390,768]});
 }
 for(const target of targets)for(const width of target.widths)for(const lang of width>=1280?['en'] as const:languages){
  try{await runCase(target,width,lang);}
  catch(error){errors.push(`${target.screen}-${lang}-${width} ${String(error)}`);}
 }
}finally{
 for(const stop of cleanup.reverse())await stop();
 await rm(scratch,{recursive:true,force:true});
 await writeFile(join(output,'toolbar-readings.json'),JSON.stringify({observations,errors,pixelControls},null,2)+'\n');
}
assert.deepEqual(errors,[]);
console.log(`TOOLBAR_WRAP_OK ${observations.filter(row=>row.state==='open').length} closed/open cases and ${pixelControls.length} pixel controls`);
