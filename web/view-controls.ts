/** Local inspection controls; these never write source or review state. */
export const panelNode=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
export const panelMake=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
export const actionButton=(
 label:string,
 click:((e?:MouseEvent)=>void)|null,
 disabled?:boolean,
)=>panelMake('button',{
 type:'button',
 textContent:label,
 ...(disabled===undefined?{}:{disabled}),
 onclick:click,
});
export const labelledControl=(
 label:Node|string,
 control:HTMLElement,
 controlFirst=false,
):HTMLLabelElement=>panelMake(
 'label',
 {},
 ...(controlFirst?[control,label]:[label,control]),
);
export type ThemePreference = 'system' | 'dark' | 'light';
import {t,setSourceText} from './i18n.ts';

export interface ViewPoint { x:number; y:number }
export function stageOrientation(width:number,height:number):'horizontal'|'vertical' {return width>=height?'horizontal':'vertical';}
export function panCenter(center:ViewPoint,dx:number,dy:number,scale:number,space:'world'|'image'):ViewPoint {
 if(![center.x,center.y,dx,dy,scale].every(Number.isFinite)||scale<=0)throw new Error('Pan requires finite coordinates and a positive scale');
 return {x:center.x-dx/scale,y:center.y+(space==='world'?dy:-dy)/scale};
}
export function idleAvailable(names:readonly string[],selected:string):boolean {return selected==='idle'&&names.includes('idle');}
export function initialIdleAnimation(names:readonly string[],fallback:string|null,explicit:boolean):string|null {return !explicit&&names.includes('idle')?'idle':fallback;}
/** An automatic idle-at-start checkpoint is preview context, not a manual hold. */
export function automaticIdlePreview(names:readonly string[],selected:string,checkpoint:{animation?:string;time?:number;axis?:unknown}|undefined,explicitCheckpoint:boolean):boolean {
 return idleAvailable(names,selected)&&!explicitCheckpoint&&(!checkpoint||(checkpoint.animation==='idle'&&(checkpoint.time??0)===0&&!checkpoint.axis));
}
export function themePreference(value:unknown):ThemePreference {return value==='dark'||value==='light'?value:'system';}

/** The inspection appearance is transient; workspace Settings owns the saved browser default. */
export function bindAppearance(control:HTMLSelectElement,initial:ThemePreference='system'):{get:()=>ThemePreference;set:(value:ThemePreference)=>void;dispose:()=>void} {
 let current=themePreference(initial);
 const system=matchMedia('(prefers-color-scheme: light)');
 const render=()=>{document.documentElement.dataset.theme=current==='system'?(system.matches?'light':'dark'):current;control.value=current;};
 const set=(value:ThemePreference)=>{current=themePreference(value);render();};
 const change=()=>set(themePreference(control.value));control.addEventListener('change',change);system.addEventListener('change',render);render();
 return {get:()=>current,set,dispose:()=>{control.removeEventListener('change',change);system.removeEventListener('change',render);}};
}
export function syncStageLayout(area:Pick<HTMLElement,'clientWidth'|'clientHeight'|'dataset'>):boolean {const next=stageOrientation(area.clientWidth,area.clientHeight);if(area.dataset.orientation===next)return false;area.dataset.orientation=next;return true;}
export function bindStageLayout(area:HTMLElement,changed:()=>void):()=>void {
 const render=()=>{if(syncStageLayout(area))changed();};
 const observer=new ResizeObserver(render);observer.observe(area);render();return ()=>observer.disconnect();
}
/** Single-key layer toggles. Free of Space (pan), Enter (frame entry), arrows/Home/End (tabs, separators, part list). */
export const layerShortcuts=Object.freeze([
 Object.freeze({key:'i',id:'layer-images',label:'Images'}),
 Object.freeze({key:'m',id:'layer-mesh',label:'Mesh edges'}),
 Object.freeze({key:'b',id:'layer-bones',label:'Bone points'}),
] as const);
const nonTextInputs=new Set(['checkbox','radio','button','submit','reset','range','color','file','image']);
/** A focused text field, textarea, select or contenteditable keeps its keys. */
export function textEntryFocused(target:unknown):boolean {
 const node=target as {closest?:(selector:string)=>unknown;isContentEditable?:boolean}|null;if(!node||typeof node.closest!=='function')return false;
 if(node.isContentEditable||node.closest('textarea,select,[contenteditable]:not([contenteditable="false"])'))return true;
 const input=node.closest('input') as {type?:string}|null;return !!input&&!nonTextInputs.has(String(input.type??'text').toLowerCase());
}
interface ShortcutInput {disabled:boolean;click():void}
/** `I`/`M`/`B` click the actual checkbox, so its change handler, checked state and draft input stay the only state. */
export function bindLayerShortcuts(root:Pick<Document,'addEventListener'|'removeEventListener'>&{getElementById(id:string):unknown}):()=>void {
 const keyDown=(event:Event)=>{
  const e=event as KeyboardEvent;if(e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||typeof e.key!=='string'||textEntryFocused(e.target))return;
  const shortcut=layerShortcuts.find(item=>item.key===e.key.toLowerCase());if(!shortcut)return;
  const input=root.getElementById(shortcut.id) as ShortcutInput|null;if(!input||input.disabled)return;
  e.preventDefault();input.click();
 };
 root.addEventListener('keydown',keyDown);return ()=>root.removeEventListener('keydown',keyDown);
}
/** Disabled toggles name their reason as a tooltip; enabled ones name their key. */
export function describeLayerToggles(root:{getElementById(id:string):unknown},reason:string):void {
 for(const item of layerShortcuts){
  const input=root.getElementById(item.id) as (ShortcutInput&{closest(selector:string):{title:string}|null})|null;const label=input?.closest('label');
  if(input&&label)label.title=input.disabled?reason:`${item.label} · key ${item.key.toUpperCase()}`;
 }
}

