/** Fixed-instance handshake and enforced landing binding; no filesystem control API. */
import {timingSafeEqual} from 'node:crypto';
export interface OpenIdentity {key:string;contentHash:string;nonce:string;fingerprint:string}
export function openGate(req:Request,identity:OpenIdentity|undefined):Response|null{
 if(!identity)return null;const url=new URL(req.url);
 if(url.pathname==='/api/open-status'){
  if(req.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  if(req.headers.get('authorization')!==`Bearer ${identity.nonce}`)return Response.json({error:'Open instance capability required'},{status:403});
  return Response.json({schema:'rig-review-open-status/1',...identity},{headers:{'Cache-Control':'no-store'}});
 }
 if((url.pathname==='/'||url.pathname==='/index.html')&&(url.searchParams.get('input')!==identity.contentHash||url.searchParams.get('handoff')!==identity.key))return Response.json({error:'Open URL binding does not match this review instance'},{status:409});
 return null;
}

export function staleOpenStatus(identity:OpenIdentity):Response{return Response.json({schema:'rig-review-open-status/1',...identity,ready:false,error:'Inputs changed; open a new review binding'},{status:409,headers:{'Cache-Control':'no-store'}});}
/** Header names shared by the worker, the managed front and the page. */
export const capabilityHeader='X-Review-Capability',openNonceHeader='X-Review-Open-Nonce',openKeyHeader='X-Review-Open-Key';
export const capabilityPattern=/^[a-f0-9]{64}$/;
export function sameSecret(actual:string|null,expected:string):boolean{const a=Buffer.from(actual??''),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
/** Every non-GET request needs this instance's page capability, compared in constant time before any
 * Origin check. GET /api/access only says whether one is required; no endpoint ever returns it. */
export function accessGate(req:Request,capability:string|undefined):Response|null{
 const url=new URL(req.url),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(url.pathname==='/api/access')return req.method==='GET'||req.method==='HEAD'?Response.json({schema:'rig-review-access/1',capabilityRequired:!!capability},{headers}):Response.json({error:'Method not allowed'},{status:405,headers});
 if(!capability||req.method==='GET'||req.method==='HEAD')return null;
 return sameSecret(req.headers.get(capabilityHeader),capability)?null:Response.json({error:'REVIEW_CAPABILITY_REQUIRED: reopen with rig-review open to edit'},{status:403,headers});
}
/** The front forwards the open record's nonce on every request; a replaced worker refuses it. */
export function openNonceGate(req:Request,identity:OpenIdentity|undefined):Response|null{const sent=req.headers.get(openNonceHeader);if(sent===null||!identity)return null;return sameSecret(sent,identity.nonce)?null:Response.json({error:'OPEN_INSTANCE_REPLACED'},{status:409,headers:{'Cache-Control':'no-store'}});}
/** Proof for the front that this exact worker answered, not whatever now holds the port. */
export function stampOpen(req:Request,response:Response,identity:OpenIdentity|undefined):Response{if(identity&&sameSecret(req.headers.get(openNonceHeader),identity.nonce))response.headers.set(openKeyHeader,identity.key);return response;}
