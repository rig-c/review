import {expect,test} from 'bun:test';
import {allocateWorkspaceLayout,bindWorkspaceDrawer,bindWorkspaceSeparator,InspectorScrollMemory,parseInspectorScroll,type ScrollScheduler,type WorkspacePanel} from '../web/workspace-layout.ts';
import {defaultWorkspacePanels,panelBounds,type WorkspacePanels} from '../web/workspace-preferences.ts';
class LayoutElement extends EventTarget {
 attrs=new Map<string,string>();dataset:Record<string,string>={};style={touchAction:'pan-y'};tabIndex=-1;captured=new Set<number>();focused=false;id='';open=false;showCalls=0;closeCalls=0;
 getAttribute(key:string){return this.attrs.get(key)??null;}setAttribute(key:string,value:string){this.attrs.set(key,value);}removeAttribute(key:string){this.attrs.delete(key);}closest(){return null;}
 setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
 focus(){this.focused=true;}
 showModal(){this.open=true;this.showCalls++;this.focused=true;}
 close(){this.open=false;this.closeCalls++;/* native close event is queued, not synchronously delivered */}
 emit(type:string,values:Record<string,unknown>={}){const event=new Event(type,{cancelable:true});for(const [key,value]of Object.entries(values))Object.defineProperty(event,key,{value});this.dispatchEvent(event);return event;}
}
function separator(panel:WorkspacePanel='leftWidth',commit=true){
 const element=new LayoutElement(),events=new EventTarget();let desired=panel==='inspectorHeight'?280:200,enabled=true;const values:number[]=[],commits:number[]=[];
 const binding=bindWorkspaceSeparator({element:element as unknown as HTMLElement,panel,controls:'actual-panel',label:'Resize actual panel',events,range:()=>({min:120,max:600,value:Math.min(600,desired),enabled}),desired:()=>desired,resize:value=>{desired=value;values.push(value);},...(commit?{commit:(value:number)=>commits.push(value)}:{})});
 return {element,events,binding,values,commits,value:()=>desired,disable:()=>{enabled=false;binding.refresh();}};
}
test('allocator preserves stage minima without changing desired desktop values; narrow views use drawers',()=>{
 const desired={leftWidth:420,rightWidth:550,inspectorHeight:500},large=allocateWorkspaceLayout({width:1600,height:1100},desired);expect(large).toMatchObject({...desired,stageWidth:614,stageHeight:592,leftMode:'panel',rightMode:'panel',inspectorMode:'panel',stageMinimumSatisfied:true});
 const squeezed=allocateWorkspaceLayout({width:700,height:500},desired);expect(squeezed.stageWidth).toBeCloseTo(240,8);expect(squeezed.stageHeight).toBe(180);expect(squeezed.leftWidth).toBeGreaterThanOrEqual(120);expect(squeezed.rightWidth).toBeGreaterThanOrEqual(180);expect(squeezed.leftWidth+squeezed.rightWidth+squeezed.stageWidth+16).toBeCloseTo(700,8);
 const narrow=allocateWorkspaceLayout({width:390,height:300},desired);expect(narrow).toMatchObject({leftWidth:0,rightWidth:0,inspectorHeight:0,leftMode:'drawer',rightMode:'drawer',inspectorMode:'drawer',stageWidth:390,stageHeight:300});expect(narrow.separators.leftWidth).toEqual({enabled:false,min:0,max:0,value:0});expect(allocateWorkspaceLayout({width:1600,height:1100},desired)).toEqual(large);expect(desired).toEqual({leftWidth:420,rightWidth:550,inspectorHeight:500});
 expect(allocateWorkspaceLayout({width:180,height:100},defaultWorkspacePanels).stageMinimumSatisfied).toBe(false);expect(()=>allocateWorkspaceLayout({width:NaN,height:300},desired)).toThrow('RECTANGLE');
});
test('separator keyboard has correct orientation, pixel ARIA and boundary direction without intercepting text arrows',()=>{
 for(const [panel,key,expected,orientation]of [['leftWidth','ArrowRight',208,'vertical'],['rightWidth','ArrowLeft',208,'vertical'],['inspectorHeight','ArrowUp',288,'horizontal']] as const){const h=separator(panel,false);expect(h.element.getAttribute('role')).toBe('separator');expect(h.element.getAttribute('aria-controls')).toBe('actual-panel');expect(h.element.getAttribute('aria-orientation')).toBe(orientation);expect(h.element.tabIndex).toBe(0);const arrow=h.element.emit('keydown',{key});expect(arrow.defaultPrevented).toBe(true);expect(h.value()).toBe(expected);expect(h.element.getAttribute('aria-valuenow')).toBe(String(expected));h.element.emit('keydown',{key:'End'});expect(h.value()).toBe(600);h.element.emit('keydown',{key:'Home'});expect(h.value()).toBe(120);const text=h.element.emit('keydown',{key:'ArrowRight',target:new LayoutElement()});expect(text.defaultPrevented).toBe(false);expect(h.value()).toBe(120);const modified=h.element.emit('keydown',{key:'ArrowRight',ctrlKey:true});expect(modified.defaultPrevented).toBe(false);h.binding.dispose();expect(h.element.getAttribute('role')).toBeNull();expect(h.element.style.touchAction).toBe('pan-y');}
});
test('pointer resizing captures focus, commits only release, and ignores unrelated pointers',()=>{
 const h=separator();h.element.emit('pointerdown',{pointerId:3,isPrimary:true,button:0,clientX:10,clientY:10});expect(h.element.focused).toBe(true);expect(h.element.hasPointerCapture(3)).toBe(true);h.element.emit('pointermove',{pointerId:8,clientX:100,clientY:0});expect(h.value()).toBe(200);h.element.emit('pointermove',{pointerId:3,clientX:45,clientY:10});expect(h.value()).toBe(235);expect(h.commits).toEqual([]);h.element.emit('pointerup',{pointerId:3});expect(h.commits).toEqual([235]);expect(h.element.hasPointerCapture(3)).toBe(false);expect(h.element.dataset.resizing).toBeUndefined();h.binding.dispose();
});
test('cancel, lost capture, blur, Escape and disabled responsive state restore original desired size and release drag',()=>{
 for(const ending of ['pointercancel','lostpointercapture','blur','Escape','disabled','dispose']){const h=separator('rightWidth');h.element.emit('pointerdown',{pointerId:3,isPrimary:true,button:0,clientX:100,clientY:0});h.element.emit('pointermove',{pointerId:3,clientX:70,clientY:0});expect(h.value()).toBe(230);if(ending==='blur')h.events.dispatchEvent(new Event('blur'));else if(ending==='Escape')h.element.emit('keydown',{key:'Escape'});else if(ending==='disabled')h.disable();else if(ending==='dispose')h.binding.dispose();else h.element.emit(ending,{pointerId:3});expect(h.value()).toBe(200);expect(h.element.hasPointerCapture(3)).toBe(false);expect(h.element.dataset.resizing).toBeUndefined();expect(h.commits).toEqual([]);if(ending==='disabled'){expect(h.element.tabIndex).toBe(-1);expect(h.element.getAttribute('aria-valuenow')).toBe('200');}h.binding.dispose();}
});
test('native-dialog drawer supplies named trigger semantics and immediately restores focus on owned close/disposal',()=>{
 const trigger=new LayoutElement(),drawer=new LayoutElement(),close=new LayoutElement();drawer.id='sources-dialog';const dispose=bindWorkspaceDrawer({trigger:trigger as unknown as HTMLButtonElement,drawer:drawer as unknown as HTMLDialogElement,label:'Sources and settings',close:close as unknown as HTMLButtonElement});expect(trigger.getAttribute('aria-controls')).toBe('sources-dialog');expect(drawer.getAttribute('aria-label')).toBe('Sources and settings');trigger.emit('click');expect(drawer.showCalls).toBe(1);expect(trigger.getAttribute('aria-expanded')).toBe('true');trigger.focused=false;close.emit('click');expect(drawer.open).toBe(false);expect(trigger.focused).toBe(true);expect(trigger.getAttribute('aria-expanded')).toBe('false');drawer.emit('close');trigger.emit('click');trigger.focused=false;dispose();expect(drawer.open).toBe(false);expect(trigger.focused).toBe(true);trigger.emit('click');expect(drawer.open).toBe(false);
});
function scheduler(){let next=0;const queued=new Map<number,()=>void>();const value:ScrollScheduler={request:callback=>{queued.set(++next,callback);return next;},cancel:handle=>{queued.delete(handle);}};return {value,frame:()=>{const pending=[...queued];queued.clear();for(const [,callback]of pending)callback();},size:()=>queued.size};}
test('tab scroll stores source-local actual x/y, settles and clamps without losing desired position on late content',()=>{
 const queue=scheduler(),memory=new InspectorScrollMemory({},queue.value),view={scrollLeft:23,scrollTop:480,scrollWidth:900,scrollHeight:1200,clientWidth:500,clientHeight:400},rig={...view,scrollLeft:4,scrollTop:75};memory.capture('view',view);memory.capture('rig',rig);view.scrollLeft=0;view.scrollTop=0;memory.restore('view',view);queue.frame();expect(view.scrollTop).toBe(0);queue.frame();expect(view.scrollTop).toBe(480);expect(view.scrollLeft).toBe(23);expect(memory.snapshot().rig).toEqual({x:4,y:75});
 view.scrollHeight=400;memory.restore('view',view);queue.frame();queue.frame();expect(view.scrollTop).toBe(0);expect(memory.restoring('view')).toBe(true);memory.capture('view',view);expect(memory.snapshot().view?.y).toBe(480);queue.frame();expect(memory.restoring('view')).toBe(false);view.scrollHeight=1200;memory.restore('view',view);queue.frame();queue.frame();expect(view.scrollTop).toBe(480);const saved=memory.snapshot();saved.view!.y=1;expect(memory.snapshot().view?.y).toBe(480);const reloaded=new InspectorScrollMemory(JSON.parse(JSON.stringify(memory.snapshot())),queue.value);expect(reloaded.snapshot()).toEqual(memory.snapshot());expect(new InspectorScrollMemory().snapshot()).toEqual({});memory.dispose();reloaded.dispose();
});
test('superseded scroll cancellation cannot cancel a newer restoration; malformed source-draft scroll refuses',()=>{
 const queue=scheduler(),memory=new InspectorScrollMemory({feedback:{x:10,y:100}},queue.value),panel={scrollLeft:0,scrollTop:0,scrollWidth:500,scrollHeight:1000,clientWidth:300,clientHeight:400};const oldCancel=memory.restore('feedback',panel);memory.restore('feedback',panel);oldCancel();queue.frame();queue.frame();expect(panel.scrollTop).toBe(100);memory.restore('feedback',panel);memory.dispose();expect(queue.size()).toBe(0);
 for(const value of [{unknown:{x:1,y:1}},{view:{x:-1,y:0}},{view:{x:0,y:Infinity}},{view:{x:1,y:1,sourceHash:'private'}},{view:{x:1,y:10000001}}])expect(()=>parseInspectorScroll(value)).toThrow('INSPECTOR_SCROLL');
});

