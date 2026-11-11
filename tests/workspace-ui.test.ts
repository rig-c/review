import {getLanguagePreference,getLinkLanguage,setLanguagePreference,setLinkLanguage} from '../web/i18n.ts';
import {mountRigInspector,mountBottomPanel} from '../web/inspector-blocks.ts';
import {rigWorkspaceMarkup,rigReviewDialogMarkup,rigLayerControlsMarkup,sharedViewToolsMarkup,sharedCommentMarkup} from '../src/compare-html.ts';
import {expect,test} from 'bun:test';
import {workspaceResizeRange,workspaceResizeTarget,bindWorkspaceUI} from '../web/workspace-ui.ts';
import {bindInspectorTabs,type InspectorTabRow} from '../web/view-controls.ts';
import {allocateWorkspaceLayout} from '../web/workspace-layout.ts';
import {workspacePreferenceKey,WorkspacePreferenceStore} from '../web/workspace-preferences.ts';

test('compressed sidebar handles advertise reachable sizes and invert allocator without drift',()=>{
 const available={width:700,height:500},desired={leftWidth:420,rightWidth:550,inspectorHeight:500};
 for(const panel of ['leftWidth','rightWidth','inspectorHeight'] as const){
  const range=workspaceResizeRange(available,desired,panel);expect(range.min).toBeLessThanOrEqual(range.value);expect(range.max).toBeGreaterThanOrEqual(range.value);
  for(const fraction of [0,.1,.5,.9,1]){const target=range.min+(range.max-range.min)*fraction,changed=workspaceResizeTarget(available,desired,panel,target),actual=allocateWorkspaceLayout(available,{...desired,[panel]:changed});expect(actual[panel]).toBeCloseTo(target,8);}
 }
 const narrow={width:390,height:300};expect(workspaceResizeRange(narrow,desired,'rightWidth').enabled).toBe(false);expect(workspaceResizeTarget(narrow,desired,'rightWidth',0)).toBe(550);expect(desired).toEqual({leftWidth:420,rightWidth:550,inspectorHeight:500});
});

