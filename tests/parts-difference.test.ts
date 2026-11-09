import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {differencePixels,parsePartsComparison} from '../src/parts-comparison.ts';
import {loadPartsView,partsDifference,saveVerdict,readVerdict,exportPartsVerdict,assertPartsUnchanged} from '../src/parts-view.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {candidate} from './helpers/parts-comments-package.ts';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {resolvedCropPath} from '../src/comment-crops.ts';
const fixture=async(fn:(root:string)=>Promise<void>)=>{const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'difference-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}};

test('#390 literal raw RGB max-channel strict threshold, alpha 0 excluded and alpha 1 retained',()=>{
 const box={x:0,y:0,w:3,h:1},painting={width:3,height:1,data:Uint8Array.from([10,20,30,255,10,20,30,255,10,20,30,255])},part={width:3,height:1,data:Uint8Array.from([255,255,255,0,10,37,30,1,10,20,47,255])};
 expect(differencePixels(part,box,painting,[],16,false).count).toBe(2);
 expect(differencePixels(part,box,painting,[],17,false).count).toBe(0);
 const f={box:{x:1,y:0,w:1,h:1},raster:{width:1,height:1,data:Uint8Array.from([0,0,0,1])}};
 const on=differencePixels(part,box,painting,[f],0,true);expect(on.count).toBe(1);expect([...on.data.slice(4,8)]).toEqual([128,128,128,255]);
 expect(()=>differencePixels(part,{...box,x:.5},painting,[],0,false)).toThrow('PARTS_DIFFERENCE_ALIGNMENT');
 for(const threshold of [-1,.5,256,NaN])expect(()=>parsePartsComparison({mode:'difference',opacity:.5,threshold})).toThrow('PARTS_COMPARISON_INVALID');
 expect(parsePartsComparison({mode:'difference',opacity:.5,threshold:255}).mode).toBe('difference');
});
test('#390 uncovered original0; exactly one planted cell1; front toggle off81/on1 and strict threshold17',()=>fixture(async root=>{
 await writeDifferencePackage(root);let pkg=await loadPartsView(root);expect((await partsDifference(pkg,0,0,true)).count).toBe(0);
 await writeDifferencePackage(root,true);pkg=await loadPartsView(root);const on=await partsDifference(pkg,0,16,true);
 expect(on.count).toBe(1);expect(on.covered).toBe(80);expect([...on.data.slice((2*20+2)*4,(2*20+2)*4+4)]).toEqual([17,0,0,255]);
 expect((await partsDifference(pkg,0,0,false)).count).toBe(81);expect((await partsDifference(pkg,0,17,true)).count).toBe(0);
}));
test('#390 declared raster refuses hash, size, provenance, encoding, alpha, path, missing and symlink escape; legacy remains readable',()=>fixture(async root=>{
 await writeDifferencePackage(root);const manifest=join(root,'parts.json'),base=JSON.parse(await readFile(manifest,'utf8')),raster=join(root,'painting_in_rig.png'),original=await readFile(raster);
 const declaration=async(d:any)=>writeFile(manifest,JSON.stringify({...base,painting_in_rig:d}));
 await declaration({...base.painting_in_rig,sha256:'0'.repeat(64)});await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_HASH');
 await declaration({...base.painting_in_rig,resample:'bilinear'});await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_PROVENANCE');
 for(const path of ['../escape.png','/tmp/a.png','https://a/p.png','%2e%2e/a.png','no.png']){await declaration({...base.painting_in_rig,path});await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_PATH');}
 const outside=join(root,'../'+root.split('/').pop()+'-outside.png');await writeFile(outside,original);try{await symlink(outside,join(root,'escape.png'));await declaration({...base.painting_in_rig,path:'escape.png'});await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_PATH');}finally{await rm(outside);}
 for(const [kind,bytes]of [['SIZE',PNG.sync.write(new PNG({width:1,height:1}))],['ALPHA',(()=>{const p=PNG.sync.read(original);p.data[3]=254;return PNG.sync.write(p);})()],['PNG',PNG.sync.write(PNG.sync.read(original),{colorType:2})]] as const){await writeFile(raster,bytes);await declaration({...base.painting_in_rig,sha256:createHash('sha256').update(bytes).digest('hex')});await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_'+kind);}
 await writeFile(raster,original);await declaration(base.painting_in_rig);const pkg=await loadPartsView(root);await writeFile(raster,Buffer.from('changed'));await expect(assertPartsUnchanged(pkg)).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');
 delete base.painting_in_rig;await writeFile(manifest,JSON.stringify(base));const old=await loadPartsView(root);await expect(partsDifference(old,0,0,false)).rejects.toThrow('PARTS_DIFFERENCE_UNAVAILABLE');
}));
test('#390 difference comment save/reopen/JSON/issue preserves state and original native RGBA',()=>fixture(async root=>{
 const f=await writeDifferencePackage(root,true),pkg=await loadPartsView(root),before=await Promise.all(pkg.files.map(f=>readFile(f.abs))),c=candidate(pkg);c.parts=[{name:'body',imageHash:c.parts[0]!.imageHash}];if(!c.imageRegion)throw new Error('Expected item region');c.rigRegion={...c.imageRegion,x:6,y:7};c.view.comparison={mode:'difference',opacity:.5,threshold:16};c.view.alpha=false;
 const prepared=await preparePartsComment(pkg,c);await saveVerdict(pkg,{status:'changes-requested',issues:[prepared]});
 const saved=(await readVerdict(await loadPartsView(root))).verdict!;expect(saved.issues[0]).toEqual(prepared);
 const native=PNG.sync.read(await readFile(resolvedCropPath(prepared.nativeCrop!.path))),r=c.imageRegion;
 for(let y=0;y<r.height;y++)expect(native.data.subarray(y*r.width*4,(y+1)*r.width*4)).toEqual(f.part.data.subarray(((r.y+y)*20+r.x)*4,((r.y+y)*20+r.x+r.width)*4));
 expect(JSON.parse(exportPartsVerdict(saved,'json')).issues[0].view.comparison).toEqual(c.view.comparison);expect(exportPartsVerdict(saved,'issue')).toContain(JSON.stringify(c.view.comparison));expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
}));

test('#390 changed declared operand refuses API load, difference, crop, sign-off and export before reuse',()=>fixture(async root=>{
 await writeDifferencePackage(root,true);const pkg=await loadPartsView(root),c=candidate(pkg);c.parts=[{name:'body',imageHash:c.parts[0]!.imageHash}];if(!c.imageRegion)throw new Error('Expected item region');c.rigRegion={...c.imageRegion,x:6,y:7};c.view.comparison={mode:'difference',opacity:.5,threshold:16};
 const prepared=await preparePartsComment(pkg,c),body={status:'changes-requested',issues:[prepared]};await saveVerdict(pkg,body);
 const {startPartsServer}=await import('../src/parts-server.ts'),server=await startPartsServer(pkg,{port:0,exitOnClose:false});const base=`http://127.0.0.1:${server.port}`;
 try{
  await writeFile(join(root,'painting_in_rig.png'),Buffer.from('tampered'));
  for(const [path,method,payload] of [['/api/parts','GET',undefined],['/api/parts/difference/0?threshold=16&footprints=true','GET',undefined],['/api/parts/export?format=json','GET',undefined],['/api/parts/export?format=issue','GET',undefined],['/api/parts/comment','POST',c],['/api/parts/verdict','POST',body]] as const){
   const response=await fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});expect(response.status).toBe(409);expect((await response.json() as {error:string}).error).toContain('PARTS_VIEW_SOURCE_CHANGED');
  }
 }finally{server.stop(true);}
}));

test('#390 repair: footprint Off ignores fractional front geometry; On refuses exact alignment',()=>fixture(async root=>{
 await writeDifferencePackage(root,true);const path=join(root,'parts.json'),doc=JSON.parse(await readFile(path,'utf8'));doc.parts[1].x+=.5;await writeFile(path,JSON.stringify(doc));const pkg=await loadPartsView(root);
 expect((await partsDifference(pkg,0,0,false)).count).toBe(81);
 await expect(partsDifference(pkg,0,0,true)).rejects.toThrow('PARTS_DIFFERENCE_ALIGNMENT');
 const box={x:0,y:0,w:1,h:1},raster={width:1,height:1,data:Uint8Array.from([10,20,30,255])},front={box:{...box,x:.5},raster};
 expect(differencePixels(raster,box,raster,[front],0,false).count).toBe(0);expect(()=>differencePixels(raster,box,raster,[front],0,true)).toThrow('PARTS_DIFFERENCE_ALIGNMENT');
}));
test('#390 repair: footprint Off ignores unsupported front encoding; On refuses exact operand encoding',()=>fixture(async root=>{
 await writeDifferencePackage(root,true);const path=join(root,'parts/front.png'),png=PNG.sync.read(await readFile(path));await writeFile(path,PNG.sync.write(png,{colorType:2}));const pkg=await loadPartsView(root);
 expect((await partsDifference(pkg,0,0,false)).count).toBe(81);await expect(partsDifference(pkg,0,0,true)).rejects.toThrow('PARTS_DIFFERENCE_PNG');
}));

test('#390 refuses a directory as the declared painting path', () => fixture(async root => {
  await writeDifferencePackage(root);
  const manifest = join(root, 'parts.json');
  const doc = JSON.parse(await readFile(manifest, 'utf8'));
  doc.painting_in_rig.path = 'parts';
  await writeFile(manifest, JSON.stringify(doc));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_DIFFERENCE_PATH');
}));
