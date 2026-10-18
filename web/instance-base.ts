/** Explicit instance routing for a stable workspace origin. These helpers do not
 * read/save preferences or change source identity. Direct workers retain '/'. */
export function instanceBase(href:string):string {
 const url=new URL(href),match=/^\/instances\/([a-f0-9]{64})\/(?:.*)$/.exec(url.pathname);
 if(url.pathname.startsWith('/instances/')&&!match)throw new Error('FRONTEND_INSTANCE_PATH_INVALID');
 return match?'/instances/'+match[1]+'/':'';
}
export function instanceRoute(path:string,href:string):string {
 const base=instanceBase(href);
 if(!path.startsWith('/')||path.startsWith('//')||/[\\?#\x00-\x1f]/.test(path)||path.startsWith('/instances/'))throw new Error('FRONTEND_ROUTE_INVALID');
 const decoded=decodeURIComponent(path);if(/[\\?#\x00-\x1f]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..')||/%2f/i.test(path))throw new Error('FRONTEND_ROUTE_INVALID');
 return base?base+path.slice(1):path;
}
export function instanceMutationHeaders(href:string):Record<string,string> {
 const base=instanceBase(href);return base?{'X-Review-Instance':base.split('/')[2]!}:{};
}

/** Explicit at each API call; no global fetch replacement or arbitrary URL. */
export function instanceFetch(path:string,init:RequestInit={},href=location.href):Promise<Response> {
 const method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
 if(method!=='GET'&&method!=='HEAD')for(const [name,value]of Object.entries(instanceMutationHeaders(href)))headers.set(name,value);
 return fetch(new URL(instanceRoute(path,href),href),{...init,headers});
}