test('responsive boundary rectangles never overflow and preserve a positive stage whenever it fits',()=>{
 const desired={leftWidth:720,rightWidth:900,inspectorHeight:900};
 for(const width of [0,180,239,240,390,427,428,555,556,557,700,1024,1600])for(const height of [0,179,180,300,347,348,500,1000]){
  const layout=allocateWorkspaceLayout({width,height},desired),handles=(Number(layout.leftMode==='panel')+Number(layout.rightMode==='panel'))*8;
  expect(layout.leftWidth+layout.rightWidth+layout.stageWidth+handles).toBeCloseTo(width,8);expect(layout.inspectorHeight+layout.stageHeight+(layout.inspectorMode==='panel'?8:0)).toBeCloseTo(height,8);expect(layout.stageWidth).toBeGreaterThanOrEqual(0);expect(layout.stageHeight).toBeGreaterThanOrEqual(0);
  if(width>=240)expect(layout.stageWidth).toBeGreaterThanOrEqual(240-1e-8);if(height>=180)expect(layout.stageHeight).toBeGreaterThanOrEqual(180-1e-8);
 }
 expect(desired).toEqual({leftWidth:720,rightWidth:900,inspectorHeight:900});
});

test('pointer events from editing descendants are untouched while a button separator itself can drag',()=>{
 const h=separator();const input={closest:()=>input};const untouched=h.element.emit('pointerdown',{target:input,pointerId:2,isPrimary:true,button:0,clientX:0,clientY:0});expect(untouched.defaultPrevented).toBe(false);expect(h.element.captured.size).toBe(0);
 Object.defineProperty(h.element,'closest',{value:()=>h.element});h.element.emit('pointerdown',{pointerId:2,isPrimary:true,button:0,clientX:0,clientY:0});expect(h.element.hasPointerCapture(2)).toBe(true);h.binding.dispose();
});

