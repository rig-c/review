/** Original synthetic sources; compile through the published gate, never forge a model. */
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=import.meta.dir;
await mkdir(join(root,'images'),{recursive:true});
for(const [name,color] of [['rigid','#ef2020'],['mesh','#20dc30']] as const){const c=createCanvas(20,20),x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,20,20);await writeFile(join(root,'images',name+'.png'),await c.encode('png'));}
const rig={spec:'rigc-rig/1',name:'strip-probe',images:'images',skeleton:{width:80,height:64},bones:[{name:'root'},{name:'rigid',parent:'root',x:-18,y:0},{name:'mesh',parent:'root',x:18,y:0}],slots:[{name:'rigid',bone:'rigid',attachment:'rigid'},{name:'mesh',bone:'mesh',attachment:'mesh'}],skins:{default:{rigid:{rigid:{type:'region',path:'rigid',image:'rigid.png',width:20,height:20}},mesh:{mesh:{type:'mesh',path:'mesh',image:'mesh.png',width:20,height:20,uvs:[0,1,0,0,1,0,1,1],triangles:[0,1,2,0,2,3],vertices:[-10,-10,-10,10,10,10,10,-10],hull:4}}}}};
const motion={spec:'rigc-motion/1',archetype:'strip-probe',cut:'strip-probe',easings:{},animations:{inspect:{duration:1,loop:false,tracks:[{bone:'rigid',property:'translatex',keys:[{t:0,v:[0]},{t:.5,v:[12]},{t:1,v:[0]}]},{bone:'mesh',property:'rotate',keys:[{t:0,v:[0]},{t:.5,v:[35]},{t:1,v:[-20]}]}]},still:{duration:1,loop:false,tracks:[{bone:'root',property:'translatex',keys:[{t:0,v:[0]},{t:1,v:[0]}]}]},short:{duration:.8,loop:false,tracks:[{bone:'root',property:'translatex',keys:[{t:0,v:[0]},{t:.8,v:[0]}]}]}}};
await writeFile(join(root,'rig.json'),JSON.stringify(rig,null,2)+'\n');await writeFile(join(root,'motion.json'),JSON.stringify(motion,null,2)+'\n');
function run(binary:string,args:string[]){const result=spawnSync(binary,args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.status!==0)throw new Error(`${binary} failed ${result.status}: ${result.error?.message??''}`);}
run('bunx',['--package','rig-c@2.59.0','rigc','build','--rig',join(root,'rig.json'),'--motion',join(root,'motion.json'),'--out',join(root,'build'),'--copy-images','--profile','spine','--report',join(root,'gate.json')]);
const meshOnly=structuredClone(rig);meshOnly.slots=meshOnly.slots.filter(slot=>slot.name!=='rigid');delete (meshOnly.skins.default as Record<string,unknown>).rigid;
await writeFile(join(root,'mesh-only.rig.json'),JSON.stringify(meshOnly,null,2)+'\n');
run('bunx',['--package','rig-c@2.59.0','rigc','build','--rig',join(root,'mesh-only.rig.json'),'--motion',join(root,'motion.json'),'--out',join(root,'mesh-only'),'--copy-images','--profile','spine','--report',join(root,'mesh-only.gate.json')]);
for(const [index,color] of ['#2040ee','#20ccee','#ae20ee'].entries()){const c=createCanvas(64,64),x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,64,64);x.fillStyle='white';x.fillRect(4+index*12,44,8,8);await writeFile(join(root,`reference${String(index).padStart(2,'0')}.png`),await c.encode('png'));}
run(process.env.RIG_REVIEW_FFMPEG??'ffmpeg',['-v','error','-y','-threads','1','-framerate','2','-i',join(root,'reference%02d.png'),'-frames:v','3','-c:v','png','-threads','1',join(root,'reference.mov')]);
const large=createCanvas(3840,2160),largeContext=large.getContext('2d');largeContext.fillStyle='#2040ee';largeContext.fillRect(0,0,3840,2160);await writeFile(join(root,'reference-4k.png'),await large.encode('png'));
run(process.env.RIG_REVIEW_FFMPEG??'ffmpeg',['-v','error','-y','-threads','1','-loop','1','-framerate','2','-i',join(root,'reference-4k.png'),'-frames:v','3','-c:v','png','-threads','1',join(root,'reference-4k.mov')]);
console.log('Original rigid/mesh fixture, separately gated omission control, and lossless 3-frame reference generated.');
