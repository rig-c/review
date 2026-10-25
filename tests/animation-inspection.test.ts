import {expect,test} from 'bun:test';
import {RigPlayer} from '@rig-c/play';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {boneHierarchy,channelSegments,evaluateBoneLocals,filterTracks,readAnimationInspection,CHANNELS,type LocalProperty} from '../src/animation-inspection.ts';
import {InspectionSelection} from '../web/inspection-selection.ts';
import {inspectionControl,properties,bytes,fixedTimes,matrixAnimations,recognizedCases} from './helpers/animation-inspection.ts';
import {pickedSlot} from '../web/animation-inspection.ts';

test('stored lanes preserve count, index, time, channel handles and hierarchy; dropped-key plant is rejected',async()=>{
 const doc=await inspectionControl(),before=JSON.stringify(doc),actual=readAnimationInspection(doc,'control');
 const expected=doc.animations[0].bones.flatMap((b:any)=>b.timelines.map((t:any)=>({kind:'bone',target:b.name,name:t.name,keys:t.keys})));
 expect(actual.tracks.map(({kind,target,name,keys})=>({kind,target,name,keys}))).toEqual(expected);
 const plant=structuredClone(actual.tracks);plant[0]!.keys=plant[0]!.keys.slice(1);expect(()=>expect(plant.map(t=>t.keys)).toEqual(expected.map((t:any)=>t.keys))).toThrow();
 expect(channelSegments(actual.tracks[1]!,1)[0]!.curve).toEqual([.325,-2,.925,3]);
 expect(filterTracks(actual,{kind:'bone',name:'root'})).toEqual([]);expect(filterTracks(actual,{kind:'bone',name:'probe'})).toHaveLength(3);
 expect(boneHierarchy(actual)).toEqual([{name:'root',parent:null,slots:[]},{name:'probe',parent:'root',slots:[]}]);
 expect(readAnimationInspection(doc,'').tracks).toEqual([]);expect(()=>readAnimationInspection(doc,'missing')).toThrow('animation not in the drawn build');expect(JSON.stringify(doc)).toBe(before);
});

test('independent published Play locals equal the stored evaluator at fixed interior and Float32-boundary times, tolerance zero',async()=>{
 for(const form of ['bezier','linear','stepped','overlap','rotation','zero-scale'] as const){
  const doc=await inspectionControl(),timelines=doc.animations[0].bones[0].timelines;
  if(form==='linear'||form==='stepped')for(const t of timelines)for(const k of t.keys){delete k.curve;if(form==='stepped'&&k!==t.keys.at(-1))k.curve='stepped';}
  if(form==='overlap')timelines.push({name:'translatex',keys:[{time:.8,value:-2},{time:1.8,value:3}]});
  if(form==='rotation')timelines[0].keys=[{time:0,value:350},{time:1,value:10},{time:2,value:-181}];
  if(form==='zero-scale'){doc.bones[1].scaleX=0;doc.bones[1].scaleY=-2;}
  const original=JSON.stringify(doc),inspection=readAnimationInspection(doc,'control'),loaded=await loadSetupAssets(doc);
  try{for(const t of fixedTimes(timelines.flatMap((t:any)=>t.keys),2)){
   // Fresh real player prevents a cached pose's old observer callback from masquerading as this sample.
   let actual:number[]|null=null,observedTime:number|null=null;const p=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas',adjust:(bones,ctx)=>{if(ctx.animation==='control'){observedTime=ctx.trackTime;const b=bones.bone('probe');actual=properties.map(k=>b[k]);}}});
   try{p.play('control',{loop:false});p.seek(t);const expected=evaluateBoneLocals(inspection,'probe',p.time);expect(observedTime as number|null).toBe(p.time);expect(actual).not.toBeNull();expect(bytes(properties.map(k=>expected[k])),`${form} at ${t}`).toEqual(bytes(actual!));}finally{p.dispose();}
  }}finally{loaded.dispose();}expect(JSON.stringify(doc)).toBe(original);
 }
});

