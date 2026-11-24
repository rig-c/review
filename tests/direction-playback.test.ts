import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {RigPlayer,type ModelAssets} from '@rig-c/play';
import {advancePlayback,cueDue} from '../web/playback-clock.ts';
import * as scene from '../web/scene-plates.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {directionPhysicsModel,loopingDirection} from './helpers/direction-playback.ts';
import type {DirectionInspection} from '../src/direction-inspection.ts';

// Execute the actual workspace's transport functions, including the direction branch.
const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
const previous=await readFile(new URL('../web/previous-build-view.ts',import.meta.url),'utf8');
const transpiler=new Bun.Transpiler({loader:'ts'});
const priorCode=transpiler.transformSync(previous.slice(previous.indexOf('function present('),previous.indexOf('function show(')));
function priorPresentation(assets:ModelAssets|null,clipMap:Record<string,string>,player:RigPlayer|null=null){
 const scope={assets,player,root:setupRoot(),build:{clipMap},missing:{hidden:true},drawnGeneration:undefined,
  RigPlayer:class extends RigPlayer{constructor(root:HTMLElement,assets:ModelAssets){super(root,assets,{mode:'canvas'});}}};
 return new Function('scope',`with(scope){${priorCode};return {active:()=>true,present,step,player:()=>player};}`)(scope) as {
  active():boolean;present(current:RigPlayer,seek?:boolean):void;
  step(advance:(rig:RigPlayer)=>void,held:boolean,timeScale:number):void;player():RigPlayer|null;
 };
}
function transport(player:RigPlayer,direction:DirectionInspection,peer?:RigPlayer){
 const tick=main.slice(main.indexOf('function drawRigSteps('),main.indexOf('\nfunction configureTurnPad('));
 const seek=main.slice(main.indexOf('function seek(value:'),main.indexOf('\nfunction stopAudio('));
 const noop=()=>{};
 const previousBuildView=peer?priorPresentation(null,{},peer):null;
 const scope={...scene,advancePlayback,cueDue,player,time:0,duration:direction.take.duration,playbackCarry:0,lastFrame:1000,idleHeld:false,video:null,rigDifference:null,
  previousBuildView,activeScene:()=>direction,canRepeatIdle:()=>direction.take.loop,stopAudio:noop,clipMoved:noop,stepEnvironment:noop,
  drawRig(action:()=>void,paired?:'seek'|((view:NonNullable<typeof previousBuildView>)=>void)){
   action();if(peer&&paired==='seek'){peer.seek(player.time);peer.draw();}
   else if(previousBuildView&&typeof paired==='function')paired(previousBuildView);
  },
  heldPhysicsFailed:false,document:{hidden:false},selectedInspector:()=>'playback',seekingControl:false,
  input:()=>({checked:false}),renderSequenceFrame:noop,renderTransport:noop,pause:noop,message:(value:string)=>{throw Error(value);},errorText:String};
 const run=new Function('scope',`with(scope){${transpiler.transformSync(tick+'\n'+seek)};return {tick:tickPlaying,heldTick:tickHeldPhysics,seek};}`)(scope) as {
  tick(now:number):void;heldTick(now:number):void;seek(seconds:number):void;
 };
 return {...run,state:scope};
}
const vertices=(player:RigPlayer)=>{const mesh=player.posedFrame().order[0]!;if(mesh.kind!=='mesh')throw Error('Expected fixture mesh');return [...mesh.vertices];};
const jumps=(a:number[],b:number[])=>a.filter((_,i)=>i%2===0).map((_,v)=>Math.hypot(a[v*2]!-b[v*2]!,a[v*2+1]!-b[v*2+1]!));

function countPlayer(player:RigPlayer) {
 const counts={advances:[] as number[],seeks:[] as number[],draws:0};
 const {advance,seek,draw}=player;
 player.advance=seconds=>{counts.advances.push(seconds);advance.call(player,seconds);};
 player.seek=(seconds,schedule)=>{counts.seeks.push(seconds);seek.call(player,seconds,schedule);};
 player.draw=()=>{counts.draws++;draw.call(player);};
 return counts;
}

test('#1218 the retained setup draws geometry and a mapped clip settles during pause without seeking',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 const current=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});
 const prior=priorPresentation(loaded.assets,{inspect:'inspect'});
 try{
  prior.present(current,true);
  expect(prior.player()!.current).toBeNull();expect(vertices(prior.player()!)).toHaveLength(8);
  current.play('inspect',{loop:true});prior.present(current,true);
  const peer=prior.player()!;expect(peer.current).toBe('inspect');
  const rig=transport(current,loopingDirection(),peer);rig.seek(.25);
  const before=vertices(peer),a=countPlayer(current),b=countPlayer(peer),time=current.time;
  for(const dt of [0,1000/60,50,150])rig.heldTick(1000+dt);
  expect(current.time).toBe(time);expect(peer.time).toBe(time);
  expect(a).toEqual(b);expect(a.advances).toHaveLength(9);expect(a.draws).toBe(3);expect(a.seeks).toEqual([]);
  expect(vertices(peer)).not.toEqual(before);expect(vertices(peer)).toEqual(vertices(current));
  current.hold(false);rig.tick(1000+150+1000/60);
  expect(current.time).toBeGreaterThan(time);expect(peer.time).toBe(current.time);
  expect(a.seeks).toEqual([]);expect(a).toEqual(b);expect(vertices(peer)).toEqual(vertices(current));
 }finally{current.dispose();prior.player()?.dispose();loaded.dispose();}
});