/** Finite composition: target rig; compare/Parts/job compatibility expires at steps 3/2/5. */
export interface ViewSwitchMode {
 id:string;labelKey:string;pressed:boolean;hidden?:boolean;
 /** Localized explanation shown on the disabled choice. */
 disabledReason?:string;
}
export interface ViewSwitchGroup {modes:readonly ViewSwitchMode[];hidden?:boolean}
export interface ViewSwitchConfig {
 groups:readonly ViewSwitchGroup[];
 currentMode:string;
 onChange?:(id:string)=>void;
}
export type ViewControlsOptions = {layout:'rigStep1';viewSwitch:ViewSwitchConfig} | {
 layout:'legacyCompareStep3'|'legacyPartsStep2';
} | {
 layout:'legacyCompiledJobStep5';
 inputLabel:(key:string,input:HTMLElement)=>HTMLElement;
};
/** One creation site for each common control; hosts retain adjacent tools and camera/event binding. */
export function createViewControls(options:ViewControlsOptions) {
 const parts=options.layout==='legacyPartsStep2',rig=options.layout==='rigStep1',compare=options.layout==='legacyCompareStep3';
 const zoomIn=actionButton(parts||compare?'+':t(rig?'Zoom in':'job.zoomIn'),null);zoomIn.id='zoom-in';
 const zoomOut=actionButton(parts||compare?'−':t(rig?'Zoom out':'job.zoomOut'),null);zoomOut.id='zoom-out';
 const fit=actionButton(t(compare?'Fit synchronized views':'Fit'),null);fit.id='fit';
 const value=panelMake(rig||compare?'output':'span',{id:compare?'zoom-label':'zoom-value',textContent:parts?'1:1':rig||compare?'100%':''});
 const sync=panelMake('input',{id:'camera-sync',type:'checkbox'});
 const syncLabel=options.layout==='legacyCompiledJobStep5'?options.inputLabel('job.cameraSync',sync):labelledControl(t('Sync cameras'),sync,true);
 if(parts)syncLabel.className='pv-field';
 else if(options.layout==='legacyCompiledJobStep5'){zoomIn.dataset.jobText='job.zoomIn';zoomOut.dataset.jobText='job.zoomOut';fit.dataset.jobText='Fit';}
 if(rig||compare){sync.checked=true;syncLabel.className='camera-sync';zoomIn.setAttribute('aria-label',t(compare?'Zoom active view in':'Zoom in'));zoomOut.setAttribute('aria-label',t(compare?'Zoom active view out':'Zoom out'));}
 if(compare)for(const button of [zoomIn,zoomOut,fit])button.removeAttribute('type');
 const zoomButtons=[zoomIn,zoomOut,fit];
 const zoomGroup=parts||rig||compare?panelMake(parts?'span':'div',{className:parts?'pv-group':rig?'zoom-controls':'row'}):null;
 const nativeOne=parts||rig?actionButton('1:1',null):null;
 if(nativeOne)nativeOne.id='native-one';
 let viewSwitch:HTMLDetailsElement|null=null,viewLabel:HTMLSpanElement|null=null;
 const modes=new Map<string,{mode:ViewSwitchMode;button:HTMLButtonElement;group:readonly ViewSwitchMode[]}>();
 /** A null effective mode clears pressed states but may still name the requested mode. */
 const setMode=(id:string|null,summaryId:string|null=id)=>{
  const selected=id===null?undefined:modes.get(id),summary=summaryId===null?undefined:modes.get(summaryId);
  if(id!==null&&!selected)return;
  for(const item of modes.values())if(id===null||item.group===selected?.group)item.button.setAttribute('aria-pressed',String(item===selected));
  if(viewLabel&&summary)setSourceText(viewLabel,t(summary.mode.labelKey));
 };
 const setDisabled=(id:string,reason:string|null)=>{
  const item=modes.get(id);if(!item)return;
  item.button.disabled=!!reason;item.button.title=reason??'';
  if(reason)item.button.setAttribute('aria-description',reason);else item.button.removeAttribute('aria-description');
 };
 let choices:{assemble:HTMLButtonElement;comparisonGroup:HTMLSpanElement;atlasSwitch:HTMLSpanElement}|null=null;
 if(parts) {
  nativeOne!.setAttribute('aria-pressed','true');
  zoomGroup!.setAttribute('role','group');zoomGroup!.setAttribute('aria-label',t('Zoom'));
  zoomGroup!.append(zoomOut,value,zoomIn,fit,nativeOne!);
  const assemble=actionButton(t('Assembled'),null);assemble.id='pv-assemble';assemble.setAttribute('aria-pressed','false');
  const comparisonGroup=panelMake('span',{className:'pv-field',textContent:t('Painting comparison')});
  const group=panelMake('span',{className:'pv-group'});group.setAttribute('role','group');group.setAttribute('aria-label',t('Painting comparison'));
  for(const [mode,text] of [['part','Part'],['overlay','Overlay'],['difference','Difference']]) {
   const button=actionButton(t(text!),null);button.setAttribute('data-pv-comparison',mode!);button.setAttribute('aria-pressed',String(mode==='part'));group.append(button);
  }
  comparisonGroup.append(group);
  const atlasSwitch=panelMake('span',{className:'pv-group',id:'pv-atlas-switch',hidden:true});atlasSwitch.setAttribute('role','group');atlasSwitch.setAttribute('aria-label',t('Atlas view'));
  for(const [view,text] of [['item','Region'],['page','Pages']]) {
   const button=actionButton(t(text!),null);button.setAttribute('data-pv-view',view!);button.setAttribute('aria-pressed',String(view==='item'));atlasSwitch.append(button);
  }
  choices={assemble,comparisonGroup,atlasSwitch};
 }
 if(rig){
  const config=options.viewSwitch;
  viewSwitch=panelMake('details',{id:'view-menu',className:'view-menu'});
  const groups=config.groups.filter(group=>!group.hidden).map(group=>group.modes.filter(mode=>!mode.hidden)).filter(modes=>modes.length);
  const current=groups.flat().find(mode=>mode.id===config.currentMode);
  const label=viewLabel=panelMake('span',{id:'view-menu-label',textContent:current?t(current.labelKey):''});
  const summary=panelMake('summary',{},t('View switch')+' ',label);summary.setAttribute('aria-label',t('View layout'));
  const list=panelMake('div',{className:'view-menu-list'});list.setAttribute('role','group');list.setAttribute('aria-label',t('View'));
  for(const [index,group] of groups.entries()){
   if(index)list.append(panelMake('hr',{role:'separator'}));
   for(const mode of group){
    const button=actionButton(t(mode.labelKey),()=>{
     if(button.disabled)return;
     setMode(mode.id);viewSwitch!.open=false;config.onChange?.(mode.id);
    });
    button.dataset.view=mode.id;button.setAttribute('aria-pressed',String(mode.pressed));
    modes.set(mode.id,{mode,button,group});
    if(mode.disabledReason)setDisabled(mode.id,mode.disabledReason);
    list.append(button);
   }
  }
  viewSwitch.append(summary,list);
  zoomGroup!.append(zoomIn,zoomOut,fit,nativeOne!,viewSwitch,value);
 }else if(compare)zoomGroup!.append(syncLabel,zoomOut,value,zoomIn,fit);
 return {zoomButtons,zoomGroup,syncLabel,value,choices,nativeOne,viewSwitch,viewModeIds:[...modes.keys()],setMode,setDisabled};
}