/** Minimal DOM host exercises the real UI coordinator; it does not claim browser layout/focus acceptance. */
class Host extends EventTarget {
 id='';tagName:string;parentElement:Host|null=null;children:Host[]=[];dataset:Record<string,string>={};attrs=new Map<string,string>();hidden=false;tabIndex=-1;value='';checked=false;open=false;textContent='';scrollLeft=0;scrollTop=0;scrollWidth=1200;scrollHeight=1400;clientWidth=1200;clientHeight=800;captured=new Set<number>();
 style={touchAction:'',gridTemplateRows:'',values:new Map<string,string>(),setProperty(name:string,value:string){this.values.set(name,value);}};
 classes=new Set<string>();classList={add:(name:string)=>this.classes.add(name)};
 constructor(tag='div'){super();this.tagName=tag.toUpperCase();}
 get className(){return [...this.classes].join(' ');}set className(value:string){this.classes=new Set(value.split(' '));}
 get childNodes(){return this.children;}
 get firstElementChild(){return this.children[0]??null;}
 closest(selector:string):Host|null {return this.tagName.toLowerCase()===selector?this:this.parentElement?.closest(selector)??null;}
 remove(node?:Host){if(!node){this.parentElement?.remove(this);return;}this.children=this.children.filter(n=>n!==node);node.parentElement=null;}
 replaceChildren(...nodes:Host[]){for(const child of [...this.children])this.remove(child);this.append(...nodes);}
 append(...nodes:Host[]){for(const node of nodes){node.parentElement?.remove(node);node.parentElement=this;this.children.push(node);}}
 prepend(...nodes:Host[]){for(const node of [...nodes].reverse()){node.parentElement?.remove(node);node.parentElement=this;this.children.unshift(node);}}
 before(node:Host){const parent=this.parentElement!;node.parentElement?.remove(node);node.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,node);}
 after(node:Host){const parent=this.parentElement!;node.parentElement?.remove(node);node.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}
 contains(node:unknown):boolean{return node===this||this.children.some(n=>n.contains(node));}
 all():Host[]{return this.children.flatMap(n=>[n,...n.all()]);}
 querySelector(selector:string):Host|null {return this.all().find(n=>selector.startsWith('.')?n.classes.has(selector.slice(1)):selector.startsWith('#')?n.id===selector.slice(1):selector.startsWith('label[for=')?n.tagName==='LABEL'&&n.attrs.get('for')==='review-status':selector==='main'?n.tagName==='MAIN':selector.includes('aria-selected=true')&&n.attrs.get('aria-selected')==='true'||selector.includes('aria-pressed=true')&&n.attrs.get('aria-pressed')==='true')??null;}
 set innerHTML(value:string){this.children=[];for(const match of value.matchAll(/<(select|input|button|p)[^>]*id="([^"]+)"[^>]*>/g)){const n=new Host(match[1]);n.id=match[2]!;if(match[0].includes('data-app-preference'))n.attrs.set('data-app-preference','');this.append(n);}}
 getAttribute(name:string){return this.attrs.get(name)??null;}setAttribute(name:string,value:string){this.attrs.set(name,value);}removeAttribute(name:string){this.attrs.delete(name);}
 getBoundingClientRect(){return {width:this.clientWidth,height:this.classes.has('workspace-drawer-triggers')?0:this.clientHeight};}
 focus(){hostDocument.activeElement=this;}
 click(){this.dispatchEvent(new Event('click'));const action=(this as unknown as {onclick?:()=>void}).onclick;action?.();}
 showModal(){this.open=true;this.focus();}close(){this.open=false;this.dispatchEvent(new Event('close'));}
 setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
}
let hostDocument:{activeElement:Host|null};
function openHost(options:{explorerLeft?:boolean;tabs?:string[];currentTheme?:()=>'system'|'dark'|'light';leftHeader?:boolean;pressed?:boolean;direction?:boolean;bottomPanel?:boolean;kind?:string;stored?:Record<string,string>}={}){
 const body=new Host('body'),layout=new Host(),main=new Host('main'),left=new Host('aside'),right=new Host('aside'),stage=new Host(),inspector=new Host(),heading=new Host();layout.className='layout';left.className='left-panel';right.id='parts-explorer';stage.id='stage-layout';inspector.className='inspector';heading.clientHeight=30;
 const language=new Host('select');language.id='settings-language';const languageLabel=new Host('label');languageLabel.append(language);body.append(languageLabel);
 const tabs=options.tabs??['view','rig','playback','feedback'],panels={} as Record<string,Host>;for(const tab of tabs){const panel=new Host('section'),button=new Host('button');panel.id='inspector-'+tab;panel.dataset.inspectorPanel=tab;panel.hidden=tab!==tabs[0];panel.clientHeight=200;panel.clientWidth=500;button.dataset.inspector=tab;button.attrs.set(options.pressed?'aria-pressed':'aria-selected',String(tab===tabs[0]));panels[tab]=panel;if(options.pressed){button.dataset.mode=tab;body.append(button);inspector.append(panel);}else inspector.append(button,panel);}
 let bottomPanel:{kind:string;strip:Host;act:Host;actHome:Host;collapse:Host}|undefined,bottomBody:Host|undefined;
 if(options.bottomPanel){
  const strip=new Host('nav'),bottomHeading=new Host(),act=new Host(),collapse=new Host('button');bottomBody=new Host();bottomBody.className='inspector-body';bottomHeading.clientHeight=30;
  for(const child of [...inspector.children])if(child.dataset.inspector)strip.append(child);else bottomBody.append(child);
  const actHome=panels.feedback!;act.id='workspace-review-act';actHome.append(act);bottomHeading.append(strip,collapse);inspector.append(bottomHeading,bottomBody);bottomPanel={kind:options.kind??'rig',strip,act,actHome,collapse};
 }
 main.append(heading,stage,inspector);
 if(options.direction){
  layout.clientWidth=1440;layout.clientHeight=969;heading.clientHeight=80;
  const direction=new Host('details'),keys=new Host('details'),body=new Host('pre');
  direction.id='direction-panel';direction.open=true;direction.clientHeight=246;
  keys.id='direction-authored-keys';direction.append(keys);body.id='direction-authored-body';stage.before(direction);stage.before(body);body.clientHeight=0;
 }
if(options.leftHeader){const header=new Host(),strip=new Host('details');header.className='left-header parts-header';strip.id='package-context';left.append(header,strip);}if(options.explorerLeft){left.append(right);layout.append(left,main);}else layout.append(left,main,right);body.append(layout);
 const values=new Map<string,string>(Object.entries(options.stored??{})),events=new EventTarget(),frames=new Map<number,()=>void>();let handle=0;
 const document=Object.assign(new EventTarget(),{body,hidden:false,activeElement:null as Host|null,getElementById:(id:string)=>body.all().find(n=>n.id===id)??null,querySelector:(selector:string)=>body.querySelector(selector),createElement:(tag:string)=>new Host(tag)});hostDocument=document;
 const globals={document,window:events,localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)},requestAnimationFrame:(callback:()=>void)=>{frames.set(++handle,callback);return handle;},cancelAnimationFrame:(id:number)=>frames.delete(id),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{constructor(_callback:()=>void){}observe(){}disconnect(){}}};
 const old=new Map<string,PropertyDescriptor|undefined>();for(const [key,value]of Object.entries(globals)){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 let changed=0,currentTheme='dark';const ui=bindWorkspaceUI({changed:()=>changed++,defaultTheme:value=>{currentTheme=value;},...(options.currentTheme?{currentTheme:options.currentTheme}:{}),...(bottomPanel?{bottomPanel:bottomPanel as unknown as Parameters<typeof bindWorkspaceUI>[0]['bottomPanel']}:{})});
 const flush=()=>{for(let i=0;i<5;i++){const pending=[...frames.values()];frames.clear();for(const run of pending)run();}};flush();
 const tabBinding=bottomPanel?bindInspectorTabs(()=>ui.afterTab(),()=>ui.beforeTab(),{
  tabs:bottomPanel.strip.children.map(button=>({id:button.dataset.inspector!,button:button as unknown as HTMLButtonElement,panels:[panels[button.dataset.inspector!] as unknown as HTMLElement],attribute:'aria-selected' as const})),
  panels:Object.values(panels) as unknown as HTMLElement[],initialize:true,reveal:()=>ui.revealInspector(),
 }):undefined;
 const get=(id:string)=>document.getElementById(id)!;
 const choose=(id:string,value:string|boolean)=>{const node=get(id);if(typeof value==='boolean')node.checked=value;else node.value=value;(node as unknown as {onchange:()=>void}).onchange();};
 return {ui,get,choose,values,layout,panels,flush,tabBinding,bottomPanel,bottomBody,focus:()=>document.activeElement,changed:()=>changed,theme:()=>currentTheme,events,activate(tab:string){ui.beforeTab();for(const node of [...inspector.children,...body.children])if(node.dataset.inspector)node.attrs.set(options.pressed?'aria-pressed':'aria-selected',String(node.dataset.inspector===tab));for(const [name,node]of Object.entries(panels))node.hidden=name!==tab;ui.afterTab();flush();},close(){tabBinding?.dispose();ui.dispose();for(const [key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}};
}

test('Settings changes future sync/idle defaults only; transient source state and Reset remain independent',()=>{
 const app=openHost();try{
  const held={cameraSync:false,idleRepeat:false,time:.75,part:'held'},before=structuredClone(held);app.choose('settings-sync',false);app.choose('settings-idle',false);expect(held).toEqual(before);expect(app.ui.defaults()).toMatchObject({defaultCameraSync:false,defaultIdleRepeat:false});expect(app.theme()).toBe('dark');
  app.choose('settings-theme','light');expect(app.theme()).toBe('light');
  app.choose('settings-language','ko');expect(app.ui.defaults().language).toBe('ko');expect(held).toEqual(before);
  const other=new WorkspacePreferenceStore({storage:{getItem:key=>app.values.get(key)??null,setItem:(key,value)=>app.values.set(key,value)},events:null,writer:'other'});other.update({panels:{leftWidth:400,rightWidth:500}});const event=new Event('storage');Object.assign(event,{key:workspacePreferenceKey,newValue:app.values.get(workspacePreferenceKey)});app.events.dispatchEvent(event);app.flush();expect(app.ui.defaults().panels.leftWidth).toBe(400);expect(held).toEqual(before);
  app.get('settings-reset').click();expect(app.ui.defaults()).toMatchObject({theme:'light',language:'ko',defaultCameraSync:false,defaultIdleRepeat:false,panels:{leftWidth:170,rightWidth:260,inspectorHeight:350}});expect(held).toEqual(before);
  app.choose('settings-language','system');expect(app.ui.defaults().language).toBe('system');
  other.dispose();
 }finally{app.close();}
});

test('actual tab hooks retain independent x/y through resize and responsive drawer uses the same stable node',()=>{
 const app=openHost();try{
  app.panels.view!.scrollLeft=33;app.panels.view!.scrollTop=420;app.activate('rig');app.panels.rig!.scrollLeft=11;app.panels.rig!.scrollTop=80;app.activate('view');expect(app.panels.view!.scrollLeft).toBe(33);expect(app.panels.view!.scrollTop).toBe(420);app.activate('rig');expect(app.panels.rig!.scrollTop).toBe(80);expect(JSON.parse(app.ui.scroll())).toMatchObject({view:{x:33,y:420},rig:{x:11,y:80}});
  app.layout.clientWidth=390;app.layout.clientHeight=300;app.ui.refresh();app.flush();const right=app.get('parts-explorer');expect(right.parentElement?.id).toBe('workspace-drawer-rightWidth');app.ui.revealInspector();expect(app.get('workspace-drawer-inspectorHeight').open).toBe(true);
  app.layout.clientWidth=1400;app.layout.clientHeight=900;app.ui.refresh();app.flush();expect(app.get('parts-explorer')).toBe(right);expect(right.parentElement).toBe(app.layout);expect(app.get('workspace-drawer-inspectorHeight').open).toBe(false);expect(app.ui.defaults().panels).toEqual({leftWidth:170,rightWidth:260,inspectorHeight:350});
  expect(()=>app.ui.restoreScroll('{"unknown":{"x":1,"y":1}}')).toThrow('INSPECTOR_SCROLL');
 }finally{app.close();}
});

import {readFile} from 'node:fs/promises';

test('actual user scroll cancels a queued old restore; stale intent cannot replace a programmatic short clamp',()=>{
 const app=openHost();try{
  app.ui.restoreScroll(JSON.stringify({view:{x:24,y:480}}));app.panels.view!.dispatchEvent(new Event('wheel'));app.panels.view!.scrollLeft=7;app.panels.view!.scrollTop=77;app.panels.view!.dispatchEvent(new Event('scroll'));app.flush();expect(app.panels.view!.scrollTop).toBe(77);expect(JSON.parse(app.ui.scroll()).view).toEqual({x:7,y:77});
  app.panels.view!.scrollHeight=200;app.panels.view!.scrollWidth=500;app.ui.restoreScroll(JSON.stringify({view:{x:24,y:480}}));app.panels.view!.dispatchEvent(new Event('pointerdown'));app.flush();expect(app.panels.view!.scrollTop).toBe(0);app.panels.view!.dispatchEvent(new Event('scroll'));app.activate('rig');expect(JSON.parse(app.ui.scroll()).view).toEqual({x:24,y:480});
  app.panels.view!.scrollHeight=1400;app.panels.view!.scrollWidth=1200;app.activate('view');expect(app.panels.view!.scrollTop).toBe(480);expect(app.panels.view!.scrollLeft).toBe(24);
 }finally{app.close();}
});

test('drawer sources override the legacy important narrow sidebar hide in both real stylesheets',async()=>{
 for(const file of ['styles.css','compare.css']){
  const css=await readFile(new URL('../web/'+file,import.meta.url),'utf8');
  const matching=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match,index)=>{
   const display=match[2]!.match(/(?:^|;)\s*display\s*:\s*([^;]+)/);if(!display)return [];
   return match[1]!.split(',').filter(selector=>['.left-panel','.workspace-drawer>.left-panel'].includes(selector.trim())).map(selector=>({selector:selector.trim(),important:display[1]!.includes('!important'),value:display[1]!.replace('!important','').trim(),index,specificity:selector.includes('workspace-drawer')?2:1}));
  });
  expect(matching.some(row=>row.value==='none'&&row.important)).toBe(true);matching.sort((a,b)=>Number(a.important)-Number(b.important)||a.specificity-b.specificity||a.index-b.index);expect(matching.at(-1)).toMatchObject({selector:'.workspace-drawer>.left-panel',value:'flex',important:true});
 }
});

