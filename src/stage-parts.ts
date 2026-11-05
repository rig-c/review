/** Read-only embedding of the existing atlas inspector. No browser-supplied filesystem paths or verdict writes. */
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {appRoot,buildWeb} from './build.ts';
import type {ReviewPackage} from './manifest.ts';
import {loadPartsAtlas,loadPartsView,assertPartsUnchanged,partsViewJson,servedImage,type PartsViewPackage} from './parts-view.ts';
import {serveReference,assertReviewUnchanged} from './reference.ts';
export function stagePartsRoutes(packages:{single:ReviewPackage}|{a:ReviewPackage;b:ReviewPackage},loadAtlas:typeof loadPartsAtlas=loadPartsAtlas,draft?:DraftReader) {
 const corrections=new Map<string,Promise<{pkg:PartsViewPackage;metadata:unknown}>>();
 const loaded=new Map<string,ReturnType<typeof loadPartsAtlas>>();let bundle:Promise<Blob>|undefined;
 const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"};
 return async(req:Request):Promise<Response|null>=>{
  const url=new URL(req.url),path=url.pathname,read=req.method==='GET'||req.method==='HEAD';
  if(!read)return null;
  if(['/stage-parts.html','/parts.js','/parts.css'].includes(path)){
   if(path==='/parts.js'){bundle??=buildWeb('parts');return new Response(req.method==='HEAD'?null:await bundle,{headers:{...headers,'Content-Type':'text/javascript'}});}
   return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/'+(path==='/stage-parts.html'?'parts.html':'parts.css')),{headers:{...headers,'Content-Type':path.endsWith('.css')?'text/css':'text/html; charset=utf-8'}});
  }
  const match=('single' in packages?/^\/api\/stage-parts(?:\/(image|page)\/(\d+))?$/:/^\/api\/compare\/(a|b)\/stage-parts(?:\/(image|page)\/(\d+))?$/).exec(path);
  if(!match)return null;
  const key='single' in packages?'single':match[1] as 'a'|'b',p='single' in packages?packages.single:packages[key as 'a'|'b'];
  const kind=match['single' in packages?1:2] as 'image'|'page'|undefined,index=match['single' in packages?2:3];
  try{
   // Single-package Stage 1 uses the declared handoff's real separated parts, not the atlas names.
   if ('single' in packages && p.handoff?.parts && p.handoff.rig) {
    await assertReviewUnchanged(p);
    const build=req.headers.get('X-Review-Stage-Build')??'inspected';
    if(build!=='inspected'&&!/^[a-f0-9]{64}$/.test(build))throw new Error('STAGE_DRAFT_STALE');
    const applied=build==='inspected'?null:await draft?.(build);
    if(build!=='inspected'&&!applied)throw new Error('STAGE_DRAFT_UNAVAILABLE');
    const model=applied?.model??(p.manifest.model?join(p.root,p.manifest.model):null);
    if(!model)throw new Error('STAGE_DRAFT_UNAVAILABLE');
    let promise=corrections.get(build);
    if(!promise){
     promise=(async()=>{
      const rig=join(applied?.spec??p.handoff!.rig!,'rig.json');
      const pkg=await loadPartsView(p.handoff!.parts!,{rig,meshReport:join(applied?.spec??p.handoff!.rig!,'mesh_report.json')});
      const mappings=await draftMappings(model,rig,pkg);
      await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);
      return {pkg,metadata:{label:'Draft rig · structure evidence only',buildId:build,inspectionSourceHash:p.sourceHash,mappings,evidence:applied?.evidence??null}};
     })();corrections.set(build,promise);
    }
    const {pkg,metadata}=await promise;
    // Every image is served against the same full pinned draft, including geometry and flags.
    await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);
    if(kind){const file=servedImage(pkg,kind,Number(index));if(!file)return Response.json({error:'PARTS_IMAGE_UNAVAILABLE'},{status:404,headers});const pinned=pkg.files.find(f=>f.abs===file)!;return serveReference(req,file,pinned.sha256,headers);}
    return Response.json({...partsViewJson(pkg,{verdict:null,stale:null}),readOnly:true,inspectionSourceHash:p.sourceHash,draft:metadata},{headers});
   }
   let promise=loaded.get(key);
   const initializing=!promise;
   if(!promise){
    // Publish only a promise whose resolved value has passed BOTH sides of loading.
    // Keeping a rejected promise prevents an unchecked failed load becoming a usable pin.
    promise=(async()=>{await assertReviewUnchanged(p);const pkg=await loadAtlas(p);await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);return pkg;})();
    loaded.set(key,promise);
   }
   const pkg=await promise;if(!pkg.pages.length||!pkg.items.length)throw new Error('Atlas regions unavailable');
   if(!kind&&!initializing){await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);}
   if(kind){const model=pkg.files[0]!;await serveReference(new Request(req.url,{method:'HEAD'}),model.abs,model.sha256,headers);}
   if(kind){const file=servedImage(pkg,kind,Number(index));if(!file)return Response.json({error:'PARTS_IMAGE_UNAVAILABLE'},{status:404,headers});const pinned=pkg.files.find(f=>f.abs===file);if(!pinned)throw new Error('Unbound atlas page');return await serveReference(req,file,pinned.sha256,headers);}
   return Response.json({...partsViewJson(pkg,{verdict:null,stale:null}),readOnly:true,inspectionSourceHash:p.sourceHash,draftUnavailable:stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE},{headers});
  }catch(error){const code=error instanceof Error?error.message.split(':')[0]:'';const named=stageDraftRefusals[code??'']??(code==='PARTS_MESH_IMAGE_MISMATCH'?stageDraftRefusals.STAGE_DRAFT_MISMATCH:undefined);return Response.json({error:named??'PARTS_ATLAS_UNAVAILABLE: the inspected package has no usable atlas or its source changed.'},{status:409,headers});}
 };
}

