import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {
 assertMeshPatch,entryChanges,entryRegions,hitRegionPoint,meshApplyOutcome,meshDraftText,meshMode,meshPatchOps,modeNotEditable,modelMeshTriangles,moveRegionPoint,
 parseMeshDraft,patchChangedPaths,polygonRegion,precheckEntry,remeshCounts,removeSegment,setEntryValue,setRibs,triangleAgreement,withRegions,MESH_PANEL_SCHEMA,type MeshEntry,type MeshRegion,
} from '../src/mesh-entry.ts';
import {remeshPart,type ConfigPatch,type JsonValue} from '../src/config-patch.ts';
import {appliedSummary,parseAppliedContext} from '../src/applied-context.ts';
import {makePatch,patchAppliedRecord,type PatchJobView} from '../web/rebuild-client.ts';
import {paneToRig} from '../web/mesh-panel.ts';

/** The real package's two shapes (values only, no names): a contour entry with a circle region and a lattice entry. */
const topwear={contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true,regions:[{name:'bust',shape:'circle',cx:414,cy:342,r:50,bone:'chest_jiggle',spacing:13,band:30}]},r:15,segments:[['chest',[416,230],[416,600]]]} as unknown as MeshEntry;
const neck={grid:10,r:30,segments:[['chest',[416,282],[416,442]],['head',[413,214],[413,164]]]} as unknown as MeshEntry;
const skirt={grid:30,r:10,segments:[['hip',[326,624],[521,624]],'skirt0_','skirt1_']} as unknown as MeshEntry;
const config={key:'k',bones:[],meshes:{topwear,neck,skirt}} as unknown as JsonValue;
const bones=['root','chest','chest_jiggle','head','hip'];
/** `remesh.json` as the installed producer wrote it for topwear at contour spacing 20 (rig-parts 1.42.0, the real package). */
const remeshJson={spec:'rig-parts-remesh/1',request:{part:'topwear',mesh:topwear,idle_keys:'ctl',page_edges:'free',pack_shape:'polygon'},target:{before:{vertices:178,triangles:296,hull:58},after:{vertices:181,triangles:302,hull:58}}};

test('mode: exactly one of grid, contour, auto, influence; this panel edits grid and contour, and says why not the others',()=>{
 expect(meshMode(topwear,'topwear')).toEqual({mode:'contour'});expect(meshMode(neck,'neck')).toEqual({mode:'grid'});
 expect(meshMode({...neck,contour:topwear.contour},'neck')).toEqual({error:expect.stringMatching(/^CONFIG_MESH_MODE: config\.meshes\.neck — has grid and contour/)});
 expect(meshMode({r:1,segments:['a']},'x')).toEqual({error:expect.stringMatching(/^CONFIG_MESH_MODE: .* has no mode/)});
 expect(modeNotEditable('grid')).toBeNull();expect(modeNotEditable('contour')).toBeNull();
 expect(modeNotEditable('influence')).toContain('remesh --help names grid, contour and auto entries, not influence');
 expect(modeNotEditable('auto')).toStartWith('MESH_PANEL_MODE');
});