test('an explorer inside the left column makes it the parts column: no right column, explorer width, three sections',()=>{
 const app=openHost({explorerLeft:true,tabs:['rig','playback','feedback']});try{
  app.layout.clientWidth=1280;app.layout.clientHeight=800;app.ui.refresh();app.flush();
  expect(app.layout.style.values.get('--workspace-columns')).toBe('260px 4px minmax(0,1fr) 0px 0px');
  const handles=app.layout.children.filter(node=>node.classes.has('workspace-separator'));expect(handles.map(node=>node.className)).toEqual(['workspace-separator workspace-rightWidth workspace-side-left']);
  expect(handles[0]!.getAttribute('aria-controls')).toBe('workspace-left');expect(handles[0]!.getAttribute('aria-label')).toBe('Resize Parts and settings');
  const left=app.get('workspace-left'),explorer=app.get('parts-explorer');expect(left.contains(explorer)).toBe(true);
  app.panels.rig!.scrollTop=40;app.activate('playback');app.activate('rig');expect(app.panels.rig!.scrollTop).toBe(40);expect(JSON.parse(app.ui.scroll()).rig).toEqual({x:0,y:40});
  app.ui.restoreScroll(JSON.stringify({view:{x:0,y:12}}));
  app.layout.clientWidth=420;app.ui.refresh();app.flush();expect(left.parentElement?.id).toBe('workspace-drawer-rightWidth');expect(app.layout.style.values.get('--workspace-columns')).toBe('0px 0px minmax(0,1fr) 0px 0px');
  app.layout.clientWidth=1280;app.ui.refresh();app.flush();expect(left.parentElement).toBe(app.layout);expect(app.layout.children[0]).toBe(left);
 }finally{app.close();}
});