test('#930 direction playback preserves physics at both loop seams per mesh vertex',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});
  try{
   const rig=transport(player,loopingDirection());rig.seek(0);
   let previous=vertices(player),inside=0;const wraps:number[][]=[];
   for(let frame=1;wraps.length<2&&frame<=1000;frame++){
    const before=rig.state.time;rig.tick(1000+frame*1000/60);
    const now=vertices(player),delta=jumps(now,previous);
    if(rig.state.time<before)wraps.push(delta);else inside=Math.max(inside,...delta);
    previous=now;
   }
   console.log('DIRECTION_LOOP_VERTICES',JSON.stringify({inside,wraps}));
   expect(wraps.length).toBe(2);expect(inside).toBeGreaterThan(0);
   // A seam must fit the largest ordinary single-frame vertex move in this same trajectory.
   // This scale-relative envelope includes authored acceleration without accepting a reset jump.
   for(const seam of wraps)for(const jump of seam)expect(jump).toBeLessThanOrEqual(inside+1e-9);
  }finally{player.dispose();}
 }finally{loaded.dispose();}
});

test('#930 scrub and seek-to-time reproduce the exact mapped public player pose after playback',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'}),oracle=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});
  try{
   const direction=loopingDirection([{time:0,source_time:.25,easing:'smoothstep'},{time:8,source_time:2.25,easing:'linear'}]);
   player.play('inspect',{loop:true});oracle.play('inspect',{loop:true});const rig=transport(player,direction);
   rig.seek(0);oracle.seek(.25);expect(vertices(player)).toEqual(vertices(oracle));
   for(let frame=1;frame<=90;frame++)rig.tick(1000+frame*1000/60);
   for(const at of [.123456789012345,7.75,0,4,8]){
    rig.seek(at);oracle.seek(scene.takeSample(direction,at).sourceTime);
    expect(player.time).toBe(oracle.time);expect(vertices(player)).toEqual(vertices(oracle));expect(rig.state.time).toBe(at);
   }
  }finally{player.dispose();oracle.dispose();}
 }finally{loaded.dispose();}
});

test('#930 nonlinear timing lands on mapped source seconds across speed changes, holds and wraps',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const maps=[
   [{time:0,source_time:.25,easing:'smoothstep'},{time:8,source_time:2.25,easing:'linear'}],
   [{time:0,source_time:0,easing:'linear'},{time:1.17,source_time:.7,easing:'smoothstep'},{time:4.03,source_time:1.5,easing:'linear'},{time:8,source_time:2,easing:'hold'}],
   [{time:0,source_time:0,easing:'linear'},{time:1.17,source_time:.4,easing:'hold'},{time:3.03,source_time:.4,easing:'smoothstep'},{time:8,source_time:2,easing:'linear'}],
  ];
  for(const timing of maps)for(const hz of [30,60,144]){
   const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});
   try{
    const direction=loopingDirection(timing),rig=transport(player,direction);rig.seek(0);let worst=0;
    for(let frame=1;frame<=hz*17;frame++){
     rig.tick(1000+frame*1000/hz);
     const expected=scene.takeSample(direction,rig.state.time).sourceTime%2,actual=player.entry(0)!.animationTime;
     const error=Math.abs(actual-expected);worst=Math.max(worst,Math.min(error,Math.abs(error-2)));
    }
    console.log('DIRECTION_SOURCE_LANDING',JSON.stringify({hz,timing,worst,tolerance:1e-9}));
    // Double-precision accumulation, well below a 60 Hz sample (1.67e-2 s).
    expect(worst).toBeLessThan(1e-9);expect(player.held).toBe(false);
   }finally{player.dispose();}
  }
 }finally{loaded.dispose();}
});

test('#930 continuous mapping advances; holds keep physics alive; authored jumps seek once',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});
  const peer=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});peer.play('inspect',{loop:true});
  try{
   const direction=loopingDirection([{time:0,source_time:0,easing:'hold'},{time:1.175,source_time:.5,easing:'linear'},{time:8,source_time:2,easing:'linear'}]);
   const rig=transport(player,direction,peer);rig.seek(0);
   const currentCalls=countPlayer(player),previousCalls=countPlayer(peer);
   const first=vertices(player);
   rig.tick(1000);
   expect(currentCalls.draws).toBe(0);expect(previousCalls.draws).toBe(0);
   for(let frame=1;frame<=60;frame++)rig.tick(1000+frame*1000/60);
   expect(player.time).toBe(0);expect(peer.time).toBe(0);
   expect(vertices(player)).not.toEqual(first);expect(vertices(peer)).toEqual(vertices(player));
   expect(currentCalls).toEqual(previousCalls);expect(currentCalls.seeks).toEqual([]);
   expect(currentCalls.draws).toBe(60);expect(currentCalls.advances).toHaveLength(60);
   for(let frame=61;frame<=90;frame++)rig.tick(1000+frame*1000/60);
   expect(currentCalls).toEqual(previousCalls);expect(currentCalls.seeks).toEqual([.5]);
   expect(player.time).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);expect(peer.time).toBe(player.time);
  }finally{player.dispose();peer.dispose();}
 }finally{loaded.dispose();}
});

