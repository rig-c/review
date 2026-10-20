/**
 * Animate · Idle tracks panel (#104), page side: the config's `motion.tracks` as rows, one track editor (single: amp,
 * period among the divisors of the idle, phase, base; chain: per-link amp and lag, with a drag handle drawn on the stage
 * at each link), add and remove by bone + prop or chain, the blink's `t` as a marker dragged on the timeline with its
 * squash and brow_drop sliders, review's pre-checks, the pending ops with per-op revert, Apply and Reset, and the check
 * readout. While edits are pending the preview drives the edited bones through play's `adjust`, labelled
 * "preview — Apply decides"; it is cleared on Apply and Reset and is never recorded: the source draft keeps only the
 * pending ops (`#idle-pending`) and the panel's own inputs carry no ids.
 */
import {AMP_RANGE,addTrack,entryChanged,idleDraftState,idleDraftText,idleOps,initialState,isChain,orderedEntries,periodFits,periodOffers,precheck,previewLocal,previewPlan,removeTrack,setBlink,stateFromOps,setField,setLinkAmp,SETUP_DEFAULT,SINGLE_PROPS,type BlinkField,type ChainField,type IdleKeying,type IdleSource,type IdleState,type IdleStatus,type LocalChannel,type PreviewPlan,type SingleField} from '../src/idle-tracks.ts';
import type {PatchOp} from '../src/config-patch.ts';

