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

test('instance handoff strips only cap fragments before storage and preserves null fallback for invalid saved values',()=>{
 for(const fragment of ['','#review=keep-me','#cap=short','#cap='+capability]){
  const calls:string[]=[],url='http://127.0.0.1:4318/instances/'+key+'/?lang=ko'+fragment;
  const storage={getItem:(slot:string)=>{calls.push('get:'+slot);return 'malformed';},setItem:(slot:string,value:string)=>{calls.push('set:'+slot+':'+value);}};
  const access=instanceAccess(url,storage,href=>calls.push('replace:'+href));
  const slot='rig-review-capability/1:'+key;
  expect(access.capability).toBe(fragment==='#cap='+capability?capability:null);
  expect(calls).toEqual(fragment.startsWith('#cap=')?[
   'replace:http://127.0.0.1:4318/instances/'+key+'/?lang=ko',
   fragment==='#cap='+capability?'set:'+slot+':'+capability:'get:'+slot,
  ]:['get:'+slot]);
  expect(access.headers().has('X-Review-Capability')).toBe(fragment==='#cap='+capability);
 }
});

test('instance malformed cap recovers only a valid saved capability after stripping, without rewriting storage',()=>{
 const slot='rig-review-capability/1:'+key;
 for(const saved of [null,'','short','A'.repeat(64),capability]){
  const calls:string[]=[],storage={getItem:(name:string)=>{calls.push('get:'+name);return saved;},setItem:()=>{throw new Error('must not rewrite saved values');}};
  const access=instanceAccess('http://127.0.0.1:4318/instances/'+key+'/#cap=short',storage,()=>calls.push('replace'));
  expect(access.capability).toBe(saved===capability?capability:null);
  expect(calls).toEqual(['replace','get:'+slot]);
 }
});

test('instance storage denial preserves valid in-memory handoff and missing storage stays read-only',()=>{
 const denied=()=>{throw new Error('denied');},storage={getItem:denied,setItem:denied};
 for(const available of [storage,null]){
  const calls:string[]=[];
  const valid=instanceAccess('http://127.0.0.1:4318/#cap='+capability,available,href=>calls.push(href));
  expect(valid.capability).toBe(capability);expect(calls).toEqual(['http://127.0.0.1:4318/']);
  expect(instanceAccess('http://127.0.0.1:4318/#cap=short',available,()=>{}).capability).toBeNull();
  expect(instanceAccess('http://127.0.0.1:4318/#review=retained',available,()=>{throw new Error('unrelated fragment must survive');}).capability).toBeNull();
 }
});

test('instance replacement failures propagate before storage is touched',()=>{
 const calls:string[]=[],storage={getItem:()=>{calls.push('get');return capability;},setItem:()=>{calls.push('set');}};
 expect(()=>instanceAccess('http://127.0.0.1:4318/#cap='+capability,storage,()=>{throw new Error('replace failed');})).toThrow('replace failed');
 expect(calls).toEqual([]);
});

test('#756 act status waits for resolution and never upgrades immutable backdrop source access',()=>{
 const backdrop={capability:null},owner={capability:'owner'},copied={capability:null};
 for(const authority of [owner,copied])expect(readOnlyReason(backdrop,null,authority)).toBeNull();
 expect(readOnlyReason(backdrop,true,owner)).toBeNull();expect(readOnlyReason(backdrop,true,copied)).toBe(readOnlyMessage);
 expect(readOnlyReason(backdrop,true)).toBe(readOnlyMessage);expect(backdrop.capability).toBeNull();
 expect(readOnlyReason(backdrop,false,copied)).toBeNull();
});
