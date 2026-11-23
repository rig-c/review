import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fixture from './fixtures/turn-pad-compose.json';
import {loadReview} from '../src/manifest.ts';
import {freshSession,parseSession} from '../src/session.ts';
import {discoverTurnDials} from '../src/turn-pad.ts';

const turn={schema:'rig-review-turn/1',values:{body:12},held:true,smoothing:20};
const feedback={id:'turn',frameStart:0,frameEnd:0,target:{kind:'rig',name:'turn-compose'},category:'quality',summary:'At this angle',context:{turn}};

async function withReview(model:typeof fixture.single,check:(p:Awaited<ReturnType<typeof loadReview>>)=>void){
 const root=await mkdtemp(join(tmpdir(),'review-turn-compose-'));
 try{
  const manifest=join(root,'review.json');
  await writeFile(manifest,JSON.stringify({schema:'rig-review/1',id:'turn-compose',title:'Composed turn',revision:'1',model:'skeleton.model.json'}));
  await writeFile(join(root,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],slots:[],...model}));
  check(await loadReview(manifest,{handoff:false}));
 }finally{await rm(root,{recursive:true,force:true});}
}

test('one composed actor exposes its generated body dial and accepts turn feedback',async()=>{
 await withReview(fixture.single,p=>{
  expect((p.feedbackCatalog.turnDials??[]).map(d=>d.axis)).toEqual(['yaw','pitch','body']);
  expect(p.feedbackCatalog.turnDials?.filter(d=>d.axis==='body')).toEqual([{
   axis:'body',bone:'actor:body_yaw_dial',slider:'actor:body_yaw_dial',channel:'rotation',min:-12,max:12,
   provenance:'model slider actor:body_yaw_dial → bone actor:body_yaw_dial, rotate, animation actor:body_turn',
  }]);
  const values=Object.fromEntries(p.feedbackCatalog.turnDials!.map(d=>[d.axis,d.axis==='body'?12:0]));
  const angle={...turn,values};
  const parsed=parseSession({...freshSession(p),feedback:[{...feedback,context:{turn:angle}}]},p);
  expect(parsed.feedback[0]?.context).toMatchObject({turn:angle});
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

test('uncomposed dials retain their serialized ranges and provenance',()=>{
 expect(JSON.stringify(discoverTurnDials(fixture.uncomposed))).toBe(JSON.stringify([
  {axis:'yaw',bone:'yaw_dial',slider:'yaw',channel:'rotation',min:-12,max:12,provenance:'model slider yaw → bone yaw_dial, rotate, animation turn'},
  {axis:'pitch',bone:'pitch_dial',slider:'pitch',channel:'rotation',min:-12,max:12,provenance:'model slider pitch → bone pitch_dial, rotate, animation tilt'},
  {axis:'body',bone:'body_yaw_dial',slider:'body_yaw_dial',channel:'rotation',min:-12,max:12,provenance:'model slider body_yaw_dial → bone body_yaw_dial, rotate, animation body_turn'},
 ]));
});

test('a custom body bone is discovered by its namespaced body_turn animation',()=>{
 const source=fixture.single.constraints.find(c=>c.bone==='actor:body_yaw_dial')!;
 const control={...source,bone:'actor:custom_body'};
 const model={bones:[{name:control.bone}],constraints:[control],animations:fixture.single.animations};
 expect(discoverTurnDials(model)).toEqual([{
  axis:'body',bone:'actor:custom_body',slider:source.name,channel:'rotation',min:-12,max:12,
  provenance:`model slider ${source.name} → bone actor:custom_body, rotate, animation actor:body_turn (compiled body_turn binding)`,
 }]);
});

test('only the first namespace separator is stripped from a bone or animation name',()=>{
 const source=fixture.single.constraints.find(c=>c.bone==='actor:body_yaw_dial')!;
 for(const prefix of ['a:b:',':']){
  const bone=prefix+'body_yaw_dial',animation=prefix+'body_turn';
  expect(discoverTurnDials({
   bones:[{name:bone}],constraints:[{...source,bone,animation}],
   animations:[{name:animation,duration:fixture.single.animations.find(a=>a.name===source.animation)!.duration}],
  })).toEqual([]);
 }
});
