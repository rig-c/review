import type {RigPlayer,PosedFrame} from '@rig-c/play';
import {boneHierarchy,CHANNELS,channelSegments,evaluateBoneLocals,evaluateStoredChannel,filterTracks,readAnimationInspection,type AnimationInspection,type InspectionTarget,type InspectionTrack} from '../src/animation-inspection.ts';
import {InspectionSelection} from './inspection-selection.ts';
const NS='http://www.w3.org/2000/svg';
const svg=(tag:string,attrs:Record<string,string|number>)=>{const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const numeric=(value:number)=>Object.is(value,-0)?'-0':String(value);
const button=(label:string,click:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=click;return b;};
export interface AnimationPanelOptions {host:HTMLElement;stage:HTMLElement;select:(value:InspectionTarget)=>void;seek:(time:number)=>void;project:(x:number,y:number)=>{x:number;y:number};enabled:()=>boolean}

/** All picking reads the last drawn primitives, including their resolved clip; never a setup bounding box. */
export function pickedSlot(frame:PosedFrame,x:number,y:number):string|null {
 const inside=(p:readonly number[])=>{let hit=false;for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){const ax=p[i]!,ay=p[i+1]!,bx=p[j]!,by=p[j+1]!;if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)hit=!hit;}return hit;};
 for(const row of [...frame.order].reverse()){
  if(row.clip&&inside(row.clip.polygon)===row.clip.inverse)continue;
  if(row.kind==='region'&&inside(row.corners))return row.slot;
  if(row.kind==='mesh')for(let i=0;i<row.triangles.length;i+=3){const p=row.triangles.slice(i,i+3).flatMap(v=>[row.vertices[v*2]!,row.vertices[v*2+1]!]);if(inside(p))return row.slot;}
 }return null;
}

