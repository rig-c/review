/**
 * Setup · Weights (#107): a watch layer over the selected slot's setup-pose mesh. Pick a bone and every vertex is
 * coloured by that bone's stored weight on the theme's ramp (0 → 1), or switch to max influence and every vertex takes
 * its dominant bone's colour; hovering a vertex reads its stored value. Weights come from the compiled model document
 * (`src/weights.ts` over the shared reader `src/setup-mesh.ts`); vertex positions come from the published player's
 * setup pose (`web/setup-pose.ts`, a second `RigPlayer` over the same assets that never plays — the same placement
 * Edit Mesh uses). Nothing is edited, applied, recorded or sent.
 */
import type {ModelAssets,RenderMode} from '@rig-c/play';
import {placeSetupMesh} from '../src/setup-mesh.ts';
import {WEIGHTS_SELECT_SLOT,dominantInfluence,meanColor,meshWeights,rampColor,weightOf,weightText,weightsModel,type MeshWeights} from '../src/weights.ts';
import {modelBoneNames,readSetupPose} from './setup-pose.ts';
import type {OverlayPoint,OverlayProject,OverlayWeights} from './rig-overlays.ts';

export type WeightsMode='bone'|'max';
/** Ramp stops, low → high, and the categorical bone colours of max influence: theme token names. */
export const weightRampTokens=['--rv-weight-0','--rv-weight-half','--rv-weight-1'] as const;
export const weightBoneTokens=['--rv-weight-bone-1','--rv-weight-bone-2','--rv-weight-bone-3','--rv-weight-bone-4','--rv-weight-bone-5','--rv-weight-bone-6'] as const;
export const WEIGHTS_SOURCE_MISMATCH='WEIGHTS_SOURCE_MISMATCH';
export const WEIGHTS_RIG_UNAVAILABLE='WEIGHTS_RIG_UNAVAILABLE';

/** The selected slot's mesh at the setup pose: world vertices (one per stored vertex), triangles and identity. */
export interface SetupMesh {slot:string;vertices:number[];triangles:number[];identity:{skin:string;attachment:string}|null}
export type SetupMeshResult={ok:true;mesh:SetupMesh;weights:MeshWeights}|{ok:false;code:string};
/**
 * The slot's attachment is the one the setup pose resolves (`readSetupPose`); its stored vertices are placed through
 * the setup-pose bones (`placeSetupMesh`). The stage player is not touched.
 */
export function setupPoseMesh(assets:ModelAssets,model:unknown,slot:string,root:HTMLElement,mode:RenderMode='dom'):SetupMeshResult {
 const available=weightsModel(model);if(!available.ok)return available;
 try{
  const pose=readSetupPose(assets,slot,modelBoneNames(model),root,mode);
  const result=meshWeights(model,slot,pose.identity);if(!result.ok)return result;
  const vertices=placeSetupMesh(result.weights,pose.world);if(!vertices)return {ok:false,code:`${WEIGHTS_SOURCE_MISMATCH}: ${slot} has a non-finite setup-pose vertex`};
  return {ok:true,weights:result.weights,mesh:{slot,vertices,triangles:result.weights.triangles,identity:pose.identity}};
 }catch(error){return {ok:false,code:`${WEIGHTS_RIG_UNAVAILABLE}: ${error instanceof Error?error.message:String(error)}`};}
}

