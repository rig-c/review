import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {ControlLocalRevision} from '../web/control.ts';
import {parseControlCommand,parseControlInspection,parseControlView,parseControlRequest,preflightControl,type ControlInspection,type ControlCommand,type ControlRequest,type ControlView} from '../src/control.ts';
export function inspection():ControlInspection{return {theme:'system',layout:'auto',effectiveLayout:'row',cameras:{rig:{zoom:1,pan:{x:0,y:0}},reference:{zoom:1,pan:{x:0,y:0}}},animation:'idle',time:0,playing:false,loop:'off',layers:{images:true,meshes:false,bones:false},ready:true,seeking:false,dirty:false,busy:false,feedbackEligible:true,capabilities:{camera:true,referenceCamera:true,animation:true,time:true,playback:true,layers:{images:true,meshes:true,bones:true}}};}
test('closed inspection commands accept finite presentation and transport values only',()=>{
 for(const value of [{type:'theme',value:'light'},{type:'camera',target:'reference',zoom:2,pan:{x:24,y:-12}},{type:'time',seconds:.500003},{type:'animation',name:'--help'},{type:'layers',images:false,meshes:true,bones:true}] satisfies ControlCommand[])expect(parseControlCommand(value)).toEqual(value);
 for(const value of [{type:'eval',value:'alert(1)'},{type:'theme',value:'light',path:'/private/file'},{type:'camera',target:'rig',zoom:9,pan:{x:0,y:0}},{type:'camera',target:'rig',zoom:1,pan:{x:NaN,y:0}},{type:'time',seconds:Infinity},{type:'time',seconds:-1},{type:'layers',images:1,meshes:true,bones:false},{type:'layout',value:'column'},{type:'approval',value:'approved'}])expect(()=>parseControlCommand(value)).toThrow();
 expect(()=>parseControlCommand(JSON.parse('{"type":"theme","value":"dark","__proto__":{}}'))).toThrow('unknown field');
});
test('observed inspection is typed actual state, not arbitrary feedback or commands',()=>{
 const value=inspection();expect(parseControlInspection(value)).toEqual(value);expect(()=>parseControlInspection({...value,status:'approved'})).toThrow('unknown field');expect(()=>parseControlInspection({...value,time:NaN})).toThrow();expect(()=>parseControlInspection({...value,cameras:{rig:{zoom:1,pan:{x:0,y:0}}}})).toThrow();
 const request:ControlRequest={schema:'rig-review-control-command/1',requestId:'literal-id',pageId:'page',instanceKey:'a'.repeat(64),sourceHash:'b'.repeat(64),expectedRevision:0,command:{type:'time',seconds:1}};
 expect(parseControlRequest(request)).toEqual(request);expect(()=>parseControlRequest({...request,expectedRevision:9007199254740992})).toThrow('safe integer');expect(()=>parseControlRequest({...request,sourceHash:'not-a-secret'})).toThrow('SHA-256');
});
test('preflight preserves drafts and compare binding, unavailable features never become a success',()=>{
 const state=inspection();for(const command of [{type:'animation',name:'dance'},{type:'time',seconds:1},{type:'playback',value:'play'}] as const)expect(()=>preflightControl(command,{...state,dirty:true},'single')).toThrow('UNSUBMITTED');
 expect(()=>preflightControl({type:'theme',value:'light'},{...state,dirty:true},'single')).not.toThrow();expect(()=>preflightControl({type:'time',seconds:1},{...state,seeking:true},'single')).toThrow('NOT_READY');
 expect(()=>preflightControl({type:'animation',name:'dance'},state,'compare')).toThrow('REBIND_REQUIRED');expect(()=>preflightControl({type:'animation',name:'idle'},state,'compare')).not.toThrow();
 const missing={...state,capabilities:{...state.capabilities,layers:{images:true,meshes:false,bones:false}}};expect(()=>preflightControl({type:'layers',images:true,meshes:true,bones:false},missing,'single')).toThrow('UNAVAILABLE: meshes');expect(()=>preflightControl({type:'layers',images:true,meshes:false,bones:false},missing,'single')).not.toThrow();
 expect(()=>preflightControl({type:'fit',target:'reference'},{...state,capabilities:{...state.capabilities,referenceCamera:false}},'single')).toThrow('UNAVAILABLE');
});