test('a responsive clamped separator click and bound key never save the temporary size',()=>{
 const element=new LayoutElement(),commits:number[]=[],resizes:number[]=[];let desired=420;
 const binding=bindWorkspaceSeparator({element:element as unknown as HTMLElement,panel:'leftWidth',controls:'left',label:'Resize left',events:null,desired:()=>desired,range:()=>({min:120,max:184,value:184,enabled:true}),resize:value=>{desired=value;resizes.push(value);},commit:value=>commits.push(value)});
 element.emit('pointerdown',{pointerId:1,isPrimary:true,button:0,clientX:0});element.emit('pointerup',{pointerId:1});element.emit('keydown',{key:'ArrowRight'});element.emit('keydown',{key:'End'});expect(desired).toBe(420);expect(resizes).toEqual([]);expect(commits).toEqual([]);binding.dispose();
});

test('a resize that disables its own separator cancels safely before the move callback returns',()=>{
 const element=new LayoutElement();let desired=200,enabled=true;const commits:number[]=[];
 const binding=bindWorkspaceSeparator({element:element as unknown as HTMLElement,panel:'leftWidth',controls:'left',label:'Resize left',events:null,desired:()=>desired,range:()=>({min:120,max:600,value:desired,enabled}),resize:value=>{desired=value;if(value>200)enabled=false;},commit:value=>commits.push(value)});
 element.emit('pointerdown',{pointerId:1,isPrimary:true,button:0,clientX:0});expect(()=>element.emit('pointermove',{pointerId:1,clientX:10})).not.toThrow();expect(desired).toBe(200);expect(element.hasPointerCapture(1)).toBe(false);expect(commits).toEqual([]);element.emit('pointerup',{pointerId:1});expect(commits).toEqual([]);binding.dispose();
});