export interface DraftSnapshot {id:string;spec:string;model:string;evidence:unknown}
export type DraftReader=(id:string)=>Promise<DraftSnapshot>;
/** Closed public refusals; never send paths or producer output through the managed-front error channel. */
export const stageDraftRefusals:Record<string,string>={
 STAGE_DRAFT_GEOMETRY_UNSUPPORTED:'STAGE_DRAFT_GEOMETRY_UNSUPPORTED: raw indexed vertex geometry is unavailable in this draft connection.',
 STAGE_DRAFT_UNAVAILABLE:'STAGE_DRAFT_UNAVAILABLE: no producer-compatible draft is supplied.',
 STAGE_DRAFT_MISMATCH:'STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.',
 STAGE_DRAFT_STALE:'STAGE_DRAFT_STALE: the requested revision is pending or no longer applied.',
 STAGE_DRAFT_CHANGED:'STAGE_DRAFT_CHANGED: scratch inputs changed after Apply.',
 STAGE_DRAFT_UNCHECKED:'STAGE_DRAFT_UNCHECKED: this revision has no successful producer check.',
 STAGE_DRAFT_OPERATION:'STAGE_DRAFT_OPERATION: this applied operation is not a mesh correction.',
};
/** Same names alone cannot bind a producer operation: exact skin/slot/attachment, raster crop and mesh arrays must agree.
 * Compiler UV decimals round-trip float32; compare the represented float32 values exactly, with no numeric tolerance.
 */
async function draftMappings(modelPath:string,rigPath:string,pkg:PartsViewPackage){
 const model=JSON.parse(await readFile(modelPath,'utf8')),rig=JSON.parse(await readFile(rigPath,'utf8'));
 const mappings:{part:string;skin:string;slot:string;attachment:string;vertices:number;triangles:number}[]=[];
 for(const item of pkg.items){
  if(!item.mesh)continue;
  for(const [key,count]of [['vertices',item.mesh.vertices.length/2],['triangles',item.mesh.triangles.length/3]]as const)if(Object.hasOwn(item.mesh.figures,key)&&item.mesh.figures[key]!==count)throw new Error('STAGE_DRAFT_MISMATCH');
  const candidates=[];
  for(const [skin,slots]of Object.entries(rig.skins??{}))for(const [slot,attachments]of Object.entries(slots as Record<string,unknown>)){
   const a=(attachments as Record<string,any>)[item.name];if(a?.type!=='mesh')continue;
   const b=(model.skins as any[])?.find(s=>s.name===skin)?.attachments?.[slot]?.[item.name];
   if(!b||b.kind!=='mesh'||b.width!==a.width||b.height!==a.height||JSON.stringify(b.uvs?.map(Math.fround))!==JSON.stringify(a.uvs.map(Math.fround))||JSON.stringify(b.triangles)!==JSON.stringify(a.triangles))throw new Error('STAGE_DRAFT_MISMATCH');
   if(!matchingVertexGeometry(a,b))throw new Error('STAGE_DRAFT_MISMATCH');
   candidates.push({part:item.name,skin,slot,attachment:item.name,vertices:a.uvs.length/2,triangles:a.triangles.length/3});
  }
  if(candidates.length!==1)throw new Error('STAGE_DRAFT_MISMATCH');
  mappings.push(candidates[0]!);
 }
 if(!mappings.length)throw new Error('STAGE_DRAFT_UNAVAILABLE');
 return mappings;
}

/** Compare authored components in the compiler's representation; no posing, meshing or weight judgment. */
function matchingVertexGeometry(a:Record<string,any>,b:Record<string,any>):boolean {
 const equalNumbers=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>typeof v==='number'&&typeof b[i]==='number'&&Math.fround(v)===Math.fround(b[i]));
 if(Array.isArray(a.weights)){
  if(a.weights.length!==a.uvs.length/2||b.vertices?.weighted!==true||!Array.isArray(b.vertices.bindings)||a.weights.length!==b.vertices.bindings.length)return false;
  return a.weights.every((row:unknown,i:number)=>Array.isArray(row)&&Array.isArray(b.vertices.bindings[i])&&row.length>0&&row.length===b.vertices.bindings[i].length&&row.every((v:unknown,j:number)=>{
   const x=v as Record<string,unknown>,y=b.vertices.bindings[i][j];
   return x&&y&&x.bone===y.bone&&equalNumbers([x.x,x.y,x.weight],[y.x,y.y,y.weight]);
  }));
 }
 if(Array.isArray(a.vertices)&&a.vertices.length===a.uvs.length)return b.vertices?.weighted===false&&equalNumbers(a.vertices,b.vertices.xy);
 throw new Error('STAGE_DRAFT_GEOMETRY_UNSUPPORTED');
}
