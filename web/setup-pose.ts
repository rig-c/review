/**
 * The setup pose, read from the published player: a throwaway `RigPlayer` over the loaded assets that never plays, so
 * its `bone()` and `slotIdentity()` answer the setup pose (the published `posedFrame()` is empty before `play`). Shared
 * by Setup · Weights (#107) and Edit Mesh (#100). The stage player is never touched; the throwaway one is disposed
 * before this returns, so every bone the caller may ask for is read here.
 */
import {RigPlayer,type ModelAssets,type RenderMode} from '@rig-c/play';
import type {WorldTransform} from '../src/setup-mesh.ts';

export interface SetupPose {
 /** The slot's attachment at the setup pose, or null when it shows none there. */
 identity:{skin:string;attachment:string}|null;
 /** A named bone's setup-pose world transform; throws for a bone that was not read. */
 world:(bone:string)=>WorldTransform;
}
/** Reads `slot`'s setup-pose identity and every bone in `bones` (unknown names are skipped). Throws what the player throws. */
export function readSetupPose(assets:ModelAssets,slot:string,bones:readonly string[],root:HTMLElement,mode:RenderMode='dom'):SetupPose {
 const player=new RigPlayer(root,assets,{mode,slots:[slot]});
 try{
  const row=player.slotIdentity().slots.find(r=>r.slot===slot),identity=row&&row.attachment&&row.skin?{skin:row.skin,attachment:row.attachment}:null;
  const map=new Map<string,WorldTransform>();
  for(const name of bones){try{const b=player.bone(name);map.set(name,{x:b.x,y:b.y,a:b.a,b:b.b,c:b.c,d:b.d});}catch{/* not a bone of this rig */}}
  return {identity,world:name=>{const t=map.get(name);if(!t)throw new Error(`no setup-pose transform for bone ${name}`);return t;}};
 }finally{player.dispose();}
}
/** The bone names a compiled model document declares, in stored order. */
export function modelBoneNames(model:unknown):string[] {
 const list=(model as {bones?:unknown}|null)?.bones;
 return Array.isArray(list)?list.map(b=>b&&typeof (b as {name?:unknown}).name==='string'?(b as {name:string}).name:'').filter(Boolean):[];
}
