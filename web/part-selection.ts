/** Slot inspection over the public last-drawn frame. Never changes a track, skin or source. */
import type {Json} from '../src/manifest.ts';
import type {PosedFrame,RigPlayer,PoseBounds} from '@rig-c/play';
import {parseControlPart,type ControlPart} from '../src/control.ts';
export interface PartDeclaration {skin:string;attachment:string;kind:string;path:string|null}
export interface PartEntry {slot:string;bone:string;setup:string|null;declarations:PartDeclaration[]}
export interface PartObservation {side:ControlPart['side'];slot:string;mode:ControlPart['mode'];drawn:boolean;kind:string|null;page:string|null;region:string|null;sequence:number|null;vertices:number|null;triangles:number|null;z:number|null;skin:string|null;set:string|null;activeAttachment:{skin:string;attachment:string}|null;identityUnavailable:string|null;bounds:PoseBounds|null;declarations:PartDeclaration[]}
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
export function selectedFrame(full:PosedFrame,part:ControlPart|null,side:ControlPart['side']):PosedFrame{return part?.side===side&&part.mode==='solo'?{order:full.order.filter(row=>row.slot===part.slot)}:full;}
/** Retained frames own geometry: a later prepared seek cannot change an earlier drawn pose. */
export function copyPartFrame(frame:PosedFrame):PosedFrame{return {order:frame.order.map(row=>{
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
/** Exact only when the hashed catalog admits one possible declaration and a draw
 * proves the slot is non-null. No texture/UV/geometry matching is used. */
export function partIdentity(entry:PartEntry,drawn:boolean,set:string|null){
 const declaration=entry.declarations.length===1?entry.declarations[0]:null;
 return drawn&&set===null&&declaration?{skin:declaration.skin,attachment:declaration.attachment}:null;
}
export function orderedParts(entries:readonly PartEntry[],frame:PosedFrame|null):PartEntry[]{
 const z=new Map(frame?.order.map(row=>[row.slot,row.z])??[]),setup=new Map(entries.map((entry,i)=>[entry.slot,i]));
 return [...entries].sort((a,b)=>{const az=z.get(a.slot),bz=z.get(b.slot);return az!==undefined&&bz!==undefined?az-bz:az!==undefined?-1:bz!==undefined?1:setup.get(a.slot)!-setup.get(b.slot)!;});
}
export interface PartPlayer extends Pick<RigPlayer,'posedFrame'|'skin'|'set'> {readonly renderer:Pick<RigPlayer['renderer'],'render'>}
interface SideState {entries:PartEntry[];player:PartPlayer;frame:PosedFrame|null}
export class PartInspection {
 protected sides=new Map<ControlPart['side'],SideState>();protected selected:ControlPart|null=null;
 register(side:ControlPart['side'],entries:PartEntry[],player:PartPlayer){this.sides.set(side,{entries,player,frame:null});}
 value():ControlPart|null{return this.selected?{...this.selected}:null;}
 validate(value:ControlPart|null|undefined):void {if(!value)return;parseControlPart(value);const state=this.sides.get(value.side);if(!state||!state.entries.some(e=>e.slot===value.slot))throw new Error(`PART_UNAVAILABLE: ${value.side} / ${value.slot}`);}
 select(value:ControlPart|null):void {this.validate(value);const next=value?{...value}:null,previous=this.selected;try{for(const [side,state]of this.sides)if(state.frame)state.player.renderer.render(selectedFrame(state.frame,next,side));}catch(error){for(const [side,state]of this.sides)if(state.frame)state.player.renderer.render(selectedFrame(state.frame,previous,side));throw error;}this.selected=next;}
 /** Called inside the successful draw boundary, before compare submission is measured complete. */
 present(side:ControlPart['side']):void {const state=this.sides.get(side);if(!state)return;const full=copyPartFrame(state.player.posedFrame(null));if(this.selected?.side===side&&this.selected.mode==='solo')state.player.renderer.render(selectedFrame(full,this.selected,side));state.frame=full;}
 bounds():PoseBounds|null {const part=this.selected,state=part?this.sides.get(part.side):null;return part&&state?.frame?partBounds(state.frame,part.slot):null;}
 frame(side:ControlPart['side']):PosedFrame|undefined {const state=this.sides.get(side);return state?.frame?selectedFrame(state.frame,this.selected,side):undefined;}
 observation():PartObservation|null {const part=this.selected;if(!part)return null;const state=this.sides.get(part.side),entry=state?.entries.find(e=>e.slot===part.slot);if(!state||!entry)return null;const geometry=state.frame?partGeometry(state.frame,part.slot):null;return {...part,drawn:!!geometry,kind:geometry?.kind??null,page:geometry?.page??null,region:geometry?.region??null,sequence:geometry?.sequence??null,vertices:geometry?.vertices??null,triangles:geometry?.triangles??null,z:geometry?.z??null,skin:state.player.skin??null,set:state.player.set,activeAttachment:partIdentity(entry,!!geometry,state.player.set),identityUnavailable:partIdentity(entry,!!geometry,state.player.set)?null:'PART_ATTACHMENT_IDENTITY_UNAVAILABLE: published frame does not identify an ambiguous, hidden or set-selected attachment',bounds:this.bounds(),declarations:entry.declarations.map(d=>({...d}))};}
 feedback():Record<string,Json>|null {const value=this.observation();return value?{...value,activeAttachment:value.activeAttachment?{...value.activeAttachment}:null,bounds:value.bounds?{...value.bounds}:null,declarations:value.declarations.map(item=>({...item}))}:null;}
}
export class PartExplorer extends PartInspection {
 private rows=new Map<string,HTMLButtonElement>();private rowEntries=new Map<HTMLButtonElement,PartEntry>();private detailKey='';private orderKey='';
 private detailNodes:{title:HTMLHeadingElement;info:HTMLParagraphElement;declarations:HTMLParagraphElement;bounds:HTMLParagraphElement;unavailable:HTMLParagraphElement;feedback:HTMLButtonElement;status:HTMLParagraphElement}|null=null;
 constructor(private host:HTMLElement,private detail:HTMLElement,private changed:(previous:ControlPart|null)=>void,private target:(part:ControlPart)=>void){
  super();
  this.search.addEventListener('input',()=>this.renderList());this.search.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();this.list.querySelector<HTMLButtonElement>('button')?.focus();}if(event.key==='Escape'){this.search.value='';this.renderList();}});
  this.list.addEventListener('keydown',event=>{const buttons=[...this.list.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='ArrowDown'?Math.min(index+1,buttons.length-1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?buttons.length-1:null;if(next!==null){event.preventDefault();buttons[next]?.focus();}if(event.key==='Escape')this.search.focus();});
  this.whole.onclick=()=>this.action(()=>this.select(null));this.solo.onchange=()=>this.action(()=>{if(this.selected)this.select({...this.selected,mode:this.solo.checked?'solo':'context'});});this.renderList();this.renderDetail();
 }
 private get search(){return this.host.querySelector<HTMLInputElement>('[data-part-search]')!;}private get list(){return this.host.querySelector<HTMLElement>('[data-part-list]')!;}private get solo(){return this.host.querySelector<HTMLInputElement>('[data-part-solo]')!;}private get whole(){return this.host.querySelector<HTMLButtonElement>('[data-part-whole]')!;}
 register(side:ControlPart['side'],entries:PartEntry[],player:PartPlayer){super.register(side,entries,player);this.renderList();}
 select(value:ControlPart|null):void {const previous=this.value();super.select(value);this.renderSelection();this.renderDetail();this.changed(previous);}
 present(side:ControlPart['side']):void {super.present(side);this.reorder();this.renderSelection();this.renderDetail();}
 private action(run:()=>void){try{run();}catch(error){this.renderSelection();this.host.querySelector<HTMLElement>('[data-part-status]')!.textContent=`Part selection refused: ${error instanceof Error?error.message:String(error)}`;}}
 private renderList(){this.rows.clear();this.rowEntries.clear();this.list.replaceChildren();const query=this.search.value.toLowerCase();for(const [side,state]of this.sides)for(const entry of orderedParts(state.entries,state.frame)){if(!entry.slot.toLowerCase().includes(query))continue;const row=document.createElement('button');row.type='button';row.dataset.side=side;row.dataset.slot=entry.slot;row.title=`${entry.slot} · bone ${entry.bone}`;row.textContent=`${entry.declarations.some(d=>d.kind==='mesh')?'◈':'◇'} ${side==='single'?'':side.toUpperCase()+' · '}${entry.slot}`;row.onclick=()=>this.action(()=>this.select({side,slot:entry.slot,mode:this.selected?.mode??'solo'}));const item=document.createElement('li');item.append(row);this.list.append(item);this.rows.set(JSON.stringify([side,entry.slot]),row);this.rowEntries.set(row,entry);}this.orderKey='';this.reorder();this.renderSelection();const status=this.host.querySelector<HTMLElement>('[data-part-status]')!;status.textContent=this.sides.size?`${[...this.sides.values()].reduce((n,s)=>n+s.entries.length,0)} declared slots · ${this.rows.size} results`:'No compiled rig catalog available';}
 private reorder(){const keys=[...this.sides].flatMap(([side,state])=>orderedParts(state.entries,state.frame).map(entry=>JSON.stringify([side,entry.slot]))).filter(key=>this.rows.has(key)),key=JSON.stringify(keys);if(key===this.orderKey)return;this.orderKey=key;const active=document.activeElement;for(const item of keys){const row=this.rows.get(item)!;this.list.append(row.parentElement!);}if(active instanceof HTMLElement&&this.list.contains(active)&&document.activeElement!==active)active.focus({preventScroll:true});}
 private renderSelection(){const drawnBySide=new Map([...this.sides].map(([side,state])=>[side,new Set(state.frame?.order.map(row=>row.slot)??[])]));this.whole.setAttribute('aria-pressed',String(!this.selected));this.solo.disabled=!this.selected;this.solo.checked=this.selected?.mode==='solo';for(const [key,row]of this.rows){row.setAttribute('aria-pressed',String(key===JSON.stringify([this.selected?.side,this.selected?.slot])));const state=this.sides.get(row.dataset.side as ControlPart['side']);const drawn=drawnBySide.get(row.dataset.side as ControlPart['side'])?.has(row.dataset.slot!);row.dataset.drawn=String(!!drawn);const entry=this.rowEntries.get(row),identity=entry?partIdentity(entry,!!drawn,state?.player.set??null):null;row.title=`${row.dataset.slot} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'}${identity?' · '+identity.skin+' / '+identity.attachment:' · attachment identity unavailable'}`;const label=`${entry?.declarations.some(d=>d.kind==='mesh')?'◈':'◇'} ${row.dataset.side==='single'?'':row.dataset.side!.toUpperCase()+' · '}${row.dataset.slot} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'} · ${identity?identity.skin+' / '+identity.attachment:(entry?.declarations.length??0)+' declared · attachment identity unavailable'}`;if(row.textContent!==label)row.textContent=label;row.setAttribute('aria-label',`${row.textContent} · ${state?.frame?drawn?'drawn':'not drawn':'awaiting draw'}`);}}
 private renderDetail(){
  const observation=this.observation(),key=JSON.stringify(observation);if(key===this.detailKey)return;this.detailKey=key;
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
  nodes.info.textContent=observation?`${observation.mode==='solo'?'Solo':'In context'} · ${observation.drawn?observation.kind==='mesh'?`${observation.vertices} posed vertices · ${observation.triangles} triangles`:'Region · four posed corners':'Not drawn at current pose'} · Skin: ${observation.skin??'not set'} · Set: ${observation.set??'not set'}`:'Select an actual slot in the right explorer. Selection preserves animation, time and physics history.';
  for(const node of [nodes.declarations,nodes.bounds,nodes.unavailable,nodes.feedback])node.hidden=!observation;nodes.feedback.disabled=!observation;
  nodes.declarations.textContent=observation?`${observation.activeAttachment?'Resolved unique declaration: '+observation.activeAttachment.skin+' / '+observation.activeAttachment.attachment+'.':observation.identityUnavailable+'.'} Declared: ${observation.declarations.map(d=>`${d.skin} / ${d.attachment} (${d.kind})`).join('; ')||'none'}. ${observation.page?'Drawn page: '+observation.page:''}${observation.region?' · region '+observation.region:''}${observation.sequence!==null?' · sequence '+observation.sequence:''}`:'';
  nodes.bounds.textContent=observation?observation.bounds?`Selection bounds · world units / Y up: x ${observation.bounds.x}, y ${observation.bounds.y}, width ${observation.bounds.width}, height ${observation.bounds.height}. Conservative geometry/clip bounds; fit uses the existing 0.25–8× camera range.`:'PART_FIT_UNAVAILABLE: no positive drawn bounds at the held pose.':'';
 }

}
