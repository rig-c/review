/** Embedded parts inspector. Only the designated joined source can save a verdict. */
import {join} from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {appRoot,buildWeb} from './build.ts';
import type {ReviewPackage} from './manifest.ts';
import {loadPartsAtlas,loadPartsView,assertPartsUnchanged,partsViewJson,servedImage,verdictSource,readVerdict,saveVerdict,exportPartsVerdict,type PartsViewPackage} from './parts-view.ts';
import {serveReference,assertReviewUnchanged} from './reference.ts';
import {digest,object} from './interview-project.ts';
import {interviewStale,type JoinedProject} from './joined-project.ts';

export const stageVerdictLimit=4*1024*1024;
export const stageVerdictRefusals=[
 'PARTS_VERDICT_READ_ONLY','PARTS_VERDICT_SOURCE_MISMATCH','PARTS_VERDICT_OUTPUT','PARTS_VERDICT_UNAVAILABLE',
 'PARTS_VERDICT_BODY_LIMIT','PARTS_VERDICT_READ','PARTS_VERDICT_INVALID','PARTS_VERDICT_UNKNOWN_PART',
 'PARTS_VERDICT_MISSING_PART','PARTS_VERDICT_NOTE_REQUIRED','PARTS_MESH_OUTCOME_UNAVAILABLE','PARTS_MESH_OUTCOME',
 'PARTS_VERDICT_NOT_CLEAN','PARTS_VERDICT_NOTHING_FLAGGED','PARTS_VIEW_SOURCE_CHANGED','PARTS_VERDICT_INPUT_COLLISION',
 'PARTS_JOINED_ISSUE_UNSUPPORTED','PARTS_COMMENT_LIMIT','PARTS_COMMENT_INVALID','PARTS_COMMENT_DUPLICATE','PARTS_COMMENT_UNAVAILABLE',
 'PARTS_COMMENT_PART_MISMATCH','PARTS_COMMENT_STALE_SOURCE','PARTS_COMMENT_OUT_OF_BOUNDS','PARTS_COMMENT_RIG_REGION',
 'PARTS_COMMENT_CROP_INVALID','PARTS_COMMENT_EMPTY','PARTS_COMMENT_FRACTIONAL','PARTS_CAMERA_RANGE','COMMENT_CROP_INVALID',
] as const;
interface JoinedVerdictOptions {
 joined:JoinedProject;
 readInput:(req:Request)=>Promise<unknown>;
 viewOnly:boolean;
}

