/** Actual DOM transition controls; deliberately separate from the independent Play scalar oracle. */
import {AnimationInspectionPanel} from '../web/animation-inspection.ts';
export function frameTransitions(documentModel:unknown,animation:string){
 const host=document.createElement('div'),stage=document.createElement('div');document.body.append(host,stage);let active=true,reads=0,seeks=0;
 const panel=new AnimationInspectionPanel({host,stage,enabled:()=>true,project:(x,y)=>({x,y}),seek:()=>{seeks++;},select:()=>{}});
 try{
  panel.model(documentModel,animation);const player={bone:()=>{reads++;return {x:10,y:10,active};}} as never;
  panel.capture(player,{order:[],generation:1});panel.redraw(true);const initially=stage.querySelectorAll('.animation-bone-pick').length;if(!initially)throw new Error('NO_ACTIVE_BONE_CONTROL');
  active=false;panel.capture(player,{order:[],generation:2});panel.redraw(true);if(stage.querySelectorAll('.animation-bone-pick').length)throw new Error('STALE_INACTIVE_BONE_HANDLE');
  active=true;panel.capture(player,{order:[],generation:3});panel.redraw(true);const before=reads;panel.capture(player,undefined);panel.redraw(true);if(reads!==before||stage.querySelectorAll('.animation-bone-pick').length)throw new Error('MISSING_FRAME_PROBED_OR_RETAINED');
  panel.capture(player,{order:[],generation:4});panel.redraw(true);panel.unavailable('CONTROL_SOURCE_UNAVAILABLE');
  if(host.querySelector('.animation-key,[data-tree-kind],.animation-runtime-cursor')||host.querySelector<HTMLElement>('[data-curve-readout]')!.dataset.localValue!==undefined||stage.querySelector('.animation-bone-pick'))throw new Error('STALE_SOURCE_UI');
  if(seeks)throw new Error('FRAME_CONTROL_SOUGHT');return {activeToInactive:true,missingFrameNoBoneReads:true,nullSourceClearsUI:true,seekCalls:seeks};
 }finally{panel.dispose();host.remove();stage.remove();}
}
