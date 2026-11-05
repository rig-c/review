import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {commentFixture,candidate} from './helpers/parts-comments-package.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeMeshPackage} from './helpers/parts-mesh-package.ts';
import {buildVerdict,loadPartsView,verdictSource} from '../src/parts-view.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {countedFlag} from '../web/parts-flags.ts';
class Node {
 children:any[]=[];dataset:Record<string,string>={};attrs:Record<string,string>={};className='';textContent='';value='';checked=false;title='';onclick?:()=>unknown;onchange?:()=>unknown;
 constructor(public tag='div'){} append(...c:any[]){this.children.push(...c);} replaceChildren(...c:any[]){this.children=c;} setAttribute(k:string,v:string){this.attrs[k]=v;}
}
const walk=(n:Node):Node[]=>[n,...n.children.filter(c=>c instanceof Node).flatMap(walk)];
async function caller(items:any[],flag?:'part'|'mesh') {
 const source=await readFile('web/parts.ts','utf8');
 const nodes=new Map<string,Node>();const $=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!;};
 const state:any={selected:0,hidden:new Set(),verdict:new Map(items.map((i,n)=>[i.name,{outcome:n===0?'clean':'pending',note:'note '+n,...(i.mesh?{mesh:{outcome:n===0?'clean':'pending',note:'mesh note '+n}}:{})}])),data:{items,mode:'parts',flags:[],readings:[],flagMissing:[],verdictFile:'verdict.json'}};
 if(flag){const entry=state.verdict.get(items.at(-1).name);if(flag==='part')entry.outcome='flagged';else entry.mesh.outcome='flagged';}
 const comments:any[]=[];const requests:any[]=[];const radios=['pending','clean','flagged'].map(value=>Object.assign(new Node('input'),{value}));let selected=-1,painted=0;
 const scope={state,$,comments,stageEmbedded:false,t:(s:string,values:Record<string,unknown>={})=>s.replace(/\{(\w+)\}/g,(_,k)=>String(values[k]??'{'+k+'}')),countedFlag,document:{createElement:(tag:string)=>new Node(tag),querySelectorAll:()=>radios},select:(i:number)=>{selected=i;},setView:()=>{},paint:async()=>{painted++;},renderVerdict:()=>{},renderMesh:()=>{},access:{route:(s:string)=>s,headers:(v:any)=>v},fetch:async(url:string,opts:any)=>{requests.push({url,...opts,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({verdict:{source:{sha256:'a'.repeat(64)}}})};}};
 const blocks=[source.slice(source.indexOf('function renderList()'),source.indexOf('function renderVerdict()')),source.slice(source.indexOf('function updateEntry('),source.indexOf('async function boot()'))];
 const binding=source.split('\n').filter(s=>s.includes("$('pv-approve-all').onclick")||s.includes("$('pv-save').onclick" )||s.includes("r.onchange =")).join('\n');
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(blocks.join('\n')+'\n'+binding);
 const api=new Function('scope',`with(scope){${code};return {renderList,updateEntry,save};}`)(scope);
 return {state,$,comments,requests,radios,api,get selected(){return selected;},get painted(){return painted;}};
}
test('#395 actual page Approve all saves every explicit part and mesh; unchanged buildVerdict accepts and guards',async()=>{
 const root=await mkdtemp(join(tmpdir(),'approve-'));try{
 await writeMeshPackage(root);const pkg=await loadPartsView(root),binding=verdictSource(pkg),c=await caller(pkg.items),before=structuredClone([...c.state.verdict]);
 expect(c.$('pv-approve-all').onclick).toBeFunction();await c.$('pv-approve-all').onclick!();
 expect(c.requests).toHaveLength(1);const request=c.requests[0];expect(request.url).toBe('/api/parts/verdict');expect(request.method).toBe('POST');expect(request.body.status).toBe('approved');
 const verdict=buildVerdict(pkg,request.body,'test');expect(verdict.source).toEqual(binding);expect(Object.keys(verdict.parts)).toEqual(pkg.items.map(i=>i.name));
 for(const [name,entry] of before as any){expect(verdict.parts[name]!.outcome).toBe('clean');expect(verdict.parts[name]!.note).toBe(entry.note);expect(verdict.parts[name]!.mesh).toEqual({...entry.mesh,outcome:'clean'});}
 expect(c.$('pv-save-status').dataset.result).toBe('saved');expect(request.body.comments).toEqual(c.comments);
 const pending=structuredClone(request.body);pending.parts[pkg.items[0]!.name].mesh.outcome='pending';expect(()=>buildVerdict(pkg,pending,'test')).toThrow('PARTS_VERDICT_NOT_CLEAN');delete pending.parts[pkg.items[0]!.name];expect(()=>buildVerdict(pkg,pending,'test')).toThrow('PARTS_VERDICT_MISSING_PART');
 }finally{await rm(root,{recursive:true,force:true});}
});
for(const flag of ['part','mesh'] as const)test('#395 actual page preserves and refuses flagged '+flag+' atomically',async()=>{
 const c=await caller([{name:'a',index:0,mesh:{}},{name:'b',index:1,mesh:{}}],flag),before=JSON.stringify([...c.state.verdict]);c.$('pv-overall').value='changes-requested';
 expect(c.$('pv-approve-all').onclick).toBeFunction();await c.$('pv-approve-all').onclick!();
 expect(c.requests).toHaveLength(0);expect(JSON.stringify([...c.state.verdict])).toBe(before);expect(c.$('pv-overall').value).toBe('changes-requested');expect(c.$('pv-save-status').textContent).toContain('PARTS_APPROVE_ALL_FLAGGED');expect(c.$('pv-save-status').dataset.result).toBe('refused');
});
test('#395 individual approval and actual list callers preserve complete names, counts, badges, selection and visibility',async()=>{
 const items=Array.from({length:24},(_,index)=>({name:index===23?'a very long complete part name '.repeat(5):'part '+index,index})),c=await caller(items);
 c.state.data.flags=[{kind:'faint',source:'mesh_report',item:items[23]!.name,id:'faint:0'}];c.state.data.readings=[{kind:'check',source:'check',classification:'part',item:items[23]!.name,id:'check:one'}];
 c.radios[1]!.checked=true;c.radios[1]!.onchange!();c.api.renderList();const rows=c.$('pv-items').children as Node[];expect(rows).toHaveLength(24);
 for(const [i,row]of rows.entries()) {const button=row.children[0] as Node,input=walk(row).find(n=>n.tag==='input')!;expect(button.title).toBe(items[i]!.name);expect(walk(button).find(n=>n.className==='pv-name')!.textContent).toBe(items[i]!.name);expect(input.attrs['aria-label']).toBe('Show '+items[i]!.name+' in assembly');expect(row.children.flatMap(n=>n instanceof Node?n.children:[])).not.toContain('Visible');expect(walk(button).find(n=>n.className==='pv-badge')).toBeDefined();button.onclick!();expect(c.selected).toBe(i);input.checked=false;input.onchange!();expect(c.state.hidden.has(items[i]!.name)).toBe(true);input.checked=true;input.onchange!();expect(c.state.hidden.has(items[i]!.name)).toBe(false);}
 expect(walk(rows[23]!).find(n=>n.className==='pv-count')!.textContent).toBe('mesh 1 · check 1');expect(rows[0]!.children[0].attrs['aria-current']).toBe('true');
 expect(c.painted).toBe(48);expect(c.state.verdict.get(items[0]!.name).outcome).toBe('clean');expect(c.state.verdict.get(items[1]!.name).outcome).toBe('pending');
 const css=await readFile('web/parts.css','utf8');expect(css).not.toMatch(/\.pv-count\{[^}]*grid-row:2/);expect(await readFile('web/parts.html','utf8')).toContain('id="pv-approve-all"');
});
test('#395 actual approval preserves a real source-bound comment and producer flag IDs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'approve-comments-'));try{
 const pkg=await commentFixture(root),comment=await preparePartsComment(pkg,candidate(pkg)),c=await caller(pkg.items);c.comments.push(comment);
 const before=await Promise.all(pkg.files.map(f=>readFile(f.abs)));await c.$('pv-approve-all').onclick!();
 const verdict=buildVerdict(pkg,c.requests[0].body,'test');expect(verdict.comments).toEqual([comment]);
 for(const item of pkg.items)expect(verdict.parts[item.name]!.flags).toEqual([...new Set(pkg.flags.filter(f=>f.item===item.name).map(f=>f.id))]);
 expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('#395 paired approval labels and admitted Korean values use polite 파츠 vocabulary',()=>{
 for(const key of ['Approve all','PARTS_APPROVE_ALL_FLAGGED: resolve flagged part and mesh outcomes before approving all.']){expect(enCatalog[key]).toBeTruthy();expect(koCatalog[key]).toBeTruthy();}
 for(const key of ['REBUILD_REGION_DUPLICATE: {0} (two regions of the chest part carry this name)','PARTS_COMMENT_UNAVAILABLE: original part image required','Comments on this part: {count}','PARTS_COMPARISON_INVALID: part/overlay mode and opacity 0..1 required']){expect(koCatalog[key]).toContain('파츠');expect(koCatalog[key]).not.toMatch(/파트|필요해요|이름을 씀/);}
});