const indexHtml=async()=>rigWorkspaceMarkup+rigReviewDialogMarkup;
const between=(html:string,start:string,end:string)=>{const a=html.indexOf(start),b=html.indexOf(end,a);if(a<0||b<a)throw new Error(`index.html region missing: ${start} … ${end}`);return html.slice(a,b+end.length);};
test('canonical rig content preserves both source sections and all 18 real tool tabs; C6 mounts the Review act separately',async()=>{
 const html=await indexHtml(),inspector=between(html,'<section class="inspector"','</main>');
 expect([...inspector.matchAll(/role="tab"[^>]*data-block-target="([^"]+)"/g)].map(m=>m[1])).toEqual(['selected-part','modeling-tools','chest-regions','mesh-panel','weights','bones-panel','rig-fields','cuts-panel','cloth-panel','motion-tools','sound-panel','environment','physics-panel','idle-tracks','readings','requirements','retarget','report-panel']);
 expect([...inspector.matchAll(/data-inspector-panel="([^"]+)"/g)].map(m=>m[1])).toEqual(['rig','playback']);
 const source=await readFile(new URL('../web/inspector-blocks.ts',import.meta.url),'utf8');
 expect(source).toContain("feedback.dataset.inspectorPanel='feedback'");expect(source).toContain('body.append(feedback);dialog.remove()');expect(source).toContain("row:{tabs,panels:tabs.flatMap(tab=>tab.panels),initialize:true}");
});
/** Controls that seek or play the shared playhead. */
const seekOrPlay=['play','animation-select','scrub','frame-number','frame-jump','frame-scrub','idle-repeat','axis-select','axis-value','report-seek','report-time'];
test('Setup holds no control that seeks or plays: the angle tool and panel and every transport control are in Animate',async()=>{
 const html=await indexHtml(),setup=between(html,'<section id="inspector-rig"','<section id="inspector-playback"'),animate=between(html,'<section id="inspector-playback"','</main>');
 for(const id of seekOrPlay){expect(setup).not.toContain(`id="${id}"`);expect(animate).toContain(`id="${id}"`);}
 for(const marker of ['data-proposal="angle"','id="angle-panel"','id="axis-state"']){expect(setup).not.toContain(marker);expect(animate).toContain(marker);}
 for(const id of ['selected-part','modeling-tools','part-set'])expect(setup).toContain(`id="${id}"`);for(const tool of ['mesh','contour','chest'])expect(setup).toContain(`data-proposal="${tool}"`);
 expect(await mainSource()).toContain("if (tool === 'angle' && !input('axis-value').disabled) { showInspector('playback');chooseAxis(); return; }");
});
const mainSource=()=>readFile(new URL('../web/main.ts',import.meta.url),'utf8');
/** Every id of the former Feedback section, unchanged so drafts, the control page and tests keep resolving them. */
const feedbackIds=['inspector-feedback','review-status','provenance-version','provenance-rig','provenance-motion','provenance-full','source-files','checkpoint-detail','detail-title','detail-note','checkpoint-note','proposal-panel','feedback-start','feedback-end','feedback-range-hint','feedback-target-kind','feedback-target-name','feedback-target-names','feedback-target-hint','feedback-category','feedback-summary','add-proposal','proposal-boundary','feedback-warnings','proposal-list','strip-panel','strip-scope','strip-reference','strip-format','strip-export','strip-status'];
test('the real review decision and Submit nodes move to the bottom act end without a proxy submit',async()=>{
 const html=await indexHtml(),dialog=between(html,'<dialog id="review-dialog"','</dialog>');
 for(const id of feedbackIds){expect(dialog).toContain(` id="${id}"`);expect(html.split(` id="${id}"`).length).toBe(2);}
 expect(dialog.match(/id="save"/g)?.length).toBe(1);
 const composition=await readFile(new URL('../web/inspector-blocks.ts',import.meta.url),'utf8');
 expect(composition).toContain("label,status,actions");expect(composition).toContain('feedback.append(act)');expect(composition).toContain('dialog.remove()');
 const main=await mainSource();expect(main).toContain("rigInspector.row.reveal=id=>");expect(main).not.toContain('dialog.showModal()');expect(main).not.toContain("button('write-review')");
 expect(main).toContain("text('review-draft-state',value);");expect(main).toContain("text('review-message', value);");
 for(const gone of ["button('export')","button('export-markdown')"])expect(main).not.toContain(gone);
});
test('the left column is a fixed header row and one scrolling body: strip, parts and Settings scroll together',async()=>{
 const html=await indexHtml(),css=await stylesCss(),left=between(html,'<aside class="left-panel">','<main>');
 expect(left.startsWith('<aside class="left-panel"><div class="left-header parts-header"><h2>PARTS</h2>')).toBe(true);expect(between(left,'<div class="left-header','</div>')).toContain('id="part-search"');
 const rules=(selector:string)=>ruleBodies(css,selector).join(';');
 expect(rules('.workspace-layout>.left-panel')).toContain('overflow:hidden');expect(rules('.left-header')).toContain('flex:none');expect(rules('.workspace-sources')).toContain('overflow:auto');
 for(const selector of ['.left-header','.workspace-settings','.package-context #checkpoints','.left-panel .parts-explorer'])expect(rules(selector)).not.toMatch(/overflow\s*:\s*(auto|scroll)/);
 const app=openHost({explorerLeft:true,leftHeader:true,tabs:['rig','playback']});try{
  const column=app.get('workspace-left'),body=column.children[1]!;expect(column.children.map(node=>node.className)).toEqual(['left-header parts-header','workspace-sources']);
  expect(body.children.map(node=>node.id||node.className)).toEqual(['package-context','parts-explorer','workspace-settings']);
 }finally{app.close();}
});
test('a pressed header selector is the selected section for scroll memory',()=>{
 const app=openHost({explorerLeft:true,pressed:true,tabs:['rig','playback']});try{
  app.panels.rig!.scrollTop=40;app.activate('playback');app.panels.playback!.scrollTop=90;app.activate('rig');expect(app.panels.rig!.scrollTop).toBe(40);app.activate('playback');expect(app.panels.playback!.scrollTop).toBe(90);
  expect(JSON.parse(app.ui.scroll())).toEqual({rig:{x:0,y:40},playback:{x:0,y:90}});
 }finally{app.close();}
});
test('every footer status readout lives inside footer and the stage-meta row is gone',async()=>{
 const html=await indexHtml(),footer=between(html,'<footer','</footer>');
 for(const id of ['message','source-hash','player-state','layout-state','renderer-state','layer-state','control-state','idle-state','draft-state'])expect(footer).toContain(`id="${id}"`);
 expect(html).not.toContain('stage-meta');expect(html.match(/role="status"/g)?.length).toBe(10);
});
test('the parts explorer is the left column with checkpoints and reference folded above it',async()=>{
 const html=await indexHtml(),left=between(html,'<aside class="left-panel">','<main>');
 expect(left.indexOf('<details id="package-context"')).toBeLessThan(left.indexOf('<aside id="parts-explorer"'));for(const id of ['checkpoints','checkpoint-title','reference-select','person-select'])expect(between(left,'<details id="package-context"','</details>')).toContain(`id="${id}"`);
 expect(html.slice(html.indexOf('</main>'),html.indexOf('<footer'))).toBe('</main></div>');expect(html.match(/parts-explorer/g)?.length).toBe(2);
});

const stylesCss=()=>readFile(new URL('../web/styles.css',import.meta.url),'utf8');
/** Declarations of every rule whose selector list is exactly `selector`, in source order. */
const ruleBodies=(css:string,selector:string)=>[...css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1]!.trim()===selector).map(m=>m[2]!);

test('no id appears twice in index.html; the view-bar appearance select and Copy view link are gone',async()=>{
 const html=await indexHtml(),ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]!),seen=new Set<string>(),twice=ids.filter(id=>seen.has(id)||!seen.add(id));
 expect(ids.length).toBeGreaterThan(100);expect(twice).toEqual([]);
 for(const gone of ['id="appearance"','id="copy-view"','Copy view link','Appearance','class="view-options"','class="segmented"'])expect(html).not.toContain(gone);
 // The page's only theme select is the one Settings builds; the per-inspection idle toggle is in Animate's transport row.
 expect(html).not.toContain('<option value="system">');expect(html.match(/id="idle-repeat"/g)?.length).toBe(1);
 expect(between(html,'<section id="transport"','</section>')).toContain('id="idle-repeat"');
 expect(between(html,'<div class="viewbar">','<div id="stage-layout"')).not.toContain('idle-repeat');
});

