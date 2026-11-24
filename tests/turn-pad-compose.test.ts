import {expect,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fixture from './fixtures/turn-pad-compose.json';
import {loadReview} from '../src/manifest.ts';
import {freshSession,parseSession,readSession,saveSession} from '../src/session.ts';
import {discoverTurnDials} from '../src/turn-pad.ts';

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
