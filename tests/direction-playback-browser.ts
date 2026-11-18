/** #930 real shared workspace playback, ordinary Nova; synthetic public mesh and plates. */
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
type PoseSample={actual:number[];expected:number[];source:number;expectedSource:number;take:number};
type LoopReport={inside:number;wraps:number[][];sourceError:number;frames:number};
const arg=Bun.argv.indexOf('--out'),out=resolve(arg<0?'artifacts/direction-playback-930':Bun.argv[arg+1]!);
await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'direction-playback-930-'));
let page:InputCdpSession|undefined;const servers:{stop():void}[]=[],errors:unknown[]=[],observations:unknown[]=[];
// Read after the real tick and draw. This wrapper records only; it never steps/seeks or replaces physics.
const probe=`
let record930=null;
const vertices930=()=>{const mesh=player.posedFrame().order.find(p=>p.kind==='mesh');if(!mesh)throw Error('DIRECTION_MESH_REQUIRED');return [...mesh.vertices];};
const originalTick930=tickPlaying;
tickPlaying=now=>{const before=time,previous=player?.current?vertices930():null;originalTick930(now);if(!record930||!previous||time===before)return;
 const next=vertices930(),jump=next.filter((_,i)=>i%2===0).map((_,v)=>Math.hypot(next[v*2]-previous[v*2],next[v*2+1]-previous[v*2+1]));
 if(time<before)record930.wraps.push(jump);else record930.inside=Math.max(record930.inside,...jump);
 const expected=takeSample(activeScene(),time).sourceTime%player.entry(0).duration,actual=player.entry(0).animationTime,error=Math.abs(actual-expected);
 record930.sourceError=Math.max(record930.sourceError,Math.min(error,Math.abs(error-player.entry(0).duration)));record930.frames++;
};
Object.assign(window,{__direction930:{ready:()=>!!activeScene()&&!!player?.current,state:()=>({playing,time,source:player?.time,vertices:player?.current?vertices930():null}),record:()=>{record930={inside:0,wraps:[],sourceError:0,frames:0};},report:()=>record930,
 scrub:target=>{const control=input('scrub');control.value=String(target);control.dispatchEvent(new Event('input',{bubbles:true}));const actual=vertices930(),source=player.time;
 const oracle=new RigPlayer(document.createElement('div'),assets,{mode:'canvas'});try{oracle.play(animation,{loop:true});oracle.seek(takeSample(activeScene(),target).sourceTime);const mesh=oracle.posedFrame().order.find(p=>p.kind==='mesh');return {actual,expected:[...mesh.vertices],source,expectedSource:oracle.time,take:time};}finally{oracle.dispose();}}
}});
`;
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'direction-observer',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));}}]});
assert.ok(built.success,JSON.stringify(built.logs));
async function wait(expression:string,ms=25000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await page!.evaluate<any>(expression);if(value)return value;await Bun.sleep(50);}throw Error('DIRECTION_WAIT '+expression+' '+await page!.evaluate('document.body.innerText'));}
try{
 const pkg=join(root,'package');await mkdir(pkg);
 await writeFile(join(pkg,'skeleton.model.json'),JSON.stringify(await directionPhysicsModel()));
 await copyFile('tests/fixtures/strip-probe/build/mesh.png',join(pkg,'mesh.png'));
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'direction-930',title:'Direction physics fixture',revision:'1',model:'skeleton.model.json',animations:[{id:'inspect',label:'Inspect'}]}));
 const {direction}=await installSceneFixture(pkg);direction.timing.keys[0]!.easing='linear';
 await writeFile(join(pkg,'direction.json'),JSON.stringify(direction));
 page=await launchCdpSession(join(root,'profile'),{sendDeadlineMs:30000,browserArgs:['--renderer-process-limit=2','--js-flags=--max-old-space-size=1536'],onEvent(event){if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1280,900);
 for(const language of ['en','ko']){
  const context=await createReviewRequestContext(await loadReview(pkg),{port:0,bundle:built.outputs[0]!,viewOnly:true,stateDir:join(root,'state-'+language)});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,async fetch(req,srv){return (await context.handle(req,srv.port,srv))!;}});
  servers.push({stop(){context.stop();server.stop(true);}});
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${language}`);
  await wait('window.__direction930?.ready()');
  await page.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
  await wait(`!document.querySelector('#play').disabled`);
  const initial:PoseSample=await page.evaluate<PoseSample>('window.__direction930.scrub(0)');assert.deepEqual(initial.actual,initial.expected);assert.equal(initial.source,initial.expectedSource);
  await page.evaluate(`window.__direction930.record();document.querySelector('#play').click()`);
  await wait('window.__direction930.report().wraps.length>=2',25000);
  // Pause and read synchronously before held physics receives another animation frame.
  const report:LoopReport=await page.evaluate<LoopReport>(`(()=>{document.querySelector('#play').click();return window.__direction930.report();})()`);
  assert.ok(report.frames>100);assert.equal(report.wraps.length,2);assert.ok(report.inside>0);
  for(const seam of report.wraps)for(const jump of seam)assert.ok(jump<=report.inside+1e-9,JSON.stringify(report));
  assert.ok(report.sourceError<1e-9,JSON.stringify(report));
  const scrubs=[];
  for(const target of [.125,7.75,0,4,8]){
   const sample:PoseSample=await page.evaluate<PoseSample>(`window.__direction930.scrub(${target})`);assert.deepEqual(sample.actual,sample.expected);assert.equal(sample.source,sample.expectedSource);assert.equal(sample.take,target);scrubs.push(sample);
  }
  await writeFile(join(out,language+'.png'),await page.screenshot());observations.push({language,initial,report,scrubs});
  await writeFile(join(out,'report.json'),JSON.stringify({observations,errors},null,2));console.log('DIRECTION_BROWSER_PASS',JSON.stringify({language,...report}));
 }
 assert.deepEqual(errors,[]);
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),errors,observations,body:await page?.evaluate('document.body.innerText')},null,2));if(page)await writeFile(join(out,'failure.png'),await page.screenshot());throw error;
}finally{await page?.close();for(const server of servers)server.stop();assert.ok(root.startsWith(join(tmpdir(),'direction-playback-930-')));await rm(root,{recursive:true,force:true});}
