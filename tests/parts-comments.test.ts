import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {beforeAll,expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {writePartsPackage} from './helpers/parts-package.ts';
import {loadPartsView,saveVerdict,saveVerdictWithReceipt,readVerdict,readPartsVerdictJson,verdictSource,exportPartsVerdict,partsViewJson} from '../src/parts-view.ts';
import {preparePartsComment,validateStoredPartsComment} from '../src/parts-comment-crops.ts';
import {resolvedCropPath,storePngCrop} from '../src/comment-crops.ts';
import {parsePartsComment,parsePartsIssue,snapImageRegion} from '../src/parts-comment.ts';
import {parseStageComment} from '../src/stage-comment.ts';
import {commentFixture,candidate,legacyCandidate} from './helpers/parts-comments-package.ts';
// Prime the implicit spawn environment before any per-test state exists; children must get explicit state.
beforeAll(async()=>{const warmup=Bun.spawn([process.execPath,'-e','void 0'],{stdout:'ignore',stderr:'pipe'});expect(await warmup.exited).toBe(0);});
test('parts issues (/2): item and assembled multi-part records round-trip in verdict/4 and both exports; decoded server native RGBA equals original subrect including alpha',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-comments-'));try{const pkg=await commentFixture(root),before=await Promise.all(pkg.files.map(f=>readFile(f.abs))),one=await preparePartsComment(pkg,candidate(pkg)),frontHash=pkg.files.find(f=>f.abs===pkg.imagePaths[2])!.sha256,two=await preparePartsComment(pkg,{...candidate(pkg),id:'comment-two',summary:'Assembled multi-part seam',parts:[{name:'back_defect',imageHash:one.parts[0]!.imageHash},{name:'front',imageHash:frontHash}],imageRegion:null,rigRegion:{x:2,y:11,width:8,height:9},nativeCrop:null,view:{...one.view,mode:'assembled',camera:{...one.view.camera,zoom:0.25}}});
 expect(two.nativeCrop).toBeNull();
 expect(two.view.camera.zoom).toBe(0.25);
 const saved=await saveVerdict(pkg,{status:'changes-requested',issues:[one,two]});expect(saved.schema).toBe('rig-review-parts-verdict/4');expect((await readVerdict(pkg)).verdict!.issues).toEqual([one,two]);
 const {verdict:named}=await saveVerdictWithReceipt(pkg,{status:'changes-requested',issues:[one,two]},undefined,'alice');expect(named.schema).toBe('rig-review-parts-verdict/4');expect(named.by).toBe('alice');expect((await readVerdict(pkg)).verdict!.by).toBe('alice');
 const unnamedResaved=await saveVerdict(pkg,{status:'changes-requested',issues:[one,two],by:'forged-browser-by'});expect(unnamedResaved.by).toBeUndefined();expect((await readVerdict(pkg)).verdict!.by).toBeUndefined();
 const crop=PNG.sync.read(await readFile(resolvedCropPath(one.nativeCrop!.path))),original=PNG.sync.read(await readFile(pkg.imagePaths[0]!));const expected=[];for(let y=3;y<12;y++)expected.push(...original.data.subarray((y*30+2)*4,(y*30+10)*4));expect([...crop.data]).toEqual(expected);expect(new Set([...crop.data].filter((_,i)=>i%4===3)).size).toBeGreaterThan(2);
 for(const format of ['json','issue'] as const){const out=exportPartsVerdict(saved,format);expect(out).toContain('back_defect');expect(out).toContain('front');for(const c of [one,two]){expect(out).toContain(c.summary);expect(out).toContain(c.crop.sha256);expect(out).toContain(c.crop.path);}expect(out).toContain(one.nativeCrop!.sha256);expect(out).toContain(one.nativeCrop!.path);expect(out).toContain('2.125');expect(out).toContain('11.375');expect(out).not.toContain('data:image');}
 expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
 const cleanParts=Object.fromEntries(pkg.items.map(i=>[i.name,{outcome:'clean',note:''}]));
 await writeFile(pkg.verdictPath,JSON.stringify({schema:'rig-review-parts-verdict/1',mode:'parts',tool:saved.tool,source:saved.source,status:'approved',parts:cleanParts,updatedAt:saved.updatedAt}));
 expect((await readVerdict(pkg)).verdict).toMatchObject({schema:'rig-review-parts-verdict/4',status:'approved',issues:[]});
 const legacyComment={...legacyCandidate(pkg),nativeCrop:one.nativeCrop};
 await writeFile(pkg.verdictPath,JSON.stringify({schema:'rig-review-parts-verdict/2',mode:'parts',tool:saved.tool,source:saved.source,status:'changes-requested',parts:{...cleanParts,back_defect:{outcome:'flagged',note:'covered by comment'}},comments:[legacyComment],updatedAt:saved.updatedAt}));
 expect((await readVerdict(pkg)).verdict!.issues).toEqual([one]);
 await writeFile(pkg.verdictPath,JSON.stringify({schema:'rig-review-parts-verdict/2',mode:'parts',tool:saved.tool,source:saved.source,status:'changes-requested',parts:{...cleanParts,back_defect:{outcome:'flagged',note:'bare flagged note'},front:{outcome:'flagged',note:'second bare note'}},comments:[legacyComment],updatedAt:saved.updatedAt}));
 const legacyRead=await readVerdict(pkg);expect(legacyRead.verdict).toBeNull();expect(legacyRead.legacy).toEqual({schema:'rig-review-parts-verdict/2',status:'changes-requested',readOnly:true,code:'PARTS_VERDICT_LEGACY_FORMAT',flaggedCount:1,flaggedParts:[{name:'front',note:'second bare note'}],issues:[one]});
 expect(partsViewJson(pkg,legacyRead)).toMatchObject({verdict:null,legacyVerdict:legacyRead.legacy});
 const legacyJson=JSON.parse(await readPartsVerdictJson(pkg));
 expect(legacyJson).toMatchObject({schema:'rig-review-parts-verdict/2',status:'changes-requested',parts:{front:{outcome:'flagged',note:'second bare note'}}});
 const pendingParts=Object.fromEntries(pkg.items.map(i=>[i.name,{outcome:'pending',note:''}]));
 await writeFile(pkg.verdictPath,JSON.stringify({schema:'rig-review-parts-verdict/1',mode:'parts',tool:saved.tool,source:saved.source,status:'pending',parts:pendingParts,updatedAt:saved.updatedAt}));
 expect(JSON.parse(await readPartsVerdictJson(pkg))).toMatchObject({schema:'rig-review-parts-verdict/1',status:'pending'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('parts closed codec refuses empty, fractional, OOB, stale, tampered viewport/native crops, duplicate parts, and rig schema remains closed',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-negatives-'));try{const pkg=await commentFixture(root),c=candidate(pkg),old=legacyCandidate(pkg);
 expect(parsePartsComment(old,false)).toEqual(old);
 expect(parsePartsIssue(old,false,true)).toEqual(c);
 expect(()=>parsePartsIssue(old,false,false)).toThrow('PARTS_COMMENT_INVALID');
 expect(()=>parsePartsIssue({...c,parts:[]},false)).toThrow('PARTS_COMMENT_INVALID');
 expect(()=>parsePartsIssue({...c,parts:[c.parts[0]!,c.parts[0]!]},false)).toThrow('PARTS_COMMENT_INVALID');
 expect(()=>parsePartsIssue({...c,view:{...c.view,mode:'item'},imageRegion:null},false)).toThrow('PARTS_COMMENT_INVALID');
 expect(()=>parsePartsIssue({...c,view:{...c.view,mode:'assembled'}},false)).toThrow('PARTS_COMMENT_INVALID');
 expect(()=>parsePartsIssue({...c,imageRegion:null,view:{...c.view,mode:'assembled'}},false)).toThrow('PARTS_COMMENT_FRACTIONAL');
 expect(()=>parsePartsIssue({...c,imageRegion:{...c.imageRegion!,width:0}},false)).toThrow('PARTS_COMMENT_EMPTY');
 expect(()=>parsePartsIssue({...c,imageRegion:{...c.imageRegion!,x:2.5}},false)).toThrow('PARTS_COMMENT_FRACTIONAL');
 expect(()=>parsePartsIssue({...c,frame:0},false)).toThrow('PARTS_COMMENT_INVALID');expect(()=>parseStageComment(c)).toThrow('COMMENT_MODE_MISSING');
 await expect(preparePartsComment(pkg,{...c,imageRegion:{...c.imageRegion!,x:29},rigRegion:{...c.rigRegion,x:29.125}})).rejects.toThrow('PARTS_COMMENT_OUT_OF_BOUNDS');
 await expect(preparePartsComment(pkg,{...c,imageRegion:null,rigRegion:{x:50,y:50,width:10,height:10},view:{...c.view,mode:'assembled'}})).rejects.toThrow('PARTS_COMMENT_OUT_OF_BOUNDS');
 await expect(preparePartsComment(pkg,{...c,imageRegion:null,rigRegion:{x:2,y:11,width:8,height:9},view:{...c.view,mode:'assembled',camera:{...c.view.camera,zoom:0}}})).rejects.toThrow('PARTS_CAMERA_RANGE');
 await expect(preparePartsComment(pkg,{...c,imageRegion:null,rigRegion:{x:2,y:11,width:8,height:9},view:{...c.view,mode:'assembled',camera:{...c.view.camera,zoom:16.01}}})).rejects.toThrow('PARTS_CAMERA_RANGE');
 await expect(preparePartsComment(pkg,{...c,parts:[{name:'back_defect',imageHash:'0'.repeat(64)}]})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 await expect(preparePartsComment(pkg,{...c,rigRegion:{...c.rigRegion,x:Math.round(c.rigRegion.x)}})).rejects.toThrow('PARTS_COMMENT_RIG_REGION');
 await expect(preparePartsComment(pkg,{...c,crop:{...c.crop,sha256:'0'.repeat(64),path:'comment-crops/'+ '0'.repeat(64)+'.png'}})).rejects.toThrow('COMMENT_CROP_INVALID');
 const ready=await preparePartsComment(pkg,c),altered=PNG.sync.read(await readFile(resolvedCropPath(ready.nativeCrop!.path)));altered.data[0]^=1;const png=PNG.sync.write(altered),sha256=createHash('sha256').update(png).digest('hex'),nativeCrop={...ready.nativeCrop!,sha256,path:`comment-crops/${sha256}.png`};await storePngCrop({...nativeCrop,png:'data:image/png;base64,'+png.toString('base64')});await expect(preparePartsComment(pkg,{...ready,nativeCrop},true)).rejects.toThrow('PARTS_COMMENT_NATIVE_CROP_TAMPERED');
 const hugePkg={...pkg,items:pkg.items.map((it,i)=>i===0?{...it,w:5000,h:5000}:it)};
 await expect(preparePartsComment(hugePkg,{...c,imageRegion:{x:0,y:0,width:4097,height:4097},rigRegion:{x:c.rigRegion.x-c.imageRegion!.x,y:c.rigRegion.y-c.imageRegion!.y,width:4097,height:4097}})).rejects.toThrow('PARTS_COMMENT_CROP_LIMIT');
 const origFront=await readFile(pkg.imagePaths[2]!);await writeFile(pkg.imagePaths[2]!,Buffer.from('changed-unreferenced'));await expect(preparePartsComment(pkg,c)).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');await writeFile(pkg.imagePaths[2]!,origFront);
 const changedPng=PNG.sync.write(new PNG({width:pkg.items[0]!.w,height:pkg.items[0]!.h})),forgedHash=createHash('sha256').update(changedPng).digest('hex');await writeFile(pkg.imagePaths[0]!,changedPng);
 await expect(preparePartsComment(pkg,{...c,parts:[{name:'back_defect',imageHash:forgedHash}]})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 await expect(preparePartsComment(pkg,c)).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('drag snapping is integer only; preserves fractional placement by later exact addition',()=>{expect(snapImageRegion({x:2.2,y:3.9,width:4.1,height:5.2})).toEqual({x:2,y:3,width:5,height:7});});
test('optional painting is hashed and protected; wrong canvas is refused before launch',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-painting-'));try{await writePartsPackage(root);const painting=join(root,'rig','painting.png');await writeFile(painting,PNG.sync.write(new PNG({width:63,height:64})));await expect(loadPartsView(root,{painting})).rejects.toThrow('PARTS_PAINTING_SIZE');await writeFile(painting,PNG.sync.write(new PNG({width:64,height:64})));const pkg=await loadPartsView(root,{painting});expect(pkg.files.some(f=>f.abs===pkg.painting!.abs)).toBe(true);await expect(loadPartsView(root,{painting,verdict:painting})).rejects.toThrow('PARTS_VERDICT_INPUT_COLLISION');
 }finally{await rm(root,{recursive:true,force:true});}
});

import {startPartsServer} from '../src/parts-server.ts';
test('parts comment HTTP routes enforce origin/capability/closed paths and CLI exports both crops after save',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-comment-http-'));const pkg=await commentFixture(root),capability='b'.repeat(64),server=await startPartsServer(pkg,{port:0,capability,exitOnClose:false});try{
 const origin=`http://127.0.0.1:${server.port}`,headers={'Content-Type':'application/json',Origin:origin,'X-Review-Capability':capability},post=(body:unknown,h=headers)=>fetch(origin+'/api/parts/comment',{method:'POST',headers:h,body:JSON.stringify(body)}),c=candidate(pkg);
 expect((await post(c,{'Content-Type':'application/json',Origin:origin} as any)).status).toBe(403);expect((await post(c,{...headers,Origin:'http://elsewhere'})).status).toBe(403);
 const pathInjection=await post({...c,crop:{...c.crop,path:'../../outside.png'}});expect(pathInjection.status).toBe(400);expect((await pathInjection.json()).error).toContain('PARTS_COMMENT_CROP_INVALID');
 for(const [body,name]of [[{...c,parts:[{name:'back_defect',imageHash:'0'.repeat(64)}]},'PARTS_COMMENT_STALE_SOURCE'],[{...c,imageRegion:{...c.imageRegion!,x:1.5}},'PARTS_COMMENT_FRACTIONAL'],[{...c,crop:{...c.crop,png:c.crop.png!.replace('AAAA','BBBB')}},'COMMENT_CROP_INVALID'],[{...c,view:{...c.view,camera:{...c.view.camera,zoom:17}}},'PARTS_CAMERA_RANGE'],[{...c,view:{...c.view,camera:{...c.view.camera,unknown:1}}},'PARTS_COMMENT_INVALID']] as const){const res=await post(body);expect(res.status).toBe(400);expect((await res.json()).error).toContain(name);}
 const res=await post(c);expect(res.status).toBe(200);const one=(await res.json()).comment;await saveVerdict(pkg,{status:'changes-requested',issues:[one]});
 const cliState=process.env.RIG_REVIEW_STATE_DIR!;
 for(const format of ['json','issue']){const proc=Bun.spawn([process.execPath,'src/cli.ts','parts',root,'--format',format],{env:{...process.env,RIG_REVIEW_STATE_DIR:cliState},stdout:'pipe',stderr:'pipe'}),text=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(await proc.exited,error).toBe(0);expect(error).toBe('');expect(text).toContain(one.nativeCrop.sha256);expect(text).toContain(one.crop.sha256);expect(text).not.toContain('data:image');}
 expect((await fetch(origin+'/api/parts/comment-crops/../../outside.png')).status).toBe(404);
 }finally{server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('native evidence accepts distinct PNG encoding with identical RGBA; read never writes or resets a verdict on missing state',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-read-evidence-'));let server:Awaited<ReturnType<typeof startPartsServer>>|undefined;try{
 const pkg=await commentFixture(root),one=await preparePartsComment(pkg,candidate(pkg)),pixels=PNG.sync.read(await readFile(resolvedCropPath(one.nativeCrop!.path))),alternate=PNG.sync.write(pixels,{filterType:0,deflateLevel:0}),sha256=createHash('sha256').update(alternate).digest('hex');expect(sha256).not.toBe(one.nativeCrop!.sha256);
 const nativeCrop={...one.nativeCrop!,sha256,path:`comment-crops/${sha256}.png`};await storePngCrop({...nativeCrop,png:'data:image/png;base64,'+alternate.toString('base64')});
 const saved=await saveVerdict(pkg,{status:'changes-requested',issues:[{...one,nativeCrop}]});expect((await readVerdict(pkg)).verdict!.issues[0]!.nativeCrop).toEqual(nativeCrop);
 const before=await readFile(pkg.verdictPath),missing=resolvedCropPath(one.crop.path);await rm(missing);server=await startPartsServer(pkg,{port:0,exitOnClose:false});const origin=`http://127.0.0.1:${server.port}`,res=await fetch(origin+'/api/parts'),body=await res.json();expect(res.status).toBe(400);expect(body.error).toContain('COMMENT_CROP_STATE_UNAVAILABLE');expect(body.error).not.toContain(root);
 await expect(readVerdict(pkg)).rejects.toThrow('COMMENT_CROP_STATE_UNAVAILABLE');await expect(readFile(missing)).rejects.toThrow();expect(await readFile(pkg.verdictPath)).toEqual(before);
 await expect(saveVerdict(pkg,{status:'approved',issues:[]})).rejects.toThrow('COMMENT_CROP_STATE_UNAVAILABLE');expect(await readFile(pkg.verdictPath)).toEqual(before);expect(saved.status).toBe('changes-requested');
 }finally{server?.stop(true);await rm(root,{recursive:true,force:true});}
});

test('read propagates a native-pixel validation error and keeps saved outcomes intact; real source staleness stays separate',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-read-tamper-'));try{const pkg=await commentFixture(root),one=await preparePartsComment(pkg,candidate(pkg)),saved=await saveVerdict(pkg,{status:'changes-requested',issues:[one]});
 const altered=PNG.sync.read(await readFile(resolvedCropPath(one.nativeCrop!.path)));altered.data[0]=altered.data[0]!^1;const png=PNG.sync.write(altered),sha256=createHash('sha256').update(png).digest('hex'),nativeCrop={...one.nativeCrop!,sha256,path:`comment-crops/${sha256}.png`};await storePngCrop({...nativeCrop,png:'data:image/png;base64,'+png.toString('base64')});await writeFile(pkg.verdictPath,JSON.stringify({...saved,issues:[{...one,nativeCrop}]}));const before=await readFile(pkg.verdictPath);
 await expect(readVerdict(pkg)).rejects.toThrow('PARTS_COMMENT_NATIVE_CROP_TAMPERED');expect(await readFile(pkg.verdictPath)).toEqual(before);
 await writeFile(pkg.verdictPath,JSON.stringify({...saved,source:{...saved.source,sha256:'0'.repeat(64)}}));expect(await readVerdict(pkg)).toEqual({verdict:null,stale:'files'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('painting refuses external, symlink escape and non-PNG inputs by name; hashes the same accepted PNG buffer',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-painting-contract-'));try{await writePartsPackage(root);const outside=join(root,'outside.png'),inside=join(root,'rig','painting.png'),png=PNG.sync.write(new PNG({width:64,height:64}));await writeFile(outside,png);await expect(loadPartsView(root,{painting:outside})).rejects.toThrow('PARTS_PAINTING_OUTSIDE');
 await writeFile(inside,'not a PNG');await expect(loadPartsView(root,{painting:inside})).rejects.toThrow('PARTS_PAINTING_PNG');await rm(inside);const {symlink}=await import('node:fs/promises');await symlink(outside,inside);await expect(loadPartsView(root,{painting:inside})).rejects.toThrow('PARTS_PAINTING_OUTSIDE');await rm(inside);await writeFile(inside,png);
 const pkg=await loadPartsView(root,{painting:inside});expect(pkg.painting!.sha256).toBe(createHash('sha256').update(png).digest('hex'));expect([pkg.painting!.width,pkg.painting!.height]).toEqual([64,64]);expect(verdictSource(pkg).files.some(f=>f.path==='painting.png')).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('selected pre-rig comment exports the same part image and exact original evidence',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-correction-'));
 try{
  const pkg=await commentFixture(root),comment=await preparePartsComment(pkg,candidate(pkg));
  await saveVerdict(pkg,{status:'changes-requested',issues:[comment]});
  const cli=Bun.spawn([process.execPath,'src/cli.ts','parts',root,'--correction',comment.id,'--parts-file','evidence/parts.json','--format','issue'],{env:{...process.env,RIG_REVIEW_STATE_DIR:process.env.RIG_REVIEW_STATE_DIR!},stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(cli.stdout).text(),new Response(cli.stderr).text(),cli.exited]);
  expect({exit,err}).toEqual({exit:0,err:''});
  expect(out).toContain('Unresolved request');expect(out).toContain(comment.parts[0]!.imageHash);expect(out).toContain(comment.summary);expect(out).toContain('--parts-file');expect(out).not.toContain('--version');
  const json=Bun.spawn([process.execPath,'src/cli.ts','parts',root,'--correction',comment.id,'--parts-file','evidence/parts.json','--format','json'],{env:{...process.env,RIG_REVIEW_STATE_DIR:process.env.RIG_REVIEW_STATE_DIR!},stdout:'pipe',stderr:'pipe'});
  const [bytes,diagnostic,jsonExit]=await Promise.all([new Response(json.stdout).text(),new Response(json.stderr).text(),json.exited]);
  expect({jsonExit,diagnostic}).toEqual({jsonExit:0,diagnostic:''});
  expect(JSON.parse(bytes)).toMatchObject({issues:[comment],correction:{path:'described',itemId:comment.id,part:comment.parts[0]!.name,imageHash:comment.parts[0]!.imageHash,outcome:null}});

 }finally{await rm(root,{recursive:true,force:true});}
});

test('preparePartsComment and validateStoredPartsComment default to verdictSource(pkg).sha256 and accept server-trusted options.sourceHash for job stage-parts',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'parts-sourcehash-'));
 try{
  const pkg=await commentFixture(root),c=candidate(pkg),standaloneHash=verdictSource(pkg).sha256,retainedHash='e'.repeat(64);
  expect(retainedHash).not.toBe(standaloneHash);
  const standaloneReady=await preparePartsComment(pkg,c);
  expect(standaloneReady.sourceHash).toBe(standaloneHash);
  expect(await validateStoredPartsComment(pkg,standaloneReady)).toEqual(standaloneReady);
  await expect(preparePartsComment(pkg,{...c,sourceHash:retainedHash})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
  await expect(validateStoredPartsComment(pkg,{...standaloneReady,sourceHash:retainedHash})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');

  const jobReady=await preparePartsComment(pkg,{...c,id:'job-comment-1',sourceHash:retainedHash},false,{sourceHash:retainedHash});
  expect(jobReady.sourceHash).toBe(retainedHash);
  expect(jobReady.nativeCrop).not.toBeNull();
  expect(await validateStoredPartsComment(pkg,jobReady,false,{sourceHash:retainedHash})).toEqual(jobReady);
  await expect(preparePartsComment(pkg,c,false,{sourceHash:retainedHash})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
  await expect(validateStoredPartsComment(pkg,standaloneReady,false,{sourceHash:retainedHash})).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
  await expect(validateStoredPartsComment(pkg,jobReady)).rejects.toThrow('PARTS_COMMENT_STALE_SOURCE');
 }finally{await rm(root,{recursive:true,force:true});}
});