test('a drag begun before a remote apply supersedes it on move and completion, hover does not',async()=>{
 let inFlight:AbortController|null=null;const local=new ControlLocalRevision(()=>inFlight?.abort());local.interaction('pointerdown',7);const expected=local.revision;inFlight=new AbortController();const signal=inFlight.signal;
 const pending=new Promise<string>(resolve=>signal.addEventListener('abort',()=>resolve('superseded'),{once:true}));local.interaction('pointermove',7);expect(await pending).toBe('superseded');expect(local.revision).toBeGreaterThan(expected);
 inFlight=new AbortController();local.interaction('pointerup',7);expect(inFlight.signal.aborted).toBe(true);const after=local.revision;local.interaction('pointermove',7);local.interaction('pointermove',12);expect(local.revision).toBe(after);
 for(const completion of ['pointercancel','lostpointercapture','blur']){local.interaction('pointerdown',8);inFlight=new AbortController();local.interaction(completion,8);expect(inFlight.signal.aborted).toBe(true);const ended=local.revision;local.interaction('pointermove',8);expect(local.revision).toBe(ended);}
});

test('numeric view readback preserves per-pane canonical coordinates and refuses malformed or secret fields',()=>{
 const world={space:'world' as const,center:{x:-20.5,y:110},zoom:2,viewport:{width:640,height:480},visible:{x:-100,y:-50,width:160,height:120}};
 const image={space:'image' as const,center:{x:960,y:540},zoom:1,viewport:{width:320,height:600},visible:{x:0,y:-1260,width:1920,height:3600}};
 const view:ControlView={schema:'rig-review-view/1',cameras:{rig:world,a:null,b:null,reference:image}};
 expect(parseControlView(view)).toEqual(view);expect(parseControlInspection({...inspection(),view}).view).toEqual(view);
 const compare:ControlView={schema:'rig-review-view/1',cameras:{rig:null,a:world,b:{...world,viewport:{width:320,height:480},visible:{x:-60,y:-50,width:80,height:120}},reference:null}};
 expect(parseControlView(compare)).toEqual(compare);expect(parseControlInspection(inspection()).view).toBeUndefined();
 const allNull:ControlView={schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:null}};expect(parseControlView(allNull)).toEqual(allNull);
 for(const invalid of [null,{...view,schema:'rig-review-view/2'},{...view,token:'secret'},{...view,cameras:{...view.cameras,path:'/private'}},{...view,cameras:{...view.cameras,rig:{...world,space:'image'}}},{...view,cameras:{...view.cameras,reference:world}},{...view,cameras:{...view.cameras,rig:{...world,center:{x:NaN,y:0}}}},{...view,cameras:{...view.cameras,rig:{...world,viewport:{width:0,height:480}}}},{...view,cameras:{...view.cameras,rig:{...world,visible:{...world.visible,width:-1}}}},{...view,cameras:{...view.cameras,rig:{...world,zoom:Infinity}}}])expect(()=>parseControlView(invalid)).toThrow();
 expect(()=>parseControlInspection({...inspection(),view:{...view,cameras:{rig:world}}})).toThrow('expected object');
 const parsed=parseControlView(view);expect(parsed.cameras.rig).not.toBe(world);expect(parsed.cameras.rig!.center).not.toBe(world.center);
});

test('camera sync and pane commands remain closed and legacy observations remain readable',()=>{
 const commands:ControlCommand[]=[{type:'camera-sync',value:true},{type:'camera-sync',value:false},{type:'camera',target:'a',zoom:2,pan:{x:-42,y:12}},{type:'fit',target:'b'}];
 for(const command of commands)expect(parseControlCommand(command)).toEqual(command);
 for(const invalid of [{type:'camera-sync',value:'on'},{type:'camera-sync',value:1},{type:'camera-sync',value:true,target:'a'},{type:'camera-sync',enabled:true},{type:'fit',target:'all'},{type:'camera',target:'b',zoom:1,pan:{x:65537,y:0}}])expect(()=>parseControlCommand(invalid)).toThrow();
 const legacy=inspection();expect(parseControlInspection(legacy)).toEqual(legacy);
 const view:ControlView={schema:'rig-review-view/1',cameraSync:false,activeCamera:'b',cameras:{rig:null,a:null,b:null,reference:null}};
 const state={...legacy,view,cameras:{...legacy.cameras,a:{zoom:2,pan:{x:30,y:-10}},b:{zoom:.5,pan:{x:-20,y:40}}}};
 expect(parseControlInspection(state)).toEqual(state);expect(parseControlView({...view,cameraSync:true,activeCamera:'reference'})).toEqual({...view,cameraSync:true,activeCamera:'reference'});
 const parsed=parseControlInspection(state);expect(parsed.cameras.a).not.toBe(state.cameras.a);expect(parsed.cameras.a!.pan).not.toBe(state.cameras.a.pan);
 for(const invalid of [{...view,cameraSync:'off'},{...view,cameraSync:null},{...view,activeCamera:'all'},{...view,activeCamera:null},{...view,enabled:true}])expect(()=>parseControlView(invalid)).toThrow();
 for(const cameras of [{...state.cameras,a:null},{...state.cameras,b:{zoom:1,pan:{x:Infinity,y:0}}},{...state.cameras,c:{zoom:1,pan:{x:0,y:0}}}])expect(()=>parseControlInspection({...state,cameras})).toThrow();
});

