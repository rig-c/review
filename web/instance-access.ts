/** Page-side instance routing and the per-instance write capability. The capability arrives only in the
 * printed `#cap=` handoff fragment (never sent to a server), moves into memory and this tab's
 * sessionStorage under the instance key, and is stripped from the address bar. No endpoint serves it, so a
 * copied link without the fragment opens read-only. Managed pages live under `/instances/<key>/`; direct and
 * foreground pages under `/`. */
export const capabilityHeader='X-Review-Capability';
export const readOnlyMessage='Read-only view: reopen with rig-review open to edit.';
export interface InstanceAccess {readonly base:string;readonly key:string;readonly capability:string|null;route(path:string):string;headers(init?:HeadersInit):Headers}
/** Shared hash handoff core; callers retain their existing slot and storage/stripping policy. */
export function hashCapabilityAccess<Missing extends '' | null>(url: URL, slotName: string,
 storage: () => Pick<Storage, 'getItem' | 'setItem'> | null, replace: (href: string) => void,
 options: {valueCheck?: (value: string) => boolean; strip: 'cap-before-storage' | 'always-after-storage';
  storedValue: 'validate' | 'preserve'; fallback: Missing}): string | Missing {
 const check = options.valueCheck ?? ((value: string) => /^[a-f0-9]{64}$/.test(value));
 const hasFragment = url.hash.startsWith('#cap='), value = hasFragment ? url.hash.slice(5) : '';
 let capability: string | Missing = hasFragment && check(value) ? value : options.fallback;
 const strip = () => {url.hash = ''; replace(url.href);};
 if (options.strip === 'cap-before-storage' && hasFragment) strip();
 try {
  if (capability) storage()?.setItem(slotName, capability);
  else {
   const saved = storage()?.getItem(slotName);
   capability = saved != null && (options.storedValue === 'preserve' || saved && check(saved)) ? saved : options.fallback;
  }
 } catch { /* Storage denial leaves only the in-memory handoff or the caller's fallback. */ }
 if (options.strip === 'always-after-storage') strip();
 return capability;
}
export function instanceAccess(href:string,storage:Pick<Storage,'getItem'|'setItem'>|null,replace:(href:string)=>void):InstanceAccess {
 const url=new URL(href),match=/^\/instances\/([a-f0-9]{64})\//.exec(url.pathname);
 if(url.pathname.startsWith('/instances/')&&!match)throw new Error('Instance path invalid');
 const handoff=url.searchParams.get('handoff'),key=match?match[1]!:handoff&&/^[a-f0-9]{64}$/.test(handoff)?handoff:'direct',base=match?`/instances/${key}/`:'/',slot=`rig-review-capability/1:${key}`;
 const capability=hashCapabilityAccess(url,slot,()=>storage,replace,
  {strip:'cap-before-storage',storedValue:'validate',fallback:null});
 return {base,key,capability,
  route:path=>{if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Instance route must be app-absolute');return base+path.slice(1);},
  headers:init=>{const headers=new Headers(init);if(capability)headers.set(capabilityHeader,capability);return headers;}};
}
/** A server that requires a capability, reached without one, is read-only with this reason. */
export function readOnlyReason(access:Pick<InstanceAccess,'capability'>,capabilityRequired:boolean):string|null {return capabilityRequired&&!access.capability?readOnlyMessage:null;}
/** Browser glue: tolerate storage denial; the page then keeps the capability in memory only. */
export function pageInstanceAccess():InstanceAccess {let storage:Storage|null=null;try{storage=sessionStorage;}catch{}return instanceAccess(location.href,storage,href=>history.replaceState(history.state,'',href));}
