import {writePartsPackage} from './parts-package.ts';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {createHash} from 'node:crypto';
import {loadPartsView,verdictSource} from '../../src/parts-view.ts';
import type {PartsComment} from '../../src/parts-comment.ts';
export async function commentFixture(root:string){
 await writePartsPackage(root);const path=join(root,'rig/parts.json'),doc=JSON.parse(await readFile(path,'utf8'));doc.parts[0].x=.125;doc.parts[0].y=8.375;await writeFile(path,JSON.stringify(doc));
 const png=new PNG({width:30,height:32});for(let y=0;y<32;y++)for(let x=0;x<30;x++){const i=(y*30+x)*4;png.data.set([x*7,y*5,125,(x+y)%5*51],i);}await writeFile(join(root,'rig/parts/back_defect.png'),PNG.sync.write(png));
 return loadPartsView(root);
}
export function candidate(pkg:Awaited<ReturnType<typeof loadPartsView>>):PartsComment {
 const png=PNG.sync.write(new PNG({width:4,height:5})),sha256=createHash('sha256').update(png).digest('hex');
 return {schema:'rig-review-parts-comment/1',id:'comment-one',summary:'Native alpha edge',part:'back_defect',imageHash:pkg.files.find(f=>f.abs===pkg.imagePaths[0])!.sha256,sourceHash:verdictSource(pkg).sha256,imageRegion:{x:2,y:3,width:8,height:9},rigRegion:{x:2.125,y:11.375,width:8,height:9},view:{cameraSync:false,referenceCamera:null,camera:{zoom:2,center:{x:15,y:16},viewport:{width:40,height:50}},background:'checker',alpha:true,footprints:true,mesh:false},crop:{path:`comment-crops/${sha256}.png`,sha256,png:'data:image/png;base64,'+png.toString('base64'),width:4,height:5},nativeCrop:null};
}
