/** Inspection-only protocol. Source identity and human review decisions are not commands. */
export type ControlMode='single'|'compare';
export type ControlCameraTarget='rig'|'a'|'b'|'reference';
export interface ControlCamera {zoom:number;pan:{x:number;y:number}}
export interface ControlLayers {images:boolean;meshes:boolean;bones:boolean}
/** Observed camera coordinates, independent of viewport-specific CSS pan. */
export interface ControlNumericCamera {
 space:'world'|'image';center:{x:number;y:number};zoom:number;
 viewport:{width:number;height:number};visible:{x:number;y:number;width:number;height:number};
}
export interface ControlView {
 schema:'rig-review-view/1';
 cameraSync?:boolean;activeCamera?:ControlCameraTarget;
 cameras:{rig:ControlNumericCamera|null;a:ControlNumericCamera|null;b:ControlNumericCamera|null;reference:ControlNumericCamera|null};
}
export interface ControlInspection {
 theme:'system'|'dark'|'light';layout:'auto';effectiveLayout:'row'|'column'|null;
 cameras:{rig:ControlCamera;reference:ControlCamera;a?:ControlCamera;b?:ControlCamera};animation:string|null;time:number|null;
 playing:boolean;loop:'idle'|'off';layers:ControlLayers;ready:boolean;seeking:boolean;
 dirty:boolean;busy:boolean;feedbackEligible:boolean;view?:ControlView;
 capabilities:{camera:boolean;referenceCamera:boolean;animation:boolean;time:boolean;playback:boolean;layers:ControlLayers};
}
export type ControlCommand=
 |{type:'theme';value:'system'|'dark'|'light'}|{type:'layout';value:'auto'}
 |{type:'camera';target:ControlCameraTarget;zoom:number;pan:{x:number;y:number}}
 |{type:'fit';target:ControlCameraTarget}|{type:'camera-sync';value:boolean}|{type:'playback';value:'play'|'pause'}
 |{type:'animation';name:string}|{type:'time';seconds:number}|({type:'layers'}&ControlLayers);
