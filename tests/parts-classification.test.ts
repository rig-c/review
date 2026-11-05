import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import * as reader from '../src/parts-view.ts';
import * as labels from '../web/parts-flags.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/parts-check-385.json',import.meta.url),'utf8'));
const names=new Set(['front','back_defect','back_control']);
test('#385 explicit scope/kind/subjects alone classify all six combinations under a passing unknown block',()=>{
 const before=JSON.stringify(fixture),rows=reader.checkReadings(fixture,names);
 expect(rows.filter(r=>r.item==='front').map(labels.readingGroup)).toEqual(['part','evidence','pair','evidence']);
 expect(rows.filter(r=>r.item==='back_defect').map(labels.readingGroup)).toEqual(['pair','evidence']);
 expect(rows.filter(r=>r.item==='back_control')).toHaveLength(0);
 expect(rows.filter(r=>r.item==='').map(labels.readingGroup)).toEqual(['evidence','evidence']);
 expect(rows.filter(labels.countedFlag)).toHaveLength(1);
 expect(JSON.stringify(fixture)).toBe(before);
});

test('#385 nested sets, singleton summaries and requirements dictionaries retain only explicit row attribution',()=>{
 const row={row_scope:'part',row_kind:'finding',row_subjects:['front']};
 const doc={sets:{alt:{requirements:{status:'FAIL',lines:{named:row}}}},PASSING:{status:'PASS',rows:[{...row,poses:[{row_scope:'rig',row_kind:'evidence',row_subjects:[]}],worst:{part:'front',severity:50}}]}};
 const rows=reader.checkReadings(doc,names);
 expect(rows.map(r=>r.kind==='check'?r.path:'')).toEqual(['sets.alt.requirements.lines.named','PASSING.rows[0]','PASSING.rows[0].poses[0]']);
 expect(rows.filter(labels.countedFlag)).toHaveLength(2);
});

test('#385 missing, partial and invalid row metadata is visible unclassified, never a finding',()=>{
 const good={row_scope:'part',row_kind:'finding',row_subjects:['front']};
 const bad=[{part:'front',status:'FAIL'},{...good,row_subjects:[]},{...good,row_kind:'wat'},{...good,row_scope:'pair',row_subjects:['front','front']},{...good,row_subjects:'front'}];
 const rows=reader.checkReadings({ROOT:{status:'FAIL',rows:[good,...bad]}},names);
 expect(rows).toHaveLength(7);expect(rows.filter(r=>r.kind==='check'&&r.path!=='ROOT.rows[0]').every(r=>labels.readingGroup(r)==='unclassified'&&r.item==='')).toBe(true);
 expect(rows.filter(labels.countedFlag)).toHaveLength(1);
 const legacy={ROOT:{status:'FAIL',rows:[{part:'front',reason:'looks like a finding'}]}};
 expect(reader.checkReadings(legacy,names)).toMatchObject([{item:'front',classification:'unclassified',entry:legacy.ROOT.rows[0]}]);
 expect(reader.checkReadings(legacy,names).filter(labels.countedFlag)).toHaveLength(0);
});

test('#385 actual pinned producer output hash and row semantics are independent of the synthetic matrix',()=>{
 const bytes=readFileSync(new URL('./fixtures/parts-check-385-real.json',import.meta.url));
 const doc=JSON.parse(bytes.toString()),rows=reader.checkReadings(doc,new Set(['front','back']));
 expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('58a0fea58a5dcce10f3cd0b513b017db2ddd2d086f2bc47aec6df015a509a896');
 expect(rows.filter(labels.countedFlag)).toMatchObject([{item:'back',path:'TEXTURE_STRETCH.per_mesh[0]'}]);
 expect(rows.filter(r=>r.kind==='check'&&r.entry.status==='unavailable').every(r=>labels.readingGroup(r)==='evidence')).toBe(true);
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
 const pkg=await reader.loadPartsView(root),wireBefore=reader.buildVerdict(pkg,{status:'pending',parts:Object.fromEntries([...names].map(n=>[n,{outcome:'pending'}]))},'test');
 expect(wireBefore.schema).toBe('rig-review-parts-verdict/2');
 expect(wireBefore.parts.front!.flags).toEqual([]); // legacy PASS extraction stays unchanged
 expect(pkg.readings!.filter(labels.countedFlag)).toHaveLength(1);
 const time=new Date(wireBefore.updatedAt);
 expect(reader.buildVerdict({...pkg,readings:[]} as any,{status:'pending',parts:Object.fromEntries([...names].map(n=>[n,{outcome:'pending'}]))},'test',time)).toEqual(wireBefore);
 await reader.saveVerdict(pkg,{status:'pending',parts:Object.fromEntries([...names].map(n=>[n,{outcome:'pending'}]))});
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
test('#385 actual renderFlags/renderList callers collapse nonflags and count only mesh + part; legacy has no fabricated count',async()=>{
 const source=await readFile('web/parts.ts','utf8'),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(source.indexOf('function renderFlags()'),source.indexOf('function renderVerdict()')));
 const state:any={selected:2,hidden:new Set(),verdict:new Map(),data:{mode:'parts',items:[...names].reverse().map((name,index)=>({name,index})),flags:[],readings:reader.checkReadings(fixture,names),flagSources:['check.json'],flagMissing:['mesh_report.json']}};
 state.selected=state.data.items.findIndex((i:any)=>i.name==='front');
 const nodes=new Map<string,Node>(),$=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node('ul'));return nodes.get(id)!;};
 const {t}=await import('../web/i18n.ts');
 const run=new Function('scope',`with(scope){${code};return ()=>{renderFlags();renderList();};}`)({state,$,document:{createElement:(tag:string)=>new Node(tag)},...labels,t});
 run();
 expect(descend($('pv-flags')).filter(n=>n.dataset.pvCategory).map(n=>[n.dataset.pvCategory,n.open])).toEqual([['part',false],['pair',false],['evidence',false]]);
 const badges=()=>descend($('pv-items')).filter(n=>n.className==='pv-count').map(n=>n.textContent);
 expect(badges().filter(Boolean)).toEqual(['check 1']);
 state.data.readings=reader.checkReadings({FAIL:{status:'FAIL',rows:[{part:'front'}]}},names);run();expect(badges().filter(Boolean)).toEqual([]);
 expect($('pv-flag-sources').textContent).toContain('unclassified');
 expect(descend($('pv-flags')).some(n=>n.dataset.pvRoot==='FAIL')).toBe(true);
});

