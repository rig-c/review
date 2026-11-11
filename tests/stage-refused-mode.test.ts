import {expect,test} from 'bun:test';
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {setLanguagePreference,t} from '../web/i18n.ts';
import {bindHeaderModeAvailability} from '../web/workspace-ui.ts';
import {bindInspectorTabs} from '../web/view-controls.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';

class HarnessElement {
 tagName:string;
 id='';
 className='';
 type='';
 hidden=false;
 disabled=false;
 inert=false;
 tabIndex=0;
 title='';
 textContent='';
 src='';
 dataset:Record<string,string>={};
 style:Record<string,string>={};
 children:HarnessElement[]=[];
 parentElement:HarnessElement|null=null;
 onclick:((event?:any)=>void)|null=null;
 onkeydown:((event?:any)=>void)|null=null;
 private attrs=new Map<string,string>();
 private listeners=new Map<string,{fn:(event?:any)=>void;capture:boolean}[]>();
 classList={
  set:new Set<string>(),
  add:(...names:string[])=>{for(const n of names)this.classList.set.add(n);},
  remove:(...names:string[])=>{for(const n of names)this.classList.set.delete(n);},
  contains:(name:string)=>this.classList.set.has(name),
 };
 constructor(tagName='div'){this.tagName=tagName.toUpperCase();}
 append(...nodes:HarnessElement[]){
  for(const node of nodes){node.parentElement=this;this.children.push(node);}
 }
 remove(){
  if(!this.parentElement)return;
  this.parentElement.children=this.parentElement.children.filter(child=>child!==this);
  this.parentElement=null;
 }
 setAttribute(name:string,value:string){
  const str=String(value);
  const prev=this.attrs.get(name);
  this.attrs.set(name,str);
  if(name==='title')this.title=str;
  if(name==='id')this.id=str;
  if(name.startsWith('data-')){
   const camel=name.slice(5).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase());
   this.dataset[camel]=str;
  }
  if(prev!==str)HarnessMutationObserver.notify(this,name);
 }
 getAttribute(name:string):string|null{
  if(name==='title'&&!this.attrs.has('title'))return null;
  return this.attrs.get(name)??null;
 }
 hasAttribute(name:string):boolean{return this.attrs.has(name);}
 removeAttribute(name:string){
  const had=this.attrs.has(name);
  this.attrs.delete(name);
  if(name==='title')this.title='';
  if(had)HarnessMutationObserver.notify(this,name);
 }
 addEventListener(type:string,fn:(event?:any)=>void,options?:boolean|{capture?:boolean}){
  const capture=typeof options==='boolean'?options:Boolean(options?.capture);
  const list=this.listeners.get(type)??[];
  list.push({fn,capture});
  this.listeners.set(type,list);
 }
 removeEventListener(type:string,fn:(event?:any)=>void,options?:boolean|{capture?:boolean}){
  const capture=typeof options==='boolean'?options:Boolean(options?.capture);
  const list=this.listeners.get(type);
  if(!list)return;
  this.listeners.set(type,list.filter(entry=>!(entry.fn===fn&&entry.capture===capture)));
 }
 click(){
  if(this.disabled)return;
  let stopped=false;
  const event={
   type:'click',
   target:this,
   defaultPrevented:false,
   preventDefault(){this.defaultPrevented=true;},
   stopImmediatePropagation(){stopped=true;},
  };
  const entries=this.listeners.get('click')??[];
  for(const entry of [...entries].filter(e=>e.capture)){
   entry.fn(event);
   if(stopped)return;
  }
  if(this.onclick){
   this.onclick(event);
   if(stopped)return;
  }
  for(const entry of [...entries].filter(e=>!e.capture)){
   entry.fn(event);
   if(stopped)return;
  }
 }
 closest(selector:string):HarnessElement|null{
  let cur:HarnessElement|null=this;
  while(cur){
   if(selector==='header'&&cur.tagName==='HEADER')return cur;
   cur=cur.parentElement;
  }
  return null;
 }
 getBoundingClientRect(){return {left:0,top:0,right:120,bottom:48,width:120,height:48};}
 querySelectorAll(selector:string):HarnessElement[]{
  const out:HarnessElement[]=[];
  const visit=(node:HarnessElement)=>{
   for(const child of node.children){
    if(matchesSelector(child,selector))out.push(child);
    visit(child);
   }
  };
  visit(this);
  return out;
 }
 querySelector(selector:string):HarnessElement|null{
  return this.querySelectorAll(selector)[0]??null;
 }
}

