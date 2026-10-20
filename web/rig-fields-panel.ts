/**
 * Setup · Rig fields (#110), page side: the bone a rigid part rides (`regions.<part>`), a lash's blink still row dragged
 * on the stage (`motion.blink.still.<part>`), each stop's inward / outward arc dragged at its pivot (`stops[i]`), a bone's
 * inherit mode (`bones[i].inherit`, a chain's `link_inherit`), and `turn`'s pivot and per-part depth with a live dial —
 * play's `adjust` holding the `turn` bone's x, labelled "preview — Apply decides" and never recorded. Every edit is a
 * pending config patch op with a per-op revert; Apply is the whole-rig runner (`rig --config`, then `check`) behind the
 * baseline guard; Reset returns to the inspected build. The source draft keeps the pending ops (`#rig-fields-pending`);
 * the generated controls carry no ids.
 */
import {arcBound,dragRow,readingPair,fieldsApplyEnabled,fieldsDraftEdits,fieldsDraftText,INHERIT_MODES,rigFieldOps,rigFieldsSource,seedStill,setInherit,setRegion,setStill,setStop,setTurn,stillParts,stopArcs,turnDial,TURN_DIAL_RANGE,TURN_PREVIEW_LABEL,type FieldEdit,type RigFieldsSource,type RigPoint,type StillEntry} from '../src/rig-fields.ts';
import type {JsonValue,PatchOp} from '../src/config-patch.ts';

