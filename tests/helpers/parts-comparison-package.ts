/** Public synthetic original painting and two overlapping parts; no producer or private art. */
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
export async function writeComparisonPackage(root:string,mesh=false){
 await mkdir(join(root,'parts'),{recursive:true});
 const body={name:'body',x:4,y:4,w:20,h:16},front={name:'front',x:14,y:8,w:8,h:10};
 const painting=new PNG({width:32,height:24}),part=new PNG({width:body.w,height:body.h}),cover=new PNG({width:front.w,height:front.h});
 for(let y=0;y<24;y++)for(let x=0;x<32;x++)painting.data.set([40+x*3,50+y*4,100,255],(y*32+x)*4);
 for(let y=0;y<body.h;y++)for(let x=0;x<body.w;x++){const i=(y*body.w+x)*4,j=((body.y+y)*32+body.x+x)*4;part.data.set(painting.data.subarray(j,j+4),i);}
 // Transparent RGB deliberately differs; alpha=1 retains original RGB for a premultiplication control.
 part.data.set([255,1,2,0],0);part.data[7]=1;
 for(let y=0;y<front.h;y++)for(let x=0;x<front.w;x++){const rgba=[225,70,40,255];cover.data.set(rgba,(y*front.w+x)*4);painting.data.set(rgba,((front.y+y)*32+front.x+x)*4);}
 await writeFile(join(root,'painting.png'),PNG.sync.write(painting));await writeFile(join(root,'parts/body.png'),PNG.sync.write(part));await writeFile(join(root,'parts/front.png'),PNG.sync.write(cover));
 await writeFile(join(root,'parts.json'),JSON.stringify({rig_size:[32,24],scale_rig_per_source:1,parts:[body,front].map(p=>({...p,from:'synthetic:'+p.name}))},null,2)+'\n');
 if(mesh){
  const attachment={type:'mesh',image:'body.png',width:body.w,height:body.h,uvs:[0,0,1,0,1,1,0,1],triangles:[0,1,2,0,2,3]};
  await writeFile(join(root,'rig.json'),JSON.stringify({images:'parts',skins:{default:{body:{body:attachment}}}}));
 }
 return {body,front,painting,part,cover};
}