test('each panel header is the first child of its panel and carries the sticky class',async()=>{
 const html=await indexHtml(),css=await stylesCss();
 const firstChild=(open:string)=>{const at=html.indexOf(open);if(at<0)throw new Error('missing '+open);const rest=html.slice(html.indexOf('>',at)+1);return rest.slice(0,rest.indexOf('>')+1);};
 expect(firstChild('<aside class="left-panel"')).toBe('<div class="left-header parts-header">');
 const parts=between(html,'<div class="left-header parts-header">','</div>');expect(parts).toContain('<h2>PARTS</h2>');expect(parts).toContain('id="part-search"');
 expect(firstChild('<section class="inspector"')).toBe('<div class="inspector-heading sticky-header">');expect(between(html,'<div class="inspector-heading sticky-header">','</div>')).not.toContain('role="tablist"');
 const ui=await readFile(new URL('../web/workspace-ui.ts',import.meta.url),'utf8');expect(ui).toContain(`settingsHeader.className='sticky-header settings-header'`);expect(ui).toContain('settings.append(settingsHeader,settingsBody)');
 const sticky=ruleBodies(css,'.sticky-header');expect(sticky.length).toBe(1);expect(sticky[0]).toContain('position:sticky');expect(sticky[0]).toContain('top:0');
 const app=openHost({explorerLeft:true,tabs:['rig','playback','feedback']});try{
  for(const panel of ['rightWidth','inspectorHeight']){const dialog=app.get('workspace-drawer-'+panel),header=dialog.children[0]!;expect(header.classes.has('sticky-header')).toBe(true);expect(header.children.some(node=>node.classes.has('workspace-drawer-close'))).toBe(true);}
  app.layout.clientWidth=420;app.layout.clientHeight=300;app.ui.refresh();app.flush();const dialog=app.get('workspace-drawer-rightWidth');expect(dialog.children[0]!.classes.has('sticky-header')).toBe(true);expect(dialog.children[1]!.id).toBe('workspace-left');
 }finally{app.close();}
});

test('rig mounts distinct primary and secondary toolbar regions using the shared control constructor',async()=>{
 const html=await indexHtml(),main=await mainSource();
 for(const seam of ['data-workspace-comment','data-workspace-layers','data-workspace-view-tools','data-workspace-camera'])expect(html).toContain(seam);
 expect(main).toContain("createViewControls({layout:'rigStep1'})");
 for(const id of ['layer-images','layer-mesh','layer-bones'])expect(rigLayerControlsMarkup).toContain(`id="${id}"`);
 expect(sharedCommentMarkup.match(/id="stage-comment"/g)?.length).toBe(1);
 const css=await stylesCss();expect(css).toContain('.workspace-main-toolbar');expect(css).toContain('.workspace-secondary-toolbar');
});

