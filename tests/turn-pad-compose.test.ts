import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fixture from './fixtures/turn-pad-compose.json';
import {loadReview} from '../src/manifest.ts';
import {freshSession,parseSession,readSession,saveSession} from '../src/session.ts';
import {discoverTurnDials,TurnState} from '../src/turn-pad.ts';
import {turnModel} from './helpers/turn-pad.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {RigPlayer} from '@rig-c/play';

test('#1283 untouched pad passes the clip yaw keys through at three times',async()=>{
 const model=await turnModel({keyedYaw:true}),{assets,dispose}=await loadSetupAssets(model);
 const player=new RigPlayer(setupRoot(),assets,{mode:'canvas'});
 try{
  const state=new TurnState(discoverTurnDials(model,assets.animations));
  player.play('inspect');player.pause();
  const times=[0,.25,.5];
  const yawAt=(time:number)=>{player.seek(time);player.repose();return player.bone('yaw_dial').rotationX;};
  const clip=times.map(yawAt);
  [8,-8,4].forEach((value,i)=>expect(clip[i]).toBeCloseTo(value,6));
  player.adjust=state.adjust();
  expect(times.map(yawAt)).toEqual(clip);
  state.smoothing=0;
  state.pointer(.5,0);state.step(0);
  expect(times.map(yawAt).map(Math.round)).toEqual([20,20,20]);
  expect(state.leave()).toBe(true);
  expect(times.map(yawAt)).toEqual(clip);

  state.restore({schema:'rig-review-turn/1',values:{yaw:12,pitch:0,body:0},held:false,smoothing:20});
  expect(yawAt(0)).toBeCloseTo(12,6);
  expect(state.leave()).toBe(true);
  state.step(.05);
  // The critically damped release follows the clip at the time of each pose.
  const weight=2/Math.E;
  expect(yawAt(.25)).toBeCloseTo(-8+(12+8)*weight,6);
  expect(yawAt(.5)).toBeCloseTo(4+(12-4)*weight,6);
  state.step(1);
  expect(times.map(yawAt)).toEqual(clip);
  state.pointer(.25,0);state.step(1);
  expect(yawAt(.25)).toBeCloseTo(10,6);
  state.hold(true);
  expect(state.leave()).toBe(false);
  expect(yawAt(.5)).toBeCloseTo(10,6);
  state.clear();
  expect(times.map(yawAt)).toEqual(clip);
 }finally{player.dispose();dispose();}
});

test('#1283 unkeyed clip poses retain the exact old zero-override bytes',async()=>{
 const model=await turnModel(),{assets,dispose}=await loadSetupAssets(model);
 const player=new RigPlayer(setupRoot(),assets,{mode:'canvas'});
 try{
  const untouched=new TurnState(discoverTurnDials(model,assets.animations));
  const legacy=new TurnState(untouched.dials);
  legacy.restore(untouched.snapshot());
  player.play('inspect');player.pause();
  const poses=(pad:TurnState)=>{
   player.adjust=pad.adjust();
   return JSON.stringify([0,.25,.5].map(time=>{
    player.seek(time);
    return [player.bone('yaw_dial'),player.posedFrame()];
   }));
  };
  expect(poses(untouched)).toBe(poses(legacy));
  expect(untouched.values).toEqual({yaw:0,pitch:0,body:0});
 }finally{player.dispose();dispose();}
});

const turn={schema:'rig-review-turn/1',values:{body:12},held:true,smoothing:20};
const feedback={id:'turn',frameStart:0,frameEnd:0,target:{kind:'rig',name:'turn-compose'},category:'quality',summary:'At this angle',context:{turn}};

async function withReview(model:typeof fixture.single,check:(p:Awaited<ReturnType<typeof loadReview>>)=>void|Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'review-turn-compose-'));
 try{
  const manifest=join(root,'review.json');
  await writeFile(manifest,JSON.stringify({schema:'rig-review/1',id:'turn-compose',title:'Composed turn',revision:'1',model:'skeleton.model.json'}));
  await writeFile(join(root,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],slots:[],...model}));
  await check(await loadReview(manifest,{handoff:false}));
 }finally{await rm(root,{recursive:true,force:true});}
}

test('one composed actor exposes its generated dials and saves turn feedback at both extremes',async()=>{
 await withReview(fixture.single,async p=>{
  const dials=p.feedbackCatalog.turnDials??[];
  expect(dials).toMatchObject([
   {axis:'yaw',bone:'actor:yaw_dial',slider:'actor:yaw',min:-12,max:12},
   {axis:'pitch',bone:'actor:pitch_dial',slider:'actor:pitch',min:-12,max:12},
   {axis:'body',bone:'actor:body_yaw_dial',slider:'actor:body_yaw_dial',min:-12,max:12},
  ]);
  expect(dials.filter(d=>d.axis==='body')).toEqual([{
   axis:'body',bone:'actor:body_yaw_dial',slider:'actor:body_yaw_dial',channel:'rotation',min:-12,max:12,
   provenance:'model slider actor:body_yaw_dial → bone actor:body_yaw_dial, rotate, animation actor:body_turn',
  }]);
  const extremes=[{yaw:-12,pitch:-12,body:-12},{yaw:12,pitch:12,body:12}].map((values,index)=>
   ({...feedback,id:`turn-${index}`,context:{turn:{...turn,values}}}));
  const state=join(p.root,'state');
  const saved=await saveSession(p,{...freshSession(p),feedback:extremes},state);
  expect(saved.feedback).toMatchObject(extremes);
  expect((await readSession(p,state)).feedback).toEqual(saved.feedback);
 });
});

test('two composed actors with turn sliders expose no dials and refuse turn feedback',async()=>{
 expect(discoverTurnDials(fixture.pair)).toEqual([]);
 await withReview(fixture.pair,p=>{
  expect(p.feedbackCatalog.turnDials).toBeUndefined();
  expect(()=>parseSession({...freshSession(p),feedback:[feedback]},p))
   .toThrow('TURN_UNAVAILABLE: this inspected model has no supported turn dials');
 });
});
