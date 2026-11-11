import {expect,test} from 'bun:test';
import {RigPlayer} from '@rig-c/play';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {boneHierarchy,channelSegments,evaluateBoneLocals,filterTracks,readAnimationInspection,CHANNELS,type AnimationInspection,type LocalProperty} from '../src/animation-inspection.ts';
import type {AnimationSideState} from '../web/animation-inspection.ts';
import {InspectionSelection} from '../web/inspection-selection.ts';
import {inspectionControl,properties,bytes,fixedTimes,matrixAnimations,recognizedCases} from './helpers/animation-inspection.ts';
import {pickedSlot} from '../web/stage-pick.ts';

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


// Native Bun EventTarget drives the real production callers; this is not a browser-layout test.
class AnimationActionNode extends EventTarget {
 children:AnimationActionNode[]=[];dataset:Record<string,string>={};type='';textContent='';className='';
 private handler:((event:Event)=>void)|null=null;
 constructor(readonly tagName:string){super();}
 get onclick(){return this.handler;}
 set onclick(value:((event:Event)=>void)|null){if(this.handler)this.removeEventListener('click',this.handler);this.handler=value;if(value)this.addEventListener('click',value);}
 append(...children:AnimationActionNode[]){this.children.push(...children);}
 prepend(...children:AnimationActionNode[]){this.children.unshift(...children);}
 replaceChildren(){this.children=[];}
}
async function actualAnimationActions(document:{createElement(tag:string):AnimationActionNode}){
 const source=await Bun.file(new URL('../web/animation-inspection.ts',import.meta.url)).text();
 const controls=(await Bun.file(new URL('../web/view-controls.ts',import.meta.url)).text()).split('export type ThemePreference')[0]!.replaceAll('export const','const');
 const tree=source.slice(source.indexOf(' private renderTree(){'),source.indexOf(' /**',source.indexOf(' private renderTree(){'))).replace('private renderTree()','function renderTree()');
 const start=source.indexOf("     const mark=button('◆',e=>{");
 const marker=source.slice(start,source.indexOf("     mark.className='animation-key';",start));
 expect(start).toBeGreaterThan(0);expect(tree).toContain('boneHierarchy(this.inspection)');
 const script=`${controls}\nconst button=actionButton;${tree}\nfunction makeMark(track,index,isEditable,cls,readonlyReason){const trackPointer=track.pointer,key=track.keys[index];${marker}return mark;}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 return new Function('document','boneHierarchy',code+';return {renderTree,makeMark};')(document,boneHierarchy);
}

test('#658 animation tree actions preserve order, literal labels and captured bone/slot selections',async()=>{
 const document={createElement:(tag:string)=>new AnimationActionNode(tag)},pane=new AnimationActionNode('div');
 const actions=await actualAnimationActions(document),seen:unknown[]=[];
 const storedInspection=readAnimationInspection(await inspectionControl(),'control');
 const inspection:AnimationInspection={...storedInspection,slots:[...storedInspection.slots,{name:'sleeve',bone:'probe'}]};
 const host={panes:new Map([['tree',pane]]),inspection,select:(value:unknown)=>seen.push(value)};
 actions.renderTree.call(host);
 const buttons:AnimationActionNode[]=[];
 const visit=(node:AnimationActionNode)=>{if(node.tagName==='button')buttons.push(node);for(const child of node.children)visit(child);};visit(pane);
 expect(buttons.map(value=>[value.type,value.textContent])).toEqual([['button','Whole rig'],['button','root'],['button','probe'],['button','◇ sleeve']]);
 expect(buttons.map(value=>value.dataset)).toEqual([{}, {treeKind:'bone',treeName:'root'}, {treeKind:'bone',treeName:'probe'}, {treeKind:'slot',treeName:'sleeve'}]);
 for(const value of buttons)value.dispatchEvent(new Event('click'));
 expect(seen).toEqual([null,{kind:'bone',name:'root'},{kind:'bone',name:'probe'},{kind:'slot',name:'sleeve'}]);
});

test('#658 actual timeline key action receives native Events, keeps shift/detail suppression and uses live key indexes',async()=>{
 const actions=await actualAnimationActions({createElement:(tag:string)=>new AnimationActionNode(tag)}),calls:unknown[]=[];
 const track={pointer:'/track',keys:[{time:.25}]},liveTrack={pointer:'/track',keys:[{time:.5},{time:1.5}]};
 const selection:Pick<AnimationSideState,'selectedKey'|'selectedKeys'>&{track:typeof liveTrack|null}={track:null,selectedKey:null,selectedKeys:[]};
 const host={inspection:{tracks:[liveTrack]},animation:'idle',runtimeDuration:2,suppressNextKeyClick:false,...selection,channel:1,
  renderChannels:()=>calls.push('channels'),toggleKeySelection:(...args:unknown[])=>calls.push(['toggle',...args]),autoSyncPoseModeFromProperty:(value:string)=>calls.push(['pose',value]),syncTimelineKeysInPlace:()=>calls.push('timeline'),syncKeyInspectorInPlace:()=>calls.push('inspector'),setEditorStatus:(...args:unknown[])=>calls.push(['status',...args]),options:{seek:(value:number)=>calls.push(['seek',value])}};
 const mark=actions.makeMark.call(host,track,0,true,{trackIndex:7,property:'rotate'},'read-only') as AnimationActionNode;
 mark.dataset.keyIndex='1';
 mark.dispatchEvent(Object.assign(new Event('click'),{detail:1,shiftKey:false}));expect(calls).toEqual([]);
 mark.dispatchEvent(Object.assign(new Event('click'),{detail:0,shiftKey:true}));
 expect(calls).toEqual(['channels',['toggle',7,1,'/track'],['seek',1.5]]);expect(host.track).toBe(liveTrack);
 calls.length=0;mark.dispatchEvent(new Event('click'));
 const expected={animation:'idle',trackIndex:7,keyIndex:1,pointer:'/track'};
 expect(host.selectedKey).toEqual(expected);
 expect(host.selectedKeys).toEqual([expected]);expect(calls).toEqual(['channels',['pose','rotate'],'timeline','inspector',['seek',1.5]]);
 calls.length=0;host.suppressNextKeyClick=true;mark.dispatchEvent(new Event('click'));expect(calls).toEqual([]);expect(host.suppressNextKeyClick).toBe(false);
});