test('swapped asymmetric Bezier handles and shortest-rotation plants disagree with independent Play',async()=>{
 const doc=await inspectionControl(),mutant=structuredClone(doc),curve=mutant.animations[0].bones[0].timelines[0].keys[0].curve;mutant.animations[0].bones[0].timelines[0].keys[0].curve=[...curve.slice(2),...curve.slice(0,2)];
 const loaded=await loadSetupAssets(doc);let local=NaN;const p=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas',adjust:bones=>{local=bones.bone('probe').rotation;}});
 try{p.play('control',{loop:false});p.seek(.375);expect(evaluateBoneLocals(readAnimationInspection(doc,'control'),'probe',.375).rotation).toBe(local);expect(evaluateBoneLocals(readAnimationInspection(mutant,'control'),'probe',.375).rotation).not.toBe(local);}finally{p.dispose();loaded.dispose();}
 const rotation=await inspectionControl();rotation.animations[0].bones[0].timelines[0].keys=[{time:0,value:350},{time:1,value:10}];const v=evaluateBoneLocals(readAnimationInspection(rotation,'control'),'probe',.5).rotation;expect(v).toBe(23.4+180);expect(v).not.toBe(23.4+360);
});

test('all ten recognized kinds × linear/stepped/Bezier match installed Play exactly, including shear and recurrence-constant drift plant',async()=>{
 expect(Object.keys(CHANNELS).sort()).toEqual(recognizedCases.map(([kind])=>kind).sort());
 const doc=await inspectionControl();Object.assign(doc.bones[1],{shearX:-3.7,shearY:1.2});doc.animations=matrixAnimations('probe');doc.editorOrder.animations=doc.animations.map((a:any)=>a.name);
 const loaded=await loadSetupAssets(doc);
 try{for(const a of doc.animations){const inspection=readAnimationInspection(doc,a.name);for(const requested of fixedTimes(a.bones[0].timelines[0].keys,2)){
  let actual:number[]=[];const p=new RigPlayer(setupRoot(),loaded.assets,{mode:'canvas',adjust:bones=>{const b=bones.bone('probe');actual=properties.map(k=>b[k]);}});
  try{p.play(a.name,{loop:false});p.seek(requested);const values=evaluateBoneLocals(inspection,'probe',p.time);expect(bytes(properties.map(k=>values[k])),`${a.name} ${p.time}`).toEqual(bytes(actual));}finally{p.dispose();}
 }}}finally{loaded.dispose();}
 const source=await Bun.file(new URL('../src/animation-inspection.ts',import.meta.url)).text();expect(source).toContain('(p0-2*p1+p2)*0.03');
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(source.replace('(p0-2*p1+p2)*0.03','(p0-2*p1+p2)*0.031'));
 const mutant=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 const original=await inspectionControl(),assets=await loadSetupAssets(original);let actual=NaN;const p=new RigPlayer(setupRoot(),assets.assets,{mode:'canvas',adjust:bones=>{actual=bones.bone('probe').rotation;}});
 try{p.play('control',{loop:false});p.seek(.375);const inspection=readAnimationInspection(original,'control');expect(evaluateBoneLocals(inspection,'probe',p.time).rotation).toBe(actual);expect(mutant.evaluateBoneLocals(inspection,'probe',p.time).rotation).not.toBe(actual);}finally{p.dispose();assets.dispose();}
});

test('selection routes are page-local and reentrant-safe; primitive picking respects draw order and clips',()=>{
 const seen:unknown[]=[];const selection=new InspectionSelection(value=>{seen.push(value);selection.select(null);});selection.select({kind:'bone',name:'no-slot'});expect(selection.value()).toEqual({kind:'bone',name:'no-slot'});selection.select({kind:'slot',name:'visible'});selection.select(null);expect(seen).toHaveLength(3);
 const row={kind:'region',slot:'back',corners:[0,0,10,0,10,10,0,10]},front={...row,slot:'front',clip:{polygon:[0,0,5,0,5,5,0,5],inverse:false}};
 expect(pickedSlot({order:[row,front]} as never,2,2)).toBe('front');expect(pickedSlot({order:[row,front]} as never,8,8)).toBe('back');expect(pickedSlot({order:[row]} as never,20,20)).toBeNull();
});
