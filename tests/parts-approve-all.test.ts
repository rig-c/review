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
import {mountPartsWorkspace,REGION_MARGIN,type PanelOutput,type PartsHost,type PartsSource,type ViewData} from '../web/parts.ts';
import type {PartsIssue} from '../src/parts-comment.ts';

class Node {
 children:any[]=[];dataset:Record<string,string>={};attrs:Record<string,string>={};className='';textContent='';value='';checked=false;disabled=false;hidden=false;title='';id='';type='';onclick?:()=>unknown;onchange?:()=>unknown;
 constructor(public tag='div'){} append(...c:any[]){this.children.push(...c);} replaceChildren(...c:any[]){this.children=c;} setAttribute(k:string,v:string){this.attrs[k]=v;} getAttribute(k:string){return this.attrs[k]??null;} remove(){}
}
const walk=(n:Node):Node[]=>[n,...n.children.filter(c=>c instanceof Node).flatMap(walk)];

async function caller(items:any[],opts?:{legacyVerdict?:ViewData['legacyVerdict'];locked?:boolean}) {
 const source=await readFile('web/parts.ts','utf8');
 const nodes=new Map<string,Node>();const $=(id:string)=>{if(!nodes.has(id)){const n=new Node();n.id=id;nodes.set(id,n);}return nodes.get(id)!;};
 const state:any={selected:0,hidden:new Set(),data:{items,mode:'parts',flags:[],readings:[],flagMissing:[],verdictFile:'verdict.json',legacyVerdict:opts?.legacyVerdict}};
 const comments:PartsIssue[]=[];const requests:any[]=[];let selected=-1,painted=0;
 const host:PartsHost={initial:()=>comments,register:()=>{},locked:()=>opts?.locked||opts?.legacyVerdict?.readOnly?'sent':'open',changed:()=>{}};
 const scope={
  state,$,comments,host,options:{},stageEmbedded:false,embedded:false,disposed:false,busy:false,
  get currentView(){return state.data;},output:{value:()=>({verdict:comments.length?'changes-requested':'approved',issues:[...comments],words:''})},required:(selector:string)=>$(selector.slice(1)),
  t:(s:string,values:Record<string,unknown>|unknown[]={})=>Array.isArray(values)?s.replace(/\{(\d+)\}/g,(_,k)=>String(values[Number(k)]??'{'+k+'}')):s.replace(/\{(\w+)\}/g,(_,k)=>String((values as Record<string,unknown>)[k]??'{'+k+'}')),
  countedFlag,
  doc:{createElement:(tag:string)=>new Node(tag),getElementById:(id:string)=>$(id),querySelectorAll:()=>[]},
  query:(sel:string)=>$(sel.slice(1)),
  select:(i:number)=>{selected=i;},
  setView:()=>{},
  paint:async()=>{painted++;},
  renderMesh:()=>{},
  access:{capability:'cap',route:(s:string)=>s,headers:(v?:HeadersInit)=>new Headers(v)},
  stageHeaders:()=>new Headers(),
  partsApi:'/api/parts',headers:()=>new Headers(),
  stageBuild:'inspected',
  fetch:async(url:string,init:any)=>{requests.push({url,...init,body:JSON.parse(init.body)});return {ok:true,json:async()=>({verdict:{source:{sha256:'a'.repeat(64)}}})};},
 };
 const adapter=await readFile('web/parts-page.ts','utf8');
 const save=adapter.slice(adapter.indexOf('  const save = async () => {'),adapter.indexOf('  const exportVerdict =')).replace('const save = async () => {','async function save() {').replace(/};\s*$/, '}');
 const blocks=[
  source.slice(source.indexOf('function renderList()'),source.indexOf('function renderMesh()')),
  source.slice(source.indexOf('function renderLegacyVerdict()'),source.indexOf('async function boot()')),save,
 ];
 const binding="$('pv-save').onclick = () => save();";
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(blocks.join('\n')+'\n'+binding);
 const api=new Function('scope',`with(scope){${code};return {renderList,renderLegacyVerdict,save};}`)(scope);
 return {state,$,comments,requests,api,get selected(){return selected;},get painted(){return painted;}};
}