test('coupled allocation uses reachable effective ranges and inverse desired values for keyboard and pointer',()=>{
 const element=new LayoutElement(),available={width:700,height:500};let desired:WorkspacePanels={leftWidth:420,rightWidth:550,inspectorHeight:280};const commits:number[]=[];
 const effective=(leftWidth=desired.leftWidth)=>allocateWorkspaceLayout(available,{...desired,leftWidth}).leftWidth;
 const range=()=>({min:effective(panelBounds.leftWidth.min),max:effective(panelBounds.leftWidth.max),value:effective(),enabled:true});
 const binding=bindWorkspaceSeparator({element:element as unknown as HTMLElement,panel:'leftWidth',controls:'left',label:'Resize left',events:null,desired:()=>desired.leftWidth,range,resolveDesired:(target,context)=>{expect(context.range).toEqual(range());expect(context.desired).toBe(desired.leftWidth);let low:number=panelBounds.leftWidth.min,high:number=panelBounds.leftWidth.max;for(let i=0;i<60;i++){const mid=(low+high)/2;if(effective(mid)<target)low=mid;else high=mid;}return (low+high)/2;},resize:value=>{desired={...desired,leftWidth:value};},commit:value=>commits.push(value)});
 const original=effective();element.emit('keydown',{key:'ArrowRight'});expect(effective()).toBeCloseTo(original+8,6);for(const name of ['aria-valuemin','aria-valuemax','aria-valuenow'])expect(element.getAttribute(name)).toMatch(/^\d+$/);expect(element.getAttribute('aria-valuetext')).toMatch(/^\d+ pixels$/);expect(desired.leftWidth).toBeGreaterThan(420);expect(commits.at(-1)).toBe(desired.leftWidth);
 element.emit('keydown',{key:'Home'});expect(effective()).toBeCloseTo(range().min,6);element.emit('keydown',{key:'End'});expect(effective()).toBeCloseTo(range().max,6);const atEnd=desired.leftWidth,count=commits.length;element.emit('keydown',{key:'ArrowRight'});expect(commits.length).toBe(count);expect(desired.leftWidth).toBe(atEnd);
 element.emit('pointerdown',{pointerId:2,isPrimary:true,button:0,clientX:100});element.emit('pointermove',{pointerId:2,clientX:90});expect(effective()).toBeCloseTo(range().max-10,6);element.emit('pointercancel',{pointerId:2});expect(desired.leftWidth).toBe(atEnd);expect(commits.length).toBe(count);
 element.emit('pointerdown',{pointerId:3,isPrimary:true,button:0,clientX:100});element.emit('pointermove',{pointerId:3,clientX:90});const moved=desired.leftWidth;element.emit('pointerup',{pointerId:3});expect(commits.at(-1)).toBe(moved);expect(effective()).toBeCloseTo(range().max-10,6);binding.dispose();
});