test('one thin scrollbar rule from theme tokens covers every scrolling region',async()=>{
 const css=await stylesCss();
 expect(ruleBodies(css,'*').join(';')).toContain('scrollbar-width:thin;scrollbar-color:var(--rv-scrollbar-thumb) var(--rv-scrollbar-track)');
 expect(ruleBodies(css,'*::-webkit-scrollbar')).toEqual(['width:6px;height:6px']);
 expect(ruleBodies(css,'*::-webkit-scrollbar-thumb')[0]).toContain('background:var(--rv-scrollbar-thumb)');
 // Firefox takes the standard properties; Chromium/WebKit take the 6px pseudo-element rule, which Chromium ignores once scrollbar-width is set.
 const bare=css.replace(/\/\*[\s\S]*?\*\//g,'');expect(bare).toContain('@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;');
 expect(bare.match(/scrollbar-width/g)?.length).toBe(1);expect(bare.match(/::-webkit-scrollbar\{/g)?.length).toBe(1);
});

test('Settings theme shows the current inspection appearance when the page supplies it',()=>{
 let current:'system'|'dark'|'light'='light';const app=openHost({currentTheme:()=>current});try{
  expect(app.ui.defaults().theme).toBe('system');expect(app.get('settings-theme').value).toBe('light');
  current='dark';app.get('settings-reset').click();app.flush();expect(app.get('settings-theme').value).toBe('dark');
 }finally{app.close();}
 const plain=openHost();try{expect(plain.get('settings-theme').value).toBe('system');}finally{plain.close();}
});

test('the parts header is one row: the title and the search are the only children of one flex row',async()=>{
 const html=await indexHtml(),css=await stylesCss(),header=between(html,'<div class="left-header parts-header">','</div>').slice('<div class="left-header parts-header">'.length);
 // Top-level elements of the header row, in order: no separate label line.
 expect([...header.matchAll(/<([a-z0-9]+)[\s>]/g)].map(m=>m[1])).toEqual(['h2','input']);
 expect(header).toContain('aria-label="Find slot"');expect(header).not.toContain('<label');
 const row=ruleBodies(css,'.parts-header').join(';');expect(row).toContain('display:flex');expect(row).toContain('flex-direction:row');expect(row).toContain('flex-wrap:nowrap');
 expect(ruleBodies(css,'.parts-header input[type=search]').join(';')).toContain('flex:1');
});
test('Settings collapses from its own header; the state is a workspace preference, collapsed by default',()=>{
 const app=openHost({explorerLeft:true,tabs:['rig','playback']});try{
  const toggle=app.get('settings-toggle'),body=app.get('settings-body');expect(toggle.parentElement!.classes.has('sticky-header')).toBe(true);expect(toggle.getAttribute('aria-controls')).toBe('settings-body');
  expect(body.hidden).toBe(true);expect(toggle.getAttribute('aria-expanded')).toBe('false');expect(app.ui.defaults().settingsCollapsed).toBe(true);expect(app.get('settings-theme')).not.toBeNull();
  toggle.click();expect(body.hidden).toBe(false);expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(JSON.parse(app.values.get(workspacePreferenceKey)!).settingsCollapsed).toBe(false);
  app.get('settings-reset').click();expect(body.hidden).toBe(false);
  toggle.click();expect(body.hidden).toBe(true);expect(JSON.parse(app.values.get(workspacePreferenceKey)!).settingsCollapsed).toBe(true);
 }finally{app.close();}
});
test('the footer View region body is a fixed popover above the footer, bounded by the viewport',async()=>{
 const css=await stylesCss(),body=ruleBodies(css,'.view-region-body').join(';');
 expect(body).toContain('position:fixed');expect(body).not.toContain('position:absolute');expect(body).toContain('bottom:calc(40px + 6px)');expect(body).toContain('right:8px');
 expect(body).toMatch(/max-height:calc\(100dvh - 40px - \d+px\)/);expect(body).toMatch(/max-width:calc\(100vw - \d+px\)/);expect(body).toContain('overflow:auto');
 expect(ruleBodies(css,'footer').join(';')).toContain('height:40px');
});

test('authored keys take the stage slot while the Inspector stays docked in at most two layout passes per transition',()=>{
 const app=openHost({direction:true});
 try{
  const direction=app.get('direction-panel'),keys=app.get('direction-authored-keys');
  const body=app.get('direction-authored-body'),inspector=app.get('workspace-inspector');
  const main=inspector.parentElement!;
  // At the captured viewport, use the allocator's largest legal desired height
  // so the measured chrome clamps the Inspector and leaves the 180px stage minimum.
  const saved=new WorkspacePreferenceStore({storage:{getItem:key=>app.values.get(key)??null,setItem:(key,value)=>app.values.set(key,value)},events:null,writer:'other'});
  saved.update({panels:{inspectorHeight:900}});
  const event=new Event('storage');Object.assign(event,{key:workspacePreferenceKey,newValue:app.values.get(workspacePreferenceKey)});app.events.dispatchEvent(event);
  app.flush();saved.dispose();
  const available={width:1440,height:969-80-direction.clientHeight};
  const desired=app.ui.defaults().panels;
  expect(desired.inspectorHeight).toBe(900);
  const base=allocateWorkspaceLayout(available,desired);
  expect(base).toMatchObject({inspectorMode:'panel',inspectorHeight:459,stageHeight:180});
  const dockedRows=`minmax(0,1fr) 4px ${base.inspectorHeight}px`;
  expect(main.style.gridTemplateRows).toBe(dockedRows);
  for(const open of [true,false]){
   keys.open=open;
   const priorPasses=app.changed();
   for(let pass=0;pass<2;pass++){
    const [separator,inspectorHeight]=main.style.gridTemplateRows.split(' ').slice(-2).map(parseFloat);
    body.clientHeight=open?available.height-separator!-inspectorHeight!:0;
    app.ui.refresh();app.flush();
    expect(inspector.parentElement).toBe(main);
    expect(main.style.gridTemplateRows).toBe(dockedRows);
   }
   expect(app.changed()-priorPasses).toBe(2);
  }
 }finally{app.close();}
});


test('#666 actual compare bookmark restoration delegates selection between the existing workspace hooks',async()=>{
 const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8'),a=source.indexOf('async function applyInspection('),b=source.indexOf('async function setupPersistence(',a);
 const trace:string[]=[],inputs=new Map<string,{checked:boolean}>(),layers={},cameras={};
 const scope={cameraRestoring:false,turnPad:null,parts:{select(){},assertIdentity(){}},idleHeld:false,stop(){},appearance:null,layers,
  input:(id:string)=>{if(!inputs.has(id))inputs.set(id,{checked:false});return inputs.get(id);},
  workspace:{beforeTab:()=>trace.push('before'),afterTab:()=>trace.push('after')},inspectorTabs:{restore:(id:string)=>trace.push('restore:'+id)},
  pickedTools:{setPickedSide:(id:string)=>trace.push('side:'+id),setMode:(id:string,options:unknown)=>trace.push('mode:'+id+':'+JSON.stringify(options))},
  syncStageLayout(){},el(){return {};},fit(){},paneFrame(){return null;},cameras,cameraSync:false,activeCamera:'a',redrawOverlays(){},
 };
 const apply=new Function('scope','with(scope){'+new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b))+';return applyInspection;}')(scope);
 await apply({selection:{inspector:'playback',side:'b',mode:'animate'},time:null,theme:'dark',layers:{images:true,meshes:false,bones:true},view:{cameras:{}}},new AbortController().signal);
 expect(trace).toEqual(['before','restore:playback','after','side:b','mode:animate:{"fromTab":true}']);expect(scope.cameraRestoring).toBe(false);
});


test('#671 real bottom tabs reveal selected Setup and Animate bodies in a short embedded-layout drawer without restore side effects',()=>{
 const app=openHost({explorerLeft:true,tabs:['rig','playback','feedback'],bottomPanel:true});
 try{
  const original=app.bottomBody!,strip=app.bottomPanel!.strip,act=app.bottomPanel!.act;
  app.layout.clientWidth=390;app.layout.clientHeight=300;app.ui.refresh();app.flush();
  const drawer=app.get('workspace-drawer-inspectorHeight');
  expect(original.parentElement).toBe(drawer);expect(drawer.open).toBe(false);
  app.tabBinding!.restore('playback');app.flush();expect(drawer.open).toBe(false);expect(app.panels.playback!.hidden).toBe(false);
  for(const name of ['playback','rig','rig','playback']){
   app.tabBinding!.select(name);app.flush();expect(drawer.open).toBe(true);expect(original.hidden).toBe(false);expect(app.panels[name]!.hidden).toBe(false);
   expect(strip.parentElement!.parentElement).toBe(app.get('workspace-inspector'));expect(drawer.contains(act)).toBe(true);
   drawer.close();app.flush();expect(drawer.open).toBe(false);expect(app.focus()?.dataset.inspector).toBe(name);expect(act.parentElement).toBe(strip.parentElement);
  }
  const first=strip.children[0]!,key=Object.assign(new Event('keydown',{cancelable:true}),{key:'ArrowRight'});
  (first as unknown as {onkeydown:(event:KeyboardEvent)=>void}).onkeydown(key as KeyboardEvent);app.flush();expect(key.defaultPrevented).toBe(true);expect(drawer.open).toBe(true);expect(app.focus()).toBe(drawer);
  app.layout.clientWidth=1400;app.layout.clientHeight=900;app.ui.refresh();app.flush();
  expect(drawer.open).toBe(false);expect(original.parentElement).toBe(app.get('workspace-inspector'));expect(drawer.contains(original)).toBe(false);expect(act.parentElement).toBe(app.bottomPanel!.actHome);
 }finally{app.close();}
});

test('#671 collapse and expand keep single act identity and explicit selected-tab activation restores the real body',()=>{
 const app=openHost({explorerLeft:true,tabs:['rig','playback','feedback'],bottomPanel:true});
 try{
  const {collapse,act,strip,actHome}=app.bottomPanel!,body=app.bottomBody!;
  collapse.click();app.flush();expect(body.hidden).toBe(true);expect(act.parentElement).toBe(strip.parentElement);expect(app.values.get('rig-review-bottom-collapsed/rig')).toBe('true');
  app.tabBinding!.restore('rig');app.flush();expect(body.hidden).toBe(true);
  app.tabBinding!.select('rig');app.flush();expect(body.hidden).toBe(false);expect(act.parentElement).toBe(actHome);expect(app.values.get('rig-review-bottom-collapsed/rig')).toBe('false');
  app.layout.clientWidth=390;app.layout.clientHeight=300;app.ui.refresh();app.flush();
  collapse.click();app.flush();expect(body.hidden).toBe(true);
  collapse.click();app.flush();const drawer=app.get('workspace-drawer-inspectorHeight');expect(body.hidden).toBe(false);expect(drawer.open).toBe(true);expect(drawer.contains(act)).toBe(true);
  expect(app.bottomPanel!.act).toBe(act);expect(app.bottomPanel!.strip).toBe(strip);
 }finally{app.close();}
});

test('#671 actual rig selection adapter restores without explicit reveal and sends repeated user acts through the shared tab authority',async()=>{
 const source=await mainSource(),a=source.indexOf('function showInspector('),b=source.indexOf('function bindInspector(',a),trace:string[]=[];
 const inspectorTabs={select:(name:string)=>trace.push('select:'+name),restore:(name:string)=>trace.push('restore:'+name)},openReview=()=>trace.push('review');
 const show=new Function('inspectorTabs','openReview',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b))+';return showInspector;')(inspectorTabs,openReview);
 show('rig',false);show('playback',false);show('feedback',false);expect(trace).toEqual(['restore:rig','restore:playback']);
 show('rig');show('rig');show('playback');show('feedback');expect(trace.slice(2)).toEqual(['select:rig','select:rig','select:playback','review']);
});


