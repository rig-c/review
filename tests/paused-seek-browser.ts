/**
 * #935: a paused seek to the take's end lands on the same frame whatever came before it: fresh, after a seek
 * elsewhere, after playback across the loop. Compared at the instant the seek resolves and after 60 held steps,
 * against a fresh player seeking under the standing world. Ordinary Nova; synthetic public mesh and plates.
 * A time-varying wind (breeze, repeating gust) is not covered: its standing world at a seek depends on the wind
 * clock, which awaits a ruling on #935.
 */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
import {installSceneFixture} from './helpers/scene-inspection-fixture.ts';
import {directionPhysicsModel} from './helpers/direction-playback.ts';
const arg=Bun.argv.indexOf('--out'),out=resolve(arg<0?'artifacts/paused-seek-935':Bun.argv[arg+1]!);
await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'paused-seek-935-'));
let page:InputCdpSession|undefined;const servers:{stop():void}[]=[],errors:unknown[]=[];
const probe=`
const verts935=()=>{const mesh=player.posedFrame().order.find(p=>p.kind==='mesh');return [...mesh.vertices];};
const p935={on:false,n:0,target:60,snap:null};
const adv935=RigPlayer.prototype.advance;
RigPlayer.prototype.advance=function(dt){const r=adv935.call(this,dt);if(p935.on&&this===player&&this.held&&!playing){p935.n++;if(p935.n===p935.target)p935.snap=verts935();}return r;};
let wraps935=0;const tick935=tickPlaying;tickPlaying=now=>{const before=time;tick935(now);if(time<before)wraps935++;};
Object.assign(window,{__p935:{ready:()=>!!activeScene()&&!!player?.current,
 scrub:t=>{const c=input('scrub');c.value=String(t);p935.on=false;c.dispatchEvent(new Event('input',{bubbles:true}));const v=verts935();p935.n=0;p935.snap=null;p935.on=true;
  const oracle=new RigPlayer(document.createElement('div'),assets,{mode:'canvas'});let o;try{oracle.play(animation,{loop:true});oracle.environment(player.environment());oracle.seek(takeSample(activeScene(),t).sourceTime);o=[...oracle.posedFrame().order.find(p=>p.kind==='mesh').vertices];}finally{oracle.dispose();}
  return {v,o,time,source:player.time,env:player.environment(),wind:wind.read().time,applied:environmentApplied()};},
 held:()=>p935.snap,heldCount:()=>p935.n,wraps:()=>wraps935,time:()=>time,playing:()=>playing}});
`;
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'p935',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));}}]});
assert.ok(built.success,JSON.stringify(built.logs));
async function wait(expression:string,ms=25000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await page!.evaluate<any>(expression);if(value)return value;await Bun.sleep(30);}throw Error('WAIT '+expression);}
const spread=(a:number[],b:number[])=>{let m=0;for(let i=0;i<a.length;i+=2)m=Math.max(m,Math.hypot(a[i]!-b[i]!,a[i+1]!-b[i+1]!));return m;};
const results:Record<string,unknown>={};
try{
 const pkg=join(root,'package');await mkdir(pkg);
 await writeFile(join(pkg,'skeleton.model.json'),JSON.stringify(await directionPhysicsModel()));
 await copyFile('tests/fixtures/strip-probe/build/mesh.png',join(pkg,'mesh.png'));
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'paused-seek-935',title:'Paused seek fixture',revision:'1',model:'skeleton.model.json',animations:[{id:'inspect',label:'Inspect'}]}));
 const {direction}=await installSceneFixture(pkg);direction.timing.keys[0]!.easing='linear';
 await writeFile(join(pkg,'direction.json'),JSON.stringify(direction));
 page=await launchCdpSession(join(root,'profile'),{sendDeadlineMs:30000,browserArgs:['--renderer-process-limit=2'],onEvent(event){if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1280,900);
 for(const world of ['default','base']){
  const context=await createReviewRequestContext(await loadReview(pkg),{port:0,bundle:built.outputs[0]!,viewOnly:true,stateDir:join(root,'state-'+world)});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,async fetch(req,srv){return (await context.handle(req,srv.port,srv))!;}});
  servers.push({stop(){context.stop();server.stop(true);}});
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await wait('window.__p935?.ready()');
  await page.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
  await wait(`!document.querySelector('#play').disabled`);
  if(world==='base')await page.evaluate(`(()=>{const c=document.querySelector('#wind-base');c.value='3';c.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const T=8,rows:any={};
  const instant=async(name:string)=>{const s:any=await page!.evaluate(`window.__p935.scrub(${T})`);await wait('window.__p935.held()',20000);const h:number[]=await page!.evaluate('window.__p935.held()');rows[name]={v:s.v,h,oracle:spread(s.v,s.o),env:s.env,wind:s.wind,applied:s.applied,source:s.source};};
  await instant('a');
  await page.evaluate(`window.__p935.scrub(4)`);await Bun.sleep(400);
  await instant('c');
  await page.evaluate(`document.querySelector('#play').click()`);await wait('window.__p935.wraps()>=1&&window.__p935.time()>1.5',30000);
  await page.evaluate(`document.querySelector('#play').click()`);
  await instant('b');
  await instant('a2');
  const summary={applied:rows.a.applied,
   instant:{ab:spread(rows.a.v,rows.b.v),ac:spread(rows.a.v,rows.c.v),aa2:spread(rows.a.v,rows.a2.v)},
   held60:{ab:spread(rows.a.h,rows.b.h),ac:spread(rows.a.h,rows.c.h),aa2:spread(rows.a.h,rows.a2.h)},
   oracleStanding:{a:rows.a.oracle,b:rows.b.oracle,c:rows.c.oracle},
   env:{a:rows.a.env,b:rows.b.env,c:rows.c.env},wind:{a:rows.a.wind,b:rows.b.wind,c:rows.c.wind,a2:rows.a2.wind}};
  results[world]=summary;console.log('PAUSED_SEEK_935',world,JSON.stringify(summary));
  assert.equal(rows.a.applied,world!=='default');assert.ok(rows.b.wind>0,'playback crossed the loop');
  for(const [name,value] of Object.entries({...summary.instant,...summary.held60,...summary.oracleStanding}))assert.equal(value,0,world+' '+name+' '+JSON.stringify(summary));
 }
 await writeFile(join(out,'report.json'),JSON.stringify({results,errors},null,2));
 assert.deepEqual(errors,[]);
}finally{await page?.close();for(const server of servers)server.stop();assert.ok(root.startsWith(join(tmpdir(),'paused-seek-935-')));await rm(root,{recursive:true,force:true});}