test('settled programmatic clamping survives before-hide capture but intentional user scroll replaces it',()=>{
 const queue=scheduler(),memory=new InspectorScrollMemory({view:{x:23,y:480}},queue.value),panel={scrollLeft:0,scrollTop:0,scrollWidth:500,scrollHeight:400,clientWidth:500,clientHeight:400};memory.restore('view',panel);queue.frame();queue.frame();queue.frame();expect(memory.restoring('view')).toBe(false);expect(panel.scrollTop).toBe(0);
 // The ordinary before-hide capture happens after restore suppression has ended.
 memory.capture('view',panel);expect(memory.snapshot().view).toEqual({x:23,y:480});panel.scrollWidth=900;panel.scrollHeight=1200;memory.restore('view',panel);queue.frame();queue.frame();queue.frame();expect(panel.scrollTop).toBe(480);expect(panel.scrollLeft).toBe(23);
 panel.scrollLeft=0;panel.scrollTop=0;memory.capture('view',panel,true);memory.restore('view',panel);queue.frame();queue.frame();expect(memory.snapshot().view).toEqual({x:0,y:0});expect(panel.scrollTop).toBe(0);
 memory.restore('view',panel);queue.frame();panel.scrollTop=77;memory.capture('view',panel,true);queue.frame();queue.frame();expect(panel.scrollTop).toBe(77);expect(memory.snapshot().view).toEqual({x:0,y:77});expect(memory.restoring('view')).toBe(false);memory.dispose();
});

const explorerLeft={left:'rightWidth',right:null} as const;
test('a single left column uses its own saved width and bounds; the absent side has no size or separator',()=>{
 const wide=allocateWorkspaceLayout({width:1280,height:900},defaultWorkspacePanels,explorerLeft);
 expect(wide).toMatchObject({rightWidth:260,leftWidth:0,leftMode:'absent',rightMode:'panel',stageWidth:1280-260-8});expect(wide.separators.leftWidth.enabled).toBe(false);expect(wide.separators.rightWidth).toMatchObject({min:180,value:260,enabled:true});
 const edge=180+240+8;expect(allocateWorkspaceLayout({width:edge,height:900},defaultWorkspacePanels,explorerLeft).rightMode).toBe('panel');
 expect(allocateWorkspaceLayout({width:edge-1,height:900},defaultWorkspacePanels,explorerLeft)).toMatchObject({rightMode:'drawer',rightWidth:0,stageWidth:edge-1});
 for(const width of [0,239,240,427,428,429,700,980,1280,1600])for(const height of [0,180,500,900]){const layout=allocateWorkspaceLayout({width,height},{leftWidth:720,rightWidth:900,inspectorHeight:900},explorerLeft),handle=layout.rightMode==='panel'?8:0;expect(layout.leftWidth).toBe(0);expect(layout.rightWidth+layout.stageWidth+handle).toBeCloseTo(width,8);if(width>=240)expect(layout.stageWidth).toBeGreaterThanOrEqual(240-1e-8);}
 expect(allocateWorkspaceLayout({width:1280,height:900},defaultWorkspacePanels)).toMatchObject({leftWidth:170,rightWidth:260,leftMode:'panel',rightMode:'panel'});
});
test('column maps that repeat or invent a saved width are refused by name',()=>{
 expect(()=>allocateWorkspaceLayout({width:900,height:600},defaultWorkspacePanels,{left:'rightWidth',right:'rightWidth'})).toThrow('WORKSPACE_COLUMNS: left rightWidth / right rightWidth; required distinct leftWidth, rightWidth or null');
 expect(()=>allocateWorkspaceLayout({width:900,height:600},defaultWorkspacePanels,{left:'inspectorHeight',right:null} as never)).toThrow('WORKSPACE_COLUMNS: left inspectorHeight');
});
test('a separator follows its side, not its saved field name',()=>{
 const element=new LayoutElement();let desired=260;
 const binding=bindWorkspaceSeparator({element:element as unknown as HTMLElement,panel:'rightWidth',side:'left',controls:'parts',label:'Resize parts',events:null,desired:()=>desired,range:()=>({min:180,max:600,value:desired,enabled:true}),resize:value=>{desired=value;}});
 element.emit('keydown',{key:'ArrowRight'});expect(desired).toBe(268);element.emit('pointerdown',{pointerId:1,isPrimary:true,button:0,clientX:100});element.emit('pointermove',{pointerId:1,clientX:130});expect(desired).toBe(298);element.emit('pointerup',{pointerId:1});binding.dispose();
});