test('sync preflight preserves drafts and checks actual pane availability without inventing legacy support',()=>{
 const legacy=inspection(),view:ControlView={schema:'rig-review-view/1',cameraSync:false,activeCamera:'a',cameras:{rig:null,a:null,b:null,reference:null}};
 const state={...legacy,view,cameras:{...legacy.cameras,a:{zoom:2,pan:{x:10,y:20}},b:{zoom:1,pan:{x:0,y:0}}}};
 expect(()=>preflightControl({type:'camera-sync',value:true},legacy,'compare')).toThrow('UNAVAILABLE: camera sync');
 for(const value of [true,false])expect(()=>preflightControl({type:'camera-sync',value},{...state,dirty:true},'compare')).not.toThrow();
 expect(()=>preflightControl({type:'camera-sync',value:true},{...state,busy:true},'compare')).toThrow('CONTROL_BUSY');
 for(const target of ['a','b'] as const){
  const command:ControlCommand={type:'fit',target};
  expect(()=>preflightControl(command,state,'compare')).not.toThrow();
  expect(()=>preflightControl(command,state,'single')).toThrow(`UNAVAILABLE: ${target} camera`);
  expect(()=>preflightControl(command,{...state,cameras:legacy.cameras},'compare')).toThrow(`UNAVAILABLE: ${target} camera`);
  expect(()=>preflightControl(command,{...state,capabilities:{...state.capabilities,camera:false}},'compare')).toThrow(`UNAVAILABLE: ${target} camera`);
 }
 const numeric={space:'world' as const,center:{x:0,y:0},zoom:1,viewport:{width:640,height:480},visible:{x:-320,y:-240,width:640,height:480}};
 expect(()=>preflightControl({type:'fit',target:'b'},{...legacy,view:{...view,cameras:{...view.cameras,b:numeric}}},'compare')).not.toThrow();
 // Legacy rig commands keep their explicit A/B-group meaning, including when sync is off.
 expect(()=>preflightControl({type:'fit',target:'rig'},state,'compare')).not.toThrow();
});

test('synchronized observed CSS pan can exceed the command bound while commands stay bounded',()=>{
 const state=inspection();state.cameras.reference.pan={x:120000,y:-131072};
 expect(parseControlInspection(state)).toEqual(state);
 for(const coordinate of [Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER])expect(parseControlInspection({...state,cameras:{...state.cameras,rig:{zoom:1,pan:{x:coordinate,y:coordinate}}}}).cameras.rig.pan.x).toBe(coordinate);
 for(const coordinate of [Infinity,NaN,Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER-1])expect(()=>parseControlInspection({...state,cameras:{...state.cameras,rig:{zoom:1,pan:{x:coordinate,y:0}}}})).toThrow();
 expect(parseControlCommand({type:'camera',target:'a',zoom:1,pan:{x:65536,y:-65536}}).type).toBe('camera');
 for(const coordinate of [65537,-65537,120000])expect(()=>parseControlCommand({type:'camera',target:'reference',zoom:1,pan:{x:coordinate,y:0}})).toThrow('control.pan.x');
});

