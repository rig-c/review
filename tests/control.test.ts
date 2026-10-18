import {expect,test} from 'bun:test';
import {ControlLocalRevision} from '../web/control.ts';
import {parseControlCommand,parseControlInspection,parseControlRequest,preflightControl,type ControlInspection,type ControlCommand,type ControlRequest} from '../src/control.ts';
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
