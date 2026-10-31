import {isTimeOnlyFeedback,hasStageComment,parseStageComment} from '../src/stage-comment.ts';
import {parseTurnSnapshot,type TurnSnapshot} from '../src/turn-pad.ts';
/** Versioned local drafts and public numeric view links. No capability or review decision is put in a URL. */
import {parseControlPart,parseControlView,type ControlPart,type ControlView} from '../src/control.ts';
import type {Json} from '../src/manifest.ts';
/** Feedback stores an inert JSON value, independently copied from the typed control observation. */
export function serializableView(view:ControlView):Record<string,Json> {
 const camera=(value:ControlView['cameras']['rig']):Record<string,Json>|null=>value===null?null:{space:value.space,center:{x:value.center.x,y:value.center.y},zoom:value.zoom,viewport:{width:value.viewport.width,height:value.viewport.height},visible:{x:value.visible.x,y:value.visible.y,width:value.visible.width,height:value.visible.height}};
 const value:Record<string,Json>={schema:view.schema,cameras:{rig:camera(view.cameras.rig),a:camera(view.cameras.a),b:camera(view.cameras.b),reference:camera(view.cameras.reference)}};
 if(view.cameraSync!==undefined)value.cameraSync=view.cameraSync;if(view.activeCamera!==undefined)value.activeCamera=view.activeCamera;return value;
}
export interface InspectionBinding {mode:'single'|'compare';sourceHash:string;rigs:(string|null)[]}
export interface InspectionSelection {turn?:TurnSnapshot;part?:ControlPart|null;workspace?:'modeling'|'motion';view?:'compare'|'reference'|'rig';checkpoint?:string|null;reference?:string|null;person?:string|null;inspector?:string;partSet?:string|null;axis?:{id:string;value:number}|null}
export interface InspectionBookmark {
 schema:'rig-review-inspection/1';binding:InspectionBinding;animation:string|null;time:number|null;
 theme:'system'|'dark'|'light';layers:{images:boolean;meshes:boolean;bones:boolean};view:ControlView;selection:InspectionSelection;
}
export interface InputValue {value:string;checked?:boolean}
export type FormInputs=Record<string,InputValue>;
export interface LocalInspectionDraft {schema:'rig-review-local-draft/1';sourceHash:string;baseline:string;savedAt:string;reviewDirty:boolean;bookmark:InspectionBookmark;inputs:FormInputs;session:unknown;ui:Record<string,string|number|null>}
export const maximumLinkBytes=16384,maximumDraftBytes=512*1024;
const record=(value:unknown,name:string):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${name}: expected object`);return value as Record<string,unknown>;};
const keys=(o:Record<string,unknown>,allowed:string[],name:string)=>{for(const key of Object.keys(o))if(!allowed.includes(key))throw new Error(`${name}.${key}: unknown field`);};
const text=(value:unknown,name:string,max=256):string=>{if(typeof value!=='string'||value.length>max||/[\x00-\x1f]/.test(value))throw new Error(`${name}: invalid text`);return value;};
const hash=(value:unknown):string=>{const s=text(value,'source hash',64);if(!/^[a-f0-9]{64}$/.test(s))throw new Error('View source hash: expected SHA-256');return s;};
export function sameBinding(a:InspectionBinding,b:InspectionBinding):boolean{return a.mode===b.mode&&a.sourceHash===b.sourceHash&&JSON.stringify(a.rigs)===JSON.stringify(b.rigs);}
export function parseBookmark(value:unknown,expected?:InspectionBinding):InspectionBookmark {
 const o=record(value,'inspection');keys(o,['schema','binding','animation','time','theme','layers','view','selection'],'inspection');
 if(o.schema!=='rig-review-inspection/1')throw new Error('View link version unsupported');
 const b=record(o.binding,'inspection.binding');keys(b,['mode','sourceHash','rigs'],'binding');if(b.mode!=='single'&&b.mode!=='compare')throw new Error('View mode unavailable');
 if(!Array.isArray(b.rigs)||b.rigs.length!==(b.mode==='single'?1:2))throw new Error('View rig binding invalid');
 const binding:InspectionBinding={mode:b.mode,sourceHash:hash(b.sourceHash),rigs:b.rigs.map(v=>v===null?null:hash(v))};
 if(expected&&!sameBinding(binding,expected))throw new Error('VIEW_SOURCE_CHANGED: view belongs to different reviewed inputs');
 const animation=o.animation===null?null:text(o.animation,'animation');if(animation==='')throw new Error('View animation must be named or null');
 if(o.time!==null&&(typeof o.time!=='number'||!Number.isFinite(o.time)||o.time<0||o.time>Number.MAX_SAFE_INTEGER))throw new Error('View time requires finite nonnegative seconds');
 if(!['system','dark','light'].includes(String(o.theme)))throw new Error('View appearance invalid');
 const layers=record(o.layers,'layers');keys(layers,['images','meshes','bones'],'layers');for(const k of ['images','meshes','bones'])if(typeof layers[k]!=='boolean')throw new Error('View layers must be boolean');
 const selection=record(o.selection,'selection');keys(selection,['workspace','view','checkpoint','reference','person','inspector','partSet','axis','part','turn'],'selection');
 if(selection.workspace!==undefined&&!['modeling','motion'].includes(String(selection.workspace)))throw new Error('View workspace invalid');
 if(selection.view!==undefined&&!['compare','reference','rig'].includes(String(selection.view)))throw new Error('View selection invalid');
 for(const k of ['checkpoint','reference','person','inspector','partSet'])if(selection[k]!==undefined&&selection[k]!==null)text(selection[k],k);
 if(selection.axis!==undefined&&selection.axis!==null){const axis=record(selection.axis,'axis');keys(axis,['id','value'],'axis');text(axis.id,'axis id');if(typeof axis.value!=='number'||!Number.isFinite(axis.value))throw new Error('View axis value invalid');}
 if(selection.inspector!==undefined&&!['view','rig','playback','feedback'].includes(String(selection.inspector)))throw new Error('Inspector selection invalid');
 if(selection.part!==undefined){const part=parseControlPart(selection.part);if(part&&(binding.mode==='single'?part.side!=='single':part.side==='single'))throw new Error('View part side unavailable in this review mode');selection.part=part;}
 if(selection.turn!==undefined)selection.turn=parseTurnSnapshot(selection.turn);
 const view=parseControlView(o.view);
 if(view.activeCamera&&(binding.mode==='single'&&(view.activeCamera==='a'||view.activeCamera==='b')||binding.mode==='compare'&&view.activeCamera==='rig'))throw new Error('View active camera is unavailable in this review mode');
 return {schema:o.schema,binding,animation,time:o.time as number|null,theme:o.theme as InspectionBookmark['theme'],layers:{images:layers.images as boolean,meshes:layers.meshes as boolean,bones:layers.bones as boolean},view,selection:{...selection} as InspectionSelection};
}
export function encodeBookmark(value:InspectionBookmark):string {
 const parsed=parseBookmark(value),bytes=new TextEncoder().encode(JSON.stringify(parsed));
 let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
 const fragment='#review='+btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 if(fragment.length>maximumLinkBytes)throw new Error('View link exceeds 16 KiB');return fragment;
}
export function decodeBookmark(fragment:string,expected:InspectionBinding):InspectionBookmark|null {
 if(!fragment.startsWith('#review='))return null;if(fragment.length>maximumLinkBytes)throw new Error('View link exceeds 16 KiB');
 const encoded=fragment.slice(8);if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error('View link encoding invalid');
 const binary=atob(encoded.replaceAll('-','+').replaceAll('_','/'));const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 return parseBookmark(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),expected);
}
/** Preserve only public fixed-instance landing digests, never arbitrary query capabilities. */
export function inspectionLink(current:string,bookmark:InspectionBookmark):URL {
 const source=new URL(current),url=new URL(source.pathname,source.origin);
 for(const name of ['input','handoff']){const values=source.searchParams.getAll(name);if(values.length>1||values.length===1&&!/^[a-f0-9]{64}$/.test(values[0]!))throw new Error('View landing binding invalid: '+name);if(values.length)url.searchParams.set(name,values[0]!);}
 url.hash=encodeBookmark(bookmark);return url;
}
/** Preparation is nonmutating; runtime failures restore the previously inspected state. */
export async function restoreTransaction<T>(prepare:()=>Promise<void>,capture:()=>T,apply:()=>Promise<void>,rollback:(previous:T)=>Promise<void>):Promise<void> {
 await prepare();const previous=capture();
 try{await apply();}catch(error){try{await rollback(previous);}catch(recovery){throw new Error(`Inspection restore failed (${error instanceof Error?error.message:String(error)}); previous inspection recovery failed (${recovery instanceof Error?recovery.message:String(recovery)})`);}throw error;}
}
/** CSS camera rectangles are measured in source units; world y is up, image y is down. */
export function numericCamera(space:'world'|'image',center:{x:number;y:number},zoom:number,scale:number,width:number,height:number) {
 if(![center.x,center.y,zoom,scale,width,height].every(Number.isFinite)||scale<=0||width<=0||height<=0)return null;
 return {space,center:{...center},zoom,viewport:{width,height},visible:{x:center.x-width/(2*scale),y:center.y-height/(2*scale),width:width/scale,height:height/scale}};
}
/** Restore saved source-region coverage under a different viewport aspect, without pixel-pan guesses. */
export function restoredZoom(camera:NonNullable<ControlView['cameras']['rig']>,baseScale:number,width:number,height:number):number {
 // Reuse the captured value when the same pane/fit reproduces its exact region.
 // Inverting visible extent can otherwise lose one ULP on each bookmark jump.
 if(camera.viewport.width===width&&camera.viewport.height===height&&camera.zoom>=.25&&camera.zoom<=8){const current=numericCamera(camera.space,camera.center,camera.zoom,baseScale*camera.zoom,width,height);if(current&&JSON.stringify(current.visible)===JSON.stringify(camera.visible))return camera.zoom;}
 const scale=Math.min(width/camera.visible.width,height/camera.visible.height),zoom=scale/baseScale;
 if(!Number.isFinite(zoom)||zoom<.25||zoom>8)throw new Error('VIEW_CAMERA_RANGE: saved region cannot fit within zoom 0.25..8');return zoom;
}
export function captureInputs(root:ParentNode=document):FormInputs {
 const result:FormInputs={};for(const node of root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')){
  const key=node.id||(node instanceof HTMLInputElement&&node.type==='radio'&&node.name?`radio:${node.name}:${node.value}`:'');
  // Browser-wide Settings are not inspection state and never enter a source draft.
  if(!key||node.hasAttribute('data-app-preference')||node instanceof HTMLInputElement&&['password','file'].includes(node.type))continue;
  result[key]={value:node.value,...(node instanceof HTMLInputElement&&['checkbox','radio'].includes(node.type)?{checked:node.checked}:{})};
 }return result;
}
export function restoreInputs(inputs:FormInputs,excluded:ReadonlySet<string>=new Set(),root:ParentNode=document):void {
 for(const [key,value]of Object.entries(inputs)){
  if(excluded.has(key))continue;
  const node=key.startsWith('radio:')?[...root.querySelectorAll<HTMLInputElement>('input[type=radio]')].find(n=>`radio:${n.name}:${n.value}`===key):root.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('#'+CSS.escape(key));
  if(!node||node.hasAttribute('data-app-preference'))continue;if(node instanceof HTMLSelectElement&&![...node.options].some(o=>o.value===value.value))continue;
  if(node instanceof HTMLInputElement&&['password','file'].includes(node.type))continue;
  node.value=value.value;if(node instanceof HTMLInputElement&&value.checked!==undefined)node.checked=value.checked;
 }
}
function parseInputs(value:unknown):FormInputs {
 const o=record(value,'draft inputs'),entries=Object.entries(o);if(entries.length>256)throw new Error('Draft input count exceeds 256');const result:FormInputs={};
 for(const [k,v]of entries){text(k,'input id');if(['__proto__','constructor','prototype'].includes(k))throw new Error('Draft input key invalid');const input=record(v,'input');keys(input,['value','checked'],'input');if(typeof input.value!=='string'||input.value.length>32768||input.checked!==undefined&&typeof input.checked!=='boolean')throw new Error('Draft input invalid');result[k]={value:input.value,...(input.checked===undefined?{}:{checked:input.checked as boolean})};}return result;
}
export async function sessionFingerprint(value:unknown):Promise<string> {const bytes=new TextEncoder().encode(JSON.stringify(value));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function recoverSession<T extends {id:string;revision:string;sourceHash:string;status:string;feedback:unknown[]}>(value:unknown,baseline:T):T|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const o=value as Record<string,unknown>;for(const key of Object.keys(o))if(!Object.keys(baseline).includes(key))return null;
 for(const k of ['id','revision','sourceHash','reviewedSource','referenceBinding','binding'])if(JSON.stringify(o[k])!==JSON.stringify((baseline as Record<string,unknown>)[k]))return null;
 if(!['pending','approved','changes-requested'].includes(String(o.status))||!Array.isArray(o.feedback)||!Array.isArray(o.feedbackWarnings))return null;
 for(const item of o.feedback){if(!item||typeof item!=='object')return null;const f=item as Record<string,unknown>,target=f.target as Record<string,unknown>|undefined;const comment=(f.context as any)?.comment;if(hasStageComment(comment)){try{parseStageComment(comment);}catch{return null;}}if(hasStageComment(comment)&&(comment.frame===null||comment.timeBasis!==undefined)&&!isTimeOnlyFeedback(f))return null;if(typeof f.id!=='string'||typeof f.summary!=='string'||(!Number.isInteger(f.frameStart)||!Number.isInteger(f.frameEnd))&&!isTimeOnlyFeedback(f)||!target||!['bone','slot','rig'].includes(String(target.kind))||typeof target.name!=='string'||!['defect','quality'].includes(String(f.category)))return null;}
 if('checkpoints'in baseline){if(!o.checkpoints||typeof o.checkpoints!=='object'||Array.isArray(o.checkpoints))return null;for(const value of Object.values(o.checkpoints)){if(!value||typeof value!=='object'||Array.isArray(value))return null;const item=value as Record<string,unknown>;if(!['pending','pass','fail'].includes(String(item.outcome))||typeof item.note!=='string'||item.note.length>32768)return null;}}
 return o as T;
}
/** Drafts kept per origin before least-recently-written eviction; recent drafts are never evicted. */
export const maximumDrafts=32,protectedDraftMs=24*60*60*1000;
const draftPrefix='rig-review-draft/1:',draftIndex='rig-review-draft-index/1';
/** Storage is confined to this app; the scope carries the source identity (`single:<id>:<sourceHash>`), so
 * revisions of one package opened on one origin keep separate drafts. Opening deletes nothing; writing evicts
 * the least-recently-written drafts beyond 32, except any written within the last 24 hours. */
export class InspectionDraftStore {
 private storage:Storage|null=null;
 private blocked=false;
 private rawRecovery:string|null=null;
 recovery():string|null{return this.rawRecovery;}
 readonly key:string;
 constructor(private readonly scope:string,private readonly binding:InspectionBinding,private readonly warn:(message:string)=>void,storage?:Storage,private readonly now:()=>number=Date.now){
  this.key=`${draftPrefix}${scope}:${binding.sourceHash}`;
  try{this.storage=storage??localStorage;this.storage.getItem(draftIndex);}catch{this.storage=null;warn('Local draft storage unavailable. Keep this page open or export feedback before leaving.');}
 }
 /** Written-at times by key; a draft missing from the index falls back to its own savedAt. */
 private written():Map<string,number>{
  const storage=this.storage!,times=new Map<string,number>();let index:Record<string,unknown>={};try{const raw=storage.getItem(draftIndex);const parsed=raw?JSON.parse(raw):{};if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))index=parsed;}catch{}
  for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(draftPrefix))continue;let time=Number(index[key]);if(!Number.isFinite(time)){try{time=Date.parse(JSON.parse(storage.getItem(key)??'').savedAt);}catch{time=NaN;}}times.set(key,Number.isFinite(time)?time:0);}
  return times;
 }
 private evict():void{
  const storage=this.storage!,now=this.now(),times=this.written();times.set(this.key,now);
  const old=[...times].filter(([key,time])=>key!==this.key&&now-time>protectedDraftMs).sort((a,b)=>a[1]-b[1]);
  for(const [key]of old){if(times.size<=maximumDrafts)break;storage.removeItem(key);times.delete(key);}
  storage.setItem(draftIndex,JSON.stringify(Object.fromEntries(times)));
 }
 read():LocalInspectionDraft|null {
  if(!this.storage)return null;try{const raw=this.storage.getItem(this.key);if(!raw)return null;this.rawRecovery=raw;if(new TextEncoder().encode(raw).length>maximumDraftBytes)throw new Error('Draft exceeds 512 KiB');const o=record(JSON.parse(raw),'draft');keys(o,['schema','sourceHash','baseline','savedAt','reviewDirty','bookmark','inputs','session','ui'],'draft');if(o.schema!=='rig-review-local-draft/1'||o.sourceHash!==this.binding.sourceHash)throw new Error('Draft binding/version differs');if(typeof o.reviewDirty!=='boolean')throw new Error('Draft review state invalid');const bookmark=parseBookmark(o.bookmark,this.binding),baseline=hash(o.baseline);if(typeof o.savedAt!=='string'||!Number.isFinite(Date.parse(o.savedAt)))throw new Error('Draft timestamp invalid');const ui=record(o.ui,'draft UI');for(const [k,v]of Object.entries(ui)){text(k,'draft UI key');if(v!==null&&typeof v!=='string'&&typeof v!=='number'||typeof v==='number'&&!Number.isFinite(v))throw new Error('Draft UI value invalid');}return {schema:o.schema,sourceHash:this.binding.sourceHash,baseline,savedAt:o.savedAt,reviewDirty:o.reviewDirty,bookmark,inputs:parseInputs(o.inputs),session:o.session,ui:ui as LocalInspectionDraft['ui']};}catch(error){this.blocked=true;this.warn(`Saved local draft was not restored: ${error instanceof Error?error.message:String(error)}. It remains in storage for recovery.`);return null;}
 }
 write(draft:LocalInspectionDraft):boolean {
  if(!this.storage||this.blocked)return false;try{const value=JSON.stringify(draft);if(new TextEncoder().encode(value).length>maximumDraftBytes)throw new Error('Draft exceeds 512 KiB');this.storage.setItem(this.key,value);try{this.evict();}catch{}return true;}catch(error){this.warn(`Local draft could not be saved: ${error instanceof Error?error.message:String(error)}. Export feedback before leaving.`);return false;}
 }
 clear():void {try{this.storage?.removeItem(this.key);this.blocked=false;this.rawRecovery=null;}catch{this.warn('Local draft could not be cleared.');}}
}

interface PersistenceSession {id:string;revision:string;sourceHash:string;status:string;feedback:unknown[]}
interface PersistenceAdapter<T extends PersistenceSession> {
 scope:string;binding:InspectionBinding;baseline:T;session:()=>T;reviewDirty:()=>boolean;
 restoreSession:(value:T,dirty:boolean)=>void;bookmark:()=>InspectionBookmark;
 restoreBookmark:(bookmark:InspectionBookmark,signal:AbortSignal)=>Promise<void>;
 ui:()=>Record<string,string|number|null>;restoreUI:(ui:Record<string,string|number|null>)=>void;
 afterInputs:()=>void;onConflict:(conflict:boolean)=>void;onStatus:(message:string)=>void;
}
export interface PersistenceConnection {restored:boolean;restoring:()=>boolean;save:()=>void;submitted:(session:unknown)=>Promise<void>;dispose:()=>void}
const viewInputIds=new Set(['part-search','part-solo','camera-sync','appearance','layer-images','layer-mesh','layer-bones','animation-select','reference-select','person-select','axis-select','axis-value','scrub','frame-number','frame-scrub','time-input','frame-input','part-set']);
/** Restore once after normal startup; snapshots never perform a server mutation. */
export async function connectInspectionPersistence<T extends PersistenceSession>(adapter:PersistenceAdapter<T>):Promise<PersistenceConnection> {
 let restoring=true,closed=false,conflict=false,timer:ReturnType<typeof setTimeout>|undefined;
 let navigationGeneration=0,navigationAbort:AbortController|null=null,navigationQueue=Promise.resolve(),lastNavigationHash=location.hash;
 let previousInert:boolean|null=null;
 const holdRestore=(value:boolean)=>{restoring=value;const body=document.body;if(value){if(body&&previousInert===null){previousInert=body.inert;body.inert=true;}}else if(body&&previousInert!==null){body.inert=previousInert;previousInert=null;}};
 let baseline=await sessionFingerprint(adapter.baseline);const status=adapter.onStatus,initialInputs=captureInputs();
 const store=new InspectionDraftStore(adapter.scope,adapter.binding,status),draft=store.read();
 const notice=document.getElementById('draft-recovery');if(notice)notice.replaceChildren();
 const download=(raw:string)=>{const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='review-local-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const raw=store.recovery();
 if(raw&&notice){const button=document.createElement('button');button.type='button';button.textContent='Download saved local draft';button.onclick=()=>download(raw);notice.append(button);}
 let explicit:InspectionBookmark|null=null;
 try{explicit=decodeBookmark(location.hash,adapter.binding);}catch(error){status(error instanceof Error?error.message:String(error));}
 if(draft){
  const recovered=recoverSession(draft.session,adapter.baseline);conflict=draft.baseline!==baseline||!recovered;
  if(!conflict&&recovered&&draft.reviewDirty){try{adapter.restoreSession(recovered,true);status('Restored local draft · not submitted');}catch(error){conflict=true;adapter.onConflict(true);status(`Local draft needs explicit recovery: ${error instanceof Error?error.message:String(error)}`);}}
  else if(conflict){status('Saved local draft conflicts with the current submitted review. Server status is unchanged; download it or explicitly recover as pending.');adapter.onConflict(true);
   if(recovered&&notice){const button=document.createElement('button');button.type='button';button.textContent='Recover local draft as pending';button.onclick=()=>{try{adapter.restoreSession({...recovered,status:'pending'},true);conflict=false;adapter.onConflict(false);status('Recovered local draft as pending · not submitted');save();}catch(error){status(`Local draft recovery refused: ${error instanceof Error?error.message:String(error)}`);}};notice.append(button);}
  }
  try{adapter.restoreUI(draft.ui);}catch(error){status(`Saved panel selection unavailable: ${error instanceof Error?error.message:String(error)}`);}
 }
 if(conflict&&notice){const discard=document.createElement('button');discard.type='button';discard.textContent='Discard conflicting local draft';discard.onclick=()=>{adapter.restoreSession(structuredClone(adapter.baseline),false);restoreInputs(initialInputs,viewInputIds);adapter.afterInputs();store.clear();conflict=false;adapter.onConflict(false);notice.replaceChildren();status('Local draft discarded · current submitted review retained.');save();};notice.append(discard);}
 const selected=location.hash.startsWith('#review=')?explicit:draft?.bookmark;
 let restored=location.hash.startsWith('#review=')||!!draft;
 if(selected){try{await adapter.restoreBookmark(selected,new AbortController().signal);restored=true;}catch(error){status(`Inspection was not restored: ${error instanceof Error?error.message:String(error)}`);}}
 if(draft){
  const excluded=new Set(viewInputIds);if(conflict){excluded.add('review-status');excluded.add('status');for(const key of Object.keys(draft.inputs))if(key.startsWith('radio:outcome:'))excluded.add(key);}
  restoreInputs(draft.inputs,excluded);adapter.afterInputs();
 }
 if(raw&&!draft&&notice){const button=document.createElement('button');button.type='button';button.textContent='Discard unusable local draft';button.onclick=()=>{store.clear();notice.replaceChildren();status('Unusable local draft discarded for this review only.');save();};notice.append(button);}
 restoring=false;
 function save():void {
  if(closed||restoring||conflict)return;
  try{const bookmark=parseBookmark(adapter.bookmark(),adapter.binding);const value:LocalInspectionDraft={schema:'rig-review-local-draft/1',sourceHash:adapter.binding.sourceHash,baseline,savedAt:new Date().toISOString(),reviewDirty:adapter.reviewDirty(),bookmark,inputs:captureInputs(),session:adapter.session(),ui:adapter.ui()};
   if(store.write(value)){const url=new URL(location.href);url.hash=encodeBookmark(bookmark);history.replaceState(null,'',url);lastNavigationHash=url.hash;}
  }catch(error){status(`Local view was not saved: ${error instanceof Error?error.message:String(error)}`);}
 }
 function navigateView():void {
  if(closed||location.hash===lastNavigationHash)return;
  lastNavigationHash=location.hash;const generation=++navigationGeneration;
  navigationAbort?.abort();navigationAbort=null;if(timer)clearTimeout(timer);
  let bookmark:InspectionBookmark|null=null;
  try{bookmark=decodeBookmark(location.hash,adapter.binding);}catch(error){status(`View link refused: ${error instanceof Error?error.message:String(error)}`);}
  // A cleared or invalid fragment cancels pending restoration, but never
  // applies a local draft or changes the submitted review/session.
  if(!bookmark){void navigationQueue.finally(()=>{if(!closed&&generation===navigationGeneration)holdRestore(false);});return;}
  const requested=bookmark,controller=new AbortController();navigationAbort=controller;
  holdRestore(true);status('Restoring source-bound view · inspection controls temporarily paused.');
  navigationQueue=navigationQueue.then(async()=>{
   if(closed||generation!==navigationGeneration||controller.signal.aborted)return;
   try{await adapter.restoreBookmark(requested,controller.signal);if(!closed&&generation===navigationGeneration&&!controller.signal.aborted)status(adapter.reviewDirty()?'View link restored · paused inspection; local draft not submitted.':'View link restored · paused inspection; submitted review unchanged.');}
   catch(error){if(!closed&&generation===navigationGeneration&&!controller.signal.aborted)status(`View link was not restored: ${error instanceof Error?error.message:String(error)}`);}
   finally{if(!closed&&generation===navigationGeneration){navigationAbort=null;holdRestore(false);save();}}
  });
 }
 window.addEventListener('hashchange',navigateView);window.addEventListener('popstate',navigateView);
 function schedule():void {if(timer)clearTimeout(timer);timer=setTimeout(save,120);}
 const events=['input','change','click','pointerup','wheel'] as const;for(const event of events)window.addEventListener(event,schedule,{passive:true});
 const interval=setInterval(()=>{if(!document.hidden)save();},1000);
 const copy=document.getElementById('copy-view');const copyView=async()=>{if(closed)return;try{const url=inspectionLink(location.href,adapter.bookmark());await navigator.clipboard.writeText(url.href);history.replaceState(null,'',url);lastNavigationHash=url.hash;status('View link copied · source-bound numeric region, no review decisions.');}catch(error){status(`View link was not copied: ${error instanceof Error?error.message:String(error)}`);}};if(copy)copy.onclick=copyView;
 return {restored,restoring:()=>restoring,save,submitted:async session=>{baseline=await sessionFingerprint(session);save();},dispose:()=>{save();closed=true;++navigationGeneration;navigationAbort?.abort();holdRestore(false);window.removeEventListener('hashchange',navigateView);window.removeEventListener('popstate',navigateView);if(copy?.onclick===copyView)copy.onclick=null;if(timer)clearTimeout(timer);clearInterval(interval);for(const event of events)window.removeEventListener(event,schedule);}};
}
