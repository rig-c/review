/** Browser-owned app defaults. Source inspection, review data and capabilities never belong here. */
export const workspacePreferenceKey='rig-review-preferences/1';
export const legacyAppearanceKey='rig-review-appearance/1';
export type WorkspaceTheme='system'|'dark'|'light';
export interface WorkspacePanels {leftWidth:number;rightWidth:number;inspectorHeight:number}
export const panelBounds=Object.freeze({leftWidth:Object.freeze({min:120,max:720}),rightWidth:Object.freeze({min:180,max:900}),inspectorHeight:Object.freeze({min:160,max:900})});
export const defaultWorkspacePanels:Readonly<WorkspacePanels>=Object.freeze({leftWidth:170,rightWidth:260,inspectorHeight:280});
type Field='theme'|'defaultCameraSync'|'defaultIdleRepeat'|keyof WorkspacePanels;
const fields:readonly Field[]=['theme','defaultCameraSync','defaultIdleRepeat','leftWidth','rightWidth','inspectorHeight'];
interface FieldStamp {revision:number;writer:string}
export interface WorkspacePreferences {schema:'rig-review-preferences/1';revision:number;theme:WorkspaceTheme;defaultCameraSync:boolean;defaultIdleRepeat:boolean;panels:WorkspacePanels;stamps:Record<Field,FieldStamp>}
export interface WorkspacePreferencePatch {theme?:WorkspaceTheme;defaultCameraSync?:boolean;defaultIdleRepeat?:boolean;panels?:Partial<WorkspacePanels>}
export interface PreferenceStorage {getItem(key:string):string|null;setItem(key:string,value:string):void}
export interface PreferenceStatus {state:'available'|'memory-only'|'corrupt';detail:string}
export interface PreferenceEventSource {addEventListener(type:string,listener:EventListener):void;removeEventListener(type:string,listener:EventListener):void}
export interface WorkspacePreferenceOptions {storage?:PreferenceStorage|null;events?:PreferenceEventSource|null;writer?:string;onStatus?:(status:PreferenceStatus)=>void}
const object=(v:unknown,label:string):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(`${label}: expected object`);return v as Record<string,unknown>;};
const closed=(v:Record<string,unknown>,allowed:readonly string[],label:string)=>{for(const key of Object.keys(v))if(!allowed.includes(key))throw new Error(`${label}.${key}: unknown field`);};
const theme=(v:unknown):WorkspaceTheme=>{if(v!=='system'&&v!=='dark'&&v!=='light')throw new Error('PREFERENCES_THEME: expected system, dark or light');return v;};
const boolean=(v:unknown,label:string):boolean=>{if(typeof v!=='boolean')throw new Error(`${label}: expected boolean`);return v;};
const panel=(v:unknown,key:keyof WorkspacePanels):number=>{const {min,max}=panelBounds[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(`PREFERENCES_PANEL: ${key} requires finite ${min}..${max} CSS pixels`);return v;};
export function parseWorkspacePanels(value:unknown):WorkspacePanels {const o=object(value,'panels');closed(o,Object.keys(panelBounds),'panels');return {leftWidth:panel(o.leftWidth,'leftWidth'),rightWidth:panel(o.rightWidth,'rightWidth'),inspectorHeight:panel(o.inspectorHeight,'inspectorHeight')};}
export function defaultWorkspacePreferences():WorkspacePreferences {return {schema:workspacePreferenceKey,revision:0,theme:'system',defaultCameraSync:true,defaultIdleRepeat:true,panels:{...defaultWorkspacePanels},stamps:Object.fromEntries(fields.map(field=>[field,{revision:0,writer:''}])) as Record<Field,FieldStamp>};}
const clone=(v:WorkspacePreferences):WorkspacePreferences=>({...v,panels:{...v.panels},stamps:Object.fromEntries(fields.map(field=>[field,{...v.stamps[field]}])) as Record<Field,FieldStamp>});
function leaf(value:WorkspacePreferences,field:Field):WorkspaceTheme|boolean|number {return field in panelBounds?value.panels[field as keyof WorkspacePanels]:value[field as 'theme'|'defaultCameraSync'|'defaultIdleRepeat'];}
function put(value:WorkspacePreferences,field:Field,v:WorkspaceTheme|boolean|number):void {if(field==='theme')value.theme=theme(v);else if(field==='defaultCameraSync'||field==='defaultIdleRepeat')value[field]=boolean(v,field);else value.panels[field]=panel(v,field);}
export function parseWorkspacePreferences(value:unknown):WorkspacePreferences {
 const o=object(value,'preferences');closed(o,['schema','revision','theme','defaultCameraSync','defaultIdleRepeat','panels','stamps'],'preferences');if(o.schema!==workspacePreferenceKey)throw new Error('PREFERENCES_VERSION: unsupported schema');
 const result=defaultWorkspacePreferences();result.theme=theme(o.theme);result.defaultCameraSync=boolean(o.defaultCameraSync,'defaultCameraSync');result.defaultIdleRepeat=boolean(o.defaultIdleRepeat,'defaultIdleRepeat');result.panels=parseWorkspacePanels(o.panels);
 const stamps=object(o.stamps,'stamps');closed(stamps,fields,'stamps');
 for(const field of fields){const stamp=object(stamps[field],`stamps.${field}`);closed(stamp,['revision','writer'],`stamps.${field}`);if(typeof stamp.revision!=='number'||!Number.isSafeInteger(stamp.revision)||stamp.revision<0||typeof stamp.writer!=='string'||!(/^[A-Za-z0-9_-]{1,80}$/.test(stamp.writer)||stamp.revision===0&&stamp.writer===''))throw new Error(`PREFERENCES_STAMP: invalid ${field} revision/writer`);if(stamp.revision===0&&(stamp.writer!==''||leaf(result,field)!==leaf(defaultWorkspacePreferences(),field)))throw new Error(`PREFERENCES_STAMP: unstamped ${field} differs from defaults`);result.stamps[field]={revision:stamp.revision,writer:stamp.writer};}
 const revision=Math.max(...fields.map(field=>result.stamps[field].revision));if(o.revision!==revision)throw new Error('PREFERENCES_REVISION: record revision must equal maximum field revision');result.revision=revision;return result;
}
function parseText(raw:string):WorkspacePreferences {if(raw.length>8192)throw new Error('PREFERENCES_SIZE: record exceeds 8192 characters');return parseWorkspacePreferences(JSON.parse(raw));}
function patches(value:unknown):Map<Field,WorkspaceTheme|boolean|number> {
 const o=object(value,'preference patch');closed(o,['theme','defaultCameraSync','defaultIdleRepeat','panels'],'preference patch');const patch=new Map<Field,WorkspaceTheme|boolean|number>();
 if('theme'in o)patch.set('theme',theme(o.theme));for(const field of ['defaultCameraSync','defaultIdleRepeat'] as const)if(field in o)patch.set(field,boolean(o[field],field));
 if('panels'in o){const p=object(o.panels,'panel patch');closed(p,Object.keys(panelBounds),'panel patch');for(const key of Object.keys(p) as (keyof WorkspacePanels)[])patch.set(key,panel(p[key],key));}return patch;
}
/** Per-field Lamport stamps converge even when independent tabs wrote stale whole records.
 * Equal-field concurrent writes use revision then writer ordering, never wall-clock time. */
export function mergeWorkspacePreferences(...records:WorkspacePreferences[]):WorkspacePreferences {
 const result=defaultWorkspacePreferences();
 for(const raw of records){const value=parseWorkspacePreferences(raw);for(const field of fields){const a=result.stamps[field],b=value.stamps[field],order=b.revision-a.revision|| (b.writer<a.writer?-1:b.writer>a.writer?1:0);if(order>0){put(result,field,leaf(value,field));result.stamps[field]={...b};}else if(order===0&&leaf(result,field)!==leaf(value,field))throw new Error(`PREFERENCES_STAMP_CONFLICT: ${field} has two values at one stamp`);}}
 result.revision=Math.max(...fields.map(field=>result.stamps[field].revision));return result;
}
let fallbackWriter=0;
export class WorkspacePreferenceStore {
 private value=defaultWorkspacePreferences();private persistence:PreferenceStatus={state:'available',detail:'Browser preferences use defaults.'};private readonly storage:PreferenceStorage|null;private readonly events:PreferenceEventSource|null;private readonly writer:string;private listeners=new Set<(value:WorkspacePreferences)=>void>();private closed=false;
 constructor(private readonly options:WorkspacePreferenceOptions={}){
  this.writer=options.writer??(globalThis.crypto?.randomUUID?.()??`local-${Date.now().toString(36)}-${++fallbackWriter}`);if(!/^[A-Za-z0-9_-]{1,80}$/.test(this.writer))throw new Error('PREFERENCES_WRITER: invalid tab writer');
  let storage=options.storage??null;if(options.storage===undefined){try{storage=globalThis.localStorage;}catch{this.statusTo('memory-only','Browser storage access was denied; preferences remain usable in this page.');}}this.storage=storage;this.events=options.events===undefined?(typeof window==='undefined'?null:window):options.events;
  const loaded=this.read();if(loaded.kind==='valid'){this.value=loaded.value;this.statusTo('available','Saved browser preferences loaded.');}else if(loaded.kind==='absent')this.migrateAppearance();this.events?.addEventListener('storage',this.storageEvent);
 }
 get():WorkspacePreferences{return clone(this.value);}
 status():PreferenceStatus{return {...this.persistence};}
 subscribe(listener:(value:WorkspacePreferences)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
 update(patch:WorkspacePreferencePatch):WorkspacePreferences {
  if(this.closed)throw new Error('PREFERENCES_DISPOSED');const changes=patches(patch);if(!changes.size)return this.get();const loaded=this.read();let next=loaded.kind==='valid'?mergeWorkspacePreferences(this.value,loaded.value):clone(this.value);
  if(next.revision===Number.MAX_SAFE_INTEGER)throw new Error('PREFERENCES_REVISION_EXHAUSTED');const revision=next.revision+1;for(const [field,v]of changes){put(next,field,v);next.stamps[field]={revision,writer:this.writer};}next.revision=revision;this.value=next;this.persist();this.notify();return this.get();
 }
 resetLayout():WorkspacePreferences{return this.update({panels:{...defaultWorkspacePanels}});}
 /** Reconcile after resuming a suspended tab as well as on storage events. */
 refresh():WorkspacePreferences {if(this.closed)return this.get();const loaded=this.read();if(loaded.kind==='valid'){this.value=mergeWorkspacePreferences(this.value,loaded.value);this.persist();this.notify();}return this.get();}
 dispose():void {if(this.closed)return;this.closed=true;this.events?.removeEventListener('storage',this.storageEvent);this.listeners.clear();}
 private statusTo(state:PreferenceStatus['state'],detail:string){this.persistence={state,detail};this.options.onStatus?.(this.status());}
 private read():{kind:'valid';value:WorkspacePreferences}|{kind:'absent'|'denied'|'corrupt'} {
  if(!this.storage){this.statusTo('memory-only','Browser storage is unavailable; preferences remain usable in this page.');return {kind:'denied'};}
  let raw:string|null;try{raw=this.storage.getItem(workspacePreferenceKey);}catch{this.statusTo('memory-only','Browser storage read was denied; preferences remain usable in this page.');return {kind:'denied'};}
  if(raw===null)return {kind:'absent'};try{return {kind:'valid',value:parseText(raw)};}catch(error){this.statusTo('corrupt',`Saved browser preferences were refused: ${error instanceof Error?error.message:String(error)}. Current page defaults remain usable.`);return {kind:'corrupt'};}
 }
 private persist():void {
  if(!this.storage)return;const latest=this.read();if(latest.kind==='valid')this.value=mergeWorkspacePreferences(this.value,latest.value);
  const text=JSON.stringify(this.value);if(latest.kind==='valid'&&JSON.stringify(latest.value)===text){this.statusTo('available','Browser preferences are current.');return;}
  try{this.storage.setItem(workspacePreferenceKey,text);this.statusTo('available','Browser preferences saved.');}catch{this.statusTo('memory-only','Browser storage write was denied; changed preferences remain usable in this page.');}
 }
 private migrateAppearance():void {
  if(!this.storage)return;let raw:string|null;try{raw=this.storage.getItem(legacyAppearanceKey);}catch{this.statusTo('memory-only','Legacy appearance storage read was denied; defaults remain usable.');return;}if(raw===null)return;
  if(raw!=='system'&&raw!=='dark'&&raw!=='light'){this.statusTo('corrupt','Legacy appearance value was refused; defaults remain usable.');return;}
  this.value.theme=raw;this.value.stamps.theme={revision:1,writer:this.writer};this.value.revision=1;this.persist();
 }
 private storageEvent:EventListener=(event)=>{
  if(this.closed)return;const e=event as StorageEvent;if(e.key!==workspacePreferenceKey&&e.key!==null||e.storageArea&&e.storageArea!==this.storage)return;const latest=this.read();
  if(latest.kind==='absent'){this.value=defaultWorkspacePreferences();this.statusTo('available','Browser preferences were cleared; defaults remain usable.');this.notify();return;}
  try{const incoming=e.newValue===null||e.key===null?null:parseText(e.newValue);this.value=mergeWorkspacePreferences(this.value,...(incoming?[incoming]:[]),...(latest.kind==='valid'?[latest.value]:[]));if(latest.kind!=='corrupt')this.persist();this.notify();}catch(error){this.statusTo('corrupt',`Browser preference update was refused: ${error instanceof Error?error.message:String(error)}.`);}
 };
 private notify(){for(const listener of this.listeners)listener(this.get());}
}