class HarnessMutationObserver {
 static active=new Set<HarnessMutationObserver>();
 private targets=new Map<HarnessElement,Set<string>|null>();
 private callback:()=>void;
 constructor(callback:()=>void){this.callback=callback;}
 observe(target:HarnessElement,options?:{attributes?:boolean;attributeFilter?:string[]}){
  this.targets.set(target,options?.attributeFilter?new Set(options.attributeFilter):null);
  HarnessMutationObserver.active.add(this);
 }
 disconnect(){
  this.targets.clear();
  HarnessMutationObserver.active.delete(this);
 }
 static notify(target:HarnessElement,attributeName:string){
  for(const observer of [...HarnessMutationObserver.active]){
   if(!observer.targets.has(target))continue;
   const filter=observer.targets.get(target);
   if(!filter||filter.has(attributeName))observer.callback();
  }
 }
}

function matchesSelector(node:HarnessElement,selector:string):boolean {
 return selector.split(',').map(part=>part.trim()).some(part=>{
  if(part==='.mode-switch')return node.className.split(/\s+/).includes('mode-switch');
  if(part==='.layout')return node.className.split(/\s+/).includes('layout');
  if(part==='.pv-layout')return node.className.split(/\s+/).includes('pv-layout');
  if(part==='[data-mode]')return node.dataset.mode!==undefined;
  if(part==='[data-inspector]')return node.dataset.inspector!==undefined;
  if(part==='[data-inspector-panel]')return node.dataset.inspectorPanel!==undefined;
  if(part==='[data-build-side]')return node.dataset.buildSide!==undefined;
  if(part==='[data-review-stage]')return node.dataset.reviewStage!==undefined;
  if(part==='.review-stage-panel')return node.className.split(/\s+/).includes('review-stage-panel');
  const stageMatch=/^\[data-review-stage="(\d+)"\]$/.exec(part);
  if(stageMatch)return node.dataset.reviewStage===stageMatch[1];
  const inspectorMatch=/^\[data-inspector="([^"]+)"\]$/.exec(part);
  if(inspectorMatch)return node.dataset.inspector===inspectorMatch[1];
  return false;
 });
}

function buildHeaderDom() {
 const root=new HarnessElement('html');
 const body=new HarnessElement('body');
 const header=new HarnessElement('header');
 header.className='topbar';

 const modeSwitch=new HarnessElement('div');
 modeSwitch.className='mode-switch';
 modeSwitch.setAttribute('role','group');
 modeSwitch.setAttribute('aria-label','Mode');

 const setupBtn=new HarnessElement('button');
 setupBtn.type='button';
 setupBtn.textContent='Setup';
 setupBtn.setAttribute('data-mode','rig');
 setupBtn.setAttribute('data-inspector','rig');
 setupBtn.setAttribute('aria-pressed','true');

 const animateBtn=new HarnessElement('button');
 animateBtn.type='button';
 animateBtn.textContent='Animate';
 animateBtn.setAttribute('data-mode','playback');
 animateBtn.setAttribute('data-inspector','playback');
 animateBtn.setAttribute('aria-pressed','false');

 const compareTitle='No second build supplied: reopen with --compare <built> --reference <video>';
 const compareBtn=new HarnessElement('button');
 compareBtn.type='button';
 compareBtn.textContent='Compare';
 compareBtn.disabled=true;
 compareBtn.setAttribute('data-mode','compare');
 compareBtn.setAttribute('aria-pressed','false');
 compareBtn.setAttribute('title',compareTitle);

 modeSwitch.append(setupBtn,animateBtn,compareBtn);

 const picker=new HarnessElement('div');
 picker.id='mode-build-picker';
 picker.className='mode-build-picker';
 picker.hidden=true;
 picker.setAttribute('aria-label','Picked build for Setup and Animate');
 const sideA=new HarnessElement('button');
 sideA.type='button';
 sideA.setAttribute('data-build-side','a');
 sideA.setAttribute('aria-pressed','true');
 const sideB=new HarnessElement('button');
 sideB.type='button';
 sideB.setAttribute('data-build-side','b');
 sideB.setAttribute('aria-pressed','false');
 picker.append(sideA,sideB);

 header.append(modeSwitch,picker);

 const workspace=new HarnessElement('div');
 workspace.className='layout';
 const tabView=new HarnessElement('button');
 tabView.type='button';
 tabView.setAttribute('role','tab');
 tabView.setAttribute('data-inspector','view');
 tabView.setAttribute('aria-selected','true');
 const tabRig=new HarnessElement('button');
 tabRig.type='button';
 tabRig.setAttribute('role','tab');
 tabRig.setAttribute('data-inspector','rig');
 tabRig.setAttribute('aria-selected','false');
 const panelRig=new HarnessElement('section');
 panelRig.setAttribute('data-inspector-panel','rig');
 const panelPlayback=new HarnessElement('section');
 panelPlayback.hidden=true;
 panelPlayback.setAttribute('data-inspector-panel','playback');
 workspace.append(tabView,tabRig,panelRig,panelPlayback);

 body.append(header,workspace);
 root.append(body);

 const documentStub={
  body,
  documentElement:root,
  createElement:(tag:string)=>new HarnessElement(tag),
  getElementById:(id:string)=>root.querySelectorAll('*').find(el=>el.id===id)??(picker.id===id?picker:null),
  querySelector:(selector:string)=>root.querySelector(selector),
  querySelectorAll:(selector:string)=>root.querySelectorAll(selector),
 };
 return {root,body,header,modeSwitch,setupBtn,animateBtn,compareBtn,compareTitle,picker,workspace,tabView,tabRig,panelRig,panelPlayback,documentStub};
}