export function stagePartsRoutes(packages:{single:ReviewPackage}|{a:ReviewPackage;b:ReviewPackage},loadAtlas:typeof loadPartsAtlas=loadPartsAtlas,draft?:DraftReader,verdictOptions?:JoinedVerdictOptions) {
 const corrections=new Map<string,Promise<{pkg:PartsViewPackage;modelPath:string;modelSha256:string;metadata:Record<string,unknown>|null}>>();
 const loaded=new Map<string,ReturnType<typeof loadPartsAtlas>>();let bundle:Promise<Blob>|undefined;
 const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"};
 return async(req:Request):Promise<Response|null>=>{
  const url=new URL(req.url),path=url.pathname,read=req.method==='GET'||req.method==='HEAD';
  const save=path==='/api/stage-parts/verdict'&&req.method==='POST';
  const format=read&&path==='/api/stage-parts/export/json'?'json':read&&path==='/api/stage-parts/export/issue'?'issue':null;
  const verdictRequest=save||format!==null;
  if(!read&&!save)return null;
  if(save&&req.headers.get('origin')!==url.origin)return Response.json({error:'Same-origin Origin required'},{status:403,headers});
  if(verdictRequest&&(!verdictOptions?.joined.verdictDirectory||verdictOptions.viewOnly||(req.headers.get('X-Review-Stage-Build')??'inspected')!=='inspected')){
   return Response.json({error:'PARTS_VERDICT_READ_ONLY'},{status:409,headers});
  }
  if(['/stage-parts.html','/parts.js','/parts.css'].includes(path)){
   if(path==='/parts.js'){bundle??=buildWeb('parts');return new Response(req.method==='HEAD'?null:await bundle,{headers:{...headers,'Content-Type':'text/javascript'}});}
   return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/'+(path==='/stage-parts.html'?'parts.html':'parts.css')),{headers:{...headers,'Content-Type':path.endsWith('.css')?'text/css':'text/html; charset=utf-8'}});
  }
  const match=('single' in packages?/^\/api\/stage-parts(?:\/(image|page)\/(\d+))?$/:/^\/api\/compare\/(a|b)\/stage-parts(?:\/(image|page)\/(\d+))?$/).exec(verdictRequest?'/api/stage-parts':path);
  if(!match)return null;
  const key='single' in packages?'single':match[1] as 'a'|'b',p='single' in packages?packages.single:packages[key as 'a'|'b'];
  const kind=match['single' in packages?1:2] as 'image'|'page'|undefined,index=match['single' in packages?2:3];
  try{
   // Single-package Stage 1 uses the declared handoff's real separated parts, not the atlas names.
   const recorded=verdictOptions?.joined.draft;
   if ('single' in packages && (recorded||p.handoff?.parts&&p.handoff.rig)) {
    await verdictOptions?.joined.assertCurrent();
    await assertReviewUnchanged(p);
    const build=req.headers.get('X-Review-Stage-Build')??'inspected';
    if(build!=='inspected'&&!/^[a-f0-9]{64}$/.test(build))throw new Error('STAGE_DRAFT_STALE');
    if(build!=='inspected'&&recorded&&(!recorded.editable||verdictOptions?.viewOnly))throw new Error('STAGE_DRAFT_UNAVAILABLE');
    const applied=build==='inspected'?null:await draft?.(build);
    if(build!=='inspected'&&!applied)throw new Error('STAGE_DRAFT_UNAVAILABLE');
    const model=applied?.model??recorded?.model??(p.manifest.model?join(p.root,p.manifest.model):null);
    if(!model)throw new Error('STAGE_DRAFT_UNAVAILABLE');
    let promise=corrections.get(build);
    if(!promise){
     const loading=(async()=>{
      const rig=applied?join(applied.spec,'rig.json'):(recorded?.rig??join(p.handoff!.rig!,'rig.json'));
      const meshReport=applied?join(applied.spec,'mesh_report.json'):(recorded?.meshReport??join(p.handoff!.rig!,'mesh_report.json'));
      const pkg=await loadPartsView(recorded?.parts??p.handoff!.parts!,{rig,meshReport});
      if(recorded){
       const partsPrefix=recorded.parts.replace(/\/+$/,'')+'/';
       const pinned=applied?pkg.files.filter(file=>file.abs.startsWith(partsPrefix)):[...pkg.files,...pkg.flagFiles];
       if(pinned.some(file=>recorded.files.get(file.abs)!==file.sha256))
        throw new Error(applied?'STAGE_DRAFT_CHANGED':'PARTS_VERDICT_SOURCE_MISMATCH');
      }
      const mappings=await draftMappings(model,rig,pkg,applied?undefined:recorded?.files);
      const modelSha256=digest(await readFile(model));
      await verdictOptions?.joined.assertCurrent();
      await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);
      const inspectionOnly=Boolean(recorded&&(!recorded.editable||verdictOptions?.viewOnly));
      return {pkg,modelPath:model,modelSha256,metadata:mappings.length?{label:'Draft rig · structure evidence only',buildId:build,inspectionSourceHash:p.sourceHash,mappings,evidence:applied?.evidence??null,...(inspectionOnly?{inspectionOnly:true}:{})}:null};
     })();
     promise=loading.catch(error=>{if(corrections.get(build)===promise)corrections.delete(build);throw error;});
     corrections.set(build,promise);
    }
    const {pkg,modelPath,modelSha256,metadata}=await promise;
    // Every response and image is served against the revalidated source, active scratch build and model/parts pins.
    let latestApplied:DraftSnapshot|null=null;
    let imageResponse:Response|null=null;
    try{
     await verdictOptions?.joined.assertCurrent();
     await assertReviewUnchanged(p);await assertPartsUnchanged(pkg);
     const currentModelSha256=digest(await readFile(modelPath).catch(()=>{throw new Error('STAGE_DRAFT_CHANGED');}));
     if(currentModelSha256!==modelSha256)throw new Error('STAGE_DRAFT_CHANGED');
     if(kind){
      const file=servedImage(pkg,kind,Number(index));
      if(!file)return Response.json({error:'PARTS_IMAGE_UNAVAILABLE'},{status:404,headers});
      const pinned=pkg.files.find(f=>f.abs===file)!;
      imageResponse=await serveReference(req,file,pinned.sha256,headers);
     }
     await verdictOptions?.joined.assertCurrent();
     await assertReviewUnchanged(p);
     latestApplied=build==='inspected'?null:(await draft?.(build))??null;
     if(build!=='inspected'&&(!latestApplied||latestApplied.model!==modelPath))throw new Error('STAGE_DRAFT_STALE');
    }catch(error){
     if(build!=='inspected')corrections.delete(build);
     throw error;
    }
    if(imageResponse)return imageResponse;
    const writable=build==='inspected'&&verdictOptions?.joined.verdictDirectory&&!verdictOptions.viewOnly;
    const saved=writable?await joinedVerdict(req,p,pkg,verdictOptions,save,format,headers):null;
    if(saved instanceof Response)return saved;
    const activeMetadata=metadata&&latestApplied?{...metadata,evidence:latestApplied.evidence}:metadata;
    return Response.json({...partsViewJson(pkg,saved??{verdict:null,stale:null}),differenceAvailable:false,readOnly:!writable,...(recorded&&!writable?{verdictReadOnlyReason:'PARTS_VERDICT_READ_ONLY: a pending parts review and an explicit verdict output directory are required.'}:{}),inspectionSourceHash:p.sourceHash,...(saved?{joinedVerdictBinding:saved.binding,verdictFile:saved.filename}:{}),...(activeMetadata?{draft:activeMetadata}:{draftUnavailable:stageDraftRefusals.STAGE_DRAFT_NO_MESH})},{headers});
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
   return Response.json({...partsViewJson(pkg,{verdict:null,stale:null}),differenceAvailable:false,readOnly:true,inspectionSourceHash:p.sourceHash,draftUnavailable:stageDraftRefusals.STAGE_DRAFT_UNAVAILABLE},{headers});
  }catch(error){const code=error instanceof Error?error.message.split(':')[0]??'':'';
   if((verdictRequest||verdictOptions)&& (code===interviewStale||stageVerdictRefusals.some(refusal=>refusal===code))){
    const invalid=save&&!['PARTS_VERDICT_SOURCE_MISMATCH','PARTS_VERDICT_OUTPUT','PARTS_VERDICT_READ_ONLY','PARTS_VIEW_SOURCE_CHANGED',interviewStale].includes(code);
    return Response.json({error:code},{status:invalid?400:409,headers});
   }
   const named=stageDraftRefusals[code??'']??(code==='PARTS_MESH_IMAGE_MISMATCH'?stageDraftRefusals.STAGE_DRAFT_MISMATCH:undefined);return Response.json({error:named??'PARTS_ATLAS_UNAVAILABLE: the inspected package has no usable atlas or its source changed.'},{status:409,headers});}
 };
}

