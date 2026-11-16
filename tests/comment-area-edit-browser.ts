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
for(const lang of (Bun.argv.includes('--red')?['en']:['en','ko']) as ('en'|'ko')[])for(const zoom of (Bun.argv.includes('--red')?['native-one']:['native-one','fit'])){
 const f=await scriptedJobWindowFixture({c5Parts:'no-mesh'}),profile=await mkdtemp('/tmp/review891-');let p:InputCdpSession|undefined,control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 try{
  // Scale the existing public fixture for native gestures; add a narrow crowded strip before publication.
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
  async function handle(name:string,dx:number,dy:number){const r=await page.evaluate<any>(`document.querySelector('[data-comment-handle="${name}"]')?.getBoundingClientRect().toJSON()`);assert.ok(r,'handle '+name);await drag({x:r.left+r.width/2,y:r.top+r.height/2},{x:r.left+r.width/2+dx,y:r.top+r.height/2+dy});}
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
  await check(lang+' bar7 submitted',async()=>{await escape();await click(page,'#request-changes');await wait(page,`document.getElementById('review-draft-state')?.dataset.saveState==='saved'`).catch(async e=>{report.push({name:'submission diagnostic',state:await page.evaluate(`({message:document.getElementById('message')?.textContent,state:document.getElementById('review-draft-state')?.textContent,bad:window.__891Bad})`)});throw e;});await click(page,'#stage-comment');await click(page,'.stage-comment-summary');await wait(page,`!!document.querySelector('.stage-comment-composer')`);assert.equal(await page.evaluate(`document.querySelectorAll('[data-comment-handle]').length`),0);assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').readOnly`),true);});
 }finally{await p?.close();await f.close();await rm(profile,{recursive:true,force:true});}
}
console.log('COMMENT_AREA_EDIT_891 '+JSON.stringify({checks:report.filter(x=>'pass'in x).length,failures}));
assert.deepEqual(failures,[]);