// Nested or separately disposed pan binders must not restore another binder's override.
const panVideoOverrides=new WeakMap<HTMLVideoElement,{owners:number;value:string;priority:string}>();
/**
 * A drag that also carries the rig (#331): once the press has travelled more than `threshold` px from where it went down
 * (the click/drag line, the same one a stage click reads), each move is handed to `move` as well as panned. The first
 * delivery is the whole travel since the press, so nothing panned below the threshold is lost; a press that started
 * with Space held is a pan only, and a press that never passes the threshold is a click and carries nothing.
 */
export interface PanCarry {threshold:number;move:(dx:number,dy:number)=>void}
export function bindPan(viewport:HTMLElement,move:(dx:number,dy:number)=>void,enabled:()=>boolean=()=>true,carry?:PanCarry,pinch?:(factor:number,at:ViewPoint,delta:ViewPoint)=>void):()=>void {
 let pointer:number|null=null,x=0,y=0,space=false,press:{x:number;y:number;far:boolean}|null=null;
 const touches=new Map<number,ViewPoint>();let pinching=false;const pair=()=>{const [a,b]=[...touches.values()];return a&&b?{distance:Math.hypot(a.x-b.x,a.y-b.y),center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}}:null;};
 const videos=new Set<HTMLVideoElement>();
 const releaseVideo=(video:HTMLVideoElement)=>{
  const previous=panVideoOverrides.get(video);if(!previous)return;
  if(--previous.owners===0){if(previous.value)video.style.setProperty('pointer-events',previous.value,previous.priority);else video.style.removeProperty('pointer-events');panVideoOverrides.delete(video);}
 };
 const syncVideos=()=>{
  const current=new Set(viewport.querySelectorAll<HTMLVideoElement>('video[controls]'));
  for(const video of videos)if(!current.has(video)){releaseVideo(video);videos.delete(video);}
  for(const video of current)if(!videos.has(video)){
   const previous=panVideoOverrides.get(video);
   if(previous)previous.owners++;else{panVideoOverrides.set(video,{owners:1,value:video.style.getPropertyValue('pointer-events'),priority:video.style.getPropertyPriority('pointer-events')});video.style.setProperty('pointer-events','none','important');}
   videos.add(video);
  }
 };
 const observer=new MutationObserver(()=>{if(space)syncVideos();});
 const releaseSpace=()=>{space=false;observer.disconnect();for(const video of videos)releaseVideo(video);videos.clear();};
 const releasePointer=()=>{const id=pointer;pointer=null;press=null;delete viewport.dataset.panning;if(id!==null&&viewport.hasPointerCapture(id))viewport.releasePointerCapture(id);};
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&enabled()&&!(event.target instanceof Element&&event.target.closest('input,textarea,select,button'))){
  if(!space){space=true;syncVideos();observer.observe(viewport,{childList:true,subtree:true,attributes:true,attributeFilter:['controls']});}event.preventDefault();
 }};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')releaseSpace();};const blur=()=>{for(const id of touches.keys())if(viewport.hasPointerCapture(id))viewport.releasePointerCapture(id);touches.clear();pinching=false;releaseSpace();releasePointer();};
 const start=(event:PointerEvent)=>{if(enabled()&&pinch&&event.pointerType==='touch'&&!(event.target as Element)?.closest?.('button,input,select,textarea,a,[data-viewport-action]')){touches.set(event.pointerId,{x:event.clientX,y:event.clientY});if(touches.size===2){pointer=null;press=null;delete viewport.dataset.panning;pinching=true;viewport.setPointerCapture(event.pointerId);event.preventDefault();return;}}if(!enabled()||!event.isPrimary||event.button!==0)return;const target=event.target;if(target instanceof Element&&(target.closest('button,input,select,textarea,a,[data-viewport-action]')||target.closest('video[controls]')&&!space))return;pointer=event.pointerId;x=event.clientX;y=event.clientY;press=carry&&!space?{x,y,far:false}:null;viewport.setPointerCapture(pointer);viewport.dataset.panning='true';event.preventDefault();};
 const drag=(event:PointerEvent)=>{
  if(touches.has(event.pointerId)){const before=pair();touches.set(event.pointerId,{x:event.clientX,y:event.clientY});const after=pair();if(pinching){if(enabled()&&before&&after&&before.distance>0&&after.distance>0){const r=viewport.getBoundingClientRect();pinch?.(after.distance/before.distance,{x:before.center.x-r.left,y:before.center.y-r.top},{x:after.center.x-before.center.x,y:after.center.y-before.center.y});}event.preventDefault();return;}}
  if(event.pointerId!==pointer)return;const dx=event.clientX-x,dy=event.clientY-y;x=event.clientX;y=event.clientY;move(dx,dy);event.preventDefault();
  if(!press||!carry)return;
  if(press.far)carry.move(dx,dy);
  else if(Math.hypot(x-press.x,y-press.y)>carry.threshold){press.far=true;carry.move(x-press.x,y-press.y);}
 };
 const end=(event:PointerEvent)=>{touches.delete(event.pointerId);if(event.pointerType==='touch'&&viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);if(touches.size===0)pinching=false;if(event.pointerId===pointer)releasePointer();};
 const native=(event:DragEvent)=>event.preventDefault();
 window.addEventListener('blur',blur);document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);viewport.addEventListener('pointerdown',start);viewport.addEventListener('pointermove',drag);viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);viewport.addEventListener('lostpointercapture',end);viewport.addEventListener('dragstart',native);
 return ()=>{blur();window.removeEventListener('blur',blur);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);viewport.removeEventListener('pointerdown',start);viewport.removeEventListener('pointermove',drag);viewport.removeEventListener('pointerup',end);viewport.removeEventListener('pointercancel',end);viewport.removeEventListener('lostpointercapture',end);viewport.removeEventListener('dragstart',native);};
}

