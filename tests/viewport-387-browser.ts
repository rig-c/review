/** Exact c9 app vs candidate: actual canvas composition, complete pair DOM/styles, normal control clock, old bookmark. */
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {viewportBrowser} from './helpers/viewport-387-browser.ts';
const baseline=resolve(Bun.argv[2]!),out=resolve(Bun.argv[3]??'tests/viewport-387-evidence'),fixture=resolve('tests/fixtures/viewport-387/package');await mkdir(out,{recursive:true});
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const browser=await viewportBrowser(await mkdtemp(join(tmpdir(),'viewport-387-browser-'))),report:any={schema:'viewport-387-browser/1',browser:browser.metadata,checks:[],cases:[]};
let server:ReturnType<typeof Bun.spawn>|null=null,port=0;let oldBookmark='';const snapshots:Record<string,any>={};
async function wait<T>(read:()=>Promise<T>,ready:(v:T)=>boolean,label:string,limit=15000):Promise<T>{const at=Date.now();for(;;){const v=await read();if(ready(v))return v;if(Date.now()-at>limit)throw Error('Timeout '+label+' '+JSON.stringify(v));await Bun.sleep(50);}}
async function start(app:string,label:string){
 server=Bun.spawn([process.execPath,'tests/viewport-387-server.ts',app,fixture,String(port),join(out,label+'-state')],{stdout:'pipe',stderr:'pipe'});
 const reader=(server.stdout as ReadableStream<Uint8Array>).getReader();let text='';const startAt=Date.now();while(!text.includes('\n')){const r=await Promise.race([reader.read(),new Promise<never>((_,no)=>setTimeout(()=>no(Error('App startup timeout '+text)),15000))]);if(r.done)throw Error('App startup exited '+await new Response(server.stderr as ReadableStream<Uint8Array>).text());text+=new TextDecoder().decode(r.value);if(Date.now()-startAt>15000)throw Error('Startup timeout');}reader.releaseLock();const info=JSON.parse(text.trim().split('\n').find(s=>s.startsWith('{'))!);port=info.port;return info;
}
async function stop(){if(server){server.kill('SIGTERM');await server.exited;server=null;}}
async function buildCapture(app:string){const built=await Bun.build({entrypoints:['tests/viewport-387-capture-entry.ts'],target:'browser',format:'iife',plugins:[{name:'exact-app-capture',setup(build){build.onResolve({filter:/^@viewport-387-capture$/},()=>({path:join(app,'web/viewport-capture.ts')}));}}]});if(!built.success)throw Error(String(built.logs));return await built.outputs[0]!.text();}
try{
 for(const [label,app]of [['baseline',baseline],['candidate',resolve('.')]]){
  const info=await start(app!,label!),origin='http://127.0.0.1:'+port,page=await browser.page();
  try{
   await page.size(1440,1000);await page.goto(origin+'/?lang=en');
   const state=async()=>{const r=await fetch(origin+'/api/control',{headers:{Authorization:'Bearer '+info.token}});if(!r.ok)throw Error(await r.text());return await r.json() as any;};
   await wait(async()=>{try{return await state();}catch{return null;}},v=>v?.pages?.length===1&&!v.pages[0].inspection.busy&&!v.pages[0].inspection.seeking&&!!v.pages[0].inspection.view?.cameras.rig&&!!v.pages[0].inspection.view?.cameras.reference,'ready');
   async function command(command:any){const current=await state(),p=current.pages[0],requestId=crypto.randomUUID(),r=await fetch(origin+'/api/control/commands',{method:'POST',headers:{Authorization:'Bearer '+info.token,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({schema:'rig-review-control-command/1',requestId,pageId:p.pageId,instanceKey:info.instanceKey,sourceHash:info.sourceHash,expectedRevision:p.revision,command})});const receipt:any=await r.json();if(!r.ok)throw Error(JSON.stringify(receipt));const done:any=await wait(async()=>await(await fetch(origin+'/api/control/receipts/'+receipt.commandId,{headers:{Authorization:'Bearer '+info.token}})).json(),(v:any)=>!['queued','dispatched'].includes(v.status),'command '+command.type);if(done.status!=='applied')throw Error(JSON.stringify(done));return done;}
   await command({type:'time',seconds:.25});await command({type:'layers',images:true,meshes:true,bones:false});
   const capture=await buildCapture(app!);await page.evaluate(capture);
   async function snapshot(name:string,compareAs=name){await page.evaluate('new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)))');await Bun.sleep(250);const current=await state(),inspection=current.pages[0].inspection;if(inspection.time!==.25||inspection.playing||inspection.seeking||inspection.busy)throw Error('Held normal control changed '+JSON.stringify(inspection));
    const actual:any=await page.evaluate(`globalThis.__viewport387Capture(${JSON.stringify(inspection.view)})`);const dom=Buffer.from(JSON.stringify(actual.dom));await writeFile(join(out,`${label}-${name}-pair.json`),dom);const row:any={label,name,time:inspection.time,view:inspection.view,domBytes:dom.length,domSha256:sha(dom),panes:{}};
    for(const key of ['rig','reference']){const p=actual.pixels[key],bytes=Buffer.from(p.rgba,'base64');await writeFile(join(out,`${label}-${name}-${key}.rgba`),bytes);row.panes[key]={width:p.width,height:p.height,bytes:bytes.length,sha256:sha(bytes)};actual.pixels[key]=bytes;}
    const png=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,`${label}-${name}-unmasked.png`),Buffer.from(png.data,'base64'));
    const previous=report.cases.filter((v:any)=>v.label===label).at(-1);if(name==='point-zoom'&&inspection.view.cameras.rig.zoom!==1.1)throw Error('Trusted wheel did not zoom');if(name==='pan'&&isDeepStrictEqual(previous?.view.cameras.rig.center,inspection.view.cameras.rig.center))throw Error('Trusted drag did not pan');if(name==='resize'&&isDeepStrictEqual(previous?.view.cameras.rig.viewport,inspection.view.cameras.rig.viewport))throw Error('Browser resize did not reach camera');report.cases.push(row);if(label==='baseline')snapshots[name]={dom,pixels:actual.pixels,view:inspection.view};else{const prior=snapshots[compareAs];const equality:any={name,domEqual:dom.equals(prior.dom),cameraEqual:isDeepStrictEqual(inspection.view,prior.view),panes:{}};for(const key of ['rig','reference']){const a:Buffer=prior.pixels[key],b:Buffer=actual.pixels[key];let deltas=Math.abs(a.length-b.length);for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])deltas++;equality.panes[key]={baselineBytes:a.length,candidateBytes:b.length,deltas};}report.checks.push(equality);}
   }
   await command({type:'fit',target:'rig'});await snapshot('fit');
   const r:any=await page.evaluate("(()=>{const r=document.getElementById('rig-viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
   await page.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:r.x+r.width*.27,y:r.y+r.height*.61,deltaX:0,deltaY:-120});await snapshot('point-zoom');
   const x=r.x+r.width*.42,y=r.y+r.height*.44;await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+73,y:y-31,button:'left',buttons:1});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+73,y:y-31,button:'left',buttons:0,clickCount:1});await snapshot('pan');
   await page.size(1280,920);await snapshot('resize');
   if(label==='baseline'){await wait(async()=>{const fragment=await page.evaluate<string>('location.hash');try{const encoded=fragment.slice(8).replaceAll('-','+').replaceAll('_','/');return {fragment,bookmark:JSON.parse(Buffer.from(encoded,'base64').toString('utf8'))};}catch{return {fragment,bookmark:null};}},v=>isDeepStrictEqual(v.bookmark?.view,snapshots.resize.view),'bookmark matches actual post-resize control camera');oldBookmark=await page.evaluate<string>('location.hash');await writeFile(join(out,'c9-bookmark.txt'),oldBookmark+'\n');report.baselineBookmark=oldBookmark;}
   {
    const target:any=snapshots.resize.view;await command({type:'fit',target:'rig'});const fitActual=(await state()).pages[0].inspection.view;
    await wait(async()=>{const fragment=await page.evaluate<string>('location.hash');try{return {fragment,view:JSON.parse(Buffer.from(fragment.slice(8).replaceAll('-','+').replaceAll('_','/'),'base64').toString('utf8')).view};}catch{return {fragment,view:null};}},v=>v.fragment!==oldBookmark&&isDeepStrictEqual(v.view,fitActual),'fit bookmark saved before old-link navigation');
    await page.evaluate(`location.hash=${JSON.stringify(oldBookmark)}`);
    await wait(async()=>({status:await page.evaluate<string>("document.getElementById('draft-state').textContent"),state:await state()}),v=>v.status.includes('restored')&&!v.state.pages[0].inspection.busy&&!v.state.pages[0].inspection.seeking,'old bookmark restore');
    const status=await page.evaluate<string>("document.getElementById('draft-state').textContent");if(/outside|unavailable|refused|failed|not restored/i.test(status))throw Error('Restore is a refusal, not success: '+status);
    await snapshot('bookmark-restored');const observed=(await state()).pages[0].inspection;report.bookmarks??={};report.bookmarks[label!]={status,cameraEqual:isDeepStrictEqual(observed.view,target),time:observed.time};if(!report.bookmarks[label!].cameraEqual)throw Error('Old bookmark camera differs');
   }
  }finally{await page.close();await stop();}
 }
 report.ok=report.checks.every((r:any)=>r.domEqual&&r.cameraEqual&&Object.values(r.panes).every((p:any)=>p.deltas===0))&&report.bookmarks?.baseline?.cameraEqual===true&&report.bookmarks?.candidate?.cameraEqual===true;
}catch(e){report.ok=false;report.error=e instanceof Error?e.stack:String(e);}finally{await stop();await browser.close();await writeFile(join(out,'browser-verdict.json'),JSON.stringify(report,null,2)+'\n');}
console.log('VIEWPORT_387 '+JSON.stringify(report));if(!report.ok)process.exit(1);
