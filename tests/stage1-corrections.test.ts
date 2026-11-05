import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,mkdir,rm,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeMeshPackage} from './helpers/parts-mesh-package.ts';
import {loadReview} from '../src/manifest.ts';
import {loadPartsView,saveVerdict,readVerdict} from '../src/parts-view.ts';
import {stagePartsRoutes} from '../src/stage-parts.ts';
import {chestPartFields,chestSeed,chestStatusForPart,seedFields,seedLandmarks,designatedRegions} from '../web/rebuild-client.ts';

test('two chest parts keep independent row, landmark and kept-region seeds; the global seed is a negative control',()=>{
 const region=(name:string,cx:number)=>({name,shape:'circle' as const,cx,cy:40,r:10,bone:name,spacing:4,band:2});
 const bust=(n:number)=>({apex_r:[n,50],apex_l:[n+50,50],cleavage:[n+25,40],bone_r:'r'+n,bone_l:'l'+n,alpha:.6,clearance:3});
 const a=[region('A',20),region('A2',60),region('keptA',90)],b=[region('B',120)];
 const status={parts:[{name:'A',regions:a},{name:'B',regions:b}],contour:{A:{r:15,contour:{regions:a,bust:bust(20)}},B:{contour:{regions:b,bust:bust(120)}}}};
 expect(seedFields(status,()=>undefined)?.['chest-0-cx']).toBe('20');
 const scoped=chestStatusForPart(status,'B'),next=chestPartFields(status,'B');
 expect(next.fields['chest-0-cx']).toBe('120');expect(next.fields['chest-1-cx']).toBeUndefined();expect(next.fields['chest-r']).toBeUndefined();
 expect(next.fields['lm-apex_r-x']).toBe('120');expect(next.fields['lm-bone_r']).toBe('r120');expect(next.seed.kept).toEqual([]);
 expect(seedLandmarks(status,()=>undefined)?.['lm-apex_r-x']).toBe('20');
 const read=(id:string)=>({value:next.fields[id]??''});
 expect(designatedRegions(read,chestSeed(scoped))).toEqual({regions:b});
 expect(chestPartFields({...status,contour:{...status.contour,B:{contour:{regions:b}}}},'B').mode).toBe('circles');
 expect(chestPartFields(status,'B').mode).toBe('landmarks');
});

test('a region-only handoff keeps separated-parts inspection and image routes with only correction unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stage1-regions-'));
 try{
  const parts=join(root,'out');await mkdir(parts);await writeMeshPackage(parts);await mkdir(join(parts,'rig'));await cp(join(parts,'images'),join(parts,'rig/images'),{recursive:true});
  const attachments=Object.fromEntries(['gap','covered'].map(name=>[name,{[name]:{type:'region',image:name+'.png',width:64,height:64}}]));
  await writeFile(join(parts,'rig/rig.json'),JSON.stringify({images:'images',skins:{default:attachments}}));await writeFile(join(parts,'rig/motion.json'),'{}');await writeFile(join(parts,'rig/mesh_report.json'),'[]');
  await writeFile(join(root,'config.json'),JSON.stringify({regions:{gap:'root',covered:'root'}}));
  await writeFile(join(root,'draft.model.json'),JSON.stringify({spec:'rigc-compiled/3',bones:[],slots:[],skins:[{name:'default',attachments}],pages:[]}));
  await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'regions',title:'Region draft',revision:'1',model:'draft.model.json',producer:{config:'config.json',parts:'out'}}));
  const route=stagePartsRoutes({single:await loadReview(root)}),response=await route(new Request('http://127.0.0.1/api/stage-parts')),data=await response!.json();
  expect(response!.status).toBe(200);expect(data.mode).toBe('parts');expect(data.items.map((item:any)=>item.name)).toEqual(['gap','covered']);expect(data.items.every((item:any)=>!item.mesh)).toBe(true);
  expect(data.draft).toBeUndefined();expect(data.draftUnavailable).toStartWith('STAGE_DRAFT_NO_MESH');expect(data.verdict).toBeNull();
  const image=await route(new Request('http://127.0.0.1/api/stage-parts/image/0'));expect(image!.status).toBe(200);expect((await image!.arrayBuffer()).byteLength).toBeGreaterThan(0);
 }finally{await rm(root,{recursive:true,force:true});}
});