/** A discovered row; the block adapter supplies nodes, never another activation implementation. */
export interface InspectorTabItem {
 id:string;button:HTMLButtonElement;panels:HTMLElement[];attribute:'aria-selected'|'aria-pressed';included?:HTMLElement[];
}
export interface InspectorTabRow {
 tabs:InspectorTabItem[];panels:HTMLElement[];modes?:{button:HTMLButtonElement;id:string}[];
 /** Inner rows delegate bubbling events and keep per-block offsets; outer selectors retain onclick timing. */
 root?:HTMLElement;scrollRoot?:HTMLElement;initialize?:boolean;
 /** Explicit activation reveals an existing host panel, including an already-selected tab; restore never calls it. */
 reveal?:(id:string)=>void;
}
export interface InspectorTabs {select(id:string):void;restore(id:string):void;state():string|undefined;dispose():void}
/** beforeChange runs while the old panel is visible; changed runs after the new one is shown.
 * Omitted row discovers the existing outer selectors. Restore changes selection without user hooks or scrolling. */
export function bindInspectorTabs(changed:()=>void,beforeChange:()=>void=()=>{},row?:InspectorTabRow):InspectorTabs {
 const scoped=!!row;
 if(!row){
  const buttons=[...document.querySelectorAll<HTMLButtonElement>('[data-inspector]')],panels=[...document.querySelectorAll<HTMLElement>('[data-inspector-panel]')];
  row={tabs:buttons.map(button=>({id:button.dataset.inspector!,button,panels:panels.filter(panel=>panel.dataset.inspectorPanel===button.dataset.inspector),attribute:button.dataset.mode!==undefined?'aria-pressed':'aria-selected'})),panels,
   modes:[...document.querySelectorAll<HTMLButtonElement>('[data-mode]')].filter(button=>!buttons.includes(button)).map(button=>({button,id:button.dataset.mode!}))};
 }
 const {tabs,panels,modes=[],root,scrollRoot}=row,disposers:(()=>void)[]=[],scrolls=new Map<string,number>();
 let active=tabs.find(tab=>tab.button.getAttribute?.(tab.attribute)==='true'),disposed=false;
 const reflect=()=>{const selected=tabs.find(tab=>tab.button.getAttribute?.(tab.attribute)==='true')?.id;for(const mode of modes)mode.button.setAttribute('aria-pressed',String(mode.id===selected));};
 const render=(target:InspectorTabItem)=>{
  for(const tab of tabs){
   const on=tab===target,value=String(on);
   if(!scoped||tab.button.getAttribute(tab.attribute)!==value)tab.button.setAttribute(tab.attribute,value);
   if(tab.attribute==='aria-selected'&&(!scoped||tab.button.tabIndex!==(on?0:-1)))tab.button.tabIndex=on?0:-1;
   if(scoped)for(const panel of tab.panels)if(panel.hidden===on)panel.hidden=!on;
   for(const node of tab.included??[])if(node.hasAttribute('data-block-hidden')===on)node.toggleAttribute('data-block-hidden',!on);
  }
  if(!scoped)for(const panel of panels)panel.hidden=!target.panels.includes(panel);
  reflect();
 };
 const activate=(id:string,user:boolean)=>{
  if(disposed)return;const target=tabs.find(tab=>tab.id===id);if(!target)return;
  if(scoped&&active===target){if(user)row.reveal?.(id);return;}
  const previous=active;
  if(user){beforeChange();if(scrollRoot&&previous)scrolls.set(previous.id,scrollRoot.scrollTop);}
  render(target);
  if(user&&scrollRoot&&previous){const next=scrolls.get(id)??0;if(scrollRoot.scrollTop!==next)scrollRoot.scrollTop=next;}
  active=target;
  // Inner restoration has always notified draft persistence, but never swaps scroll offsets.
  if(user||scoped&&previous)changed();
  if(user)row.reveal?.(id);
 };
 const key=(tab:InspectorTabItem,event:KeyboardEvent)=>{
  if(tab.attribute==='aria-pressed')return;const index=tabs.indexOf(tab);
  const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
  if(next===null)return;event.preventDefault();const target=tabs[next];if(target){if(row.reveal)target.button.focus();activate(target.id,true);if(!row.reveal)target.button.focus();}
 };
 if(root){
  const tabOf=(event:Event)=>{const button=(event.target as Element|null)?.closest?.('button[data-block-target]');return tabs.find(tab=>tab.button===button);};
  const click=(event:Event)=>{const tab=tabOf(event);if(tab)activate(tab.id,true);};
  const keydown=(event:KeyboardEvent)=>{const tab=tabOf(event);if(tab)key(tab,event);};
  root.addEventListener('click',click);root.addEventListener('keydown',keydown);
  disposers.push(()=>{root.removeEventListener('click',click);root.removeEventListener('keydown',keydown);});
 }else{
  for(const tab of tabs){
   const click=()=>activate(tab.id,true),keydown=(event:KeyboardEvent)=>key(tab,event);
   tab.button.onclick=click;if(tab.attribute==='aria-selected')tab.button.onkeydown=keydown;
   disposers.push(()=>{if(tab.button.onclick===click)tab.button.onclick=null;if(tab.button.onkeydown===keydown)tab.button.onkeydown=null;});
  }
 }
 for(const mode of modes){const click=()=>activate(mode.id,true);mode.button.onclick=click;disposers.push(()=>{if(mode.button.onclick===click)mode.button.onclick=null;});}
 if(row.initialize){active??=tabs[0];if(active)render(active);}else reflect();
 return {select:id=>activate(id,true),restore:id=>activate(id,false),state:()=>active?.id,dispose(){disposed=true;for(const dispose of disposers)dispose();scrolls.clear();}};
}