export interface WeightsOverlayInput {
 weights:MeshWeights;mesh:SetupMesh;mode:WeightsMode;bone:string|null;hover:number|null;
 /** Token values: the ramp stops low → high, the bone colours, and the overlay's own colours. */
 ramp:readonly string[];boneColors:readonly string[];colors:OverlayWeights['colors'];
}
/** The overlay drawing: one entry per setup-pose vertex, its value and colour read from the stored weights. */
export function weightsOverlay(input:WeightsOverlayInput):{ok:true;overlay:OverlayWeights}|{ok:false;code:string} {
 const {weights,mesh,mode,bone}=input,count=weights.vertices.length;
 if(mesh.vertices.length!==count*2||mesh.triangles.length%3||mesh.triangles.some(i=>!Number.isSafeInteger(i)||i<0||i>=count))return {ok:false,code:`${WEIGHTS_SOURCE_MISMATCH}: ${mesh.slot} setup pose draws ${mesh.vertices.length/2} vertices; the model attachment stores ${count}`};
 if(mode==='bone'&&!bone)return {ok:false,code:'WEIGHTS_SELECT_BONE: pick a bone'};
 const vertices:OverlayWeights['vertices'][number][]=[];
 for(let i=0;i<count;i++){
  const influences=weights.vertices[i]!,at:OverlayPoint={x:mesh.vertices[i*2]!,y:mesh.vertices[i*2+1]!};
  if(mode==='bone'){
   const value=weightOf(influences,bone!),color=rampColor(input.ramp,value);if(!color)return {ok:false,code:'WEIGHTS_RAMP_UNAVAILABLE: the weight ramp tokens are not hex colours'};
   vertices.push({at,index:i,value,color,label:`#${i} ${bone} ${weightText(value)}`});
  }else{
   const top=dominantInfluence(influences)!,color=input.boneColors[weights.bones.indexOf(top.bone)%input.boneColors.length];
   if(!color)return {ok:false,code:'WEIGHTS_RAMP_UNAVAILABLE: no bone colour tokens'};
   vertices.push({at,index:i,value:top.weight,color,label:`#${i} max ${top.bone} ${weightText(top.weight)}`});
  }
 }
 const triangles:OverlayWeights['triangles'][number][]=[];
 for(let t=0;t<mesh.triangles.length;t+=3){const points=[mesh.triangles[t]!,mesh.triangles[t+1]!,mesh.triangles[t+2]!] as const;triangles.push({points,color:meanColor(points.map(i=>vertices[i]!.color))??vertices[points[0]]!.color});}
 const hover=input.hover!==null&&input.hover>=0&&input.hover<count?input.hover:null;
 return {ok:true,overlay:{triangles,vertices,hover,colors:input.colors}};
}
/** Nearest projected vertex within `radius` canvas px, or null. */
export function hitVertex(overlay:OverlayWeights,project:OverlayProject,at:OverlayPoint,radius=10):number|null {
 let best:number|null=null,distance=radius;
 overlay.vertices.forEach((v,i)=>{const p=project(v.at.x,v.at.y),d=Math.hypot(p.x-at.x,p.y-at.y);if(Number.isFinite(d)&&d<=distance){distance=d;best=i;}});
 return best;
}

export interface WeightsViewHost {
 pane:HTMLElement;canvas:HTMLElement;
 project:()=>OverlayProject|null;
 inspector:()=>string|undefined;
 slot:()=>string|null;
 /** The hash-verified compiled model document the stage draws (null: the package has none; undefined: still loading). */
 model:()=>unknown;
 /** The selected slot's weights and setup-pose mesh (null: no rig loaded). */
 setup:(slot:string)=>SetupMeshResult|null;
 changed:()=>void;
 token:(name:string)=>string;
}
export interface WeightsView {overlay:()=>OverlayWeights|null;refresh:()=>void;sync:()=>void;dispose:()=>void;state:()=>{show:boolean;mode:WeightsMode;bone:string|null;code:string|null;hover:number|null}}