/** Independent controls: original vs changed selected UV, wrong raster bytes, stale original, Reset. */
test('stage 1 follows the explicitly drawn draft, refuses wrong bytes, and Reset restores original geometry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stage1-'));
 try{
  await cp('examples/demo',root,{recursive:true});
  const parts=join(root,'out');await mkdir(parts);await writeMeshPackage(parts);
  await mkdir(join(parts,'rig'));for(const n of ['rig.json','mesh_report.json'])await cp(join(parts,n),join(parts,'rig',n));await cp(join(parts,'images'),join(parts,'rig/images'),{recursive:true});await writeFile(join(parts,'rig/motion.json'),'{}');
  await writeFile(join(root,'config.json'),JSON.stringify({meshes:{gap:{grid:16},covered:{grid:16}}}));
  const raw=JSON.parse(await readFile(join(parts,'rig/rig.json'),'utf8'));
  for(const attachments of Object.values(raw.skins.default)as any[])for(const mesh of Object.values(attachments)as any[])mesh.vertices=mesh.uvs.map((v:number)=>v*64);
  raw.skins.default.gap.gap.uvs[0]=.02381;await writeFile(join(parts,'rig/rig.json'),JSON.stringify(raw));
  const model={spec:'rigc-compiled/3',bones:[],slots:[],skins:[{name:'default',attachments:Object.fromEntries(Object.entries(raw.skins.default).map(([slot,atts])=>[slot,Object.fromEntries(Object.entries(atts as object).map(([name,a]:[string,any])=>[name,{...a,kind:'mesh',uvs:[...a.uvs],vertices:{weighted:false,xy:a.vertices.map(Math.fround)}}]))]))}],pages:[]};
  await writeFile(join(root,'draft.model.json'),JSON.stringify(model));
  await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'draft',title:'Generated draft',revision:'1',model:'draft.model.json',producer:{config:'config.json',parts:'out'}}));
  const originalParts=await loadPartsView(parts,{rig:join(parts,'rig/rig.json'),meshReport:join(parts,'rig/mesh_report.json')});
  await saveVerdict(originalParts,{status:'approved',parts:{gap:{outcome:'clean',mesh:{outcome:'clean'}},covered:{outcome:'clean',mesh:{outcome:'clean'}}}});
  const verdictBefore=await readFile(originalParts.verdictPath);
  const p=await loadReview(root),route=stagePartsRoutes({single:p});
  const req=(build='inspected')=>new Request('http://127.0.0.1/api/stage-parts',{headers:{'X-Review-Stage-Build':build}});
  const response=await route(req()),data=await response!.json();
  expect(response!.status).toBe(200);expect(data.mode).toBe('parts');expect(data.draft.label).toBe('Draft rig · structure evidence only');expect(data.items[0].mesh.triangles.length/3).toBe(30);
  // Both producer and compiler spell the same float32 as .02381, not its full double expansion.
  // The next float32 value is a different geometry, even though it is only one ULP away.
  const bits=new Uint32Array(new Float32Array([.02381]).buffer);bits[0]!++;const adjacent=new Float32Array(bits.buffer)[0]!;
  const wrongAdjacent=structuredClone(model);wrongAdjacent.skins[0]!.attachments.gap.gap.uvs[0]=adjacent;
  await writeFile(join(root,'draft.model.json'),JSON.stringify(wrongAdjacent));
  const wrongRoute=stagePartsRoutes({single:await loadReview(root)});expect((await (await wrongRoute(req()))!.json()).error).toStartWith('STAGE_DRAFT_MISMATCH');
  await writeFile(join(root,'draft.model.json'),JSON.stringify(model));
  const wrongVertices=structuredClone(model);wrongVertices.skins[0]!.attachments.gap.gap.vertices.xy[0]+=10;await writeFile(join(root,'draft.model.json'),JSON.stringify(wrongVertices));
  const wrongVertexRoute=stagePartsRoutes({single:await loadReview(root)});expect((await (await wrongVertexRoute(req()))!.json()).error).toStartWith('STAGE_DRAFT_MISMATCH');await writeFile(join(root,'draft.model.json'),JSON.stringify(model));
  const weightedRaw=structuredClone(raw),weightedModel=structuredClone(model);const mesh=weightedRaw.skins.default.gap.gap;mesh.weights=Array.from({length:mesh.vertices.length/2},(_,i)=>[{bone:'root',x:mesh.vertices[2*i],y:mesh.vertices[2*i+1],weight:1}]);delete mesh.vertices;weightedModel.skins[0]!.attachments.gap.gap.vertices={weighted:true,bindings:structuredClone(mesh.weights)};
  await writeFile(join(parts,'rig/rig.json'),JSON.stringify(weightedRaw));await writeFile(join(root,'draft.model.json'),JSON.stringify(weightedModel));expect((await stagePartsRoutes({single:await loadReview(root)})(req()))!.status).toBe(200);
  weightedModel.skins[0]!.attachments.gap.gap.vertices.bindings[0][0].x+=4;await writeFile(join(root,'draft.model.json'),JSON.stringify(weightedModel));expect((await (await stagePartsRoutes({single:await loadReview(root)})(req()))!.json()).error).toStartWith('STAGE_DRAFT_MISMATCH');
  const indexed=structuredClone(raw);indexed.skins.default.gap.gap.vertices=[1,0,0,0,1];indexed.skins.default.gap.gap.boneIndexing='raw';await writeFile(join(parts,'rig/rig.json'),JSON.stringify(indexed));await writeFile(join(root,'draft.model.json'),JSON.stringify(model));expect((await (await stagePartsRoutes({single:await loadReview(root)})(req()))!.json()).error).toStartWith('STAGE_DRAFT_GEOMETRY_UNSUPPORTED');
  await writeFile(join(parts,'rig/rig.json'),JSON.stringify(raw));await writeFile(join(root,'draft.model.json'),JSON.stringify(model));
  const scratch=join(root,'scratch');await cp(join(parts,'rig'),scratch,{recursive:true});
  const revised=structuredClone(raw);revised.skins.default.gap.gap.triangles.splice(-6);
  await writeFile(join(scratch,'rig.json'),JSON.stringify(revised));
  const reports=JSON.parse(await readFile(join(scratch,'mesh_report.json'),'utf8'));reports[0].triangles=28;await writeFile(join(scratch,'mesh_report.json'),JSON.stringify(reports));
  const revisedModel=structuredClone(model);revisedModel.skins[0]!.attachments.gap.gap.triangles=[...revised.skins.default.gap.gap.triangles];await writeFile(join(scratch,'draft.model.json'),JSON.stringify(revisedModel));
  const build='e'.repeat(64),appliedRoute=stagePartsRoutes({single:p},undefined,async id=>{if(id!==build)throw Error('STAGE_DRAFT_STALE');return {id,spec:scratch,model:join(scratch,'draft.model.json'),evidence:{check:{pass:true}}};});
  const applied=await (await appliedRoute(req(build)))!.json();expect(applied.items[0].mesh.triangles.length/3).toBe(28);expect(applied.sourceHash).not.toBe(data.sourceHash);expect(applied.verdict).toBeNull();
  const reset=await (await appliedRoute(req()))!.json();expect(reset.sourceHash).toBe(data.sourceHash);expect(reset.items[0].mesh.triangles.length/3).toBe(30);
  await writeFile(join(scratch,'rig.json'),'{}');expect((await appliedRoute(req(build)))!.status).toBe(409);expect((await appliedRoute(req()))!.status).toBe(200);
  expect((await (await appliedRoute(req('f'.repeat(64))))!.json()).error).toStartWith('STAGE_DRAFT_STALE');
  expect(verdictBefore.equals(await readFile(originalParts.verdictPath))).toBe(true);
  const imagePath=join(parts,'parts/gap.png'),originalImage=await readFile(imagePath);const {PNG}=await import('pngjs');const recoded=PNG.sync.write(PNG.sync.read(originalImage),{filterType:0});expect(recoded.equals(originalImage)).toBe(false);await writeFile(imagePath,recoded);
  expect((await readVerdict(await loadPartsView(parts,{rig:join(parts,'rig/rig.json'),meshReport:join(parts,'rig/mesh_report.json')}))).verdict).toBeNull();await writeFile(imagePath,originalImage);expect((await readVerdict(originalParts)).verdict?.status).toBe('approved');
  const wrong=structuredClone(model);wrong.skins[0]!.attachments.gap.gap.uvs[0]=.5;await writeFile(join(root,'draft.model.json'),JSON.stringify(wrong));
  expect((await route(req()))!.status).toBe(409);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('new chest/delta records require successful checks; historical absence remains readable, never synthesizes success',async()=>{
 const {appliedCheckRefusal,parseAppliedContext,checkSummary}=await import('../src/applied-context.ts');
 const {appliedRecord}=await import('../web/rebuild-client.ts');
 const base={schema:'rig-review-applied/1',buildId:'a'.repeat(64),part:'torso',regions:[],configHash:'b'.repeat(64),entrySha256:'c'.repeat(64),producer:{package:'@rig-c/parts',version:'1.78.0'},compiler:{package:'@rig-c/core',version:'2.81.0'},line:null,modelHash:'d'.repeat(64)};
 expect(()=>parseAppliedContext(base)).not.toThrow();expect(appliedCheckRefusal(base)).toBeNull();
 const pass=checkSummary({PASS:true},0,['check: PASS'],null);
 for(const check of [null,{...pass,pass:null},{...pass,pass:false},{...pass,exitCode:1}]){
  const record={...base,check};expect(()=>parseAppliedContext(record)).not.toThrow();expect(appliedCheckRefusal(record)).toStartWith('EDIT_SUBMIT_UNCHECKED');
 }
 const checked={...base,check:pass,stageInputHash:'e'.repeat(64),mesh:{part:'torso',before:{vertices:3,triangles:1,hull:3},after:{vertices:4,triangles:2,hull:4}}};
 expect(()=>parseAppliedContext(checked)).not.toThrow();expect(appliedCheckRefusal(checked)).toBeNull();
 expect(()=>parseAppliedContext({...checked,stageInputHash:'wrong'})).toThrow('stageInputHash');
 const record=appliedRecord({id:base.buildId,request:{part:'torso',regions:[],configHash:base.configHash,entrySha256:base.entrySha256},producer:base.producer,compiler:base.compiler,producerLine:null,build:{modelHash:base.modelHash},check:pass,stageInputHash:checked.stageInputHash,remesh:checked.mesh} as any);
 expect(record.check).toEqual(pass);expect(record.mesh).toEqual(checked.mesh);expect(record.stageInputHash).toBe(checked.stageInputHash);expect(()=>parseAppliedContext(record)).not.toThrow();
 const delta={...base,schema:'rig-review-applied/3',op:'remesh',delta:{schema:'rig-review-mesh-edit/1',basis:'setup-image-pixels-y-down',slot:'torso',source:{hash:'f'.repeat(64)},ops:[]},deltaSha256:'c'.repeat(64),files:null};delete (delta as any).regions;delete (delta as any).entrySha256;
 // Use a known parsed delta from the existing fixture contract for source/basis coverage there; the check gate is schema-specific.
 expect(appliedCheckRefusal({...delta,check:null})).toStartWith('EDIT_SUBMIT_UNCHECKED');expect(appliedCheckRefusal({...delta,check:pass})).toBeNull();
});

