import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {RigPlayer,type BoneAdjust} from '@rig-c/play';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';
import {composeAdjust,idlePreviewAdjust,PhysicsPreview,LIVE_PHYSICS_FIELDS} from '../web/preview.ts';
import {idleOps,initialState,previewPlan,setField,type IdleSource} from '../src/idle-tracks.ts';
import {patchOps,setEdit,tuningRows,type PendingEdit} from '../src/physics-tuning.ts';
import {makePatch} from '../web/rebuild-client.ts';
import {bindPhysicsPanel} from '../web/physics-panel.ts';

const fixture=new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url);
const physics={kind:'physics',name:'probe_physics',declaredIn:'rig',bone:'probe',x:1,y:1,rotate:1,strength:100,damping:0.85,inertia:0.5,mass:1,wind:2,gravity:3,mix:1};
async function model(keyed=false){
 const doc=JSON.parse(await readFile(fixture,'utf8'));
 doc.animations[0].name='idle';doc.editorOrder.animations=['idle'];doc.constraints=[physics];
 if(keyed)doc.animations[0].constraints.physics=[{name:physics.name,timelines:[{name:'strength',keys:[{time:0,value:70,curve:'stepped'},{time:1,value:130}]}]}];
 return doc;
}
const player=(assets:ConstructorParameters<typeof RigPlayer>[1])=>new RigPlayer(setupRoot(),assets,{mode:'canvas',seekStep:0.125});
// Double bytes include every public world component, rather than a tolerance comparison or rounded JSON.
function pose(p:RigPlayer){const b=p.bone('probe');return Buffer.from(new Float64Array([b.x,b.y,b.a,b.b,b.c,b.d,b.rotationX,b.rotationY,b.scaleX,b.scaleY]).buffer).toString('hex');}
function walk(p:RigPlayer,t:number){p.resume();while(p.time<t){p.advance(Math.min(0.125,t-p.time));}}
function rowFor(doc:unknown){const table=tuningRows([{...physics,type:'physics',kind:undefined,declaredIn:undefined}],doc);if(!table.available)throw new Error(table.reason);return table.rows[0]!;}
const edit=(doc:unknown,field:PendingEdit['field'],value:number)=>[...setEdit(new Map(),rowFor(doc),field,value).values()];

test('idle preview: real Play seek replay and continuous evaluation have bit-exact locals, context and physics at the same time',async()=>{
 const doc=await model(),loaded=await loadSetupAssets(doc),players:RigPlayer[]=[];
 try{
  const props=['rotate','translatex','translatey','scalex','scaley','shearx','sheary'] as const;
  const source:IdleSource={duration:2,bones:['probe'],chains:{},blink:null,tracks:props.map(prop=>({bone:'probe',prop,amp:0.1,period:2,phase:0.17,base:prop.startsWith('scale')?1:0}))};
  let state=initialState(source);for(const e of state.entries)state=setField(state,e.key,'amp',0.37);
  const patchBefore=JSON.stringify(idleOps(source,state));
  const plan=previewPlan(source,state,{keys:'direct',source:'synthetic keyed probe',controls:[],keyed:Object.fromEntries(props.map(prop=>['probe.'+prop,'probe']))},new Set(['root','probe']));
  expect(plan.refusals).toEqual([]);expect(plan.writes.length).toBe(7);
  const setup={names:['root','probe'],get:()=>({x:3,y:7,rotation:0,scaleX:1,scaleY:1,shearX:0,shearY:0})};
  const adjust=idlePreviewAdjust(plan,setup)!;
  for(const target of [0,0.5,1.125,1.53,2.25]){
   const continuous=player(loaded.assets),seeked=player(loaded.assets);players.push(continuous,seeked);
   const samples:[number,string,number][][]=[[],[]],locals:number[][]=[[],[]];
   for(const [i,p] of [continuous,seeked].entries()){
    const dial:BoneAdjust=(bones,ctx)=>{bones.bone('root').x=2; samples[i]!.push([ctx.trackTime!,ctx.animation!,ctx.globalTime]);};
    const composed=composeAdjust(adjust,dial)!;
    p.adjust=(bones,ctx)=>{composed(bones,ctx);const b=bones.bone('probe');locals[i]=[b.x,b.y,b.rotation,b.scaleX,b.scaleY,b.shearX,b.shearY];};
    p.play('idle',{loop:true});
   }
   walk(continuous,target);
   // Make the displayed clock stale before replay; no compensating repose is allowed.
   walk(seeked,1.875);samples[1]=[];seeked.seek(target);
   expect(pose(seeked)).toBe(pose(continuous));
   expect(Buffer.from(new Float64Array(locals[1]).buffer)).toEqual(Buffer.from(new Float64Array(locals[0]).buffer));
   expect(samples[1]!.at(-1)).toEqual(samples[0]!.at(-1));
   const before=pose(seeked);seeked.seek(target);expect(pose(seeked)).toBe(before); // exact cache hit
  }
  expect(JSON.stringify(idleOps(source,state))).toBe(patchBefore);
 }finally{for(const p of players)p.dispose();loaded.dispose();}
});