export function bindWeightsView(host:WeightsViewHost):WeightsView {
 const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
 const show=node<HTMLButtonElement>('weights-show'),modeSelect=node<HTMLSelectElement>('weights-mode'),boneSelect=node<HTMLSelectElement>('weights-bone');
 const stateText=node<HTMLElement>('weights-state'),legend=node<HTMLElement>('weights-legend'),readout=node<HTMLElement>('weights-hover');
 let on=false,hover:number|null=null,weights:MeshWeights|null=null,mesh:SetupMesh|null=null,loadCode:string|null=null,code:string|null=null,current:OverlayWeights|null=null,loaded:{slot:string|null;model:unknown}|null=null;
 const mode=():WeightsMode=>modeSelect.value==='max'?'max':'bone';
 const option=(value:string,label=value)=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;};
 const allBones=():string[]=>modelBoneNames(host.model());
 /** Re-read the slot's weights and setup mesh when the slot or the model changed. */
 function load():void {
  const slot=host.slot(),model=host.model();
  if(loaded&&loaded.slot===slot&&loaded.model===model)return;loaded={slot,model};weights=null;mesh=null;hover=null;let code:string|null=null;
  const done=()=>{loadCode=code;fillBones();};
  if(model===undefined){code=`${WEIGHTS_RIG_UNAVAILABLE}: the compiled model document is still loading`;loaded=null;done();return;}
  if(model===null){const result=meshWeights(model,slot,null);code=result.ok?null:result.code;done();return;}
  if(!slot){code=`${WEIGHTS_SELECT_SLOT}: select one mesh slot in the parts list`;done();return;}
  const setup=host.setup(slot);
  if(!setup){code=`${WEIGHTS_RIG_UNAVAILABLE}: no rig loaded`;loaded=null;done();return;}
  if(!setup.ok){code=setup.code;done();return;}
  weights=setup.weights;mesh=setup.mesh;done();
 }
 function fillBones():void {
  const before=boneSelect.value,influencing=weights?.bones??[],rest=allBones().filter(b=>!influencing.includes(b));
  boneSelect.replaceChildren();
  if(influencing.length){const g=document.createElement('optgroup');g.label=`Influencing ${weights!.slot}`;for(const b of influencing)g.append(option(b));boneSelect.append(g);}
  if(rest.length){const g=document.createElement('optgroup');g.label='Other bones';for(const b of rest)g.append(option(b));boneSelect.append(g);}
  const names=[...influencing,...rest];boneSelect.value=names.includes(before)?before:(influencing[0]??names[0]??'');
  boneSelect.disabled=!names.length;
 }
 function build():void {
  current=null;code=loadCode;
  if(!on||!weights||!mesh){render();return;}
  const token=host.token,result=weightsOverlay({weights,mesh,mode:mode(),bone:boneSelect.value||null,hover,ramp:weightRampTokens.map(token),boneColors:weightBoneTokens.map(token),
   colors:{veil:token('--rv-mesh-veil'),edge:token('--rv-mesh-ink'),ink:token('--rv-mesh-ink'),labelBg:token('--rv-bust-label-bg'),hover:token('--rv-mesh-hover')}});
  if(result.ok)current=result.overlay;else code=result.code;
  render();
 }
 function render():void {
  show.setAttribute('aria-pressed',String(on));show.textContent=on?'Hide weights':'Show weights';
  show.disabled=!weights&&!on;boneSelect.disabled=!boneSelect.options.length||mode()==='max';
  stateText.classList.toggle('error',!!code);
  if(code)stateText.textContent=code;
  else if(weights)stateText.textContent=`${weights.slot} / ${weights.skin} / ${weights.attachment}${weights.source.attachment!==weights.attachment||weights.source.slot!==weights.slot?` (linked to ${weights.source.slot} / ${weights.source.attachment})`:''} · ${weights.vertices.length} vertices · ${weights.weighted?`weighted over ${weights.bones.length} bone(s)`:`unweighted: every vertex is ${weights.bones[0]} at 1.0`} · setup pose${on?'':' · Show weights to draw them'}`;
  else stateText.textContent='';
  legend.replaceChildren();
  if(weights&&mode()==='bone'){
   const bar=document.createElement('span');bar.className='weights-ramp';bar.setAttribute('aria-hidden','true');
   const low=document.createElement('span'),high=document.createElement('span');low.textContent='0.0';high.textContent=`1.0 · ${boneSelect.value||'no bone'}`;legend.append(low,bar,high);
  }else if(weights){
   weights.bones.forEach((b,i)=>{const item=document.createElement('span'),dot=document.createElement('i');item.className='weights-swatch';dot.style.background=`var(${weightBoneTokens[i%weightBoneTokens.length]})`;item.append(dot,b);legend.append(item);});
  }
  const h=current&&current.hover!==null?current.vertices[current.hover]:null;
  readout.textContent=h&&weights?`#${h.index}: ${weights.vertices[h.index]!.map(i=>`${i.bone} ${weightText(i.weight)}`).join(' · ')}`:on&&weights?'Hover a vertex to read its stored weights':'';
 }
 const local=(event:PointerEvent)=>{const rect=host.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const move=(event:PointerEvent)=>{
  if(!on||!current)return;const project=host.project();if(!project)return;
  const hit=hitVertex(current,project,local(event));if(hit===hover)return;hover=hit;build();host.changed();
 };
 const leave=()=>{if(hover===null)return;hover=null;build();host.changed();};
 host.pane.addEventListener('pointermove',move);host.pane.addEventListener('pointerleave',leave);
 const toggle=()=>{on=!on;hover=null;load();build();host.changed();};
 const pick=()=>{hover=null;build();host.changed();};
 show.addEventListener('click',toggle);modeSelect.addEventListener('change',pick);boneSelect.addEventListener('change',pick);
 const visible=()=>host.inspector()==='rig';
 return {
  overlay:()=>on&&visible()?current:null,
  refresh(){load();build();if(on)host.changed();},
  sync(){if(!visible()&&hover!==null){hover=null;build();}},
  state:()=>({show:on,mode:mode(),bone:boneSelect.value||null,code,hover}),
  dispose(){host.pane.removeEventListener('pointermove',move);host.pane.removeEventListener('pointerleave',leave);show.removeEventListener('click',toggle);modeSelect.removeEventListener('change',pick);boneSelect.removeEventListener('change',pick);},
 };
}
