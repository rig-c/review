/** Slot inspection over the public last-drawn frame. Never changes a track, skin or source. */
import type {Json} from '../src/manifest.ts';
import type {PosedFrame,RigPlayer,PoseBounds,SlotIdentitySnapshot} from '@rig-c/play';
import {parseControlPart,parsePartIdentity,type ControlPart,type ControlPartIdentity,type PartIdentityReason} from '../src/control.ts';
export interface PartDeclaration {skin:string;attachment:string;kind:string;path:string|null}
export interface PartEntry {slot:string;bone:string;setup:string|null;declarations:PartDeclaration[]}
export interface PartObservation {side:ControlPart['side'];slot:string;mode:ControlPart['mode'];identity:ControlPartIdentity|null;generation:number|null;reason:PartIdentityReason|null;drawn:boolean;kind:string|null;page:string|null;region:string|null;sequence:number|null;vertices:number|null;triangles:number|null;z:number|null;skin:string|null;set:string|null;activeAttachment:{skin:string;attachment:string}|null;identityUnavailable:string|null;bounds:PoseBounds|null;declarations:PartDeclaration[]}
const object=(v:unknown,name:string):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(`${name}: expected object`);return v as Record<string,unknown>;};
const name=(v:unknown,field:string):string=>{if(typeof v!=='string'||!v||v.length>512||/[\x00-\x1f]/.test(v))throw new Error(`${field}: expected nonempty name <= 512`);return v;};
export function partCatalog(value:unknown,expected:readonly string[]):PartEntry[]{
 const model=object(value,'part model');if(!Array.isArray(model.slots)||!Array.isArray(model.skins)||model.slots.length>20000||model.skins.length>2000)throw new Error('Part catalog requires bounded model slots and skins');
 const entries=model.slots.map((v,i)=>{const slot=object(v,`slot ${i}`);return {slot:name(slot.name,'slot.name'),bone:name(slot.bone,'slot.bone'),setup:slot.setup===undefined||slot.setup===null||slot.setup===''?null:name(slot.setup,'slot.setup'),declarations:[] as PartDeclaration[]};});
 const bySlot=new Map(entries.map(e=>[e.slot,e]));if(bySlot.size!==entries.length||expected.length!==entries.length||new Set(expected).size!==expected.length||expected.some(s=>!bySlot.has(s)))throw new Error('PART_SOURCE_CHANGED: slot catalog differs from reviewed model');
 let count=0;for(const [i,v]of model.skins.entries()){const skin=object(v,`skin ${i}`),skinName=name(skin.name,'skin.name');const slots=object(skin.attachments??{},'skin.attachments');for(const [slot,raw]of Object.entries(slots)){const entry=bySlot.get(slot);if(!entry)throw new Error(`Part catalog unknown slot ${slot}`);for(const [attachment,a]of Object.entries(object(raw,'slot attachments'))){if(++count>100000)throw new Error('Part declaration count exceeds 100000');const spec=object(a,'attachment');entry.declarations.push({skin:skinName,attachment:name(attachment,'attachment name'),kind:name(spec.kind,'attachment.kind'),path:typeof spec.path==='string'?name(spec.path,'attachment.path'):null});}}}
 return entries;
}
export async function loadPartCatalog(url:string,sha256:string,slots:readonly string[],fetcher:typeof fetch=fetch):Promise<PartEntry[]>{
 const response=await fetcher(url);if(!response.ok)throw new Error('Part catalog model unavailable');const bytes=await response.arrayBuffer();if(bytes.byteLength>128*1024*1024)throw new Error('Part catalog exceeds 128 MiB');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');if(hash!==sha256)throw new Error('PART_SOURCE_CHANGED: model bytes differ from reviewed SHA-256');
 return partCatalog(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),slots);
}
/** Resolve clips on the whole frame first. Filtering player.slots would drop clipping slots. */
export function selectedFrame(full:PosedFrame,part:ControlPart|null,side:ControlPart['side']):PosedFrame{return part?.side===side&&part.mode==='solo'?{...(full.generation===undefined?{}:{generation:full.generation}),order:full.order.filter(row=>row.slot===part.slot)}:full;}
/** Retained frames own geometry: a later prepared seek cannot change an earlier drawn pose. */
export function copyPartFrame(frame:PosedFrame):PosedFrame{return {...(frame.generation===undefined?{}:{generation:frame.generation}),order:frame.order.map(row=>{
 const common={tint:[...row.tint] as [number,number,number,number],...(row.dark?{dark:[...row.dark] as [number,number,number]}:{}),...(row.clip?{clip:{...row.clip,polygon:[...row.clip.polygon]}}:{}),uvs:[...row.uvs]};
 return row.kind==='mesh'?{...row,...common,vertices:[...row.vertices],triangles:[...row.triangles]}:{...row,...common,corners:[...row.corners]};
})};}
export function partGeometry(frame:PosedFrame,slot:string){
 const row=frame.order.find(r=>r.slot===slot);if(!row)return null;const coords=row.kind==='mesh'?row.vertices:row.corners;
 if(coords.length%2||coords.some(v=>!Number.isFinite(v))||row.kind==='mesh'&&(row.triangles.length%3||row.triangles.some(i=>!Number.isSafeInteger(i)||i<0||i>=coords.length/2)))throw new Error(`Part ${slot}: malformed posed geometry`);
 return {kind:row.kind,page:row.page,region:row.kind==='region'?row.region:null,sequence:row.kind==='mesh'?row.sequence:null,vertices:row.kind==='mesh'?coords.length/2:null,triangles:row.kind==='mesh'?row.triangles.length/3:null,z:row.z};
}
/** Conservative world AABB of the last drawn geometry. Normal clips restrict its AABB;
 * inverse clips remain conservative. This is not an alpha/pixel coverage measurement. */