test('idle adapter keeps null track time explicit and forwards the very same context to both adjustments',()=>{
 const locals={rotation:12,x:0,y:0,scaleX:1,scaleY:1,shearX:0,shearY:0},bones={names:['probe'],bone:()=>locals};
 const adjust=idlePreviewAdjust({tracks:1,refusals:[],writes:[{bone:'probe',channel:'rotation',prop:'rotate',sine:{base:0,amp:4,period:2,phase:0}}]},{names:['probe'],get:()=>({})})!;
 const context={trackTime:null,animation:null,globalTime:4};adjust(bones,context);expect(locals.rotation).toBe(12);
 const seen:unknown[]=[];composeAdjust((_b,c)=>seen.push(c),(_b,c)=>seen.push(c))!(bones,context);
 expect(seen[0]).toBe(context);expect(seen[1]).toBe(context);
});

test('six physics fields are pending until the next real evaluation; clear resumes authored keys and retains integrated history',async()=>{
 const doc=await model(true),bytes=JSON.stringify(doc),loaded=await loadSetupAssets(doc),a=player(loaded.assets),control=player(loaded.assets),fresh=player(loaded.assets),preview=new PhysicsPreview();
 try{
  a.play('idle',{loop:false});control.play('idle',{loop:false});fresh.play('idle',{loop:false});
  const patch={strength:210,damping:0.2,inertia:0.75,wind:11,gravity:7,mix:0.7};
  const edits=LIVE_PHYSICS_FIELDS.flatMap(f=>edit(doc,f,patch[f]));
  const initial=a.readPhysicsParameters(physics.name),held=pose(a),time=a.time;
  preview.sync(a,edits);control.setPhysicsParameters(physics.name,patch);
  expect(a.time).toBe(time);expect(pose(a)).toBe(held);
  expect(preview.read()[0]!.read).toEqual({override:patch,effective:initial.effective});
  a.advance(0.125);control.advance(0.125);
  expect(preview.read()[0]!.read.effective).toEqual(patch);expect(pose(a)).toBe(pose(control));expect(pose(a)).not.toBe(held);
  for(let i=0;i<7;i++){a.advance(0.125);control.advance(0.125);}
  const history=pose(a),last=a.readPhysicsParameters(physics.name).effective;
  preview.clear();control.clearPhysicsParameters(physics.name);
  expect(a.time).toBe(1);expect(pose(a)).toBe(history);
  expect(a.readPhysicsParameters(physics.name)).toEqual({override:null,effective:last});
  a.advance(0.125);control.advance(0.125);walk(fresh,1.125);
  expect(a.readPhysicsParameters(physics.name).effective).toEqual({strength:130,damping:0.85,inertia:0.5,wind:2,gravity:3,mix:1});
  expect(pose(a)).toBe(pose(control));expect(pose(a)).not.toBe(pose(fresh)); // clear didn't reset to a fresh authored walk
  expect(JSON.stringify(doc)).toBe(bytes);expect(fresh.readPhysicsParameters(physics.name).override).toBeNull();
 }finally{preview.clear();a.dispose();control.dispose();fresh.dispose();loaded.dispose();}
});