test('actual control client acknowledges truthful scaled pan after a legal camera command',async()=>{
 const source=await readFile(new URL('../web/control.ts',import.meta.url),'utf8'),start=source.indexOf('export function connectControl(');if(start<0)throw new Error('control client boundary missing');
 const compiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start).replace('export function','function'));
 const state=inspection();state.view={schema:'rig-review-view/1',cameraSync:true,activeCamera:'reference',cameras:{rig:null,a:null,b:null,reference:null}};
 const request:ControlRequest={schema:'rig-review-control-command/1',requestId:'scaled-camera-pan',pageId:'page',instanceKey:'a'.repeat(64),sourceHash:'b'.repeat(64),expectedRevision:0,command:{type:'camera',target:'reference',zoom:1,pan:{x:60000,y:0}}};
 let acknowledged!:(value:Record<string,unknown>)=>void,delivered=false;const receipt=new Promise<Record<string,unknown>>(resolve=>{acknowledged=resolve;});
 const fetch=async(path:string,options?:RequestInit)=>{
  let result:unknown={};if(path.endsWith('/config'))result={enabled:true,sourceHash:request.sourceHash,mode:'single'};
  else if(path.endsWith('/register'))result={pageId:'page',pageToken:'page capability',revision:0};
  else if(path.endsWith('/poll')){result={command:delivered?null:{commandId:'command',request}};delivered=true;}
  else if(path.endsWith('/ack'))acknowledged(JSON.parse(String(options?.body)) as Record<string,unknown>);
  return Response.json(result);
 };
 const window={addEventListener:()=>{},removeEventListener:()=>{}};
 const open=new Function('ControlLocalRevision','parseControlCommand','parseControlInspection','preflightControl','window','document','fetch',compiled+';return connectControl;')(ControlLocalRevision,parseControlCommand,parseControlInspection,preflightControl,window,{hidden:false},fetch) as (adapter:{sourceHash:string;mode:'single';observe:()=>ControlInspection;apply:(command:ControlCommand)=>Promise<void>})=>()=>void;
 const dispose=open({sourceHash:request.sourceHash,mode:'single',observe:()=>state,apply:async command=>{
  if(command.type!=='camera')throw new Error('Expected camera command');
  // Same normalized pan: reference width300, rig width600.
  state.cameras.reference={zoom:command.zoom,pan:{...command.pan}};
  state.cameras.rig={zoom:command.zoom,pan:{x:command.pan.x*2,y:command.pan.y*2}};
 }});
 try{const ack=await receipt;expect(ack.status).toBe('applied');expect(ack.revision).toBe(1);expect((ack.inspection as ControlInspection).cameras.rig.pan.x).toBe(120000);expect(ack.inspection).toEqual(state);}
 finally{dispose();}
});

test('actual control client captures navigation before a held remote apply and acknowledges superseded, while hover still applies',async()=>{
 const source=await readFile(new URL('../web/control.ts',import.meta.url),'utf8'),start=source.indexOf('export function connectControl(');if(start<0)throw new Error('control client boundary missing');
 const compiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start).replace('export function','function'));
 for(const eventType of ['hashchange','popstate','pointermove']){
  const handlers=new Map<string,{handler:(event:Event)=>void;capture:boolean}>(),window={addEventListener:(type:string,handler:(event:Event)=>void,options:{capture:boolean})=>handlers.set(type,{handler,capture:options.capture}),removeEventListener:(type:string)=>handlers.delete(type)};
  const state=inspection();let release!:()=>void,started!:()=>void,acknowledged!:(value:Record<string,unknown>)=>void,delivered=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),applying=new Promise<void>(resolve=>{started=resolve;}),receipt=new Promise<Record<string,unknown>>(resolve=>{acknowledged=resolve;});
  const request:ControlRequest={schema:'rig-review-control-command/1',requestId:'navigation-race',pageId:'page',instanceKey:'a'.repeat(64),sourceHash:'b'.repeat(64),expectedRevision:0,command:{type:'theme',value:'light'}};
  const fetch=async(path:string,options?:RequestInit)=>{
   let result:unknown={};if(path.endsWith('/config'))result={enabled:true,sourceHash:request.sourceHash,mode:'single'};
   else if(path.endsWith('/register'))result={pageId:'page',pageToken:'page capability',revision:0};
   else if(path.endsWith('/poll')){result={command:delivered?null:{commandId:'command',request}};delivered=true;}
   else if(path.endsWith('/ack')){const body=JSON.parse(String(options?.body)) as Record<string,unknown>;acknowledged(body);}
   return Response.json(result);
  };
  const open=new Function('ControlLocalRevision','parseControlCommand','parseControlInspection','preflightControl','window','document','fetch',compiled+';return connectControl;')(ControlLocalRevision,parseControlCommand,parseControlInspection,preflightControl,window,{hidden:false},fetch) as (adapter:{sourceHash:string;mode:'single';observe:()=>ControlInspection;apply:(command:ControlCommand,signal:AbortSignal)=>Promise<void>})=>()=>void;
  const dispose=open({sourceHash:request.sourceHash,mode:'single',observe:()=>state,apply:async(_command,signal)=>{started();await gate;if(!signal.aborted)state.theme='light';}});
  try{
   await applying;const registered=handlers.get(eventType);expect(registered).toBeDefined();expect(registered!.capture).toBe(true);
   registered!.handler({type:eventType,isTrusted:true,pointerId:99} as unknown as Event);release();const ack=await receipt;
   expect(ack.status).toBe(eventType==='pointermove'?'applied':'superseded');expect(ack.revision).toBe(1);expect(ack.inspection).toEqual(state);expect(state.theme).toBe(eventType==='pointermove'?'light':'system');
  }finally{release();dispose();}
 }
});
