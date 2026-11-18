/** Public synthetic fixtures only; no producer or compiler acceptance is claimed. */
import {readFile} from 'node:fs/promises';
import type {DirectionInspection} from '../../src/direction-inspection.ts';

export async function directionPhysicsModel(){
 const model=JSON.parse(await readFile(new URL('../fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'));
 const mesh=JSON.parse(await readFile(new URL('../fixtures/strip-probe/build/skeleton.model.json',import.meta.url),'utf8'));
 model.slots=[{name:'mesh',bone:'probe',setup:'mesh'}];
 model.skins[0].attachments={mesh:mesh.skins[0].attachments.mesh};
 model.pages=mesh.pages.filter((page:{name:string})=>page.name==='mesh.png');
 model.editorOrder.skins[0].slots=['mesh'];
 model.constraints=[{kind:'physics',name:'probe_physics',declaredIn:'rig',bone:'probe',x:1,y:1,rotate:1,strength:100,damping:.85,inertia:.5,mass:1,wind:2,gravity:3,mix:1}];
 return model;
}
export function loopingDirection(timing:DirectionInspection['timing']=[{time:0,source_time:0,easing:'linear'},{time:8,source_time:2,easing:'linear'}]):DirectionInspection{
 return {file:{path:'direction.json',sha256:'a'.repeat(64)},model:{path:'skeleton.model.json',sha256:'b'.repeat(64)},rigVersion:1,take:{duration:8,loop:true},camera:{space:'rig-world-y-up',keys:[{time:0,easing:'hold',box:{x:-32,y:-16,width:64,height:64}}]},timing};
}
