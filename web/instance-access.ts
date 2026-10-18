/** Page-side instance routing and the per-instance write capability. The capability arrives only in the
 * printed `#cap=` handoff fragment (never sent to a server), moves into memory and this tab's
 * sessionStorage under the instance key, and is stripped from the address bar. No endpoint serves it, so a
 * copied link without the fragment opens read-only. Managed pages live under `/instances/<key>/`; direct and
 * foreground pages under `/`. */
export const capabilityHeader='X-Review-Capability';
export const readOnlyMessage='Read-only view: reopen with rig-review open to edit.';
export interface InstanceAccess {readonly base:string;readonly key:string;readonly capability:string|null;route(path:string):string;headers(init?:HeadersInit):Headers}
export function instanceAccess(href:string,storage:Pick<Storage,'getItem'|'setItem'>|null,replace:(href:string)=>void):InstanceAccess {
 const url=new URL(href),match=/^\/instances\/([a-f0-9]{64})\//.exec(url.pathname);
 if(url.pathname.startsWith('/instances/')&&!match)throw new Error('Instance path invalid');
 const handoff=url.searchParams.get('handoff'),key=match?match[1]!:handoff&&/^[a-f0-9]{64}$/.test(handoff)?handoff:'direct',base=match?`/instances/${key}/`:'/',slot=`rig-review-capability/1:${key}`;
 let capability:string|null=null;
 if(url.hash.startsWith('#cap=')){const value=url.hash.slice(5);if(/^[a-f0-9]{64}$/.test(value))capability=value;url.hash='';replace(url.href);try{if(capability)storage?.setItem(slot,capability);}catch{}}
 if(!capability){try{const saved=storage?.getItem(slot)??null;capability=saved&&/^[a-f0-9]{64}$/.test(saved)?saved:null;}catch{}}
 return {base,key,capability,
  route:path=>{if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Instance route must be app-absolute');return base+path.slice(1);},
  headers:init=>{const headers=new Headers(init);if(capability)headers.set(capabilityHeader,capability);return headers;}};
}
/** A server that requires a capability, reached without one, is read-only with this reason. */
export function readOnlyReason(access:Pick<InstanceAccess,'capability'>,capabilityRequired:boolean):string|null {return capabilityRequired&&!access.capability?readOnlyMessage:null;}
/** Browser glue: tolerate storage denial; the page then keeps the capability in memory only. */
export function pageInstanceAccess():InstanceAccess {let storage:Storage|null=null;try{storage=sessionStorage;}catch{}return instanceAccess(location.href,storage,href=>history.replaceState(history.state,'',href));}
