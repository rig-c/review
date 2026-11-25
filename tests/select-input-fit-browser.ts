/** #883: ordinary Nova only. Reuses the four declared scenes from the owner shots harness.
 * Checks native text field scroll boxes AND a font-matched line box against the
 * padding-reduced content height; Chromium native selects can conceal scroll overflow.
 * No screenshots, CSS injection, producer run or new fixture format.
 */
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {withDeadline} from './helpers/walk-deadline.ts';

const at=Bun.argv.indexOf('--out');
const output=resolve(at<0?'artifacts/review-883/select-fit':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const work=await mkdtemp(join(process.platform==='linux'?'/tmp':tmpdir(),'review-select-fit-'));
const oldState=process.env.RIG_REVIEW_STATE_DIR,oldTmp=process.env.TMPDIR;
process.env.TMPDIR=work;process.env.RIG_REVIEW_STATE_DIR=join(work,'state');
const started=performance.now();
const observations:any[]=[],defects:any[]=[],errors:any[]=[],representatives:any[]=[];
const exclusions={checkbox:'Native toggle glyph, not an editable text line.',radio:'Native toggle glyph, not an editable text line.',range:'Native slider track/thumb, not a text line.',hidden:'No painted text.',file:'Native file-picker compound widget; not a single text field.',color:'Native colour swatch, not a text line.',button:'Button widget, outside the text-field audit.',submit:'Button widget, outside the text-field audit.',reset:'Button widget, outside the text-field audit.'};
let page:InputCdpSession|undefined;
const sourceStyles=await Promise.all(['web/styles.css','web/compare.css'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
async function save(complete=false){
 const report={complete,diagnostic:'select/input vertical text fit',viewport:{width:1440,height:900},seconds:(performance.now()-started)/1000,sourceStyles,exclusions,observations,representatives,defects,errors};
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 await writeFile(join(output,'defects.json'),JSON.stringify({defects,errors},null,2)+'\n');
 const rows=defects.map(d=>`${d.screen}/${d.lang}/${d.scheme}/${d.phase} ${d.selector}: ${d.reasons.join(', ')}; font=${d.font}; line=${d.lineHeight}; padding=${d.padding}; height=${d.height}; scroll/client=${d.scrollHeight}/${d.clientHeight}; content=${d.contentHeightPx}; lineBox=${d.lineBoxPx}`);
 await writeFile(join(output,'report.md'),`# Select/input fit\n\nComplete: ${complete}. No screenshots.\n\n${rows.join('\n\n')||'No text-fit defects recorded.'}\n\n${errors.map(e=>JSON.stringify(e)).join('\n')}\n`);
}
async function until(expression:string,label:string){
 await withDeadline('select-fit '+label,10000,async signal=>{
  while(!signal.aborted){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}
 });
}
const settled=`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`;
const measure=`(()=>{
 const excluded=${JSON.stringify(exclusions)};
 const selector=n=>n.id?'#'+CSS.escape(n.id):n.tagName.toLowerCase()+[...n.classList].map(c=>'.'+CSS.escape(c)).join('')+(n.hasAttribute('data-insert-time')?'[data-insert-time]':'')+(n.hasAttribute('data-key-time-input')?'[data-key-time-input]':'');
 const visible=n=>{
  const r=n.getBoundingClientRect(),s=getComputedStyle(n);
  if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none'||n.closest('[hidden],dialog:not([open])'))return false;
  let top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right);
  for(let p=n.parentElement;p;p=p.parentElement){const c=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(c.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom);}if(/auto|scroll|hidden|clip/.test(c.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}}
  return bottom>top&&right>left;
 };
 const controls=[],omitted=[];
 for(const n of document.querySelectorAll('select,input')){
  if(!visible(n))continue;
  const key=selector(n),type=n.tagName==='INPUT'?n.type:'select';
  if(excluded[type]){omitted.push({selector:key,type,reason:excluded[type]});continue;}
  if(n.tagName==='SELECT'&&(n.multiple||n.size>1)){omitted.push({selector:key,type,reason:'Scrollable multi-row listbox; scrollHeight is its intentional list extent.'});continue;}
  const s=getComputedStyle(n),r=n.getBoundingClientRect();
  const text=n.tagName==='SELECT'?(n.selectedOptions[0]?.textContent??''):(n.value||n.placeholder||'');
  const probe=document.createElement('span');
  probe.style.cssText='all:initial;position:fixed;visibility:hidden;pointer-events:none;white-space:pre;display:inline-block;padding:0;margin:0;border:0;left:0;top:0';
  for(const k of ['fontFamily','fontSize','fontWeight','fontStyle','fontStretch','fontVariant','letterSpacing','lineHeight'])probe.style[k]=s[k];
  probe.textContent=text||'Hgypq한글';document.body.append(probe);
  const lineBoxPx=probe.getBoundingClientRect().height;probe.remove();
  const paddingTop=parseFloat(s.paddingTop),paddingBottom=parseFloat(s.paddingBottom);
  const contentHeightPx=n.clientHeight-paddingTop-paddingBottom;
  const reasons=[];
  if(n.scrollHeight>n.clientHeight)reasons.push('scrollHeight exceeds clientHeight');
  if(lineBoxPx>contentHeightPx)reasons.push('font line box exceeds padding-reduced content height');
  controls.push({selector:key,tag:n.tagName,type,text,label:n.getAttribute('aria-label')||document.querySelector('label[for="'+CSS.escape(n.id)+'"]')?.textContent||'',disabled:n.disabled,
   font:s.font,fontSize:s.fontSize,fontFamily:s.fontFamily,lineHeight:s.lineHeight,padding:s.padding,paddingTop,paddingBottom,height:s.height,boxSizing:s.boxSizing,
   rect:{x:r.x,y:r.y,width:r.width,height:r.height},scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,contentHeightPx,lineBoxPx,reasons});
 }
 return {language:document.documentElement.lang,theme:document.documentElement.dataset.theme,mediaDark:matchMedia('(prefers-color-scheme:dark)').matches,controls,omitted};
})()`;
async function audit(context:{screen:string;lang:string;scheme:string},phase:string){
 await page!.evaluate(settled);
 const data=await page!.evaluate<any>(measure),row={...context,phase,...data};observations.push(row);
 for(const field of data.controls)if(field.reasons.length)defects.push({...context,phase,...field});
 // Named real fields keep both accepted density tiers under regression coverage.
 const required=context.screen==='rig'?(phase==='setup'?[['#reference-select',32],['#settings-language',24]]:phase==='timeline'?[['input.animation-insert-time[data-insert-time]',24]]:[]):[];
 for(const [selector,height] of required){
  const field=data.controls.find((n:any)=>n.selector===selector);
  representatives.push({...context,phase,selector,expectedHeight:height,measurement:field??null});
  if(!field)errors.push({...context,phase,selector,error:'Required named field is not visible/mounted'});
  else if(field.rect.height!==height)errors.push({...context,phase,selector,error:'Named field control height changed',expectedHeight:height,actualHeight:field.rect.height});
 }
 if(data.language!==context.lang)errors.push({...context,phase,error:'Wrong document language',actual:data.language});
 if(data.mediaDark!==(context.scheme==='dark'))errors.push({...context,phase,error:'Wrong emulated colour scheme'});
 await save();
}
try{
 const {scriptedJobWindowFixture}=await import('./helpers/job-window-fixture.ts');
 const {recordScreenFixture}=await import('./helpers/job-record-screen-fixture.ts');
 const {writeDifferencePackage}=await import('./helpers/parts-difference-package.ts');
 const {loadPartsView}=await import('../src/parts-view.ts');
 const {startPartsServer}=await import('../src/parts-server.ts');
 const {loadCompare}=await import('../src/compare.ts');
 const {startCompareServer}=await import('../src/compare-server.ts');
 const {PROBE_MP4_BASE64}=await import('./compare-mode-browser.ts');
 type Screen={name:string;setup():Promise<{url:string;close():Promise<void>}>;ready:string};
 const screens:Screen[]=[
  {name:'rig',async setup(){const f=await scriptedJobWindowFixture({c5Parts:'mesh'});try{const p=await f.publish('rig');await f.ask(p,{kind:'review-verdict',stage:'rig-review'});return {url:f.host.ownerUrl,close:()=>f.close()};}catch(e){await f.close();throw e;}},ready:`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#rig-root canvas')&&!document.getElementById('play').disabled`},
  {name:'parts',async setup(){const dir=join(work,'parts-fixture');await writeDifferencePackage(dir,false);const server=await startPartsServer(await loadPartsView(dir,{painting:join(dir,'painting.png')}),{port:0,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});return {url:'http://127.0.0.1:'+server.port+'/',close:async()=>{server.stop(true);}};},ready:`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`},
  {name:'compare',async setup(){const dir=join(work,'compare-fixture'),fx=join(import.meta.dir,'fixtures/strip-probe');for(const side of ['a','b']){for(const d of ['build','images'])await cp(join(fx,d),join(dir,side,d),{recursive:true});for(const f of ['motion.json','gate.json'])await cp(join(fx,f),join(dir,side,f));}const reference=join(dir,'ref.mp4');await writeFile(reference,Buffer.from(PROBE_MP4_BASE64,'base64'));const server=await startCompareServer(await loadCompare({a:join(dir,'a'),b:join(dir,'b'),reference,animation:'inspect'}),{port:0,stateDir:join(dir,'state')});return {url:'http://127.0.0.1:'+server.port+'/',close:async()=>{server.stop(true);}};},ready:`!!document.querySelector('#a-root canvas,#a-root img')&&!!document.querySelector('#b-root canvas,#b-root img')&&!document.getElementById('play')?.disabled`},
  {name:'interview',async setup(){const f=await recordScreenFixture('option-set',true);return {url:f.ownerUrl,close:()=>f.close()};},ready:`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')`},
 ];
 type Send=(method:string,params?:Record<string,unknown>)=>Promise<any>;
 let receive!:(send:Send)=>void;
 const commandReady=new Promise<Send>(resolve=>{receive=resolve;});
 page=await launchCdpSession(join(work,'profile'),{sendDeadlineMs:10000,onEvent(event,send){if(event.sessionId)receive(send);}});
 const send=await withDeadline('select-fit CDP commands',10000,()=>commandReady);
 await page.setViewport(1440,900);await save();
 for(const screen of screens){
  let fixture:Awaited<ReturnType<Screen['setup']>>|undefined;
  try{
   fixture=await screen.setup();
   for(const lang of ['en','ko'] as const){
    const url=new URL(fixture.url);url.searchParams.set('lang',lang);
    await send('Storage.clearDataForOrigin',{origin:url.origin,storageTypes:'all'});
    await page.goto(url.href,lang);await until(screen.ready,screen.name+' ready');
    for(const scheme of ['dark','light'] as const){
     const context={screen:screen.name,lang,scheme};
     try{
      await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      if(screen.name==='compare')await page.evaluate(`document.querySelector('[data-mode="compare"]')?.click()`);
      await audit(context,'entry');
      // Open the existing Setup view and Reference details, without style/value overrides.
      await page.evaluate(`(()=>{document.querySelector('[data-mode="rig"]')?.click();const details=document.querySelector('#package-context');if(details)details.open=true;document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target="mesh-panel"]')?.click();})()`);
      await page.evaluate(settled);await audit(context,'setup');
      if(screen.name==='rig'){
       await page.evaluate(`(()=>{document.querySelector('[data-mode="playback"]')?.click();document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target="animation-dock"]')?.click();})()`);
       await until(`!!document.querySelector('#animation-dock [data-insert-time]')&&!document.getElementById('animation-dock').hidden`,'rig timeline compact input');
       await audit(context,'timeline');
      }
     }catch(e){errors.push({...context,error:String(e)});await save();}
    }
   }
  }catch(e){errors.push({screen:screen.name,error:String(e)});await save();}
  finally{try{await fixture?.close();}catch(e){errors.push({screen:screen.name,error:'Fixture close: '+String(e)});await save();}}
 }
}catch(e){errors.push({error:String(e)});}
finally{
 try{await page?.close();}
 catch(e){errors.push({error:'Browser close: '+String(e)});}
 finally{
  await rm(work,{recursive:true,force:true});
  if(oldState===undefined)delete process.env.RIG_REVIEW_STATE_DIR;else process.env.RIG_REVIEW_STATE_DIR=oldState;
  if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
 }
 await save(true);
}
console.log(`SELECT_INPUT_FIT: ${observations.length} audited states, ${defects.length} defects, ${errors.length} setup/coverage errors; report ${output}`);
assert.equal(errors.length,0,'Select/input audit setup/coverage errors; see '+join(output,'report.json'));
assert.equal(defects.length,0,'Select/input text clipping; see '+join(output,'defects.json'));
