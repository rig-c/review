import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,mkdir,rm,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeMeshPackage} from './helpers/parts-mesh-package.ts';
import {loadReview} from '../src/manifest.ts';
import {loadPartsView,partsViewJson,saveVerdict,readVerdict} from '../src/parts-view.ts';
import {stageDraftRefusals,stagePartsRoutes} from '../src/stage-parts.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
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

test('#562(i) standalone partsViewJson omits STAGE_DRAFT_UNAVAILABLE and removes prior host while explicit/joined draft and refusals stay intact in EN and KO',async()=>{
 class CorrectionNode {
  id='';type='';textContent='';title='';children:CorrectionNode[]=[];onclick?:()=>unknown;
  constructor(public tag:string,private onRemove?:(node:CorrectionNode)=>void){}
  append(...nodes:CorrectionNode[]){this.children.push(...nodes);}
  replaceChildren(...nodes:CorrectionNode[]){this.children=nodes;}
  remove(){this.onRemove?.(this);}
 }
 const source=await readFile('web/parts.ts','utf8');
 const slice=source.slice(source.indexOf('function renderCorrections():void {'),source.indexOf('\nfunction stagePartsSnapshot('));
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(slice);
 const root=await mkdtemp(join(tmpdir(),'stage1-562-'));
 try{
  await cp('examples/demo',root,{recursive:true});
  const atlasRoute=stagePartsRoutes({single:await loadReview(join(root,'review.json'))});
  const unavailableData=await (await atlasRoute(new Request('http://127.0.0.1/api/stage-parts')))!.json();
  expect(unavailableData.draftUnavailable).toBe(stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE);
  const parts=join(root,'out');await mkdir(parts);await writeMeshPackage(parts);
  await mkdir(join(parts,'rig'));for(const n of ['rig.json','mesh_report.json'])await cp(join(parts,n),join(parts,'rig',n));await cp(join(parts,'images'),join(parts,'rig/images'),{recursive:true});await writeFile(join(parts,'rig/motion.json'),'{}');
  await writeFile(join(root,'config.json'),JSON.stringify({meshes:{gap:{grid:16},covered:{grid:16}}}));
  const raw=JSON.parse(await readFile(join(parts,'rig/rig.json'),'utf8'));
  for(const attachments of Object.values(raw.skins.default)as any[])for(const mesh of Object.values(attachments)as any[])mesh.vertices=mesh.uvs.map((v:number)=>v*64);
  await writeFile(join(parts,'rig/rig.json'),JSON.stringify(raw));
  const model={spec:'rigc-compiled/3',bones:[],slots:[],skins:[{name:'default',attachments:Object.fromEntries(Object.entries(raw.skins.default).map(([slot,atts])=>[slot,Object.fromEntries(Object.entries(atts as object).map(([name,a]:[string,any])=>[name,{...a,kind:'mesh',uvs:[...a.uvs],vertices:{weighted:false,xy:a.vertices.map(Math.fround)}}]))]))}],pages:[]};
  await writeFile(join(root,'draft.model.json'),JSON.stringify(model));
  const standalonePkg=await loadPartsView(parts,{rig:join(parts,'rig/rig.json'),meshReport:join(parts,'rig/mesh_report.json')});
  const standaloneData=partsViewJson(standalonePkg,await readVerdict(standalonePkg));
  expect(Object.hasOwn(standaloneData,'draft')).toBe(false);
  expect(Object.hasOwn(standaloneData,'draftUnavailable')).toBe(false);
  await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'draft',title:'Generated draft',revision:'1',model:'draft.model.json',producer:{config:'config.json',parts:'out'}}));
  const mappedRoute=stagePartsRoutes({single:await loadReview(root)});
  const mappedData=await (await mappedRoute(new Request('http://127.0.0.1/api/stage-parts',{headers:{'X-Review-Stage-Build':'inspected'}})))!.json();
  expect(mappedData.draft?.label).toBe('Draft rig · structure evidence only');
  const regionRoot=join(root,'region-only');await mkdir(regionRoot);const regionParts=join(regionRoot,'out');await mkdir(regionParts);await writeMeshPackage(regionParts);await mkdir(join(regionParts,'rig'));await cp(join(regionParts,'images'),join(regionParts,'rig/images'),{recursive:true});
  const regionAttachments=Object.fromEntries(['gap','covered'].map(name=>[name,{[name]:{type:'region',image:name+'.png',width:64,height:64}}]));
  await writeFile(join(regionParts,'rig/rig.json'),JSON.stringify({images:'images',skins:{default:regionAttachments}}));await writeFile(join(regionParts,'rig/motion.json'),'{}');await writeFile(join(regionParts,'rig/mesh_report.json'),'[]');
  await writeFile(join(regionRoot,'config.json'),JSON.stringify({regions:{gap:'root',covered:'root'}}));
  await writeFile(join(regionRoot,'draft.model.json'),JSON.stringify({spec:'rigc-compiled/3',bones:[],slots:[],skins:[{name:'default',attachments:regionAttachments}],pages:[]}));
  await writeFile(join(regionRoot,'review.json'),JSON.stringify({schema:'rig-review/1',id:'regions',title:'Region draft',revision:'1',model:'draft.model.json',producer:{config:'config.json',parts:'out'}}));
  const noMeshData=await (await stagePartsRoutes({single:await loadReview(regionRoot)})(new Request('http://127.0.0.1/api/stage-parts')))!.json();
  expect(noMeshData.draftUnavailable).toBe(stageDraftRefusals.STAGE_DRAFT_NO_MESH);

  for(const catalog of [enCatalog,koCatalog]as const){
   const dom:{host:CorrectionNode|null}={host:null};
   const posted:{data:unknown;origin:string}[]=[];
   const state:{selected:number;data:any}={selected:0,data:standaloneData};
   let stageEmbedded=false;
   const makeRunner=()=>{
    const scope={
     get stageEmbedded(){return stageEmbedded;},
     state,
     t:(key:string)=>catalog[key]??key,
     location:{origin:'http://127.0.0.1:4173'},
     parent:{postMessage:(data:unknown,origin:string)=>{posted.push({data,origin});}},
     document:{
      getElementById:(id:string)=>id==='pv-corrections'?dom.host:null,
      createElement:(tag:string)=>new CorrectionNode(tag,node=>{if(dom.host===node)dom.host=null;}),
      querySelector:(sel:string)=>sel==='.pv-toolbar'?{after:(node:CorrectionNode)=>{dom.host=node;}}:null,
     },
    };
    return new Function('scope',`with(scope){${code};return renderCorrections;}`)(scope) as ()=>void;
   };
   const renderCorrections=makeRunner();

   // 1. Standalone partsViewJson with no prior host omits #pv-corrections and STAGE_DRAFT_UNAVAILABLE.
   stageEmbedded=false;state.data=standaloneData;state.selected=0;
   renderCorrections();
   expect(dom.host).toBeNull();

   // 2. Joined / explicit request mounts #pv-corrections, then standalone partsViewJson removes prior host.
   stageEmbedded=true;state.data=unavailableData;
   renderCorrections();
   expect(dom.host).not.toBeNull();
   expect(dom.host!.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE!]!]);
   stageEmbedded=false;state.data=standaloneData;
   renderCorrections();
   expect(dom.host).toBeNull();

   // 3. Standalone with own draftUnavailable or own draft property retains named refusal.
   stageEmbedded=false;state.data={...standaloneData,draftUnavailable:stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE};
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE!]!]);
   state.data={...standaloneData,draftUnavailable:stageDraftRefusals.STAGE_DRAFT_NO_MESH};
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_NO_MESH!]!]);
   state.data={...standaloneData,draft:undefined};
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE!]!]);

   // 4. Joined (stageEmbedded=true) preserves no-mesh, unavailable, unmapped part, mapped buttons, and inspectionOnly.
   stageEmbedded=true;state.data=standaloneData;
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE!]!]);
   state.data=noMeshData;
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_NO_MESH!]!]);
   state.data={...mappedData,items:[...mappedData.items,{name:'unmapped',index:2}]};state.selected=2;
   renderCorrections();
   expect(dom.host?.children.map(c=>c.textContent)).toEqual([catalog[stageDraftRefusals.STAGE_DRAFT_NO_MESH!]!]);
   state.data=mappedData;state.selected=0;posted.length=0;
   renderCorrections();
   expect(dom.host?.children).toHaveLength(5);
   expect(dom.host?.children[0]!.textContent).toBe(`${catalog['Draft rig · structure evidence only']} · gap · default/gap/gap · v 25 t 30 · inspected`);
   expect(dom.host?.children.slice(1,4).map(c=>c.textContent)).toEqual([catalog['Chest regions']!,catalog['Mesh parameters']!,catalog['Edit Mesh']!]);
   expect(dom.host?.children[4]!.textContent).toBe(catalog['Use Write review, choose Parts review and name the Create draft. Export the saved item with the feedback CLI. Mesh deltas retain evidence as unsupported operations.']!);
   dom.host?.children[1]!.onclick?.();
   expect(posted).toEqual([{data:{type:'review-stage-correction',part:'gap',sourceHash:mappedData.sourceHash,buildId:'inspected',instrument:'chest'},origin:'http://127.0.0.1:4173'}]);
   state.data={...mappedData,draft:{...mappedData.draft,inspectionOnly:true}};
   renderCorrections();
   expect(dom.host?.children).toHaveLength(1);
   expect(dom.host?.children[0]!.textContent).toBe(`${catalog['Draft rig · structure evidence only']} · gap · default/gap/gap · v 25 t 30 · inspected`);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#562B joined stage 1 routes original vs scratch builds, enforces eligibility/cache/stale checks, and Reset restores original geometry',async()=>{
 const {joinedVerdictFixture}=await import('./helpers/joined-verdict-fixture.ts');
 const {loadOpenPackage}=await import('../src/open.ts');
 const root=await mkdtemp(join(tmpdir(),'stage1-562b-'));
 try{
  // Retained zero-version mesh fixture and four-version no-mesh fixture as separate controls (not five-version acceptance).
  const f=await joinedVerdictFixture(root,'1-parts-verdict');
  const scratch=join(root,'scratch-spec');
  await cp(join(root,'derived/drafts/chain/out'),scratch,{recursive:true});
  const rawRig=JSON.parse(await readFile(f.draft.rig,'utf8'));
  rawRig.skins.default.torso.torso.triangles.splice(-6);
  await writeFile(join(scratch,'rig.json'),JSON.stringify(rawRig));
  const reports=JSON.parse(await readFile(f.draft.meshReport,'utf8'));
  for(const row of Array.isArray(reports)?reports:[])if(row?.part==='torso')row.triangles=38;
  await writeFile(join(scratch,'mesh_report.json'),JSON.stringify(reports));
  const rawModel=JSON.parse(await readFile(f.draft.model,'utf8'));
  rawModel.skins[0].attachments.torso.torso.triangles=[...rawRig.skins.default.torso.torso.triangles];
  const scratchModelPath=join(scratch,'skeleton.model.json');
  await writeFile(scratchModelPath,JSON.stringify(rawModel));

  const buildId='a'.repeat(64);
  let activeBuild:string|null=buildId;
  let busyState=false;
  let flipSelectionOnAssertCall=0;
  let assertCallCount=0;
  const draftReader=async(id:string)=>{
   if(busyState||id!==activeBuild)throw new Error('STAGE_DRAFT_STALE');
   return {id,spec:scratch,model:scratchModelPath,evidence:{id,check:{pass:true,exitCode:0}}};
  };
  const joinedWithBarrier:typeof f.joined={
   ...f.joined,
   assertCurrent:async()=>{
    await f.joined.assertCurrent();
    assertCallCount++;
    if(flipSelectionOnAssertCall>0&&assertCallCount===flipSelectionOnAssertCall){
     activeBuild=null;
    }
   },
  };
  const route=stagePartsRoutes({single:f.p},undefined,draftReader,{
   joined:joinedWithBarrier,
   readInput:async req=>req.json(),
   viewOnly:false,
  });
  const req=(build='inspected',pathname='/api/stage-parts',init?:RequestInit)=>
   new Request('http://127.0.0.1'+pathname,{...init,headers:{...(init?.headers as Record<string,string>|undefined),'X-Review-Stage-Build':build}});

  // 1. Editable joined draft: `inspected` selects recorded original and omits inspectionOnly.
  const origRes=await route(req('inspected'));
  expect(origRes!.status).toBe(200);
  const origData=await origRes!.json();
  expect(origData.draft.buildId).toBe('inspected');
  expect(origData.draft.inspectionOnly).toBeUndefined();
  expect(origData.draft.mappings).toEqual([{part:'torso',skin:'default',slot:'torso',attachment:'torso',vertices:30,triangles:40}]);
  expect(origData.items.find((i:any)=>i.name==='torso').mesh.triangles.length/3).toBe(40);

  // 2. Scratch build ID selects settled applied rig, mesh report and model while keeping original rasters pinned.
  const scratchRes=await route(req(buildId));
  expect(scratchRes!.status).toBe(200);
  const scratchData=await scratchRes!.json();
  expect(scratchData.draft.buildId).toBe(buildId);
  expect(scratchData.draft.inspectionOnly).toBeUndefined();
  expect(scratchData.draft.evidence).toEqual({id:buildId,check:{pass:true,exitCode:0}});
  expect(scratchData.draft.mappings).toEqual([{part:'torso',skin:'default',slot:'torso',attachment:'torso',vertices:30,triangles:38}]);
  expect(scratchData.items.find((i:any)=>i.name==='torso').mesh.triangles.length/3).toBe(38);
  expect(scratchData.readOnly).toBe(true);
  const imgRes=await route(req(buildId,'/api/stage-parts/image/0'));
  expect(imgRes!.status).toBe(200);

  // 3. Verdict save/export on a scratch build is refused with PARTS_VERDICT_READ_ONLY.
  const verdictOnScratch=await route(req(buildId,'/api/stage-parts/verdict',{method:'POST',headers:{Origin:'http://127.0.0.1'},body:'{}'}));
  expect(verdictOnScratch!.status).toBe(409);
  expect(await verdictOnScratch!.json()).toEqual({error:'PARTS_VERDICT_READ_ONLY'});

  // 4. Reset to `inspected` restores the exact recorded original from its separate cache entry.
  const resetRes=await route(req('inspected'));
  expect(resetRes!.status).toBe(200);
  const resetData=await resetRes!.json();
  expect(resetData.draft.buildId).toBe('inspected');
  expect(resetData.draft.mappings[0].triangles).toBe(40);
  expect(resetData.items.find((i:any)=>i.name==='torso').mesh.triangles.length/3).toBe(40);

  // 5. Cache-hit revalidation catches busy state and Undo/superseding Apply (STAGE_DRAFT_STALE).
  busyState=true;
  const busyRes=await route(req(buildId));
  expect(busyRes!.status).toBe(409);
  expect((await busyRes!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_STALE);
  busyState=false;
  // Re-populate cache then simulate Undo (activeBuild = null).
  expect((await route(req(buildId)))!.status).toBe(200);
  activeBuild=null;
  const undoneRes=await route(req(buildId));
  expect(undoneRes!.status).toBe(409);
  expect((await undoneRes!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_STALE);
  activeBuild=buildId;

  // 5b. Cached Stage 1 late-read selection change control (selection flips after entry draft check, during post-cache prepared read / image read, and in the final trailing source-check await).
  for(const targetCall of [2,3]){
   expect((await route(req(buildId)))!.status).toBe(200);
   assertCallCount=0;flipSelectionOnAssertCall=targetCall;
   const lateJsonRes=await route(req(buildId));
   flipSelectionOnAssertCall=0;activeBuild=buildId;
   expect(lateJsonRes!.status).toBe(409);
   expect((await lateJsonRes!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_STALE);

   expect((await route(req(buildId)))!.status).toBe(200);
   assertCallCount=0;flipSelectionOnAssertCall=targetCall;
   const lateImgRes=await route(req(buildId,'/api/stage-parts/image/0'));
   flipSelectionOnAssertCall=0;activeBuild=buildId;
   expect(lateImgRes!.status).toBe(409);
   expect((await lateImgRes!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_STALE);
  }

  // 6. Cache-hit revalidation catches mutated scratch model bytes while keeping `inspected` intact.
  expect((await route(req(buildId)))!.status).toBe(200);
  await writeFile(scratchModelPath,JSON.stringify({...rawModel,tampered:true}));
  const tamperedModelRes=await route(req(buildId));
  expect(tamperedModelRes!.status).toBe(409);
  expect((await tamperedModelRes!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_CHANGED);
  expect((await route(req('inspected')))!.status).toBe(200);
  await writeFile(scratchModelPath,JSON.stringify(rawModel));

  // 7. Raw project.json whitespace mutation invalidates cached `inspected` and scratch reads (INTERVIEW_OPTIONS_STALE).
  const projectPath=join(root,'project.json'),projectBytes=await readFile(projectPath);
  try{
   await writeFile(projectPath,Buffer.concat([projectBytes,Buffer.from('\n')]));
   for(const target of ['inspected',buildId]){
    const staleRes=await route(req(target));
    expect(staleRes!.status).toBe(409);
    expect(await staleRes!.json()).toEqual({error:'INTERVIEW_OPTIONS_STALE'});
   }
  }finally{await writeFile(projectPath,projectBytes);}

  // 8. View-only and locked-stage (rig-review-only reopen / later approval) set inspectionOnly: true and refuse scratch builds.
  const viewOnlyRoute=stagePartsRoutes({single:f.p},undefined,draftReader,{joined:f.joined,readInput:async r=>r.json(),viewOnly:true});
  expect((await (await viewOnlyRoute(req('inspected')))!.json()).draft.inspectionOnly).toBe(true);
  expect((await (await viewOnlyRoute(req(buildId)))!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE);

  try{
   const lockedProject=JSON.parse(projectBytes.toString());
   lockedProject.stage='rig-review';
   lockedProject.signoffs=[{stage:'parts-review',by:'reviewer',at:'2026-04-01T00:00:00.000Z'}];
   lockedProject.reopens=[{stage:'rig-review',by:'reviewer',at:'2026-04-02T00:00:00.000Z'}];
   await writeFile(projectPath,JSON.stringify(lockedProject));
   const lockedOpen=await loadOpenPackage({input:f.input,project:{root,draftId:f.project.draftId,picksDir:f.project.picksDir}});
   if(lockedOpen.mode!=='single'||!lockedOpen.joined?.draft)throw new Error('Expected locked joined draft');
   expect(lockedOpen.joined.draft.editable).toBe(false);
   const lockedRoute=stagePartsRoutes({single:lockedOpen.p},undefined,draftReader,{joined:lockedOpen.joined,readInput:async r=>r.json(),viewOnly:false});
   expect((await (await lockedRoute(req('inspected')))!.json()).draft.inspectionOnly).toBe(true);
   expect((await (await lockedRoute(req(buildId)))!.json()).error).toBe(stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE);
  }finally{await writeFile(projectPath,projectBytes);}

  await rm(scratch,{recursive:true,force:true});
  await f.assertFixture();
 }finally{await rm(root,{recursive:true,force:true});}
});