test('non-first part selection transfers by exact art/package/address, never by list position or name alone',async()=>{
 const {stagePartsSelectionIndex}=await import('../web/stage-nav.ts');
 const item=(name:string,hash:string)=>({name,imageHash:hash,x:10,y:20,w:64,h:64});
 const mappings=['first','second'].map(part=>({part,skin:'default',slot:part,attachment:part}));
 const saved={inspectionSourceHash:'package-a',part:'second',imageHash:'image-b',box:{x:10,y:20,w:64,h:64},mapping:{skin:'default',slot:'second',attachment:'second'},rig:{zoom:2,center:{x:22,y:28}},reference:{zoom:1,center:null},cameraSync:false,bg:'green',alpha:false,footprints:false,view:'item' as const,mesh:true};
 const data={inspectionSourceHash:'package-a',items:[item('first','image-a'),item('second','image-b')],draft:{mappings}};
 expect(stagePartsSelectionIndex(data,saved)).toBe(1);
 expect(stagePartsSelectionIndex({...data,items:[...data.items].reverse()},saved)).toBe(0);
 for(const wrong of [{...data,inspectionSourceHash:'package-b'},{...data,items:[data.items[0]!]},{...data,items:[data.items[0]!,item('second','wrong-bytes')]},{...data,draft:{mappings:[mappings[0]!,{...mappings[1]!,slot:'wrong-address'}]}}])expect(()=>stagePartsSelectionIndex(wrong,saved)).toThrow('STAGE_DRAFT_MISMATCH');
 expect(saved.rig).toEqual({zoom:2,center:{x:22,y:28}});
});