export type DialAdjust=((bones:{bone(name:string):{x:number}})=>void)|null;
export interface PaneBox {left:number;right:number;top:number;bottom:number}
export interface RigFieldsDeps {
 apply:(ops:PatchOp[])=>Promise<void>;
 reset:()=>Promise<void>;
 /** The angle-range reading (#108) of a bone relative to another, on the inspected and the latest scratch build. */
 reading:(bone:string,relative:string)=>Promise<void>;
 /** The selected part's slot, if any. */
 part:()=>string|null;
 /** Rig px (y down) → pane px of the stage handles' layer; null when nothing is drawn or the crop mapping is unavailable. */
 toPane:(x:number,y:number)=>{x:number;y:number}|null;
 /** Pane px → rig px; null as above. */
 toRig:(x:number,y:number)=>RigPoint|null;
 /** The drawn box of a slot in pane px, or null. */
 slotBox:(slot:string)=>PaneBox|null;
 /** Hand the dial to the player (`adjust` on the `turn` bone), or null to clear it. */
 dial:(fn:DialAdjust)=>void;
 /** Whether the `turn` bone is in the drawn model. */
 hasTurn:()=>boolean;
 inspector:()=>string|undefined;
 pause:()=>void;
 saved:()=>void;
}
export interface RigFieldsPanel {
 load(config:unknown|null,reason:string|null):void;
 source():RigFieldsSource|null;edits():FieldEdit[];ops():PatchOp[];
 region(part:string,bone:string):void;
 still(part:string,entry:StillEntry|null):void;
 stop(index:number,bounds:{inward?:number;outward?:number}):void;
 inherit(index:number,mode:string|null,link?:string):void;
 turn(target:{pivot:number}|{part:string;depth:number}):void;
 select(kind:'part'|'still'|'stop'|'bone',value:string|number|null):void;
 /** The dial (rig px), and whether its preview is on with its label. */
 setDial(x:number):void;dialState():{x:number;on:boolean;label:string};
 /** The stage handles' client positions, for automation that drags with a real pointer. */
 handles():{kind:string;x:number;y:number}[];
 revert(path:string):void;
 applied(ops:readonly PatchOp[]|null):void;
 status(text:string,error:boolean):void;
 readout(lines:{name:string;before:string;after:string}[]):void;
 busy(value:boolean):void;
 place():void;restore():void;clear():void;dispose():void;
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const SVG='http://www.w3.org/2000/svg';
const svg=<K extends keyof SVGElementTagNameMap>(tag:K,attrs:Record<string,string|number>):SVGElementTagNameMap[K]=>{const e=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
const shown=(v:JsonValue|undefined)=>v===undefined?'(absent)':typeof v==='string'?v:JSON.stringify(v);
/** Arc radius on the stage, pane px. */
const ARC_R=46;
const rad=(deg:number)=>deg*Math.PI/180;
/** A point on a circle at a Spine angle (counter-clockwise, y up) in pane px (y down). */
const onCircle=(c:{x:number;y:number},deg:number,r=ARC_R)=>({x:c.x+r*Math.cos(rad(deg)),y:c.y-r*Math.sin(rad(deg))});
/** The SVG path of an arc from Spine angle `a` to `b` (b >= a), counter-clockwise on the page. */
export function arcPath(c:{x:number;y:number},a:number,b:number,r=ARC_R):string {
 const p=onCircle(c,a,r),q=onCircle(c,b,r),large=b-a>180?1:0;
 return `M ${c.x} ${c.y} L ${p.x.toFixed(2)} ${p.y.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${q.x.toFixed(2)} ${q.y.toFixed(2)} Z`;
}

export function bindRigFieldsPanel(deps:RigFieldsDeps):RigFieldsPanel {
 const stateLine=node('rig-fields-state'),regionArea=node('rig-fields-region'),stillArea=node('rig-fields-still'),stopsArea=node('rig-fields-stops'),inheritArea=node('rig-fields-inherit'),turnArea=node('rig-fields-turn');
 const pending=node('rig-fields-pending-list'),applyButton=node<HTMLButtonElement>('rig-fields-apply'),resetButton=node<HTMLButtonElement>('rig-fields-reset'),readingButton=node<HTMLButtonElement>('rig-fields-reading');
 const statusOut=node('rig-fields-status'),readoutArea=node('rig-fields-readout'),draft=node<HTMLTextAreaElement>('rig-fields-pending'),stage=node('rig-fields-stage'),dialLabel=node('rig-fields-dial-label');
 let source:RigFieldsSource|null=null,edits=new Map<string,FieldEdit>(),appliedOps:string[]=[],busy=false,dial=0;
 let selPart:string|null=null,selStill:string|null=null,selStop:number|null=null,selBone:number|null=null;
 let drag:{kind:'still'|'inward'|'outward';pointer:number;start:number;from:number}|null=null;

 function panelStatus(text:string,error:boolean){statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);}
 const ops=()=>source?rigFieldOps(source,edits):[];
 const save=()=>{draft.value=fieldsDraftText(edits);draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 const change=(make:()=>Map<string,FieldEdit>,persist=true)=>{try{edits=make();if(persist)save();render();}catch(error){panelStatus(error instanceof Error?error.message:String(error),true);}};
 const valueAt=(path:string,fallback:JsonValue|undefined)=>edits.has(path)?(edits.get(path)!.op==='remove'?undefined:edits.get(path)!.value):fallback;
 const select=(options:{value:string;label:string}[],value:string,aria:string,onchange:(v:string)=>void)=>{const s=make('select',{disabled:busy});s.setAttribute('aria-label',aria);s.append(...options.map(o=>make('option',{value:o.value,textContent:o.label})));s.value=value;s.onchange=()=>onchange(s.value);return s;};
 const number=(value:number,aria:string,step:string,commit:(v:number)=>void)=>{const n=make('input',{type:'number',step,value:String(value),disabled:busy,inputMode:'decimal'});n.setAttribute('aria-label',aria);n.onchange=()=>{const v=Number(n.value);if(!n.value.trim()||!Number.isFinite(v)){panelStatus(`RIG_FIELDS_VALUE_INVALID: ${aria} must be a number`,true);return;}commit(v);};return n;};
 const title=(text:string,hint?:string)=>[make('p',{className:'eyebrow',textContent:text}),...(hint?[make('p',{className:'hint',textContent:hint})]:[])];
 const boneOptions=()=>(source?.boneNames??[]).map(b=>({value:b,label:b}));

 function renderRegion(){
  if(!source?.regions){regionArea.replaceChildren(...title('REGIONS.<PART> · THE BONE A RIGID PART RIDES','The config states no regions.'));return;}
  const parts=Object.keys(source.regions).sort(),slot=deps.part();
  if(slot&&source.regions[slot]!==undefined&&selPart===null)selPart=slot;
  const part=selPart&&source.regions[selPart]!==undefined?selPart:null;
  const pick=select([{value:'',label:'Pick a rigid part (or select it on the stage)'},...parts.map(p=>({value:p,label:`${p} · ${valueAt(`/regions/${p}`,source!.regions![p])}`}))],part??'','Rigid part',v=>{selPart=v||null;render();});
  const rows:Node[]=[pick];
  if(part){
   const now=String(valueAt(`/regions/${part}`,source.regions[part]));
   rows.push(make('div',{className:'row'},make('span',{textContent:`${part} rides`}),select(boneOptions(),now,`regions.${part} bone`,v=>change(()=>setRegion(source!,edits,part,v)))));
   if(slot&&source.regions[slot]===undefined)rows.push(make('p',{className:'hint',textContent:`${slot} is not a rigid part (its mesh rides its weights).`}));
  }
  regionArea.replaceChildren(...title('REGIONS.<PART> · THE BONE A RIGID PART RIDES'),...rows);
 }
 function renderStill(){
  if(!source?.blink){stillArea.replaceChildren(...title('MOTION.BLINK.STILL · A LASH\'S STILL ROW','The config states no motion.blink.'));return;}
  const parts=stillParts(source);
  if(!parts.length){stillArea.replaceChildren(...title('MOTION.BLINK.STILL · A LASH\'S STILL ROW',`No region part rides a bone the blink's eyes name (${source.blink.eyes.join(', ')||'none'}).`));return;}
  const stillOf=(part:string)=>valueAt(`/motion/blink/still/${part}`,source!.blink!.still?.[part] as JsonValue|undefined) as StillEntry|undefined;
  const part=selStill&&parts.includes(selStill)?selStill:null;
  const pick=select([{value:'',label:'Pick a part on an eye bone'},...parts.map(p=>{const e=stillOf(p);return {value:p,label:`${p} · ${e?`row ${e.row} on ${e.bone}`:'no still row'}`};})],part??'','Still row part',v=>{selStill=v||null;if(selStill)deps.pause();render();});
  const rows:Node[]=[pick];
  if(part){
   const now=stillOf(part);
   if(!now){const add=make('button',{type:'button',textContent:'Add still row',disabled:busy});add.onclick=()=>{const seed=seedStill(source!,part);if(!seed){panelStatus(`RIG_FIELDS_NO_SEED: ${part}'s eye bone states no origin`,true);return;}change(()=>setStill(source!,edits,part,seed));};rows.push(make('div',{className:'row'},make('span',{className:'hint',textContent:`${part}: no still row`}),add));}
   else{const remove=make('button',{type:'button',textContent:'Remove',disabled:busy});remove.onclick=()=>change(()=>setStill(source!,edits,part,null));
    rows.push(make('div',{className:'row'},make('span',{textContent:`${part} row`}),number(now.row,`${part} still row`,'1',v=>change(()=>setStill(source!,edits,part,{...now,row:v}))),make('span',{textContent:'on'}),select(boneOptions(),now.bone,`${part} still bone`,v=>change(()=>setStill(source!,edits,part,{...now,bone:v}))),remove));}
  }
  stillArea.replaceChildren(...title('MOTION.BLINK.STILL · A LASH\'S STILL ROW','Rows above the line (rig px, y down) are drawn on the still bone and do not blink. propose drafts one for a lash; the producer takes any region on an eye bone. Drag the row on the stage.'),...rows);
 }
 function renderStops(){
  if(!source?.stops?.length){stopsArea.replaceChildren(...title('STOPS · INWARD / OUTWARD ARCS','The config states no stops (adding one is out of scope).'));return;}
  const rows=source.stops.map(stop=>{
   const now=valueAt(`/stops/${stop.index}`,stop.raw) as Record<string,number>;
   const pick=make('button',{type:'button',className:'physics-row-pick',textContent:`stops[${stop.index}] ${stop.chain} against ${stop.against}`});pick.setAttribute('aria-pressed',String(selStop===stop.index));pick.onclick=()=>{selStop=selStop===stop.index?null:stop.index;deps.pause();render();};
   return make('div',{className:'row'},pick,make('span',{textContent:'in'}),number(now.inward!,`stops[${stop.index}] inward`,'1',v=>change(()=>setStop(source!,edits,stop.index,{inward:v}))),make('span',{textContent:'out'}),number(now.outward!,`stops[${stop.index}] outward`,'1',v=>change(()=>setStop(source!,edits,stop.index,{outward:v}))));
  });
  stopsArea.replaceChildren(...title('STOPS · INWARD / OUTWARD ARCS','Degrees around the rest aim from the first stopped link\'s origin; pick a stop to drag its arc ends on the stage.'),...rows);
 }
 function renderInherit(){
  const bones=source?.bones??[];
  if(!bones.length){inheritArea.replaceChildren(...title('BONES[I].INHERIT','The config states no bones.'));return;}
  const bone=bones.find(b=>b.index===selBone)??null;
  const pick=select([{value:'',label:'Pick a bone'},...bones.map(b=>({value:String(b.index),label:`${b.name}${b.chain?' (chain)':''} · ${b.chain?Object.keys(b.linkInherit??{}).length?'link_inherit':'normal':b.inherit??'normal'}`}))],bone?String(bone.index):'','Bone for inherit',v=>{selBone=v===''?null:Number(v);render();});
  const modes=[{value:'',label:'(absent: normal)'},...INHERIT_MODES.map(m=>({value:m,label:m}))];
  const rows:Node[]=[pick];
  if(bone&&!bone.chain){const now=valueAt(`/bones/${bone.index}/inherit`,bone.inherit??undefined) as string|undefined;rows.push(make('div',{className:'row'},make('span',{textContent:`${bone.name} inherit`}),select(modes,now??'',`${bone.name} inherit`,v=>change(()=>setInherit(source!,edits,bone.index,v||null)))));}
  if(bone?.chain){const now=(valueAt(`/bones/${bone.index}/link_inherit`,bone.linkInherit??undefined) as Record<string,string>|undefined)??{};
   rows.push(...bone.links.map(link=>make('div',{className:'row'},make('span',{textContent:`${link} inherit`}),select(modes,now[link]??'',`${link} inherit`,v=>change(()=>setInherit(source!,edits,bone.index,v||null,link))))));}
  inheritArea.replaceChildren(...title('BONES[I].INHERIT · WHAT A BONE TAKES FROM ITS PARENT'),...rows);
 }
 function renderTurn(){
  if(!source?.turn){turnArea.replaceChildren(...title('TURN · DEPTH, PIVOT AND THE DIAL','The config states no turn.'));dialLabel.hidden=true;return;}
  const t=source.turn,parts=Object.keys(t.depths).sort(),depths=Object.values(t.depths),lo=Math.min(...depths,t.pivot),hi=Math.max(...depths,t.pivot);
  const slider=(value:number,aria:string,commit:(v:number)=>void)=>{const r=make('input',{type:'range',min:String(Math.max(0,lo-.1)),max:String(hi+.1),step:'0.001',value:String(value),disabled:busy});r.setAttribute('aria-label',aria);r.onchange=()=>commit(Number(r.value));return r;};
  const pivot=valueAt('/turn/pivot',t.pivot) as number;
  const slot=deps.part();const part=selPart&&t.depths[selPart]!==undefined?selPart:slot&&t.depths[slot]!==undefined?slot:null;
  const rows:Node[]=[make('div',{className:'physics-control'},make('span',{textContent:'pivot'}),slider(pivot,'turn.pivot',v=>change(()=>setTurn(source!,edits,{pivot:v}))),number(pivot,'turn.pivot value','any',v=>change(()=>setTurn(source!,edits,{pivot:v}))))];
  rows.push(select([{value:'',label:'Pick a part for its depth'},...parts.map(p=>({value:p,label:`${p} · ${valueAt(`/turn/depths/${p}`,t.depths[p])}`}))],part??'','Part for turn depth',v=>{selPart=v||null;render();}));
  if(part){const d=valueAt(`/turn/depths/${part}`,t.depths[part]) as number;rows.push(make('div',{className:'physics-control'},make('span',{textContent:`${part} depth`}),slider(d,`turn.depths.${part}`,v=>change(()=>setTurn(source!,edits,{part,depth:v}))),number(d,`turn.depths.${part} value`,'any',v=>change(()=>setTurn(source!,edits,{part,depth:v})))));}
  const has=deps.hasTurn();
  const dialInput=make('input',{type:'range',min:String(-TURN_DIAL_RANGE),max:String(TURN_DIAL_RANGE),step:'1',value:String(dial),disabled:!has});dialInput.setAttribute('aria-label','turn dial (rig px)');
  dialInput.oninput=()=>panel.setDial(Number(dialInput.value));
  const zero=make('button',{type:'button',textContent:'0',disabled:!has});zero.setAttribute('aria-label','Dial back to 0');zero.onclick=()=>panel.setDial(0);
  rows.push(make('div',{className:'physics-control'},make('span',{textContent:'dial'}),dialInput,make('output',{textContent:`${dial} px`}),zero));
  rows.push(make('p',{className:'hint',textContent:has?'The dial holds the drawn build\'s turn bone at x (play adjust): it shows the build on the stage, not the pending depths — Apply builds those. Nothing is recorded.':'The drawn model has no turn bone; the dial is off.'}));
  turnArea.replaceChildren(...title('TURN · DEPTH, PIVOT AND THE DIAL','(pivot − depth) / (pivot − nearest depth) of the dial carries each part; turn.deform is out of scope.'),...rows);
 }
 function renderPending(){
  const items=[...edits.values()];
  pending.replaceChildren(...items.map(e=>{
   const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.setAttribute('aria-label',`Revert ${e.path}`);revert.onclick=()=>panel.revert(e.path);
   const applied=appliedOps.includes(JSON.stringify({path:e.path,value:e.value??null}));
   return make('li',{className:applied?'applied':''},make('code',{textContent:`${e.op} ${e.path}`}),` ${shown(e.from)} → ${e.op==='remove'?'(removed)':shown(e.value)}${e.name?` · ${e.name}`:''}${applied?' · applied':''}`,revert);
  }));
  if(!items.length)pending.append(make('li',{className:'hint',textContent:'No pending ops.'}));
  applyButton.disabled=!fieldsApplyEnabled({busy,pending:items.length});resetButton.disabled=busy;
  const pair=pairNow();readingButton.disabled=busy||!pair;readingButton.title=pair?`angle-range ${pair.bone}:${pair.relative}`:'Pick a bone with a parent (inherit) or a rigid part';
  readingButton.textContent=pair?`Angle range ${pair.bone}:${pair.relative}`:'Angle range';
 }
 const pairNow=()=>source?readingPair(source,edits,{bone:selBone,part:selPart}):null;
 function renderLabel(){
  const on=dial!==0&&deps.hasTurn();dialLabel.hidden=!on;dialLabel.textContent=on?`${TURN_PREVIEW_LABEL} · turn x ${dial} px`:TURN_PREVIEW_LABEL;dialLabel.title=dialLabel.textContent;
 }
 function render(){renderRegion();renderStill();renderStops();renderInherit();renderTurn();renderPending();renderLabel();place();}

 // ---- stage: the still row and the stop arcs ----
 const svgLayer=svg('svg',{class:'rig-fields-svg','aria-hidden':'true'});
 function stillGeometry(){
  if(!source||!selStill)return null;const now=valueAt(`/motion/blink/still/${selStill}`,source.blink?.still?.[selStill] as JsonValue|undefined) as StillEntry|undefined;if(!now)return null;
  const eye=source.bones.find(b=>!b.chain&&b.name===source!.regions?.[selStill!]),box=deps.slotBox(selStill),cx=eye?.at?.[0]??0;
  const a=deps.toPane(cx,now.row);if(!a)return null;
  const left=box?box.left-8:a.x-50,right=box?box.right+8:a.x+50;
  return {row:now.row,y:a.y,left,right};
 }
 function stopGeometry(){
  if(!source?.stops||selStop===null)return null;const stop=source.stops.find(s=>s.index===selStop);if(!stop)return null;
  const now=valueAt(`/stops/${stop.index}`,stop.raw) as Record<string,number>,arcs=stopArcs(source,stop,{inward:now.inward!,outward:now.outward!});
  if('reason' in arcs)return {reason:arcs.reason};const c=deps.toPane(...arcs.pivot);if(!c)return null;
  return {stop,arcs,c};
 }
 function place(){
  const visible=deps.inspector()==='rig'&&!!source;const still=visible?stillGeometry():null,stop=visible?stopGeometry():null;
  if(!still&&(!stop||'reason' in stop)){stage.hidden=true;return;}
  stage.hidden=false;svgLayer.replaceChildren();
  const handles:HTMLButtonElement[]=[];
  const handle=(kind:'still'|'inward'|'outward',at:{x:number;y:number},label:string)=>{const h=make('button',{type:'button',className:`rig-fields-handle ${kind}`});h.dataset.kind=kind;h.setAttribute('aria-label',label);h.style.left=`${at.x}px`;h.style.top=`${at.y}px`;h.append(make('span',{textContent:label}));h.onpointerdown=event=>down(event,kind);handles.push(h);};
  if(still){svgLayer.append(svg('line',{class:'rig-fields-still-line',x1:still.left,y1:still.y,x2:still.right,y2:still.y}));handle('still',{x:still.right,y:still.y},`${selStill} still row ${still.row}`);}
  if(stop&&!('reason' in stop)){
   const {arcs,c}=stop;
   svgLayer.append(svg('path',{class:'rig-fields-arc inward',d:arcPath(c,arcs.from,arcs.rest)}),svg('path',{class:'rig-fields-arc outward',d:arcPath(c,arcs.rest,arcs.to)}));
   const r=onCircle(c,arcs.rest,ARC_R+14);svgLayer.append(svg('line',{class:'rig-fields-rest',x1:c.x,y1:c.y,x2:r.x,y2:r.y}));
   handle('inward',onCircle(c,arcs.from),`inward ${Number((arcs.rest-arcs.from).toFixed(3))}°`);handle('outward',onCircle(c,arcs.to),`outward ${Number((arcs.to-arcs.rest).toFixed(3))}°`);
  }
  stage.replaceChildren(svgLayer,...handles);
 }
 const angleAt=(event:PointerEvent,c:{x:number;y:number})=>{const rect=stage.getBoundingClientRect();return Math.atan2(-(event.clientY-rect.top-c.y),event.clientX-rect.left-c.x)*180/Math.PI;};
 function down(event:PointerEvent,kind:'still'|'inward'|'outward'){
  if(busy||!source)return;event.preventDefault();event.stopPropagation();deps.pause();
  const rect=stage.getBoundingClientRect();
  if(kind==='still'){const g=stillGeometry();const rig=deps.toRig(event.clientX-rect.left,event.clientY-rect.top);if(!g||!rig)return;drag={kind,pointer:event.pointerId,start:rig[1],from:g.row};}
  else drag={kind,pointer:event.pointerId,start:0,from:0};
  // The handles are redrawn while dragging, so the drag follows the window, not the handle.
  window.addEventListener('pointermove',moveDrag,true);window.addEventListener('pointerup',endDrag,true);window.addEventListener('pointercancel',endDrag,true);
 }
 function dragValue(event:PointerEvent):(()=>Map<string,FieldEdit>)|null {
  if(!drag||!source||event.pointerId!==drag.pointer)return null;
  const rect=stage.getBoundingClientRect();
  if(drag.kind==='still'){const rig=deps.toRig(event.clientX-rect.left,event.clientY-rect.top),part=selStill!,now=valueAt(`/motion/blink/still/${part}`,source.blink?.still?.[part] as JsonValue|undefined) as StillEntry|undefined;if(!rig||!now)return null;const row=dragRow(drag.from,drag.start,rig[1]);return ()=>setStill(source!,edits,part,{...now,row});}
  const g=stopGeometry();if(!g||'reason' in g)return null;const angle=angleAt(event,g.c),v=arcBound(g.arcs.rest,drag.kind,angle),key=drag.kind;
  return ()=>setStop(source!,edits,g.stop.index,{[key]:v});
 }
 function moveDrag(event:PointerEvent){const next=dragValue(event);if(next){event.stopPropagation();change(next,false);}}
 function endDrag(event:PointerEvent){if(!drag||event.pointerId!==drag.pointer)return;const next=dragValue(event);drag=null;unlisten();if(next)change(next);else save();}
 const unlisten=()=>{window.removeEventListener('pointermove',moveDrag,true);window.removeEventListener('pointerup',endDrag,true);window.removeEventListener('pointercancel',endDrag,true);};

 applyButton.onclick=()=>{if(!edits.size||busy)return;panel.setDial(0);void deps.apply(ops());};
 resetButton.onclick=()=>{if(busy)return;void deps.reset();};
 readingButton.onclick=()=>{const pair=pairNow();if(pair&&!busy)void deps.reading(pair.bone,pair.relative);};
 const observer=new MutationObserver(()=>place());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});

