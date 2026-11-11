import {createRigViewControls} from './helpers/rig-view-controls.ts';
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
  await saveVerdict(originalParts,{status:'approved',issues:[]});
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
     CustomEvent:class{constructor(public type:string,public options:any){}get detail(){return this.options.detail;}},
     slots:{stage:{append:(node:CorrectionNode)=>{dom.host=node;},dispatchEvent:(event:any)=>{posted.push({data:event.detail,origin:'http://127.0.0.1:4173'});}}},
     query:(selector:string)=>selector==='#pv-corrections'?dom.host:null,
     doc:{
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

test('#562(ii) handoffText renders joined draft provenance vs installed tools without synthetic handoff, and Stage 1 pre-rig setup instruments load, transact, apply, undo, and reset a verified live preview model while preserving preceding state on race or failure',async()=>{
 const {createCanvas,Image}=await import('@napi-rs/canvas');
 const {RigPlayer,loadModel}=await import('@rig-c/play');
 const {loadModelDocument}=await import('../src/environment.ts');
 const {PartExplorer,partCatalog,partBounds}=await import('../web/part-selection.ts');
 const {PartThumbnails,pageRegionTable}=await import('../web/part-thumbnails.ts');
 const {createViewportState,createViewportController}=await import('../web/viewport-controller.ts');
 const {createRigViewportProvider}=await import('../web/rig-viewport-provider.ts');
 const {singleEligibility}=await import('../src/comparison-eligibility.ts');
 const {rendererStatus}=await import('../web/renderer-status.ts');
 const {selectedInspector}=await import('../web/workspace-ui.ts');
 const {bindInspectorTabs}=await import('../web/view-controls.ts');
 const {modelBoneNames,readSetupPose}=await import('../web/setup-pose.ts');
 const {chestInputIds,chestRegionRows,chestRowId,evaluateChestForm}=await import('../web/chest-regions-tool.ts');
 const {LANDMARKS}=await import('../web/chest-editor.ts');
 const {cropWorldMapping}=await import('../src/chest-regions.ts');
 const {meshEditSource}=await import('../web/mesh-editor.ts');
 const {
  handoffText,
  appliedRecord,
  patchAppliedRecord,
  deltaAppliedRecord,
  recordFor,
  outcomeLine,
  patchOutcomeLine,
  deltaOutcomeLine,
  MESH_DELTA_APPLIED_SOURCE,
  stageModel,
  chestStatusForPart,
  designatedRegions,
  chestSeed,
  noContourReason,
  pickPart,
 }=await import('../web/rebuild-client.ts');

 const draftStatus={
  available:true,
  handoff:null,
  baseline:null,
  draft:{
   id:'chain',
   kind:'draft-rig' as const,
   at:'2026-04-01T00:00:00.000Z',
   producer:{name:'@rig-c/parts',version:'1.48.0'},
   editable:true,
   config:{path:'derived/drafts/chain/config.json',sha256:'1234567890abcdef'.repeat(4)},
   parts:{path:'derived/drafts/chain/input',files:[]},
   files:[],
  },
  producer:{package:'@rig-c/parts',version:'1.49.0'},
  compiler:{package:'rig-c',version:'2.64.1'},
  reason:null,
 };
 const shown=handoffText(draftStatus as any);
 expect(shown.error).toBe(false);
 expect(shown.text).toBe('Draft chain (@rig-c/parts 1.48.0): derived/drafts/chain/config.json sha256 1234567890ab… · parts derived/drafts/chain/input · installed @rig-c/parts 1.49.0 · rig-c 2.64.1');
 expect(shown.text).not.toContain('Handoff ');

 const lockedShown=handoffText({
  ...draftStatus,
  available:false,
  draft:{...draftStatus.draft,editable:false},
  reason:'PARTS_VERDICT_READ_ONLY: Stage 1 sign-off is already recorded',
 } as any);
 expect(lockedShown.error).toBe(true);
 expect(lockedShown.text).toContain('PARTS_VERDICT_READ_ONLY: Stage 1 sign-off is already recorded');

 // Build real compiled model documents (clipped inspected, clipped scratch, unclipped scratch) backed by strip-probe PNG pages.
 const stripBase=new URL('./fixtures/strip-probe/build/',import.meta.url);
 const pageBytes=new Map<string,Buffer>();
 for(const name of ['rigid.png','mesh.png'])pageBytes.set(name,await readFile(new URL(name,stripBase)));
 const baseModel=JSON.parse(await readFile(new URL('skeleton.model.json',stripBase),'utf8'));
 const makeDoc=(
  bones:Array<{name:string;parent?:string;x?:number;y?:number}>,
  triangles:number[],
  opts?:{clipPolygon?:number[];animationName?:string},
 )=>{
  const doc=structuredClone(baseModel);
  doc.stage={x:-32,y:0,width:64,height:64};
  doc.bones=bones;
  const hasClip=Array.isArray(opts?.clipPolygon)&&opts!.clipPolygon!.length>=6;
  doc.slots=[
   ...(hasClip?[{name:'clip_mask',bone:'root',setup:'clip_mask'}]:[]),
   {name:'torso',bone:'torso_bone',setup:'torso'},
  ];
  doc.skins=[{
   name:'default',
   bones:[],
   constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},
   attachments:{
    ...(hasClip?{
     clip_mask:{
      clip_mask:{
       kind:'clipping',
       end:'torso',
       vertexCount:opts!.clipPolygon!.length/2,
       vertices:{weighted:false,xy:opts!.clipPolygon!},
      },
     },
    }:{}),
    torso:{
     torso:{
      kind:'mesh',
      path:'mesh',
      uvs:[0,0,1,0,1,1,0,1,0.5,0.5],
      triangles,
      hull:4,
      vertices:{weighted:false,xy:[-10,10,10,10,10,-10,-10,-10,0.25,-0.5]},
      width:20,
      height:20,
     },
    },
   },
  }];
  doc.animations=opts?.animationName?[{
   name:opts.animationName,
   duration:1,
   bones:[{name:'root',timelines:[{name:'translatex',keys:[{time:0,value:0},{time:1,value:0}]}]}],
   slots:[],
   constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},
   attachments:[],
   drawOrder:[],
   events:[],
  }]:[];
  doc.editorOrder={
   skins:[{name:'default',slots:hasClip?['clip_mask','torso']:['torso']}],
   animations:opts?.animationName?[opts.animationName]:[],
  };
  return doc;
 };
 const sha256Hex=(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
 const inspectedClipPolygon=[-12,12,12,12,12,-12,-12,-12];
 const inspectedClipCss='polygon(-12px -12px,12px -12px,12px 12px,-12px 12px)';
 const inspectedDoc=makeDoc(
  [{name:'root',x:0,y:0},{name:'torso_bone',parent:'root',x:2,y:4}],
  [0,1,4,1,2,4,2,3,4,3,0,4],
  {clipPolygon:inspectedClipPolygon,animationName:'idle_inspected'},
 );
 const inspectedBytes=new TextEncoder().encode(JSON.stringify(inspectedDoc));
 const inspectedHash=sha256Hex(inspectedBytes);

 const scratchId='a'.repeat(64);
 const scratchClipPolygon=[-20,18,20,18,20,-18,-20,-18];
 const scratchClipCss='polygon(-20px -18px,20px -18px,20px 18px,-20px 18px)';
 const scratchDoc=makeDoc(
  [{name:'root',x:0,y:0},{name:'torso_bone',parent:'root',x:2,y:4},{name:'scratch_rib',parent:'torso_bone',x:1,y:2}],
  [0,1,4,1,2,4,2,3,4],
  {clipPolygon:scratchClipPolygon,animationName:'idle_scratch'},
 );
 const scratchBytes=new TextEncoder().encode(JSON.stringify(scratchDoc));
 const scratchHash=sha256Hex(scratchBytes);

 const unclippedScratchId='b'.repeat(64);
 const unclippedScratchDoc=makeDoc(
  [{name:'root',x:0,y:0},{name:'torso_bone',parent:'root',x:2,y:4}],
  [0,1,4,1,2,4,2,3,4],
 );
 const unclippedScratchBytes=new TextEncoder().encode(JSON.stringify(unclippedScratchDoc));
 const unclippedScratchHash=sha256Hex(unclippedScratchBytes);

 const globals=globalThis as unknown as Record<string,unknown>;
 const savedGlobals=new Map(['document','Image','fetch','HTMLElement','HTMLInputElement','HTMLImageElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const srcDesc=Object.getOwnPropertyDescriptor(Image.prototype,'src')!;
 class LocalImage extends Image {}
 Object.defineProperty(LocalImage.prototype,'src',{
  get(){return srcDesc.get!.call(this);},
  set(value:unknown){
   const u=typeof value==='string'?new URL(value):null;
   const file=u?u.pathname.split('/').pop()??'':'';
   const img=pageBytes.get(file);
   if(!img)throw new Error(`Undeclared fixture image: ${String(value)}`);
   srcDesc.set!.call(this,img);
  },
 });

 const matchesSelector=(node:any,sel:string):boolean=>{
  if(node.selector===sel)return true;
  if(sel.startsWith('.'))return typeof node.className==='string'&&node.className.split(/\s+/).includes(sel.slice(1));
  if(sel.startsWith('#'))return node.id===sel.slice(1);
  if(sel==='[data-view]')return node.dataset?.view!==undefined;
  if(sel==='[data-inspector][aria-selected=true],[data-inspector][aria-pressed=true]'){
   return node.dataset?.inspector!==undefined&&(node.getAttribute('aria-selected')==='true'||node.getAttribute('aria-pressed')==='true');
  }
  const attrMatch=/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if(attrMatch){
   const [,attr,val]=attrMatch;
   const dataKey=attr!.startsWith('data-')?attr!.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()):null;
   const actual=node.getAttribute(attr!)??(dataKey?node.dataset?.[dataKey]:undefined);
   return val===undefined?actual!==null&&actual!==undefined:actual===val;
  }
  return node.tagName===sel.toUpperCase();
 };

 class FakeHTMLElement {
  tag:string;
  tagName:string;
  id:string;
  selector='';
  private _value='';
  get value():string{return this._value;}
  set value(v:string){
   const next=String(v??'');
   this._value=this.tag==='select'?(this.options.some(o=>o.value===next)?next:''):next;
  }
  defaultValue='';
  checked=false;
  defaultChecked=false;
  disabled=false;
  readOnly=false;
  hidden=false;
  title='';
  className='';
  type='';
  clientWidth=320;
  clientHeight=240;
  style:Record<string,string>={clipPath:'',left:'',top:'',transform:'',transformOrigin:''};
  dataset:Record<string,string>={};
  parentElement:FakeHTMLElement|null=null;
  childNodes:FakeHTMLElement[]=[];
  children:FakeHTMLElement[]=[];
  options:FakeHTMLElement[]=[];
  attrs=new Map<string,string>();
  onclick:(()=>void)|null=null;
  onchange:(()=>void)|null=null;
  private content='';
  classList={
   toggle:(cls:string,force?:boolean)=>{
    const set=new Set(this.className.split(/\s+/).filter(Boolean));
    const on=force===undefined?!set.has(cls):force;
    if(on)set.add(cls);else set.delete(cls);
    this.className=[...set].join(' ');
   },
  };
  constructor(tag:string,id=''){
   this.tag=tag.toLowerCase();
   this.tagName=tag.toUpperCase();
   this.id=id;
  }
  get textContent():string{
   return this.content+this.children.map(c=>c.textContent).join('');
  }
  set textContent(v:string){
   for(const c of this.children)c.parentElement=null;
   this.children=[];
   this.childNodes=[];
   if(this.tag==='select'){this.options=[];this._value='';}
   this.content=String(v??'');
  }
  setAttribute(k:string,v:string){
   this.attrs.set(k,String(v));
   if(k.startsWith('data-')){
    const key=k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    this.dataset[key]=String(v);
   }
  }
  getAttribute(k:string){
   if(this.attrs.has(k))return this.attrs.get(k)!;
   if(k.startsWith('data-')){
    const key=k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(key in this.dataset)return this.dataset[key]!;
   }
   return null;
  }
  removeAttribute(k:string){
   this.attrs.delete(k);
   if(k.startsWith('data-')){
    const key=k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    delete this.dataset[key];
   }
  }
  contains(target:FakeHTMLElement|null):boolean{
   return !!target&&(target===this||this.children.some(c=>c.contains(target)));
  }
  append(...items:(FakeHTMLElement|string)[]){
   for(const child of items){
    const item=typeof child==='string'?Object.assign(new FakeHTMLElement('span'),{textContent:child}):child;
    if(item.parentElement){
     item.parentElement.children=item.parentElement.children.filter(c=>c!==item);
     item.parentElement.childNodes=item.parentElement.childNodes.filter(c=>c!==item);
    }
    item.parentElement=this;
    this.childNodes.push(item);
    this.children.push(item);
   }
   if(this.tag==='select')this.options=this.children;
  }
  appendChild(item:FakeHTMLElement){
   this.append(item);
   return item;
  }
  prepend(...items:FakeHTMLElement[]){
   for(const item of [...items].reverse()){
    if(item.parentElement){
     item.parentElement.children=item.parentElement.children.filter(c=>c!==item);
     item.parentElement.childNodes=item.parentElement.childNodes.filter(c=>c!==item);
    }
    item.parentElement=this;
    this.childNodes.unshift(item);
    this.children.unshift(item);
   }
   if(this.tag==='select')this.options=this.children;
  }
  replaceChildren(...items:FakeHTMLElement[]){
   for(const c of this.children)c.parentElement=null;
   this.childNodes=[];
   this.children=[];
   this.content='';
   this.append(...items);
   if(this.tag==='select'){this.options=this.children;this._value=this.options[0]?.value??'';}
  }
  remove(){
   if(this.parentElement){
    this.parentElement.children=this.parentElement.children.filter(c=>c!==this);
    this.parentElement.childNodes=this.parentElement.childNodes.filter(c=>c!==this);
    this.parentElement=null;
   }
   if(this.id)elements.delete(this.id);
  }
  addEventListener(){}
  dispatchEvent(){return true;}
  focus(){}
  click(){this.onclick?.();}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:this.clientHeight,x:0,y:0,toJSON(){}};}
  querySelector(sel:string):FakeHTMLElement|null{return this.querySelectorAll(sel)[0]??null;}
  querySelectorAll(sel:string):FakeHTMLElement[]{
   const out:FakeHTMLElement[]=[];
   for(const child of this.children){
    if(matchesSelector(child,sel))out.push(child);
    out.push(...child.querySelectorAll(sel));
   }
   return out;
  }
 }
 class FakeHTMLInputElement extends FakeHTMLElement {}

 const makeNode=(tag:string,id=''):FakeHTMLElement=>tag==='input'?new FakeHTMLInputElement(tag,id):new FakeHTMLElement(tag,id);

 const elements=new Map<string,FakeHTMLElement>();
 const bodyNode=makeNode('body','body');
 const ensureEl=(id:string,tag='div')=>{
  if(!elements.has(id)){
   const n=makeNode(tag,id);
   elements.set(id,n);
   bodyNode.append(n);
  }
  return elements.get(id)!;
 };
 const rigPane=ensureEl('rig-pane','div');
 const rigViewport=ensureEl('rig-viewport','div');
 const rigRoot=ensureEl('rig-root','div');
 rigRoot.style.clipPath='inset(2px)';
 rigViewport.append(rigRoot);
 rigPane.append(rigViewport);
 const rigEmpty=ensureEl('rig-empty','div');
 rigEmpty.hidden=false;

 const refPane=ensureEl('reference-pane','div');
 const refViewport=ensureEl('reference-viewport','div');
 const refContent=ensureEl('reference-content','div');
 refViewport.append(refContent);
 refPane.append(refViewport);

 ensureEl('player-state','span').textContent='No rig supplied · reference review is available';
 ensureEl('renderer-state','span');
 ensureEl('layout-state','span');
 ensureEl('view-menu-label','span');
 ensureEl('zoom-value','span');
 ensureEl('coordinates','span');
 ensureEl('view-coordinates','pre');
 ensureEl('fit','button');
 ensureEl('camera-sync','input');
 ensureEl('event-log','span');
 const animSelectEl=ensureEl('animation-select','select');
 animSelectEl.disabled=true;
 const partSetEl=ensureEl('part-set','select');
 partSetEl.disabled=true;

 ensureEl('applied-status','span');
 ensureEl('applied-records','section');
 ensureEl('applied-list','div');
 ensureEl('rebuild-applied','textarea');
 ensureEl('chest-regions','div');
 ensureEl('chest-mapping','span');
 ensureEl('chest-status','span');
 ensureEl('chest-crop-w','input');
 ensureEl('chest-crop-h','input');
 ensureEl('lm-bones','datalist');
 for(const row of chestRegionRows){
  ensureEl(chestRowId(row,'bone'),'select');
  for(const field of ['name','cx','cy','ax','ay','band','spacing','clip'] as const)ensureEl(chestRowId(row,field),'input');
 }
 for(const id of ['layer-images','layer-mesh','layer-bones','bust-mode']){
  const inputEl=ensureEl(id,'input');
  if(id.startsWith('layer-'))inputEl.disabled=true;
 }
 const chestEditBtn=ensureEl('chest-edit','button');
 chestEditBtn.setAttribute('aria-pressed','false');
 chestEditBtn.onclick=()=>chestEditBtn.setAttribute('aria-pressed',chestEditBtn.getAttribute('aria-pressed')==='true'?'false':'true');
 const meshEditBtn=ensureEl('mesh-edit','button');
 meshEditBtn.setAttribute('aria-pressed','false');
 meshEditBtn.onclick=()=>meshEditBtn.setAttribute('aria-pressed',meshEditBtn.getAttribute('aria-pressed')==='true'?'false':'true');
 ensureEl('applied-undo','button');

 const viewbar=makeNode('div','viewbar');
 viewbar.className='viewbar';
 bodyNode.append(viewbar);
 for(const layout of ['compare','reference','rig'] as const){
  const btn=makeNode('button',`view-btn-${layout}`);
  btn.setAttribute('data-view',layout);
  btn.setAttribute('aria-pressed',String(layout==='reference'));
  viewbar.append(btn);
 }
 const inspectorTabs:FakeHTMLElement[]=[];
 for(const tab of ['view','rig','playback'] as const){
  const btn=makeNode('button',`inspector-tab-${tab}`);
  btn.setAttribute('data-inspector',tab);
  btn.setAttribute('aria-selected',String(tab==='view'));
  inspectorTabs.push(btn);
  bodyNode.append(btn);
 }

 const workspaceLeft=ensureEl('workspace-left','aside');
 for(const [selector,tag] of [['[data-part-search]','input'],['[data-part-list]','ul'],['[data-part-solo]','input'],['[data-part-whole]','button'],['[data-part-status]','p']] as const){
  const child=makeNode(tag);
  child.selector=selector;
  const attr=/^\[([a-z-]+)\]$/.exec(selector)![1]!;
  child.setAttribute(attr,'');
  workspaceLeft.append(child);
 }
 ensureEl('selected-part','section');

 const fakeDocument:any={
  baseURI:'http://127.0.0.1:4173/',
  body:bodyNode,
  activeElement:bodyNode,
  getElementById:(id:string)=>elements.get(id)??bodyNode.querySelector(`#${id}`),
  createElement:(tag:string)=>{
   if(tag==='canvas'){
    const raw=createCanvas(64,64) as any;
    const node=makeNode('canvas');
    return Object.assign(raw,{
     tag:'canvas',
     tagName:'CANVAS',
     id:'',
     selector:'',
     className:'',
     hidden:false,
     title:'',
     style:{clipPath:'',left:'',top:'',transform:'',transformOrigin:''},
     dataset:node.dataset,
     attrs:node.attrs,
     parentElement:null,
     childNodes:[],
     children:[],
     setAttribute:node.setAttribute.bind(raw),
     getAttribute:node.getAttribute.bind(raw),
     removeAttribute:node.removeAttribute.bind(raw),
     contains:node.contains.bind(raw),
     append:node.append.bind(raw),
     appendChild:node.appendChild.bind(raw),
     prepend:node.prepend.bind(raw),
     replaceChildren:node.replaceChildren.bind(raw),
     remove:node.remove.bind(raw),
     querySelector:node.querySelector.bind(raw),
     querySelectorAll:node.querySelectorAll.bind(raw),
    });
   }
   const n=makeNode(tag);
   return n;
  },
  querySelector:(sel:string)=>bodyNode.querySelector(sel),
  querySelectorAll:(sel:string)=>bodyNode.querySelectorAll(sel),
 };

 const modelResponses=new Map<string,{bytes:Uint8Array;hook?:()=>Promise<void>}>([
  ['http://127.0.0.1:4173/assets/build/skeleton.model.json',{bytes:inspectedBytes}],
  [`http://127.0.0.1:4173/rebuild/${scratchId}/skeleton.model.json`,{bytes:scratchBytes}],
  [`http://127.0.0.1:4173/rebuild/${unclippedScratchId}/skeleton.model.json`,{bytes:unclippedScratchBytes}],
 ]);

 let inspectorBinding:ReturnType<typeof bindInspectorTabs>|null=null;
 try{
  globals.Image=LocalImage;
  globals.HTMLImageElement=LocalImage;
  globals.document=fakeDocument;
  globals.HTMLElement=FakeHTMLElement;
  globals.HTMLInputElement=FakeHTMLInputElement;
  globals.fetch=new Proxy(fetch,{
   apply:async(_t,_s,args:Parameters<typeof fetch>)=>{
    const url=String(args[0]);
    const entry=modelResponses.get(url);
    if(!entry)return new Response('not found',{status:404});
    if(entry.hook)await entry.hook();
    return new Response(new Uint8Array(entry.bytes),{status:200,headers:{'Content-Type':'application/json'}});
   },
  });

  const mainSource=await readFile('web/main.ts','utf8');
  const sliceBetween=(start:string,end:string)=>{
   const a=mainSource.indexOf(start),b=mainSource.indexOf(end,a);
   if(a<0||b<a)throw new Error(`Missing slice ${start} .. ${end}`);
   return mainSource.slice(a,b);
  };
  let fitCameraHook:(()=>void)|null=null;
  const mainSlice=[
   sliceBetween('const viewportState=createViewportState();','connectLiveWindow(access);').replace('const {fitCamera,','const {')+'\nconst fitCamera=()=>{viewport.fitCamera();onFitCamera?.();};',
   sliceBetween('let partModel:unknown=null;','let referenceSize:').replace('let inspectorTabs:ReturnType<typeof bindInspectorTabs>|null=null;','let inspectorTabs=stageInspectorTabs;'),
   sliceBetween('function setView(','function setReferenceInput('),
   sliceBetween('function drawRig(','function chooseAnimation('),
   sliceBetween('function stageLoadInputs(','async function initPlayer('),
   sliceBetween('function showInspector(','function bindInspector('),
   sliceBetween('function chestField(','const environmentInputs='),
   sliceBetween('function boneSetup(','async function exportMesh('),
   sliceBetween('async function undoApply(','(window as unknown as {rigReviewEditor:unknown}).rigReviewEditor='),
   sliceBetween('async function applyRetarget(','/** The handoff line (#101):'),
   sliceBetween('async function resetRebuild(','async function swapRig('),
   mainSource.slice(mainSource.indexOf('interface StageDraftModelTarget')),
   sliceBetween('parts=new PartExplorer(','animationPanel=new AnimationInspectionPanel('),
  ].join('\n');
  const transpiler=new Bun.Transpiler({loader:'ts',target:'bun'});
  const mainCode=transpiler.transformSync(mainSlice);

  const disposedAssets:unknown[]=[];
  const disposedPlayers:unknown[]=[];
  const wrappedLoadModel=async(opts:Parameters<typeof loadModel>[0])=>{
   const a=await loadModel(opts);
   const origDispose=a.dispose.bind(a);
   a.dispose=()=>{disposedAssets.push(a);origDispose();};
   return a;
  };
  class TrackedRigPlayer extends RigPlayer {
   override dispose(){
    disposedPlayers.push(this);
    super.dispose();
   }
  }

  const stagePayloads:Record<string,any>={
   inspected:{
    sourceHash:'hash-inspected',
    inspectionSourceHash:'insp-source-1',
    draft:{buildId:'inspected',mappings:[{part:'torso',slot:'torso',skin:'default',attachment:'torso',vertices:5,triangles:4}]},
   },
   [scratchId]:{
    sourceHash:'hash-scratch',
    inspectionSourceHash:'insp-source-1',
    draft:{buildId:scratchId,mappings:[{part:'torso',slot:'torso',skin:'default',attachment:'torso',vertices:5,triangles:3}]},
   },
   [unclippedScratchId]:{
    sourceHash:'hash-unclipped',
    inspectionSourceHash:'insp-source-1',
    draft:{buildId:unclippedScratchId,mappings:[{part:'torso',slot:'torso',skin:'default',attachment:'torso',vertices:5,triangles:3}]},
   },
  };
  let failStageBuild:string|null=null;
  let stagePartsCallCount=0;
  let onStagePartsCall:((call:number,buildId:string)=>Promise<void>|void)|null=null;
  let failSelectAfterSelectOnce=false;
  let clearPreviewCalls=0;
  let playPreviewCalls=0;
  let idleModelHook:(()=>void)|null=null;
  const refreshedBuilds:string[]=[];
  const messages:{text:string;error:boolean}[]=[];
  const chestNotices:{text:string|null;error:boolean}[]=[];

  const makeBuiltJob=(id:string,hash:string)=>({
   id,
   kind:'patch' as const,
   op:'remesh' as const,
   status:'built' as const,
   reused:false,
   lines:['remesh ok','check: PASS'],
   producerLine:'remesh ok',
   exitCode:0,
   wallMs:{op:10,compile:10,check:5},
   check:{pass:true,exitCode:0,line:'check: PASS',source:'remesh'},
   diff:{count:1,paths:['/meshes/torso/density']},
   build:{modelUrl:`/rebuild/${id}/skeleton.model.json`,modelHash:hash,files:{}},
   request:{patch:{schema:'rig-review-config-patch/1',config_sha256:draftStatus.draft.config.sha256,ops:[{op:'add',path:'/meshes/torso/density',value:16}],producer:{name:'@rig-c/parts',version:'1.49.0'},op:{cmd:'remesh',args:['--part','torso']}},patchSha256:'patch-sha-123456',configHash:draftStatus.draft.config.sha256},
   producer:{package:'@rig-c/parts',version:'1.49.0'},
   compiler:{package:'rig-c',version:'2.64.1'},
  });
  let activeRebuildJob=makeBuiltJob(scratchId,scratchHash);

  const rebuildStatusPayload={
   available:true,
   draft:draftStatus.draft,
   inputs:{config:'derived/drafts/chain/config.json',parts:'derived/drafts/chain/input',rig:'derived/drafts/chain/out',configHash:draftStatus.draft.config.sha256},
   parts:[{name:'torso',regions:[{name:'bust_r',shape:'circle',cx:20,cy:20,r:6,bone:'torso_bone',spacing:4,band:10}]}],
   contour:{torso:{contour:{regions:[{name:'bust_r',shape:'circle',cx:20,cy:20,r:6,bone:'torso_bone',spacing:4,band:10}]}}},
   producer:draftStatus.producer,
   compiler:draftStatus.compiler,
   reason:null,
  };

  inspectorBinding=bindInspectorTabs(()=>{},()=>{}, {tabs:inspectorTabs.map(button=>({id:button.dataset.inspector!,button:button as unknown as HTMLButtonElement,panels:[],attribute:'aria-selected' as const})),panels:[],initialize:true,reveal:()=>mainScope.workspace.revealInspector()});
  const mainScope:any={
   controls:createRigViewControls(),
   refreshedBuilds,
   HTMLInputElement:FakeHTMLInputElement,
   HTMLSelectElement:FakeHTMLElement,
   HTMLTextAreaElement:FakeHTMLElement,
   HTMLElement:FakeHTMLElement,
   RigPlayer:TrackedRigPlayer,
   loadModel:wrappedLoadModel,
   loadModelDocument,
   PartExplorer,
   partCatalog,
   partBounds,
   PartThumbnails,
   pageRegionTable,
   createViewportState,
   createViewportController,
   createRigViewportProvider,
   singleEligibility,
   rendererStatus,
   selectedInspector,
   stageInspectorTabs:inspectorBinding,
   modelBoneNames,
   readSetupPose,
   cropWorldMapping,
   evaluateChestForm,
   chestInputIds,
   chestRegionRows,
   chestRowId,
   LANDMARKS,
   meshEditSource,
   appliedRecord,
   patchAppliedRecord,
   deltaAppliedRecord,
   recordFor,
   outcomeLine,
   patchOutcomeLine,
   deltaOutcomeLine,
   MESH_DELTA_APPLIED_SOURCE,
   stageModel,
   chestPartFields,
   chestStatusForPart,
   designatedRegions,
   chestSeed,
   seedFields,
   seedLandmarks,
   noContourReason,
   pickPart,
   posedChestMapping:(m:any)=>m,
   chestPoseOffset:()=>({x:0,y:0}),
   onFitCamera:()=>fitCameraHook?.(),
   readOnly:null,
   assets:null,
   player:null,
   animation:'',
   time:0,
   duration:0,
   playing:false,
   stageClock:null,
   view:'reference',
   rigInput:{state:'absent'},
   referenceInput:{state:'loaded'},
   effectiveView:'reference',
   referenceSize:{width:64,height:64},
   referenceGeneration:1,
   inDrawRig:false,
   inspectionSourceState:'ready',
   layers:{images:true,mesh:false,bones:false,meshOpacity:0.65},
   data:{
    manifest:{id:'chain',title:'Chain',revision:'1',animations:[],axes:[],references:[],checkpoints:[]},
    capabilities:{preRig:true,playback:false,modeling:false,motion:false,feedback:true,audio:false},
    reviewedSource:{rig:{path:'build/skeleton.model.json',sha256:inspectedHash}},
    feedbackCatalog:{bones:null,slots:null,animations:[]},
    sourceHash:'hash-inspected',
   },
   rebuildStatus:null,
   stageCheck:null,
   stripPending:null,
   appliedHistory:{depth:0,records:[]},
   parts:null,
   overlays:{clear:()=>{}},
   workspace:{revealInspector:()=>{}},
   persistence:{save:()=>{}},
   requirementsPanel:{selectionChanged:()=>{}},
   renderFeedbackTargets:()=>{},
   openReview:()=>{},
   retargetPanel:{load:()=>{}},
   rigFieldsPanel:{load:()=>{}},
   meshPanel:{load:()=>{},select:()=>{},part:()=>'torso',status:()=>{},counts:()=>{},readout:()=>{}},
   meshEditor:{selectionChanged:()=>{},sync:()=>{},setStatusNote:()=>{},statusNote:()=>''},
   chestEditor:{notify:(text:string|null,error=false)=>{chestNotices.push({text,error});},rebind:()=>{},unavailable:()=>{},rebuildState:()=>{},sync:()=>{},active:()=>false,mode:()=>'circles',flashing:()=>false},
   weightsView:{refresh:()=>{},sync:()=>{}},
   bonesPanel:{load:()=>{},sync:()=>{}},
   cutsPanel:{load:()=>{},shown:()=>{},sync:()=>{}},
   clothPanel:{load:()=>{},shown:()=>{},sync:()=>{}},
   physicsPanel:{clearPreview:()=>{clearPreviewCalls++;}},
   idlePanel:{model:()=>idleModelHook?.()},
   animationPanel:{loadSource:()=>{},capture:()=>{},fromParts:()=>{},reconcileStageApplied:()=>{}},
   directionPanel:{refresh:()=>{}},
   inspectorBlocks:{select:()=>{}},
   access:{route:(p:string)=>p},
   location:{href:'http://127.0.0.1:4173/',origin:'http://127.0.0.1:4173'},
   document:fakeDocument,
   el:(id:string)=>ensureEl(id),
   input:(id:string)=>ensureEl(id,'input'),
   select:(id:string)=>ensureEl(id,'select'),
   button:(id:string)=>ensureEl(id,'button'),
   option:(value:string,label:string)=>{const o=makeNode('option');o.value=value;o.textContent=label;return o;},
   text:(id:string,val:string)=>{ensureEl(id).textContent=val;},
   tr:(s:string)=>s,
   errorText:(e:unknown)=>e instanceof Error?e.message:String(e),
   assetUrl:(p:string)=>'/assets/'+p.replace(/^\/+/,''),
   pause:()=>{mainScope.playing=false;},
   seek:()=>{},
   playPreview:async()=>{playPreviewCalls++;mainScope.playing=true;},
   renderTransport:()=>{},
   renderCues:()=>{},
   renderIdle:()=>{},
   renderDropNotices:()=>{},
   renderHandoff:()=>{},
   refreshPhysics:()=>{},
   refreshApplied:async()=>{},
   canManageApplied:()=>true,
   configureTurnPad:()=>{},
   refreshAnimationInspection:()=>{},
   useWorld:()=>false,
   checkAnimation:()=>'idle',
   worldFor:()=>null,
   stageWorld:()=>null,
   swapRig:async()=>{throw new Error('SWAP_RIG_CALLED_IN_PRE_RIG');},
   runRebuild:async(body:any)=>({
    ...activeRebuildJob,
    request:{
     ...activeRebuildJob.request,
     part:body?.part??'torso',
     regions:body?.regions??[],
     entrySha256:'entry-sha-123456',
     delta:body?.delta??{ops:[]},
     deltaSha256:'delta-sha-123456',
    },
   }),
   retargetStage:()=>null,
   chooseAnimation:()=>{},
   stageChanged:()=>{},
   renderAppliedBlocks:()=>{},
   recordBlock:()=>'mesh',
   rebuildState:()=>{},
   appliedStatus:(t:string)=>{ensureEl('applied-status').textContent=t;},
   redrawOverlay:()=>{},
   message:(text:string,error=false)=>{messages.push({text,error});},
   api:async(path:string,init?:any)=>{
    if(path==='/api/rebuild')return structuredClone(rebuildStatusPayload);
    if(path==='/api/stage-parts'){
     const b=init?.headers?.['X-Review-Stage-Build']??'inspected';
     stagePartsCallCount++;
     if(onStagePartsCall)await onStagePartsCall(stagePartsCallCount,b);
     if(failStageBuild===b)throw new Error('409: {"error":"STAGE_DRAFT_MISMATCH"}');
     return structuredClone(stagePayloads[b]);
    }
    if(path===`/api/rebuild/${scratchId}`)return structuredClone(makeBuiltJob(scratchId,scratchHash));
    if(path===`/api/rebuild/${unclippedScratchId}`)return structuredClone(makeBuiltJob(unclippedScratchId,unclippedScratchHash));
    if(path==='/api/rebuild/undo'){
     return {status:'inspected',undone:scratchId,history:{depth:0,records:[]}};
    }
    throw new Error(`unexpected api ${path}`);
   },
  };

  const fns=new Function(
   'scope',
   `with(scope){${mainCode};refreshStageParts=()=>{refreshedBuilds.push(appliedOnStage?.buildId??'inspected');};return {openStageCorrection,prepareStageDraftBuild,draftInspectedTarget,draftScratchTarget,resolveStageDraftTarget,populateChestBones,loadRebuildStatus,rebindChestPart,applyPatch,applyMeshDelta,applyRebuild,undoApply,resetRebuild,meshSource,activeSetupBones,hasStageModel,setView,renderLayout,fitCamera,getParts:()=>parts,setPlaying:(v)=>{playing=v;},setRebuildBusy:(v)=>{rebuildBusy=v;},setStageModelBones:(v)=>{stageModelBones=v;},setStageDraftTarget:(v)=>{if(typeof stageDraftTarget!=='undefined')stageDraftTarget=v;},getState:()=>({player,assets,partModel,stageModelBones,inspectedModel,appliedOnStage,stageModelHash,stageCorrectionPart,stageDraftSelection,chestFormPart,chestMapping,rebuildBusy,view,effectiveView,rigInput,viewportState:viewport.state,feedbackCatalog:data.feedbackCatalog,stageDraftTarget:typeof stageDraftTarget!=='undefined'?stageDraftTarget:undefined,stageDraftTargets:typeof stageDraftTargets!=='undefined'?stageDraftTargets:undefined})};}`,
  )(mainScope) as any;

  const partsExplorer=fns.getParts() as InstanceType<typeof PartExplorer>;
  const origSelect=partsExplorer.select.bind(partsExplorer);
  partsExplorer.select=(val)=>{
   origSelect(val);
   if(failSelectAfterSelectOnce){
    failSelectAfterSelectOnce=false;
    throw new Error('SELECT_POST_MUTATION_FAILURE');
   }
  };
  fns.getState().viewportState.activeCamera='reference';
  fns.renderLayout();
  fns.populateChestBones();
  await fns.loadRebuildStatus();

  // 0. Normal Pre-Rig entry before opening correction: no compiled model drawn yet, feedbackCatalog.bones/slots stay null, view is reference, clipPath is baseline 'inset(2px)'.
  expect(fns.getState().player).toBeNull();
  expect(fns.getState().partModel).toBeNull();
  expect(fns.getState().stageModelBones).toBeNull();
  expect(fns.hasStageModel()).toBe(false);
  expect(ensureEl(chestRowId(0,'bone'),'select').disabled).toBe(true);
  expect(ensureEl(chestRowId(0,'bone'),'select').options.map((o:any)=>o.value)).toEqual(['']);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('');
  expect(ensureEl(chestRowId(0,'name'),'input').value).toBe('bust_r');
  expect(ensureEl(chestRowId(0,'cx'),'input').value).toBe('20');
  expect(fns.getState().chestFormPart).toBe('torso');
  expect(fns.getState().view).toBe('reference');
  expect(fns.getState().effectiveView).toBe('reference');
  expect(fns.getState().viewportState.activeCamera).toBe('reference');
  expect(selectedInspector(fakeDocument)).toBe('view');
  expect(rigRoot.style.clipPath).toBe('inset(2px)');
  expect(partsExplorer.value()).toBeNull();
  expect(partsExplorer.refusal('single')).toBeNull();
  expect(workspaceLeft.querySelector('[data-part-status]')!.textContent).toBe('No compiled rig catalog available');
  expect(fns.meshSource()).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_MODEL_UNAVAILABLE:/)});

  // 1. Locked (`inspectionOnly: true`) and unmapped parts refuse in openStageCorrection before loading any model or touching selection.
  stagePayloads.inspected.draft.inspectionOnly=true;
  await expect(fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'mesh'})).rejects.toThrow('PARTS_VERDICT_READ_ONLY');
  delete stagePayloads.inspected.draft.inspectionOnly;
  await expect(fns.openStageCorrection({part:'unknown',sourceHash:'hash-inspected',buildId:'inspected',instrument:'mesh'})).rejects.toThrow('STAGE_DRAFT_MISMATCH');
  expect(fns.getState().player).toBeNull();
  expect(disposedAssets).toHaveLength(0);

  // 2. Exact `(buildId, url, modelHash)` tuple enforcement: refuses missing/invalid fields without falling back to stageModelHash, and uses a single bounded stageDraftTarget instead of an unbounded Map.
  expect(fns.getState().stageDraftTargets).toBeUndefined();
  expect(fns.getState().stageDraftTarget).toBeNull();
  expect(()=>fns.draftScratchTarget('','/rebuild/a/skeleton.model.json',scratchHash)).toThrow('STAGE_DRAFT_MISMATCH');
  expect(()=>fns.draftScratchTarget('inspected','/rebuild/a/skeleton.model.json',scratchHash)).toThrow('STAGE_DRAFT_MISMATCH');
  expect(()=>fns.draftScratchTarget(scratchId,'',scratchHash)).toThrow('STAGE_DRAFT_MISMATCH');
  expect(()=>fns.draftScratchTarget(scratchId,`/rebuild/${scratchId}/skeleton.model.json`,'')).toThrow('STAGE_DRAFT_MISMATCH');
  await expect(fns.resolveStageDraftTarget(scratchId)).rejects.toThrow('STAGE_DRAFT_STALE');

  // 2b. First-open commit rollback after parts.select mutates explorer/view/camera/inspector and nextPlayer writes root clip:
  // everything rolls back cleanly to the initial pre-open state (parts.clear('single'), no catalog refusal, view='reference', activeCamera='reference', inspector='view', clipPath='inset(2px)', buttons/selects disabled, clearPreview not called).
  failSelectAfterSelectOnce=true;
  await expect(fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'delta'})).rejects.toThrow('SELECT_POST_MUTATION_FAILURE');
  expect(disposedPlayers).toHaveLength(1);
  expect(disposedAssets).toHaveLength(1);
  expect(fns.getState().player).toBeNull();
  expect(fns.getState().assets).toBeNull();
  expect(fns.getState().partModel).toBeNull();
  expect(fns.getState().stageModelBones).toBeNull();
  expect(fns.getState().stageDraftSelection).toBeNull();
  expect(fns.getState().stageDraftTarget).toBeNull();
  expect(partsExplorer.value()).toBeNull();
  expect(partsExplorer.refusal('single')).toBeNull();
  expect(workspaceLeft.dataset.parts).toBeUndefined();
  expect(workspaceLeft.querySelector('[data-part-list]')!.querySelectorAll('button')).toHaveLength(0);
  expect(workspaceLeft.querySelector('[data-part-status]')!.textContent).toBe('No compiled rig catalog available');
  expect(fns.getState().view).toBe('reference');
  expect(fns.getState().effectiveView).toBe('reference');
  expect(fns.getState().viewportState.activeCamera).toBe('reference');
  expect(selectedInspector(fakeDocument)).toBe('view');
  expect(rigRoot.style.clipPath).toBe('inset(2px)');
  expect(rigEmpty.hidden).toBe(false);
  expect(animSelectEl.disabled).toBe(true);
  expect(animSelectEl.options).toHaveLength(0);
  expect(ensureEl('layer-mesh','input').disabled).toBe(true);
  expect(clearPreviewCalls).toBe(0);

  // 3. Eligible Stage 1 draft opens correction by loading the hash-verified draft model into a real RigPlayer + setup mesh + root clip polygon A.
  await fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'delta'});
  const afterOpen=fns.getState();
  expect(afterOpen.player).not.toBeNull();
  expect(afterOpen.assets).not.toBeNull();
  expect(afterOpen.partModel).toEqual(inspectedDoc);
  expect(afterOpen.stageModelBones).toEqual(['root','torso_bone']);
  expect(fns.activeSetupBones()).toEqual(['root','torso_bone']);
  expect(afterOpen.feedbackCatalog).toEqual({bones:null,slots:null,animations:[]});
  expect(afterOpen.chestMapping.available).toBe(true);
  expect(afterOpen.stageCorrectionPart).toBe('torso');
  expect(afterOpen.stageDraftSelection).toEqual({
   part:'torso',
   slot:'torso',
   skin:'default',
   attachment:'torso',
   sourceHash:'hash-inspected',
   buildId:'inspected',
  });
  expect(partsExplorer.value()?.identity).toMatchObject({skin:'default',attachment:'torso'});
  expect(workspaceLeft.querySelector('[data-part-list]')!.querySelectorAll('button').map(b=>b.dataset.slot)).toEqual(['clip_mask','torso']);
  const openedClip=afterOpen.player.posedFrame().order.find((row:any)=>row.slot==='torso')?.clip?.polygon;
  expect(openedClip).toHaveLength(inspectedClipPolygon.length);
  inspectedClipPolygon.forEach((coordinate,index)=>expect(openedClip[index]).toBeCloseTo(coordinate,5));
  const openedCanvas=rigRoot.children.find(node=>node.tagName==='CANVAS') as any;
  expect(openedCanvas).toBeDefined();
  const openedPixels=openedCanvas.getContext('2d').getImageData(0,0,openedCanvas.width,openedCanvas.height).data as Uint8ClampedArray;
  expect(openedPixels.some((value,index)=>index%4===3&&value>0)).toBe(true);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);
  expect(animSelectEl.disabled).toBe(false);
  expect(animSelectEl.options.map(o=>o.value)).toEqual(['idle_inspected']);
  expect(afterOpen.view).toBe('rig');
  expect(selectedInspector(fakeDocument)).toBe('rig');
  expect(ensureEl('mesh-edit','button').getAttribute('aria-pressed')).toBe('true');
  expect(ensureEl(chestRowId(0,'bone'),'select').disabled).toBe(false);
  expect(ensureEl(chestRowId(0,'bone'),'select').options.map((o:any)=>o.value)).toEqual(['','root','torso_bone']);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  expect(ensureEl(chestRowId(1,'bone'),'select').value).toBe('');
  const openMesh=fns.meshSource();
  expect(openMesh.ok).toBe(true);
  expect(openMesh.source.vertices).toHaveLength(5);
  expect(openMesh.source.triangles.length/3).toBe(4);

  const livePlayer1=afterOpen.player;
  const liveAssets1=afterOpen.assets;

  // 4a. Phase A failure (hash mismatch on scratch model fetch) disposes staged nextAssets and keeps livePlayer1 + inspected model intact.
  const wrongBytes=new TextEncoder().encode(JSON.stringify({...scratchDoc,tampered:true}));
  modelResponses.set(`http://127.0.0.1:4173/rebuild/${scratchId}/skeleton.model.json`,{bytes:wrongBytes});
  const patch={schema:'rig-review-config-patch/1',config_sha256:draftStatus.draft.config.sha256,ops:[{op:'add',path:'/meshes/torso/density',value:16}],producer:{name:'@rig-c/parts',version:'1.49.0'},op:{cmd:'remesh',args:['--part','torso']}};
  const playersDisposedBefore4a=disposedPlayers.length;
  const badHashApply=await fns.applyPatch(patch);
  expect(badHashApply.status).toBe('refused');
  expect(badHashApply.error).toContain('DIRECTION_SOURCE_CHANGED');
  expect(fns.getState().player).toBe(livePlayer1);
  expect(fns.getState().assets).toBe(liveAssets1);
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(fns.getState().stageModelHash).toBe(inspectedHash);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(disposedPlayers).toHaveLength(playersDisposedBefore4a);
  modelResponses.set(`http://127.0.0.1:4173/rebuild/${scratchId}/skeleton.model.json`,{bytes:scratchBytes});

  // 4b. Phase A final re-read failure (server selection/source changes while model is loading) disposes nextAssets and keeps livePlayer1 intact.
  const assetsDisposedBefore=disposedAssets.length;
  onStagePartsCall=(call,b)=>{
   if(b===scratchId&&call>=2)stagePayloads[scratchId].sourceHash='mutated-mid-flight';
  };
  stagePartsCallCount=0;
  const midFlightFailedApply=await fns.applyPatch(patch);
  onStagePartsCall=null;
  stagePayloads[scratchId].sourceHash='hash-scratch';
  expect(midFlightFailedApply.status).toBe('refused');
  expect(midFlightFailedApply.error).toContain('STAGE_DRAFT_STALE');
  expect(disposedAssets.length).toBe(assetsDisposedBefore+1);
  expect(disposedPlayers).toHaveLength(playersDisposedBefore4a);
  expect(fns.getState().player).toBe(livePlayer1);
  expect(fns.getState().assets).toBe(liveAssets1);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(fns.meshSource().source.triangles.length/3).toBe(4);

  // 4c. Actual two overlapping openStageCorrection calls with controlled async fetch barriers:
  // first open waits at model fetch barrier while second open runs and commits livePlayer2; releasing first open throws STAGE_DRAFT_STALE, disposes only its own nextAssets, and preserves livePlayer2.
  let notifyFirstFetch!:()=>void;
  const firstFetchReached=new Promise<void>(r=>{notifyFirstFetch=r;});
  let releaseFirstFetch!:()=>void;
  const firstFetchBarrier=new Promise<void>(r=>{releaseFirstFetch=r;});
  let interceptFirstFetch=true;
  modelResponses.set('http://127.0.0.1:4173/assets/build/skeleton.model.json',{
   bytes:inspectedBytes,
   hook:async()=>{
    if(interceptFirstFetch){
     interceptFirstFetch=false;
     notifyFirstFetch();
     await firstFetchBarrier;
    }
   },
  });
  const firstOpenPromise=fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'chest'});
  await firstFetchReached;
  const secondOpenPromise=fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'delta'});
  await secondOpenPromise;
  const livePlayer2=fns.getState().player;
  const liveAssets2=fns.getState().assets;
  expect(livePlayer2).not.toBeNull();
  expect(livePlayer2).not.toBe(livePlayer1);
  expect(disposedPlayers).toContain(livePlayer1);
  expect(disposedAssets).toContain(liveAssets1);
  const assetsDisposedBeforeFirstRelease=disposedAssets.length;
  releaseFirstFetch();
  await expect(firstOpenPromise).rejects.toThrow('STAGE_DRAFT_STALE');
  modelResponses.set('http://127.0.0.1:4173/assets/build/skeleton.model.json',{bytes:inspectedBytes});
  expect(disposedAssets.length).toBe(assetsDisposedBeforeFirstRelease+1);
  expect(disposedPlayers).not.toContain(livePlayer2);
  expect(disposedAssets).not.toContain(liveAssets2);
  expect(fns.getState().player).toBe(livePlayer2);
  expect(fns.getState().assets).toBe(liveAssets2);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);

  // Changes during the final awaited re-read must be checked before live mutation.
  const beforeStaleAssets=disposedAssets.length;
  stagePartsCallCount=0;
  onStagePartsCall=call=>{if(call===2)fns.setRebuildBusy(true);};
  try{
   await expect(fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'delta'})).rejects.toThrow('STAGE_DRAFT_STALE');
  }finally{onStagePartsCall=null;fns.setRebuildBusy(false);}
  expect(disposedAssets.length).toBe(beforeStaleAssets+1);
  expect(fns.getState().player).toBe(livePlayer2);
  expect(disposedPlayers).not.toContain(livePlayer2);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);

  // Actual explorer callbacks invalidate an in-flight open even when the user
  // returns to the original mode before the await finishes.
  stagePartsCallCount=0;
  onStagePartsCall=call=>{
   if(call!==2)return;
   partsExplorer.select({side:'single',slot:'torso',mode:'solo'});
   partsExplorer.select({side:'single',slot:'torso',mode:'context'});
  };
  try{
   await expect(fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'delta'})).rejects.toThrow('STAGE_DRAFT_STALE');
  }finally{onStagePartsCall=null;}
  expect(disposedAssets.length).toBe(beforeStaleAssets+2);
  expect(fns.getState().player).toBe(livePlayer2);
  expect(partsExplorer.value()).toMatchObject({slot:'torso',mode:'context'});
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);

  // 4d. Late Phase B commit rollback inside final fitCamera() after drawRig + parts.select + renderLayout + updateChestMapping:
  // custom camera zoom/center, rigRoot transform/clipPath (polygon A), #animation-select options, physicsPreview, and playback intent are all preserved/restored!
  fns.getState().viewportState.zoom=2.5;
  fns.getState().viewportState.cameraCenter={x:7,y:11};
  fns.fitCamera();
  const customLeft=rigRoot.style.left,customTop=rigRoot.style.top,customTransform=rigRoot.style.transform;
  fns.setPlaying(true);
  clearPreviewCalls=0;
  playPreviewCalls=0;
  let fitCallsInCommit=0;
  fitCameraHook=()=>{
   fitCallsInCommit++;
   // The same slot remains selected. renderLayout fits once, then the
   // explicit final fit runs after selection, layout and mapping are committed.
   if(fitCallsInCommit===2){
    fitCameraHook=null;
    throw new Error('FIT_CAMERA_LATE_FAILURE');
   }
  };
  const failedLateApply=await fns.applyPatch(patch);
  fitCameraHook=null;
  expect(failedLateApply.status).toBe('refused');
  expect(failedLateApply.error).toContain('FIT_CAMERA_LATE_FAILURE');
  expect(disposedPlayers).not.toContain(livePlayer2);
  expect(disposedAssets).not.toContain(liveAssets2);
  expect(fns.getState().player).toBe(livePlayer2);
  expect(fns.getState().assets).toBe(liveAssets2);
  expect(fns.getState().partModel).toEqual(inspectedDoc);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(partsExplorer.value()?.identity).toMatchObject({skin:'default',attachment:'torso'});
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);
  expect(fns.getState().viewportState.zoom).toBe(2.5);
  expect(fns.getState().viewportState.cameraCenter).toEqual({x:7,y:11});
  expect(rigRoot.style.left).toBe(customLeft);
  expect(rigRoot.style.top).toBe(customTop);
  expect(rigRoot.style.transform).toBe(customTransform);
  expect(animSelectEl.options.map(o=>o.value)).toEqual(['idle_inspected']);
  expect(clearPreviewCalls).toBe(0);
  expect(playPreviewCalls).toBe(1);
  fns.setPlaying(false);

  // A later UI failure after animation/layer controls changed restores those
  // controls and the caller's camera, leaving the previous physics preview intact.
  clearPreviewCalls=0;
  const beforeUiFailureNodes=[...rigRoot.children];
  idleModelHook=()=>{throw new Error('IDLE_MODEL_UI_FAILURE');};
  const failedUiApply=await fns.applyPatch(patch);
  idleModelHook=null;
  expect(failedUiApply.status).toBe('refused');
  expect(failedUiApply.error).toContain('IDLE_MODEL_UI_FAILURE');
  expect(fns.getState().player).toBe(livePlayer2);
  expect(fns.getState().assets).toBe(liveAssets2);
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(rigRoot.children).toEqual(beforeUiFailureNodes);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);
  expect(fns.getState().viewportState.zoom).toBe(2.5);
  expect(fns.getState().viewportState.cameraCenter).toEqual({x:7,y:11});
  expect(rigRoot.style.transform).toBe(customTransform);
  expect(animSelectEl.options.map(o=>o.value)).toEqual(['idle_inspected']);
  expect(animSelectEl.disabled).toBe(false);
  expect(rigEmpty.hidden).toBe(true);
  expect(clearPreviewCalls).toBe(0);
  expect(disposedPlayers).not.toContain(livePlayer2);

  // 5. Successful Apply (`applyPatch`) across two consecutive clipped models (`inspectedDoc` polygon A -> `scratchDoc` polygon B):
  // `prevPlayer.renderer.render({ order: [] })` releases root clip before `nextPlayer.draw()` so `prevPlayer.dispose()` does NOT clobber `scratchClipCss`!
  const builtApply=await fns.applyPatch(patch);
  expect(builtApply).toMatchObject({status:'built'});
  expect(disposedPlayers).toContain(livePlayer2);
  expect(disposedAssets).toContain(liveAssets2);
  const afterScratch=fns.getState();
  expect(afterScratch.player).not.toBe(livePlayer2);
  expect(afterScratch.appliedOnStage?.buildId).toBe(scratchId);
  expect(afterScratch.stageModelHash).toBe(scratchHash);
  expect(afterScratch.partModel).toEqual(scratchDoc);
  expect(afterScratch.stageModelBones).toEqual(['root','torso_bone','scratch_rib']);
  expect(afterScratch.feedbackCatalog).toEqual({bones:null,slots:null,animations:[]});
  const scratchClip=afterScratch.player.posedFrame().order.find((row:any)=>row.slot==='torso')?.clip?.polygon;
  expect(scratchClip).toHaveLength(scratchClipPolygon.length);
  scratchClipPolygon.forEach((coordinate,index)=>expect(scratchClip[index]).toBeCloseTo(coordinate,5));
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);
  expect(animSelectEl.options.map(o=>o.value)).toEqual(['idle_scratch']);
  expect(fns.meshSource().source.triangles.length/3).toBe(3);
  expect(refreshedBuilds).toEqual([scratchId]);

  // Verify resolveStageDraftTarget recovers the exact tuple from `/api/rebuild/${scratchId}` when single cached stageDraftTarget is cleared.
  expect(afterScratch.stageDraftTarget).toEqual({
   buildId:scratchId,
   url:`http://127.0.0.1:4173/rebuild/${scratchId}/skeleton.model.json`,
   prefix:`/rebuild/${scratchId}/`,
   sha256:scratchHash,
  });
  fns.setStageDraftTarget(null);
  const resolvedScratch=await fns.resolveStageDraftTarget(scratchId);
  expect(resolvedScratch).toEqual({
   buildId:scratchId,
   url:`http://127.0.0.1:4173/rebuild/${scratchId}/skeleton.model.json`,
   prefix:`/rebuild/${scratchId}/`,
   sha256:scratchHash,
  });

  // 5b. Transition from clipped model (`scratchDoc`) to unclipped model (`unclippedScratchDoc`) restores original pre-existing baseline `rigRoot.style.clipPath` ('inset(2px)'), never hardcoding "".
  activeRebuildJob=makeBuiltJob(unclippedScratchId,unclippedScratchHash);
  const unclippedApply=await fns.applyPatch(patch);
  expect(unclippedApply).toMatchObject({status:'built'});
  expect(fns.getState().appliedOnStage?.buildId).toBe(unclippedScratchId);
  const unclippedFrame=fns.getState().player.posedFrame();
  expect(unclippedFrame.order).toHaveLength(1);
  expect(unclippedFrame.order[0].clip).toBeUndefined();
  expect(rigRoot.style.clipPath).toBe('inset(2px)');
  expect(animSelectEl.disabled).toBe(true);
  expect(animSelectEl.options).toHaveLength(0);
  activeRebuildJob=makeBuiltJob(scratchId,scratchHash);
  await fns.applyPatch(patch);
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);

  // 6. Failed Undo preparation keeps scratch build live on stage (including scratchClipCss); successful Undo restores `inspected` model, bones, 4-triangle setup mesh, and inspectedClipCss.
  const liveScratchPlayer=fns.getState().player;
  const liveScratchAssets=fns.getState().assets;
  failStageBuild='inspected';
  const failedUndo=await fns.undoApply();
  expect(failedUndo.status).toBe('refused');
  expect(fns.getState().player).toBe(liveScratchPlayer);
  expect(fns.getState().assets).toBe(liveScratchAssets);
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone','scratch_rib']);
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);

  failStageBuild=null;
  const okUndo=await fns.undoApply();
  expect(okUndo.status).toBe('inspected');
  expect(disposedPlayers).toContain(liveScratchPlayer);
  expect(disposedAssets).toContain(liveScratchAssets);
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(fns.getState().stageModelHash).toBe(inspectedHash);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);
  expect(fns.meshSource().source.triangles.length/3).toBe(4);
  expect(refreshedBuilds.at(-1)).toBe('inspected');

  // 7. Re-apply via `applyMeshDelta` and `applyRebuild`, then verify failed Reset preserves scratch and successful Reset restores `inspected`.
  const deltaDoc={slot:'torso',skin:'default',attachment:'torso',basis:'setup',preview:'p',source:{hash:inspectedHash,vertices:[[0,0]],triangles:[0,0,0],hull:1},ops:[]};
  const deltaRes=await fns.applyMeshDelta(deltaDoc,()=>{});
  expect(deltaRes.built).toBe(true);
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone','scratch_rib']);
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);
  expect(fns.meshSource().source.triangles.length/3).toBe(3);

  expect(await fns.applyMeshDelta(deltaDoc,()=>{})).toEqual({built:false,error:true,text:MESH_DELTA_APPLIED_SOURCE});
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  failStageBuild='inspected';
  await fns.resetRebuild();
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone','scratch_rib']);
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);

  failStageBuild=null;
  await fns.resetRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(fns.getState().stageModelHash).toBe(inspectedHash);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);
  expect(fns.meshSource().source.triangles.length/3).toBe(4);
  expect(refreshedBuilds.at(-1)).toBe('inspected');

  // Verify `applyRebuild` (Chest regions Apply · Rebuild) transitions cleanly without manual bone injection and preserves valid choices across Apply / Undo / Reset.
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  ensureEl(chestRowId(0,'cx'),'input').value='22';
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone','scratch_rib']);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  expect(rigRoot.style.clipPath).toBe(scratchClipCss);
  await fns.undoApply();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage?.buildId).toBe(scratchId);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  await fns.resetRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  expect(rigRoot.style.clipPath).toBe(inspectedClipCss);

  // Preserve an explicit non-default valid bone on rebuild, then clear to blank with named refusal when that bone vanishes on Reset.
  await fns.applyRebuild();
  ensureEl(chestRowId(0,'bone'),'select').value='scratch_rib';
  await fns.applyRebuild();
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('scratch_rib');
  await fns.resetRebuild();
  expect(fns.getState().stageModelBones).toEqual(['root','torso_bone']);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('');
  chestNotices.length=0;
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(chestNotices.at(-1)).toEqual({text:'REBUILD_REGION_INCOMPLETE: bust_r bone',error:true});

  // Do not overwrite a deliberate empty choice once the catalog is usable.
  ensureEl(chestRowId(0,'bone'),'select').value='torso_bone';
  await fns.applyRebuild();
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('torso_bone');
  ensureEl(chestRowId(0,'bone'),'select').value='';
  await fns.resetRebuild();
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('');
  chestNotices.length=0;
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(chestNotices.at(-1)).toEqual({text:'REBUILD_REGION_INCOMPLETE: bust_r bone',error:true});

  // When transitioning from a disabled pre-rig catalog, honor row-name mismatch and missing source-row with blank named refusals.
  fns.setStageModelBones(null);
  fns.populateChestBones();
  expect(ensureEl(chestRowId(0,'bone'),'select').disabled).toBe(true);
  ensureEl(chestRowId(0,'name'),'input').value='renamed_r';
  ensureEl(chestRowId(1,'name'),'input').value='bust_l';
  for(const [f,v] of [['cx','40'],['cy','20'],['ax','6'],['ay','6'],['band','10'],['spacing','4']] as const){
   ensureEl(chestRowId(1,f),'input').value=v;
  }
  await fns.openStageCorrection({part:'torso',sourceHash:'hash-inspected',buildId:'inspected',instrument:'chest'});
  expect(ensureEl(chestRowId(0,'bone'),'select').disabled).toBe(false);
  expect(ensureEl(chestRowId(0,'bone'),'select').value).toBe('');
  expect(ensureEl(chestRowId(1,'bone'),'select').value).toBe('');
  chestNotices.length=0;
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(chestNotices.at(-1)).toEqual({text:'REBUILD_REGION_INCOMPLETE: renamed_r bone',error:true});
  ensureEl(chestRowId(0,'bone'),'select').value='torso_bone';
  chestNotices.length=0;
  await fns.applyRebuild();
  expect(fns.getState().appliedOnStage).toBeNull();
  expect(chestNotices.at(-1)).toEqual({text:'REBUILD_REGION_INCOMPLETE: bust_l bone',error:true});

  fns.getState().player?.dispose();
  fns.getState().assets?.dispose();
 }finally{
  inspectorBinding?.dispose();
  for(const [key,descriptor] of savedGlobals){
   if(descriptor)Object.defineProperty(globalThis,key,descriptor);
   else delete globals[key];
  }
 }
});
