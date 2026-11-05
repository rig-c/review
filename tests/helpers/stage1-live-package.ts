/** Public generated structure fixture; no painting, private art or inferred authoring data. */
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
export const stage1Config={key:'stage1-structure',assemble:{rig_scale:1,plan:[['torso','full','topwear']]},bones:[{name:'chest',parent:'root',at:[120,180],tip:[120,60]}],meshes:{torso:{contour:{tolerance:1,margin:2,spacing:16,maxEdge:30,stray:0,bridges:true,regions:[{name:'right',shape:'circle',cx:90,cy:105,r:18,bone:'chest',spacing:8,band:8},{name:'left',shape:'circle',cx:150,cy:105,r:18,bone:'chest',spacing:8,band:8}]},r:16,segments:[['chest',[120,180],[120,60]]]}},regions:{},motion:{duration:1,tracks:[{bone:'chest',prop:'translatey',amp:8,period:1,phase:0}]}};
export async function writeStage1LivePackage(root:string){
 await mkdir(join(root,'out/parts'),{recursive:true});
 const image=new PNG({width:160,height:160});for(let i=0;i<160*160;i++){image.data[i*4]=80;image.data[i*4+1]=140;image.data[i*4+2]=210;image.data[i*4+3]=255;}
 await writeFile(join(root,'out/parts/torso.png'),PNG.sync.write(image));
 await writeFile(join(root,'out/parts.json'),JSON.stringify({rig_size:[240,240],scale_rig_per_source:1,ghost_px:{},parts:[{name:'torso',from:'full:topwear',x:40,y:40,w:160,h:160,opaque_px:25600,projected_core_px:25600,source_px_taken:25600,refused_drift_px:0,merged_px:0,seam_override_px:0}]}));
 await writeFile(join(root,'config.json'),JSON.stringify(stage1Config,null,1)+'\n');
}
if(import.meta.main)await writeStage1LivePackage(process.argv[2]!);
