import { launchChrome } from './helpers/software-capture.ts';
/**
 * Browser runner for #345 (explicit, separate from `bun test`): the chest panel on a rig with a contour mesh (chest tools
 * enabled) and on one with grid meshes only (disabled, reason shown).
 *
 * - Marker toggle: no chest overlay is drawn at load, it is drawn after one click on the toggle, and gone after a second.
 * - Compare → Setup → Chest (the compare page serves its own stylesheet): the Markers button shows exactly one state label,
 *   following its pressed state, and the regions are the table layout.
 * - `--shots <dir>`: panel screenshots at 1440 and 1024 px wide in en and ko for both rigs, and the Compare block.
 *
 * The rigs are synthetic: the `strip-probe` test model with a config that declares a contour mesh, or grid meshes only.
 * Stand-in producers answer `--version`; nothing is rebuilt.
 *
 *   bun tests/chest-panel-browser.ts [--shots <dir>]
 */
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {loadCompare} from '../src/compare.ts';
import {startCompareServer} from '../src/compare-server.ts';
import {PROBE_MP4_BASE64} from './compare-mode-browser.ts';

interface Page {viewport(w:number,h:number):Promise<void>;goto(url:string):Promise<void>;evaluate<T>(expression:string):Promise<T>;screenshot(clip?:{x:number;y:number;width:number;height:number}):Promise<Buffer>;close():Promise<void>}

function browserBinary():string {
 const roots=[join(homedir(),'.cache','ms-playwright'),join(homedir(),'Library','Caches','ms-playwright')],found:string[]=[];
 for(const root of roots){if(!existsSync(root))continue;for(const entry of readdirSync(root).sort().reverse().filter(e=>e.startsWith('chromium-')))found.push(
  join(root,entry,'chrome-linux','chrome'),join(root,entry,'chrome-linux64','chrome'),
  join(root,entry,'chrome-mac','Chromium.app','Contents','MacOS','Chromium'),join(root,entry,'chrome-mac-arm64','Chromium.app','Contents','MacOS','Chromium'),
  join(root,entry,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'),join(root,entry,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'));}
 const candidates=[process.env.CHROME_BIN,...found,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].filter((c):c is string=>!!c);
 const bin=candidates.find(c=>existsSync(c));if(!bin)throw new Error('No headless Chromium/Chrome binary found (set CHROME_BIN)');return bin;
}

