import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {commentFixture,candidate} from './helpers/parts-comments-package.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {expect,test} from 'bun:test';
import {PNG} from 'pngjs';
import {createCanvas,loadImage,type Canvas} from '@napi-rs/canvas';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeMeshPackage} from './helpers/parts-mesh-package.ts';
import {buildVerdict,loadPartsView,verdictSource} from '../src/parts-view.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {getLanguage,setLanguagePreference,setLinkLanguage} from '../web/i18n.ts';
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

function partsMountDocument(raster = false) {
 class FakeElement {
  tagName:string;id='';className='';textContent='';title='';type='';value='';min='';max='';step='';
  hidden=false;disabled=false;checked=false;tabIndex=0;clientWidth=160;clientHeight=120;clientLeft=0;clientTop=0;
  private pixelWidth=16;private pixelHeight=16;
  private surface:Canvas|null=null;
  get width(){return this.pixelWidth;}
  set width(value:number){this.pixelWidth=value;if(this.surface)this.surface.width=value;}
  get height(){return this.pixelHeight;}
  set height(value:number){this.pixelHeight=value;if(this.surface)this.surface.height=value;}
  rasterSurface(){return this.surface??=createCanvas(this.width,this.height);}
  toDataURL(){return this.rasterSurface().toDataURL('image/png');}
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
   remove:(...tokens:string[])=>{const s=new Set(this.className.split(/\s+/).filter(Boolean));for(const t of tokens)s.delete(t);this.className=[...s].join(' ');},
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
  captured=new Set<number>();
  setPointerCapture(id:number){this.captured.add(id);}
  hasPointerCapture(id:number){return this.captured.has(id);}
  releasePointerCapture(id:number){this.captured.delete(id);}
  focus(){fakeDoc.activeElement=this;fakeDoc.emit('focusin',{target:this});}

  getBoundingClientRect(){
   let left=0,top=0,width=this.clientWidth,height=this.clientHeight;
   if(raster&&this.tagName==='CANVAS'){
    const root=this.closest('#rig-root')??this.closest('#reference-content');
    const zoom=Number(root?.style.transform.match(/scale\(([^)]+)\)/)?.[1]??1);
    left=parseFloat(root?.style.left??'0')||0;top=parseFloat(root?.style.top??'0')||0;
    width=this.width*zoom;height=this.height*zoom;
   }
   return {left,top,width,height,right:left+width,bottom:top+height,x:left,y:top};
  }
  getContext(){
   if(raster){
    const ctx=this.rasterSurface().getContext('2d');
    if(!(ctx as any).mountDrawImage){
     const drawImage=ctx.drawImage.bind(ctx);
     (ctx as any).mountDrawImage=true;
     ctx.drawImage=((image:any,...args:any[])=>drawImage(image instanceof FakeElement?image.rasterSurface():image,...args as [number,number])) as typeof ctx.drawImage;
    }
    return ctx;
   }
   return {
    imageSmoothingEnabled:false,fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,
    clearRect(){},fillRect(){},strokeRect(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
    getImageData:(_x:number,_y:number,w:number,h:number)=>({data:new Uint8ClampedArray(Math.max(4,w*h*4))}),
    putImageData(){},
   };
  }
 }

 const savedStyle=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');
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
  title:'',documentElement:rootDoc,visibilityState:'visible',
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
 if(raster)Object.defineProperty(globalThis,'getComputedStyle',{value:(node:FakeElement)=>({getPropertyValue:()=> '#3b82f6',backgroundColor:'transparent',backgroundImage:'none',backgroundSize:'auto',backgroundPosition:'0% 0%',display:node.hidden?'none':'block',visibility:node.style.visibility??'visible',opacity:'1',filter:'none',transformOrigin:'0px 0px',transform:'none',zIndex:'0'}),configurable:true,writable:true});
 Object.defineProperty(globalThis,'document',{value:fakeDoc,configurable:true,writable:true});
 Object.defineProperty(globalThis,'window',{value:fakeWin,configurable:true,writable:true});
 Object.defineProperty(globalThis,'requestAnimationFrame',{value:()=>1,configurable:true,writable:true});
 Object.defineProperty(globalThis,'cancelAnimationFrame',{value:()=>{},configurable:true,writable:true});
 Object.defineProperty(globalThis,'ResizeObserver',{value:FakeObserver,configurable:true,writable:true});
 Object.defineProperty(globalThis,'MutationObserver',{value:FakeObserver,configurable:true,writable:true});
 Object.defineProperty(globalThis,'Element',{value:FakeElement,configurable:true,writable:true});
  const makeSlots=(prefix:string)=>{
   const hostWrap=new FakeElement('div');hostWrap.id=`host-${prefix}`;
   const left=new FakeElement('aside'),stage=new FakeElement('main'),toolbar=new FakeElement('div'),side=new FakeElement('aside');
   hostWrap.append(left,stage,toolbar,side);
   rootDoc.append(hostWrap);
   return {left:left as unknown as HTMLElement,stage:stage as unknown as HTMLElement,toolbar:toolbar as unknown as HTMLElement,side:side as unknown as HTMLElement,hostWrap};
  };
 return {FakeElement, fakeDoc, fakeWin, rootDoc, makeSlots, cleanup() {
  if(savedStyle)Object.defineProperty(globalThis,'getComputedStyle',savedStyle);
  else delete (globalThis as any).getComputedStyle;
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
 }};
}

