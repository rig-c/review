import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {RigPlayer} from '@rig-c/play';
import {advancePlayback,cueDue} from '../web/playback-clock.ts';
import * as scene from '../web/scene-plates.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {directionPhysicsModel,loopingDirection} from './helpers/direction-playback.ts';
import type {DirectionInspection} from '../src/direction-inspection.ts';

// Execute the actual workspace's transport functions, including the direction branch.
const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
const transpiler=new Bun.Transpiler({loader:'ts'});
function transport(player:RigPlayer,direction:DirectionInspection){
 const tick=main.slice(main.indexOf('function tickPlaying('),main.indexOf('\nfunction configureTurnPad('));
 const seek=main.slice(main.indexOf('function seek(value:'),main.indexOf('\nfunction stopAudio('));
 const noop=()=>{};
 const scope={...scene,advancePlayback,cueDue,player,time:0,duration:direction.take.duration,playbackCarry:0,lastFrame:1000,idleHeld:false,video:null,rigDifference:null,
  activeScene:()=>direction,canRepeatIdle:()=>direction.take.loop,stopAudio:noop,clipMoved:noop,stepEnvironment:noop,drawRig:(action:()=>void)=>action(),
  input:()=>({checked:false}),renderSequenceFrame:noop,renderTransport:noop,pause:noop,message:(value:string)=>{throw Error(value);},errorText:String};
 const run=new Function('scope',`with(scope){${transpiler.transformSync(tick+'\n'+seek)};return {tick:tickPlaying,seek};}`)(scope);
 return {...run,state:scope};
}
const vertices=(player:RigPlayer)=>{const mesh=player.posedFrame().order[0]!;if(mesh.kind!=='mesh')throw Error('Expected fixture mesh');return [...mesh.vertices];};
const jumps=(a:number[],b:number[])=>a.filter((_,i)=>i%2===0).map((_,v)=>Math.hypot(a[v*2]!-b[v*2]!,a[v*2+1]!-b[v*2+1]!));

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
  try{
   const direction=loopingDirection([{time:0,source_time:0,easing:'hold'},{time:1.175,source_time:.5,easing:'linear'},{time:8,source_time:2,easing:'linear'}]);
   const rig=transport(player,direction);rig.seek(0);
   const seeks:number[]=[],seek=player.seek.bind(player);player.seek=value=>{seeks.push(value);seek(value);};
   const first=vertices(player);
   for(let frame=1;frame<=60;frame++)rig.tick(1000+frame*1000/60);
   expect(player.time).toBe(0);expect(vertices(player)).not.toEqual(first);expect(seeks).toEqual([]);
   for(let frame=61;frame<=90;frame++)rig.tick(1000+frame*1000/60);
   expect(seeks).toEqual([.5]);expect(player.time).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);
  }finally{player.dispose();}
 }finally{loaded.dispose();}
});

test('#930 partial source loop is a true discontinuity, even when both endpoints are near the clip seam',async()=>{
 const loaded=await loadSetupAssets(await directionPhysicsModel());
 try{
  for(const start of [0,1e-5]){
   const direction=loopingDirection([{time:0,source_time:start,easing:'linear'},{time:8,source_time:1.99999,easing:'linear'}]);
   const player=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});player.play('inspect',{loop:true});
   try{
    const rig=transport(player,direction);rig.seek(0);const seeks:number[]=[],seek=player.seek.bind(player);player.seek=value=>{seeks.push(value);seek(value);};
    for(let frame=1;frame<=486;frame++)rig.tick(1000+frame*1000/60);
    expect(seeks).toEqual([start]);expect(player.time).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);
   }finally{player.dispose();}
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
  try{
   for(const [name,duration] of [['other',3],['inspect',2]] as const){
    player.play(name,{loop:true});expect(player.entry(0)!.animation).toBe(name);expect(player.entry(0)!.duration).toBe(duration);
    const direction=loopingDirection([{time:0,source_time:0,easing:'linear'},{time:8,source_time:duration,easing:'linear'}]),rig=transport(player,direction);rig.seek(0);
    const seeks:number[]=[],seek=player.seek.bind(player);player.seek=value=>{seeks.push(value);seek(value);};
    for(let frame=1;frame<=486;frame++)rig.tick(1000+frame*1000/60);
    expect(seeks).toEqual([]);expect(player.entry(0)!.animationTime).toBeCloseTo(scene.takeSample(direction,rig.state.time).sourceTime,12);
    player.seek=seek;
   }
  }finally{player.dispose();}
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