function withDom<T>(dom:ReturnType<typeof buildHeaderDom>,href:string,run:()=>Promise<T>|T):Promise<T> {
 const globals={
  document:dom.documentStub,
  location:new URL(href),
  window:{addEventListener(){},removeEventListener(){}},
  MutationObserver:HarnessMutationObserver,
  fetch:async()=>Response.json({error:'INTERVIEW_UNAVAILABLE'},{status:404}),
 };
 const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 return (async()=>{
  try{
   for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
   return await run();
  }finally{
   HarnessMutationObserver.active.clear();
   for(const [key,descriptor] of descriptors){
    if(descriptor)Object.defineProperty(globalThis,key,descriptor);
    else Reflect.deleteProperty(globalThis,key);
   }
  }
 })();
}

test('#735 refused header controls retain exact EN/KO reasons, relock mutations and restore their original attributes',async()=>{
 const dom=buildHeaderDom();await withDom(dom,'http://127.0.0.1:4318/',async()=>{
  setLanguagePreference('en');const dispose=bindHeaderModeAvailability({model:false,preRig:true});
  try{
   for(const lang of ['en','ko'] as const){setLanguagePreference(lang);const reason=(lang==='en'?enCatalog:koCatalog)['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.'];for(const button of [dom.setupBtn,dom.animateBtn,dom.compareBtn]){expect(button.disabled).toBe(true);expect(button.getAttribute('title')).toBe(reason);expect(button.getAttribute('aria-pressed')).toBe('false');}}
   dom.animateBtn.click();dom.animateBtn.setAttribute('aria-pressed','true');expect(dom.animateBtn.getAttribute('aria-pressed')).toBe('false');
   // Planted unguarded header is detected by the same enabled/pressed oracle.
   HarnessMutationObserver.active.clear();dom.setupBtn.disabled=false;dom.setupBtn.setAttribute('aria-pressed','true');expect([dom.setupBtn,dom.animateBtn].filter(button=>!button.disabled||button.getAttribute('aria-pressed')==='true')).toEqual([dom.setupBtn]);
  }finally{dispose();setLanguagePreference('en');}
  expect(dom.setupBtn.disabled).toBe(false);expect(dom.setupBtn.getAttribute('aria-pressed')).toBe('true');expect(dom.setupBtn.getAttribute('title')).toBeNull();expect(dom.compareBtn.disabled).toBe(true);expect(dom.compareBtn.getAttribute('title')).toBe(dom.compareTitle);expect(dom.workspace.inert).toBe(false);
 });
});
test('#735 no-model header is refused by name and a supported header keeps real Setup/Animate navigation',async()=>{
 const dom=buildHeaderDom();await withDom(dom,'http://127.0.0.1:4318/',async()=>{
  const dispose=bindHeaderModeAvailability({model:false});for(const button of [dom.setupBtn,dom.animateBtn,dom.compareBtn]){expect(button.disabled).toBe(true);expect(button.title).toBe(t('MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.'));}dispose();
  const tabs=bindInspectorTabs(()=>{}),supported=bindHeaderModeAvailability({model:true});try{dom.animateBtn.click();expect(dom.animateBtn.getAttribute('aria-pressed')).toBe('true');expect(dom.setupBtn.getAttribute('aria-pressed')).toBe('false');expect(dom.panelPlayback.hidden).toBe(false);expect(dom.panelRig.hidden).toBe(true);dom.setupBtn.click();expect(dom.panelRig.hidden).toBe(false);expect(dom.compareBtn.disabled).toBe(true);expect(dom.compareBtn.title).toBe(dom.compareTitle);}finally{supported();tabs.dispose();}
 });
});

