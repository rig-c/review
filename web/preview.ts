/** Review's preview adapters. All posing, parameter validation and history belong to published Play. */
import type {BoneAdjust,PhysicsParameterPatch,PhysicsParameterRead,RigPlayer} from '@rig-c/play';
import {previewLocal,SETUP_DEFAULT,type LocalChannel,type PreviewPlan} from '../src/idle-tracks.ts';
import type {PendingEdit} from '../src/physics-tuning.ts';

export interface BoneSetup {names:readonly string[];get(bone:string):Partial<Record<LocalChannel,number>>|undefined}

/** Preserve the core's evaluation context through the idle + turn composition. */
export function composeAdjust(a:BoneAdjust|null,b:BoneAdjust|null):BoneAdjust|null {
 return a&&b?(bones,ctx)=>{a(bones,ctx);b(bones,ctx);}:a??b;
}

/** Uses the existing idle preview conversion; no player clock or seek compensation. */
export function idlePreviewAdjust(plan:PreviewPlan,setup:BoneSetup):BoneAdjust|null {
 const writes=plan.writes.map(w=>({w,setup:setup.get(w.bone)?.[w.channel]??SETUP_DEFAULT[w.channel]}));
 return writes.length?(bones,ctx)=>{
  if(ctx.trackTime===null)return;
  for(const {w,setup:s} of writes)bones.bone(w.bone)[w.channel]=previewLocal(w,s,ctx.trackTime);
 }:null;
}

export const LIVE_PHYSICS_FIELDS=['strength','damping','inertia','wind','gravity','mix'] as const;
type PhysicsPlayer=Pick<RigPlayer,'setPhysicsParameters'|'readPhysicsParameters'|'clearPhysicsParameters'>;
export interface PhysicsPreviewRead {name:string;read:PhysicsParameterRead}

/** Owns only this panel's pending overrides. Set/read/clear never evaluate, seek or reset physics. */
export class PhysicsPreview {
 private player:PhysicsPlayer|null=null;
 private patches=new Map<string,PhysicsParameterPatch>();
 sync(player:PhysicsPlayer|null,edits:readonly PendingEdit[]):PhysicsPreviewRead[] {
  const next=new Map<string,PhysicsParameterPatch>();
  for(const e of edits)if((LIVE_PHYSICS_FIELDS as readonly string[]).includes(e.field)){
   next.set(e.name,{...next.get(e.name),[e.field]:e.value});
  }
  if(this.player!==player){this.clear();this.player=player;}
  if(!player){if(next.size)throw new Error('PHYSICS_PREVIEW_UNAVAILABLE: no live player');return [];}
  for(const [name,patch] of this.patches){
   const wanted=next.get(name);
   // Play merges patches: removing a field must clear the old patch before setting the remaining fields.
   if(!wanted||Object.keys(patch).some(k=>!(k in wanted))){player.clearPhysicsParameters(name);this.patches.delete(name);}
  }
  for(const [name,patch] of next)if(JSON.stringify(this.patches.get(name))!==JSON.stringify(patch)){
   player.setPhysicsParameters(name,patch);this.patches.set(name,patch);
  }
  return this.read();
 }
 read():PhysicsPreviewRead[] {return this.player?[...this.patches.keys()].map(name=>({name,read:this.player!.readPhysicsParameters(name)})):[];}
 clear():void {
  for(const name of this.patches.keys())this.player?.clearPhysicsParameters(name);
  this.patches.clear();this.player=null;
 }
}
