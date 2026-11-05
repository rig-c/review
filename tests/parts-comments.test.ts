import {expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {writePartsPackage} from './helpers/parts-package.ts';
import {loadPartsView,saveVerdict,readVerdict,verdictSource,exportPartsVerdict} from '../src/parts-view.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {resolvedCropPath} from '../src/comment-crops.ts';
import {parsePartsComment,snapImageRegion,type PartsComment} from '../src/parts-comment.ts';
import {parseStageComment} from '../src/stage-comment.ts';
import {commentFixture,candidate} from './helpers/parts-comments-package.ts';
test('parts comments: two records round-trip in verdict/2 and both exports; decoded server native RGBA equals original subrect including alpha',async()=>{
 const root=await mkdtemp(join(tmpdir(),'parts-comments-'));try{const pkg=await commentFixture(root),before=await Promise.all(pkg.files.map(f=>readFile(f.abs))),one=await preparePartsComment(pkg,candidate(pkg)),two=await preparePartsComment(pkg,{...candidate(pkg),id:'comment-two',summary:'Second edge'});
 const parts=Object.fromEntries(pkg.items.map(i=>[i.name,{outcome:'pending',note:''}]));const saved=await saveVerdict(pkg,{status:'pending',parts,comments:[one,two]});expect(saved.schema).toBe('rig-review-parts-verdict/2');expect((await readVerdict(pkg)).verdict!.comments).toEqual([one,two]);
 const crop=PNG.sync.read(await readFile(resolvedCropPath(one.nativeCrop!.path))),original=PNG.sync.read(await readFile(pkg.imagePaths[0]!));const expected=[];for(let y=3;y<12;y++)expected.push(...original.data.subarray((y*30+2)*4,(y*30+10)*4));expect([...crop.data]).toEqual(expected);expect(new Set([...crop.data].filter((_,i)=>i%4===3)).size).toBeGreaterThan(2);
 for(const format of ['json','issue'] as const){const out=exportPartsVerdict(saved,format);expect(out).toContain(one.part);for(const c of [one,two]){expect(out).toContain(c.summary);expect(out).toContain(c.crop.sha256);expect(out).toContain(c.nativeCrop!.sha256);expect(out).toContain(c.crop.path);expect(out).toContain(c.nativeCrop!.path);}expect(out).toContain('2.125');expect(out).toContain('11.375');expect(out).not.toContain('data:image');}
 expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
 const old={...saved,schema:'rig-review-parts-verdict/1'};delete (old as any).comments;await writeFile(pkg.verdictPath,JSON.stringify(old));expect((await readVerdict(pkg)).verdict!.comments).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('parts closed codec refuses empty, fractional, OOB, stale, tampered viewport/native crops, and rig schema remains closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'parts-negatives-'));try{const pkg=await commentFixture(root),c=candidate(pkg);
 expect(()=>parsePartsComment({...c,imageRegion:{...c.imageRegion,width:0}},false)).toThrow('PARTS_COMMENT_EMPTY');
 expect(()=>parsePartsComment({...c,imageRegion:{...c.imageRegion,x:2.5}},false)).toThrow('PARTS_COMMENT_FRACTIONAL');
 expect(()=>parsePartsComment({...c,frame:0},false)).toThrow('PARTS_COMMENT_INVALID');expect(()=>parseStageComment(c)).toThrow('COMMENT_MODE_MISSING');
 await expect(preparePartsComment(pkg,{...c,imageRegion:{...c.imageRegion,x:29},rigRegion:{...c.rigRegion,x:29.125}})).rejects.toThrow('PARTS_COMMENT_OUT_OF_BOUNDS');
 await expect(preparePartsComment(pkg,{...c,imageHash:'0'.repeat(64)})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 await expect(preparePartsComment(pkg,{...c,rigRegion:{...c.rigRegion,x:Math.round(c.rigRegion.x)}})).rejects.toThrow('PARTS_COMMENT_RIG_REGION');
 await expect(preparePartsComment(pkg,{...c,crop:{...c.crop,sha256:'0'.repeat(64),path:'comment-crops/'+ '0'.repeat(64)+'.png'}})).rejects.toThrow('COMMENT_CROP_INVALID');
 const ready=await preparePartsComment(pkg,c);await expect(preparePartsComment(pkg,{...ready,nativeCrop:{...ready.nativeCrop,sha256:'0'.repeat(64),path:'comment-crops/'+ '0'.repeat(64)+'.png'}},true)).rejects.toThrow('PARTS_COMMENT_NATIVE_CROP_TAMPERED');
 await writeFile(pkg.imagePaths[0]!,Buffer.from('changed'));await expect(preparePartsComment(pkg,c)).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('drag snapping is integer only; preserves fractional placement by later exact addition',()=>{expect(snapImageRegion({x:2.2,y:3.9,width:4.1,height:5.2})).toEqual({x:2,y:3,width:5,height:7});});
test('optional painting is hashed and protected; wrong canvas is refused before launch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'parts-painting-'));try{await writePartsPackage(root);const painting=join(root,'painting.png');await writeFile(painting,PNG.sync.write(new PNG({width:63,height:64})));await expect(loadPartsView(root,{painting})).rejects.toThrow('PARTS_PAINTING_SIZE');await writeFile(painting,PNG.sync.write(new PNG({width:64,height:64})));const pkg=await loadPartsView(root,{painting});expect(pkg.files.some(f=>f.abs===pkg.painting!.abs)).toBe(true);await expect(loadPartsView(root,{painting,verdict:painting})).rejects.toThrow('PARTS_VERDICT_INPUT_COLLISION');
 }finally{await rm(root,{recursive:true,force:true});}
});

import {startPartsServer} from '../src/parts-server.ts';
test('parts comment HTTP routes enforce origin/capability/closed paths and CLI exports both crops after save',async()=>{
 const root=await mkdtemp(join(tmpdir(),'parts-comment-http-'));const pkg=await commentFixture(root),capability='b'.repeat(64),server=await startPartsServer(pkg,{port:0,capability,exitOnClose:false});try{
 const origin=`http://127.0.0.1:${server.port}`,headers={'Content-Type':'application/json',Origin:origin,'X-Review-Capability':capability},post=(body:unknown,h=headers)=>fetch(origin+'/api/parts/comment',{method:'POST',headers:h,body:JSON.stringify(body)}),c=candidate(pkg);
 expect((await post(c,{'Content-Type':'application/json',Origin:origin} as any)).status).toBe(403);expect((await post(c,{...headers,Origin:'http://elsewhere'})).status).toBe(403);
 const pathInjection=await post({...c,crop:{...c.crop,path:'../../outside.png'}});expect(pathInjection.status).toBe(400);expect((await pathInjection.json()).error).toContain('PARTS_COMMENT_CROP_INVALID');
 for(const [body,name]of [[{...c,imageHash:'0'.repeat(64)},'PARTS_COMMENT_STALE_SOURCE'],[{...c,imageRegion:{...c.imageRegion,x:1.5}},'PARTS_COMMENT_FRACTIONAL'],[{...c,crop:{...c.crop,png:c.crop.png.replace('AAAA','BBBB')}},'COMMENT_CROP_INVALID']] as const){const res=await post(body);expect(res.status).toBe(400);expect((await res.json()).error).toContain(name);}
 const res=await post(c);expect(res.status).toBe(200);const one=(await res.json()).comment;await saveVerdict(pkg,{status:'pending',parts:Object.fromEntries(pkg.items.map(i=>[i.name,{outcome:'pending'}])),comments:[one]});
 for(const format of ['json','issue']){const proc=Bun.spawn([process.execPath,'src/cli.ts','parts',root,'--format',format],{stdout:'pipe',stderr:'pipe'}),text=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(await proc.exited).toBe(0);expect(error).toBe('');expect(text).toContain(one.nativeCrop.sha256);expect(text).toContain(one.crop.sha256);expect(text).not.toContain('data:image');}
 expect((await fetch(origin+'/api/parts/comment-crops/../../outside.png')).status).toBe(404);
 }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});
