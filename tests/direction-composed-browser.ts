/** #933 direction@3 in the real shared workspace, ordinary Nova; synthetic public mesh, no plates. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
import {directionPhysicsModel} from './helpers/direction-playback.ts';
type LoopReport={inside:number;wraps:number[][];frames:number;seeks:number};
type Panel={title:string;rows:string[];keysHidden:boolean;scene:boolean;animation:string;repeat:boolean;idleGate:string;idleEditable:string};
const arg=Bun.argv.indexOf('--out'),out=resolve(arg<0?'artifacts/direction-composed-933':Bun.argv[arg+1]!);
await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'direction-composed-933-'));
let page:InputCdpSession|undefined;const servers:{stop():void}[]=[],errors:unknown[]=[],observations:unknown[]=[];
// Read after the real tick and draw. This wrapper records only; it never steps or replaces physics.
const probe=`
let record933=null;
const vertices933=()=>{const mesh=player.posedFrame().order.find(p=>p.kind==='mesh');if(!mesh)throw Error('DIRECTION_MESH_REQUIRED');return [...mesh.vertices];};
const originalTick933=tickPlaying;
tickPlaying=now=>{const before=time,previous=player?.current?vertices933():null;originalTick933(now);if(!record933||!previous||time===before)return;
 const next=vertices933(),jump=next.filter((_,i)=>i%2===0).map((_,v)=>Math.hypot(next[v*2]-previous[v*2],next[v*2+1]-previous[v*2+1]));
 if(time<before)record933.wraps.push(jump);else record933.inside=Math.max(record933.inside,...jump);record933.frames++;
};
Object.assign(window,{__direction933:{playing:()=>playing,ready:()=>!!player?.current&&!!data?.direction,record:()=>{record933={inside:0,wraps:[],frames:0,seeks:0};const seek=player.seek.bind(player);player.seek=value=>{record933.seeks++;seek(value);};},report:()=>record933,
 panel:()=>{const host=document.querySelector('#direction-panel'),gate=document.querySelector('[data-animation-gate]');return {title:host.querySelector('summary').textContent,rows:[...host.querySelectorAll('li')].map(row=>row.textContent),
  keysHidden:document.querySelector('#direction-authored-keys').hidden,scene:!!activeScene(),animation:player.current,repeat:canRepeatIdle(),idleGate:gate.textContent,idleEditable:gate.dataset.editable};}}});
`;
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'direction-observer',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));}}]});
assert.ok(built.success,JSON.stringify(built.logs));
async function wait(expression:string,ms=25000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await page!.evaluate<any>(expression);if(value)return value;await Bun.sleep(50);}throw Error('DIRECTION_WAIT '+expression+' '+await page!.evaluate('document.body.innerText'));}
const expected={
 en:{title:'Direction · 2 s · loop',idleReason:'Read-only clip · ANIMATION_IDLE_NOT_KEY_EDITABLE: The producer generates "idle". Keyed editing requires a clip from motion.animations_from.',hidden:['Plain rig view','CAMERA_PLAYBACK_UNAVAILABLE','CAMERA_APPLY_UNSUPPORTED','moving camera','fixed camera']},
 ko:{title:'연출 · 2초 · 반복',idleReason:'읽기 전용 클립 · ANIMATION_IDLE_NOT_KEY_EDITABLE: 제작 도구가 "idle" 클립을 생성해요. 키를 편집하려면 motion.animations_from에 선언된 클립이 필요해요.',hidden:['인물만 표시','CAMERA_PLAYBACK_UNAVAILABLE','CAMERA_APPLY_UNSUPPORTED','카메라 이동','카메라 고정']},
} as const;
try{
 const pkg=join(root,'package');await mkdir(pkg);
 const doc=await directionPhysicsModel();doc.animations[0].name='idle';doc.editorOrder.animations=['idle'];
 const modelBytes=JSON.stringify(doc),model={path:'skeleton.model.json',sha256:createHash('sha256').update(modelBytes).digest('hex')};
 await writeFile(join(pkg,model.path),modelBytes);
 await copyFile('tests/fixtures/strip-probe/build/mesh.png',join(pkg,'mesh.png'));
 // The contract's closed @3 shape: the model's idle is the take; no camera, timing or scene document.
 await writeFile(join(pkg,'direction.json'),JSON.stringify({schema:'rig-create/direction@3',rig:{version:1,acceptance:{signoff:{},verdict:{},review_package:{}}},
  compose:{out:'outputs/v1/compose'},model,take:{duration:doc.animations[0].duration,loop:true},citations:{camera:'quoted',timing:'quoted',composition:'quoted'}}));
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'direction-933',title:'Composed direction fixture',revision:'1',model:model.path,direction:'direction.json',animations:[{id:'idle',label:'Idle'}]}));
 const loaded=await loadReview(pkg);assert.equal(loaded.scene,undefined);assert.equal(loaded.direction?.composed,true);
 page=await launchCdpSession(join(root,'profile'),{sendDeadlineMs:30000,browserArgs:['--renderer-process-limit=2','--js-flags=--max-old-space-size=1536'],onEvent(event){if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1280,900);
 for(const language of ['en','ko'] as const){
  const context=await createReviewRequestContext(loaded,{port:0,bundle:built.outputs[0]!,viewOnly:true,stateDir:join(root,'state-'+language)});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,async fetch(req,srv){return (await context.handle(req,srv.port,srv))!;}});
  servers.push({stop(){context.stop();server.stop(true);}});
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${language}`);
  await wait('window.__direction933?.ready()');
  await page.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
  await wait(`!document.querySelector('#play').disabled`);
  // The idle preview may already be running on open; record from here either way, then pause and read synchronously.
  await page.evaluate(`window.__direction933.record();if(!window.__direction933.playing())document.querySelector('#play').click()`);
  await wait('window.__direction933.report().wraps.length>=2',25000);
  const report:LoopReport=await page.evaluate<LoopReport>(`(()=>{if(window.__direction933.playing())document.querySelector('#play').click();return window.__direction933.report();})()`);
  assert.ok(report.frames>100);assert.equal(report.wraps.length,2);assert.ok(report.inside>0);
  for(const seam of report.wraps)for(const jump of seam)assert.ok(jump<=report.inside+1e-9,JSON.stringify(report));
  assert.equal(report.seeks,0,JSON.stringify(report));
  await page.evaluate(`document.querySelector('#direction-panel').open=true`);
  const panel:Panel=await page.evaluate<Panel>('window.__direction933.panel()');
  assert.equal(panel.title,expected[language].title);assert.equal(panel.scene,false);assert.equal(panel.animation,'idle');assert.equal(panel.repeat,true);assert.equal(panel.keysHidden,true);
  assert.equal(panel.rows.length,6,JSON.stringify(panel.rows));
  assert.ok(panel.rows.some(row=>row.startsWith('TURN_UNAVAILABLE')));
  assert.equal(panel.idleEditable,'false');
  assert.equal(panel.idleGate,expected[language].idleReason);
  for(const text of expected[language].hidden)assert.ok(!panel.rows.join('\n').includes(text)&&!panel.title.includes(text),text);
  assert.ok(panel.rows.join('\n').includes(model.sha256));
  await writeFile(join(out,language+'.png'),await page.screenshot());observations.push({language,report,panel});
  await writeFile(join(out,'report.json'),JSON.stringify({observations,errors},null,2));console.log('DIRECTION_AT3_BROWSER_PASS',JSON.stringify({language,inside:report.inside,seam:Math.max(...report.wraps.flat()),frames:report.frames,seeks:report.seeks,panel}));
 }
 assert.deepEqual(errors,[]);
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),errors,observations,body:await page?.evaluate('document.body.innerText')},null,2));if(page)await writeFile(join(out,'failure.png'),await page.screenshot());throw error;
}finally{await page?.close();for(const server of servers)server.stop();assert.ok(root.startsWith(join(tmpdir(),'direction-composed-933-')));await rm(root,{recursive:true,force:true});}