/** The output address and request binding share the exact joined and parts identities.
 * Only the standard verdict is exported, with source paths relative to the file on disk.
 */
async function joinedVerdict(req:Request,p:ReviewPackage,pkg:PartsViewPackage,options:JoinedVerdictOptions,
 save:boolean,format:'json'|'issue'|null,headers:Record<string,string>){
 const {joined}=options,{hash}=joined.opened,{version}=joined.designation;
 const binding=digest(JSON.stringify({projectHash:hash,version,sourceHash:p.sourceHash,parts:verdictSource(pkg)}));
 const filename=`parts-review-${binding}.json`;
 const directory=joined.verdictDirectory!();
 const destination={...pkg,verdictPath:join(directory,filename)};
 const assertCurrent=async()=>{
  await joined.assertCurrent();
  await assertPartsUnchanged(pkg);
  try{
   joined.verdictDirectory!();
   const entry=await lstat(destination.verdictPath).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return null;});
   if(entry&&(!entry.isFile()||entry.nlink!==1))throw new Error('Aliased output');
  }catch{throw new Error('PARTS_VERDICT_OUTPUT');}
 };
 const input=save?object(await options.readInput(req)):null;
 if(input&&input.binding!==binding)throw new Error('PARTS_VERDICT_SOURCE_MISMATCH');
 // Joined issue editing is deferred. The standing job route owns issue submission.
 if(input&&input.comments!==undefined)throw new Error('PARTS_VERDICT_INVALID');
 await assertCurrent();
 const saved=await readVerdict(destination);
 if(saved.stale)throw new Error('PARTS_VERDICT_SOURCE_MISMATCH');
 if(input&&(input.status==='approved'||input.status==='changes-requested')&&Array.isArray(input.issues)&&input.issues.length>0)throw new Error('PARTS_JOINED_ISSUE_UNSUPPORTED');
 if(input)return Response.json({verdict:await saveVerdict(destination,input,assertCurrent)},{headers});
 if(format){
  if(!saved.verdict)throw new Error('PARTS_VERDICT_UNAVAILABLE');
  return new Response(req.method==='HEAD'?null:exportPartsVerdict(saved.verdict,format),{headers:{...headers,
   'Content-Type':format==='json'?'application/json':'text/markdown; charset=utf-8',
   'Content-Disposition':`attachment; filename="${format==='json'?filename:filename.replace(/\.json$/,'.md')}"`}});
 }
 return {...saved,binding,filename};
}