test('reverting one physics field removes its standing override without losing other pending fields or changing Apply bytes',async()=>{
 const doc=await model(),loaded=await loadSetupAssets(doc),p=player(loaded.assets),preview=new PhysicsPreview();
 try{
  p.play('idle');const row=rowFor(doc);let edits=setEdit(new Map(),row,'damping',0.4);edits=setEdit(edits,row,'wind',9);edits=setEdit(edits,row,'mass',0);
  const before=JSON.stringify(patchOps(edits));preview.sync(p,[...edits.values()]);
  expect(p.readPhysicsParameters(physics.name).override).toEqual({damping:0.4,wind:9});
  expect(JSON.stringify(patchOps(edits))).toBe(before);
  edits=setEdit(edits,row,'damping',0.85);preview.sync(p,[...edits.values()]);
  expect(p.readPhysicsParameters(physics.name).override).toEqual({wind:9});
  preview.sync(p,[]);expect(p.readPhysicsParameters(physics.name).override).toBeNull();
  // Exact literal producer document, including the non-preview mass edit; preview adds no wire field.
  const status={inputs:{config:'rig/config.json',parts:null,rig:null,configHash:'a'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.49.1'}};
  expect(JSON.stringify(makePatch(status,patchOps(edits)))).toBe(JSON.stringify({schema:'rig-review-config-patch/1',config_sha256:'a'.repeat(64),ops:[{op:'replace',path:'/constraints/0/wind',value:9,name:'probe_physics'},{op:'replace',path:'/constraints/0/mass',value:0,name:'probe_physics'}],producer:{name:'@rig-c/parts',version:'1.49.1'},op:{cmd:'rig',args:[]}}));
 }finally{preview.clear();p.dispose();loaded.dispose();}
});

test('public runtime refusals stay named: no track, unknown/non-physics constraints and invalid parameters',async()=>{
 const doc=await model();doc.constraints.push({kind:'transform',name:'follower',declaredIn:'rig',bones:['probe'],source:'root'});
 const loaded=await loadSetupAssets(doc),p=player(loaded.assets),preview=new PhysicsPreview();
 try{
  expect(()=>preview.sync(p,edit(doc,'wind',9))).toThrow('no live track');p.play('idle');
  const unknown=edit(doc,'wind',9).map(e=>({...e,name:'unknown'}));expect(()=>preview.sync(p,unknown)).toThrow('unknown');
  expect(()=>p.setPhysicsParameters('follower',{wind:1})).toThrow('not physics');
  expect(()=>p.setPhysicsParameters(physics.name,{wind:NaN})).toThrow('finite');
  expect(()=>p.setPhysicsParameters(physics.name,{mass:2} as never)).toThrow('mass');
  preview.sync(p,edit(doc,'wind',9));const before=p.readPhysicsParameters(physics.name);
  expect(()=>p.setPhysicsParameters(physics.name,{wind:Infinity})).toThrow();expect(p.readPhysicsParameters(physics.name)).toEqual(before);
 }finally{preview.clear();p.dispose();loaded.dispose();}
});

test('standing physics patch replays the current values, not the old trajectory; seek 0 retains the authored initial effective values',async()=>{
 const doc=await model(true),loaded=await loadSetupAssets(doc),p=player(loaded.assets),control=player(loaded.assets),preview=new PhysicsPreview();
 try{
  p.play('idle',{loop:false});walk(p,0.5);preview.sync(p,edit(doc,'wind',12));walk(p,1);
  p.seek(0.5);
  control.play('idle',{loop:false});control.setPhysicsParameters(physics.name,{wind:12});walk(control,0.5);
  expect(pose(p)).toBe(pose(control));
  p.seek(0);expect(p.readPhysicsParameters(physics.name)).toMatchObject({override:{wind:12},effective:{strength:70,wind:2}});
  p.advance(0.125);expect(p.readPhysicsParameters(physics.name).effective!.wind).toBe(12);
  // A paused UI may explicitly repose the held time: no seek, history reset or time advance.
  const heldTime=p.time;p.pause();preview.sync(p,[]);p.repose();expect(p.time).toBe(heldTime);
  expect(p.readPhysicsParameters(physics.name)).toMatchObject({override:null,effective:{wind:2}});
  control.seek(0);control.advance(0.125);control.clearPhysicsParameters(physics.name);control.repose();control.advance(0.125);
  p.resume();p.advance(0.125);expect(pose(p)).toBe(pose(control));
 }finally{preview.clear();p.dispose();control.dispose();loaded.dispose();}
});

/** Minimal panel host, as in retarget-panel.test.ts. The player/physics behind the panel is the real published runtime. */
class PanelElement extends EventTarget {
 [key:string]:unknown;
 children:PanelElement[]=[];attributes:Record<string,string>={};dataset:Record<string,string>={};style:Record<string,string>={};
 value='';checked=false;textContent='';title='';disabled=false;
 classList={toggle(){},add(){},remove(){}};
 constructor(readonly tagName='div'){super();}
 append(...nodes:unknown[]){for(const n of nodes)if(n instanceof PanelElement)this.children.push(n);}
 replaceChildren(...nodes:unknown[]){this.children=[];this.append(...nodes);}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 find(predicate:(e:PanelElement)=>boolean):PanelElement|undefined {if(predicate(this))return this;for(const c of this.children){const found=c.find(predicate);if(found)return found;}}
 fire(name:string){const fn=this['on'+name] as (()=>void)|undefined;fn?.();}
}

test('physics panel: slider input previews before change; label reads real effective values; Clear keeps Apply ops, time, pose and history',async()=>{
 const doc=await model(true),loaded=await loadSetupAssets(doc),p=player(loaded.assets),control=player(loaded.assets),fresh=player(loaded.assets),preview=new PhysicsPreview();
 const elements=new Map<string,PanelElement>(),at=(id:string)=>{let e=elements.get(id);if(!e){e=new PanelElement();elements.set(id,e);}return e;};
 const previewBox=at('previewBox');previewBox.checked=true;
 const nativeDocument=globalThis.document;
 (globalThis as unknown as Record<string,unknown>).document={createElement:(tag:string)=>new PanelElement(tag),getElementById:at,querySelector:(selector:string)=>selector==='#physics-panel [data-physics-preview]'?previewBox:null};
 let applied:unknown=null;
 const panel=bindPhysicsPanel({pane:at('pane') as unknown as HTMLElement,saved:()=>{},bonePoints:()=>null,reset:async()=>{},apply:async ops=>{applied=structuredClone(ops);},preview:edits=>preview.sync(p,edits),previewRead:()=>preview.read()});
 try{
  p.play('idle',{loop:false});control.play('idle',{loop:false});fresh.play('idle',{loop:false});
  const table=tuningRows([{...physics,type:'physics',kind:undefined,declaredIn:undefined}],doc);panel.load(table,doc.bones);panel.select(physics.name);
  expect(at('physics-preview-label').textContent).toContain('mass and x/y/rotate require Apply');
  const range=at('physics-row-editor').find(e=>e.tagName==='input'&&e.type==='range'&&e.dataset.field==='wind')!;
  const held=pose(p);range.value='12';range.fire('input');
  // Preview while dragging, before mouse-up/change; the active input isn't replaced.
  expect(at('physics-row-editor').find(e=>e===range)).toBe(range);
  expect(panel.edits().map(e=>[e.field,e.value])).toEqual([['wind',12]]);
  expect(pose(p)).toBe(held);expect(p.time).toBe(0);
  expect(at('physics-preview-label').textContent).toContain('preview — Apply decides');
  expect(at('physics-preview-label').textContent).toContain('pending {"wind":12}');
  expect(p.readPhysicsParameters(physics.name).effective!.wind).toBe(2);
  control.setPhysicsParameters(physics.name,{wind:12});p.advance(0.125);control.advance(0.125);panel.refreshPreview();
  expect(at('physics-preview-label').textContent).toContain('"wind":12');
  expect(at('physics-preview-label').textContent).toContain('last evaluated');
  for(let i=0;i<7;i++){p.advance(0.125);control.advance(0.125);}
  const inputBytes=at('physics-pending').value,applyBytes=JSON.stringify(panel.edits().map(({op,path,value,name})=>({op,path,value,name}))),beforeClear=pose(p);
  at('physics-preview-clear').fire('click');control.clearPhysicsParameters(physics.name);
  expect(previewBox.checked).toBe(false);expect(pose(p)).toBe(beforeClear);expect(p.time).toBe(1);
  expect(at('physics-preview-label').textContent).toContain('integrated history is kept');
  expect(at('physics-pending').value).toBe(inputBytes);expect(panel.edits()).toHaveLength(1);
  expect(p.readPhysicsParameters(physics.name)).toMatchObject({override:null,effective:{wind:12}});
  p.advance(0.125);control.advance(0.125);walk(fresh,1.125);
  expect(p.readPhysicsParameters(physics.name).effective!.wind).toBe(2);
  expect(pose(p)).toBe(pose(control));expect(pose(p)).not.toBe(pose(fresh));
  at('physics-apply').fire('click');expect(JSON.stringify(applied)).toBe(applyBytes);
  panel.busy(true);previewBox.checked=true;previewBox.fire('change');
  expect(previewBox.disabled).toBe(true);expect(at('physics-preview-clear').disabled).toBe(true);expect(p.readPhysicsParameters(physics.name).override).toBeNull();
  panel.busy(false);
  // Reset removes pending edits; Clear preview didn't. Applied markers do not re-preview an applied op.
  panel.clear();expect(panel.edits()).toEqual([]);panel.set(physics.name,'wind',8);panel.applied([{op:'replace',path:'/constraints/0/wind',value:8,name:physics.name}]);
  previewBox.checked=true;previewBox.fire('change');expect(preview.read()).toEqual([]);
  panel.set(physics.name,'mass',0);expect(p.readPhysicsParameters(physics.name).override).toBeNull();
  panel.applied(null);panel.set(physics.name,'wind',10);expect(p.readPhysicsParameters(physics.name).override).toEqual({wind:10});
  const draft=at('physics-pending').value;panel.restore();expect(p.readPhysicsParameters(physics.name).override).toBeNull();expect(at('physics-pending').value).toBe(draft);
 }finally{panel.dispose();preview.clear();p.dispose();control.dispose();fresh.dispose();globalThis.document=nativeDocument;loaded.dispose();}
});
