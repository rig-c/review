import {expect,test} from 'bun:test';
import {readingSeekTime,TICK_EDGE} from '../src/readings.ts';
import {retargetStage,patchAppliedRecord,retargetAppliedRecord,type AnyJobView,type PatchJobView,type RetargetJobView} from '../web/rebuild-client.ts';
import {keptAnimation} from '../src/animation-selection.ts';
import {rigPaneLabel,transportClock} from '../src/frame-clock.ts';
import {staleReadouts} from '../src/applied-blocks.ts';
import {CONFIG_PATCH_SCHEMA,type PatchOp} from '../src/config-patch.ts';

/** #186: the editor UI-state decisions main.ts makes on a seek, an undo, a model swap and a stage change. */
const hex=(c:string)=>c.repeat(64);
function retargetJob(id:string,animation:string,frameTimes:number[]|null):RetargetJobView {
 return {id,kind:'retarget',op:'retarget',status:'built',reused:false,lines:[],producerLine:'ok',refusals:[],exitCode:0,wallMs:{clean:1,retarget:1,compile:1},files:null,motion:null,readings:[],frameTimes,
  build:{modelUrl:'m',modelHash:hex(id[0]!),files:{}},request:{record:{flags:{animation}},recordSha256:hex('r'),configHash:hex('c')},producer:{package:'@rig-c/pose',version:'1.0.0'},compiler:{package:'@rig-c/compiler',version:'1.0.0'}} as unknown as RetargetJobView;
}
function patchJob(id:string,op:'build'|'cloth'|'rig',ops:PatchOp[]):PatchJobView {
 const patch={schema:CONFIG_PATCH_SCHEMA,config_sha256:hex('c'),ops,producer:{name:'@rig-c/parts',version:'1.50.0'},op:{cmd:'rig' as const,args:[]}};
 return {id,kind:'patch',op,status:'built',reused:false,lines:[],producerLine:'ok',exitCode:0,wallMs:{op:1,compile:1,check:1},check:null,diff:null,
  build:{modelUrl:'m',modelHash:hex(id[0]!),files:{}},request:{patch,patchSha256:hex('d'),configHash:hex('c')},producer:{package:'@rig-c/parts',version:'1.50.0'},compiler:{package:'@rig-c/compiler',version:'1.0.0'}} as unknown as PatchJobView;
}

test('#186 item 2: a reading seek snaps against the target clip\'s end, not the clip drawn before the switch',()=>{
 // The reviewer is on a 1 s clip; the retarget clip is 3 s; the line's last sample sits a rounding hair past 3 s.
 expect(readingSeekTime(3+TICK_EDGE/2,3)).toBe(3);
 // A time inside the target clip is the time, even though it is past the shorter clip that was drawn.
 expect(readingSeekTime(2.5,3)).toBe(2.5);
 // Past the edge, the time is kept and the seek refuses it by name (no substitute time).
 expect(readingSeekTime(3.5,3)).toBe(3.5);
 // An unknown duration snaps nothing.
 expect(readingSeekTime(1.00001,0)).toBe(1.00001);
});

test('#186 item 3: undo onto a retarget build restores its animation and its own clock bound to that build',()=>{
 const older=retargetJob('a1','dance',[0,0.04,0.1]),hash=older.build!.modelHash;
 const stage=retargetStage(older,hash);
 expect(stage).toEqual({animation:'dance',clock:{animation:'dance',modelHash:hash,clock:{kind:'samples',frameTimes:[0,0.04,0.1]}}});
 // The transport reads that clock for the restored build (and not for the reverted one's hash).
 expect(transportClock({clock:null,animation:undefined},'dance',true,stage!.clock,hash)?.source).toBe('stage');
 expect(transportClock({clock:null,animation:undefined},'dance',true,stage!.clock,hex('b'))).toBeNull();
 // A retarget without readable frameTimes still selects its animation; it states no clock.
 expect(retargetStage(retargetJob('a1','dance',null),hash)).toEqual({animation:'dance',clock:null});
 // A non-retarget build restores nothing retarget-specific.
 expect(retargetStage(patchJob('b2','rig',[]) as AnyJobView,hex('b'))).toBeNull();
});

test('#186 item 4: a swapped-in model without the staged animation clears it, so the rig pane names no removed clip',()=>{
 expect(keptAnimation('dance',['idle','walk'])).toBe('');
 expect(keptAnimation('idle',['idle','walk'])).toBe('idle');
 expect(keptAnimation('',['idle'])).toBe('');
 expect(rigPaneLabel({hasPlayer:true,animation:keptAnimation('dance',['idle']),time:0,frame:null})).toBe('Generated rig · no animation · 0.000 s');
});

test('#186 item 5: a stage change clears each Cuts / Cloth readout the new stage record is not that block\'s',()=>{
 const cuts=patchAppliedRecord(patchJob('a1','build',[{op:'replace',path:'/assemble/cuts/0/overlap',value:3}])),cloth=patchAppliedRecord(patchJob('b2','cloth',[{op:'replace',path:'/cloth/x/translate',value:0.2}]));
 const physics=patchAppliedRecord(patchJob('c3','rig',[{op:'replace',path:'/constraints/0/damping',value:0.8}])),retarget=retargetAppliedRecord(retargetJob('d4','dance',null));
 // Cuts Apply, then Cloth Apply: the Cuts readout is an older build's.
 expect(staleReadouts(cuts,cloth)).toEqual(['cuts']);
 expect(staleReadouts(cloth,cuts)).toEqual(['cloth']);
 // A general Reset (the inspected build), a physics or a retarget Apply: neither block owns the stage.
 expect(staleReadouts(cuts,null)).toEqual(['cuts','cloth']);
 expect(staleReadouts(cloth,physics)).toEqual(['cuts','cloth']);
 expect(staleReadouts(cuts,retarget)).toEqual(['cuts','cloth']);
 // No stage change: nothing is cleared (a refused Apply's readout stays).
 expect(staleReadouts(cuts,cuts)).toEqual([]);
 expect(staleReadouts(null,null)).toEqual([]);
 // A second Cuts Apply clears only the Cloth readout; its own block shows the new job.
 expect(staleReadouts(cuts,patchAppliedRecord(patchJob('e5','build',[])))).toEqual(['cloth']);
});