export function partBounds(frame:PosedFrame,slot:string):PoseBounds|null {
 const row=frame.order.find(r=>r.slot===slot);if(!row)return null;partGeometry(frame,slot);
 const box=(coordinates:readonly number[])=>{let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;for(let i=0;i<coordinates.length;i+=2){const x=coordinates[i]!,y=coordinates[i+1]!;if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error(`Part ${slot}: malformed posed bounds`);left=Math.min(left,x);right=Math.max(right,x);bottom=Math.min(bottom,y);top=Math.max(top,y);}return {left,right,bottom,top};};
 const bounds=box(row.kind==='mesh'?row.vertices:row.corners);
 if(row.clip&&!row.clip.inverse){if(row.clip.polygon.length<6||row.clip.polygon.length%2)throw new Error(`Part ${slot}: malformed clip bounds`);const clip=box(row.clip.polygon);bounds.left=Math.max(bounds.left,clip.left);bounds.right=Math.min(bounds.right,clip.right);bounds.bottom=Math.max(bounds.bottom,clip.bottom);bounds.top=Math.min(bounds.top,clip.top);}
 const width=bounds.right-bounds.left,height=bounds.top-bounds.bottom;return Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0?{x:bounds.left,y:bounds.bottom,width,height}:null;
}
/** Identity comes only from the held public snapshot, never catalog/UV/geometry inference. */
export function partIdentity(snapshot:SlotIdentitySnapshot|null,slot:string):ControlPartIdentity|null {
 const row=snapshot?.slots.find(row=>row.slot===slot);return row?{attachment:row.attachment,skin:row.skin,reason:row.reason,set:snapshot!.set,activeSkin:snapshot!.skin}:null;
}
export function copyPartIdentity(snapshot:SlotIdentitySnapshot,frame:PosedFrame,entries:readonly PartEntry[],before:number,after:number):SlotIdentitySnapshot {
 if(!Number.isSafeInteger(before)||before<0||before!==after||snapshot.generation!==before||frame.generation!==before)throw new Error('PART_IDENTITY_STALE: held frame and public slot identity generations differ');
 if(snapshot.slots.length!==entries.length)throw new Error('PART_IDENTITY_SOURCE_CHANGED: snapshot slot count differs from reviewed catalog');
 const names=new Set(entries.map(entry=>entry.slot)),seen=new Set<string>();
 const slots=snapshot.slots.map((row,index)=>{
  if(!names.has(row.slot)||seen.has(row.slot)||row.z!==index)throw new Error(`PART_IDENTITY_SOURCE_CHANGED: slot "${row.slot}" has unknown, repeated or noncontiguous z ${row.z}`);seen.add(row.slot);
  parsePartIdentity({attachment:row.attachment,skin:row.skin,reason:row.reason,set:snapshot.set,activeSkin:snapshot.skin});return {...row};
 });
 const bySlot=new Map(slots.map(row=>[row.slot,row]));let lastZ=-1;
 for(const row of frame.order){const identity=bySlot.get(row.slot);if(!identity||identity.reason!==null||identity.z!==row.z||row.z<=lastZ)throw new Error(`PART_IDENTITY_FRAME_MISMATCH: slot "${row.slot}" does not match held frame order`);lastZ=row.z;}
 // Identity-known slots need not have a visible primitive (zero alpha/empty
 // geometry/nonvisual setup). A known key is not a pixel or fit guarantee.
 return {generation:snapshot.generation,set:snapshot.set,skin:snapshot.skin,slots};
}
export function orderedParts(entries:readonly PartEntry[],frame:PosedFrame|null,identity:SlotIdentitySnapshot|null=null):PartEntry[]{
 const z=new Map(identity?.slots.map(row=>[row.slot,row.z])??frame?.order.map(row=>[row.slot,row.z])??[]),setup=new Map(entries.map((entry,i)=>[entry.slot,i]));
 return [...entries].sort((a,b)=>{const az=z.get(a.slot),bz=z.get(b.slot);return az!==undefined&&bz!==undefined?az-bz:az!==undefined?-1:bz!==undefined?1:setup.get(a.slot)!-setup.get(b.slot)!;});
}
export interface PartPlayer extends Pick<RigPlayer,'posedFrame'|'slotIdentity'|'generation'|'skin'|'set'> {readonly renderer:Pick<RigPlayer['renderer'],'render'>}
interface SideState {entries:PartEntry[];player:PartPlayer;frame:PosedFrame|null;identity:SlotIdentitySnapshot|null}
/** Why a side's parts cannot be inspected. A catalog refusal lasts until that side registers again; an identity refusal until a later valid frame. */
export interface PartRefusal {code:string;message:string;catalog:boolean}
export function partRefusal(error:unknown,catalog:boolean):PartRefusal{const message=error instanceof Error?error.message:String(error),code=/^([A-Z][A-Z0-9_]+):/.exec(message)?.[1]??(catalog?'PART_CATALOG_UNAVAILABLE':'PART_IDENTITY_UNAVAILABLE');return {code,message,catalog};}
export class PartInspection {
 protected sides=new Map<ControlPart['side'],SideState>();protected selected:ControlPart|null=null;protected refused=new Map<ControlPart['side'],PartRefusal>();
 register(side:ControlPart['side'],entries:PartEntry[],player:PartPlayer){this.refused.delete(side);this.sides.set(side,{entries,player,frame:null,identity:null});}
 /** The catalog for this side failed to load or hash: the rig still draws, the side offers no parts. */
 refuseCatalog(side:ControlPart['side'],error:unknown):void {this.sides.delete(side);this.refused.set(side,partRefusal(error,true));}
 refusal(side:ControlPart['side']):PartRefusal|null {return this.refused.get(side)??null;}
 /** A selection on a refused side is retained for recovery but never exposed, drawn Solo or targeted. */
 protected live():ControlPart|null {const part=this.selected;return part&&!this.refused.has(part.side)?part:null;}
 value():ControlPart|null {const part=this.live();if(!part)return null;const state=this.sides.get(part.side),identity=partIdentity(state?.identity??null,part.slot);return {...part,...(identity?{identity}:{} )};}
 assertIdentity(expected:ControlPart|null|undefined):void {if(!expected)return;this.validate(expected);const actual=partIdentity(this.sides.get(expected.side)?.identity??null,expected.slot);if(!actual)throw new Error(`PART_IDENTITY_UNAVAILABLE: ${expected.side} / ${expected.slot} has no held public snapshot`);if(expected.identity&&JSON.stringify(actual)!==JSON.stringify(parsePartIdentity(expected.identity)))throw new Error(`PART_IDENTITY_MISMATCH: ${expected.side} / ${expected.slot} no longer resolves the bookmarked skin/attachment/set/reason`);}
 validate(value:ControlPart|null|undefined):void {if(!value)return;parseControlPart(value);const state=this.sides.get(value.side);if(!state||!state.entries.some(e=>e.slot===value.slot))throw new Error(`PART_UNAVAILABLE: ${value.side} / ${value.slot}`);}
 select(value:ControlPart|null):void {this.validate(value);const refusal=value?this.refused.get(value.side):undefined;if(refusal)throw new Error(`PARTS_UNAVAILABLE: ${value!.side} / ${refusal.message}`);const next=value?{side:value.side,slot:value.slot,mode:value.mode}:null,previous=this.selected;try{for(const [side,state]of this.sides)if(state.frame)state.player.renderer.render(selectedFrame(state.frame,next,side));}catch(error){for(const [side,state]of this.sides)if(state.frame)state.player.renderer.render(selectedFrame(state.frame,previous,side));throw error;}this.selected=next;}
 /** Called inside the successful draw boundary, before compare submission is measured complete. */
 present(side:ControlPart['side']):void {const state=this.sides.get(side);if(!state)return;this.commit(side,state,this.capture(state));}
 protected capture(state:SideState):{full:PosedFrame;identity:SlotIdentitySnapshot} {const before=state.player.generation,full=copyPartFrame(state.player.posedFrame());return {full,identity:copyPartIdentity(state.player.slotIdentity(),full,state.entries,before,state.player.generation)};}
 /** Solo is drawn only from a frame whose identity was just captured; a renderer failure still propagates to the draw boundary. */
 protected commit(side:ControlPart['side'],state:SideState,{full,identity}:{full:PosedFrame;identity:SlotIdentitySnapshot}):void {if(this.selected?.side===side&&this.selected.mode==='solo')state.player.renderer.render(selectedFrame(full,this.selected,side));state.frame=full;state.identity=identity;this.refused.delete(side);}
 /** Drop the held frame and identity: nothing stale is shown as current, and the player's own whole draw stays on screen. */
 protected refuseIdentity(side:ControlPart['side'],state:SideState,error:unknown):void {state.frame=null;state.identity=null;this.refused.set(side,partRefusal(error,false));}
 bounds():PoseBounds|null {const part=this.live(),state=part?this.sides.get(part.side):null;return part&&state?.frame?partBounds(state.frame,part.slot):null;}
 frame(side:ControlPart['side']):PosedFrame|undefined {const state=this.sides.get(side);return state?.frame?selectedFrame(state.frame,this.live(),side):undefined;}
 observation():PartObservation|null {const part=this.live();if(!part)return null;const state=this.sides.get(part.side),entry=state?.entries.find(e=>e.slot===part.slot);if(!state||!entry)return null;const geometry=state.frame?partGeometry(state.frame,part.slot):null,identity=partIdentity(state.identity,part.slot),row=state.identity?.slots.find(row=>row.slot===part.slot);return {...part,identity,generation:state.identity?.generation??null,reason:identity?.reason??null,drawn:!!geometry,kind:geometry?.kind??null,page:geometry?.page??null,region:geometry?.region??null,sequence:geometry?.sequence??null,vertices:geometry?.vertices??null,triangles:geometry?.triangles??null,z:row?.z??geometry?.z??null,skin:state.identity?.skin??null,set:state.identity?.set??null,activeAttachment:identity?.reason===null&&identity.attachment!==null&&identity.skin!==null?{skin:identity.skin,attachment:identity.attachment}:null,identityUnavailable:identity?null:'PART_IDENTITY_UNAVAILABLE: no held public identity snapshot',bounds:this.bounds(),declarations:entry.declarations.map(d=>({...d}))};}

