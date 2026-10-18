import {expect,test} from 'bun:test';
import {instanceAccess,readOnlyReason,readOnlyMessage} from '../web/instance-access.ts';
const key='b'.repeat(64),capability='c'.repeat(64),other='d'.repeat(64);
function memory(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};}
test('handoff fragment moves the capability into memory and session storage, then is stripped from the address bar',()=>{
 const storage=memory(),replaced:string[]=[],href=`http://127.0.0.1:4318/instances/${key}/?input=${'a'.repeat(64)}&handoff=${key}#cap=${capability}`;
 const access=instanceAccess(href,storage,url=>replaced.push(url));
 expect(access.capability).toBe(capability);expect(access.base).toBe(`/instances/${key}/`);expect(replaced).toEqual([`http://127.0.0.1:4318/instances/${key}/?input=${'a'.repeat(64)}&handoff=${key}`]);expect(storage.values.get('rig-review-capability/1:'+key)).toBe(capability);
 expect(access.route('/api/session')).toBe(`/instances/${key}/api/session`);expect(access.headers({'Content-Type':'application/json'}).get('X-Review-Capability')).toBe(capability);expect(()=>access.route('//evil.test/x')).toThrow();
 // A reload in the same tab (fragment already gone) recovers it from this tab's session storage only.
 const reloaded=instanceAccess(replaced[0]!,storage,()=>{throw new Error('nothing to strip');});expect(reloaded.capability).toBe(capability);expect(readOnlyReason(reloaded,true)).toBeNull();
});
test('a copied link without the fragment, or a page for another instance key, holds no capability and is read-only',()=>{
 const storage=memory();instanceAccess(`http://127.0.0.1:4318/instances/${key}/?handoff=${key}#cap=${capability}`,storage,()=>{});
 const copied=instanceAccess(`http://127.0.0.1:4318/instances/${other}/?handoff=${other}`,storage,()=>{throw new Error('nothing to strip');});
 expect(copied.capability).toBeNull();expect(copied.headers().has('X-Review-Capability')).toBe(false);expect(readOnlyReason(copied,true)).toBe(readOnlyMessage);expect(readOnlyMessage).toContain('reopen with rig-review open to edit');
 const fresh=instanceAccess(`http://127.0.0.1:4318/instances/${key}/?handoff=${key}`,memory(),()=>{});expect(fresh.capability).toBeNull();expect(readOnlyReason(fresh,true)).toBe(readOnlyMessage);
 // Foreground servers created without a capability stay writable by same-origin page requests.
 expect(readOnlyReason(fresh,false)).toBeNull();
 const malformed:string[]=[];expect(instanceAccess(`http://127.0.0.1:4318/instances/${key}/#cap=short`,memory(),url=>malformed.push(url)).capability).toBeNull();expect(malformed).toEqual([`http://127.0.0.1:4318/instances/${key}/`]);
 expect(()=>instanceAccess('http://127.0.0.1:4318/instances/zz/',memory(),()=>{})).toThrow('Instance path invalid');
});
test('direct and foreground pages route from the root and key storage by their handoff',()=>{
 const storage=memory(),direct=instanceAccess(`http://127.0.0.1:5000/?input=${'a'.repeat(64)}&handoff=${key}#cap=${capability}`,storage,()=>{});
 expect(direct.base).toBe('/');expect(direct.route('/api/review')).toBe('/api/review');expect(direct.key).toBe(key);expect(storage.values.get('rig-review-capability/1:'+key)).toBe(capability);
 const foreground=instanceAccess(`http://127.0.0.1:4317/?checkpoint=x#cap=${capability}`,null,()=>{});expect(foreground.key).toBe('direct');expect(foreground.capability).toBe(capability);
});
