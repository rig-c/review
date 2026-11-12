/** Closed, byte-bound inspection of Create's scene@1. Project authority remains Create-owned. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {object, packagePath, safeFile} from './manifest.ts';
import {sceneDocumentShape} from './interview-scene.ts';
import type {DirectionInspection} from './direction-inspection.ts';
export type SceneBox = {x:number;y:number;width:number;height:number};
type Binding = {path:string;sha256:string};
export interface SceneInspection {
 file:Binding;n:number;rigVersion:number;animation:string;stage:SceneBox;
 plates:{role:'background'|'foreground';path:string;sha256:string;width:number;height:number;rect:SceneBox}[];
}
const fail=(code:string,field:string):never=>{throw new Error(`${code}: ${field}`);};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Parse the full closed shape before opening its declared plate files. */
export function readSceneInspection(value:unknown,file:Binding,direction:DirectionInspection,model:Record<string,unknown>):SceneInspection{
 let d:Record<string,unknown>;try{d=object(value,'scene');}catch{return fail('SCENE_SOURCE_MISMATCH',file.path);}
 if(Array.isArray(d.plates))for(const raw of d.plates){let p:Record<string,unknown>;try{p=object(raw,'scene.plate');}catch{return fail('SCENE_SOURCE_MISMATCH','scene.plate');}
  if(!Number.isSafeInteger(p.width)||!Number.isSafeInteger(p.height)||Number(p.width)<=0||Number(p.height)<=0)fail('SCENE_PLATE_DIMENSIONS',String(p.path));}
 if(!sceneDocumentShape(d,direction.scene?.n))fail('SCENE_SOURCE_MISMATCH',file.path);
 const r=object(d.rig,'scene.rig'),m=object(r.model,'scene.rig.model'),anim=object(r.animation,'scene.rig.animation');
 if(r.version!==direction.rigVersion||m.path!==direction.model.path||m.sha256!==direction.model.sha256)fail('SCENE_MODEL_MISMATCH',file.path);
 if(!Array.isArray(model.animations)||!model.animations.some(v=>object(v,'animation').name===anim.name))fail('SCENE_ANIMATION_MISSING',String(anim.name));
 const f=object(d.frame,'scene.frame'),stage=object(f.stage,'scene.frame.stage') as SceneBox;
 const modelStage=object(model.stage,'model.stage');
 if(Object.entries(stage).some(([k,v])=>!Number.isFinite(v)||modelStage[k]!==v)||stage.width<=0||stage.height<=0)fail('SCENE_MODEL_MISMATCH','scene.frame');
 if((d.plates as unknown[]).length<1||(d.plates as unknown[]).length>2)fail('SCENE_LAYER_ORDER','scene.plates');
 const plates:SceneInspection['plates']=(d.plates as unknown[]).map((raw,index)=>{
  const name=`scene.plates[${index}]`,row=object(raw,name);
  let path:string;try{path=packagePath(row.path,name);}catch{return fail('SCENE_SOURCE_MISMATCH',name);}
  const b={path,sha256:String(row.sha256)},rect=object(row.rect,name+'.rect') as SceneBox;
  const x=rect.width*Number(row.height),y=rect.height*Number(row.width);
  if(!Object.values(rect).every(Number.isFinite)||rect.width<=0||rect.height<=0||!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x-y)>1e-9*Math.max(Math.abs(x),Math.abs(y)))fail('SCENE_PLATE_DIMENSIONS',b.path);
  return {role:row.role as 'background'|'foreground',...b,width:Number(row.width),height:Number(row.height),rect};
 });
 const expected=plates.length===2?['background','rig','foreground']:['background','rig'];
 if(plates.filter(p=>p.role==='background').length!==1||plates.filter(p=>p.role==='foreground').length!==plates.length-1||JSON.stringify(d.layers)!==JSON.stringify(expected)||new Set(plates.map(p=>p.path)).size!==plates.length||new Set(plates.map(p=>p.sha256)).size!==plates.length)fail('SCENE_LAYER_ORDER','scene.layers');
 return {file,n:Number(d.n),rigVersion:Number(r.version),animation:String(anim.name),stage,plates};
}
/** Read contained plate bytes once; these exact bytes subsequently enter the package hash. */
export async function scenePlateBytes(root:string,scene:SceneInspection):Promise<Map<string,Buffer>>{
 const result=new Map<string,Buffer>();
 for(const plate of scene.plates){
  let bytes:Buffer;try{bytes=await readFile(await safeFile(root,plate.path));}catch{return fail('SCENE_REQUIRED',plate.path);}
  if(hash(bytes)!==plate.sha256)fail('SCENE_PLATE_CHANGED',plate.path);
  if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==plate.width||bytes.readUInt32BE(20)!==plate.height)fail('SCENE_PLATE_DIMENSIONS',plate.path);
  result.set(plate.path,bytes);
 }
 return result;
}
