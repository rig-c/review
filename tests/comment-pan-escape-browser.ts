/** #897 browser proof across rig, compare and parts screens in EN and KO; ordinary Nova only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {loadCompare} from '../src/compare.ts';
import {startCompareServer} from '../src/compare-server.ts';
import {PROBE_MP4_BASE64} from './compare-mode-browser.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';

const at=Bun.argv.indexOf('--out'),out=resolve(at<0?'artifacts/comment-pan-escape':Bun.argv[at+1]!);
await mkdir(out,{recursive:true});
const redMode=Bun.argv.includes('--red');
const report:Record<string,unknown>[]=[],failures:string[]=[];

async function wait(p:InputCdpSession,expr:string,label=expr){
 const until=Date.now()+15000;
 while(Date.now()<until){if(await p.evaluate<boolean>(expr))return;await Bun.sleep(25);}
 throw new Error('WAIT '+label);
}
async function check(name:string,run:()=>Promise<Record<string,unknown>|void>){
 try{
  const detail=await run();
  report.push({name,pass:true,...(detail??{})});
 }catch(e){
  failures.push(`${name}: ${e instanceof Error?e.message:String(e)}`);
  report.push({name,pass:false,error:String(e)});
 }
 await writeFile(join(out,'report.json'),JSON.stringify({redMode,checks:report.length,failures,report},null,2)+'\n');
}

type ScreenKind='rig'|'compare'|'parts';
interface ScreenHandle {
 kind:ScreenKind;
 url:string;
 viewportId:string;
 rootId:string;
 paneId:string;
 close:()=>Promise<void>;
}

async function openScreen(kind:ScreenKind,work:string):Promise<ScreenHandle>{
 if(kind==='parts'){
  const f=await scriptedJobWindowFixture({c5Parts:'no-mesh'}),pkg=f.packageRoot;
  const manifest=JSON.parse(await readFile(join(pkg,'parts.json'),'utf8'));
  for(const path of ['painting.png','parts/body.png','parts/front.png']){
   const a=PNG.sync.read(await readFile(join(pkg,path))),b=new PNG({width:a.width*10,height:a.height*10});
   for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)b.data.set(a.data.subarray((Math.floor(y/10)*a.width+Math.floor(x/10))*4,(Math.floor(y/10)*a.width+Math.floor(x/10))*4+4),(y*b.width+x)*4);
   await writeFile(join(pkg,path),PNG.sync.write(b));
  }
  manifest.rig_size=[320,240];
  for(const a of manifest.parts)for(const k of ['x','y','w','h'])a[k]*=10;
  await writeFile(join(pkg,'parts.json'),JSON.stringify(manifest));
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),context=f.input.getContext();
  const refs=[{path:'parts/body.png',role:'part'},{path:'parts/front.png',role:'part'},{path:'painting.png',role:'painting'}];
  const images=await Promise.all(refs.map(async r=>({...r,sha256:hash(await readFile(join(pkg,r.path)))})));
  f.input.setPartsReferences(refs);
  f.input.setContext({...context,parts:{...context.parts!,manifest:{path:'out/parts.json',sha256:hash(await readFile(join(pkg,'parts.json')))},images}});
  await f.publish('parts');
  return {
   kind,url:f.host.ownerUrl,viewportId:'rig-viewport',rootId:'rig-root',paneId:'rig-pane',
   close:()=>f.close(),
  };
 }
 if(kind==='rig'){
  const f=await scriptedJobWindowFixture({c5Parts:'mesh'}),pkg=f.packageRoot;
  await f.publish('rig');
  const model=JSON.parse(await readFile(join(pkg,'skeleton.model.json'),'utf8'));
  model.constraints=[...(model.constraints??[]),{kind:'physics',name:'mesh_physics',declaredIn:'rig',bone:'mesh',x:1,y:1,rotate:1,strength:20,damping:0.6,inertia:1,mass:1,wind:0,gravity:0,mix:1}];
  await writeFile(join(pkg,'skeleton.model.json'),JSON.stringify(model));
  const recordSha=createHash('sha256').update(await readFile(join(f.input.root,'project.json'))).digest('hex');
  f.input.setContext({...f.input.getContext(),selector:{kind:'rig',version:3}});
  const pubRes=await (await f.call({schema:'rig-review/job-api@2',jobId:f.host.session.jobId,requestId:'rig-physics-pub',verb:'publish',expectedGeneration:f.host.session.status().generation,idempotencyKey:'rig-physics-pub',result:{path:'out',selector:{kind:'rig',version:3}},freeze:{kind:'producer-held',holdId:'scripted-window-held',record:{path:'project.json',sha256:recordSha}}})).json();
  if(!pubRes.ok)throw new Error(JSON.stringify(pubRes));
  return {
   kind,url:f.host.ownerUrl,viewportId:'rig-viewport',rootId:'rig-root',paneId:'rig-pane',
   close:()=>f.close(),
  };
 }
 const dir=join(work,'compare-fixture'),fx=join(import.meta.dir,'fixtures/strip-probe');
 for(const side of ['a','b']){
  for(const d of ['build','images'])await cp(join(fx,d),join(dir,side,d),{recursive:true});
  for(const f of ['motion.json','gate.json'])await cp(join(fx,f),join(dir,side,f));
  const modelPath=join(dir,side,'build/skeleton.model.json'),model=JSON.parse(await readFile(modelPath,'utf8'));
  model.constraints=[...(model.constraints??[]),{kind:'physics',name:'mesh_physics',declaredIn:'rig',bone:'mesh',x:1,y:1,rotate:1,strength:20,damping:0.6,inertia:1,mass:1,wind:0,gravity:0,mix:1}];
  await writeFile(modelPath,JSON.stringify(model));
 }
 const reference=join(dir,'ref.mp4');
 await writeFile(reference,Buffer.from(PROBE_MP4_BASE64,'base64'));
 const server=await startCompareServer(await loadCompare({a:join(dir,'a'),b:join(dir,'b'),reference,animation:'inspect'}),{port:0,stateDir:join(dir,'state')});
 return {
  kind,url:`http://127.0.0.1:${server.port}/`,viewportId:'a-viewport',rootId:'a-root',paneId:'a-pane',
  close:async()=>{server.stop(true);},
 };
}

for(const lang of (redMode?['en']:['en','ko']) as ('en'|'ko')[]){
 for(const kind of ['parts','rig','compare'] as ScreenKind[]){
  const work=await mkdtemp(join(tmpdir(),`review897-${kind}-${lang}-`));
  let screen:ScreenHandle|undefined,page:InputCdpSession|undefined,control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
  try{
   screen=await openScreen(kind,work);
   page=await launchCdpSession(join(work,'profile'),{sendDeadlineMs:20000,onEvent(event,send){if(event.sessionId)control=send;}});
   const p=page;
   await p.setViewport(1440,900);
   const targetUrl=new URL(screen.url);
   targetUrl.searchParams.set('lang',lang);
   await p.goto(targetUrl.href,lang);
   if(kind==='parts'){
    await wait(p,`document.body.dataset.ready==='true'&&!document.body.inert&&document.getElementById('parts-canvas')?.width===320`,'parts ready');
    await click(p,'#fit');
   }else if(kind==='rig'){
    await wait(p,`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#rig-root canvas')&&!document.getElementById('play').disabled`,'rig ready');
    if(await p.evaluate(`document.getElementById('play').textContent==='Ⅱ'`))await click(p,'#play');
    await click(p,'#fit');
   }else{
    await wait(p,`!!document.querySelector('#a-root canvas,#a-root img')&&!!document.querySelector('#b-root canvas,#b-root img')&&!document.getElementById('play')?.disabled&&!!document.getElementById('stage-comment-list')`,'compare ready');
    await click(p,'#fit');
   }
   const settle=()=>p.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
   await settle();

   const modeState=()=>p.evaluate<{active:boolean;pressed:string|null;listOpen:boolean;composer:boolean;readOnly:boolean;value:string;regions:number;pins:number;handles:number;items:number}>(`(()=>{
    const v=document.getElementById(${JSON.stringify(screen!.viewportId)}),t=document.getElementById('stage-comment'),l=document.getElementById('stage-comment-list'),f=document.querySelector('.stage-comment-composer input');
    return {
     active:!!v?.classList.contains('stage-comment-mode'),
     pressed:t?.getAttribute('aria-pressed')??null,
     listOpen:!!l&&!l.hidden&&!l.closest('[hidden]'),
     composer:!!f,
     readOnly:!!f?.readOnly,
     value:f?.value??'',
     regions:v?.querySelectorAll('.stage-comment-region').length??0,
     pins:v?.querySelectorAll('.stage-comment-pin').length??0,
     handles:v?.querySelectorAll('[data-comment-handle]').length??0,
     items:document.querySelectorAll('.stage-comment-item').length,
    };
   })()`);
   const panPos=()=>p.evaluate<{x:number;y:number}>(`(()=>{
    const r=document.getElementById(${JSON.stringify(screen!.rootId)});
    return {x:parseFloat(r.style.left||'0'),y:parseFloat(r.style.top||'0')};
   })()`);
   const viewportBox=()=>p.evaluate<{x:number;y:number;w:number;h:number}>(`(()=>{
    const v=document.getElementById(${JSON.stringify(screen!.viewportId)});
    if(${JSON.stringify(kind)}==='parts'){
     const c=document.getElementById('parts-canvas').getBoundingClientRect();
     return {x:c.left+c.width*0.35,y:c.top+c.height*0.35,w:40,h:30};
    }
    const r=v.getBoundingClientRect();
    return {x:r.left+r.width*0.4,y:r.top+r.height*0.4,w:40,h:30};
   })()`);

   const pressKey=async(key:string,code=key,keyCode=key==='Escape'?27:key==='Enter'?13:key===' '?32:67)=>{
    assert.ok(control);
    await control('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,...(key==='Enter'?{text:'\r'}:key===' '?{text:' '}:{})});
    await control('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
    await settle();
   };
   const holdSpace=async(down:boolean)=>{
    assert.ok(control);
    await control('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
   };
   const mouseDrag=async(from:{x:number;y:number},to:{x:number;y:number},button:'left'|'right'='left')=>{
    assert.ok(control);
    const buttons=button==='left'?1:2;
    await control('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x,y:from.y,button:'none',buttons:0});
    await control('Input.dispatchMouseEvent',{type:'mousePressed',x:from.x,y:from.y,button,buttons,clickCount:1});
    await control('Input.dispatchMouseEvent',{type:'mouseMoved',x:(from.x+to.x)/2,y:(from.y+to.y)/2,button,buttons});
    await control('Input.dispatchMouseEvent',{type:'mouseMoved',x:to.x,y:to.y,button,buttons});
    await control('Input.dispatchMouseEvent',{type:'mouseReleased',x:to.x,y:to.y,button,buttons:0,clickCount:1});
    await Bun.sleep(50);
    await settle();
   };

   // Enable comment mode via toggle button.
   await click(p,'#stage-comment');
   await settle();
   assert.equal((await modeState()).active,true,'comment mode turns on');

   // Seed one comment so a pin exists on stage and an editable comment exists in the list.
   const box=await viewportBox();
   await mouseDrag({x:box.x,y:box.y},{x:box.x+box.w,y:box.y+box.h},'left');
   await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'seed composer');
   await p.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer input');f.focus();f.select();})()`);
   assert.ok(control);
   // Bar 6 check during seed typing: typing Space inside the composer input types a space and neither pans nor drops the draft.
   const beforeTypePan=await panPos();
   await control('Input.insertText',{text:'Seed'});
   await pressKey(' ','Space',32);
   await control('Input.insertText',{text:'note'});
   const afterTypePan=await panPos(),duringTypeState=await modeState();
   if(!redMode){
    await check(`${kind} ${lang} bar6 space in composer input`,async()=>{
     assert.deepEqual(afterTypePan,beforeTypePan,'typing space in composer does not pan');
     assert.equal(duringTypeState.composer,true,'draft stays open');
     assert.equal(duringTypeState.value,'Seed note','space is typed into input');
     return {value:duringTypeState.value,pan:afterTypePan};
    });
   }
   await pressKey('Enter','Enter',13);
   await wait(p,`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-item').length===1`,'seed saved');
   await settle();

   const resetMode=async()=>{
    if((await modeState()).composer)await pressKey('Escape');
    if(!(await modeState()).active)await click(p,'#stage-comment');
    await settle();
   };

   // Bar 1a: Escape with nothing open leaves comment mode on and list open.
   await check(`${kind} ${lang} bar1 escape nothing open`,async()=>{
    await resetMode();
    await pressKey('Escape');
    const s=await modeState();
    assert.equal(s.active,true,'Escape with nothing open keeps comment mode on');
    assert.equal(s.listOpen,true,'Escape with nothing open keeps list open');
    return s;
   });

   // Bar 1b: Escape during a pending drag drops the drag and keeps comment mode on and list open.
   await check(`${kind} ${lang} bar1 escape pending drag`,async()=>{
    await resetMode();
    const b=await viewportBox();
    assert.ok(control);
    await control('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x+70,y:b.y,button:'none',buttons:0});
    await control('Input.dispatchMouseEvent',{type:'mousePressed',x:b.x+70,y:b.y,button:'left',buttons:1,clickCount:1});
    await control('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.x+95,y:b.y+25,button:'left',buttons:1});
    await settle();
    await pressKey('Escape');
    await control('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.x+95,y:b.y+25,button:'left',buttons:0,clickCount:1});
    await settle();
    const s=await modeState();
    assert.equal(s.composer,false,'pending drag was dropped without opening composer');
    assert.equal(s.regions,1,'only the saved comment region remains');
    assert.equal(s.active,true,'Escape on pending drag keeps comment mode on');
    assert.equal(s.listOpen,true,'Escape on pending drag keeps list open');
    return s;
   });

   // Bar 1c: Escape on a new draft drops the draft and keeps comment mode on and list open.
   await check(`${kind} ${lang} bar1 escape new draft`,async()=>{
    await resetMode();
    const b=await viewportBox();
    await mouseDrag({x:b.x+70,y:b.y},{x:b.x+100,y:b.y+25},'left');
    await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'new draft composer');
    await control!('Input.insertText',{text:'unsaved draft'});
    await pressKey('Escape');
    const s=await modeState();
    assert.equal(s.composer,false,'new draft composer dropped');
    assert.equal(s.items,1,'no draft comment added');
    assert.equal(s.active,true,'Escape on new draft keeps comment mode on');
    assert.equal(s.listOpen,true,'Escape on new draft keeps list open');
    return s;
   });

   // Bar 1d: Escape on an open editable comment reverts text (and geometry on parts) and keeps comment mode on.
   await check(`${kind} ${lang} bar1 escape editable comment`,async()=>{
    await resetMode();
    const beforeBox=await p.evaluate<{left:string;top:string;width:string;height:string}>(`(()=>{const n=document.querySelector('.stage-comment-region:not([data-comment-handle])');return {left:n.style.left,top:n.style.top,width:n.style.width,height:n.style.height};})()`);
    await click(p,'.stage-comment-summary');
    await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'editable composer');
    await settle();
    if(kind==='parts'){
     const h=await p.evaluate<{x:number;y:number}>(`(()=>{const n=document.querySelector('[data-comment-handle="se"]'),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
     await mouseDrag(h,{x:h.x+18,y:h.y+18},'left');
    }
    await p.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer input');f.focus();f.value='mutated text';})()`);
    await pressKey('Escape');
    const s=await modeState();
    const afterBox=await p.evaluate<{left:string;top:string;width:string;height:string}>(`(()=>{const n=document.querySelector('.stage-comment-region:not([data-comment-handle])');return {left:n.style.left,top:n.style.top,width:n.style.width,height:n.style.height};})()`);
    await click(p,'.stage-comment-summary');
    await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'reopen editable composer');
    const reopened=await modeState();
    await pressKey('Escape');
    assert.equal(s.composer,false,'editable composer closed on Escape');
    assert.equal(s.handles,0,'geometry handles removed on Escape');
    assert.equal(reopened.value,'Seed note','editable comment text reverted');
    assert.deepEqual(afterBox,beforeBox,'geometry reverted');
    assert.equal(s.active,true,'Escape on editable comment keeps comment mode on');
    assert.equal(s.listOpen,true,'Escape on editable comment keeps list open');
    return {reopenedValue:reopened.value,activeAfter:s.active};
   });

   // Find the rendered pin rect for Bars 2 & 3 (dragging directly over a pin).
   const pinCenter=()=>p.evaluate<{x:number;y:number}>(`(()=>{
    const pin=document.querySelector(${JSON.stringify('#'+screen!.viewportId+' .stage-comment-pin')});
    const r=pin.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
   })()`);

   // Bar 2: In comment mode, a left drag with Space held pans the camera, creates no mark, does not open a pin under the pointer, leaves no pending area, and after releasing Space clicking that pin opens it.
   await check(`${kind} ${lang} bar2 space left-drag pan over pin`,async()=>{
    await resetMode();
    const startAt=await pinCenter(),before=await panPos();
    await holdSpace(true);
    try{
     await mouseDrag(startAt,{x:startAt.x+36,y:startAt.y+22},'left');
    }finally{
     await holdSpace(false);
    }
    const after=await panPos(),s=await modeState();
    assert.ok(Math.abs(after.x-before.x-36)<=2&&Math.abs(after.y-before.y-22)<=2,`Space+left-drag panned camera (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
    assert.equal(s.items,1,'creates no mark');
    assert.equal(s.composer,false,'pin under pointer does not open during Space-drag');
    assert.equal(s.regions,1,'no pending area remains after release');
    assert.equal(s.active,true,'comment mode stays on');
    await click(p,`#${screen!.viewportId} .stage-comment-pin`);
    await settle();
    const openedAfterSpaceDrag=await modeState();
    assert.equal(openedAfterSpaceDrag.composer,true,'clicking pin after releasing Space opens it');
    await pressKey('Escape');
    return {delta:{dx:after.x-before.x,dy:after.y-before.y},openedAfterSpaceDrag:openedAfterSpaceDrag.composer,state:s};
   });

   // Bar 3a: In comment mode, a right-button drag without Space held pans, creates no mark, does not open a pin, leaves no pending area, and clicking that pin afterward opens it.
   await check(`${kind} ${lang} bar3 right-drag pan without space over pin`,async()=>{
    await resetMode();
    const startAt=await pinCenter(),before=await panPos();
    await mouseDrag(startAt,{x:startAt.x-30,y:startAt.y+18},'right');
    const after=await panPos(),s=await modeState();
    assert.ok(Math.abs(after.x-before.x+30)<=2&&Math.abs(after.y-before.y-18)<=2,`Right-drag panned camera (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
    assert.equal(s.items,1,'creates no mark');
    assert.equal(s.composer,false,'pin under pointer does not open during right-drag');
    assert.equal(s.regions,1,'no pending area remains after release');
    assert.equal(s.active,true,'comment mode stays on');
    await click(p,`#${screen!.viewportId} .stage-comment-pin`);
    await settle();
    const openedAfterRightDrag=await modeState();
    assert.equal(openedAfterRightDrag.composer,true,'clicking pin after right-drag opens it');
    await pressKey('Escape');
    return {delta:{dx:after.x-before.x,dy:after.y-before.y},openedAfterRightDrag:openedAfterRightDrag.composer,state:s};
   });

   // Bar 3b (owner's exact sentence): In comment mode, Space held + right-button drag pans.
   await check(`${kind} ${lang} bar3 space held + right-drag pan over pin`,async()=>{
    await resetMode();
    const startAt=await pinCenter(),before=await panPos();
    await holdSpace(true);
    try{
     await mouseDrag(startAt,{x:startAt.x+30,y:startAt.y-18},'right');
    }finally{
     await holdSpace(false);
    }
    const after=await panPos(),s=await modeState();
    assert.ok(Math.abs(after.x-before.x-30)<=2&&Math.abs(after.y-before.y+18)<=2,`Space+right-drag panned camera (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
    assert.equal(s.items,1,'creates no mark');
    assert.equal(s.composer,false,'pin under pointer does not open');
    assert.equal(s.regions,1,'no pending area remains after release');
    assert.equal(s.active,true,'comment mode stays on');
    return {delta:{dx:after.x-before.x,dy:after.y-before.y},state:s};
   });

   // Bar 1f: The toggle button and C turn comment mode off (and back on).
   await check(`${kind} ${lang} bar1 toggle button and C turn mode off and on`,async()=>{
    await resetMode();
    await click(p,'#stage-comment');
    await settle();
    const afterClickOff=await modeState();
    assert.equal(afterClickOff.active,false,'toggle button turns comment mode off');
    await click(p,'#stage-comment');
    await settle();
    const afterClickOn=await modeState();
    assert.equal(afterClickOn.active,true,'toggle button turns comment mode on');
    await pressKey('c','KeyC',67);
    const afterKeyOff=await modeState();
    assert.equal(afterKeyOff.active,false,'C key turns comment mode off');
    await pressKey('c','KeyC',67);
    const afterKeyOn=await modeState();
    assert.equal(afterKeyOn.active,true,'C key turns comment mode on');
    return {afterClickOff:afterClickOff.active,afterClickOn:afterClickOn.active,afterKeyOff:afterKeyOff.active,afterKeyOn:afterKeyOn.active};
   });

   if(!redMode){
    // Bar 5: No context menu opens on the view surface; toolbars, panels and the composer's text box keep the browser menu.
    await check(`${kind} ${lang} bar5 contextmenu cancellation surface`,async()=>{
     await click(p,'.stage-comment-summary');
     await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'composer for contextmenu');
     const menuRes=await p.evaluate<Record<string,boolean>>(`(()=>{
      const probe=sel=>{
       const node=document.querySelector(sel);
       const ev=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});
       node.dispatchEvent(ev);
       return ev.defaultPrevented;
      };
      return {
       stage:probe('#stage-layout'),
       pane:probe(${JSON.stringify('#'+screen!.paneId)}),
       viewport:probe(${JSON.stringify('#'+screen!.viewportId)}),
       composerInput:probe('.stage-comment-composer input'),
       composerForm:probe('.stage-comment-composer'),
       toolbar:probe('#stage-comment'),
       inspector:probe('.inspector'),
      };
     })()`);
     assert.equal(menuRes.stage,true,'stage cancels contextmenu');
     assert.equal(menuRes.pane,true,'pane cancels contextmenu');
     assert.equal(menuRes.viewport,true,'viewport cancels contextmenu');
     assert.equal(menuRes.composerInput,false,'composer input keeps browser menu');
     assert.equal(menuRes.composerForm,false,'composer form keeps browser menu');
     assert.equal(menuRes.toolbar,false,'toolbar keeps browser menu');
     assert.equal(menuRes.inspector,false,'inspector keeps browser menu');
     await pressKey('Escape');
     return menuRes;
    });

    // Bar 4: With comment mode off, right-drag (and Space + right-drag) pans without physics carry; plain left drag pans and carries physics on rig.
    await check(`${kind} ${lang} bar4 comment mode off right-drag and left-drag physics carry`,async()=>{
     if((await modeState()).active)await click(p,'#stage-comment');
     await settle();
     assert.equal((await modeState()).active,false,'comment mode is off');
     if(kind==='rig'&&await p.evaluate(`document.getElementById('play').textContent==='Ⅱ'`))await click(p,'#play');
     await settle();
     const canvasSnap=()=>p.evaluate<string>(`(()=>{const c=document.querySelector('#rig-root canvas,#a-root canvas');return c?c.toDataURL():'';})()`);
     const b=await viewportBox();
     const p0=await panPos(),snap0=await canvasSnap();
     await mouseDrag({x:b.x+20,y:b.y+20},{x:b.x+60,y:b.y+45},'right');
     const p1=await panPos(),snap1=await canvasSnap();
     assert.ok(Math.abs(p1.x-p0.x-40)<=2&&Math.abs(p1.y-p0.y-25)<=2,'right-drag pans with comment mode off');
     if(kind==='rig')assert.equal(snap1,snap0,'right-drag does not carry physics');
     await holdSpace(true);
     try{
      await mouseDrag({x:b.x+60,y:b.y+45},{x:b.x+20,y:b.y+20},'right');
     }finally{
      await holdSpace(false);
     }
     const p2=await panPos(),snap2=await canvasSnap();
     assert.ok(Math.abs(p2.x-p1.x+40)<=2&&Math.abs(p2.y-p1.y+25)<=2,'Space + right-drag pans with comment mode off');
     if(kind==='rig')assert.equal(snap2,snap0,'Space + right-drag does not carry physics');
     await mouseDrag({x:b.x+20,y:b.y+20},{x:b.x+70,y:b.y+50},'left');
     const p3=await panPos(),snap3=await canvasSnap();
     assert.ok(Math.abs(p3.x-p2.x-50)<=2&&Math.abs(p3.y-p2.y-30)<=2,`plain left-drag pans with comment mode off (p2=${JSON.stringify(p2)}, p3=${JSON.stringify(p3)})`);
     if(kind==='rig')assert.notEqual(snap3,snap2,'plain left-drag carries rig physics');
     return {rightDelta:{dx:p1.x-p0.x,dy:p1.y-p0.y},spaceRightDelta:{dx:p2.x-p1.x,dy:p2.y-p1.y},leftDelta:{dx:p3.x-p2.x,dy:p3.y-p2.y},physicsCarried:kind==='rig'?snap3!==snap2:null};
    });
   }

   // Bar 1e: Escape on an open read-only (submitted/locked) comment hides it while keeping comment mode on and the list open.
   await check(`${kind} ${lang} bar1 escape read-only comment`,async()=>{
    await resetMode();
    if(kind==='compare'){
     await click(p,'#submit');
     await wait(p,`!document.getElementById('submit').disabled&&!document.getElementById('save-state').classList.contains('dirty')`,'compare submitted');
    }else{
     await click(p,'#send-comments');
     await wait(p,`document.getElementById('review-draft-state')?.dataset.saveState==='saved'`,kind+' submitted');
    }
    if(!(await modeState()).active)await click(p,'#stage-comment');
    await settle();
    await click(p,'.stage-comment-summary');
    await wait(p,`!!document.querySelector('.stage-comment-composer input')`,'read-only composer open');
    const openState=await modeState();
    assert.equal(openState.readOnly,true,'submitted comment opens read-only');
    await pressKey('Escape');
    const afterState=await modeState();
    assert.equal(afterState.composer,false,'Escape hides read-only comment');
    assert.equal(afterState.active,true,'Escape on read-only comment keeps comment mode on');
    assert.equal(afterState.listOpen,true,'Escape on read-only comment keeps list open');
    return {readOnly:openState.readOnly,activeAfter:afterState.active,listOpenAfter:afterState.listOpen};
   });

  }finally{
   await page?.close();
   await screen?.close();
   await rm(work,{recursive:true,force:true});
  }
 }
}

console.log('COMMENT_PAN_ESCAPE_897 '+JSON.stringify({redMode,checks:report.length,failures}));
assert.deepEqual(failures,[]);