test('pre-rig joined project preserves source-bound refusal and verdict output alongside refused Stage 3 navigation',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'review-441-'));
 let server:Awaited<ReturnType<typeof startServer>>|undefined;
 try{
  const fixture=await joinedVerdictFixture(root);
  const capability='a'.repeat(64);
  server=await startServer(fixture.p,{port:0,capability,stateDir:join(root,'state'),joined:fixture.joined});
  const origin='http://127.0.0.1:'+server.port;

  const review=await (await fetch(origin+'/api/review')).json();
  expect(review.manifest.model).toBeUndefined();
  expect(review.capabilities).toMatchObject({preRig:true,interview:true,playback:false});

  // Header availability consumes the exact server capabilities for this pre-rig draft.
  const dom=buildHeaderDom();await withDom(dom,origin+'/',async()=>{
   const dispose=bindHeaderModeAvailability({model:Boolean(review.manifest.model),preRig:review.capabilities.preRig});
   try{for(const button of [dom.setupBtn,dom.animateBtn,dom.compareBtn]){expect(button.disabled).toBe(true);expect(button.getAttribute('aria-pressed')).toBe('false');expect(button.title).toBe(enCatalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']);}}finally{dispose();}
  });

  // Session submission remains refused with MODEL_UNAVAILABLE on pre-rig draft.
  const sessionRes=await fetch(origin+'/api/session',{
   method:'PUT',
   headers:{Origin:origin,'X-Review-Capability':capability,'Content-Type':'application/json'},
   body:JSON.stringify({}),
  });
  expect(sessionRes.status).toBe(409);
  expect(await sessionRes.json()).toEqual({error:'MODEL_UNAVAILABLE'});

  // Source-bound Stage 1 verdict mismatch is refused and exact binding writes the verdict cleanly.
  const partsData=await (await fetch(origin+'/api/stage-parts')).json();
  expect(partsData.readOnly).toBe(false);
  const payload={
   binding:partsData.joinedVerdictBinding,
   status:'approved',
   issues:[],
  };
  const mismatch=await fetch(origin+'/api/stage-parts/verdict',{
   method:'POST',
   headers:{Origin:origin,'X-Review-Capability':capability,'Content-Type':'application/json'},
   body:JSON.stringify({...payload,binding:'0'.repeat(64)}),
  });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toEqual({error:'PARTS_VERDICT_SOURCE_MISMATCH'});
  expect(await readdir(fixture.output)).toEqual([]);

  const saved=await fetch(origin+'/api/stage-parts/verdict',{
   method:'POST',
   headers:{Origin:origin,'X-Review-Capability':capability,'Content-Type':'application/json'},
   body:JSON.stringify(payload),
  });
  expect(saved.status).toBe(200);
  const savedBody=await saved.json();
  expect(savedBody.verdict).toMatchObject({schema:'rig-review-parts-verdict/4',status:'approved',issues:[]});
  expect(await readdir(fixture.output)).toEqual([partsData.verdictFile]);
  expect(JSON.parse(await readFile(join(fixture.output,partsData.verdictFile),'utf8'))).toEqual(savedBody.verdict);
  await fixture.assertFixture();
 }finally{
  server?.stop(true);
  await rm(root,{recursive:true,force:true});
 }
});