export interface ControlRequest {schema:'rig-review-control-command/1';requestId:string;pageId:string;instanceKey:string;sourceHash:string;expectedRevision:number;command:ControlCommand}
export interface ControlDelivery {commandId:string;request:ControlRequest}
export type ControlOutcome='queued'|'dispatched'|'applied'|'rejected'|'failed'|'superseded'|'outcome-unknown';
export interface ControlReceipt {commandId:string;requestId:string;pageId:string;status:ControlOutcome;error?:string;revision:number;inspection:ControlInspection|null}
export function controlObject(v:unknown,keys:readonly string[],name:string):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)throw new Error(`${name}: expected object`);
 const o=v as Record<string,unknown>;for(const key of Object.keys(o))if(!keys.includes(key))throw new Error(`${name}.${key}: unknown field`);return o;
}
export function controlString(v:unknown,name:string,max=128):string{if(typeof v!=='string'||!v||v.length>max||/[\x00-\x1f]/.test(v))throw new Error(`${name}: expected nonempty text <= ${max}`);return v;}
export function controlInteger(v:unknown,name:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error(`${name}: expected safe integer >= 0`);return v;}
function num(v:unknown,name:string,min:number,max:number):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(`${name}: expected finite ${min}..${max}`);return v;}
function bool(v:unknown,name:string):boolean{if(typeof v!=='boolean')throw new Error(`${name}: expected boolean`);return v;}
function choice<T extends string>(v:unknown,values:readonly T[],name:string):T{if(typeof v!=='string'||!values.includes(v as T))throw new Error(`${name}: expected ${values.join(' | ')}`);return v as T;}
function pan(v:unknown,limit=65536){const o=controlObject(v,['x','y'],'control.pan');return {x:num(o.x,'control.pan.x',-limit,limit),y:num(o.y,'control.pan.y',-limit,limit)};}
/** Sync scales CSS displacement by pane size; observed pan is not a command input. */
function camera(v:unknown):ControlCamera{const o=controlObject(v,['zoom','pan'],'control.camera');return {zoom:num(o.zoom,'control.camera.zoom',.25,8),pan:pan(o.pan,Number.MAX_SAFE_INTEGER)};}
function layers(v:unknown):ControlLayers{const o=controlObject(v,['images','meshes','bones'],'control.layers');return {images:bool(o.images,'control.layers.images'),meshes:bool(o.meshes,'control.layers.meshes'),bones:bool(o.bones,'control.layers.bones')};}
export function parseControlView(v:unknown):ControlView{
 const o=controlObject(v,['schema','cameras','cameraSync','activeCamera'],'control.view');
 if(o.schema!=='rig-review-view/1')throw new Error('control.view.schema: expected rig-review-view/1');
 const c=controlObject(o.cameras,['rig','a','b','reference'],'control.view.cameras');
 const numeric=(value:unknown,id:'rig'|'a'|'b'|'reference'):ControlNumericCamera|null=>{
  if(value===null)return null;
  const name=`control.view.cameras.${id}`,camera=controlObject(value,['space','center','zoom','viewport','visible'],name);
  const space=id==='reference'?'image':'world';
  if(camera.space!==space)throw new Error(`${name}.space: expected ${space}`);
  const center=controlObject(camera.center,['x','y'],`${name}.center`),viewport=controlObject(camera.viewport,['width','height'],`${name}.viewport`),visible=controlObject(camera.visible,['x','y','width','height'],`${name}.visible`);
  const coordinate=(value:unknown,field:string)=>num(value,`${name}.${field}`,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
  const positive=(value:unknown,field:string,max:number)=>{const n=num(value,`${name}.${field}`,0,max);if(n===0)throw new Error(`${name}.${field}: expected positive dimension`);return n;};
  return {space,center:{x:coordinate(center.x,'center.x'),y:coordinate(center.y,'center.y')},zoom:num(camera.zoom,`${name}.zoom`,.25,8),viewport:{width:positive(viewport.width,'viewport.width',65536),height:positive(viewport.height,'viewport.height',65536)},visible:{x:coordinate(visible.x,'visible.x'),y:coordinate(visible.y,'visible.y'),width:positive(visible.width,'visible.width',Number.MAX_SAFE_INTEGER),height:positive(visible.height,'visible.height',Number.MAX_SAFE_INTEGER)}};
 };
 return {schema:'rig-review-view/1',...(o.cameraSync===undefined?{}:{cameraSync:bool(o.cameraSync,'control.view.cameraSync')}),...(o.activeCamera===undefined?{}:{activeCamera:choice(o.activeCamera,['rig','a','b','reference'] as const,'control.view.activeCamera')}),cameras:{rig:numeric(c.rig,'rig'),a:numeric(c.a,'a'),b:numeric(c.b,'b'),reference:numeric(c.reference,'reference')}};
}
export function parseControlCommand(v:unknown):ControlCommand{
 const base=controlObject(v,['type','value','target','zoom','pan','name','seconds','images','meshes','bones'],'control.command');
 const type=choice(base.type,['theme','layout','camera','fit','camera-sync','playback','animation','time','layers'] as const,'control.command.type');
 const keys={theme:['type','value'],layout:['type','value'],camera:['type','target','zoom','pan'],fit:['type','target'],'camera-sync':['type','value'],playback:['type','value'],animation:['type','name'],time:['type','seconds'],layers:['type','images','meshes','bones']}[type];controlObject(v,keys,'control.command');
 if(type==='theme')return {type,value:choice(base.value,['system','dark','light'] as const,'control.theme')};
 if(type==='layout')return {type,value:choice(base.value,['auto'] as const,'control.layout')};
 if(type==='camera')return {type,target:choice(base.target,['rig','a','b','reference'] as const,'control.target'),zoom:num(base.zoom,'control.zoom',.25,8),pan:pan(base.pan)};
 if(type==='fit')return {type,target:choice(base.target,['rig','a','b','reference'] as const,'control.target')};
 if(type==='camera-sync')return {type,value:bool(base.value,'control.cameraSync')};
 if(type==='playback')return {type,value:choice(base.value,['play','pause'] as const,'control.playback')};
 if(type==='animation')return {type,name:controlString(base.name,'control.animation')};
 if(type==='time')return {type,seconds:num(base.seconds,'control.seconds',0,Number.MAX_SAFE_INTEGER)};
 return {type,images:bool(base.images,'control.layers.images'),meshes:bool(base.meshes,'control.layers.meshes'),bones:bool(base.bones,'control.layers.bones')};
}
export function parseControlInspection(v:unknown):ControlInspection{
 const o=controlObject(v,['theme','layout','effectiveLayout','cameras','animation','time','playing','loop','layers','ready','seeking','dirty','busy','feedbackEligible','capabilities','view'],'control.inspection');
 const c=controlObject(o.cameras,['rig','reference','a','b'],'control.cameras'),a=controlObject(o.capabilities,['camera','referenceCamera','animation','time','playback','layers'],'control.capabilities');
 return {...(o.view===undefined?{}:{view:parseControlView(o.view)}),theme:choice(o.theme,['system','dark','light'] as const,'control.theme'),layout:choice(o.layout,['auto'] as const,'control.layout'),effectiveLayout:o.effectiveLayout===null?null:choice(o.effectiveLayout,['row','column'] as const,'control.effectiveLayout'),cameras:{rig:camera(c.rig),reference:camera(c.reference),...(c.a===undefined?{}:{a:camera(c.a)}),...(c.b===undefined?{}:{b:camera(c.b)})},animation:o.animation===null?null:controlString(o.animation,'control.animation'),time:o.time===null?null:num(o.time,'control.time',0,Number.MAX_SAFE_INTEGER),playing:bool(o.playing,'control.playing'),loop:choice(o.loop,['idle','off'] as const,'control.loop'),layers:layers(o.layers),ready:bool(o.ready,'control.ready'),seeking:bool(o.seeking,'control.seeking'),dirty:bool(o.dirty,'control.dirty'),busy:bool(o.busy,'control.busy'),feedbackEligible:bool(o.feedbackEligible,'control.feedbackEligible'),capabilities:{camera:bool(a.camera,'control.capabilities.camera'),referenceCamera:bool(a.referenceCamera,'control.capabilities.referenceCamera'),animation:bool(a.animation,'control.capabilities.animation'),time:bool(a.time,'control.capabilities.time'),playback:bool(a.playback,'control.capabilities.playback'),layers:layers(a.layers)}};
}
export function parseControlRequest(v:unknown):ControlRequest{
 const o=controlObject(v,['schema','requestId','pageId','instanceKey','sourceHash','expectedRevision','command'],'control.request');
 if(o.schema!=='rig-review-control-command/1')throw new Error('control.schema: expected rig-review-control-command/1');
 for(const field of ['instanceKey','sourceHash'])if(typeof o[field]!=='string'||!/^[a-f0-9]{64}$/.test(o[field] as string))throw new Error(`control.${field}: expected SHA-256`);
 return {schema:o.schema,requestId:controlString(o.requestId,'control.requestId'),pageId:controlString(o.pageId,'control.pageId'),instanceKey:o.instanceKey as string,sourceHash:o.sourceHash as string,expectedRevision:controlInteger(o.expectedRevision,'control.expectedRevision'),command:parseControlCommand(o.command)};
}
/** Shared preflight; adapters additionally validate actual names/domains before mutation. */
export function preflightControl(command:ControlCommand,state:ControlInspection,mode:ControlMode):void{
 if(state.busy)throw new Error('CONTROL_BUSY: inspection update in progress');
 if(['animation','time','playback'].includes(command.type)&&state.dirty)throw new Error('CONTROL_UNSUBMITTED_CHANGES: preserve the current feedback draft');
 if(['animation','time','playback'].includes(command.type)&&(!state.ready||state.seeking))throw new Error('CONTROL_NOT_READY: inspection is not settled');
 const cap=state.capabilities;
 if(command.type==='animation'&&mode==='compare'&&command.name!==state.animation)throw new Error('CONTROL_REBIND_REQUIRED: comparison animation is source-bound');
 if(command.type==='animation'&&!cap.animation)throw new Error('CONTROL_UNAVAILABLE: animation');
 if(command.type==='time'&&!cap.time)throw new Error('CONTROL_UNAVAILABLE: time');
 if(command.type==='playback'&&!cap.playback)throw new Error('CONTROL_UNAVAILABLE: playback');
 if(command.type==='camera-sync'&&state.view?.cameraSync===undefined)throw new Error('CONTROL_UNAVAILABLE: camera sync');
 if(command.type==='camera'||command.type==='fit'){
  const target=command.target;
  if((target==='a'||target==='b')&&(mode!=='compare'||!cap.camera||!state.cameras[target]&&!state.view?.cameras[target]))throw new Error(`CONTROL_UNAVAILABLE: ${target} camera`);
  if((target==='rig'&&!cap.camera)||(target==='reference'&&!cap.referenceCamera))throw new Error(`CONTROL_UNAVAILABLE: ${target} camera`);
 }
 if(command.type==='layers')for(const name of ['images','meshes','bones'] as const)if(command[name]!==state.layers[name]&&!cap.layers[name])throw new Error(`CONTROL_UNAVAILABLE: ${name}`);
}
