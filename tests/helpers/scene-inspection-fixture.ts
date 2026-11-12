/** Synthetic public scene/take fixture. No project authority or real-data provenance is claimed. */
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
export const sceneHash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export async function installSceneFixture(root:string,options:{sourceStart?:number}={}){
 const manifest=JSON.parse(await readFile(join(root,'review.json'),'utf8'));
 const model=JSON.parse(await readFile(join(root,manifest.model),'utf8'));
 model.stage={x:-32,y:-16,width:64,height:64};
 await writeFile(join(root,manifest.model),JSON.stringify(model));
 const binding={path:manifest.model,sha256:sceneHash(await readFile(join(root,manifest.model)))};
 const make=(role:string,red:number)=>{const png=new PNG({width:8,height:8});for(let i=0;i<png.data.length;i+=4){png.data[i]=red;png.data[i+1]=role==='background'?160:0;png.data[i+2]=20;png.data[i+3]=role==='background'?255:i<32?255:0;}return PNG.sync.write(png);};
 const plates=[];
 for(const [role,red] of [['background',24],['foreground',230]] as const){const bytes=make(role,red),path=role+'.png';await writeFile(join(root,path),bytes);plates.push({role,path,sha256:sceneHash(bytes),width:8,height:8,rect:{...model.stage},registered:{kind:'input',ref:'inputs[0]'}});}
 const scene={schema:'rig-create/scene@1',n:1,rig:{version:1,model:binding,animation:{name:model.animations[0].name},acceptance:{signoff:{stage:'rig-review',checkpoint:null,at:'2026-11-13T00:00:00Z'},verdict:'versions[0].verdicts[0]',review_package:{path:'versions[0].review_package',sha256:'a'.repeat(64)}}},frame:{space:'rig-world-y-up',stage:model.stage},plates,layers:['background','rig','foreground']};
 const sceneBytes=JSON.stringify(scene);await writeFile(join(root,'scene.json'),sceneBytes);
 const direction={schema:'rig-create/direction@2',rig:{version:1,model:binding},scene:{n:1,path:'scene.json',sha256:sceneHash(sceneBytes)},take:{duration:8,loop:true},camera:{space:'rig-world-y-up',keys:[{time:0,box:model.stage,easing:'linear'},{time:8,box:{x:-16,y:0,width:32,height:32},easing:'hold'}]},timing:{keys:[{time:0,source_time:options.sourceStart??0,easing:'smoothstep'},{time:8,source_time:2,easing:'hold'}]}};
 await writeFile(join(root,'direction.json'),JSON.stringify(direction));
 await writeFile(join(root,'review.json'),JSON.stringify({...manifest,direction:'direction.json',scene:'scene.json'}));
 return {scene,direction,model};
}
