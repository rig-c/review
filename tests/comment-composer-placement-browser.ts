/** #895: saved assembled comments, real publish/ask/UI flow; ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
type Point={x:number;y:number};
type Rect=Point&{width:number;height:number;left:number;top:number;right:number;bottom:number};
type Observation={lang:string;width:number;height:number;case:string;composer:Rect;area:Rect;pane:Rect;main:Rect;canvas:Rect;position:string;parent:string;acts:Rect[];handles:{name:string;rect:Rect;hit:string;self:boolean}[];value:string;readOnly:boolean;parts:number;view:string|null};
const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const out=arg('--out')??'artifacts/comment-composer-placement',baseline=Bun.argv.includes('--baseline');
await mkdir(out,{recursive:true});const report:Observation[]=[],dragUnavailable:string[]=[];
export async function composerFixture(partCount=22){
 const f=await scriptedJobWindowFixture({c5Parts:'no-mesh'});
 try{
  const pkg=f.packageRoot,w=2400,h=2200,painting=new PNG({width:w,height:h});
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)painting.data.set([40+Math.floor(x/40)%100,50+Math.floor(y/40)%100,100,255],(y*w+x)*4);
  const parts=[{name:'body',x:200,y:200,w:2000,h:1800},...Array.from({length:21},(_,i)=>({name:i===0?'front':'detail_'+i,x:600+i%7*120,y:500+Math.floor(i/7)*240,w:80,h:160}))].slice(0,partCount);
  if(partCount===2)Object.assign(parts[0]!,{x:40,y:40,w:2320,h:2120});
  await writeFile(join(pkg,'painting.png'),PNG.sync.write(painting));
  for(const part of parts){const png=new PNG({width:part.w,height:part.h});for(let y=0;y<part.h;y++)painting.data.copy(png.data,y*part.w*4,((part.y+y)*w+part.x)*4,((part.y+y)*w+part.x+part.w)*4);await writeFile(join(pkg,'parts/'+part.name+'.png'),PNG.sync.write(png));}
  await writeFile(join(pkg,'parts.json'),JSON.stringify({rig_size:[w,h],scale_rig_per_source:1,parts}));
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),refs=[...parts.map(part=>({path:'parts/'+part.name+'.png',role:'part'})),{path:'painting.png',role:'painting'}],images=await Promise.all(refs.map(async r=>({...r,sha256:hash(await readFile(join(pkg,r.path)))}))),context=f.input.getContext();
  f.input.setPartsReferences(refs);f.input.setContext({...context,partIds:parts.map(part=>part.name),parts:{...context.parts!,manifest:{path:'out/parts.json',sha256:hash(await readFile(join(pkg,'parts.json')))},images}});
  return f;
 }catch(error){await f.close();throw error;}
}

async function wait(p:InputCdpSession,e:string){const until=Date.now()+15000;while(Date.now()<until){if(await p.evaluate<boolean>(e))return;await Bun.sleep(30);}await writeFile(join(out,'failure.png'),await p.screenshot());const state=await p.evaluate<{message:string;error:string;value:string;parts:string[]}>(`({message:document.getElementById('message')?.textContent,error:document.querySelector('.stage-comment-composer [role=alert]')?.textContent,value:document.querySelector('.stage-comment-composer input')?.value,parts:[...document.querySelectorAll('[data-comment-part][aria-pressed=true]')].map(n=>n.dataset.commentPart)})`);await writeFile(join(out,'failure.json'),JSON.stringify(state,null,2));throw Error('WAIT '+e+' '+JSON.stringify(state));}
function intersects(a:Rect,b:Rect){return a.left<b.right-.05&&a.right>b.left+.05&&a.top<b.bottom-.05&&a.bottom>b.top+.05;}
function minimumCovered(o:Omit<Observation,'lang'|'width'|'height'|'case'>,bounds=o.pane){
 const w=o.composer.width,h=o.composer.height,p=bounds;
 const axes=(low:number,high:number,edges:number[])=>{const ends=[low,high,...edges].filter(v=>v>=low&&v<=high).sort((a,b)=>a-b);return [...ends,...ends.slice(1).map((v,i)=>(v+ends[i]!)/2)];};
 const xs=axes(p.left+4,p.right-w-4,o.handles.flatMap(b=>[b.rect.left-w,b.rect.right]));
 const ys=axes(p.top+4,p.bottom-h-4,o.handles.flatMap(b=>[b.rect.top-h,b.rect.bottom]));
 return Math.min(...xs.flatMap(x=>ys.map(y=>o.handles.filter(b=>intersects({x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h},b.rect)).length)));
}
if(import.meta.main){
for(const lang of ['en','ko'] as const)for(const [width,height] of [[1024,768],[1440,900]])for(const partCount of (width===1440?[22,2]:[22])){
 const f=await composerFixture(partCount),profile=await mkdtemp('/tmp/review895-');let p:InputCdpSession|undefined,control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 try{
  const pub=await f.publish('parts');await f.ask(pub,{kind:'parts-verdict',draftId:'synthetic-parts'});
  p=await launchCdpSession(profile,{sendDeadlineMs:20000,browserArgs:['--renderer-process-limit=2'],onEvent(event,send){if(event.sessionId)control=send;}});const page=p;await page.setViewport(width!,height!);const url=new URL(f.host.ownerUrl);url.searchParams.set('lang',lang);await page.goto(url.href,lang);
  await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.getElementById('parts-canvas')?.width===2400`);
  await click(page,'#fit');await click(page,'#stage-comment');
  const settle=()=>page.evaluate<void>(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  async function drag(a:Point,b:Point){await page.mouse('mouseMoved',a.x,a.y);await page.mouse('mousePressed',a.x,a.y);await page.mouse('mouseMoved',b.x,b.y);await page.mouse('mouseReleased',b.x,b.y);await settle();}
  for(const item of (partCount===2?[{name:'interior',a:{x:60,y:60},b:{x:2340,y:2140}},{name:'above',a:{x:60,y:1400},b:{x:2340,y:1700}}]:[{name:'ordinary',a:{x:1000,y:600},b:{x:1300,y:900}},{name:'narrow',a:{x:650,y:600},b:{x:1750,y:1400}},{name:'large',a:{x:260,y:260},b:{x:2140,y:1940}}])){
   const points=await page.evaluate<{a:Point;b:Point}>(`(()=>{const c=document.getElementById('parts-canvas'),r=c.getBoundingClientRect(),z=r.width/c.width;return {a:{x:r.left+${item.a.x}*z,y:r.top+${item.a.y}*z},b:{x:r.left+${item.b.x}*z,y:r.top+${item.b.y}*z}};})()`);
   await drag(points.a,points.b);await wait(page,`!!document.querySelector('.stage-comment-composer')`);
   await page.evaluate<void>(`document.querySelector('.stage-comment-composer input').focus()`);assert.ok(control);await control('Input.insertText',{text:'Saved assembled '+item.name});
   for(const type of ['keyDown','keyUp'])await control('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
   await wait(page,`!document.querySelector('.stage-comment-composer')`);
   await page.evaluate<void>(`[...document.querySelectorAll('.stage-comment-summary')].at(-1).scrollIntoView({block:'nearest'})`);
   const selector='.stage-comment-item:last-child .stage-comment-summary';await click(page,selector);await wait(page,`!!document.querySelector('.stage-comment-composer')`);await settle();
   const observation=await page.evaluate<Omit<Observation,'lang'|'width'|'height'|'case'>>(`(()=>{const rect=n=>n.getBoundingClientRect().toJSON(),form=document.querySelector('.stage-comment-composer'),area=document.querySelector('[data-comment-handle="move"]'),input=form.querySelector('input');return {composer:rect(form),area:rect(area),pane:rect(document.getElementById('rig-viewport')),main:rect(form.closest('main')),position:getComputedStyle(form).position,parent:form.parentElement.id,acts:[...form.closest('main').querySelectorAll('#workspace-act-row button,.workspace-act-bar button,#submit,#approve,#request-changes')].filter(n=>!n.hidden&&n.getClientRects().length).map(rect),canvas:rect(document.getElementById('parts-canvas')),handles:[...document.querySelectorAll('button[data-comment-handle]')].map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:n.dataset.commentHandle,rect:r.toJSON(),hit:hit?.tagName+'.'+hit?.className,self:hit===n};}),value:input.value,readOnly:input.readOnly,parts:form.querySelectorAll('[data-comment-part]').length,view:document.querySelector('#view-menu [aria-pressed="true"]')?.dataset.view};})()`);
   assert.equal(observation.handles.length,8);assert.equal(observation.readOnly,false);assert.equal(observation.value,'Saved assembled '+item.name);
   if(!baseline){
    const paneMinimum=minimumCovered(observation),optimum=paneMinimum===0?0:minimumCovered(observation,observation.main);
    const covered=observation.handles.filter(h=>intersects(observation.composer,h.rect)).length;
    assert.equal(covered,optimum,lang+' '+width+' '+item.name+' minimum blocked handles');
    assert.equal(optimum,0,'main workspace has a zero-cover placement');assert.ok(observation.handles.every(h=>h.self),'all eight handle centres hit themselves');assert.equal(observation.parent,'rig-viewport','existing form is not reparented');
    const bound=observation.position==='fixed'?observation.main:observation.pane;assert.ok(observation.composer.left>=bound.left+3.95&&observation.composer.right<=bound.right-3.95&&observation.composer.top>=bound.top+3.95&&observation.composer.bottom<=bound.bottom-3.95,'form fits declared domain with 4px inset');assert.ok(!observation.acts.some(r=>intersects(observation.composer,r)),'act row controls remain uncovered');
    const controlPath=arg('--control');
    if(controlPath){const controls=JSON.parse(await readFile(controlPath,'utf8')) as Observation[],before=controls.find(r=>r.lang===lang&&r.width===width&&r.case===item.name)!;assert.equal(observation.composer.width,before.composer.width,'composer width unchanged');assert.equal(observation.composer.height,before.composer.height,'composer height unchanged');if(before.handles.every(h=>h.self))assert.deepEqual(observation.composer,before.composer,'every safe in-pane rect unchanged from 5799065');}
    if(item.name==='above')assert.ok(observation.composer.bottom<=observation.area.top-6,'above fallback stays outside area and handles');
    if(width===1440&&item.name==='interior'){assert.equal(optimum,0);assert.ok(observation.composer.left>observation.area.left&&observation.composer.right<observation.area.right,'large-area interior fallback');}
   }
   report.push({lang,width:width!,height:height!,case:item.name,...observation});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await Bun.sleep(700);await writeFile(join(out,`${lang}-${width}-${item.name}.png`),await page.screenshot());
   if(!baseline&&item.name==='large'&&width===1024){
    const read=()=>page.evaluate<{composer:Rect;main:Rect;hits:boolean[];world:{x:number;y:number;width:number;height:number};parent:string;pane:Rect;blockers:unknown[]}>(`(()=>{const f=document.querySelector('.stage-comment-composer'),a=document.querySelector('[data-comment-handle="move"]').getBoundingClientRect(),c=document.getElementById('parts-canvas'),r=c.getBoundingClientRect(),z=r.width/c.width;return {composer:f.getBoundingClientRect().toJSON(),main:f.closest('main').getBoundingClientRect().toJSON(),parent:f.parentElement.id,pane:document.getElementById('rig-viewport').getBoundingClientRect().toJSON(),blockers:[...document.querySelectorAll('button[data-comment-handle]')].map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:n.dataset.commentHandle,rect:r.toJSON(),hit:hit?.tagName+'.'+hit?.className};}),hits:[...document.querySelectorAll('button[data-comment-handle]')].map(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===n;}),world:{x:(a.left-r.left)/z,y:(a.top-r.top)/z,width:a.width/z,height:a.height/z}};})()`);
    const initial=await read(),lifecycle:unknown[]=[];
    const verify=async(event:string,requireVisible=true)=>{await settle();await Bun.sleep(120);const r=await read();lifecycle.push({event,...r});await writeFile(join(out,lang+'-lifecycle.json'),JSON.stringify(lifecycle,null,2));await writeFile(join(out,lang+'-lifecycle-last.png'),await page.screenshot());assert.equal(r.hits.length,8);if(requireVisible)assert.ok(r.hits.every(Boolean),'all eight after '+event);assert.equal(r.parent,'rig-viewport');for(const k of ['x','y','width','height'] as const)assert.ok(Math.abs(r.world[k]-initial.world[k])<=1,'native region stable after '+event+' '+k);assert.ok(r.composer.left>=r.main.left+3.95&&r.composer.right<=r.main.right-3.95&&r.composer.top>=r.main.top+3.95&&r.composer.bottom<=r.main.bottom-3.95,'main bounds after '+event);};
    await page.setViewport(width,height!+80);await verify('window resize');
    const separator=await page.evaluate<Point>(`(()=>{const r=document.querySelector('.workspace-separator.workspace-inspectorHeight').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);await drag(separator,{x:separator.x,y:separator.y-25});await verify('bottom panel resize');
    const pan=await page.evaluate<Point>(`(()=>{const r=document.getElementById('rig-viewport').getBoundingClientRect();return {x:r.left+20,y:r.top+20};})()`);
    for(const [type,x,y,buttons] of [['mouseMoved',pan.x,pan.y,0],['mousePressed',pan.x,pan.y,2],['mouseMoved',pan.x-8,pan.y-4,2],['mouseReleased',pan.x-8,pan.y-4,0]] as const)await control('Input.dispatchMouseEvent',{type,x,y,button:'right',buttons,clickCount:1});await verify('right pan');
    const scroll=await page.evaluate<{before:number;after:number}>(`(()=>{const n=document.getElementById('workspace-inspector'),before=n.scrollTop;n.scrollTop+=40;return {before,after:n.scrollTop};})()`);await verify('bottom panel scroll');lifecycle.push({scroll});
    await page.setViewport(width,height!);await verify('restore window before Fit',false);await click(page,'#fit');await verify('Fit after resize');await writeFile(join(out,lang+'-lifecycle.json'),JSON.stringify(lifecycle,null,2));
   }
   if(!baseline){
    const names=['ordinary','narrow','large'].includes(item.name)?['nw','n','ne','e','se','s','sw','w']:['nw'];
    for(const name of names){
     if(name!=='nw'){for(const type of ['keyDown','keyUp'])await control('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await click(page,selector);await wait(page,`document.querySelectorAll('button[data-comment-handle]').length===8`);await settle();}
     const handle=await page.evaluate<{x:number;y:number;self:boolean}>(`(()=>{const n=document.querySelector('[data-comment-handle="${name}"]'),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,self:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===n};})()`);assert.ok(handle.self,'drag centre '+name);
     await page.mouse('mouseMoved',handle.x,handle.y);await page.mouse('mousePressed',handle.x,handle.y);
     for(let step=1;step<=3;step++){const point={x:handle.x+step*2,y:handle.y+step*2};await page.mouse('mouseMoved',point.x,point.y);await settle();assert.equal(await page.evaluate<boolean>(`document.elementFromPoint(${point.x},${point.y})?.closest('.stage-comment-composer')!==null`),false,'drag never moves composer under pointer');}
     await page.mouse('mouseReleased',handle.x+6,handle.y+6);await settle();
    }
   }
   for(const type of ['keyDown','keyUp'])await control('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();
  }
 }finally{await p?.close();await f.close();await rm(profile,{recursive:true,force:true});}
}
console.log('REPRODUCTION_895 '+JSON.stringify(report.map(r=>({lang:r.lang,width:r.width,case:r.case,blocked:r.handles.filter(h=>!h.self).map(h=>h.name),composer:r.composer}))));
if(baseline)assert.ok(report.some(r=>r.width===1024&&r.handles.every(h=>!h.self)),'STOP: no reproduction');
await writeFile(join(out,'summary.json'),JSON.stringify({baseline,cases:report.length,handleCentres:report.length*8,holes:0,dragUnavailable,skips:dragUnavailable.length},null,2));
console.log('COMMENT_COMPOSER_PLACEMENT_895 '+JSON.stringify({baseline,cases:report.length,handleCentres:report.length*8,holes:0,dragUnavailable,skips:dragUnavailable.length}));
}

