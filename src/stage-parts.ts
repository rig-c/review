/** Read-only embedding of the existing atlas inspector. No browser-supplied filesystem paths or verdict writes. */
import {readFile} from 'node:fs/promises';
import {appRoot,buildWeb} from './build.ts';
import type {ReviewPackage} from './manifest.ts';
import {loadPartsAtlas,assertPartsUnchanged,partsViewJson,servedImage} from './parts-view.ts';
import {serveReference,assertReviewUnchanged} from './reference.ts';
export function stagePartsRoutes(packages:{single:ReviewPackage}|{a:ReviewPackage;b:ReviewPackage},loadAtlas:typeof loadPartsAtlas=loadPartsAtlas) {
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
   return Response.json({...partsViewJson(pkg,{verdict:null,stale:null}),readOnly:true,inspectionSourceHash:p.sourceHash},{headers});
  }catch{return Response.json({error:'PARTS_ATLAS_UNAVAILABLE: the inspected package has no usable atlas or its source changed.'},{status:409,headers});}
 };
}