test('#612 zero-issue sign-off saves approvedrig-review-parts-verdict/4 without per-part outcome map',async()=>{
 const root=await mkdtemp(join(tmpdir(),'approve-'));try{
 await writeMeshPackage(root);const pkg=await loadPartsView(root),binding=verdictSource(pkg),c=await caller(pkg.items);
 expect(c.$('pv-save').onclick).toBeFunction();await c.$('pv-save').onclick!();
 expect(c.requests).toHaveLength(1);const request=c.requests[0];
 expect(request.url).toBe('/api/parts/verdict');expect(request.method).toBe('POST');
 expect(request.body).toEqual({status:'approved',issues:[]});
 const verdict=buildVerdict(pkg,request.body,'test');
 expect(verdict.schema).toBe('rig-review-parts-verdict/4');
 expect(verdict.status).toBe('approved');
 expect(verdict.source).toEqual(binding);
 expect(verdict.issues).toEqual([]);
 expect(c.$('pv-save-status').dataset.result).toBe('saved');
 expect(()=>buildVerdict(pkg,{status:'approved',issues:[{}]},'test')).toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#612 pointed issue switches save payload to changes-requested and preserves source-bound issue',async()=>{
 const root=await mkdtemp(join(tmpdir(),'approve-comments-'));try{
 const pkg=await commentFixture(root),comment=await preparePartsComment(pkg,candidate(pkg)),c=await caller(pkg.items);
 c.comments.push(comment);
 const before=await Promise.all(pkg.files.map(f=>readFile(f.abs)));
 await c.$('pv-save').onclick!();
 expect(c.requests).toHaveLength(1);
 expect(c.requests[0].body).toEqual({status:'changes-requested',issues:[comment]});
 const verdict=buildVerdict(pkg,c.requests[0].body,'test');
 expect(verdict.schema).toBe('rig-review-parts-verdict/4');
 expect(verdict.status).toBe('changes-requested');
 expect(verdict.issues).toEqual([comment]);
 expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#612 legacy read-only verdict renders flagged parts and refuses save when legacy read-only or host locked',async()=>{
 const legacy={
  readOnly:true as const,
  code:'PARTS_VERDICT_LEGACY_FORMAT' as const,
  schema:'rig-review-parts-verdict/2' as const,
  status:'changes-requested' as const,
  flaggedCount:1,
  flaggedParts:[{name:'gap',outcome:'flagged' as const,note:'legacy seam note',flags:['faint:0']}],
  issues:[],
 };
 const c=await caller([{name:'gap',index:0},{name:'covered',index:1}],{legacyVerdict:legacy});
 c.api.renderLegacyVerdict();
 const list=c.$('pv-legacy-flagged');
 expect(list.hidden).toBe(false);
 expect(list.children).toHaveLength(1);
 expect(list.children[0].dataset.legacyFlaggedPart).toBe('gap');
 expect(list.children[0].textContent).toBe('gap: legacy seam note');
 await c.$('pv-save').onclick!();
 expect(c.requests).toHaveLength(0);

 const lockedCaller=await caller([{name:'gap',index:0}],{locked:true});
 await lockedCaller.$('pv-save').onclick!();
 expect(lockedCaller.requests).toHaveLength(0);
});

test('#612 actual list caller renders complete names, producer flag counts, issue count badges, selection, and assembly visibility',async()=>{
 const items=Array.from({length:24},(_,index)=>({name:index===23?'a very long complete part name '.repeat(5):'part '+index,index})),c=await caller(items);
 c.state.data.flags=[{kind:'faint',source:'mesh_report',item:items[23]!.name,id:'faint:0'}];
 c.state.data.readings=[{kind:'check',source:'check',classification:'part',item:items[23]!.name,id:'check:one'}];
 c.comments.push({parts:[{name:items[0]!.name,imageHash:'a'.repeat(64)}]} as unknown as PartsIssue);
 c.api.renderList();
 const rows=c.$('pv-items').children as Node[];expect(rows).toHaveLength(24);
 for(const [i,row] of rows.entries()){
  const button=row.children[0] as Node,input=walk(row).find(n=>n.tag==='input')!;
  expect(button.title).toBe(items[i]!.name);
  expect(walk(button).find(n=>n.className==='pv-name')!.textContent).toBe(items[i]!.name);
  expect(input.attrs['aria-label']).toBe('Show '+items[i]!.name+' in assembly');
  const badge=walk(button).find(n=>n.className==='pv-badge')!;
  expect(badge).toBeDefined();
  expect(badge.dataset.issues).toBe(i===0?'1':'0');
  expect(badge.textContent).toBe(i===0?'1':'');
  button.onclick!();expect(c.selected).toBe(i);
  input.checked=false;input.onchange!();expect(c.state.hidden.has(items[i]!.name)).toBe(true);
  input.checked=true;input.onchange!();expect(c.state.hidden.has(items[i]!.name)).toBe(false);
 }
 expect(walk(rows[23]!).find(n=>n.className==='pv-count')!.textContent).toBe('mesh 1 · check 1');
 expect(rows[0]!.children[0].attrs['aria-current']).toBe('true');
 expect(c.painted).toBe(48);
 const css=await readFile('web/parts.css','utf8');expect(css).not.toMatch(/\.pv-count\{[^}]*grid-row:2/);
 const html=await readFile('web/parts.html','utf8');
 expect(html).toContain('id="parts-actions"');
 expect(html).not.toContain('id="pv-items"');
 expect(html).not.toContain('id="pv-canvas"');
 expect(html).not.toContain('id="pv-approve-all"');
 expect(html).not.toContain('data-pv-outcome');
 expect(html).not.toContain('id="pv-note"');
 expect(html).not.toContain('id="pv-overall"');
});

test('#612 two simultaneous mountPartsWorkspace instances in one document stay isolated across slots and host adapters',async()=>{
 expect(REGION_MARGIN).toBe(4);
 const partsSourceText=await readFile('web/parts.ts','utf8');
 expect(partsSourceText).not.toContain("getElementById('parts-app')");
 expect(partsSourceText).not.toContain('pageInstanceAccess(');

 class FakeElement {
  tagName:string;id='';className='';textContent='';title='';type='';value='';min='';max='';step='';
  hidden=false;disabled=false;checked=false;tabIndex=0;clientWidth=160;clientHeight=120;width=16;height=16;
  style:Record<string,string>={left:'',top:'',width:'',height:'',transform:'',transformOrigin:''};
  dataset:Record<string,string>={};
  attrs=new Map<string,string>();
  parentElement:FakeElement|null=null;
  children:FakeElement[]=[];
  onclick:((e?:any)=>unknown)|null=null;
  onchange:((e?:any)=>unknown)|null=null;
  oninput:((e?:any)=>unknown)|null=null;
  classList={
   add:(...tokens:string[])=>{const s=new Set(this.className.split(/\s+/).filter(Boolean));for(const t of tokens)s.add(t);this.className=[...s].join(' ');},
   toggle:(cls:string,force?:boolean)=>{const s=new Set(this.className.split(/\s+/).filter(Boolean));const on=force===undefined?!s.has(cls):force;if(on)s.add(cls);else s.delete(cls);this.className=[...s].join(' ');},
   contains:(cls:string)=>this.className.split(/\s+/).includes(cls),
  };
  get ownerDocument(){return fakeDoc;}
  constructor(tag:string){this.tagName=tag.toUpperCase();}
  set innerHTML(markup:string){
   this.replaceChildren();const stack:FakeElement[]=[this];
   for(const match of markup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)){
    const [whole,tag,attributes]=match;
    if(whole.startsWith('</')){stack.pop();continue;}
    const node=new FakeElement(tag!);
    for(const attr of attributes!.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))node.setAttribute(attr[1]!,attr[2]??attr[3]??attr[4]??'');
    if(attributes!.includes(' hidden'))node.hidden=true;
    stack.at(-1)!.append(node);if(!['input','img','br'].includes(tag!))stack.push(node);
   }
  }
  setAttribute(k:string,v:string){
   this.attrs.set(k,String(v));
   if(k==='id')this.id=String(v);
   if(k==='class')this.className=String(v);
   if(k.startsWith('data-')){
    const camel=k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    this.dataset[camel]=String(v);
   }
  }
  getAttribute(k:string){return this.attrs.get(k)??null;}
  removeAttribute(k:string){this.attrs.delete(k);}
  append(...nodes:any[]){
   for(const n of nodes){
    if(n instanceof FakeElement){
     if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(c=>c!==n);
     n.parentElement=this;
     this.children.push(n);
    }else if(typeof n==='string'){
     this.textContent+=n;
    }
   }
  }
  replaceChildren(...nodes:any[]){
   for(const c of this.children)c.parentElement=null;
   this.children=[];this.textContent='';
   this.append(...nodes);
  }
  before(node:FakeElement){
   if(!this.parentElement)return;
   const idx=this.parentElement.children.indexOf(this);
   if(idx>=0){node.parentElement=this.parentElement;this.parentElement.children.splice(idx,0,node);}
  }
  after(node:FakeElement){
   if(!this.parentElement)return;
   const idx=this.parentElement.children.indexOf(this);
   if(idx>=0){node.parentElement=this.parentElement;this.parentElement.children.splice(idx+1,0,node);}
  }
  remove(){
   if(this.parentElement){
    this.parentElement.children=this.parentElement.children.filter(c=>c!==this);
    this.parentElement=null;
   }
  }
  contains(target:any):boolean{return target===this||this.children.some(c=>c.contains(target));}
  closest(sel:string):FakeElement|null{
   let cur:FakeElement|null=this;
   while(cur){if(cur.matches(sel))return cur;cur=cur.parentElement;}
   return null;
  }
  matches(sel:string):boolean{
   if(sel.startsWith('#'))return this.id===sel.slice(1);
   if(sel.startsWith('.'))return this.classList.contains(sel.slice(1));
   const m=/^([a-zA-Z0-9_-]+)?\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
   if(m){
    const [,tag,attr,val]=m;
    if(tag&&this.tagName!==tag.toUpperCase())return false;
    const camel=attr!.startsWith('data-')?attr!.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()):null;
    const actual=this.attrs.get(attr!)??(camel?this.dataset[camel]:undefined);
    return val===undefined?actual!==undefined:actual===val;
   }
   return this.tagName===sel.toUpperCase();
  }
  querySelector<T=FakeElement>(sel:string):T|null{return (this.querySelectorAll(sel)[0]??null) as T|null;}
  querySelectorAll<T=FakeElement>(sel:string):T[]{
   const parts=sel.split(/\s+/).filter(Boolean);
   if(parts.length>1){
    let current:FakeElement[]=[this];
    for(const part of parts){
     const next:FakeElement[]=[];
     for(const node of current)for(const found of node.querySelectorAll<FakeElement>(part))if(!next.includes(found))next.push(found);
     current=next;
    }
    return current as unknown as T[];
   }
   const out:FakeElement[]=[];
   for(const child of this.children){
    if(child.matches(sel))out.push(child);
    out.push(...child.querySelectorAll<FakeElement>(sel));
   }
   return out as unknown as T[];
  }
  handlers=new Map<string,Set<Function>>();
  addEventListener(type:string,fn:Function){const group=this.handlers.get(type)??new Set();group.add(fn);this.handlers.set(type,group);}
  removeEventListener(type:string,fn:Function){this.handlers.get(type)?.delete(fn);}
  emit(type:string,event:any){for(const fn of this.handlers.get(type)??[])fn(event);}
  hasPointerCapture(){return false;}
  focus(){fakeDoc.activeElement=this;fakeDoc.emit('focusin',{target:this});}

  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight,right:this.clientWidth,bottom:this.clientHeight,x:0,y:0};}
  getContext(){
   return {
    imageSmoothingEnabled:false,fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,
    clearRect(){},fillRect(){},strokeRect(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
    getImageData:(_x:number,_y:number,w:number,h:number)=>({data:new Uint8ClampedArray(Math.max(4,w*h*4))}),
    putImageData(){},
   };
  }
 }

 const savedDoc=Object.getOwnPropertyDescriptor(globalThis,'document');
 const savedWin=Object.getOwnPropertyDescriptor(globalThis,'window');
 const savedRaf=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame');
 const savedCaf=Object.getOwnPropertyDescriptor(globalThis,'cancelAnimationFrame');
 const savedRo=Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver');
 const savedMo=Object.getOwnPropertyDescriptor(globalThis,'MutationObserver');
 const savedEl=Object.getOwnPropertyDescriptor(globalThis,'Element');
 const rootDoc=new FakeElement('body');
 const fakeDoc={
  body:rootDoc,
  title:'',
  activeElement:null as FakeElement|null,
  defaultView:null as any,
  createElement:(tag:string)=>new FakeElement(tag),
  getElementById:(id:string)=>rootDoc.querySelector(`#${id}`),
  querySelector:(sel:string)=>rootDoc.querySelector(sel),
  querySelectorAll:(sel:string)=>rootDoc.querySelectorAll(sel),
  handlers:new Map<string,Set<Function>>(),
  addEventListener(type:string,fn:Function){const group=this.handlers.get(type)??new Set();group.add(fn);this.handlers.set(type,group);},
  removeEventListener(type:string,fn:Function){this.handlers.get(type)?.delete(fn);},
  emit(type:string,event:any){for(const fn of this.handlers.get(type)??[])fn(event);},
 };
 const fakeWin={
  handlers:new Map<string,Set<Function>>(),
  addEventListener(type:string,fn:Function){const group=this.handlers.get(type)??new Set();group.add(fn);this.handlers.set(type,group);},
  removeEventListener(type:string,fn:Function){this.handlers.get(type)?.delete(fn);},
  emit(type:string,event:any){for(const fn of this.handlers.get(type)??[])fn(event);},
  devicePixelRatio:1,Node:FakeElement,
 };
 fakeDoc.defaultView=fakeWin;
 class FakeObserver{observe(){}disconnect(){}}
 Object.defineProperty(globalThis,'document',{value:fakeDoc,configurable:true,writable:true});
 Object.defineProperty(globalThis,'window',{value:fakeWin,configurable:true,writable:true});
 Object.defineProperty(globalThis,'requestAnimationFrame',{value:()=>1,configurable:true,writable:true});
 Object.defineProperty(globalThis,'cancelAnimationFrame',{value:()=>{},configurable:true,writable:true});
 Object.defineProperty(globalThis,'ResizeObserver',{value:FakeObserver,configurable:true,writable:true});
 Object.defineProperty(globalThis,'MutationObserver',{value:FakeObserver,configurable:true,writable:true});
 Object.defineProperty(globalThis,'Element',{value:FakeElement,configurable:true,writable:true});
 let handleA:ReturnType<typeof mountPartsWorkspace>|null=null;
 let handleB:ReturnType<typeof mountPartsWorkspace>|null=null;
 try{
  const makeSlots=(prefix:string)=>{
   const hostWrap=new FakeElement('div');hostWrap.id=`host-${prefix}`;
   const left=new FakeElement('aside'),stage=new FakeElement('main'),toolbar=new FakeElement('div'),side=new FakeElement('aside');
   hostWrap.append(left,stage,toolbar,side);
   rootDoc.append(hostWrap);
   return {left:left as unknown as HTMLElement,stage:stage as unknown as HTMLElement,toolbar:toolbar as unknown as HTMLElement,side:side as unknown as HTMLElement,hostWrap};
  };
  const sampleIssue:PartsIssue={
   schema:'rig-review-parts-comment/2',
   id:'11111111-1111-4111-8111-111111111111',
   summary:'seam gap on A',
   parts:[{name:'gap',imageHash:'a'.repeat(64)}],
   sourceHash:'1'.repeat(64),
   imageRegion:{x:1,y:2,width:4,height:5},
   rigRegion:{x:1,y:2,width:4,height:5},
   view:{
    mode:'item',
    camera:{zoom:1,center:{x:8,y:8},viewport:{width:160,height:120}},
    cameraSync:false,
    referenceCamera:null,
    background:'green',
    alpha:false,
    footprints:false,
    mesh:false,
    comparison:{mode:'part',opacity:0.5},
   },
   crop:{path:`comment-crops/${'c'.repeat(64)}.png`,sha256:'c'.repeat(64),width:8,height:8,png:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='},
   nativeCrop:null,
  };
  const makeView=(title:string,sourceHash:string,issues:PartsIssue[]):ViewData=>({
   mode:'parts',
   title,
   sourceHash,
   painting:null,
   rigSize:[64,64],
   items:[
    {name:'gap',index:0,x:0,y:0,w:16,h:16,imageHash:'a'.repeat(64)},
    {name:'covered',index:1,x:8,y:8,w:16,h:16,imageHash:'b'.repeat(64)},
   ],
   pages:[],
   flags:[],
   readings:[],
   flagSources:[],
   flagMissing:['mesh_report.json','check.json'],
   verdictFile:'parts-review.json',
   verdict:issues.length?{status:'changes-requested',issues}:null,
   verdictStale:null,
  });

  const slotsA=makeSlots('a'),slotsB=makeSlots('b');
  const outputs:{a?:PanelOutput;b?:PanelOutput}={};
  let releaseFirstImage!: (image:HTMLImageElement) => void;
  const firstImage=new Promise<HTMLImageElement>(resolve=>{releaseFirstImage=resolve;});
  const sourceA:PartsSource={
   view:async()=>makeView('Package A','1'.repeat(64),[sampleIssue]),
   image:()=>firstImage,page:async()=>({width:16,height:16} as HTMLImageElement),painting:()=>null,
   crop:async issue=>issue,
  };
  const sourceB:PartsSource={
   view:async()=>makeView('Package B','2'.repeat(64),[]),
   image:async()=>({width:16,height:16} as HTMLImageElement),page:async()=>({width:16,height:16} as HTMLImageElement),painting:()=>null,
   crop:async issue=>issue,
  };
  let phase:ReturnType<PartsHost['locked']>='open';let changedA=0;
  const hostA:PartsHost={initial:()=>[sampleIssue],locked:()=>phase,changed:()=>{changedA++;},register:out=>{outputs.a=out;}};
  const hostB:PartsHost={initial:()=>[],locked:()=>'open',changed:()=>{},register:out=>{outputs.b=out;}};

  const importUrl=new URL('../web/parts.ts',import.meta.url);importUrl.searchParams.set('c3','import-purity');
  const beforeImport=rootDoc.children.length;
  const pure=await import(importUrl.href);
  expect(pure.mountPartsWorkspace).toBeFunction();
  expect(rootDoc.children.length).toBe(beforeImport);
  expect(fakeDoc.handlers.size).toBe(0);
  handleA=mountPartsWorkspace(slotsA,sourceA,hostA,{defaultView:'assembled'});
  handleB=mountPartsWorkspace(slotsB,sourceB,hostB,{defaultView:'item'});
  let firstPaintSettled=false;
  void handleA.ready.then(()=>{firstPaintSettled=true;},()=>{});
  const waitReady=async(promise:Promise<void>,label:string,slots:ReturnType<typeof makeSlots>)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(label+' readiness pending '+JSON.stringify({caption:slots.hostWrap.querySelector('#pv-caption')?.textContent,status:slots.hostWrap.querySelector('#pv-save-status')?.textContent,load:slots.hostWrap.querySelector('#pv-load')?.textContent}))),500);})]);}
   finally{clearTimeout(timer);}
  };
  await waitReady(handleB.ready,'B',slotsB);
  for(let i=0;i<20;i++)await Promise.resolve();
  expect(firstPaintSettled).toBe(false);
  expect(slotsA.hostWrap.querySelector<FakeElement>('#pv-canvas')!.width).toBe(1);
  releaseFirstImage({width:16,height:16} as HTMLImageElement);
  await waitReady(handleA.ready,'A',slotsA);
  expect(firstPaintSettled).toBe(true);
  expect(slotsA.hostWrap.querySelector<FakeElement>('#pv-canvas')!.width).toBe(64);


  const sidebarA=slotsA.side as unknown as FakeElement,sidebarB=slotsB.side as unknown as FakeElement;
  const issueListA=sidebarA.querySelector<FakeElement>('.stage-comment-list')!;
  const issueListB=sidebarB.querySelector<FakeElement>('.stage-comment-list')!;
  expect(issueListA.parentElement).toBe(sidebarA);
  expect(issueListB.parentElement).toBe(sidebarB);
  for(const [slots,list] of [[slotsA,issueListA],[slotsB,issueListB]] as const){
   expect(slots.hostWrap.querySelectorAll('.stage-comment-list')).toHaveLength(1);
   expect(list.classList.contains('stage-comment-list-inline')).toBe(true);
   expect(list.hidden).toBe(false);
   expect(list.style.top).toBe('');
  }
  expect(issueListA.querySelectorAll('.stage-comment-item')).toHaveLength(1);
  expect(issueListA.querySelector('.stage-comment-summary')?.textContent).toContain('seam gap on A');
  expect(issueListB.querySelectorAll('.stage-comment-item')).toHaveLength(0);
  expect(issueListB.querySelector('p')?.textContent).toBe('No issues yet.');
  const partsCss=await readFile('web/parts.css','utf8');
  expect(partsCss).toMatch(/\.stage-comment-list\.stage-comment-list-inline\{position:static;/);

  expect(outputs.a?.kind).toBe('parts-verdict');
  expect(outputs.b?.kind).toBe('parts-verdict');
  expect(outputs.a!.value()).toEqual({verdict:'changes-requested',issues:[sampleIssue],words:''});
  expect(outputs.b!.value()).toEqual({verdict:'approved',issues:[],words:''});

  // Selecting 'covered' in instance A does not change instance B's selection ('gap').
  handleA.select('covered');
  const activeA=slotsA.hostWrap.querySelector<FakeElement>('button[aria-current="true"]');
  const activeB=slotsB.hostWrap.querySelector<FakeElement>('button[aria-current="true"]');
  expect(activeA?.dataset.pvItem).toBe('covered');
  expect(activeB?.dataset.pvItem).toBe('gap');

  // Badge counts stay isolated between instances A and B.
  const badgeA=slotsA.hostWrap.querySelector<FakeElement>('button[data-pv-item="gap"] .pv-badge');
  const badgeB=slotsB.hostWrap.querySelector<FakeElement>('button[data-pv-item="gap"] .pv-badge');
  expect(badgeA?.dataset.issues).toBe('1');
  expect(badgeB?.dataset.issues).toBe('0');
  expect(slotsA.hostWrap.querySelector('#pv-assemble')?.getAttribute('aria-pressed')).toBe('true');
  expect(slotsB.hostWrap.querySelector('#pv-assemble')?.getAttribute('aria-pressed')).toBe('false');
  const key=(key:string)=>({key,code:key,repeat:false,target:rootDoc,preventDefault(){},ctrlKey:false,metaKey:false,altKey:false});
  const toggleA=slotsA.hostWrap.querySelector<FakeElement>('#stage-comment')!;
  const toggleB=slotsB.hostWrap.querySelector<FakeElement>('#stage-comment')!;
  for(let i=0;i<20;i++)await Promise.resolve();
  slotsB.stage.focus();fakeDoc.emit('keydown',key('c'));
  expect(toggleA.getAttribute('aria-pressed')).toBe('false');
  expect(toggleB.getAttribute('aria-pressed')).toBe('true');
  slotsA.stage.focus();phase='sent';fakeDoc.emit('keydown',key('c'));
  expect(slotsA.hostWrap.querySelector('#stage-comment-refusal')?.textContent).toContain('Read-only');
  expect(changedA).toBe(0);
  fakeDoc.emit('keydown',key('Escape'));
  expect(toggleB.getAttribute('aria-pressed')).toBe('true');
  phase='open';
  slotsB.stage.focus();fakeDoc.emit('keydown',key('Escape'));
  expect(toggleB.getAttribute('aria-pressed')).toBe('false');
  expect(issueListA.hidden).toBe(false);expect(issueListB.hidden).toBe(false);
  expect(toggleB.getAttribute('aria-expanded')).toBe('true');

  const value=outputs.a!.value();
  if(!('issues' in value))throw new Error('Expected parts issue output');
  value.issues[0]!.summary='external mutation';
  expect(handleA.issues()[0]!.summary).toBe('seam gap on A');
  slotsA.stage.focus();
  const issueRow=slotsA.hostWrap.querySelector<FakeElement>('.stage-comment-summary')!;
  await issueRow.onclick!();
  const composer=slotsA.hostWrap.querySelector<FakeElement>('.stage-comment-composer')!;
  const field=composer.querySelector<FakeElement>('input')!;
  field.value='edited A issue';
  await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  expect(changedA).toBe(1);
  expect(handleA.issues()[0]!.summary).toBe('edited A issue');
  expect(handleB.issues()).toEqual([]);
  const documentKeyCount=fakeDoc.handlers.get('keydown')!.size;
  handleA.dispose();
  expect(fakeDoc.handlers.get('keydown')!.size).toBeLessThan(documentKeyCount);
  expect(slotsA.stage.children).toHaveLength(0);
  expect(sidebarA.querySelectorAll('.stage-comment-list')).toHaveLength(0);
  expect(sidebarB.querySelectorAll('.stage-comment-list')).toHaveLength(1);
  expect(()=>outputs.a!.value()).toThrow('PARTS_VERDICT_READ_ONLY');
  const failureSlots=makeSlots('failure');
  const failureMount=mountPartsWorkspace(failureSlots,{...sourceB,image:async()=>{throw new Error('planted-initial-image-error');}},{...hostB,register(){}},{defaultView:'item'});
  await expect(waitReady(failureMount.ready,'image-failure',failureSlots)).rejects.toThrow('planted-initial-image-error');
  failureMount.dispose();
  const sourceFailureSlots=makeSlots('source-failure');
  const sourceFailureMount=mountPartsWorkspace(sourceFailureSlots,{...sourceB,view:async()=>{throw new Error('planted-source-error');}},{...hostB,register(){}},{defaultView:'item'});
  await expect(waitReady(sourceFailureMount.ready,'source-failure',sourceFailureSlots)).rejects.toThrow('planted-source-error');
  sourceFailureMount.dispose();
  const disposalSlots=makeSlots('disposed-before-paint');
  let releaseDisposedImage!:(image:HTMLImageElement)=>void;
  const heldImage=new Promise<HTMLImageElement>(resolve=>{releaseDisposedImage=resolve;});
  const disposalMount=mountPartsWorkspace(disposalSlots,{...sourceB,image:()=>heldImage},{...hostB,register(){}},{defaultView:'item'});
  const disposalReady=waitReady(disposalMount.ready,'disposed',disposalSlots);
  disposalMount.dispose();
  await expect(disposalReady).rejects.toThrow('PARTS_WORKSPACE_DISPOSED');
  releaseDisposedImage({width:16,height:16} as HTMLImageElement);
  for(let i=0;i<20;i++)await Promise.resolve();
  expect(disposalSlots.stage.children).toHaveLength(0);
  handleB.select('covered');
  expect(slotsB.hostWrap.querySelector<FakeElement>('button[aria-current="true"]')?.dataset.pvItem).toBe('covered');

 }finally{
  handleA?.dispose();
  handleB?.dispose();
  if(savedDoc)Object.defineProperty(globalThis,'document',savedDoc);
  else delete (globalThis as any).document;
  if(savedWin)Object.defineProperty(globalThis,'window',savedWin);
  else delete (globalThis as any).window;
  if(savedRaf)Object.defineProperty(globalThis,'requestAnimationFrame',savedRaf);
  else delete (globalThis as any).requestAnimationFrame;
  if(savedCaf)Object.defineProperty(globalThis,'cancelAnimationFrame',savedCaf);
  else delete (globalThis as any).cancelAnimationFrame;
  if(savedRo)Object.defineProperty(globalThis,'ResizeObserver',savedRo);
  else delete (globalThis as any).ResizeObserver;
  if(savedMo)Object.defineProperty(globalThis,'MutationObserver',savedMo);
  else delete (globalThis as any).MutationObserver;
  if(savedEl)Object.defineProperty(globalThis,'Element',savedEl);
  else delete (globalThis as any).Element;
 }
});

test('#612 paired legacy verdict labels and admitted Korean values use polite 파츠 vocabulary',()=>{
 for(const key of ['PARTS_VERDICT_LEGACY_FORMAT','parts.legacyVerdictBanner']){
  expect(enCatalog[key]).toBeTruthy();
  expect(koCatalog[key]).toBeTruthy();
 }
 for(const key of ['REBUILD_REGION_DUPLICATE: {0} (two regions of the chest part carry this name)','PARTS_COMMENT_UNAVAILABLE: original part image required','Comments on this part: {count}','PARTS_COMPARISON_INVALID: part/overlay mode and opacity 0..1 required']){
  expect(koCatalog[key]).toContain('파츠');
  expect(koCatalog[key]).not.toMatch(/파트|필요해요|이름을 씀/);
 }
});
