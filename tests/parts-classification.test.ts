import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import * as reader from '../src/parts-view.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/parts-check-385.json',import.meta.url),'utf8'));
const names=new Set(['front','back_defect','back_control']);
test('#385 explicit scope/kind/subjects alone classify all six combinations under a passing unknown block',()=>{
 const before=JSON.stringify(fixture),rows=reader.checkReadings(fixture,names);
 expect(rows.filter(r=>r.item==='front').map(r=>r.kind==='check'?r.classification:'part')).toEqual(['part','evidence','pair','evidence']);
 expect(rows.filter(r=>r.item==='back_defect').map(r=>r.kind==='check'?r.classification:'part')).toEqual(['pair','evidence']);
 expect(rows.filter(r=>r.item==='back_control')).toHaveLength(0);
 expect(rows.filter(r=>r.item==='').map(r=>r.kind==='check'?r.classification:'part')).toEqual(['evidence','evidence']);
 expect(rows.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(1);
 expect(JSON.stringify(fixture)).toBe(before);
});

test('#385 nested sets, singleton summaries and requirements dictionaries retain only explicit row attribution',()=>{
 const row={row_scope:'part',row_kind:'finding',row_subjects:['front']};
 const doc={sets:{alt:{requirements:{status:'FAIL',lines:{named:row}}}},PASSING:{status:'PASS',rows:[{...row,poses:[{row_scope:'rig',row_kind:'evidence',row_subjects:[]}],worst:{part:'front',severity:50}}]}};
 const rows=reader.checkReadings(doc,names);
 expect(rows.map(r=>r.kind==='check'?r.path:'')).toEqual(['sets.alt.requirements.lines.named','PASSING.rows[0]','PASSING.rows[0].poses[0]']);
 expect(rows.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(2);
});

test('#385 missing, partial and invalid row metadata is visible unclassified, never a finding',()=>{
 const good={row_scope:'part',row_kind:'finding',row_subjects:['front']};
 const bad=[{part:'front',status:'FAIL'},{...good,row_subjects:[]},{...good,row_kind:'wat'},{...good,row_scope:'pair',row_subjects:['front','front']},{...good,row_subjects:'front'}];
 const rows=reader.checkReadings({ROOT:{status:'FAIL',rows:[good,...bad]}},names);
 expect(rows).toHaveLength(7);expect(rows.filter(r=>r.kind==='check'&&r.path!=='ROOT.rows[0]').every(r=>(r.kind==='check'?r.classification:'part')==='unclassified'&&r.item==='')).toBe(true);
 expect(rows.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(1);
 const legacy={ROOT:{status:'FAIL',rows:[{part:'front',reason:'looks like a finding'}]}};
 expect(reader.checkReadings(legacy,names)).toMatchObject([{item:'front',classification:'unclassified',entry:legacy.ROOT.rows[0]}]);
 expect(reader.checkReadings(legacy,names).filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(0);
});

test('#385 actual pinned producer output hash and row semantics are independent of the synthetic matrix',()=>{
 const bytes=readFileSync(new URL('./fixtures/parts-check-385-real.json',import.meta.url));
 const doc=JSON.parse(bytes.toString()),rows=reader.checkReadings(doc,new Set(['front','back']));
 expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('58a0fea58a5dcce10f3cd0b513b017db2ddd2d086f2bc47aec6df015a509a896');
 expect(rows.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toMatchObject([{item:'back',path:'TEXTURE_STRETCH.per_mesh[0]'}]);
 expect(rows.filter(r=>r.kind==='check'&&r.entry.status==='unavailable').every(r=>(r.kind==='check'?r.classification:'part')==='evidence')).toBe(true);
});

import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writePartsPackage} from './helpers/parts-package.ts';
import {startPartsServer} from '../src/parts-server.ts';
test('#385 serving path exposes separate readings, keeps verdict/2 IDs and refuses changed classification inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'classified-'));
 let server:Awaited<ReturnType<typeof startPartsServer>>|undefined;
 try{
 await writePartsPackage(root);const path=join(root,'check/check.json');await writeFile(path,JSON.stringify(fixture));
 const pkg=await reader.loadPartsView(root),wireBefore=reader.buildVerdict(pkg,{status:'approved',issues:[]},'test');
 expect(wireBefore.schema).toBe('rig-review-parts-verdict/4');
 expect(wireBefore.issues).toEqual([]);
 expect(pkg.readings!.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(1);
 const time=new Date(wireBefore.updatedAt);
 expect(reader.buildVerdict({...pkg,readings:[]} as any,{status:'approved',issues:[]},'test',time)).toEqual(wireBefore);
 await reader.saveVerdict(pkg,{status:'approved',issues:[]});
 server=await startPartsServer(pkg,{port:0,exitOnClose:false});const origin=`http://127.0.0.1:${server.port}`;
 const res=await fetch(origin+'/api/parts'),body=await res.json();expect(res.status).toBe(200);expect(body.readings).toEqual(pkg.readings);expect(body.flags).toEqual(pkg.flags);expect(JSON.stringify(body)).not.toContain(root);
 const exported=await fetch(origin+'/api/parts/export');expect(exported.status).toBe(200);expect(await exported.json()).toEqual((await reader.readVerdict(pkg)).verdict);
 await writeFile(path,JSON.stringify({...fixture,changed:'metadata input'}));
 expect((await fetch(origin+'/api/parts')).status).toBe(409);
 const changed=await reader.loadPartsView(root);expect(await reader.readVerdict(changed)).toEqual({verdict:null,stale:'flags'});
 }finally{server?.stop(true);await rm(root,{recursive:true,force:true});}
});

// Execute the actual DOM callers in CI: *-browser.ts is deliberately not a CI test.
class Node {
 children:any[]=[];dataset:Record<string,string>={};className='';textContent='';open=false;
 constructor(public tag:string){} append(...c:any[]){this.children.push(...c);} replaceChildren(...c:any[]){this.children=c;} setAttribute(){}
}
const descend=(n:Node):Node[]=>[n,...n.children.filter(c=>c instanceof Node).flatMap(descend)];

test('#385 adopted P1: any unheld subject demotes the entire tuple without partial attribution',()=>{
 const rows=reader.checkReadings({ROOT:{status:'PASS',rows:[
  {row_scope:'part',row_kind:'finding',row_subjects:['ghost']},
  {row_scope:'pair',row_kind:'finding',row_subjects:['ghost','other']},
  {row_scope:'pair',row_kind:'finding',row_subjects:['front','ghost']},
  {row_scope:'part',row_kind:'evidence',row_subjects:['ghost']},
 ]}},names);
 expect(rows).toHaveLength(4);
 expect(rows.map(r=>[r.item,(r.kind==='check'?r.classification:'part')])).toEqual(Array.from({length:4},()=>['','unclassified']));
 expect(rows.filter(r=>r.kind==='faint'||r.kind==='check'&&r.classification==='part')).toHaveLength(0);
});