export class AnimationInspectionPanel {
 private inspection:AnimationInspection|null=null;private document:unknown=null;private animation='';private at=0;private runtimeDuration=0;private track:InspectionTrack|null=null;private channel=0;private view='timeline';private unavailableChannel='';
 private selection:InspectionSelection;private panes=new Map<string,HTMLElement>();private views:HTMLButtonElement[]=[];private playhead:SVGElement|null=null;private cursor:SVGElement|null=null;private plot:((t:number,v:number)=>{x:number;y:number})|null=null;
 private channelSelect:HTMLSelectElement;private readout:HTMLOutputElement;private status:HTMLElement;private picks:HTMLElement;private bones=new Map<string,{x:number;y:number}>();private frame:PosedFrame|null=null;private down:{x:number;y:number}|null=null;private space=false;
 private disposers:(()=>void)[]=[];private boneButtons=new Map<string,HTMLButtonElement>();private bonePoints=false;
 constructor(private options:AnimationPanelOptions){
  const {host,stage}=options;host.classList.add('animation-inspection');host.innerHTML='<h3>Animation inspection · read only</h3><p data-inspection-status class="hint"></p><div class="animation-view-buttons" aria-label="Animation inspection views"></div><section data-animation-pane="timeline" aria-label="Timeline"></section><section data-animation-pane="curve" aria-label="Stored curves" hidden><label>Channel <select data-curve-channel aria-label="Stored animation channel"></select></label><label>Time (s) <input data-curve-time type="number" min="0" step="any" aria-label="Exact inspection seconds"></label><button data-curve-seek type="button">Inspect time</button><svg data-curve-plot role="img" aria-label="Exact stored curve and control points" viewBox="0 0 800 230"></svg><output data-curve-readout aria-live="off"></output><p class="hint">Stored curve and handles are exact. Runtime evaluation uses Play’s ten-piece Float32 interpolation; the cursor may sit off the cubic. Values are authored locals before constraints and previews.</p></section><section data-animation-pane="tree" aria-label="Bone tree" hidden></section>';
  this.status=host.querySelector('[data-inspection-status]')!;this.channelSelect=host.querySelector('[data-curve-channel]')!;this.readout=host.querySelector('[data-curve-readout]')!;
  for(const pane of host.querySelectorAll<HTMLElement>('[data-animation-pane]'))this.panes.set(pane.dataset.animationPane!,pane);
  for(const [id,label]of [['timeline','Timeline'],['curve','Curves'],['tree','Bone tree']]){const b=button(label!,()=>this.show(id!));b.dataset.animationView=id;host.querySelector('.animation-view-buttons')!.append(b);this.views.push(b);}
  this.selection=new InspectionSelection(value=>{options.select(value);this.renderSelection();});
  host.querySelector<HTMLButtonElement>('[data-curve-seek]')!.onclick=()=>{const value=host.querySelector<HTMLInputElement>('[data-curve-time]')!.value.trim();options.seek(value?Number(value):NaN);};
  this.channelSelect.onchange=()=>{this.unavailableChannel='';const [pointer,c]=JSON.parse(this.channelSelect.value) as [string,number];this.track=this.inspection?.tracks.find(t=>t.pointer===pointer)??null;this.channel=c;this.renderCurve();this.update(this.at,this.runtimeDuration);};
  this.picks=document.createElement('div');this.picks.className='animation-stage-picks';stage.append(this.picks);
  const down=(e:PointerEvent)=>{this.down=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY}:null;};
  const up=(e:PointerEvent)=>{const start=this.down;this.down=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>3||this.space||!options.enabled()||e.target instanceof Element&&e.target.closest('button,input,select,textarea')||!this.frame)return;
   const rect=stage.getBoundingClientRect(),p0=options.project(0,0),px=options.project(1,0),py=options.project(0,1),x=(e.clientX-rect.left-p0.x)/(px.x-p0.x),y=(e.clientY-rect.top-p0.y)/(py.y-p0.y),slot=pickedSlot(this.frame,x,y);if(slot)this.select({kind:'slot',name:slot});
  };
  const key=(e:KeyboardEvent)=>{if(e.code==='Space')this.space=e.type==='keydown';};const blur=()=>{this.space=false;this.down=null;};
  stage.addEventListener('pointerdown',down);stage.addEventListener('pointerup',up);window.addEventListener('keydown',key);window.addEventListener('keyup',key);window.addEventListener('blur',blur);
  this.disposers.push(()=>{stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointerup',up);window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('blur',blur);});this.show('timeline');
 }
 model(doc:unknown,animation:string){
  if(this.document===doc&&this.animation===animation)return;this.document=doc;this.animation=animation;this.inspection=null;this.track=null;this.unavailableChannel='';this.frame=null;this.bones.clear();this.boneButtons.clear();this.picks.replaceChildren();this.channelSelect.replaceChildren();this.playhead=null;
  try{this.inspection=readAnimationInspection(doc,animation);boneHierarchy(this.inspection);this.status.textContent=`${animation||'Setup'} · ${this.inspection.tracks.length} stored tracks · key times in seconds; frames require a declared clock.`;}
  catch(e){this.status.textContent=e instanceof Error?e.message:String(e);}
  if(this.selection.value()&&!this.has(this.selection.value()))this.selection.select(null);
  this.renderTree();this.renderSelection();
 }
 private has(value:InspectionTarget){return !value||!!this.inspection&&(value.kind==='bone'?this.inspection.bones:this.inspection.slots).some(x=>x.name===value.name);}
 unavailable(reason:string){this.model(null,'');this.capture(null,undefined);this.status.textContent=reason;}
 select(value:InspectionTarget){if(this.has(value))this.selection.select(value);}
 fromParts(slot:string|null){this.selection.select(slot?{kind:'slot',name:slot}:null);}
 value(){return this.selection.value();}
 show(view:string){this.view=view;for(const [id,pane]of this.panes)pane.hidden=id!==view;for(const b of this.views)b.setAttribute('aria-pressed',String(b.dataset.animationView===view));}
 private renderSelection(){
  const selected=this.selection.value();this.options.host.dataset.selectedKind=selected?.kind??'';this.options.host.dataset.selectedName=selected?.name??'';
  for(const b of this.options.host.querySelectorAll<HTMLButtonElement>('[data-tree-kind]'))b.setAttribute('aria-pressed',String(b.dataset.treeKind===selected?.kind&&b.dataset.treeName===selected?.name));
  this.renderTimeline();this.renderChannels();this.redraw();
 }
 private renderTree(){
  const pane=this.panes.get('tree')!;pane.replaceChildren();if(!this.inspection)return;
  pane.append(button('Whole rig',()=>this.select(null)));const root=document.createElement('ul');root.className='animation-tree';pane.append(root);const parents=new Map<string,HTMLElement>();
  for(const b of boneHierarchy(this.inspection)){
   const li=document.createElement('li'),pick=button(b.name,()=>this.select({kind:'bone',name:b.name}));pick.dataset.treeKind='bone';pick.dataset.treeName=b.name;li.append(pick);(b.parent?parents.get(b.parent)??root:root).append(li);
   const children=document.createElement('ul');li.append(children);parents.set(b.name,children);
   for(const name of b.slots){const row=document.createElement('li'),slot=button('◇ '+name,()=>this.select({kind:'slot',name}));slot.dataset.treeKind='slot';slot.dataset.treeName=name;row.append(slot);children.append(row);}
  }
  const note=document.createElement('p');note.className='hint';note.textContent='Enable Bone points to pick bones on stage. Overlapping points pick the last active bone in source order; use the tree for an exact target. Attached Parts rows highlight together.';pane.prepend(note);
 }
 private renderTimeline(){
  const pane=this.panes.get('timeline')!;pane.replaceChildren();this.playhead=null;if(!this.inspection)return;
  const tracks=filterTracks(this.inspection,this.selection.value()),end=Math.max(this.runtimeDuration,...this.inspection.tracks.map(t=>t.keys.at(-1)?.time??0),Number.MIN_VALUE);
  const list=document.createElement('div');list.className='animation-lanes';pane.append(list);
  const axis=document.createElement('div');axis.className='animation-axis';axis.textContent=`0 s → ${end} s`;list.append(axis);
  for(const kind of ['bone','slot']){
   const group=document.createElement('h4');group.textContent=kind==='bone'?'Bones':'Slots';list.append(group);
   for(const track of tracks.filter(t=>t.kind===kind)){
    const row=document.createElement('div');row.className='animation-lane';row.dataset.track=track.pointer;
    const label=button(`${track.target} · ${track.name}`,()=>{this.track=track;this.channel=0;this.renderChannels();this.show('curve');});label.className='animation-lane-label';row.append(label);
    const marks=document.createElement('div');marks.className='animation-key-lane';marks.dataset.track=track.pointer;row.append(marks);
    track.keys.forEach((key,index)=>{const mark=button('◆',()=>{this.track=track;this.channel=0;this.renderChannels();this.options.seek(key.time);});mark.className='animation-key';Object.assign(mark.dataset,{targetKind:kind,target:track.target,timeline:track.name,keyIndex:String(index),keyTime:String(key.time)});mark.style.left=`${key.time/end*100}%`;mark.title=`${track.target} · ${track.name} · key ${index} · ${key.time} s`;mark.setAttribute('aria-label',mark.title);marks.append(mark);});
    const line=document.createElement('span');line.className='animation-playhead';line.dataset.playhead='';marks.append(line);list.append(row);
   }
  }
  if(!tracks.length){const empty=document.createElement('p');empty.textContent='No stored tracks for this selection.';list.append(empty);}this.placePlayheads();
 }
 private renderChannels(){
  const unsupported=this.track&&(this.track.kind!=='bone'||!CHANNELS[this.track.name])?`${this.track.target} · ${this.track.name} has no numeric curve evaluator`:'';this.unavailableChannel=unsupported;
  this.channelSelect.replaceChildren();const tracks=this.inspection?filterTracks(this.inspection,this.selection.value()):[];
  for(const t of tracks)if(t.kind==='bone')CHANNELS[t.name]?.forEach((c,i)=>{const o=document.createElement('option');o.value=JSON.stringify([t.pointer,i]);o.textContent=`${t.target} · ${t.name} · ${c.local}`;this.channelSelect.append(o);});
  const value=this.track?JSON.stringify([this.track.pointer,this.channel]):'';
  if(unsupported){this.track=null;this.channelSelect.selectedIndex=-1;}
  else if([...this.channelSelect.options].some(o=>o.value===value))this.channelSelect.value=value;
  else{const first=this.channelSelect.options[0];if(first){const [pointer,c]=JSON.parse(first.value);this.track=tracks.find(t=>t.pointer===pointer)??null;this.channel=c;}else this.track=null;}
  this.channelSelect.disabled=this.channelSelect.options.length===0;this.renderCurve();this.update(this.at,this.runtimeDuration);
 }
 private renderCurve(){
  const host=this.options.host.querySelector('[data-curve-plot]')!;host.replaceChildren();this.cursor=null;this.plot=null;
  const t=this.track,field=t&&CHANNELS[t.name]?.[this.channel]?.field;if(!t||!field||!t.keys.length)return;
  const segments=channelSegments(t,this.channel),values=t.keys.map(k=>k[field] as number);for(const s of segments)if(Array.isArray(s.curve))values.push(s.curve[1]!,s.curve[3]!);
  const low=Math.min(...values),high=Math.max(...values),span=high-low||1,end=Math.max(this.runtimeDuration,t.keys.at(-1)!.time,Number.MIN_VALUE);
  const plot=this.plot=(time:number,value:number)=>({x:48+time/end*728,y:195-(value-low)/span*160});
  host.append(svg('path',{d:'M48 20 V195 H776',class:'animation-axes'}));
  for(const [time,value]of [[0,low],[end,high]]){const n=svg('text',{x:time===0?48:650,y:time===0?220:15});n.textContent=`${time} s · ${value}`;host.append(n);}
  for(const [index,s]of segments.entries()){
   const a=plot(...s.from),b=plot(...s.to);let d=`M${a.x} ${a.y}`;
   if(Array.isArray(s.curve)){const c=plot(s.curve[0]!,s.curve[1]!),e=plot(s.curve[2]!,s.curve[3]!);d+=` C${c.x} ${c.y} ${e.x} ${e.y} ${b.x} ${b.y}`;
    host.append(svg('path',{d:`M${a.x} ${a.y} L${c.x} ${c.y} M${b.x} ${b.y} L${e.x} ${e.y}`,class:'animation-handles'}));for(const p of [c,e])host.append(svg('circle',{cx:p.x,cy:p.y,r:3,class:'animation-handle'}));
   }else d+=s.curve==='stepped'?` H${b.x} V${b.y}`:` L${b.x} ${b.y}`;
   const path=svg('path',{d,class:'animation-curve'});path.dataset.segment=String(index);path.dataset.stored=JSON.stringify(s);host.append(path);
  }
  for(const k of t.keys){const p=plot(k.time,k[field] as number);host.append(svg('circle',{cx:p.x,cy:p.y,r:3,class:'animation-curve-key'}));}
  this.cursor=svg('circle',{r:5,class:'animation-runtime-cursor'});host.append(this.cursor);
 }
 update(time:number,duration:number){
  this.at=time;this.runtimeDuration=duration;const timeInput=this.options.host.querySelector<HTMLInputElement>('[data-curve-time]')!;timeInput.max=String(duration);if(document.activeElement!==timeInput)timeInput.value=String(time);this.placePlayheads();const t=this.track,c=t&&CHANNELS[t.name]?.[this.channel];this.readout.textContent=`Runtime evaluation unavailable: ${this.unavailableChannel||'select a numeric stored channel'}.`;for(const key of ['time','channelValue','localValue','bone','property'])delete this.readout.dataset[key];
  if(!t||!c||!this.inspection)return;
  const value=evaluateStoredChannel(t,this.channel,time),local=evaluateBoneLocals(this.inspection,t.target,time)[c.local];
  Object.assign(this.readout.dataset,{time:String(time),channelValue:value===null?'setup':numeric(value),localValue:numeric(local),bone:t.target,property:c.local});
  this.readout.textContent=`Runtime evaluation · ${time} s · ${c.local} track: ${value===null?'before first key (setup)':numeric(value)} · authored local: ${numeric(local)}`;
  if(this.cursor&&this.plot){this.cursor.setAttribute('visibility',value===null?'hidden':'visible');if(value!==null){const p=this.plot(time,value);this.cursor.setAttribute('cx',String(p.x));this.cursor.setAttribute('cy',String(p.y));}}
 }
 private placePlayheads(){const end=Math.max(this.runtimeDuration,...(this.inspection?.tracks??[]).map(t=>t.keys.at(-1)?.time??0),Number.MIN_VALUE);for(const n of this.options.host.querySelectorAll<HTMLElement>('[data-playhead]'))n.style.left=`${this.at/end*100}%`;}
 capture(player:Pick<RigPlayer,'bone'>|null,frame:PosedFrame|undefined){
  this.frame=frame??null;this.bones.clear();for(const b of player&&frame?this.inspection?.bones??[]:[]){try{const p=player!.bone(b.name);if(p.active)this.bones.set(b.name,{x:p.x,y:p.y});}catch{/* unavailable bones have no stage handle */}}this.redraw();
 }
 redraw(bonePoints=this.bonePoints){
  this.bonePoints=bonePoints;
  for(const [name,node]of this.boneButtons)if(!this.bones.has(name)){node.remove();this.boneButtons.delete(name);}
  const {stage}=this.options,selected=this.selection.value();stage.dataset.heldFrame=this.frame?'available':'unavailable';stage.dataset.selectedKind=selected?.kind??'';stage.dataset.selectedName=selected?.name??'';this.picks.hidden=!this.options.enabled();
  let order=0;for(const [name,p]of this.bones){let b=this.boneButtons.get(name);if(!b){b=button('',()=>this.select({kind:'bone',name}));b.className='animation-bone-pick';b.title=`Select bone ${name}`;b.setAttribute('aria-label',b.title);b.dataset.bone=name;this.boneButtons.set(name,b);this.picks.append(b);}
   b.style.zIndex=String(order++);const at=this.options.project(p.x,p.y);b.style.left=`${at.x}px`;b.style.top=`${at.y}px`;b.hidden=!bonePoints&&!(selected?.kind==='bone'&&selected.name===name);b.setAttribute('aria-pressed',String(selected?.kind==='bone'&&selected.name===name));
  }
 }
 dispose(){for(const dispose of this.disposers)dispose();this.picks.remove();}
}