test('#612 two simultaneous mountPartsWorkspace instances in one document stay isolated across slots and host adapters',async()=>{
 expect(REGION_MARGIN).toBe(4);
 const partsSourceText=await readFile('web/parts.ts','utf8');
 expect(partsSourceText).not.toContain("getElementById('parts-app')");
 expect(partsSourceText).not.toContain('pageInstanceAccess(');

 const cropRoot=await mkdtemp(join(tmpdir(),'mount-edit-crops-'));
 const fixture=partsMountDocument();
 const {FakeElement, fakeDoc, rootDoc, makeSlots}=fixture;
 type FakeElement=InstanceType<typeof FakeElement>;
 let handleA:ReturnType<typeof mountPartsWorkspace>|null=null;
 let handleB:ReturnType<typeof mountPartsWorkspace>|null=null;
 try{
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
  await writeMeshPackage(cropRoot);
  const cropPackage=await loadPartsView(cropRoot);
  const cropPng=PNG.sync.write(new PNG({width:8,height:8}));
  const cropHash=new Bun.CryptoHasher('sha256').update(cropPng).digest('hex');
  sampleIssue.parts[0]!.imageHash=cropPackage.files.find(file=>file.abs===cropPackage.imagePaths[0])!.sha256;
  sampleIssue.crop={path:`comment-crops/${cropHash}.png`,sha256:cropHash,width:8,height:8,png:'data:image/png;base64,'+cropPng.toString('base64')};
  Object.assign(sampleIssue,await preparePartsComment(cropPackage,sampleIssue,false,{sourceHash:sampleIssue.sourceHash}));
  const makeView=(title:string,sourceHash:string,issues:PartsIssue[]):ViewData=>({
   mode:'parts',
   title,
   sourceHash,
   painting:null,
   rigSize:[64,64],
   items:[
    {name:'gap',index:0,x:0,y:0,w:16,h:16,imageHash:sampleIssue.parts[0]!.imageHash},
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
   crop:async issue=>preparePartsComment(cropPackage,issue,false,{sourceHash:sampleIssue.sourceHash}),
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
  const loadA=slotsA.hostWrap.querySelector<FakeElement>('#pv-load')!;
  const loadB=slotsB.hostWrap.querySelector<FakeElement>('#pv-load')!;
  expect(loadA.textContent).toBe('Saved sign-off loaded.');
  expect(loadB.textContent).toBe('');
  expect(loadA.getAttribute('role')).toBe('status');
  expect(loadA.parentElement).toBe(slotsA.stage as unknown as FakeElement);
  expect(loadA).not.toBe(slotsA.hostWrap.querySelector('#pv-save-status'));


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
  for(const slots of [slotsA,slotsB]){
   const mesh=slots.hostWrap.querySelector<FakeElement>('#pv-mesh-control input')!;
   expect(mesh.disabled).toBe(false);expect(mesh.checked).toBe(true);
   expect(slots.hostWrap.querySelector('#pv-mesh-control')?.textContent).toBe('Mesh (none 0/2)');
   expect(slots.hostWrap.querySelector('#pv-mesh-panel p')?.textContent).toBe('No mesh geometry is available for this draft.');
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
  fixture.cleanup();await rm(cropRoot,{recursive:true,force:true});
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


test('#613 C during a current paint exposes busy then clears only its owned status at readiness', async () => {
 const fixture=partsMountDocument();
 const slots=fixture.makeSlots('paint-readiness');
 const node=(id:string)=>slots.hostWrap.querySelector<InstanceType<typeof fixture.FakeElement>>('#'+id)!;
 const requested: (()=>void)[]=[];
 const arrivals=Array.from({length:4},(_,index)=>new Promise<void>(resolve=>{requested[index]=resolve;}));
 const releases: ((image:HTMLImageElement)=>void)[]=[];
 const rejects: ((error:Error)=>void)[]=[];
 const images=Array.from({length:4},(_,index)=>new Promise<HTMLImageElement>((resolve,reject)=>{releases[index]=resolve;rejects[index]=reject;}));
 const view:ViewData={mode:'parts',title:'Paint readiness',sourceHash:'1'.repeat(64),painting:null,rigSize:[64,64],
  items:Array.from({length:4},(_,index)=>({name:'part-'+index,index,x:0,y:0,w:16,h:16,imageHash:'a'.repeat(64)})),
  pages:[],flags:[],readings:[],flagSources:[],flagMissing:[],verdictFile:'parts-review.json',verdict:null,verdictStale:null};
 const handle=mountPartsWorkspace(slots,{view:async()=>view,image:index=>{requested[index]!();return images[index]!;},page:async()=>({} as HTMLImageElement),painting:()=>null,crop:async issue=>issue},
  {initial:()=>[],changed(){},register(){},locked:()=>'open'},{defaultView:'item'});
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 const browserSource=await readFile('tests/parts-comments-browser.ts','utf8');
 const definitions=browserSource.slice(browserSource.indexOf('const commentState='),browserSource.indexOf('function source('));
 const readinessExpression=new Function(definitions+';return commentReady;')() as string;
 const captureReady=new Function('document','return '+readinessExpression) as (document:unknown)=>boolean;
 const pressC=()=>{
  node('rig-viewport').focus();
  fixture.fakeDoc.emit('keydown',{key:'c',target:node('rig-viewport'),defaultPrevented:false,repeat:false,ctrlKey:false,metaKey:false,altKey:false,preventDefault(){}});
 };
 try{
  await arrivals[0];
  expect(slots.stage.dataset.partsPaintState).toBe('busy');
  expect(slots.stage.getAttribute('aria-busy')).toBe('true');
  expect(node('stage-comment').disabled).toBe(true);
  expect(node('stage-comment').textContent).toContain('Rendering');
  pressC();
  expect(node('pv-save-status').textContent).toContain('COMMENT_BUSY');
  releases[0]!({width:16,height:16} as HTMLImageElement);
  await handle.ready;
  expect(slots.stage.dataset.partsPaintState).toBe('ready');
  expect(node('stage-comment').disabled).toBe(false);
  expect(node('pv-save-status').textContent).toBe('');

  // Assemble waits for uncached part images even after the initial item is ready.
  node('pv-assemble').onclick!();await arrivals[1];
  expect(captureReady(fixture.fakeDoc)).toBe(false);
  expect(slots.stage.dataset.partsPaintState).toBe('busy');
  expect(node('stage-comment').disabled).toBe(true);
  node('fit').onclick!();
  expect(captureReady(fixture.fakeDoc)).toBe(false);
  expect(slots.stage.dataset.partsPaintState).toBe('busy');
  expect(node('stage-comment').disabled).toBe(true);
  node('stage-comment').onclick!();
  expect(node('stage-comment').getAttribute('aria-pressed')).toBe('false');
  expect(node('rig-viewport').classList.contains('stage-comment-mode')).toBe(false);
  expect(node('pv-save-status').textContent).toContain('COMMENT_BUSY');
  node('pv-assemble').onclick!();await flush();
  expect(captureReady(fixture.fakeDoc)).toBe(true);
  expect(slots.stage.dataset.partsPaintState).toBe('ready');
  expect(node('stage-comment').disabled).toBe(false);
  node('stage-comment').onclick!();
  expect(node('stage-comment').getAttribute('aria-pressed')).toBe('true');
  expect(node('rig-viewport').classList.contains('stage-comment-mode')).toBe(true);
  expect(node('reference-viewport').classList.contains('stage-comment-mode')).toBe(false);
  node('stage-comment').onclick!();
  expect(node('stage-comment').getAttribute('aria-pressed')).toBe('false');
  console.log('PARTS_ASSEMBLY_CAPTURE_CONTROL '+JSON.stringify({assembledWithPendingImage:'busy',afterFit:'busy',
   busyClickActivated:false,readyClickActivated:true,secondClickDeactivated:true,control:'actual mount and existing comment engine'}));

  handle.select('part-1');await arrivals[1];pressC();
  handle.select('part-2');await arrivals[2];pressC();
  releases[1]!({width:16,height:16} as HTMLImageElement);await flush();
  expect(slots.stage.dataset.partsPaintState).toBe('busy');
  expect(node('stage-comment').disabled).toBe(true);
  expect(node('pv-save-status').textContent).toContain('COMMENT_BUSY');
  releases[2]!({width:16,height:16} as HTMLImageElement);await flush();
  expect(slots.stage.dataset.partsPaintState).toBe('ready');
  expect(node('stage-comment').disabled).toBe(false);
  expect(node('pv-save-status').textContent).toBe('');

  handle.select('part-0');pressC();
  node('pv-save-status').textContent='Unrelated save status';await flush();
  expect(slots.stage.dataset.partsPaintState).toBe('ready');
  expect(node('pv-save-status').textContent).toBe('Unrelated save status');

  handle.select('part-3');await arrivals[3];pressC();
  rejects[3]!(new Error('planted-readiness-image-failure'));await flush();
  expect(slots.stage.dataset.partsPaintState).toBe('failed');
  expect(slots.stage.getAttribute('aria-busy')).toBe('false');
  expect(node('pv-save-status').textContent).toContain('PARTS_PAINT_FAILED');
 }finally{handle.dispose();fixture.cleanup();}
});

test('#614 shared mount creates real assembled issues, validates chip edits atomically and isolates P/hover/Escape lifetime',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c5-mount-'));
 const dom=partsMountDocument(true);
 const mounts:ReturnType<typeof mountPartsWorkspace>[]=[];
 try{
  const {writeComparisonPackage}=await import('./helpers/parts-comparison-package.ts');
  await writeComparisonPackage(root,true);
  const pkg=await loadPartsView(root,{painting:join(root,'painting.png')});
  const before=await Promise.all(pkg.files.map(file=>readFile(file.abs)));
  const originalImages=await Promise.all(pkg.imagePaths.map(path=>loadImage(path)));
  const originalPainting=await loadImage(join(root,'painting.png'));
  const items=pkg.items.map(item=>({...item,imageHash:pkg.files.find(file=>file.abs===pkg.imagePaths[item.index])!.sha256}));
  const slotsA=dom.makeSlots('c5-standalone'),slotsB=dom.makeSlots('c5-job');
  type Element=InstanceType<typeof dom.FakeElement>;
  const node=(slots:typeof slotsA,selector:string)=>slots.hostWrap.querySelector<Element>(selector)!;
  const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
  const key=(value:string)=>({key:value,repeat:false,defaultPrevented:false,target:dom.rootDoc,ctrlKey:false,metaKey:false,altKey:false,preventDefault(){this.defaultPrevented=true;}});
  const outputs:PanelOutput[]=[];const changes:PartsIssue[][][]=[[],[]];
  let phase:ReturnType<PartsHost['locked']>='open';
  let releaseCrop:(()=>void)|null=null,holdCrop=false,cropRequests=0;
  const mount=(slots:typeof slotsA,index:number)=>{
   const sourceHash=index===0?verdictSource(pkg).sha256:'a'.repeat(64);
   const data:ViewData={mode:'parts',title:'Synthetic C5',sourceHash,rigSize:pkg.rigSize,
    painting:pkg.painting?{sha256:pkg.painting.sha256,width:pkg.painting.width,height:pkg.painting.height}:null,
    items,pages:[],flags:[],flagSources:[],flagMissing:[],verdictFile:'parts-review.json',verdict:null,verdictStale:null};
   const source:PartsSource={view:async()=>data,
    image:async index=>originalImages[index] as unknown as HTMLImageElement,
    page:async()=>{throw Error('Unexpected atlas image');},painting:()=>Promise.resolve(originalPainting as unknown as HTMLImageElement),
    crop:async issue=>{
     cropRequests++;
     const prepared=await preparePartsComment(pkg,issue,false,{sourceHash});
     if(holdCrop)await new Promise<void>(resolve=>{releaseCrop=resolve;});
     return prepared;
    }};
   const host:PartsHost={initial:()=>[],changed:issues=>changes[index]!.push(issues),register:output=>{outputs[index]=output;},locked:()=>phase};
   const handle=mountPartsWorkspace(slots,source,host,{defaultView:'assembled'});mounts.push(handle);return handle;
  };
  const a=mount(slotsA,0),b=mount(slotsB,1);
  await Promise.all([a.ready,b.ready]);
  expect(node(slotsA,'#pv-bg').value).toBe('checker');
  expect(node(slotsB,'#pv-bg').value).toBe('checker');
  for(const slots of [slotsA,slotsB]){
   const mesh=node(slots,'#pv-mesh-control input');expect(mesh.disabled).toBe(false);mesh.checked=true;mesh.onchange!();
  }
  await tick();
  const canvasA=node(slotsA,'#pv-canvas'),canvasB=node(slotsB,'#pv-canvas');
  const pixels=()=>canvasA.toDataURL();const base=pixels();const otherBase=canvasB.toDataURL();
  const paneA=node(slotsA,'#rig-viewport'),paneB=node(slotsB,'#rig-viewport');
  node(slotsA,'[data-pv-comparison="overlay"]').onclick!();await tick();
  expect(node(slotsA,'#pv-mesh-control input').disabled).toBe(false);
  expect(node(slotsA,'#pv-mesh-control input').checked).toBe(true);
  const overlayWithMesh=pixels();const overlayToggle=node(slotsA,'#pv-mesh-control input');overlayToggle.checked=false;overlayToggle.onchange!();await tick();
  expect(pixels()).not.toBe(overlayWithMesh);overlayToggle.checked=true;overlayToggle.onchange!();await tick();
  expect(pixels()).toBe(overlayWithMesh);node(slotsA,'[data-pv-comparison="part"]').onclick!();await tick();
  paneA.focus();dom.fakeDoc.emit('keydown',key('p'));await tick();
  expect(pixels()).not.toBe(base);expect(canvasB.toDataURL()).toBe(otherBase);
  expect(node(slotsA,'#stage-comment').disabled).toBe(true);
  const painted=pixels();dom.fakeDoc.emit('keydown',key('c'));
  expect(node(slotsA,'#stage-comment').getAttribute('aria-pressed')).toBe('false');
  expect(pixels()).toBe(painted);expect(a.issues()).toEqual([]);
  dom.fakeDoc.emit('keyup',key('p'));await tick();expect(pixels()).toBe(base);
  for(let hold=0;hold<2;hold++){
   dom.fakeDoc.visibilityState='visible';
   dom.fakeDoc.emit('keydown',key('p'));await tick();
   expect(pixels()).toBe(painted);expect(node(slotsA,'#stage-comment').disabled).toBe(true);
   dom.fakeDoc.emit('visibilitychange',{});await tick();
   expect(pixels()).toBe(painted);expect(node(slotsA,'#stage-comment').disabled).toBe(true);
   dom.fakeDoc.visibilityState='hidden';dom.fakeDoc.emit('visibilitychange',{});await tick();
   expect(pixels()).toBe(base);expect(node(slotsA,'#stage-comment').disabled).toBe(false);
   expect(slotsA.stage.dataset.partsPaintState).toBe('ready');
   expect(canvasB.toDataURL()).toBe(otherBase);expect(node(slotsB,'#stage-comment').disabled).toBe(false);
   dom.fakeDoc.visibilityState='visible';dom.fakeDoc.emit('visibilitychange',{});await tick();
   expect(pixels()).toBe(base);
  }
  dom.fakeDoc.emit('keydown',key('p'));await tick();dom.fakeWin.emit('blur',{});await tick();expect(pixels()).toBe(base);
  dom.fakeDoc.emit('keydown',key('p'));await tick();paneB.focus();await tick();expect(pixels()).toBe(base);
  paneA.focus();
  const event=(point:{x:number;y:number},extra:Record<string,unknown>={})=>{
   const bounds=canvasA.getBoundingClientRect(),zoom=bounds.width/canvasA.width;
   return {button:0,buttons:0,isPrimary:true,pointerId:17,clientX:bounds.left+point.x*zoom,clientY:bounds.top+point.y*zoom,target:paneA,
    preventDefault(){},stopImmediatePropagation(){},...extra};
  };
  paneA.emit('pointermove',event({x:15,y:9}));
  expect(node(slotsA,'[data-assembly-hover="front"] span').textContent).toBe('front');
  expect(slotsB.hostWrap.querySelector('[data-assembly-hover]')).toBeNull();
  paneA.emit('pointerleave',{});expect(slotsA.hostWrap.querySelector('[data-assembly-hover]')).toBeNull();
  paneA.emit('dblclick',event({x:15,y:9}));await tick();
  expect(node(slotsA,'#pv-assemble').getAttribute('aria-pressed')).toBe('false');
  expect(node(slotsA,'button[aria-current="true"]').dataset.pvItem).toBe('front');
  expect(node(slotsA,'#pv-mesh-control input').checked).toBe(true);
  expect(node(slotsA,'#pv-mesh-panel p').textContent).toBe('No mesh geometry is available for this part.');
  const toggle=node(slotsA,'#pv-mesh-control input');toggle.checked=false;toggle.onchange!();await tick();
  dom.fakeDoc.emit('keydown',key('Escape'));await tick();
  expect(node(slotsA,'#pv-assemble').getAttribute('aria-pressed')).toBe('true');
  expect(node(slotsA,'#pv-mesh-control input').checked).toBe(false);
  const drag=async(from:{x:number;y:number},to:{x:number;y:number})=>{
   paneA.emit('pointerdown',event(from,{buttons:1}));paneA.emit('pointermove',event(to,{buttons:1}));
   await Promise.all([...paneA.handlers.get('pointerup')!].map(handler=>handler(event(to))));
  };
  dom.fakeDoc.emit('keydown',key('c'));
  await drag({x:12,y:7},{x:20,y:15});
  let composer=node(slotsA,'.stage-comment-composer');
  const chips=()=>composer.querySelector<Element>('.stage-comment-parts')!.children;
  expect(chips().filter(chip=>chip.getAttribute('aria-pressed')==='true').map(chip=>chip.textContent)).toEqual(['body','front']);
  composer.querySelector<Element>('input')!.value='Shared seam';
  await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  expect(a.issues()).toHaveLength(1);expect(changes[0]).toHaveLength(1);expect(b.issues()).toEqual([]);
  const issue=a.issues()[0]!;
  expect(issue.parts.map(part=>part.name)).toEqual(['body','front']);
  expect(issue.view.mode).toBe('assembled');expect(issue.imageRegion).toBeNull();expect(issue.nativeCrop).toBeNull();
  expect(issue.rigRegion).toEqual({x:12,y:7,width:8,height:8});
  const {readPngCrop}=await import('../src/comment-crops.ts');
  const crop=PNG.sync.read(await readPngCrop(issue.crop));expect(crop.width).toBe(issue.crop.width);expect(crop.data.some(channel=>channel>0)).toBe(true);
  await node(slotsA,'.stage-comment-summary').onclick!();await tick();
  expect(slotsA.hostWrap.querySelectorAll('[data-assembly-outline]')).toHaveLength(2);
  composer=node(slotsA,'.stage-comment-composer');const input=composer.querySelector<Element>('input')!;
  input.value='Invalid narrowed seam';chips().find(chip=>chip.textContent==='body')!.onclick!();
  const requestsBefore=cropRequests;
  await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  expect(node(slotsA,'[role="alert"]').textContent).toContain('PARTS_COMMENT_OUT_OF_BOUNDS');
  expect(a.issues()).toEqual([issue]);expect(outputs[0]!.value()).toMatchObject({issues:[issue]});expect(cropRequests).toBe(requestsBefore);
  chips().find(chip=>chip.textContent==='body')!.onclick!();input.value='Validated seam';holdCrop=true;
  const pending=(composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  await tick();expect(releaseCrop).not.toBeNull();phase='sent';holdCrop=false;(releaseCrop as unknown as ()=>void)();await pending;
  expect(a.issues()).toEqual([issue]);expect(changes[0]).toHaveLength(1);
  phase='open';await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  expect(a.issues()[0]!.summary).toBe('Validated seam');expect(changes[0]).toHaveLength(2);
  dom.fakeDoc.emit('keydown',key('Escape'));expect(node(slotsA,'.stage-comment-list').hidden).toBe(false);
  dom.fakeDoc.emit('keydown',key('c'));await drag({x:15,y:9},{x:18,y:12});
  composer=node(slotsA,'.stage-comment-composer');
  expect(chips().filter(chip=>chip.getAttribute('aria-pressed')==='true').map(chip=>chip.textContent)).toEqual(['front']);
  dom.fakeDoc.emit('keydown',key('Escape'));
  dom.fakeDoc.emit('keydown',key('c'));await drag({x:0,y:0},{x:2,y:2});
  composer=node(slotsA,'.stage-comment-composer');expect(chips().every(chip=>chip.getAttribute('aria-pressed')==='false')).toBe(true);
  composer.querySelector<Element>('input')!.value='Empty background';await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  expect(node(slotsA,'[role="alert"]').textContent).toBe('Select at least one part.');expect(a.issues()).toHaveLength(1);
  dom.fakeDoc.emit('keydown',key('Escape'));dom.fakeDoc.emit('keydown',key('c'));await drag({x:12,y:7},{x:20,y:15});
  composer=node(slotsA,'.stage-comment-composer');composer.querySelector<Element>('input')!.value='Disposed pending seam';holdCrop=true;
  const disposedSave=(composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
  await tick();a.dispose();holdCrop=false;(releaseCrop as unknown as ()=>void)();await disposedSave;
  expect(changes[0]).toHaveLength(2);expect(slotsA.stage.children).toHaveLength(0);
  expect(slotsA.side.querySelectorAll('.stage-comment-list')).toHaveLength(0);
  expect(slotsB.side.querySelectorAll('.stage-comment-list')).toHaveLength(1);
  expect(b.issues()).toEqual([]);expect(await Promise.all(pkg.files.map(file=>readFile(file.abs)))).toEqual(before);
  const visibilityListeners=dom.fakeDoc.handlers.get('visibilitychange')!;
  expect(visibilityListeners.size).toBe(1);
  paneB.focus();dom.fakeDoc.emit('keydown',key('p'));await tick();
  expect(node(slotsB,'#stage-comment').disabled).toBe(true);
  b.dispose();expect(visibilityListeners.size).toBe(0);
  dom.fakeDoc.visibilityState='hidden';dom.fakeDoc.emit('visibilitychange',{});
  dom.fakeDoc.emit('keyup',key('p'));dom.fakeWin.emit('blur',{});await tick();
  expect(slotsB.stage.children).toHaveLength(0);expect(slotsB.stage.dataset.partsPaintState).toBe('disposed');
 }finally{for(const mount of mounts)mount.dispose();dom.cleanup();await rm(root,{recursive:true,force:true});}
});

test('#620 EN/KO stage comment drags save identical regions and native RGBA crops across first paint and toolbar layout transitions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c620-mount-'));
 const dom=partsMountDocument(true);
 const mounts:ReturnType<typeof mountPartsWorkspace>[]=[];
 const savedPref=getLanguage();
 try{
  const {writeComparisonPackage}=await import('./helpers/parts-comparison-package.ts');
  const {readPngCrop}=await import('../src/comment-crops.ts');
  const {writeFile}=await import('node:fs/promises');
  await writeComparisonPackage(root,true);
  const rawParts=JSON.parse(await readFile(join(root,'parts.json'),'utf8'));
  rawParts.parts[0].w=16;rawParts.parts[0].h=16;
  await writeFile(join(root,'parts.json'),JSON.stringify(rawParts,null,2)+'\n');
  const rawRig=JSON.parse(await readFile(join(root,'rig.json'),'utf8'));
  rawRig.skins.default.body.body.width=16;rawRig.skins.default.body.body.height=16;
  await writeFile(join(root,'rig.json'),JSON.stringify(rawRig));
  const fullBody=PNG.sync.read(await readFile(join(root,'parts/body.png')));
  const body16=new PNG({width:16,height:16});
  for(let y=0;y<16;y++)body16.data.set(fullBody.data.subarray(y*20*4,(y*20+16)*4),y*16*4);
  await writeFile(join(root,'parts/body.png'),PNG.sync.write(body16));
  const pkg=await loadPartsView(root,{painting:join(root,'painting.png')});
  const originalImages=await Promise.all(pkg.imagePaths.map(path=>loadImage(path)));
  const originalPainting=await loadImage(join(root,'painting.png'));
  const sourceHash=verdictSource(pkg).sha256;
  const items=pkg.items.map(item=>({...item,imageHash:pkg.files.find(file=>file.abs===pkg.imagePaths[item.index])!.sha256}));
  const bodyItem=items.find(item=>item.name==='body')!;
  const bodyPng=PNG.sync.read(await readFile(pkg.imagePaths[bodyItem.index]!));
  const expectedSubrect=new Uint8Array(10*10*4);
  for(let y=0;y<10;y++){
   const srcStart=((y+2)*bodyPng.width+2)*4;
   expectedSubrect.set(bodyPng.data.subarray(srcStart,srcStart+10*4),y*10*4);
  }
  type Element=InstanceType<typeof dom.FakeElement>;
  const node=(slots:ReturnType<typeof dom.makeSlots>,selector:string)=>slots.hostWrap.querySelector<Element>(selector)!;
  const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};

  const runLanguage=async(lang:'en'|'ko',withLayoutShift=false)=>{
   setLinkLanguage(null);
   setLanguagePreference(lang);
   const slots=dom.makeSlots(`c620-${lang}-${withLayoutShift?'shift':'paint'}`);
   let extraRowOffset=0;
   const data:ViewData={mode:'parts',title:'Synthetic C620',sourceHash,rigSize:pkg.rigSize,
    painting:pkg.painting?{sha256:pkg.painting.sha256,width:pkg.painting.width,height:pkg.painting.height}:null,
    items,pages:[],flags:[],flagSources:[],flagMissing:[],verdictFile:'parts-review.json',verdict:null,verdictStale:null};
   const source:PartsSource={view:async()=>data,
    image:async index=>originalImages[index] as unknown as HTMLImageElement,
    page:async()=>{throw Error('Unexpected atlas image');},painting:()=>Promise.resolve(originalPainting as unknown as HTMLImageElement),
    crop:async issue=>preparePartsComment(pkg,issue,false,{sourceHash})};
   const host:PartsHost={initial:()=>[],changed:()=>{},register:()=>{},locked:()=>'open'};
   const handle=mountPartsWorkspace(slots,source,host,{defaultView:'assembled'});
   mounts.push(handle);
   const pane=node(slots,'#rig-viewport');
   const commentBtn=node(slots,'#stage-comment');
   pane.clientWidth=437;
   Object.defineProperty(pane,'clientHeight',{
    configurable:true,
    get:()=>{
     const wrapped=lang==='en'||commentBtn.textContent.includes('렌더링 중');
     return (wrapped?695:722)-extraRowOffset;
    }
   });
   await handle.ready;
   await tick();
   const canvas=node(slots,'#pv-canvas');
   const dragCanvas=async(x0:number,y0:number,x1:number,y1:number)=>{
    const box=canvas.getBoundingClientRect();
    const sx=box.width/(canvas.width||16),sy=box.height/(canvas.height||16);
    const p0={clientX:Math.floor(box.left+x0*sx),clientY:Math.floor(box.top+y0*sy)};
    const p1={clientX:Math.floor(box.left+x1*sx),clientY:Math.floor(box.top+y1*sy)};
    const mk=(pt:{clientX:number;clientY:number},buttons:number)=>({
     button:0,buttons,isPrimary:true,pointerId:23,clientX:pt.clientX,clientY:pt.clientY,target:pane,
     preventDefault(){},stopImmediatePropagation(){}
    });
    pane.emit('pointerdown',mk(p0,1));
    pane.emit('pointermove',mk(p1,1));
    await Promise.all([...pane.handlers.get('pointerup')!].map(handler=>handler(mk(p1,0))));
   };

   const ensureCapture=()=>{if(commentBtn.getAttribute('aria-pressed')!=='true')commentBtn.onclick!();};
   node(slots,'button[data-pv-item="body"]').onclick!();
   if(node(slots,'#pv-assemble').getAttribute('aria-pressed')==='true')node(slots,'#pv-assemble').onclick!();
   node(slots,'#native-one').onclick!();
   for(let i=0;i<4;i++)node(slots,'#zoom-in').onclick!();
   await tick();

   if(withLayoutShift)extraRowOffset=27;
   ensureCapture();
   await dragCanvas(3,3,12,12);
   let composer=node(slots,'.stage-comment-composer');
   composer.querySelector<Element>('input')!.value=`item-${lang}`;
   await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
   commentBtn.onclick!();
   expect(handle.issues()).toHaveLength(1);
   expect(handle.issues()[0]!.imageRegion).toEqual({x:2,y:2,width:10,height:10});
   expect(handle.issues()[0]!.rigRegion).toEqual({x:6,y:6,width:10,height:10});

   node(slots,'#pv-assemble').onclick!();
   node(slots,'#native-one').onclick!();
   for(let i=0;i<4;i++)node(slots,'#zoom-in').onclick!();
   await tick();
   ensureCapture();
   await dragCanvas(12,7,20,15);
   composer=node(slots,'.stage-comment-composer');
   composer.querySelector<Element>('input')!.value=`assembled-${lang}`;
   await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
   commentBtn.onclick!();

   node(slots,'#pv-assemble').onclick!();
   node(slots,'#native-one').onclick!();
   for(let i=0;i<4;i++)node(slots,'#zoom-in').onclick!();
   await tick();
   const pin=node(slots,'.stage-comment-pin'),rigRoot=node(slots,'#rig-root');
   const zoom=Number(rigRoot.style.transform.match(/scale\(([^)]+)\)/)?.[1]??1);
   expect(parseFloat(pin.style.left)-parseFloat(rigRoot.style.left)).toBeCloseTo(2*zoom,5);
   expect(parseFloat(pin.style.top)-parseFloat(rigRoot.style.top)).toBeCloseTo(2*zoom,5);
   ensureCapture();
   await dragCanvas(-3,-3,-1,-1);
   composer=node(slots,'.stage-comment-composer');
   composer.querySelector<Element>('input')!.value=`empty-${lang}`;
   await (composer as unknown as HTMLFormElement).onsubmit!({preventDefault(){}} as SubmitEvent);
   expect(node(slots,'[role="alert"]').textContent).toContain('PARTS_COMMENT_EMPTY');
   commentBtn.onclick!();

   const issues=handle.issues();
   expect(issues).toHaveLength(2);
   expect(issues[0]!.imageRegion).toEqual({x:2,y:2,width:10,height:10});
   expect(issues[0]!.rigRegion).toEqual({x:6,y:6,width:10,height:10});
   expect(issues[1]!.rigRegion).toEqual({x:11,y:6,width:9,height:9});
   expect(issues[0]!.sourceHash).toBe(sourceHash);
   expect(issues[0]!.parts).toEqual([{name:'body',imageHash:bodyItem.imageHash!}]);
   expect(issues[0]!.nativeCrop).not.toBeNull();
   const decoded=PNG.sync.read(await readPngCrop(issues[0]!.nativeCrop!));
   expect({width:decoded.width,height:decoded.height}).toEqual({width:10,height:10});
   expect(new Uint8Array(decoded.data)).toEqual(expectedSubrect);
   return issues;
  };

  const enIssues=await runLanguage('en',false);
  const koIssues=await runLanguage('ko',false);
  expect(koIssues[0]!.imageRegion).toEqual(enIssues[0]!.imageRegion);
  expect(koIssues[0]!.rigRegion).toEqual(enIssues[0]!.rigRegion);
  expect(koIssues[0]!.nativeCrop!.sha256).toBe(enIssues[0]!.nativeCrop!.sha256);
  expect(koIssues[1]!.rigRegion).toEqual(enIssues[1]!.rigRegion);
  const enShift=await runLanguage('en',true);
  const koShift=await runLanguage('ko',true);
  expect(koShift[0]!.imageRegion).toEqual(enShift[0]!.imageRegion);

  const failSlots=dom.makeSlots('c620-final-fit-fail');
  const failData:ViewData={mode:'parts',title:'Synthetic C620 Fail',sourceHash,rigSize:pkg.rigSize,
   painting:null,items,pages:[],flags:[],flagSources:[],flagMissing:[],verdictFile:'parts-review.json',verdict:null,verdictStale:null};
  const failSource:PartsSource={view:async()=>failData,
   image:async index=>originalImages[index] as unknown as HTMLImageElement,
   page:async()=>{throw Error('Unexpected atlas image');},painting:()=>Promise.resolve(originalPainting as unknown as HTMLImageElement),
   crop:async issue=>preparePartsComment(pkg,issue,false,{sourceHash})};
  const failHost:PartsHost={initial:()=>[],changed:()=>{},register:()=>{},locked:()=>'open'};
  const failHandle=mountPartsWorkspace(failSlots,failSource,failHost,{defaultView:'item'});
  mounts.push(failHandle);
  const failPane=node(failSlots,'#rig-viewport');
  let throwFinalFit=true;
  Object.defineProperty(failPane,'clientHeight',{
   configurable:true,
   get:()=>{
    if(throwFinalFit&&failSlots.stage.dataset.partsPaintState==='ready'){
     throwFinalFit=false;
     throw new Error('planted-final-fit-failure');
    }
    return 722;
   }
  });
  await expect(failHandle.ready).rejects.toThrow('planted-final-fit-failure');
  expect(failSlots.stage.dataset.partsPaintState).toBe('failed');
  expect(failSlots.stage.getAttribute('aria-busy')).toBe('false');
  expect(node(failSlots,'#pv-save-status').textContent).toContain('PARTS_PAINT_FAILED');
 }finally{
  setLinkLanguage(null);
  setLanguagePreference(savedPref);
  for(const mount of mounts)mount.dispose();
  dom.cleanup();
  await rm(root,{recursive:true,force:true});
 }
});