test('#930 partial source loop is a true discontinuity, even when both endpoints are near the clip seam',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  for(const start of [0,1e-5]){
   const direction=loopingDirection([{time:0,source_time:start,easing:'linear'},{time:8,source_time:1.99999,easing:'linear'}]);
   const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});
   const peer=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});peer.play('inspect',{loop:true});
   try{
    const rig=transport(player,direction,peer);rig.seek(0);const currentCalls=countPlayer(player),previousCalls=countPlayer(peer);
    for(let frame=1;frame<=486;frame++)rig.tick(1000+frame*1000/60);
    expect(currentCalls.seeks).toEqual([start]);expect(previousCalls).toEqual(currentCalls);
    expect(player.time).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);expect(peer.time).toBe(player.time);
   }finally{player.dispose();peer.dispose();}
  }
 }finally{loaded.dispose();}
});

test('#930 nonrepeating direction lands on the mapped endpoint without a loop restart',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:false});
  try{
   const direction=loopingDirection();direction.take.loop=false;const rig=transport(player,direction);rig.seek(0);
   for(let frame=1;frame<=485;frame++)rig.tick(1000+frame*1000/60);
   expect(rig.state.time).toBe(8);expect(player.time).toBeCloseTo(2,12);expect(player.entry(0)!.animationTime).toBeCloseTo(2,12);
  }finally{player.dispose();}
 }finally{loaded.dispose();}
});

test('#930 selected track entry supplies its own duration across multiple animations',async()=>{
 const doc=await directionPhysicsModel(),other=structuredClone(doc.animations[0]);other.name='other';other.duration=3;
 for(const bone of other.bones)for(const timeline of bone.timelines)for(const key of timeline.keys)key.time*=1.5;
 doc.animations.push(other);doc.editorOrder.animations.push('other');
 const loaded=await loadSetupAssets(doc);
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});
  const peer=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});
  const currentCalls=countPlayer(player),previousCalls=countPlayer(peer);
  try{
   for(const [name,duration] of [['other',3],['inspect',2]] as const){
    player.play(name,{loop:true});expect(player.entry(0)!.animation).toBe(name);expect(player.entry(0)!.duration).toBe(duration);
    const peerDuration=duration===3?2:3;peer.play(name==='other'?'inspect':'other',{loop:true});
    const direction=loopingDirection([{time:0,source_time:0,easing:'linear'},{time:8,source_time:duration,easing:'linear'}]),rig=transport(player,direction,peer);rig.seek(0);
    const priorDraws=currentCalls.draws,seekCount=currentCalls.seeks.length;
    for(let frame=1;frame<=243;frame++)rig.tick(1000+frame*1000/30);
    expect(currentCalls).toEqual(previousCalls);expect(currentCalls.seeks).toHaveLength(seekCount);
    expect(currentCalls.draws-priorDraws).toBe(243);
    expect(player.entry(0)!.animationTime).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);
    expect(peer.time).toBe(player.time);expect(peer.time).toBeGreaterThan(duration);
    expect(peer.entry(0)!.animationTime).toBeCloseTo(player.time%peerDuration,12);
   }
  }finally{player.dispose();peer.dispose();}
 }finally{loaded.dispose();}
});

test('#930 authored source deltas land independently of public timeScale and restore it, including holds',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  for(const scale of [0,.5,1,2]){
   const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});player.timeScale=scale;
   try{
    const direction=loopingDirection([{time:0,source_time:0,easing:'linear'},{time:1.17,source_time:.4,easing:'hold'},{time:3.03,source_time:.4,easing:'smoothstep'},{time:8,source_time:2,easing:'linear'}]),rig=transport(player,direction);rig.seek(0);
    let worst=0;
    for(let frame=1;frame<=1020;frame++){
     rig.tick(1000+frame*1000/60);expect(player.timeScale).toBe(scale);
     const expected=scene.takeSample(direction,rig.state.time).sourceTime%2,error=Math.abs(player.entry(0)!.animationTime-expected);
     worst=Math.max(worst,Math.min(error,Math.abs(error-2)));
    }
    console.log('DIRECTION_TIME_SCALE',JSON.stringify({scale,worst,tolerance:1e-9}));expect(worst).toBeLessThan(1e-9);
   }finally{player.dispose();}
  }
 }finally{loaded.dispose();}
});

test('#930 restores public timeScale when a mapped advance throws',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});player.timeScale=2;
  try{
   player.advance=()=>{throw Error('planted advance failure');};
   expect(()=>scene.advanceTake(player,loopingDirection(),0,[1/60])).toThrow('planted advance failure');expect(player.timeScale).toBe(2);
  }finally{player.dispose();}
 }finally{loaded.dispose();}
});