test('#671 actual source-only startup guard excludes unavailable Review from actual API and keyboard choices, preserving compiled choices',async()=>{
 const source=await mainSource(),a=source.indexOf('    let writes:',source.indexOf('async function start():')),b=source.indexOf('    submittedBaseline=',a);
 const initialize=new Function('scope','with(scope){return (async()=>{'+new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b))+'})();}');
 for(const preRig of [false,true]){
  const buttons=['rig','playback','feedback'].map(id=>{const node=new Host('button');node.setAttribute('aria-selected',String(id==='rig'));return node;}),panels=['rig','playback','feedback'].map(id=>{const panel=new Host('section');panel.id='inspector-'+id;panel.hidden=id!=='rig';return panel;});
  const feedback=buttons[2]!,act=new Host(),row:InspectorTabRow={tabs:buttons.map((button,index)=>({id:['rig','playback','feedback'][index]!,button:button as unknown as HTMLButtonElement,panels:[panels[index] as unknown as HTMLElement],attribute:'aria-selected'})),panels:panels as unknown as HTMLElement[],initialize:true};
  const scope={data:null as unknown,session:null as unknown,readOnly:null as unknown,rigInspector:{act,row},
   api:async(path:string)=>path==='/api/review'?{capabilities:{preRig}}:path==='/api/session'?{status:'pending'}:{capabilityRequired:false},
   access:{},readOnlyReason:()=>null,button:(id:string)=>{if(id!=='workspace-tab-feedback')throw new Error('Missing real review tab');return feedback;},
  };
  await initialize(scope);expect(feedback.hidden).toBe(preRig);expect(act.hidden).toBe(preRig);
  const binding=bindInspectorTabs(()=>{},()=>{},row);
  try{
   binding.select('feedback');expect(binding.state()).toBe(preRig?'rig':'feedback');expect(panels[2]!.hidden).toBe(preRig);
   binding.restore('rig');
   const key=Object.assign(new Event('keydown',{cancelable:true}),{key:'ArrowLeft'});
   // The actual shared engine wraps only through this host's registered choices.
   const oldFocus=hostDocument;hostDocument={activeElement:null};
   try{(buttons[0] as unknown as {onkeydown:(event:KeyboardEvent)=>void}).onkeydown(key as KeyboardEvent);}finally{hostDocument=oldFocus;}
   expect(binding.state()).toBe(preRig?'playback':'feedback');expect(key.defaultPrevented).toBe(true);
  }finally{binding.dispose();}
 }
});


test('#671 real mounted outer tab-panel relationships preserve original nodes and inner rows, including pre-rig exclusion',async()=>{
 const page=new Host('body'),stack=[page],voidTags=new Set(['input','br','img','meta','link','hr','source','col','area','base','embed','param','track','wbr']);
 for(const match of (rigWorkspaceMarkup+rigReviewDialogMarkup).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*)>/g)){
  const [,close,raw,attrs]=match,tag=raw!.toLowerCase();if(close){if(!voidTags.has(tag))stack.pop();continue;}
  const node=new Host(tag);for(const attribute of attrs!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)){
   const key=attribute[1]!,value=attribute[2]??'';node.setAttribute(key,value);if(key==='id')node.id=value;if(key==='class')node.className=value;if(key==='hidden')node.hidden=true;
   if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())]=value;
  }
  stack.at(-1)!.append(node);if(!voidTags.has(tag)&&!attrs!.trimEnd().endsWith('/'))stack.push(node);
 }
 const document={getElementById:(id:string)=>page.all().find(node=>node.id===id)??null,querySelector:(selector:string)=>page.querySelector(selector),querySelectorAll:(selector:string)=>selector==='[data-mode]'?page.all().filter(node=>'mode' in node.dataset):[],createElement:(tag:string)=>new Host(tag)};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),oldFocus=hostDocument;Object.defineProperty(globalThis,'document',{configurable:true,value:document});hostDocument={activeElement:null};
 const originals=['rig','playback','feedback'].map(id=>document.getElementById('inspector-'+id)!);
 const innerBefore=page.all().filter(node=>node.attrs.get('aria-labelledby')?.startsWith('block-tab-')).map(node=>[node.id,node.getAttribute('role'),node.getAttribute('aria-labelledby')]);
 try{
  const mounted=mountRigInspector(document as unknown as Document),row=mounted.row,owners=row.tabs.map(tab=>tab.button.id);
  expect(new Set(owners).size).toBe(3);
  for(const [index,tab] of row.tabs.entries()){
   const panel=tab.panels[0]!;expect(panel).toBe(originals[index] as unknown as HTMLElement);expect(panel.getAttribute('role')).toBe('tabpanel');expect(panel.getAttribute('aria-labelledby')).toBe(tab.button.id);expect(tab.button.getAttribute('aria-controls')).toBe(panel.id);
   expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).toBe(tab.button as unknown as Host);
  }
  const binding=bindInspectorTabs(()=>{},()=>{},row);
  for(const id of ['rig','playback','feedback']){binding.select(id);expect(originals.map(panel=>panel.hidden)).toEqual(['rig','playback','feedback'].map(name=>name!==id));expect(row.tabs.filter(tab=>tab.button.getAttribute('aria-selected')==='true').map(tab=>tab.id)).toEqual([id]);}
  binding.restore('rig');binding.dispose();
  expect(page.all().filter(node=>node.attrs.get('aria-labelledby')?.startsWith('block-tab-')).map(node=>[node.id,node.getAttribute('role'),node.getAttribute('aria-labelledby')])).toEqual(innerBefore);
  const source=await mainSource(),a=source.indexOf('    let writes:',source.indexOf('async function start():')),b=source.indexOf('    submittedBaseline=',a);
  const scope={data:null as unknown,session:null as unknown,readOnly:null as unknown,rigInspector:mounted,access:{},readOnlyReason:()=>null,button:(id:string)=>document.getElementById(id)!,api:async(path:string)=>path==='/api/review'?{capabilities:{preRig:true}}:path==='/api/session'?{status:'pending'}:{capabilityRequired:false}};
  await new Function('scope','with(scope){return(async()=>{'+new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b))+'})();}')(scope);
  const preRig=bindInspectorTabs(()=>{},()=>{},row);
  try{preRig.select('feedback');expect(preRig.state()).toBe('rig');expect(originals[2]!.hidden).toBe(true);expect(document.getElementById('workspace-tab-feedback')!.hidden).toBe(true);expect(mounted.act.hidden).toBe(true);expect(row.tabs.map(tab=>tab.id)).toEqual(['rig','playback']);}
  finally{preRig.dispose();}
 }finally{hostDocument=oldFocus;if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});