test('the pre-check mirrors the config loader by name; the rig stage\'s own floors are left to the producer',()=>{
 for(const [part,entry] of [['topwear',topwear],['neck',neck],['skirt',skirt]] as const)expect(precheckEntry(part,entry,bones)).toEqual([]);
 const contour=(patch:Record<string,JsonValue|undefined>)=>({...topwear,contour:{...(topwear.contour as Record<string,JsonValue>),...patch}}) as MeshEntry;
 const first=(entry:unknown,part='topwear')=>precheckEntry(part,entry,bones)[0]??'';
 expect(first(contour({margin:0.5}))).toBe('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.margin — is 0.5; 0, or 1 px or more, is required');
 expect(first(contour({spacing:0}))).toStartWith('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.spacing');
 expect(first(contour({budget:2}))).toStartWith('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.budget');
 expect(first(contour({bridges:false}))).toStartWith('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.bridges');
 expect(first({...neck,grid:0},'neck')).toStartWith('CONFIG_FIELD_TYPE: config.meshes.neck.grid');
 expect(first({...neck,ribs:{chest:{stations:1}}},'neck')).toStartWith('CONFIG_RIBS_MODE: config.meshes.neck.ribs');
 expect(first({...topwear,stray:3})).toStartWith('CONFIG_STRAY_MODE: config.meshes.topwear.stray');
 expect(first({...neck,rule:'heat',exponent:3},'neck')).toStartWith('CONFIG_FIELD_TYPE: config.meshes.neck.exponent');
 expect(first({...neck,r:undefined,segments:neck.segments},'neck')).toStartWith('CONFIG_FIELD_TYPE: config.meshes.neck.r');
 const {r:_drop,...noR}=neck as Record<string,JsonValue>;expect(first(noR,'neck')).toBe('CONFIG_FIELD_PRESENT: config.meshes.neck.r — is absent and required');
 const region=entryRegions(topwear)[0]!;
 expect(first(withRegions(topwear,[region,{...region}]))).toBe('CONFIG_REGION_NAME_UNIQUE: config.meshes.topwear.contour.regions[1].name — "bust" is declared twice in this mesh; each region needs its own name');
 expect(first(withRegions(topwear,[{...region,cx:414.001} as MeshRegion]))).toStartWith('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.regions[0].cx — is 414.001; a multiple of 1/256 px');
 expect(first(withRegions(topwear,[{...region,bone:'nope'}]))).toStartWith('CONFIG_NAME_RESOLVES: config.meshes.topwear.contour.regions[0].bone');
 expect(first(withRegions(topwear,[{name:'p',shape:'polygon',points:[[1,1],[2,2]],bone:'chest',spacing:10,band:4}]))).toStartWith('CONFIG_FIELD_TYPE: config.meshes.topwear.contour.regions[0].points — has 2 point(s)');
 expect(first(setRibs(topwear,'skirt0_',2))).toStartWith('CONFIG_NAME_RESOLVES: config.meshes.topwear.ribs.skirt0_');
 // A spacing whose keep radius snaps to 0 is the outline's rule (CONTOUR_PARAMETER at the rig stage): review sends it and quotes the producer.
 expect(precheckEntry('topwear',contour({spacing:0.003}),bones)).toEqual([]);
});

test('edits change only their field, keep the config\'s key order, and the diff names exactly that pointer',()=>{
 const spaced=setEntryValue(topwear,['contour','spacing'],20);
 expect(Object.keys(spaced.contour as object)).toEqual(Object.keys(topwear.contour as object));expect(Object.keys(spaced)).toEqual(Object.keys(topwear));
 expect(entryChanges(topwear,spaced)).toEqual([{path:'/contour/spacing',before:28,after:20}]);
 const budget=setEntryValue(topwear,['contour','budget'],400);expect(Object.keys(budget.contour as object)).toEqual(['tolerance','margin','spacing','maxEdge','budget','stray','bridges','regions']);
 expect(setEntryValue(budget,['contour','budget'],undefined)).toEqual(topwear);
 const capped=setEntryValue(neck,['influences','maxInfluences'],2);expect(Object.keys(capped)).toEqual(['grid','r','segments','influences']);expect(setEntryValue(capped,['influences','maxInfluences'],undefined)).toEqual(neck);
 expect(entryChanges(topwear,topwear)).toEqual([]);
 const ribbed=setRibs(skirt,'skirt1_',2);expect(ribbed.ribs).toEqual({skirt1_:{stations:2}});
 // Removing the segment a rib is keyed by takes the rib with it (the loader would refuse the orphan by name).
 expect(removeSegment(ribbed,2)).toEqual({...skirt,segments:(skirt.segments as JsonValue[]).slice(0,2)});
});

