import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {RigPlayer} from '@rig-c/play';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {advancePlayback,cueDue,PLAYBACK_STEP} from '../web/playback-clock.ts';

// #346: physics carries across the loop wrap, and steps at a fixed rate whatever the display refreshes at.
const fixture=new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url);
const physics={kind:'physics',name:'probe_physics',declaredIn:'rig',bone:'probe',x:1,y:1,rotate:1,strength:100,damping:0.85,inertia:0.5,mass:1,wind:2,gravity:3,mix:1};
async function model(){const doc=JSON.parse(await readFile(fixture,'utf8'));doc.constraints=[physics];return doc;}
const tip=(p:RigPlayer)=>{const b=p.bone('probe');return {x:b.x,y:b.y};};
const dist=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
function bytes(p:RigPlayer){const b=p.bone('probe');return Buffer.from(new Float64Array([b.x,b.y,b.a,b.b,b.c,b.d,b.rotationX,b.rotationY,b.scaleX,b.scaleY]).buffer).toString('hex');}

test('fixed steps: whole steps only, carry kept, a repeating clip wraps, a held clip lands on its end',()=>{
 expect(PLAYBACK_STEP).toBe(1/60);
 const half=advancePlayback({time:0,duration:2,carry:0,elapsed:1/120,repeat:true});
 expect(half.steps).toEqual([]);expect(half.time).toBe(0);expect(half.carry).toBeCloseTo(1/120,12);
 const whole=advancePlayback({time:0,duration:2,carry:half.carry,elapsed:1/120,repeat:true});
 expect(whole.steps).toEqual([1/60]);expect(whole.time).toBe(1/60);
 const wrap=advancePlayback({time:2-1/120,duration:2,carry:0,elapsed:1/60,repeat:true});
 expect(wrap.wrapped).toBe(true);expect(wrap.ended).toBe(false);expect(wrap.time).toBeCloseTo(1/120,12);
 const end=advancePlayback({time:2-1/120,duration:2,carry:0,elapsed:1/60,repeat:false});
 expect(end.ended).toBe(true);expect(end.time).toBe(2);expect(end.steps.length).toBe(1);expect(end.steps[0]).toBeCloseTo(1/120,12);
 expect(advancePlayback({time:0,duration:0,carry:0,elapsed:1,repeat:true}).steps).toEqual([]);
});

test('the integrated physics does not depend on the refresh rate',async()=>{
 const doc=await model(),loaded=await loadSetupAssets(doc),seen:string[]=[];
 try{
  for(const elapsed of [[1/60],[1/120],[1/144],[1/30],[0.004,0.011,0.023,0.007,0.016]]){
   const p=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});p.play('inspect',{loop:true});
   let time=0,carry=0,count=0,at90='';
   for(let frame=0;count<90;frame++){
    const next=advancePlayback({time,duration:2,carry,elapsed:elapsed[frame%elapsed.length]!,repeat:true});time=next.time;carry=next.carry;
    for(const step of next.steps){p.advance(step);if(++count===90)at90=bytes(p);}
   }
   seen.push(at90);p.dispose();
  }
  expect(new Set(seen).size).toBe(1);
 }finally{loaded.dispose();}
});

test('a physics chain is continuous across two loop wraps; the replaced seek-at-wrap was not',async()=>{
 const doc=await model(),loaded=await loadSetupAssets(doc);
 try{
  const run=(arm:'carry'|'seek')=>{
   const p=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas'});p.play('inspect',{loop:arm==='carry'});
   let time=0,carry=0,prev=tip(p),inside=0;const wraps:number[]=[];
   while(wraps.length<2){
    if(arm==='carry'){
     const next=advancePlayback({time,duration:2,carry,elapsed:1/60,repeat:true});time=next.time;carry=next.carry;
     for(const step of next.steps)p.advance(step);
     const now=tip(p),jump=dist(now,prev);if(next.wrapped)wraps.push(jump);else inside=Math.max(inside,jump);prev=now;
    }else{
     // The code #346 replaced: a held track stepped to the end, then seek(0) at the wrap.
     time=Math.min(2,time+1/60);p.advance(1/60);let wrapped=false;if(time>=2){p.seek(0);time=0;wrapped=true;}
     const now=tip(p),jump=dist(now,prev);if(wrapped)wraps.push(jump);else inside=Math.max(inside,jump);prev=now;
    }
   }
   p.dispose();return {inside,wraps};
  };
  const carry=run('carry'),seek=run('seek');
  expect(carry.inside).toBeGreaterThan(0);
  for(const jump of carry.wraps)expect(jump).toBeLessThanOrEqual(carry.inside);
  expect(Math.max(...seek.wraps)).toBeGreaterThan(seek.inside);
 }finally{loaded.dispose();}
});

test('a wrapping frame sounds the cues before the clip end and after the wrap',()=>{
 // 1.95 s + 0.1 s of a 2 s clip: the frame plays (1.95, 2] and then [0, 0.05].
 const next=advancePlayback({time:1.95,duration:2,carry:0,elapsed:0.1,repeat:true});
 expect(next.wrapped).toBe(true);expect(next.time).toBeCloseTo(1/60*6-0.05,9);
 expect(cueDue(1.98,1.95,next,2)).toBe(true);
 expect(cueDue(2,1.95,next,2)).toBe(true);
 expect(cueDue(0,1.95,next,2)).toBe(true);
 expect(cueDue(next.time,1.95,next,2)).toBe(true);
 expect(cueDue(1.9,1.95,next,2)).toBe(false);
 expect(cueDue(next.time+0.01,1.95,next,2)).toBe(false);
 const plain=advancePlayback({time:0.5,duration:2,carry:0,elapsed:1/60,repeat:true});
 expect(cueDue(0.51,0.5,plain,2)).toBe(true);expect(cueDue(0.5,0.5,plain,2)).toBe(false);
});

test('the loop wrap re-holds the video reference as the replaced seek(0) did',async()=>{
 const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const wrap=main.slice(main.indexOf('if (next.wrapped) {'),main.indexOf('if (player && player.current && next.steps.length)'));
 expect(wrap).toContain("clipMoved({ kind: 'replay' })");
 expect(wrap).toContain('holdVideoReference(video, referenceGeneration)');
 expect(wrap.indexOf('holdVideoReference')).toBeLessThan(wrap.indexOf('video.play()'));
});


test('held physics steps at 60 Hz across refresh rates and at the clip end without advancing time',()=>{
 for(const hz of [30,60,120,144]){
  let carry=0,count=0;
  for(let frame=0;frame<hz;frame++){
   const next=advancePlayback({time:2,duration:2,carry,elapsed:1/hz,repeat:false,held:true});
   expect(next.time).toBe(2);expect(next.ended).toBe(false);expect(next.wrapped).toBe(false);
   expect(next.steps.every(step=>step===PLAYBACK_STEP)).toBe(true);carry=next.carry;count+=next.steps.length;
  }
  expect(count).toBe(60);
 }
});
