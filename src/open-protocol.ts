/** Fixed-instance handshake and enforced landing binding; no filesystem control API. */
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
