/** Independent browser oracle: public Play only, never the inspection reader/evaluator. */
import {loadModel,RigPlayer,type ModelAssets} from '@rig-c/play';
let assets:ModelAssets|null=null;
let player:RigPlayer|null=null,current='';
const observed=new Map<number,Map<string,Record<string,number>>>();
export async function open(modelUrl:string){assets=await loadModel({modelUrl,setsUrl:null,regions:'none'});}
export function duration(animation:string){const clip=assets?.animations.find(a=>a.name===animation);if(!clip)throw new Error('Oracle animation missing');return clip.duration;}
export function sample(animation:string,bone:string,requested:number){
 if(!assets)throw new Error('Oracle model not loaded');
 if(!player||current!==animation){player?.dispose();observed.clear();current=animation;player=new RigPlayer(document.createElement('div'),assets,{mode:'canvas',adjust:(bones,ctx)=>{if(ctx.trackTime!==null)observed.set(ctx.trackTime,new Map(bones.names.map(name=>{const b=bones.bone(name);return [name,{rotation:b.rotation,x:b.x,y:b.y,scaleX:b.scaleX,scaleY:b.scaleY,shearX:b.shearX,shearY:b.shearY}];})));}});player.play(animation,{loop:false});}
 player.seek(requested);
 // A cached seek need not call adjust. Retain only actual public-hook observations,
 // bound to this animation and the exact held track time, never a previous time's locals.
 // Repose would clear Play's seek cache and is unnecessary for these authored scalars.
 const values=observed.get(player.time)?.get(bone);if(!values)throw new Error('ORACLE_TIME_NOT_OBSERVED: '+player.time);
 return {time:player.time,evaluated:player.time,values};
}
export function close(){player?.dispose();player=null;current='';assets?.dispose();assets=null;observed.clear();}
