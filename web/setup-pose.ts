/**
 * Setup identity through the published player, followed by named geometry through Play's public readSetupMesh.
 * The short-lived player reads identity only: setup sliders can select an attachment different from slot.setup.
 * It never plays or reads bone matrices, and never touches the stage player.
 */
import {RigPlayer,readSetupMesh,type ModelAssets,type RenderMode,type SetupMesh,type SlotIdentityReason} from '@rig-c/play';

export interface SetupPose {
 /** Exact supplying table/key, or the public null identity (never guessed from declarations). */
 identity:{skin:string;attachment:string}|null;
 /** Active skin selection, distinct from the supplying table in identity.skin. Null means a fresh no-skin player. */
 skin:string|null;
 reason:SlotIdentityReason|null;
 /** Detached geometry from the public API; lazy so callers can name non-mesh/linked refusals first. */
 readMesh:()=>SetupMesh|null;
}
/** Reads setup identity without advancing time. Throws public setup/identity/geometry refusals unchanged. */
export function readSetupPose(assets:ModelAssets,slot:string,root:HTMLElement,mode:RenderMode='dom',skin?:string):SetupPose {
 const player=new RigPlayer(root,assets,{mode,slots:[slot],...(skin===undefined?{}:{skin})});
 try{
  const snapshot=player.slotIdentity(),row=snapshot.slots.find(r=>r.slot===slot);
  const identity=row&&row.attachment!==null&&row.skin!==null?{skin:row.skin,attachment:row.attachment}:null;
  return {identity,skin:snapshot.skin,reason:row?.reason??null,
   readMesh:()=>identity?readSetupMesh(assets,{slot,attachment:identity.attachment,skin:snapshot.skin}):null};
 }finally{player.dispose();}
}
/** The bone names a compiled model document declares, in stored order. */
export function modelBoneNames(model:unknown):string[] {
 const list=(model as {bones?:unknown}|null)?.bones;
 return Array.isArray(list)?list.map(b=>b&&typeof (b as {name?:unknown}).name==='string'?(b as {name:string}).name:'').filter(Boolean):[];
}