 feedback():Record<string,Json>|null {const value=this.observation();return value?{...value,identity:value.identity?{...value.identity}:null,activeAttachment:value.activeAttachment?{...value.activeAttachment}:null,bounds:value.bounds?{...value.bounds}:null,declarations:value.declarations.map(item=>({...item}))}:null;}
}
export class PartExplorer extends PartInspection {
 private rows=new Map<string,HTMLButtonElement>();private rowEntries=new Map<HTMLButtonElement,PartEntry>();private detailKey='';private orderKey='';private selectionKey='';
 private detailNodes:{title:HTMLHeadingElement;info:HTMLParagraphElement;declarations:HTMLParagraphElement;bounds:HTMLParagraphElement;unavailable:HTMLParagraphElement;feedback:HTMLButtonElement;status:HTMLParagraphElement}|null=null;
 constructor(private host:HTMLElement,private detail:HTMLElement,private changed:(previous:ControlPart|null)=>void,private target:(part:ControlPart)=>void){
  super();
  this.search.addEventListener('input',()=>this.renderList());this.search.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();this.list.querySelector<HTMLButtonElement>('button')?.focus();}if(event.key==='Escape'){this.search.value='';this.renderList();}});
  this.list.addEventListener('keydown',event=>{const buttons=[...this.list.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='ArrowDown'?Math.min(index+1,buttons.length-1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?buttons.length-1:null;if(next!==null){event.preventDefault();buttons[next]?.focus();}if(event.key==='Escape')this.search.focus();});
  this.whole.onclick=()=>this.action(()=>this.select(null));this.solo.onchange=()=>this.action(()=>{if(this.selected)this.select({...this.selected,mode:this.solo.checked?'solo':'context'});});this.renderList();this.renderDetail();
 }
 private get search(){return this.host.querySelector<HTMLInputElement>('[data-part-search]')!;}private get list(){return this.host.querySelector<HTMLElement>('[data-part-list]')!;}private get solo(){return this.host.querySelector<HTMLInputElement>('[data-part-solo]')!;}private get whole(){return this.host.querySelector<HTMLButtonElement>('[data-part-whole]')!;}
 register(side:ControlPart['side'],entries:PartEntry[],player:PartPlayer){super.register(side,entries,player);this.renderList();}
 refuseCatalog(side:ControlPart['side'],error:unknown):void {super.refuseCatalog(side,error);this.renderList();this.renderDetail();}
 select(value:ControlPart|null):void {const previous=this.value();super.select(value);this.renderSelection();this.renderDetail();this.changed(previous);}
 /** Runs on every drawn frame. The held copy and Solo draw are per frame; the list is rewritten only when what it shows changed. */
 present(side:ControlPart['side']):void {const state=this.sides.get(side);if(!state)return;let held;try{held=this.capture(state);}catch(error){this.refuseIdentity(side,state,error);}if(held)this.commit(side,state,held);if(this.viewKey()!==this.selectionKey){this.reorder();this.renderSelection();}this.renderDetail();}
 /** Everything the rows and Solo control display: selection, per-side drawn slots in order, and identity. Generation is excluded. */
 private viewKey():string {let key=JSON.stringify([this.selected,[...this.refused]]);for(const [side,state]of this.sides){key+='\u0001'+side+'\u0002'+(state.frame?state.frame.order.map(row=>row.slot).join('\u0000'):'\u0003');for(const row of state.identity?.slots??[])key+='\u0002'+row.slot+'\u0000'+row.z+'\u0000'+row.skin+'\u0000'+row.attachment+'\u0000'+row.reason;}return key;}
 private action(run:()=>void){try{run();}catch(error){this.renderSelection(true);this.host.querySelector<HTMLElement>('[data-part-status]')!.textContent=`Part selection refused: ${error instanceof Error?error.message:String(error)}`;}}
 private renderList(){this.rows.clear();this.rowEntries.clear();this.list.replaceChildren();const query=this.search.value;for(const [side,state]of this.sides)for(const entry of orderedParts(state.entries,state.frame,state.identity)){if(!entry.slot.includes(query))continue;const row=document.createElement('button');row.type='button';row.dataset.side=side;row.dataset.slot=entry.slot;row.title=`${entry.slot} · bone ${entry.bone}`;row.textContent=`${entry.declarations.some(d=>d.kind==='mesh')?'◈':'◇'} ${side==='single'?'':side.toUpperCase()+' · '}${entry.slot}`;row.onclick=()=>this.action(()=>this.select({side,slot:entry.slot,mode:this.selected?.mode??'context'}));const item=document.createElement('li');item.append(row);this.list.append(item);this.rows.set(JSON.stringify([side,entry.slot]),row);this.rowEntries.set(row,entry);}this.orderKey='';this.reorder();this.renderSelection(true);}
 private statusText():string {const refused=[...this.refused].map(([side,r])=>`${side==='single'?'':side.toUpperCase()+' '}${r.code}`);if(refused.length)return `Parts unavailable · ${refused.join(' · ')}. The rig keeps drawing whole; selection, Solo and feedback targeting are off ${[...this.refused.values()].some(r=>r.catalog)?'until the package reloads with a matching catalog':'until a frame with a valid identity snapshot'}.`;return this.sides.size?`${[...this.sides.values()].reduce((n,s)=>n+s.entries.length,0)} declared slots · ${this.rows.size} results`:'No compiled rig catalog available';}
 private reorder(){const keys=[...this.sides].flatMap(([side,state])=>orderedParts(state.entries,state.frame,state.identity).map(entry=>JSON.stringify([side,entry.slot]))).filter(key=>this.rows.has(key)),key=JSON.stringify(keys);if(key===this.orderKey)return;this.orderKey=key;const active=document.activeElement;for(const item of keys){const row=this.rows.get(item)!;this.list.append(row.parentElement!);}if(active instanceof HTMLElement&&this.list.contains(active)&&document.activeElement!==active)active.focus({preventScroll:true});}
 private renderSelection(force=false){const key=this.viewKey();if(!force&&key===this.selectionKey)return;this.selectionKey=key;const status=this.host.querySelector<HTMLElement>('[data-part-status]')!;status.textContent=this.statusText();if(this.refused.size)this.host.dataset.parts='unavailable';else delete this.host.dataset.parts;const drawnBySide=new Map([...this.sides].map(([side,state])=>[side,new Set(state.frame?.order.map(row=>row.slot)??[])]));this.whole.setAttribute('aria-pressed',String(!this.selected));this.solo.disabled=!this.live();this.solo.checked=this.live()?.mode==='solo';for(const [key,row]of this.rows){row.setAttribute('aria-pressed',String(key===JSON.stringify([this.live()?.side,this.live()?.slot])));const refusal=this.refused.get(row.dataset.side as ControlPart['side']);row.disabled=!!refusal;if(refusal){const label=`${row.dataset.side==='single'?'':row.dataset.side!.toUpperCase()+' · '}${row.dataset.slot} · parts unavailable · ${refusal.code}`;if(row.textContent!==label)row.textContent=label;row.title=label;row.setAttribute('aria-label',label);row.dataset.drawn='false';continue;}const state=this.sides.get(row.dataset.side as ControlPart['side']);const drawn=drawnBySide.get(row.dataset.side as ControlPart['side'])?.has(row.dataset.slot!);row.dataset.drawn=String(!!drawn);const entry=this.rowEntries.get(row),identity=entry?partIdentity(state?.identity??null,row.dataset.slot!):null;row.title=`${row.dataset.slot} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'}${identity?identity.reason?' · '+identity.reason:' · '+identity.skin+' / '+identity.attachment:' · awaiting identity snapshot'}`;const label=`${entry?.declarations.some(d=>d.kind==='mesh')?'◈':'◇'} ${row.dataset.side==='single'?'':row.dataset.side!.toUpperCase()+' · '}${row.dataset.slot} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'} · ${identity?identity.reason?'no active attachment · '+identity.reason:identity.skin+' / '+identity.attachment:'awaiting identity snapshot'}`;if(row.textContent!==label)row.textContent=label;row.setAttribute('aria-label',`${row.textContent} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'}`);}}
 private renderDetail(){
  const observation=this.observation(),refusal=this.selected?this.refused.get(this.selected.side):[...this.refused.values()][0],key=JSON.stringify([observation,refusal??null]);if(key===this.detailKey)return;this.detailKey=key;
  // Keep focused controls connected while the selected pose's bounds animate.
  const nodes=this.detailNodes??=(()=>{
   const title=document.createElement('h3'),info=document.createElement('p'),declarations=document.createElement('p'),bounds=document.createElement('p'),unavailable=document.createElement('p'),feedback=document.createElement('button'),status=document.createElement('p');
   for(const node of [info,declarations,bounds,unavailable,status])node.className='hint';
   feedback.type='button';feedback.textContent='Use slot for feedback';feedback.onclick=()=>{const part=this.value();if(part)this.target(part);};
   unavailable.textContent='Named vertex weights and original source alpha unavailable in this inspection. A packed page is not original part art.';
   status.textContent='Mesh optimization requires an eligible producer handoff. This inspection changes no source art, geometry or motion.';
   this.detail.replaceChildren(title,info,declarations,bounds,unavailable,feedback,status);
   return {title,info,declarations,bounds,unavailable,feedback,status};
  })();
  nodes.title.textContent=observation?`${observation.side==='single'?'':observation.side.toUpperCase()+' · '}${observation.slot}`:'Whole rig';
  nodes.info.textContent=observation?`${observation.mode==='solo'?'Solo':'In context'} · ${observation.drawn?observation.kind==='mesh'?`${observation.vertices} posed vertices · ${observation.triangles} triangles`:'Region · four posed corners':'Not drawn at current pose'} · Skin: ${observation.skin??'not set'} · Set: ${observation.set??'not set'}`:refusal?`Parts unavailable · ${refusal.message}. The whole rig stays drawn; no slot is selected, soloed or targeted from stale data.`:'Select an actual slot in the parts explorer. Selection preserves animation, time and physics history.';
  for(const node of [nodes.declarations,nodes.bounds,nodes.unavailable,nodes.feedback])node.hidden=!observation;nodes.feedback.disabled=!observation;
  nodes.declarations.textContent=observation?`${observation.activeAttachment?'Resolved public attachment: '+observation.activeAttachment.skin+' / '+observation.activeAttachment.attachment+'.':(observation.identityUnavailable??'No active drawable attachment: '+observation.reason)+'.'} Declared: ${observation.declarations.map(d=>`${d.skin} / ${d.attachment} (${d.kind})`).join('; ')||'none'}. ${observation.page?'Drawn page: '+observation.page:''}${observation.region?' · region '+observation.region:''}${observation.sequence!==null?' · sequence '+observation.sequence:''}`:'';
  nodes.bounds.textContent=observation?observation.bounds?`Selection bounds · world units / Y up: x ${observation.bounds.x}, y ${observation.bounds.y}, width ${observation.bounds.width}, height ${observation.bounds.height}. Conservative geometry/clip bounds; fit uses the existing 0.25–8× camera range.`:'PART_FIT_UNAVAILABLE: no positive drawn bounds at the held pose.':'';
 }

}
