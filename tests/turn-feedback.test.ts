import {expect,test} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {turnPackage,turnModel} from './helpers/turn-pad.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {RigPlayer} from '@rig-c/play';
import {TurnState,discoverTurnDials,sharedTurnDials} from '../src/turn-pad.ts';
import {loadReview} from '../src/manifest.ts';
import {freshSession,parseSession,saveSession,readSession} from '../src/session.ts';
import {loadCompare} from '../src/compare.ts';
import {freshCompareSession,parseCompareSession} from '../src/compare-session.ts';
import {parseBookmark} from '../web/inspection-persistence.ts';
const note=(turn:unknown)=>({id:'angle',frameStart:0,frameEnd:0,target:{kind:'rig',name:'turn-control'},category:'quality',summary:'At this angle',context:{animation:'inspect',turn}});
const snapshot=(yaw=7.125)=>({schema:'rig-review-turn/1' as const,values:{yaw,pitch:-3.5,body:2},held:true,smoothing:20});
test('the published Play adjust drives actual declared sliders and posed output, without mutating compiled input',async()=>{
 const model=await turnModel({body:'custom_body'}),before=JSON.stringify(model),{assets,dispose}=await loadSetupAssets(model),player=new RigPlayer(setupRoot(),assets,{mode:'canvas'});
 try{player.play('inspect');player.pause();const state=new TurnState(discoverTurnDials(model,assets.animations));state.restore(snapshot());player.adjust=state.adjust();
  expect(player.bone('rigid').x).toBeCloseTo(-18+.6*7.125,4);expect(player.bone('rigid').y).toBeCloseTo(.8*-3.5,4);expect(player.bone('mesh').rotationX).toBeCloseTo(5,4);
  const posed=player.posedFrame();expect(posed.order.length).toBe(2);expect(player.bone('yaw_dial').rotationX).toBeCloseTo(7.125,4);expect(JSON.stringify(model)).toBe(before);
 }finally{player.dispose();dispose();}
});
test('turn feedback is a strict separately validated finite bounded field, persists and retains immutable source identity',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'review-turn-'));try{const path=await turnPackage(join(temp,'input')),p=await loadReview(path),bytes=await readFile(join(path,'skeleton.model.json')),base=freshSession(p),state=join(temp,'state');
  const saved=await saveSession(p,{...base,feedback:[note(snapshot())]},state);expect((await readSession(p,state)).feedback).toEqual(saved.feedback);expect(saved.reviewedSource).toEqual(p.reviewedSource);expect(await readFile(join(path,'skeleton.model.json'))).toEqual(bytes);
  for(const turn of [{...snapshot(),extra:true},{...snapshot(),smoothing:101},{...snapshot(),held:0},{...snapshot(),values:{yaw:NaN,pitch:0,body:0}},{...snapshot(),values:{yaw:Infinity,pitch:0,body:0}},snapshot(41),{...snapshot(),values:{yaw:0,pitch:0}},{...snapshot(),values:{...snapshot().values,constructor:1}}])expect(()=>parseSession({...base,feedback:[note(turn)]},p)).toThrow('TURN_');
  const noDial=await loadReview(await turnPackage(join(temp,'none'),{noDials:true}));expect(()=>parseSession({...freshSession(noDial),feedback:[note(snapshot())]},noDial)).toThrow('TURN_UNAVAILABLE');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.reviewedSource.rig!.sha256);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('compare turn field must fit both inspected models; custom names and differing ranges share values, never normalized angles',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'review-turn-'));try{const a=await turnPackage(join(temp,'a')),b=await turnPackage(join(temp,'b'),{yaw:[-5,10],body:'custom_body'}),reference=join(temp,'reference.mov');await writeFile(reference,'transport test');const p=await loadCompare({a,b,reference,animation:'inspect'}),base=freshCompareSession(p),common=sharedTurnDials(p.a.feedbackCatalog.turnDials!,p.b.feedbackCatalog.turnDials!);
 expect(common.find(d=>d.axis==='yaw')).toMatchObject({min:-5,max:10});const valid={...note(snapshot(9)),side:'a'};expect(parseCompareSession({...base,feedback:[valid]},p).feedback[0]!.context).toMatchObject({turn:snapshot(9)});
 for(const side of ['a','b'])expect(()=>parseCompareSession({...base,feedback:[{...note(snapshot(11)),side}]},p)).toThrow('TURN_STATE_MODEL_MISMATCH');
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('a scratch stage cannot submit newly supported values outside the original inspected catalog; view restore stays source bound',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'review-turn-'));try{
  const input=await turnPackage(join(temp,'input')),p=await loadReview(input),base=freshSession(p),scratch=new TurnState(discoverTurnDials(await turnModel({yaw:[-50,60]})));
  scratch.restore(snapshot(50));expect(()=>parseSession({...base,feedback:[note(scratch.snapshot())]},p)).toThrow('TURN_STATE_MODEL_MISMATCH');
  const binding={mode:'single' as const,sourceHash:p.sourceHash,rigs:[p.reviewedSource.rig!.sha256]},view={schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:null}},bookmark={schema:'rig-review-inspection/1',binding,animation:'inspect',time:0,theme:'dark',layers:{images:true,meshes:false,bones:false},view,selection:{turn:snapshot()}};
  expect(parseBookmark(bookmark,binding).selection.turn).toEqual(snapshot());expect(()=>parseBookmark(bookmark,{...binding,sourceHash:'f'.repeat(64)})).toThrow('VIEW_SOURCE_CHANGED');
  expect(()=>parseBookmark({...bookmark,selection:{turn:{...snapshot(),values:{yaw:Infinity}}}},binding)).toThrow('TURN_');
 }finally{await rm(temp,{recursive:true,force:true});}
});
