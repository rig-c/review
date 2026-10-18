import {expect,test} from 'bun:test';
import {singlePresentation,workspaceResizeRange,workspaceResizeTarget,bindWorkspaceUI} from '../web/workspace-ui.ts';
import {allocateWorkspaceLayout} from '../web/workspace-layout.ts';
import {workspacePreferenceKey,WorkspacePreferenceStore} from '../web/workspace-preferences.ts';

test('actual readiness controls fallback without silently changing the requested view',()=>{
 const pending={ready:false,reason:'Selected video has no decoded frame'},rig={ready:true,reason:null};
 expect(singlePresentation('compare',rig,pending)).toEqual({requested:'compare',effective:'rig',comparisonAvailable:false,reason:pending.reason});
 expect(singlePresentation('compare',{ready:false,reason:'Public player dependency refused'},rig)).toMatchObject({effective:'reference',comparisonAvailable:false,reason:'Public player dependency refused'});
 expect(singlePresentation('reference',rig,pending)).toMatchObject({requested:'reference',effective:'rig'});
 for(const reference of ['image','decoded video','parsed static pose'])expect(singlePresentation('compare',rig,{ready:true,reason:reference})).toMatchObject({effective:'compare',comparisonAvailable:true,reason:null});
 expect(singlePresentation('compare',pending,pending).effective).toBe('none');expect(singlePresentation('rig',rig,rig).effective).toBe('rig');
});

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
 remove(node:Host){this.children=this.children.filter(n=>n!==node);node.parentElement=null;}
 append(...nodes:Host[]){for(const node of nodes){node.parentElement?.remove(node);node.parentElement=this;this.children.push(node);}}
 prepend(...nodes:Host[]){for(const node of [...nodes].reverse()){node.parentElement?.remove(node);node.parentElement=this;this.children.unshift(node);}}
 before(node:Host){const parent=this.parentElement!;node.parentElement?.remove(node);node.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,node);}
 after(node:Host){const parent=this.parentElement!;node.parentElement?.remove(node);node.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}
 contains(node:unknown):boolean{return node===this||this.children.some(n=>n.contains(node));}
 all():Host[]{return this.children.flatMap(n=>[n,...n.all()]);}
 querySelector(selector:string):Host|null {return this.all().find(n=>selector.startsWith('.')?n.classes.has(selector.slice(1)):selector==='main'?n.tagName==='MAIN':selector.includes('aria-selected=true')?n.attrs.get('aria-selected')==='true':false)??null;}
 set innerHTML(value:string){this.children=[];for(const match of value.matchAll(/<(select|input|button|p)[^>]*id="([^"]+)"[^>]*>/g)){const n=new Host(match[1]);n.id=match[2]!;if(match[0].includes('data-app-preference'))n.attrs.set('data-app-preference','');this.append(n);}}
 getAttribute(name:string){return this.attrs.get(name)??null;}setAttribute(name:string,value:string){this.attrs.set(name,value);}removeAttribute(name:string){this.attrs.delete(name);}
 getBoundingClientRect(){return {width:this.clientWidth,height:this.classes.has('workspace-drawer-triggers')?0:this.clientHeight};}
 focus(){hostDocument.activeElement=this;}
 click(){this.dispatchEvent(new Event('click'));const action=(this as unknown as {onclick?:()=>void}).onclick;action?.();}
 showModal(){this.open=true;this.focus();}close(){this.open=false;this.dispatchEvent(new Event('close'));}
 setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
}
let hostDocument:{activeElement:Host|null};
function openHost(){
 const body=new Host('body'),layout=new Host(),main=new Host('main'),left=new Host('aside'),right=new Host('aside'),stage=new Host(),inspector=new Host(),heading=new Host();layout.className='layout';left.className='left-panel';right.id='parts-explorer';stage.id='stage-layout';inspector.className='inspector';heading.clientHeight=30;
 const panels={} as Record<string,Host>;for(const tab of ['view','rig','playback','feedback']){const panel=new Host('section'),button=new Host('button');panel.id='inspector-'+tab;panel.dataset.inspectorPanel=tab;panel.hidden=tab!=='view';panel.clientHeight=200;panel.clientWidth=500;button.dataset.inspector=tab;button.attrs.set('aria-selected',String(tab==='view'));panels[tab]=panel;inspector.append(button,panel);}
 main.append(heading,stage,inspector);layout.append(left,main,right);body.append(layout);
 const values=new Map<string,string>(),events=new EventTarget(),frames=new Map<number,()=>void>();let handle=0;
 const document=Object.assign(new EventTarget(),{body,hidden:false,activeElement:null as Host|null,getElementById:(id:string)=>body.all().find(n=>n.id===id)??null,querySelector:(selector:string)=>body.querySelector(selector),createElement:(tag:string)=>new Host(tag)});hostDocument=document;
 const globals={document,window:events,localStorage:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)},requestAnimationFrame:(callback:()=>void)=>{frames.set(++handle,callback);return handle;},cancelAnimationFrame:(id:number)=>frames.delete(id),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{constructor(_callback:()=>void){}observe(){}disconnect(){}}};
 const old=new Map<string,PropertyDescriptor|undefined>();for(const [key,value]of Object.entries(globals)){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 let changed=0,currentTheme='dark';const ui=bindWorkspaceUI({changed:()=>changed++,defaultTheme:value=>{currentTheme=value;}});
 const flush=()=>{for(let i=0;i<5;i++){const pending=[...frames.values()];frames.clear();for(const run of pending)run();}};flush();
 const get=(id:string)=>document.getElementById(id)!;
 const choose=(id:string,value:string|boolean)=>{const node=get(id);if(typeof value==='boolean')node.checked=value;else node.value=value;(node as unknown as {onchange:()=>void}).onchange();};
 return {ui,get,choose,values,layout,panels,flush,changed:()=>changed,theme:()=>currentTheme,events,activate(tab:string){ui.beforeTab();for(const node of inspector.children)if(node.dataset.inspector)node.attrs.set('aria-selected',String(node.dataset.inspector===tab));for(const [name,node]of Object.entries(panels))node.hidden=name!==tab;ui.afterTab();flush();},close(){ui.dispose();for(const [key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}};
}

test('Settings changes future sync/idle defaults only; transient source state and Reset remain independent',()=>{
 const app=openHost();try{
  const held={cameraSync:false,idleRepeat:false,time:.75,part:'held'},before=structuredClone(held);app.choose('settings-sync',false);app.choose('settings-idle',false);expect(held).toEqual(before);expect(app.ui.defaults()).toMatchObject({defaultCameraSync:false,defaultIdleRepeat:false});expect(app.theme()).toBe('dark');
  app.choose('settings-theme','light');expect(app.theme()).toBe('light');
  const other=new WorkspacePreferenceStore({storage:{getItem:key=>app.values.get(key)??null,setItem:(key,value)=>app.values.set(key,value)},events:null,writer:'other'});other.update({panels:{leftWidth:400,rightWidth:500}});const event=new Event('storage');Object.assign(event,{key:workspacePreferenceKey,newValue:app.values.get(workspacePreferenceKey)});app.events.dispatchEvent(event);app.flush();expect(app.ui.defaults().panels.leftWidth).toBe(400);expect(held).toEqual(before);
  app.get('settings-reset').click();expect(app.ui.defaults()).toMatchObject({theme:'light',defaultCameraSync:false,defaultIdleRepeat:false,panels:{leftWidth:170,rightWidth:260,inspectorHeight:280}});expect(held).toEqual(before);other.dispose();
 }finally{app.close();}
});

test('actual tab hooks retain independent x/y through resize and responsive drawer uses the same stable node',()=>{
 const app=openHost();try{
  app.panels.view!.scrollLeft=33;app.panels.view!.scrollTop=420;app.activate('rig');app.panels.rig!.scrollLeft=11;app.panels.rig!.scrollTop=80;app.activate('view');expect(app.panels.view!.scrollLeft).toBe(33);expect(app.panels.view!.scrollTop).toBe(420);app.activate('rig');expect(app.panels.rig!.scrollTop).toBe(80);expect(JSON.parse(app.ui.scroll())).toMatchObject({view:{x:33,y:420},rig:{x:11,y:80}});
  app.layout.clientWidth=390;app.layout.clientHeight=300;app.ui.refresh();app.flush();const right=app.get('parts-explorer');expect(right.parentElement?.id).toBe('workspace-drawer-rightWidth');app.ui.revealInspector();expect(app.get('workspace-drawer-inspectorHeight').open).toBe(true);
  app.layout.clientWidth=1400;app.layout.clientHeight=900;app.ui.refresh();app.flush();expect(app.get('parts-explorer')).toBe(right);expect(right.parentElement).toBe(app.layout);expect(app.get('workspace-drawer-inspectorHeight').open).toBe(false);expect(app.ui.defaults().panels).toEqual({leftWidth:170,rightWidth:260,inspectorHeight:280});
  expect(()=>app.ui.restoreScroll('{"unknown":{"x":1,"y":1}}')).toThrow('INSPECTOR_SCROLL');
 }finally{app.close();}
});

// Real page loader orchestration, with only published player/asset hosts substituted.
import {readFile} from 'node:fs/promises';
test('one refused compare side preserves the other real paused diagnostic draw without admitting a pair',async()=>{
 const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8'),a=source.indexOf('async function loadSide('),b=source.indexOf('async function loadFrameIndex',a),loader=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b));
 for(const refused of ['a','b']){
  const script=`async function run(refused){
   const assets={},players={},sideReady={},sideFailure={},data={animation:'idle'},location={href:'http://127.0.0.1:4318/',origin:'http://127.0.0.1:4318'},compareSeekStep=1/120,describe=e=>e.message,instanceRoute=x=>x,sideAsset=(side,path)=>'/compare-assets/'+side+'/'+path,nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:''});return nodes.get(id);},text=(id,value)=>{el(id).textContent=value;};
   let fits=0;const fit=()=>{fits++;},presented=[],parts={register(){},present(side){presented.push(side);}},loadPartCatalog=async()=>[];
   const loadModel=async({modelUrl})=>{if(modelUrl.includes('/'+refused+'/'))throw new Error('Public player decode refused '+refused);return {animations:[{name:'idle',duration:0}],dispose(){}};};
   class RigPlayer{time=9;draws=0;paused=false;environment(){}play(){}pause(){this.paused=true;}seek(time){this.time=time;}draw(){this.draws++;}dispose(){}}
   ${loader}
   const value={manifest:{title:'fixture',model:'skeleton.model.json'},reviewedSource:{rig:{sha256:'fixture'}},feedbackCatalog:{slots:[]}};
   const results=await Promise.allSettled([loadSide('a',value),loadSide('b',value)]);return {results:results.map(r=>r.status),sideReady,sideFailure,presented,fits,players:Object.fromEntries(Object.entries(players).map(([side,p])=>[side,{time:p.time,paused:p.paused,draws:p.draws}]))};
  }`;
  const run=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(script)+';return run;')() as (side:string)=>Promise<{results:string[];sideReady:Record<string,boolean>;sideFailure:Record<string,string>;presented:string[];fits:number;players:Record<string,{time:number;paused:boolean;draws:number}>}>;
  const value=await run(refused),survivor=refused==='a'?'b':'a';expect(value.sideReady[refused]).toBe(false);expect(value.sideFailure[refused]).toContain('Public player decode refused');expect(value.sideReady[survivor]).toBe(true);expect(value.players).toEqual({[survivor]:{time:0,paused:true,draws:1}});expect(value.presented).toEqual([survivor]);expect(value.fits).toBe(1);expect(value.results.filter(status=>status==='rejected')).toHaveLength(1);
 }
});


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
