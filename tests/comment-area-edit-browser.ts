/** #891 owner-picked gestures, real job host and Side by side; ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {resolvedCropPath} from '../src/comment-crops.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
const at=Bun.argv.indexOf('--out'),out=resolve(at<0?'artifacts/comment-area-edit':Bun.argv[at+1]!);
await mkdir(out,{recursive:true});
const report:any[]=[],failures:string[]=[];
async function wait(p:InputCdpSession,e:string){const until=Date.now()+10000;while(Date.now()<until){if(await p.evaluate(e))return;await Bun.sleep(30);}throw Error('WAIT '+e);}
async function check(name:string,run:()=>Promise<void>){try{await run();report.push({name,pass:true});}catch(e){failures.push(name+': '+e);report.push({name,pass:false,error:String(e)});}await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));}
for(const lang of (Bun.argv.includes('--pilot-only')?[]:Bun.argv.includes('--red')?['en']:['en','ko']) as ('en'|'ko')[])for(const zoom of (Bun.argv.includes('--red')?['native-one']:['native-one','fit'])){
 const f=await scriptedJobWindowFixture({c5Parts:'no-mesh'}),profile=await mkdtemp('/tmp/review891-');let p:InputCdpSession|undefined,control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 try{
  // Scale the existing public fixture for native gestures before publication.
  const pkg=f.packageRoot,manifest=JSON.parse(await readFile(join(pkg,'parts.json'),'utf8'));
  for(const path of ['painting.png','parts/body.png','parts/front.png']){const a=PNG.sync.read(await readFile(join(pkg,path))),b=new PNG({width:a.width*10,height:a.height*10});for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)b.data.set(a.data.subarray((Math.floor(y/10)*a.width+Math.floor(x/10))*4,(Math.floor(y/10)*a.width+Math.floor(x/10))*4+4),(y*b.width+x)*4);await writeFile(join(pkg,path),PNG.sync.write(b));}
  manifest.rig_size=[320,240];for(const a of manifest.parts)for(const k of ['x','y','w','h'])a[k]*=10;
  await writeFile(join(pkg,'parts.json'),JSON.stringify(manifest));const context=f.input.getContext(),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  const refs=[{path:'parts/body.png',role:'part'},{path:'parts/front.png',role:'part'},{path:'painting.png',role:'painting'}];
  const images=await Promise.all(refs.map(async r=>({...r,sha256:hash(await readFile(join(pkg,r.path)))})));
  f.input.setPartsReferences(refs);f.input.setContext({...context,parts:{...context.parts!,manifest:{path:'out/parts.json',sha256:hash(await readFile(join(pkg,'parts.json')))},images}});
  const pub=await f.publish('parts');await f.ask(pub,{kind:'parts-verdict',draftId:'synthetic-parts'});
  p=await launchCdpSession(profile,{sendDeadlineMs:20000,onEvent(event,send){if(event.sessionId)control=send;}});const page=p;await page.setViewport(1440,900);const url=new URL(f.host.ownerUrl);url.searchParams.set('lang',lang);await page.goto(url.href,lang);
  await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.getElementById('parts-canvas')?.width===320`);
  await page.evaluate(`(()=>{window.__891=[];window.__891Bad=[];const native=window.fetch;window.fetch=async(...args)=>{const response=await native(...args);if(!response.ok)window.__891Bad.push({url:String(args[0]),status:response.status,body:await response.clone().text()});if(String(args[0]).endsWith('/comment')&&response.ok)window.__891.push((await response.clone().json()).comment);return response;};})()`);
  const last=()=>page.evaluate<any>(`window.__891.at(-1)`);
  const camera=()=>page.evaluate<any>(`(()=>{const c=document.getElementById('parts-canvas'),r=c.getBoundingClientRect();return {x:r.left,y:r.top,z:r.width/c.width};})()`);
  async function drag(a:{x:number;y:number},b:{x:number;y:number},shift=false){
   const mouse=async(type:string,point:{x:number;y:number},buttons:number)=>{if(shift){assert.ok(control);await control('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',buttons,clickCount:1,modifiers:8});}else await page.mouse(type as 'mouseMoved'|'mousePressed'|'mouseReleased',point.x,point.y);};
   await mouse('mouseMoved',a,0);await mouse('mousePressed',a,1);await mouse('mouseMoved',b,1);await mouse('mouseReleased',b,0);await Bun.sleep(80);
  }
  async function sourceDrag(a:{x:number;y:number},b:{x:number;y:number}){const c=await camera();await drag({x:c.x+a.x*c.z,y:c.y+a.y*c.z},{x:c.x+b.x*c.z,y:c.y+b.y*c.z});}
  async function save(text:string){await page.evaluate(`(()=>{const field=document.querySelector('.stage-comment-composer input');field.value=${JSON.stringify(text)};field.focus();})()`);assert.ok(control);await control('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await control('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait(page,`!document.querySelector('.stage-comment-composer')`);}
  async function escape(){assert.ok(control);await control('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await control('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
  async function open(id:string){await escape();await click(page,`[data-comment-id="${id}"] .stage-comment-summary`);await wait(page,`!!document.querySelector('.stage-comment-composer')`);await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);}
  async function handle(name:string,dx:number,dy:number){const r=await page.evaluate<any>(`(()=>{const n=document.querySelector('[data-comment-handle="${name}"]');if(!n)return null;const r=n.getBoundingClientRect();for(const y of [.5,.3,.7,.2,.8])for(const x of [.5,.3,.7,.2,.8]){const point={x:r.left+r.width*x,y:r.top+r.height*y};if(document.elementFromPoint(point.x,point.y)===n)return point;}throw Error('No unobscured ${name} handle');})()`);assert.ok(r,'handle '+name);await drag(r,{x:r.x+dx,y:r.y+dy});}
  {
   await escape();await click(page,'#'+zoom);await click(page,'#stage-comment');
   await sourceDrag({x:60,y:60},{x:120,y:110});await wait(page,`!!document.querySelector('.stage-comment-composer')`);await save('seed '+lang+zoom);const seed=await last(),id=seed.id;
   await check(lang+' '+zoom+' bar1 pin drag',async()=>{
    const n=await page.evaluate<number>(`document.querySelectorAll('.stage-comment-item').length`),r=await page.evaluate<any>(`[...document.querySelectorAll('.stage-comment-pin')].at(-1).getBoundingClientRect().toJSON()`);
    await drag({x:r.left+r.width/2,y:r.top+r.height/2},{x:r.left+r.width/2+35,y:r.top+r.height/2+25});
    assert.ok(await page.evaluate(`!!document.querySelector('.stage-comment-composer')`),'pin drag opens new composer');await save('overlap '+lang+zoom);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-item').length`),n+1);
   });
   await check(lang+' '+zoom+' bar2 click',async()=>{const count=await page.evaluate(`document.querySelectorAll('.stage-comment-item').length`);await open(id);assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').value`),seed.summary);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-item').length`),count,'click creates no area');});
   for(const name of ['nw','n','ne','e','se','s','sw','w'])await check(lang+' '+zoom+' bar3 '+name,async()=>{
    await open(id);const before=(await page.evaluate<any[]>(`window.__891`)).filter(c=>c.id===id).at(-1),c=await camera();
    const dx=name.includes('w')?-5: name.includes('e')?5:0,dy=name.includes('n')?-5:name.includes('s')?5:0;
    await handle(name,dx*c.z,dy*c.z);await save('resize '+name);const after=await last(),r=before.rigRegion;
    assert.deepEqual(after.rigRegion,{x:r.x+(name.includes('w')?-5:0),y:r.y+(name.includes('n')?-5:0),width:r.width+(dx?5:0),height:r.height+(dy?5:0)});
   });
   await check(lang+' '+zoom+' bar4 move',async()=>{await open(id);const before=(await page.evaluate<any[]>(`window.__891`)).filter(c=>c.id===id).at(-1),c=await camera();await handle('move',8*c.z,6*c.z);await save('moved');const a=await last();assert.deepEqual(a.rigRegion,{...before.rigRegion,x:before.rigRegion.x+8,y:before.rigRegion.y+6});});
   if(Bun.argv.includes('--red'))continue;
   await check(lang+' '+zoom+' bar5 escape/reopen',async()=>{const before=(await page.evaluate<any[]>(`window.__891`)).filter(c=>c.id===id).at(-1);await open(id);await handle('w',-12,0);await escape();await open(id);await save('unchanged after Escape');assert.deepEqual((await last()).rigRegion,before.rigRegion);await open(id);assert.equal(await page.evaluate(`document.querySelectorAll('button[data-comment-handle]').length`),8);});
   await check(lang+' '+zoom+' bar6 reopened tags',async()=>{await open(id);const before=(await page.evaluate<any[]>(`window.__891`)).filter(c=>c.id===id).at(-1);await handle('e',15,0);await save('kept reopened');assert.deepEqual((await last()).parts,before.parts);});
   await check(lang+' '+zoom+' bar9 shift',async()=>{await open(id);const r=await page.evaluate<any>(`document.querySelector('[data-comment-handle="move"]').getBoundingClientRect().toJSON()`);await drag({x:r.left+r.width*.6,y:r.top+r.height*.4},{x:r.left+r.width*.6+15,y:r.top+r.height*.4+15},true);assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').value`),'');await escape();});
   await check(lang+' '+zoom+' bar9 shift handle',async()=>{await open(id);const r=await page.evaluate<any>(`document.querySelector('[data-comment-handle="nw"]').getBoundingClientRect().toJSON()`);await drag({x:r.left+r.width/2,y:r.top+r.height/2},{x:r.left+r.width/2+20,y:r.top+r.height/2+20},true);assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').value`),'');await escape();});
   for(const touched of [false,true])await check(lang+' '+zoom+' bar6 new chips '+touched,async()=>{
    await escape();await click(page,'#stage-comment');await sourceDrag({x:80,y:90},{x:110,y:120});await wait(page,`!!document.querySelector('.stage-comment-composer')`);
    if(touched)await click(page,'[data-comment-part="front"]');const before=await page.evaluate(`document.querySelector('[data-comment-part="front"]').getAttribute('aria-pressed')`),c=await camera();await handle('e',105*c.z,0);
    assert.equal(await page.evaluate(`document.querySelector('[data-comment-part="front"]').getAttribute('aria-pressed')`),touched?before:'true');await escape();
   });
   await check(lang+' '+zoom+' bar8 crop',async()=>{await open(id);await handle('s',0,-5);await save('fresh crop');const a=await last();assert.notEqual(a.crop.sha256,seed.crop.sha256);const decoded=PNG.sync.read(Buffer.from(a.crop.png.split(',')[1],'base64'));assert.equal(decoded.width,a.crop.width);assert.equal(decoded.height,a.crop.height);assert.equal(a.imageRegion,null);assert.equal(a.nativeCrop,null);report.push({name:'crop binding '+lang+zoom,region:a.rigRegion,crop:{width:a.crop.width,height:a.crop.height,hash:a.crop.sha256},camera:a.view.camera});});
  }
  await check(lang+' '+zoom+' bar8 item crop source pixels',async()=>{
   await escape();if(!await page.evaluate(`document.querySelector('[data-part-list] button[data-slot="body"]').getAttribute('aria-pressed')==='true'`))await click(page,'[data-part-list] button[data-slot="body"]');await wait(page,`!document.getElementById('part-solo').disabled`);await click(page,'#part-solo');await wait(page,`document.getElementById('parts-canvas').width===200`);await click(page,'#fit');await click(page,'#stage-comment');
   await sourceDrag({x:35,y:35},{x:65,y:65});await wait(page,`!!document.querySelector('.stage-comment-composer')`);await save('item crop seed');const original=await last();await open(original.id);await handle('se',10,10);await save('item crop resized');const issue=await last(),r=issue.imageRegion;
   assert.ok(r);assert.deepEqual(issue.rigRegion,{...r,x:r.x+40,y:r.y+40});assert.equal(issue.nativeCrop.width,r.width);assert.equal(issue.nativeCrop.height,r.height);
   const native=PNG.sync.read(await readFile(resolvedCropPath(issue.nativeCrop.path))),source=PNG.sync.read(await readFile(join(pkg,'parts/body.png'))),expected=Buffer.alloc(r.width*r.height*4);
   for(let y=0;y<r.height;y++)source.data.copy(expected,y*r.width*4,((r.y+y)*source.width+r.x)*4,((r.y+y)*source.width+r.x+r.width)*4);
   assert.ok(native.data.equals(expected),'resized native crop matches new source region pixel-for-pixel');assert.notEqual(issue.crop.sha256,original.crop.sha256);assert.notEqual(issue.nativeCrop.sha256,original.nativeCrop.sha256);
   report.push({name:'item crop evidence '+lang+zoom,imageRegion:r,rigRegion:issue.rigRegion,nativeCrop:issue.nativeCrop});
  });
  await check(lang+' bar7 submitted',async()=>{await escape();await click(page,'#request-changes');await wait(page,`document.getElementById('review-draft-state')?.dataset.saveState==='saved'`).catch(async e=>{report.push({name:'submission diagnostic',state:await page.evaluate(`({message:document.getElementById('message')?.textContent,state:document.getElementById('review-draft-state')?.textContent,bad:window.__891Bad})`)});throw e;});await click(page,'#stage-comment');await page.evaluate(`document.querySelector('.stage-comment-summary').scrollIntoView({block:'nearest'})`);await click(page,'.stage-comment-summary');await wait(page,`!!document.querySelector('.stage-comment-composer')`);assert.equal(await page.evaluate(`document.querySelectorAll('[data-comment-handle]').length`),0);assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').readOnly`),true);});
 }finally{await p?.close();await f.close();await rm(profile,{recursive:true,force:true});}
}
/** Large synthetic source: 22 visible parts and a full painting, no pilot asset bytes. */
async function pilotCase(lang:'en'|'ko'){
 const f=await scriptedJobWindowFixture({c5Parts:'no-mesh'}),profile=await mkdtemp('/tmp/review891-large-');let p:InputCdpSession|undefined,control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 try{
  const pkg=f.packageRoot,width=2400,height=2200,painting=new PNG({width,height});
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)painting.data.set([40+Math.floor(x/40)%100,50+Math.floor(y/40)%100,100,255],(y*width+x)*4);
  const parts=[{name:'body',x:200,y:200,w:2000,h:1800},...Array.from({length:21},(_,i)=>({name:i===0?'front':'detail_'+i,x:600+i%7*120,y:500+Math.floor(i/7)*240,w:80,h:160}))];
  await writeFile(join(pkg,'painting.png'),PNG.sync.write(painting));
  for(const part of parts){const png=new PNG({width:part.w,height:part.h});for(let y=0;y<part.h;y++)painting.data.copy(png.data,y*part.w*4,((part.y+y)*width+part.x)*4,((part.y+y)*width+part.x+part.w)*4);await writeFile(join(pkg,'parts/'+part.name+'.png'),PNG.sync.write(png));}
  await writeFile(join(pkg,'parts.json'),JSON.stringify({rig_size:[width,height],scale_rig_per_source:1,parts:parts.map(part=>({...part,from:'synthetic:'+part.name}))}));
  const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),refs=[...parts.map(part=>({path:'parts/'+part.name+'.png',role:'part'})),{path:'painting.png',role:'painting'}],images=await Promise.all(refs.map(async r=>({...r,sha256:hash(await readFile(join(pkg,r.path)))}))),context=f.input.getContext();
  f.input.setPartsReferences(refs);f.input.setContext({...context,partIds:parts.map(part=>part.name),parts:{...context.parts!,manifest:{path:'out/parts.json',sha256:hash(await readFile(join(pkg,'parts.json')))},images}});
  const pub=await f.publish('parts');await f.ask(pub,{kind:'parts-verdict',draftId:'synthetic-parts'});
  p=await launchCdpSession(profile,{sendDeadlineMs:20000,onEvent(event,send){if(event.sessionId)control=send;}});const page=p;await page.setViewport(1440,900);const url=new URL(f.host.ownerUrl);url.searchParams.set('lang',lang);await page.goto(url.href,lang);
  await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.getElementById('parts-canvas')?.width===2400`);
  await page.evaluate(`(()=>{window.__891Large=[];window.__891Events=[];for(const name of ['pointerdown','pointerup','click'])document.addEventListener(name,e=>window.__891Events.push({type:name,target:e.target.className,handle:e.target.dataset?.commentHandle,x:e.clientX,y:e.clientY}),true);const native=window.fetch;window.fetch=async(...args)=>{const response=await native(...args);if(String(args[0]).endsWith('/comment')&&response.ok)window.__891Large.push((await response.clone().json()).comment);return response;};})()`);
  const settle=()=>page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const camera=()=>page.evaluate<any>(`['rig','reference'].map(target=>{const root=document.getElementById(target==='rig'?'rig-root':'reference-content'),pane=document.getElementById(target+'-viewport');return {target,zoom:new DOMMatrix(root.style.transform).a,pan:{left:root.style.left,top:root.style.top},scroll:{x:pane.scrollLeft,y:pane.scrollTop},paint:{x:root.getBoundingClientRect().x,y:root.getBoundingClientRect().y},viewport:{width:pane.clientWidth,height:pane.clientHeight}};})`);
  const pins=()=>page.evaluate<any[]>(`[...document.querySelectorAll('.stage-comment-pin')].map((n,i)=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {i,text:n.textContent,rect:r.toJSON(),hittable:n===hit||n.contains(hit)};})`);
  async function drag(a:{x:number;y:number},b:{x:number;y:number}){await page.mouse('mouseMoved',a.x,a.y);await page.mouse('mousePressed',a.x,a.y);await page.mouse('mouseMoved',b.x,b.y);await page.mouse('mouseReleased',b.x,b.y);await settle();}
  async function escape(){assert.ok(control);for(const type of ['keyDown','keyUp'])await control('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();}
  async function save(summary:string){await page.evaluate(`(()=>{const n=document.querySelector('.stage-comment-composer input');n.value=${JSON.stringify(summary)};n.focus();})()`);assert.ok(control);await control('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await control('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait(page,`!document.querySelector('.stage-comment-composer')`);await settle();}
  await click(page,'#fit');if(!await page.evaluate(`document.getElementById('camera-sync').checked`))await click(page,'#camera-sync');await click(page,'#stage-comment');await settle();const initial=await camera();
  assert.ok(initial.every((c:any)=>c.zoom<=.4&&c.zoom>0));assert.equal(await page.evaluate(`document.querySelector('#view-menu [data-view="compare"]').getAttribute('aria-pressed')`),'true');assert.equal(await page.evaluate(`document.getElementById('camera-sync').checked`),true);assert.equal(await page.evaluate(`document.querySelectorAll('[data-part-list] button').length`),22);
  const points=await page.evaluate<any>(`(()=>{const c=document.getElementById('parts-canvas'),r=c.getBoundingClientRect(),z=r.width/c.width;return {a:{x:r.left+1000*z,y:r.top+600*z},b:{x:r.left+1300*z,y:r.top+900*z}};})()`);
  await drag(points.a,points.b);await wait(page,`!!document.querySelector('.stage-comment-composer')`);
  if(Bun.argv.includes('--composer-probe')){
   const r=await page.evaluate<any>(`document.querySelector('.stage-comment-composer').getBoundingClientRect().toJSON()`);await drag({x:r.left+3,y:r.top+3},{x:r.left+10,y:r.top+9});
   report.push({name:'composer background pan evidence '+lang,before:initial,after:await camera(),events:await page.evaluate(`window.__891Events`)});
   await check(lang+' pilot draft composer must not pan',async()=>assert.deepEqual(await camera(),initial));return;
  }
  await save('large area 1');
  await check(lang+' pilot camera after save 1',async()=>assert.deepEqual(await camera(),initial));
  if(!Bun.argv.includes('--pilot-main')){
   const r=(await pins())[0].rect;await drag({x:r.left+r.width/2,y:r.top+r.height/2},{x:r.left+r.width/2+35,y:r.top+r.height/2+25});await wait(page,`!!document.querySelector('.stage-comment-composer')`);await save('large area 2');
   await check(lang+' pilot camera after save 2',async()=>assert.deepEqual(await camera(),initial));
   await check(lang+' pilot both pins hittable',async()=>{const all=await pins();assert.equal(all.length,2);assert.ok(all.every(pin=>pin.hittable),JSON.stringify(all));});
  }
  const saved=await page.evaluate<any[]>(`window.__891Large.slice(0,2)`);const count=Bun.argv.includes('--pilot-main')?1:2;
  for(let i=0;i<count;i++)await check(lang+' pilot open resize save pin '+(i+1),async()=>{
   await escape();await click(page,'.stage-comment-pin:nth-of-type('+(i+1)+')');await wait(page,`!!document.querySelector('.stage-comment-composer')||document.getElementById('message')?.textContent.includes('PARTS_CAMERA_RANGE')`);await settle();
   const footer=await page.evaluate<string>(`document.getElementById('message')?.textContent||''`);assert.ok(!footer.includes('PARTS_CAMERA_RANGE'),footer);assert.deepEqual(await camera(),initial,'opening retains both zoom and pan');assert.ok((await pins()).every(pin=>pin.hittable),'pins stay hittable while the composer is open');
   if(Bun.argv.includes('--pilot-main'))return;
   await check(lang+' pilot composer blocks pan '+i,async()=>{const r=await page.evaluate<any>(`document.querySelector('.stage-comment-composer').getBoundingClientRect().toJSON()`);await drag({x:r.left+3,y:r.top+3},{x:r.left+10,y:r.top+9});assert.deepEqual(await camera(),initial,'composer background must not pan the canvas');assert.ok(await page.evaluate(`!!document.querySelector('.stage-comment-composer')`));});
   const r=await page.evaluate<any>(`(()=>{const n=document.querySelector('[data-comment-handle="se"]'),r=n.getBoundingClientRect();if(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)!==n)throw Error('Resize handle is occluded');return r.toJSON();})()`);await drag({x:r.left+r.width/2,y:r.top+r.height/2},{x:r.left+r.width/2+5,y:r.top+r.height/2+5});await save('large resized '+i);assert.deepEqual(await camera(),initial,'saving resized area retains both zoom and pan');
   const edited=await page.evaluate<any>(`window.__891Large.at(-1)`);assert.equal(edited.id,saved[i].id);assert.ok(edited.rigRegion.width>saved[i].rigRegion.width&&edited.rigRegion.height>saved[i].rigRegion.height,'the real handle changed saved geometry');
  });
  report.push({name:'pilot state '+lang,initial,after:await camera(),pins:await pins(),events:await page.evaluate(`window.__891Events`),footer:await page.evaluate(`document.getElementById('message')?.textContent`),comments:await page.evaluate(`window.__891Large.map(c=>({id:c.id,parts:c.parts,rigRegion:c.rigRegion,camera:c.view.camera}))`)});
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
 }finally{await p?.close();await f.close();await rm(profile,{recursive:true,force:true});}
}
if(!Bun.argv.includes('--red'))for(const lang of ['en','ko'] as const)await pilotCase(lang);
console.log('COMMENT_AREA_EDIT_891 '+JSON.stringify({checks:report.filter(x=>'pass'in x).length,failures}));
assert.deepEqual(failures,[]);