test('bar 3: the submitted patch is one op at /meshes/<part>; the config moves at that path only; a leaked second path is refused',()=>{
 const pending=withRegions(setEntryValue(topwear,['contour','spacing'],20),[...entryRegions(topwear),polygonRegion('polygon',[[380,300],[440,300.4],[430,360]],'chest',14,16)]);
 const ops=meshPatchOps('topwear',pending);
 expect(ops).toEqual([{op:'replace',path:'/meshes/topwear',value:pending as unknown as JsonValue}]);
 const patch=makePatch({inputs:{config:'c',parts:null,rig:null,configHash:'a'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'}},ops,{cmd:'remesh',args:['--part','topwear']})!;
 expect(()=>assertMeshPatch(patch,'topwear')).not.toThrow();expect(remeshPart(patch)).toBe('topwear');
 const changed=patchChangedPaths(config,patch.ops);
 expect(changed.length).toBeGreaterThan(0);expect(changed.every(p=>p.startsWith('/meshes/topwear/'))).toBe(true);
 expect(new Set(patch.ops.map(o=>o.path))).toEqual(new Set(['/meshes/topwear']));
 const leaked:ConfigPatch={...patch,ops:[...patch.ops,{op:'replace',path:'/meshes/neck/r',value:31}]};
 expect(()=>assertMeshPatch(leaked,'topwear')).toThrow('MESH_PATCH_SCOPE: a mesh patch is one op, replace /meshes/topwear; this one has 2: replace /meshes/topwear, replace /meshes/neck/r');
 expect(()=>assertMeshPatch({...patch,op:{cmd:'rig',args:[]}},'topwear')).toThrow('MESH_PATCH_SCOPE');
 expect(()=>assertMeshPatch({...patch,ops:[{op:'replace',path:'/meshes/topwear/contour/spacing',value:20}]},'topwear')).toThrow('MESH_PATCH_SCOPE');
});

test('bar 1 readers: remesh.json\'s counts, the compiled model\'s triangles for the slot, and their agreement with the overlay',()=>{
 const counts=remeshCounts(remeshJson)!;
 expect(counts).toEqual({part:'topwear',before:{vertices:178,triangles:296,hull:58},after:{vertices:181,triangles:302,hull:58}});
 expect(remeshCounts({...remeshJson,target:{before:{vertices:1}}})).toBeNull();expect(remeshCounts({spec:'other'})).toBeNull();
 const tri=(n:number)=>Array.from({length:n*3},(_,i)=>i%5);
 const model={spec:'rigc-compiled/3',skins:[{name:'default',attachments:{topwear:{topwear:{kind:'mesh',triangles:tri(302)}},neck:{neck:{kind:'mesh',triangles:tri(76)}},face:{face:{kind:'region'}}}}]};
 expect(modelMeshTriangles(model,'topwear')).toBe(302);expect(modelMeshTriangles(model,'face')).toBeNull();expect(modelMeshTriangles(model,'missing')).toBeNull();
 expect(triangleAgreement(counts,302,302)).toEqual({ok:true,line:'MESH_COUNTS_AGREE: remesh.json after t 302 · revision model t 302 · overlay draws 302 triangle(s) on topwear'});
 // The overlay still drawing the inspected mesh (296) is a disagreement, named with every figure.
 expect(triangleAgreement(counts,302,296)).toEqual({ok:false,line:'MESH_COUNTS_DIFFER: remesh.json after t 302 · revision model t 302 · overlay draws 296 triangle(s) on topwear'});
 expect(triangleAgreement(counts,null,302).ok).toBe(false);expect(triangleAgreement(null,302,302).line).toStartWith('MESH_COUNTS_UNAVAILABLE');
});

test('bar 2: a refused candidate\'s line is the producer\'s, verbatim; a build reports remesh.json\'s counts',()=>{
 const line='FAIL  REMESH_CANDIDATE_REFUSED: the request\'s meshes.topwear (mesh.json) — the producer refuses it, nothing is written: CONTOUR_PARAMETER: contour mesh "topwear", spacing — is 0.003; its keep radius 0.5 x 0.003 px snaps to 0 grid units of 1/256 px, and at least 1 is required (see rig-parts guide REMESH_CANDIDATE_REFUSED)';
 expect(meshApplyOutcome({status:'refused',id:'x',producerLine:line,exitCode:1})).toEqual({text:line,error:true});
 expect(meshApplyOutcome({status:'refused',error:'REBUILD_BUSY: rebuild x is still running',producerLine:null})).toEqual({text:'REBUILD_BUSY: rebuild x is still running',error:true});
 expect(meshApplyOutcome({status:'failed',producerLine:null,exitCode:2})).toEqual({text:'REBUILD_FAILED: exit 2',error:true});
 expect(meshApplyOutcome({status:'built',id:'x',remesh:remeshCounts(remeshJson)})).toEqual({text:'Remeshed topwear: v 178 · t 296 · hull 58 → v 181 · t 302 · hull 58 (remesh.json) · Reset returns to the inspected build',error:false});
});

test('regions: polygons snap to whole rig px, need three points, drag by vertex; a circle drags by its centre',()=>{
 const p=polygonRegion('polygon',[[380.4,300.6],[440,300],[430,360.49]],'chest',14,16);
 expect(p).toEqual({name:'polygon',shape:'polygon',points:[[380,301],[440,300],[430,360]],bone:'chest',spacing:14,band:16});
 expect(()=>polygonRegion('p',[[1,1],[2,2]],'chest',14,16)).toThrow('MESH_POLYGON_POINTS');
 const regions=[...entryRegions(topwear),p];
 const moved=moveRegionPoint(regions,1,2,[431.6,370.2]);expect(moved[1]).toEqual({...p,points:[[380,301],[440,300],[432,370]]} as MeshRegion);expect(moved[0]).toEqual(regions[0]!);
 expect(moveRegionPoint(regions,0,0,[420,350])[0]).toMatchObject({cx:420,cy:350,r:50});
 const project=(x:number,y:number)=>({x:x*2,y:y*2});
 expect(hitRegionPoint(regions,project,{x:861,y:721})).toEqual({region:1,vertex:2});expect(hitRegionPoint(regions,project,{x:829,y:684})).toEqual({region:0,vertex:0});
 expect(hitRegionPoint(regions,project,{x:10,y:10})).toBeNull();
 // Pane px → rig px through the camera and the crop mapping (world = (x − W/2, H − y)).
 const mapping={available:true as const,crop:{w:832,h:1216},basis:'',toWorld:(x:number,y:number)=>({x:x-416,y:1216-y})},camera=(x:number,y:number)=>({x:300+x*.5,y:700-y*.5});
 const world=mapping.toWorld(430,360),pane=camera(world.x,world.y);expect(paneToRig(camera,mapping,pane)).toEqual([430,360]);
});

test('the draft keeps the part and its pending entry; context.applied carries remesh.json\'s counts for a remesh patch',()=>{
 const text=meshDraftText({schema:MESH_PANEL_SCHEMA,part:'topwear',entry:topwear});expect(parseMeshDraft(text)).toEqual({schema:MESH_PANEL_SCHEMA,part:'topwear',entry:topwear});
 expect(parseMeshDraft('{"schema":"x"}')).toBeNull();expect(parseMeshDraft('')).toBeNull();
 const patch=makePatch({inputs:{config:'c',parts:null,rig:null,configHash:'a'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'}},meshPatchOps('topwear',setEntryValue(topwear,['contour','spacing'],20)),{cmd:'remesh',args:['--part','topwear']})!;
 const counts=remeshCounts(remeshJson)!;
 const job={id:'b'.repeat(64),kind:'patch',status:'built',reused:false,lines:[],producerLine:'ok',exitCode:0,wallMs:{op:1,compile:1,check:1},check:null,diff:{count:3,paths:['/a']},remesh:{...counts,modelTriangles:302},build:{modelUrl:'/m',modelHash:'c'.repeat(64),files:{}},request:{patch,patchSha256:'d'.repeat(64),configHash:'a'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'}} as PatchJobView;
 const record=patchAppliedRecord(job);
 expect(record.mesh).toEqual({part:'topwear',before:counts.before,after:counts.after});
 expect(()=>parseAppliedContext(record)).not.toThrow();
 expect(appliedSummary(record)).toContain('topwear v 178 t 296 → v 181 t 302');
 expect(()=>parseAppliedContext({...record,mesh:{...record.mesh,part:'neck'}})).toThrow('mesh.part');
 expect(()=>parseAppliedContext({...record,mesh:{...record.mesh,after:{vertices:1,triangles:-1,hull:0}}})).toThrow('whole numbers');
 const {mesh:_none,...plain}=record;expect(()=>parseAppliedContext(plain)).not.toThrow();
});

test('the Mesh panel sits in Setup with its controls, draft and readouts; its overlay colours are theme tokens',async()=>{
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 const setup=html.slice(html.indexOf('<section id="inspector-rig"'),html.indexOf('<section id="inspector-playback"'));
 for(const id of ['mesh-panel','mesh-panel-state','mesh-params','mesh-add-circle','mesh-add-polygon','mesh-regions-edit','mesh-regions','mesh-segment-bone','mesh-segment-add','mesh-segments','mesh-diff','mesh-precheck','mesh-panel-apply','mesh-panel-reset','mesh-folds','mesh-status','mesh-counts','mesh-readout','mesh-pending'])expect(setup).toContain(`id="${id}"`);
 for(const token of ['--rv-mesh-region','--rv-mesh-region-fill','--rv-mesh-handle'])expect(css.match(new RegExp(`${token}:`,'g'))?.length).toBe(2);
});