async function launch(profile:string):Promise<Page> {
 const chrome=await launchChrome([browserBinary(),'--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--mute-audio','--hide-scrollbars']);
 const {endpoint}=chrome;
 try {
  const targets=await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as {type:string;webSocketDebuggerUrl?:string}[];
  const ws=new WebSocket(targets.find(t=>t.type==='page')!.webSocketDebuggerUrl!);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0;const pending=new Map<number,{res:(v:any)=>void;rej:(e:Error)=>void}>();
  ws.onmessage=event=>{const msg=JSON.parse(String(event.data));const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);if(msg.error)p.rej(new Error(msg.error.message));else p.res(msg.result);};
  const send=(method:string,params:Record<string,unknown>={})=>new Promise<any>((res,rej)=>{const n=++id;pending.set(n,{res,rej});ws.send(JSON.stringify({id:n,method,params}));});
  await send('Page.enable');await send('Runtime.enable');
  return {
   viewport:(width,height)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}),
   async goto(url){await send('Page.navigate',{url});for(let i=0;i<200;i++){const r=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});if(r?.result?.value==='complete')break;await Bun.sleep(50);}},
   async evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r?.exceptionDetails)throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description??''}`);return r?.result?.value;},
   async screenshot(clip){const r=await send('Page.captureScreenshot',{format:'png',...(clip?{clip:{...clip,scale:1}}:{})});return Buffer.from(r.data,'base64');},
   async close(){try{ws.close();}catch{}await chrome.close();},
  };
 }catch(error){await chrome.close();throw error;}
}

/** A synthetic package: the strip-probe model, and a config that declares the `mesh` part as a contour mesh or as a grid. */
async function writePackage(root:string,name:string,kind:'contour'|'grid'):Promise<string> {
 const probe=new URL('./fixtures/strip-probe/build/',import.meta.url),pkg=join(root,name);
 for(const dir of ['build','images','rig/out/rig','rig/out/parts'])await mkdir(join(pkg,dir),{recursive:true});
 // Crop px: the stage below is an 80×64 crop frame (root at its bottom centre), so (58, 50) sits on the `mesh` part.
 const regions=[{name:'bust_r',shape:'circle',cx:50,cy:50,r:4,bone:'mesh',spacing:4,band:3},{name:'bust_l',shape:'circle',cx:66,cy:50,r:4,bone:'mesh',spacing:4,band:3}];
 const mesh=kind==='contour'?{contour:{tolerance:2,margin:2,spacing:8,maxEdge:16,stray:40,bridges:true,regions},r:6,segments:[['mesh',[10,2],[10,18]]]}:{grid:12,r:6,segments:[['mesh',[10,2],[10,18]]]};
 const config={key:`chest-${kind}`,bones:[{name:'rigid',parent:'root',at:[-18,0],tip:[-18,12]},{name:'mesh',parent:'root',at:[18,0],points:[[18,0],[18,6]],tip:[18,12]}],regions:{rigid:'rigid'},meshes:{mesh,...(kind==='grid'?{rigid:{grid:10,r:6,segments:[['rigid',[0,2],[0,18]]]}}:{})}};
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,2));
 await writeFile(join(pkg,'rig/out/parts.json'),JSON.stringify({parts:[{name:'mesh',box:[0,0,20,20]},{name:'rigid',box:[0,0,20,20]}]}));
 await writeFile(join(pkg,'rig/out/rig/rig.json'),JSON.stringify({bones:[{name:'root'},{name:'rigid'},{name:'mesh'}]}));
 await writeFile(join(pkg,'rig/out/rig/motion.json'),'{}');await writeFile(join(pkg,'rig/out/rig/mesh_report.json'),'{}');
 // The chest overlay needs a crop → world mapping: a stage with the root at its bottom centre.
 const model=JSON.parse(await readFile(new URL('skeleton.model.json',probe),'utf8'));model.stage={...model.stage,x:-model.stage.width/2,y:0};
 await writeFile(join(pkg,'build/skeleton.model.json'),JSON.stringify(model));
 for(const png of ['rigid.png','mesh.png']){const bytes=await readFile(new URL(png,probe));await writeFile(join(pkg,'build',png),bytes);await writeFile(join(pkg,'images',png),bytes);}
 return pkg;
}
async function writeProducers(root:string):Promise<void> {
 for(const [dir,name,bin,version] of [['@rig-c/parts','@rig-c/parts','rig-parts','1.42.0'],['rig-c','rig-c','rigc','2.64.1'],['@rig-c/pose','@rig-c/pose','rig-pose','0.37.0']] as const){
  await mkdir(join(root,'node_modules',dir,'bin'),{recursive:true});
  await writeFile(join(root,'node_modules',dir,'package.json'),JSON.stringify({name,version,bin:{[bin]:`./bin/${bin}.cjs`}}));
  await writeFile(join(root,'node_modules',dir,'bin',`${bin}.cjs`),`if(process.argv[2]==='--version'){console.log('${version}');process.exit(0);}process.exit(2);`);
 }
}

/** Waits for the stage and the rebuild status, then selects Setup. */
const READY=`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 for(let i=0;i<400;i++){const h=document.getElementById('handoff-line'),c=document.querySelector('#rig-root canvas');if(c&&h&&h.textContent&&!/Reading/.test(h.textContent))break;await sleep(25);}
 document.querySelector('button[data-inspector="rig"]')?.click();await sleep(150);return true;})()`;
/** What the stage draws for the chest tools right now, read through the page's own overlay sources. */
const DRAWN=`(()=>{const c=window.rigReviewEditor?.chest;return c?c.drawn():null;})()`;
const PRESSED=`document.getElementById('chest-edit').getAttribute('aria-pressed')`;

export async function runChestPanelBrowser(shots:string|null):Promise<string[]> {
 const root=await realpath(await mkdtemp(join(process.env.TMPDIR??tmpdir(),'review-chest-panel-')));
 const failures:string[]=[];let page:Page|null=null;const servers:{stop:()=>unknown}[]=[];
 try{
  await writeProducers(root);
  const contour=await writePackage(root,'contour','contour'),grid=await writePackage(root,'grid','grid'),contourB=await writePackage(root,'contour-b','contour');
  const reference=join(root,'ref.mp4');await writeFile(reference,Buffer.from(PROBE_MP4_BASE64,'base64'));
  page=await launch(join(root,'profile'));
  const urls:Record<string,string>={};
  const keep={graceMs:3_600_000,unopenedTimeoutMs:3_600_000,exitOnClose:false};
  for(const [name,dir] of [['contour',contour],['grid',grid]] as const){const server=await startServer(await loadReview(dir),{port:0,stateDir:join(root,'state',name),...keep});servers.push(server as any);urls[name]=`http://127.0.0.1:${(server as any).port}/`;}
  {const server=await startCompareServer(await loadCompare({a:contour,b:contourB,reference,animation:'inspect'}),{port:0,stateDir:join(root,'state','compare'),...keep});servers.push(server as any);urls.compare=`http://127.0.0.1:${(server as any).port}/`;}

  // Compare → Setup → Chest: one state label that follows pressed, and the table layout.
  await page.viewport(1440,900);await page.goto(urls.compare+'?lang=en');
  const compareReads=await page.evaluate<{pressed:string|null;labels:string[];table:string;rowCols:string}[]>(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   for(let i=0;i<400;i++){const play=document.getElementById('play'),h=document.getElementById('handoff-line');if(play&&!play.disabled&&document.querySelector('#a-root canvas, #a-root img')&&h&&h.textContent&&!/Reading/.test(h.textContent))break;await sleep(25);}
   const setup=document.querySelector('.mode-switch [data-mode="rig"]');
   for(let i=0;i<200&&setup.getAttribute('aria-pressed')!=='true';i++){if(i%20===0)setup.click();await sleep(25);}
   for(let i=0;i<200;i++){const m=document.getElementById('chest-markers');if(m&&!m.disabled)break;await sleep(25);}
   document.getElementById('block-tab-chest-regions')?.click();await sleep(200);
   const read=()=>{const m=document.getElementById('chest-markers');return {pressed:m.getAttribute('aria-pressed'),labels:[...m.querySelectorAll('.chest-markers-state')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.textContent),table:getComputedStyle(document.querySelector('.chest-table')).tableLayout,rowCols:getComputedStyle(document.querySelector('.chest-contour')).gridTemplateColumns};};
   const out=[read()];document.getElementById('chest-markers').click();await sleep(150);out.push(read());document.getElementById('chest-markers').click();await sleep(150);out.push(read());return out;})()`);
  console.log(JSON.stringify({compare:compareReads}));
  for(const [i,r] of compareReads.entries()){
   const want=i===1?'true':'false';
   if(r.pressed!==want||r.labels.length!==1||r.labels[0]!==(want==='true'?'On':'Off'))failures.push(`COMPARE_MARKERS_STATE: step ${i} pressed=${r.pressed} labels=${JSON.stringify(r.labels)}`);
   // The new layout: a fixed-layout regions table, and the contour settings in one auto-filled row (the old sheet's 2-column grid).
   if(r.table!=='fixed'||/^repeat\(2,/.test(r.rowCols)||r.rowCols.split(' ').length<3)failures.push(`COMPARE_CHEST_TABLE_LAYOUT: step ${i} table-layout=${r.table} contour columns=${r.rowCols}`);
  }
  if(shots){await mkdir(shots,{recursive:true});await page.evaluate(`(async()=>{const s=document.getElementById('chest-regions');s.scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,100));})()`);await writeFile(join(shots,'chest-compare-1440-en-block.png'),await page.screenshot());}

  // The marker toggle: off at load, on after one click, off after a second.
  await page.viewport(1440,900);await page.goto(urls.contour+'?lang=en');await page.evaluate(READY);
  const reads:{pressed:string;drawn:{circles:number;regions:number;markers:number}|null}[]=[];
  if(shots){await mkdir(shots,{recursive:true});await writeFile(join(shots,'chest-contour-1440-en-load.png'),await page.screenshot());}
  for(let step=0;step<3;step++){
   if(step)await page.evaluate(`(async()=>{document.getElementById('chest-edit').click();await new Promise(r=>setTimeout(r,120));})()`);
   reads.push({pressed:await page.evaluate<string>(PRESSED),drawn:await page.evaluate(DRAWN)});
  }
  const total=(d:typeof reads[number]['drawn'])=>d?d.circles+d.regions+d.markers:NaN;
  const [load,on,off]=reads;
  if(!load!.drawn)failures.push('CHEST_DRAWN_HOOK_MISSING: rigReviewEditor.chest.drawn() is not exposed');
  if(load!.pressed!=='false'||total(load!.drawn)!==0)failures.push(`CHEST_MARKERS_AT_LOAD: pressed=${load!.pressed} drawn=${JSON.stringify(load!.drawn)}`);
  if(on!.pressed!=='true'||!(total(on!.drawn)>0))failures.push(`CHEST_MARKERS_NOT_ON: pressed=${on!.pressed} drawn=${JSON.stringify(on!.drawn)}`);
  if(off!.pressed!=='false'||total(off!.drawn)!==0)failures.push(`CHEST_MARKERS_NOT_OFF: pressed=${off!.pressed} drawn=${JSON.stringify(off!.drawn)}`);
  console.log(JSON.stringify({toggle:reads}));

  if(shots){
   await mkdir(shots,{recursive:true});
   for(const width of [1440,1024])for(const lang of ['en','ko'])for(const rig of ['contour','grid'] as const){
    await page.viewport(width,900);await page.goto(`${urls[rig]}?lang=${lang}`);await page.evaluate(READY);
    if(rig==='contour')await page.evaluate(`(async()=>{const b=document.getElementById('chest-edit');if(b.getAttribute('aria-pressed')!=='true')b.click();await new Promise(r=>setTimeout(r,200));})()`);
    const state=await page.evaluate<{toggle:{disabled:boolean;title:string;hidden:boolean};bar:{x:number;y:number;width:number;height:number}|null;view:{x:number;y:number;width:number;height:number}}>(`(()=>{
     const t=document.getElementById('chest-edit'),bar=document.getElementById('chest-editor-bar'),vb=document.querySelector('.viewbar'),box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
     return {toggle:{disabled:t.disabled,title:t.title,hidden:t.hidden},bar:bar&&!bar.hidden?box(bar):null,view:box(vb)};})()`);
    const top=Math.max(0,Math.floor(state.view.y)),bottom=Math.ceil(state.bar?state.bar.y+state.bar.height:state.view.y+state.view.height)+8;
    await writeFile(join(shots,`chest-${rig}-${width}-${lang}.png`),await page.screenshot({x:0,y:top,width,height:Math.max(40,bottom-top)}));
    await writeFile(join(shots,`chest-${rig}-${width}-${lang}-full.png`),await page.screenshot());
    // The inspector's Chest block (the bottom panel).
    const block=await page.evaluate<{x:number;y:number;width:number;height:number}>(`(async()=>{document.getElementById('block-tab-chest-regions').click();await new Promise(r=>setTimeout(r,150));
     const s=document.getElementById('chest-regions');s.scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,100));const r=s.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
    await writeFile(join(shots,`chest-${rig}-${width}-${lang}-block.png`),await page.screenshot());
    console.log(JSON.stringify({rig,width,lang,toggle:state.toggle,bar:state.bar,block}));
    if(rig==='grid'&&(!state.toggle.disabled||!state.toggle.title))failures.push(`CHEST_GRID_NOT_DISABLED: ${width} ${lang}`);
   }
  }
 }finally{
  await page?.close();for(const s of servers)try{await (s as any).stop?.();}catch{}
  await rm(root,{recursive:true,force:true});
 }
 return failures;
}

if(import.meta.main){
 const i=process.argv.indexOf('--shots'),shots=i>0?process.argv[i+1]??null:null;
 const failures=await runChestPanelBrowser(shots);
 if(failures.length){console.error(failures.join('\n'));process.exit(1);}
 console.log('chest panel browser: PASS');process.exit(0);
}
