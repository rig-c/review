/** #346 actual Animate transport regression. Test hooks only observe or displace the real player. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
const out=resolve('.review-state/346/browser');await mkdir(out,{recursive:true});
const model=JSON.parse(await readFile('tests/fixtures/compare-probe/skeleton.model.json','utf8'));
model.constraints=[{kind:'physics',name:'probe_physics',declaredIn:'rig',bone:'probe',x:1,y:1,rotate:1,strength:30,damping:0.7,inertia:1,mass:1,wind:0,gravity:0,mix:1}];
// A stationary clip makes the equilibrium independently observable.
model.animations[0].bones=[{name:'root',timelines:[{name:'rotate',keys:[{time:0,value:0},{time:2,value:0}]}]}];
model.animations.push({...structuredClone(model.animations[0]),name:'idle'});
model.editorOrder.animations=['inspect','idle'];
await writeFile(join(out,'skeleton.model.json'),JSON.stringify(model));
await writeFile(join(out,'review.json'),JSON.stringify({schema:'rig-review/1',id:'paused-physics',title:'Paused physics',revision:'1',model:'skeleton.model.json',animations:[{id:'inspect',label:'Inspect'}]}));
const bundle=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'physics-observation',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:await readFile(path,'utf8')+`\nObject.assign(window,{__physicsRead:()=>{const b=player.bone('probe');return {x:b.x+b.a*12,y:b.y+b.c*12,time:player.time,clipTime:time,playing,wind:wind.read(),jolts:joltQueue.map(step=>({...step})),environment:player.environment()};},__physicsDisplace:()=>{player.hold(!playing);player.resume();player.moved({x:30});player.advance(1/60);player.draw();}});`}));}}]});
if(!bundle.success)throw new Error(String(bundle.logs));
const app=await startServer(await loadReview(out),{port:0,stateDir:join(out,'state'),initialAnimation:'inspect'});
const pw=await import(pathToFileURL(resolve(process.argv[2]!)).href);
const browser=await pw.chromium.launch({headless:true,args:['--js-flags=--max-old-space-size=2048']}),page=await browser.newPage();
const errors:string[]=[];
page.on('pageerror',(error:Error)=>errors.push(error.message));
try{
 await page.route('**/main.js',async(route:any)=>route.fulfill({contentType:'text/javascript',body:await bundle.outputs[0]!.text()}));
 await page.goto(`http://127.0.0.1:${app.port}/`);await page.waitForFunction(()=>!!(window as any).__physicsRead);
 await page.locator('[data-mode="playback"]').click();
 await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#play')!.disabled);await page.locator('#play').click();await page.waitForTimeout(150);
 const rest=await page.evaluate(()=>(window as any).__physicsRead());
 await page.evaluate(()=>(window as any).__physicsDisplace());
 await page.locator('#play').click();
 const first=await page.evaluate(()=>(window as any).__physicsRead());
 await page.waitForTimeout(1100);
 const second=await page.evaluate(()=>(window as any).__physicsRead());
 const distance=(a:any,b:any)=>Math.hypot(a.x-b.x,a.y-b.y);
 const report={rest,first,second,wallMs:1100,moved:distance(first,second),firstDistance:distance(first,rest),secondDistance:distance(second,rest)};
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(first.playing||second.playing||first.time!==second.time)throw new Error('TRACK_NOT_HELD');
 if(!(report.moved>1e-6&&report.secondDistance<report.firstDistance))throw new Error('PAUSED_PHYSICS_FROZEN_OR_NOT_SETTLING');
 // #363 P1: a watched repeating schedule and queued jolts freeze while held physics settles.
 const heldWorld=await page.evaluate(()=>{
  const set=(id:string,value:string|boolean,event:string)=>{
   const input=document.getElementById(id) as HTMLInputElement;
   if(typeof value==='boolean')input.checked=value;else input.value=value;
   input.dispatchEvent(new Event(event));
  };
  set('wind-base','0','input');
  set('wind-breeze',false,'change');
  set('gravity','0','input');
  set('wind-gust-peak','10','change');
  set('wind-gust-duration','0.2','change');
  set('wind-repeat',true,'change');
  set('environment-use',true,'change');
  const select=document.getElementById('animation-select') as HTMLSelectElement;
  select.value='inspect';select.dispatchEvent(new Event('change'));
  const rest=(window as any).__physicsRead();
  // The first held step initializes the reset solver before the displacement sample.
  (window as any).__physicsDisplace();
  (window as any).__physicsDisplace();
  document.getElementById('jolt')!.click();
  return {rest,first:(window as any).__physicsRead()};
 });
 await page.waitForTimeout(1100);
 const heldSecond=await page.evaluate(()=>(window as any).__physicsRead());
 const heldReport={...heldWorld,second:heldSecond,wallMs:1100,
  firstDistance:distance(heldWorld.first,heldWorld.rest),secondDistance:distance(heldSecond,heldWorld.rest)};
 await writeFile(join(out,'held-world.json'),JSON.stringify(heldReport,null,2));
 console.log('HELD_WORLD',JSON.stringify(heldReport));
 if(!heldWorld.first.wind.repeat||heldWorld.first.wind.time!==0||heldWorld.first.jolts.length!==2)throw new Error('HELD_WORLD_CONTROL_NOT_ARMED');
 if(heldSecond.wind.time!==heldWorld.first.wind.time||JSON.stringify(heldSecond.jolts)!==JSON.stringify(heldWorld.first.jolts))throw new Error('HELD_WORLD_CLOCK_OR_JOLTS_ADVANCED');
 if(JSON.stringify(heldSecond.environment)!==JSON.stringify(heldWorld.first.environment))throw new Error('HELD_ENVIRONMENT_CHANGED');
 if(!(distance(heldWorld.first,heldSecond)>1e-6&&heldReport.secondDistance<heldReport.firstDistance))throw new Error('HELD_WORLD_PHYSICS_NOT_SETTLING');
 await page.locator('#idle-repeat').uncheck();
 await page.selectOption('#animation-select','idle');
 await page.locator('#idle-repeat').check();
 await page.waitForFunction(()=>(window as any).__physicsRead().playing);
 await page.evaluate(()=>(window as any).__physicsDisplace());
 const continuity=await page.evaluate(async()=>{
  const read=()=>(window as any).__physicsRead();
  let previous=read(),inside=0;const wraps:number[]=[];
  const deadline=performance.now()+6000;
  while(wraps.length<2&&performance.now()<deadline){
   await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   const next=read(),jump=Math.hypot(next.x-previous.x,next.y-previous.y);
   if(next.clipTime<previous.clipTime)wraps.push(jump);else inside=Math.max(inside,jump);
   previous=next;
  }
  return {inside,wraps};
 });
 console.log('WRAP',JSON.stringify(continuity));
 await writeFile(join(out,'wrap.json'),JSON.stringify(continuity,null,2));
 if(continuity.wraps.length!==2||continuity.wraps.some((jump:number)=>jump>continuity.inside))throw new Error('WRAP_DISCONTINUITY');
 if(errors.length)throw new Error(errors.join('\n'));

}finally{await browser.close();app.stop();}
