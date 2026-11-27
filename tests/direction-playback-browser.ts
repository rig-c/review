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
import {turnPackage} from './helpers/turn-pad.ts';
type PoseSample={actual:number[];expected:number[];source:number;expectedSource:number;take:number};
type LoopReport={inside:number;wraps:number[][];sourceError:number;frames:number};
type TurnReading={displayed:number;angle:number};
type DialFrame={time:number;source:number;posed:number};
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
const dialFrame1283=target=>{
 seek(target);
 return {time,source:player.entry(0).animationTime,posed:player.bone('yaw_dial').rotationX};
};
let release1283=[];
Object.assign(window,{__direction930:{ready:()=>!!activeScene()&&!!player?.current,state:()=>({playing,time,source:player?.time,vertices:player?.current?vertices930():null}),record:()=>{record930={inside:0,wraps:[],sourceError:0,frames:0};},report:()=>record930,
 dialReady:()=>!!player?.current&&!!turnPad&&duration===1,
 dialFrames:count=>Array.from({length:count},(_,i)=>dialFrame1283(i/count)),
 bookmark:()=>inspectionBookmark(),
 restore:bookmark=>restoreInspection(bookmark,new AbortController().signal),
 release:()=>release1283,
 watchRelease:()=>el('rig-viewport').addEventListener('pointerleave',()=>{
  release1283=[];
  const sample=()=>{
   release1283.push({...dialFrame1283((release1283.length%60)/60),releasing:turnPad.state.releasing});
   if(turnPad.state.releasing&&release1283.length<180)requestAnimationFrame(sample);
  };
  sample();
 },{once:true}),
 turn:()=>{const output=document.querySelector('[data-turn-axis="yaw"]');
  const rectangle=player?.current&&player.posedFrame().order.find(row=>row.kind==='region'&&row.slot==='rectangle');
  if(!output?.getClientRects().length||!output.textContent?.trim()||!rectangle)return null;
  const [x0,y0,,,x1,y1]=rectangle.corners;
  return {displayed:Number(output.textContent),angle:Math.atan2(y1-y0,x1-x0)*180/Math.PI};},
 scrub:target=>{const control=input('scrub');control.value=String(target);control.dispatchEvent(new Event('input',{bubbles:true}));const actual=vertices930(),source=player.time;
 const oracle=new RigPlayer(document.createElement('div'),assets,{mode:'canvas'});try{oracle.play(animation,{loop:true});oracle.seek(takeSample(activeScene(),target).sourceTime);const mesh=oracle.posedFrame().order.find(p=>p.kind==='mesh');return {actual,expected:[...mesh.vertices],source,expectedSource:oracle.time,take:time};}finally{oracle.dispose();}}
}});
`;
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'direction-observer',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));}}]});
assert.ok(built.success,JSON.stringify(built.logs));
async function wait(expression:string,ms=25000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await page!.evaluate<any>(expression);if(value)return value;await Bun.sleep(50);}throw Error('DIRECTION_WAIT '+expression+' '+await page!.evaluate('document.body.innerText'));}
async function servePackage(pkg:string,state:string,initialAnimation?:string){
 const context=await createReviewRequestContext(await loadReview(pkg),{port:0,bundle:built.outputs[0]!,viewOnly:true,stateDir:join(root,state),initialAnimation});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,async fetch(req,srv){return (await context.handle(req,srv.port,srv))!;}});
 servers.push({stop(){context.stop();server.stop(true);}});
 assert.ok(server.port);
 return server.port;
}

function keyedYaw(time:number):number {
 if(time<=.25)return 8-64*time;
 if(time<=.5)return -8+48*(time-.25);
 return 4+8*(time-.5);
}
const fmt=(value:number)=>value.toFixed(6);
const probeRef='window.__direction930';
const stagePoint=`(()=>{const box=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:box.left+(box.width-1)*.75,y:box.top+(box.height-1)/2};})()`;
const toggleSmoothing=`document.querySelector('#turn-pad input[type="checkbox"]').click()`;

async function inspectDial(port:number,count:number){
 await page!.mouse('mouseMoved',5,5);
 await page!.goto(`http://127.0.0.1:${port}/?lang=en`);
 await wait(`${probeRef}?.dialReady()`);
 await page!.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
 await wait(`!document.querySelector('#play').disabled`);
 const read=()=>page!.evaluate<DialFrame[]>(`${probeRef}.dialFrames(${count})`);
 const absent=await page!.evaluate<Record<string,any>>(`${probeRef}.bookmark()`);
 assert.ok(!('turn' in absent.selection));
 const untouched=await read();
 assert.equal(untouched.length,count);
 untouched.forEach((row,i)=>{
  assert.ok(Math.abs(row.source-i/count)<1e-6,JSON.stringify(row));
  assert.ok(Math.abs(row.posed-keyedYaw(row.source))<1e-5,JSON.stringify(row));
 });
 await page!.evaluate(toggleSmoothing);
 const pointer=await page!.evaluate<{x:number;y:number}>(stagePoint);
 await page!.mouse('mouseMoved',pointer.x,pointer.y);
 const engaged=await read();
 engaged.forEach(row=>assert.ok(Math.abs(row.posed-20)<.25,JSON.stringify(row)));
 const legacy=await page!.evaluate<Record<string,any>>(`${probeRef}.bookmark()`);
 assert.equal(legacy.selection.turn.schema,'rig-review-turn/1');

 await page!.evaluate(`${toggleSmoothing};${probeRef}.watchRelease()`);
 await page!.mouse('mouseMoved',5,5);
 await wait(`${probeRef}.release().some(frame=>!frame.releasing)`,4000);
 const release=await page!.evaluate<(DialFrame&{releasing:boolean})[]>(`${probeRef}.release()`);
 assert.ok(release.length>2);
 assert.ok(Math.abs(release[0]!.posed-engaged[0]!.posed)<1e-5);
 const last=release.at(-1)!;
 assert.ok(Math.abs(last.posed-keyedYaw(last.source))<1e-5);
 await page!.evaluate(toggleSmoothing);
 await page!.mouse('mouseMoved',pointer.x,pointer.y);
 const returned=(await read())[0]!;
 assert.ok(Math.abs(returned.posed-engaged[0]!.posed)<1e-5);

 await page!.mouse('mouseMoved',5,5);
 await page!.evaluate(`${probeRef}.restore(${JSON.stringify(legacy)})`);
 assert.deepEqual(await read(),engaged);
 await page!.evaluate(`${probeRef}.restore(${JSON.stringify(absent)})`);
 assert.deepEqual(await read(),untouched);
 return {untouched,engaged,release,returned};
}
try{
 const pkg=join(root,'package');await mkdir(pkg);
 await writeFile(join(pkg,'skeleton.model.json'),JSON.stringify(await directionPhysicsModel()));
 await copyFile('tests/fixtures/strip-probe/build/mesh.png',join(pkg,'mesh.png'));
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'direction-930',title:'Direction physics fixture',revision:'1',model:'skeleton.model.json',animations:[{id:'inspect',label:'Inspect'}]}));
 const {direction}=await installSceneFixture(pkg);direction.timing.keys[0]!.easing='linear';
 await writeFile(join(pkg,'direction.json'),JSON.stringify(direction));
 page=await launchCdpSession(join(root,'profile'),{sendDeadlineMs:30000,browserArgs:['--renderer-process-limit=2','--js-flags=--max-old-space-size=1536'],onEvent(event){if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1280,900);
 for(const language of ['en','ko']){
  const port=await servePackage(pkg,'state-'+language);
  await page.goto(`http://127.0.0.1:${port}/?lang=${language}`);
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
 const turnPort=await servePackage('tests/fixtures/direction-inspection','state-turn','turn');
 await page.goto(`http://127.0.0.1:${turnPort}/?lang=en`);
 const readTurn='window.__direction930?.turn()';
 await wait(readTurn);
 await page.evaluate(`document.querySelector('#turn-pad input[type="checkbox"]').click()`);
 const before=await page.evaluate<TurnReading>(readTurn);
 const pointer=await page.evaluate<{x:number;y:number}>(`(()=>{const box=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:box.left+(box.width-1)*.75,y:box.top+box.height/2};})()`);
 await page.mouse('mouseMoved',pointer.x,pointer.y);
 const after=await page.evaluate<TurnReading>(readTurn);
 // The slider maps about 60 degrees of yaw to 20 degrees of rectangle rotation.
 // The visible readout rounds yaw to two decimal places.
 const yawDelta=after.displayed-before.displayed,angleDelta=after.angle-before.angle;
 assert.ok(yawDelta>10&&angleDelta>3&&Math.abs(angleDelta-yawDelta/3)<.004,
  'TURN_PAD_POINTER_POSE '+JSON.stringify({before,after,yawDelta,angleDelta}));
 observations.push({turn:{before,after,yawDelta,angleDelta}});
 await writeFile(join(out,'report.json'),JSON.stringify({observations,errors},null,2));
 console.log('TURN_PAD_POINTER_PASS',JSON.stringify({before,after,yawDelta,angleDelta}));
 const keyedRig=await turnPackage(join(root,'keyed-rig'),{keyedYaw:true});
 const keyedDirection=await turnPackage(join(root,'keyed-direction'),{keyedYaw:true});
 const keyed=await installSceneFixture(keyedDirection);
 keyed.direction.take.duration=1;
 keyed.direction.camera.keys[1]!.time=1;
 keyed.direction.timing.keys[0]!.easing='linear';
 Object.assign(keyed.direction.timing.keys[1]!,{time:1,source_time:1});
 await writeFile(join(keyedDirection,'direction.json'),JSON.stringify(keyed.direction));
 const motion=['# Review #1283 dial motion','',
  'Channel: posed yaw_dial rotation in degrees. Clip values come from the public fixture keys.',''];
 for(const [screen,fixture,count] of [['Direction',keyedDirection,60],['Rig review',keyedRig,12]] as const){
  const result=await inspectDial(await servePackage(fixture,'keyed-'+count,'inspect'),count);
  motion.push(`## ${screen} · one loop`,'','| Frame | Time (s) | Clip | Untouched | Engaged |','| ---: | ---: | ---: | ---: | ---: |');
  result.untouched.forEach((row,i)=>motion.push(`| ${i} | ${fmt(row.time)} | ${fmt(keyedYaw(row.source))} | ${fmt(row.posed)} | ${fmt(result.engaged[i]!.posed)} |`));
  motion.push('',`### ${screen} · pointer leave and return`,'','| Frame | Time (s) | Clip | Page | Phase |','| ---: | ---: | ---: | ---: | --- |');
  result.release.forEach((row,i)=>motion.push(`| ${i} | ${fmt(row.time)} | ${fmt(keyedYaw(row.source))} | ${fmt(row.posed)} | ${row.releasing?'Release':'Untouched'} |`));
  motion.push(`| ${result.release.length} | ${fmt(result.returned.time)} | ${fmt(keyedYaw(result.returned.source))} | ${fmt(result.returned.posed)} | Re-entered |`,'');
  console.log('TURN_PAD_KEYED_PASS',JSON.stringify({screen,frames:count,releaseFrames:result.release.length}));
 }
 await writeFile(join(out,'motion.md'),motion.join('\n'));
 assert.deepEqual(errors,[]);
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),errors,observations,body:await page?.evaluate('document.body.innerText')},null,2));if(page)await writeFile(join(out,'failure.png'),await page.screenshot());throw error;
}finally{await page?.close();for(const server of servers)server.stop();assert.ok(root.startsWith(join(tmpdir(),'direction-playback-930-')));await rm(root,{recursive:true,force:true});}