export interface DraftSnapshot {id:string;spec:string;model:string;evidence:unknown}
export type DraftReader=(id:string)=>Promise<DraftSnapshot>;
/** Closed public refusals; never send paths or producer output through the managed-front error channel. */
export const stageDraftRefusals:Record<string,string>={
 STAGE_DRAFT_GEOMETRY_UNSUPPORTED:'STAGE_DRAFT_GEOMETRY_UNSUPPORTED: raw indexed vertex geometry is unavailable in this draft connection.',
 STAGE_DRAFT_UNAVAILABLE:'STAGE_DRAFT_UNAVAILABLE: no producer-compatible draft is supplied.',
 STAGE_DRAFT_NO_MESH:'STAGE_DRAFT_NO_MESH: this part has no mesh attachment; direct correction is unavailable.',
 STAGE_DRAFT_MISMATCH:'STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.',
 STAGE_DRAFT_STALE:'STAGE_DRAFT_STALE: the requested revision is pending or no longer applied.',
 STAGE_DRAFT_CHANGED:'STAGE_DRAFT_CHANGED: scratch inputs changed after Apply.',
 STAGE_DRAFT_UNCHECKED:'STAGE_DRAFT_UNCHECKED: this revision has no successful producer check.',
 STAGE_DRAFT_OPERATION:'STAGE_DRAFT_OPERATION: this applied operation is not a mesh correction.',
};
/** Same names alone cannot bind a producer operation: exact skin/slot/attachment, raster crop and mesh arrays must agree.
 * Compiler UV decimals round-trip float32; compare the represented float32 values exactly, with no numeric tolerance.
 */
async function draftMappings(modelPath:string,rigPath:string,pkg:PartsViewPackage,files?:ReadonlyMap<string,string>){
 const parse=async(path:string)=>{
  const bytes=await readFile(path);
  if(files&&digest(bytes)!==files.get(path))throw new Error('PARTS_VERDICT_SOURCE_MISMATCH');
  return JSON.parse(bytes.toString('utf8'));
 };
 const [model,rig]=await Promise.all([parse(modelPath),parse(rigPath)]);
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