test('#385 adopted P1: any unheld subject demotes the entire tuple without partial attribution',()=>{
 const rows=reader.checkReadings({ROOT:{status:'PASS',rows:[
  {row_scope:'part',row_kind:'finding',row_subjects:['ghost']},
  {row_scope:'pair',row_kind:'finding',row_subjects:['ghost','other']},
  {row_scope:'pair',row_kind:'finding',row_subjects:['front','ghost']},
  {row_scope:'part',row_kind:'evidence',row_subjects:['ghost']},
 ]}},names);
 expect(rows).toHaveLength(4);
 expect(rows.map(r=>[r.item,labels.readingGroup(r)])).toEqual(Array.from({length:4},()=>['','unclassified']));
 expect(rows.filter(labels.countedFlag)).toHaveLength(0);
});

test('#385 adopted P1: real BREATH_VISIBLE FAIL/WARN without tuple remains visible and unclassified',async()=>{
 const bytes=readFileSync(new URL('./fixtures/parts-check-385-real.json',import.meta.url)),original=JSON.parse(bytes.toString());
 const held=new Set(['back','front']);
 for(const status of ['FAIL','WARN']){
  const doc=structuredClone(original);doc.BREATH_VISIBLE.status=status;
  expect(reader.checkFlags(doc,held).filter(r=>r.kind==='check'&&r.root==='BREATH_VISIBLE').map(r=>r.item)).toEqual(['back','front']);
  const rows=reader.checkReadings(doc,held),gate=rows.filter(r=>r.kind==='check'&&r.path==='BREATH_VISIBLE');
  expect(gate).toHaveLength(1);expect(gate[0]).toMatchObject({item:'',classification:'unclassified',root:'BREATH_VISIBLE',status,entry:doc.BREATH_VISIBLE});
  expect(gate.filter(labels.countedFlag)).toHaveLength(0);
  // Execute the actual panel caller: it must render the global unclassified root on either held part.
  const source=await readFile('web/parts.ts','utf8'),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(source.indexOf('function renderFlags()'),source.indexOf('function renderList()')));
  const {t}=await import('../web/i18n.ts');
  for(const name of held){
   const nodes=new Map<string,Node>(),$=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node('ul'));return nodes.get(id)!;};
   const run=new Function('scope',`with(scope){${code};return renderFlags;}`)({state:{selected:0,data:{items:[{name}],flags:reader.checkFlags(doc,held),readings:rows,flagSources:['check.json'],flagMissing:['mesh_report.json']}},$,document:{createElement:(tag:string)=>new Node(tag)},...labels,t});
   run();
   const group=descend($('pv-flags')).find(n=>n.dataset.pvCategory==='unclassified');
   expect(group).toBeDefined();expect(descend(group!).some(n=>n.dataset.pvRoot==='BREATH_VISIBLE')).toBe(true);
   expect(descend(group!).some(n=>n.tag==='code'&&n.textContent.includes(JSON.stringify(doc.BREATH_VISIBLE)))).toBe(true);
  }
 }
 expect(JSON.stringify(original)).toBe(JSON.stringify(JSON.parse(bytes.toString())));
 expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe('58a0fea58a5dcce10f3cd0b513b017db2ddd2d086f2bc47aec6df015a509a896');
});