 const panel:RigFieldsPanel={
  load(config,reason){
   if(config===null){source=null;edits=new Map();stateLine.textContent=reason??'RIG_FIELDS_UNAVAILABLE: no producer handoff';stateLine.classList.add('error');render();return;}
   source=rigFieldsSource(config);edits=fieldsDraftEdits(draft.value,source);
   const s=source,count=(n:number|undefined,what:string)=>`${n??0} ${what}`;
   stateLine.classList.toggle('error',!!s.skipped.length);
   stateLine.textContent=[count(s.regions?Object.keys(s.regions).length:0,'regions'),s.blink?`blink (${s.blink.still?Object.keys(s.blink.still).length:0} still rows)`:'no blink',count(s.stops?.length,'stops'),`${s.bones.filter(b=>b.inherit||b.linkInherit).length} of ${s.bones.length} bones state inherit`,s.turn?`turn (${Object.keys(s.turn.depths).length} depths)`:'no turn',...(s.skipped.length?[`not read: ${s.skipped.join('; ')}`]:[])].join(' · ');
   render();
  },
  source:()=>source?structuredClone(source):null,
  edits:()=>[...edits.values()].map(e=>structuredClone(e)),ops,
  region(part,bone){if(source)change(()=>setRegion(source!,edits,part,bone));},
  still(part,entry){if(source)change(()=>setStill(source!,edits,part,entry));},
  stop(index,bounds){if(source)change(()=>setStop(source!,edits,index,bounds));},
  inherit(index,mode,link){if(source)change(()=>setInherit(source!,edits,index,mode,link));},
  turn(target){if(source)change(()=>setTurn(source!,edits,target));},
  select(kind,value){if(kind==='part')selPart=value===null?null:String(value);else if(kind==='still')selStill=value===null?null:String(value);else if(kind==='stop')selStop=value===null?null:Number(value);else selBone=value===null?null:Number(value);render();},
  setDial(x){
   const v=Math.max(-TURN_DIAL_RANGE,Math.min(TURN_DIAL_RANGE,Math.round(Number.isFinite(x)?x:0)));dial=deps.hasTurn()?v:0;
   deps.dial(dial!==0?turnDial(dial):null);renderLabel();
   const out=turnArea.querySelector('output');if(out)out.textContent=`${dial} px`;const r=turnArea.querySelector<HTMLInputElement>('input[aria-label="turn dial (rig px)"]');if(r&&Number(r.value)!==dial)r.value=String(dial);
  },
  dialState:()=>({x:dial,on:!dialLabel.hidden,label:dialLabel.textContent??''}),
  handles(){const rect=stage.getBoundingClientRect();return stage.hidden?[]:[...stage.querySelectorAll<HTMLElement>('.rig-fields-handle')].map(h=>({kind:h.dataset.kind!,x:rect.left+parseFloat(h.style.left),y:rect.top+parseFloat(h.style.top)}));},
  revert(path){const next=new Map(edits);next.delete(path);change(()=>next);},
  applied(list){appliedOps=(list??[]).map(o=>JSON.stringify({path:o.path,value:o.value??null}));renderPending();},
  status:panelStatus,
  readout(lines){readoutArea.replaceChildren(...lines.flatMap(l=>[make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'BEFORE'}),make('code',{textContent:l.before,title:l.before})),make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'AFTER'}),make('code',{textContent:l.after,title:l.after}))]));},
  busy(value){busy=value;render();},
  place,
  restore(){if(source){edits=fieldsDraftEdits(draft.value,source);render();}},
  clear(){edits=new Map();save();render();},
  dispose(){observer.disconnect();unlisten();panel.setDial(0);stage.replaceChildren();},
 };
 render();
 return panel;
}