export interface BoneSetup {names:readonly string[];get(bone:string):Partial<Record<LocalChannel,number>>|undefined}
/** play's `BoneAdjust`, as the panel writes it. */
export type IdleAdjust=(bones:{bone(name:string):Record<LocalChannel,number>})=>void;
export interface IdlePanelDeps {
 apply:(ops:PatchOp[],keys:'ctl'|'direct'|null)=>Promise<void>;
 reset:()=>Promise<void>;
 /** Hand the preview to the player (`player.adjust`), or null to clear it; the caller re-poses and draws. */
 preview:(fn:IdleAdjust|null)=>void;
 /** The player's time, read inside `adjust` (the pose being posed). */
 clock:()=>number;
 /** Bones as pane pixels on the drawn frame, for the chain handles; null when nothing is drawn. */
 bonePoints:(bones:readonly string[])=>Map<string,{x:number;y:number}>|null;
 pane:HTMLElement;
 saved:()=>void;
}
export interface IdlePanel {
 load(status:IdleStatus|null,reason:string|null):void;
 /** The drawn model's bone setups, for the preview's locals (play's `BoneLocals` before the timelines). */
 model(setup:BoneSetup|null):void;
 state():IdleState|null;ops():PatchOp[];source():IdleSource|null;keying():IdleKeying|null;
 select(key:string):void;
 field(key:string,field:SingleField|ChainField,value:number|null):void;
 linkAmp(key:string,link:number,value:number):void;
 add(spec:{bone:string;prop:string}|{chain:string}):void;
 remove(key:string):void;
 blink(field:BlinkField,value:number):void;
 /** The pre-check lines for the pending state. */
 refusals():string[];
 previewing():{on:boolean;label:string;plan:PreviewPlan|null};
 setPreview(on:boolean):void;
 restore():void;clear():void;
 applied(ops:readonly PatchOp[]|null):void;
 status(text:string,error:boolean):void;
 readout(lines:{name:string;before:string;after:string}[]):void;
 busy(value:boolean):void;
 /** Re-place the stage handles and the blink marker (every drawn frame and transport change). */
 place(duration:number):void;
 dispose():void;
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const shown=(value:number|undefined)=>value===undefined?'—':String(Number(value.toPrecision(6)));
export const PREVIEW_LABEL='preview — Apply decides';
/** Degrees of amplitude per pane pixel dragged on a chain handle. */
const DEG_PER_PX=0.02;
const THUMB=14;

export function bindIdlePanel(deps:IdlePanelDeps):IdlePanel {
 const stateLine=node('idle-tracks-state'),keysLine=node('idle-keys-line'),list=node('idle-track-list'),editor=node('idle-track-editor'),blinkArea=node('idle-blink'),precheckArea=node('idle-precheck'),pending=node('idle-pending-list');
 const applyButton=node<HTMLButtonElement>('idle-apply'),resetButton=node<HTMLButtonElement>('idle-reset'),status=node('idle-apply-status'),readoutArea=node('idle-readout'),draft=node<HTMLTextAreaElement>('idle-pending'),label=node('idle-preview-label');
 const addBone=document.querySelector<HTMLInputElement>('#idle-tracks [data-idle-add-bone]')!,addProp=document.querySelector<HTMLSelectElement>('#idle-tracks [data-idle-add-prop]')!,addSingle=document.querySelector<HTMLButtonElement>('#idle-tracks [data-idle-add-single]')!;
 const addChain=document.querySelector<HTMLSelectElement>('#idle-tracks [data-idle-add-chain]')!,addChainButton=document.querySelector<HTMLButtonElement>('#idle-tracks [data-idle-add-chain-button]')!,previewBox=document.querySelector<HTMLInputElement>('#idle-tracks [data-idle-preview]')!;
 const bones=node<HTMLDataListElement>('idle-bones'),handles=node('idle-handles'),strip=node('idle-blink-strip'),marker=node<HTMLButtonElement>('idle-blink-marker'),scrub=node<HTMLInputElement>('scrub'),transport=node('transport');
 let source:IdleSource|null=null,keying:IdleKeying|null=null,state:IdleState|null=null,selected:string|null=null,setup:BoneSetup|null=null,appliedOps:string[]=[],busy=false,previewOn=false,plan:PreviewPlan|null=null,lastDuration=0;
 addProp.replaceChildren(...SINGLE_PROPS.map(p=>make('option',{value:p,textContent:p})));

 function panelStatus(text:string,error:boolean){status.textContent=text;status.title=text;status.classList.toggle('error',error);}
 const ops=()=>source&&state?idleOps(source,state):[];
 const save=()=>{draft.value=idleDraftText(ops());draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 /** An edit: the new state, the draft, the preview (turned on by an edit unless the toggle is off) and the view. */
 function change(next:IdleState){state=next;save();if(previewBox.checked)previewOn=true;drivePreview();render();}
 const tryChange=(make:()=>IdleState)=>{try{change(make());}catch(error){panelStatus(error instanceof Error?error.message:String(error),true);}};

 // ---- preview ----
 /** The adjust for the current plan: each write holds its bone's channel at the sine's value at the player's time. */
 function drivePreview(){
  plan=null;
  if(!previewOn||!source||!state||!keying||!setup){deps.preview(null);renderLabel();return;}
  const current=previewPlan(source,state,keying,new Set(setup.names));plan=current;
  const duration=source.duration,writes=current.writes.map(w=>({w,setup:setup!.get(w.bone)?.[w.channel]??SETUP_DEFAULT[w.channel]}));
  deps.preview(writes.length?bones=>{const t=deps.clock()%duration;for(const {w,setup:s} of writes)bones.bone(w.bone)[w.channel]=previewLocal(w,s,t);}:null);
  renderLabel();
 }
 function stopPreview(){previewOn=false;plan=null;deps.preview(null);renderLabel();}
 function renderLabel(){
  const active=previewOn&&!!plan&&plan.writes.length>0;
  label.hidden=!active&&!(previewOn&&plan?.refusals.length);
  label.textContent=active?`${PREVIEW_LABEL} · ${plan!.writes.length} bone(s): ${[...new Set(plan!.writes.map(w=>w.bone))].join(', ')}`:PREVIEW_LABEL;
  label.title=label.textContent;
  label.classList.toggle('refused',!!plan?.refusals.length);
  const notes=[...(plan?.refusals??[]),...(previewOn&&state?.blink&&source?.blink&&JSON.stringify(state.blink)!==JSON.stringify(source.blink)?['IDLE_PREVIEW_BLINK: blink edits are eased keys, not sines, and are not previewed — Apply decides']:[])];
  label.dataset.refusals=String(notes.length);
  previewNotes=notes;
 }
 let previewNotes:string[]=[];

 // ---- view ----
 function renderList(){
  if(!source||!state){list.replaceChildren();return;}
  const head=make('tr',{},...['#','Track','amp','period','phase','base / lag',''].map(l=>make('th',{scope:'col',textContent:l})));
  const body=make('tbody');
  orderedEntries(state).forEach((e,i)=>{
   const t=e.track,changed=entryChanged(source!,e);
   const pick=make('button',{type:'button',className:'physics-row-pick',textContent:isChain(t)?`${t.chain}* rotate (chain, ${t.amps.length} links)`:`${t.bone}.${t.prop}`});pick.setAttribute('aria-pressed',String(selected===e.key));pick.onclick=()=>{selected=e.key;render();};
   const remove=make('button',{type:'button',textContent:'Remove',disabled:busy});remove.setAttribute('aria-label',`Remove track ${i}`);remove.onclick=()=>tryChange(()=>removeTrack(state!,e.key));
   const cells=isChain(t)?[t.amps.map(shown).join(' · '),shown(t.period),shown(t.phase),`lag ${shown(t.lag)}`]:[shown(t.amp),shown(t.period),shown(t.phase),t.base===undefined?'(absent)':shown(t.base)];
   const row=make('tr',{className:[selected===e.key?'selected':'',changed?'pending':''].filter(Boolean).join(' ')},make('td',{textContent:e.origin===null?`${i} (new)`:String(i)}),make('th',{scope:'row'},pick),...cells.map(c=>make('td',{textContent:c})),make('td',{},remove));
   row.dataset.key=e.key;body.append(row);
  });
  const removed=source.tracks.map((t,i)=>({t,i})).filter(({i})=>!state!.entries.some(e=>e.origin===i));
  list.replaceChildren(make('table',{className:'physics-table idle-table'},make('thead',{},head),body),...removed.map(({t,i})=>make('p',{className:'hint pending',textContent:`removed: config.motion.tracks[${i}] ${isChain(t)?`chain ${t.chain}`:`${t.bone}.${t.prop}`}`})));
 }
 /** A slider + number for one value; `commit` gets the number (or refuses a non-finite one by name). */
 function control(labelText:string,value:number,range:{min:number;max:number;step:number},base:number|undefined,commit:(v:number)=>void){
  const r=make('input',{type:'range',min:String(Math.min(range.min,value)),max:String(Math.max(range.max,value)),step:String(range.step),value:String(value),disabled:busy});r.setAttribute('aria-label',labelText);
  const n=make('input',{type:'number',step:'any',value:String(value),disabled:busy,inputMode:'decimal'});n.setAttribute('aria-label',`${labelText} value`);
  const go=(raw:string)=>{const v=Number(raw);if(raw.trim()===''||!Number.isFinite(v)){panelStatus(`IDLE_VALUE_INVALID: ${labelText} must be a finite number`,true);return;}commit(v);};
  r.onchange=()=>go(r.value);r.oninput=()=>{n.value=r.value;};n.onchange=()=>go(n.value);
  const pendingNow=base!==undefined&&base!==value;
  return make('label',{className:pendingNow?'physics-control pending':'physics-control'},make('span',{textContent:labelText}),r,n,make('output',{textContent:pendingNow?`was ${shown(base)}`:''}));
 }
 /** Period: a select of `duration / n` (the producer's divisors) and a typed field checked against the producer's rule. */
 function periodControl(key:string,value:number,base:number|undefined){
  const offers=periodOffers(source!.duration),sel=make('select',{disabled:busy});sel.setAttribute('aria-label','period (divisors of the idle)');
  sel.append(...offers.map(o=>make('option',{value:String(o.period),textContent:`${shown(o.period)} s · ${o.cycles} cycle${o.cycles>1?'s':''}`})));
  const offered=offers.find(o=>o.period===value);
  if(offered)sel.value=String(offered.period);else sel.prepend(make('option',{value:'',textContent:`${shown(value)} s · ${periodFits(source!.duration,value)?'a divisor not offered':'not a divisor'}`,selected:true,disabled:true}));
  sel.onchange=()=>tryChange(()=>setField(state!,key,'period',Number(sel.value)));
  const typed=make('input',{type:'number',step:'any',placeholder:'type a period',disabled:busy,inputMode:'decimal'});typed.setAttribute('aria-label','typed period (s)');typed.dataset.idleTypedPeriod='true';
  typed.onchange=()=>{const v=Number(typed.value);if(typed.value.trim()===''||!Number.isFinite(v)){panelStatus('IDLE_VALUE_INVALID: period must be a finite number',true);return;}tryChange(()=>setField(state!,key,'period',v));};
  const pendingNow=base!==undefined&&base!==value;
  return make('label',{className:pendingNow?'physics-control idle-period pending':'physics-control idle-period'},make('span',{textContent:'period'}),sel,typed,make('output',{textContent:pendingNow?`was ${shown(base)}`:''}));
 }
 function renderEditor(){
  const e=state?.entries.find(x=>x.key===selected);
  if(!source||!state||!e){editor.replaceChildren(make('p',{className:'hint',textContent:'Pick a track to edit it, or add one below.'}));return;}
  const t=e.track,orig=e.origin===null?undefined:source.tracks[e.origin],index=orderedEntries(state).indexOf(e);
  const where=e.origin===null?`new · will be config.motion.tracks[${index}]`:`/motion/tracks/${e.origin}`;
  const out=make('div',{className:'physics-controls'});
  if(isChain(t)){
   const o=orig&&isChain(orig)?orig:undefined;
   t.amps.forEach((a,i)=>out.append(control(`${t.chain}${i} amp`,a,AMP_RANGE.rotate,o?.amps[i],v=>tryChange(()=>setLinkAmp(state!,e.key,i,v)))));
   out.append(periodControl(e.key,t.period,o?.period),control('phase',t.phase,{min:0,max:1,step:0.01},o?.phase,v=>tryChange(()=>setField(state!,e.key,'phase',v))),control('lag',t.lag,{min:-0.5,max:0.5,step:0.01},o?.lag,v=>tryChange(()=>setField(state!,e.key,'lag',v))));
   out.append(make('p',{className:'hint',textContent:'Drag a link\'s handle on the stage up or down to set its amp.'}));
  }else{
   const o=orig&&!isChain(orig)?orig:undefined;
   out.append(control('amp',t.amp,AMP_RANGE[t.prop],o?.amp,v=>tryChange(()=>setField(state!,e.key,'amp',v))),periodControl(e.key,t.period,o?.period),control('phase',t.phase,{min:0,max:1,step:0.01},o?.phase,v=>tryChange(()=>setField(state!,e.key,'phase',v))));
   if(t.base!==undefined){const clear=make('button',{type:'button',textContent:'No base',disabled:busy});clear.onclick=()=>tryChange(()=>setField(state!,e.key,'base',null));const row=control('base',t.base,{min:t.base-10,max:t.base+10,step:t.prop.startsWith('scale')?0.001:0.1},o?.base,v=>tryChange(()=>setField(state!,e.key,'base',v)));row.append(clear);out.append(row);}
   else{const add=make('button',{type:'button',textContent:'Add base',disabled:busy});add.onclick=()=>tryChange(()=>setField(state!,e.key,'base',t.prop.startsWith('scale')?1:0));out.append(make('p',{className:'hint'},'base: absent (the sine about 0) ',add));}
  }
  editor.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:isChain(t)?`chain ${t.chain}`:`${t.bone}.${t.prop}`}),` · ${where}`),out);
 }
 function renderBlink(){
  if(!source||!state?.blink){blinkArea.replaceChildren(make('p',{className:'hint',textContent:'The config states no motion.blink.'}));return;}
  const b=state.blink,o=source.blink!;
  const t=make('input',{type:'number',step:'0.001',value:String(b.t),disabled:busy,inputMode:'decimal'});t.setAttribute('aria-label','blink t (s)');t.onchange=()=>{const v=Number(t.value);if(Number.isFinite(v))tryChange(()=>setBlink(state!,'t',v));};
  const rows=[make('label',{className:b.t!==o.t?'physics-control pending':'physics-control'},make('span',{textContent:'blink t'}),make('span',{className:'hint',textContent:'drag the marker on the timeline'}),t,make('output',{textContent:b.t!==o.t?`was ${shown(o.t)}`:''})),
   control('squash',b.squash,{min:0.01,max:1,step:0.01},o.squash,v=>tryChange(()=>setBlink(state!,'squash',v)))];
  if(b.brow_drop!==undefined)rows.push(control('brow_drop',b.brow_drop,{min:0,max:5,step:0.1},o.brow_drop,v=>tryChange(()=>setBlink(state!,'brow_drop',v))));
  blinkArea.replaceChildren(make('p',{className:'eyebrow',textContent:`BLINK · eyes ${b.eyes.join(', ')}${b.brows?` · brows ${b.brows.join(', ')}`:''}`}),make('div',{className:'physics-controls'},...rows));
 }
 function renderPrecheck(){
  const lines=source&&state?precheck(source,state):[];
  precheckArea.replaceChildren(...lines.map(l=>make('code',{className:'error idle-refusal',textContent:l,title:l})),...previewNotes.map(l=>make('code',{className:'idle-note',textContent:l,title:l})));
  return lines;
 }
 function renderPending(){
  const items=ops();
  pending.replaceChildren(...items.map((op,i)=>{
   const applied=appliedOps.includes(JSON.stringify(op));
   const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.setAttribute('aria-label',`Revert ${op.op} ${op.path}`);
   revert.onclick=()=>tryChange(()=>revertOp(i));
   return make('li',{className:applied?'applied':''},make('code',{textContent:`${op.op} ${op.path}`}),op.op==='remove'?'':` → ${JSON.stringify(op.value)}`,applied?' · applied':'',revert);
  }));
  if(!items.length)pending.append(make('li',{className:'hint',textContent:'No pending ops.'}));
  const refused=renderPrecheck().length>0;
  applyButton.disabled=busy||!items.length||refused;applyButton.title=refused?'Review\'s pre-check refuses the pending idle (lines above); the producer would refuse it by the same name':'';
  resetButton.disabled=busy;
 }
 /** Revert one op: the state the remaining ops describe (each op is independent of the others but for its index). */
 function revertOp(i:number):IdleState{
  return stateFromOps(source!,ops().filter((_,k)=>k!==i));
 }
 function renderAdd(){
  const tracked=new Set(state?.entries.filter(e=>isChain(e.track)).map(e=>(e.track as {chain:string}).chain));
  const chains=source?Object.keys(source.chains):[];
  addChain.replaceChildren(...(chains.length?chains.map(c=>make('option',{value:c,textContent:`${c} (${source!.chains[c]} links)${tracked.has(c)?' · keyed':''}`})):[make('option',{value:'',textContent:'No chain'})]));
  bones.replaceChildren(...(source?.bones??[]).map(b=>make('option',{value:b})));
  for(const c of [addBone,addProp,addSingle,addChain,addChainButton])c.disabled=busy||!source;
 }
 function render(){renderList();renderEditor();renderBlink();renderLabel();renderPending();renderAdd();placeHandles();placeMarker(lastDuration,true);}

 addSingle.onclick=()=>{const bone=addBone.value.trim();if(!source)return;tryChange(()=>{const next=addTrack(source!,state!,{bone,prop:addProp.value});selected=next.entries.at(-1)!.key;return next;});};
 addChainButton.onclick=()=>{if(!source||!addChain.value)return;tryChange(()=>{const next=addTrack(source!,state!,{chain:addChain.value});selected=next.entries.at(-1)!.key;return next;});};
 previewBox.onchange=()=>{if(previewBox.checked){if(ops().length){previewOn=true;drivePreview();}}else stopPreview();render();};
 applyButton.onclick=()=>{if(busy)return;const items=ops();if(!items.length)return;stopPreview();void deps.apply(items,keying?.keys??null);};
 resetButton.onclick=()=>{if(busy)return;void deps.reset();};

 // ---- stage handles (chain amps) ----
 let dragging:{key:string;link:number;startY:number;startAmp:number}|null=null;
 function selectedChain(){const e=state?.entries.find(x=>x.key===selected);return e&&isChain(e.track)?{e,track:e.track}:null;}
 function placeHandles(){
  const chain=selectedChain();
  if(!chain){handles.hidden=true;handles.replaceChildren();return;}
  const names=chain.track.amps.map((_,i)=>`${chain.track.chain}${i}`),points=deps.bonePoints(names);
  if(!points){handles.hidden=true;return;}
  handles.hidden=false;
  if(handles.childElementCount!==names.length||handles.dataset.chain!==chain.track.chain){
   handles.dataset.chain=chain.track.chain;
   handles.replaceChildren(...names.map((name,i)=>{const h=make('button',{type:'button',className:'idle-handle'});h.dataset.link=String(i);h.setAttribute('aria-label',`${name} amp`);
    h.onpointerdown=event=>{event.preventDefault();event.stopPropagation();const c=selectedChain();if(!c||busy)return;dragging={key:c.e.key,link:i,startY:event.clientY,startAmp:c.track.amps[i]!};h.setPointerCapture(event.pointerId);};
    h.onpointermove=event=>{if(!dragging||dragging.link!==i)return;const v=Number((dragging.startAmp+(dragging.startY-event.clientY)*DEG_PER_PX).toFixed(3));const c=selectedChain();if(!c)return;h.dataset.value=String(v);h.querySelector('span')!.textContent=`${name} ${shown(v)}°`;};
    h.onpointerup=event=>{if(!dragging||dragging.link!==i)return;const v=Number((dragging.startAmp+(dragging.startY-event.clientY)*DEG_PER_PX).toFixed(3)),key=dragging.key;dragging=null;h.releasePointerCapture(event.pointerId);if(v!==selectedChain()?.track.amps[i])tryChange(()=>setLinkAmp(state!,key,i,v));};
    h.onkeydown=event=>{if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;event.preventDefault();const c=selectedChain();if(!c)return;tryChange(()=>setLinkAmp(state!,c.e.key,i,Number((c.track.amps[i]!+(event.key==='ArrowUp'?0.05:-0.05)).toFixed(3))));};
    h.append(make('span'));return h;}));
  }
  [...handles.children].forEach((h,i)=>{const p=points.get(names[i]!),el=h as HTMLElement;if(!p){el.hidden=true;return;}el.hidden=false;el.style.left=`${p.x}px`;el.style.top=`${p.y}px`;
   if(!dragging||dragging.link!==i)el.querySelector('span')!.textContent=`${names[i]} ${shown(chain.track.amps[i])}°`;});
 }
 // ---- blink marker on the timeline ----
 let markerKey='';
 function placeMarker(duration:number,force=false){
  lastDuration=duration;
  const b=state?.blink,visible=!!b&&duration>0&&!!source&&Math.abs(duration-source.duration)<1e-6;
  const key=`${visible}|${b?.t}|${duration}|${scrub.offsetLeft},${scrub.offsetTop},${scrub.offsetWidth}|${busy}`;
  if(!force&&key===markerKey)return;markerKey=key;
  strip.hidden=!visible;transport.classList.toggle('has-idle-blink',visible);
  if(!visible)return;
  strip.style.left=`${scrub.offsetLeft+THUMB/2}px`;strip.style.width=`${Math.max(0,scrub.offsetWidth-THUMB)}px`;strip.style.top=`${scrub.offsetTop-12}px`;
  marker.style.left=`${(b!.t/duration)*100}%`;marker.disabled=busy;
  const text=`blink t ${shown(b!.t)} s${b!.t!==source!.blink!.t?` (was ${shown(source!.blink!.t)})`:''} · drag to move`;marker.title=text;marker.setAttribute('aria-label',text);marker.classList.toggle('pending',b!.t!==source!.blink!.t);
 }
 let markerDrag=false;
 const markerTime=(clientX:number)=>{const box=strip.getBoundingClientRect();return Number((Math.min(1,Math.max(0,(clientX-box.left)/Math.max(1,box.width)))*lastDuration).toFixed(3));};
 marker.onpointerdown=event=>{if(busy||!state?.blink)return;event.preventDefault();markerDrag=true;marker.setPointerCapture(event.pointerId);};
 marker.onpointermove=event=>{if(!markerDrag)return;marker.style.left=`${(markerTime(event.clientX)/lastDuration)*100}%`;};
 marker.onpointerup=event=>{if(!markerDrag)return;markerDrag=false;marker.releasePointerCapture(event.pointerId);const t=markerTime(event.clientX);tryChange(()=>setBlink(state!,'t',t));};
 marker.onkeydown=event=>{if(!state?.blink||(event.key!=='ArrowLeft'&&event.key!=='ArrowRight'))return;event.preventDefault();tryChange(()=>setBlink(state!,'t',Number((state!.blink!.t+(event.key==='ArrowRight'?1/12:-1/12)).toFixed(3))));};

 const panel:IdlePanel={
  load(status,reason){
   const unavailable=(why:string)=>{source=null;keying=null;state=null;stateLine.textContent=why;stateLine.classList.add('error');keysLine.textContent='';stopPreview();render();};
   if(!status){unavailable(reason??'IDLE_TRACKS_UNAVAILABLE: no producer handoff');return;}
   if(!status.source.available){unavailable(status.source.reason);return;}
   source=status.source.source;
   keying='error' in status.keying?null:status.keying;
   keysLine.textContent='error' in status.keying?`${status.keying.error} · the preview is off; Apply still runs`:`idle keys: ${status.keying.keys} — ${status.keying.source}`;keysLine.classList.toggle('error','error' in status.keying);
   stateLine.classList.remove('error');
   const chains=source.tracks.filter(isChain).length;
   stateLine.textContent=`${source.tracks.length} idle tracks from the handoff config (${source.tracks.length-chains} single, ${chains} chain) · duration ${shown(source.duration)} s · ${source.blink?'blink':'no blink'} · periods offered: duration / 1…${periodOffers(source.duration).length}`;
   state=idleDraftState(draft.value,source);
   if(selected&&!state.entries.some(e=>e.key===selected))selected=null;
   render();
  },
  model(value){setup=value;if(previewOn)drivePreview();},
  state:()=>state?structuredClone(state):null,ops,source:()=>source?structuredClone(source):null,keying:()=>keying?structuredClone(keying):null,
  select(key){selected=key;render();},
  field(key,field,value){if(!state)throw new Error('IDLE_TRACKS_UNAVAILABLE');change(setField(state,key,field,value));},
  linkAmp(key,link,value){if(!state)throw new Error('IDLE_TRACKS_UNAVAILABLE');change(setLinkAmp(state,key,link,value));},
  add(spec){if(!source||!state)throw new Error('IDLE_TRACKS_UNAVAILABLE');const next=addTrack(source,state,spec);selected=next.entries.at(-1)!.key;change(next);},
  remove(key){if(!state)throw new Error('IDLE_TRACKS_UNAVAILABLE');change(removeTrack(state,key));},
  blink(field,value){if(!state)throw new Error('IDLE_TRACKS_UNAVAILABLE');change(setBlink(state,field,value));},
  refusals:()=>source&&state?precheck(source,state):[],
  previewing:()=>({on:previewOn&&!!plan?.writes.length,label:label.hidden?'':label.textContent??'',plan:plan?structuredClone(plan):null}),
  setPreview(on){previewBox.checked=on;previewBox.dispatchEvent(new Event('change'));},
  restore(){if(source){state=idleDraftState(draft.value,source);render();}},
  clear(){stopPreview();if(source){state=initialState(source);save();}render();},
  applied(list){appliedOps=(list??[]).map(o=>JSON.stringify(o));renderPending();},
  status:panelStatus,
  readout(lines){readoutArea.replaceChildren(...lines.flatMap(l=>[make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'BEFORE'}),make('code',{textContent:l.before,title:l.before})),make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'AFTER'}),make('code',{textContent:l.after,title:l.after}))]));},
  busy(value){busy=value;render();},
  place(duration){placeHandles();placeMarker(duration);},
  dispose(){stopPreview();handles.replaceChildren();},
 };
 render();
 return panel;
}