test('#674 stored rig collapse preference survives and screen kinds keep independent preferences',()=>{
 for(const kind of ['rig','synthetic']){
  const app=openHost({explorerLeft:true,tabs:['rig','playback','feedback'],bottomPanel:true,kind,stored:{'rig-review-bottom-collapsed/rig':'true'}});
  try{
   expect(app.bottomBody!.hidden).toBe(kind==='rig');
   expect(app.bottomPanel!.collapse.getAttribute('aria-expanded')).toBe(String(kind!=='rig'));
   app.bottomPanel!.collapse.click();app.flush();
   expect(app.values.get('rig-review-bottom-collapsed/'+kind)).toBe(String(kind!=='rig'));
   if(kind!=='rig')expect(app.values.get('rig-review-bottom-collapsed/rig')).toBe('true');
  }finally{app.close();}
 }
});

test('#674 non-rig tabs reuse the C6 strip and collapse structure with a screen-owned act and sibling column',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Host(tag)}});
 try{
  const heading=new Host(),layout=new Host(),column=new Host(),act=new Host(),actHome=new Host(),panels=[new Host('section'),new Host('section')];
  panels[0]!.id='synthetic-issues';panels[1]!.id='synthetic-flags';actHome.append(act);layout.append(heading,column);
  const mounted=mountBottomPanel({kind:'synthetic',heading:heading as unknown as HTMLElement,act:act as unknown as HTMLElement,actHome:actHome as unknown as HTMLElement,tabs:panels.map((panel,index)=>({id:['issues','flags'][index]!,label:['Setup','Animate'][index]!,panel:panel as unknown as HTMLElement}))});
  expect(mounted.kind).toBe('synthetic');expect(mounted.act).toBe(act as unknown as HTMLElement);expect(mounted.actHome).toBe(actHome as unknown as HTMLElement);expect(act.parentElement).toBe(actHome);
  expect(heading.children).toEqual([mounted.strip,mounted.collapse] as unknown as Host[]);expect(layout.children).toEqual([heading,column]);
  expect(mounted.strip.className).toBe('workspace-bottom-tabs');expect(mounted.strip.getAttribute('role')).toBe('tablist');expect(mounted.strip.getAttribute('aria-label')).toBe('Inspection controls');
  expect(mounted.collapse.id).toBe('workspace-bottom-collapse');expect(mounted.collapse.getAttribute('aria-controls')).toBe('workspace-inspector');expect(mounted.collapse.getAttribute('aria-expanded')).toBe('true');expect(mounted.collapse.textContent).toBe('Collapse bottom panel');
  expect(mounted.row.tabs.map(tab=>[tab.id,tab.button.id,tab.button.textContent,tab.button.getAttribute('role'),tab.button.getAttribute('aria-controls'),tab.button.getAttribute('aria-selected'),tab.button.tabIndex])).toEqual([
   ['issues','workspace-tab-issues','Setup','tab','synthetic-issues','true',0],['flags','workspace-tab-flags','Animate','tab','synthetic-flags','false',-1],
  ]);
  for(const [index,tab] of mounted.row.tabs.entries()){expect(tab.panels[0]).toBe(panels[index] as unknown as HTMLElement);expect(tab.panels[0]!.getAttribute('role')).toBe('tabpanel');expect(tab.panels[0]!.getAttribute('aria-labelledby')).toBe(tab.button.id);}
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});


test('#674 shared bottom strip keeps rig labels and accessibility text in EN and KO',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),preference=getLanguagePreference(),link=getLinkLanguage();
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Host(tag)}});
 try{
  setLinkLanguage(null);
  for(const language of ['en','ko'] as const){
   setLanguagePreference(language);
   const heading=new Host(),act=new Host(),actHome=new Host();
   const mounted=mountBottomPanel({kind:'rig',heading:heading as unknown as HTMLElement,act:act as unknown as HTMLElement,actHome:actHome as unknown as HTMLElement,tabs:['rig','playback','feedback'].map((id,index)=>{const panel=new Host('section');panel.id='inspector-'+id;return {id,label:['Setup','Animate','Write review'][index]!,panel:panel as unknown as HTMLElement};})});
   expect(mounted.row.tabs.map(tab=>tab.button.textContent)).toEqual(language==='en'?['Setup','Animate','Write review']:['셋업','애니메이트','리뷰 작성']);
   expect(mounted.strip.getAttribute('aria-label')).toBe(language==='en'?'Inspection controls':'검사 컨트롤');
   expect(mounted.collapse.textContent).toBe(language==='en'?'Collapse bottom panel':'하단 패널 접기');
   expect(mounted.row.tabs.map(tab=>tab.button.getAttribute('aria-controls'))).toEqual(['inspector-rig','inspector-playback','inspector-feedback']);
  }
 }finally{setLinkLanguage(link);setLanguagePreference(preference);if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});
