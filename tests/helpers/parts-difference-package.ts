/** Original synthetic cells with independent literal RGB and native-alpha controls. */
import {writeComparisonPackage} from './parts-comparison-package.ts';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
export async function writeDifferencePackage(root:string,planted=false){
 const f=await writeComparisonPackage(root),bytes=await readFile(join(root,'painting.png'));
 await writeFile(join(root,'painting_in_rig.png'),bytes);
 const path=join(root,'parts.json'),doc=JSON.parse(await readFile(path,'utf8'));
 doc.painting_in_rig={path:'painting_in_rig.png',sha256:createHash('sha256').update(bytes).digest('hex'),resample:'lanczos3-rgb-opaque'};
 await writeFile(path,JSON.stringify(doc));
 if(planted){f.part.data[(2*20+2)*4]+=17;await writeFile(join(root,'parts/body.png'),PNG.sync.write(f.part));}
 return f;
}
