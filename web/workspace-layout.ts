/** Effective workspace geometry and local DOM bindings. Never stores source or global preferences. */
import {parseWorkspacePanels,panelBounds,type WorkspacePanels} from './workspace-preferences.ts';
export type WorkspacePanel=keyof WorkspacePanels;
export const workspaceMinimums=Object.freeze({stageWidth:240,stageHeight:180,separator:8});
export interface SeparatorRange {min:number;max:number;value:number;enabled:boolean}
export interface EffectiveWorkspaceLayout {leftWidth:number;rightWidth:number;inspectorHeight:number;stageWidth:number;stageHeight:number;leftMode:'panel'|'drawer';rightMode:'panel'|'drawer';inspectorMode:'panel'|'drawer';stageMinimumSatisfied:boolean;separators:Record<WorkspacePanel,SeparatorRange>}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
/** Input rectangle excludes app chrome. Drawer triggers must remain outside collapsed panel content.
 * Collapse left, then right when minima cannot coexist; Inspector becomes a drawer below its minimum.
 * Returned clamps never replace the user's desired desktop sizes. */
export function allocateWorkspaceLayout(available:{width:number;height:number},desired:WorkspacePanels):EffectiveWorkspaceLayout {
 const panels=parseWorkspacePanels(desired),{width,height}=available,{stageWidth:minWidth,stageHeight:minHeight,separator}=workspaceMinimums;
 if(![width,height].every(n=>Number.isFinite(n)&&n>=0&&n<=65536))throw new Error('WORKSPACE_RECTANGLE: finite 0..65536 CSS pixels required');
 let left=true,right=true;if(width<panelBounds.leftWidth.min+panelBounds.rightWidth.min+minWidth+2*separator)left=false;if(width<(left?panelBounds.leftWidth.min+separator:0)+panelBounds.rightWidth.min+minWidth+separator)right=false;
 const count=Number(left)+Number(right),budget=Math.max(0,width-minWidth-count*separator),leftMin=left?panelBounds.leftWidth.min:0,rightMin=right?panelBounds.rightWidth.min:0,wantLeft=left?panels.leftWidth:0,wantRight=right?panels.rightWidth:0;
 const slack=wantLeft+wantRight-leftMin-rightMin,ratio=slack>0?Math.min(1,Math.max(0,(budget-leftMin-rightMin)/slack)):1,leftWidth=leftMin+(wantLeft-leftMin)*ratio,rightWidth=rightMin+(wantRight-rightMin)*ratio;
 const inspector=height>=minHeight+panelBounds.inspectorHeight.min+separator,inspectorHeight=inspector?Math.min(panels.inspectorHeight,height-minHeight-separator):0;
 const stageWidth=Math.max(0,width-leftWidth-rightWidth-count*separator),stageHeight=Math.max(0,height-inspectorHeight-(inspector?separator:0));
 const range=(visible:boolean,key:WorkspacePanel,value:number,max:number):SeparatorRange=>visible?{min:panelBounds[key].min,max:Math.max(panelBounds[key].min,Math.min(panelBounds[key].max,max)),value,enabled:true}:{min:0,max:0,value:0,enabled:false};
 return {leftWidth,rightWidth,inspectorHeight,stageWidth,stageHeight,leftMode:left?'panel':'drawer',rightMode:right?'panel':'drawer',inspectorMode:inspector?'panel':'drawer',stageMinimumSatisfied:width>=minWidth&&height>=minHeight,separators:{leftWidth:range(left,'leftWidth',leftWidth,width-rightWidth-count*separator-minWidth),rightWidth:range(right,'rightWidth',rightWidth,width-leftWidth-count*separator-minWidth),inspectorHeight:range(inspector,'inspectorHeight',inspectorHeight,height-minHeight-separator)}};
}
export interface WorkspaceSeparatorOptions {element:HTMLElement;panel:WorkspacePanel;controls:string;label:string;range:()=>SeparatorRange;resize:(desired:number)=>void;desired?:()=>number;commit?:(desired:number)=>void;events?:Pick<EventTarget,'addEventListener'|'removeEventListener'>|null;step?:number;coarseStep?:number}
/** Arrow keys act only on the separator itself. Right/bottom boundaries grow inward.
 * Pointer cancellation, capture loss, Escape and blur restore the prior desired size. */
export function bindWorkspaceSeparator(options:WorkspaceSeparatorOptions):{refresh():void;dispose():void} {
 const {element,panel}=options,vertical=panel!=='inspectorHeight',direction=panel==='leftWidth'?1:-1,events=options.events===undefined?(typeof window==='undefined'?null:window):options.events;
 if(!options.controls||!options.label||/[\x00-\x1f]/.test(options.controls+options.label))throw new Error('WORKSPACE_SEPARATOR: controls and accessible label required');
 const step=options.step??8,coarse=options.coarseStep??40;if(![step,coarse].every(n=>Number.isFinite(n)&&n>0))throw new Error('WORKSPACE_SEPARATOR: positive finite keyboard steps required');
 const attrs=['role','aria-orientation','aria-controls','aria-label','aria-valuemin','aria-valuemax','aria-valuenow','aria-valuetext','aria-disabled'],saved=new Map(attrs.map(key=>[key,element.getAttribute(key)])),tabIndex=element.tabIndex,touchAction=element.style.touchAction;
 let drag:{id:number;coordinate:number;value:number;desired:number;last:number}|null=null,disposed=false;
 const current=()=>{const range=options.range();if(![range.min,range.max,range.value].every(Number.isFinite)||range.min>range.max)throw new Error('WORKSPACE_SEPARATOR_RANGE: finite ordered range required');return {...range,value:clamp(range.value,range.min,range.max)};};
 const release=(cancel:boolean)=>{const previous=drag;if(!previous)return;drag=null;delete element.dataset.resizing;try{if(element.hasPointerCapture(previous.id))element.releasePointerCapture(previous.id);}finally{if(cancel)options.resize(previous.desired);else options.commit?.(previous.last);}};
 const refresh=()=>{if(disposed)return;let range=current(),enabled=range.enabled&&range.max>range.min;if(!enabled&&drag){release(true);range=current();enabled=range.enabled&&range.max>range.min;}element.setAttribute('role','separator');element.setAttribute('aria-orientation',vertical?'vertical':'horizontal');element.setAttribute('aria-controls',options.controls);element.setAttribute('aria-label',options.label);element.setAttribute('aria-valuemin',String(range.min));element.setAttribute('aria-valuemax',String(range.max));element.setAttribute('aria-valuenow',String(range.value));element.setAttribute('aria-valuetext',`${Math.round(range.value*100)/100} pixels`);element.setAttribute('aria-disabled',String(!enabled));element.tabIndex=enabled?0:-1;};
 const apply=(value:number)=>{const range=current(),next=clamp(value,range.min,range.max);options.resize(next);refresh();return next;};
 const down=(event:PointerEvent)=>{if(disposed||drag||!event.isPrimary||event.button!==0)return;const target=event.target as Element|null;if(target!==element&&target&&typeof target.closest==='function'&&target.closest('input,textarea,select,button,[contenteditable]'))return;const range=current();if(!range.enabled||range.min===range.max)return;const coordinate=vertical?event.clientX:event.clientY;if(!Number.isFinite(coordinate))return;const desired=options.desired?.()??range.value;if(!Number.isFinite(desired))throw new Error('WORKSPACE_SEPARATOR: finite desired start required');drag={id:event.pointerId,coordinate,value:range.value,desired,last:range.value};try{element.setPointerCapture(event.pointerId);}catch(error){drag=null;throw error;}element.dataset.resizing='true';element.focus({preventScroll:true});event.preventDefault();};
 const move=(event:PointerEvent)=>{if(!drag||event.pointerId!==drag.id)return;const coordinate=vertical?event.clientX:event.clientY;if(!Number.isFinite(coordinate))return;drag.last=apply(drag.value+(coordinate-drag.coordinate)*direction);event.preventDefault();};
 const up=(event:PointerEvent)=>{if(drag?.id!==event.pointerId)return;release(false);refresh();};
 const cancel=(event:PointerEvent)=>{if(drag?.id!==event.pointerId)return;release(true);refresh();};
 const blur=()=>{release(true);refresh();};
 const key=(event:KeyboardEvent)=>{if(event.target!==element||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='Escape'&&drag){event.preventDefault();release(true);refresh();return;}const range=current();if(!range.enabled||range.min===range.max)return;const amount=event.shiftKey?coarse:step,delta=vertical?(event.key==='ArrowRight'?direction*amount:event.key==='ArrowLeft'?-direction*amount:null):(event.key==='ArrowDown'?-amount:event.key==='ArrowUp'?amount:null);const next=event.key==='Home'?range.min:event.key==='End'?range.max:delta===null?null:range.value+delta;if(next===null)return;event.preventDefault();const desired=apply(next);options.commit?.(desired);};
 element.style.touchAction='none';element.addEventListener('pointerdown',down);element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',cancel);element.addEventListener('lostpointercapture',cancel);element.addEventListener('keydown',key);events?.addEventListener('blur',blur);refresh();
 return {refresh,dispose(){if(disposed)return;release(true);disposed=true;element.removeEventListener('pointerdown',down);element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',cancel);element.removeEventListener('lostpointercapture',cancel);element.removeEventListener('keydown',key);events?.removeEventListener('blur',blur);element.style.touchAction=touchAction;element.tabIndex=tabIndex;for(const [key,value]of saved)if(value===null)element.removeAttribute(key);else element.setAttribute(key,value);}};
}
/** Use a native modal dialog for collapsed panels: focus containment/Escape belong to the browser.
 * The trigger remains outside the collapsed panel; closing returns focus to that trigger. */
export function bindWorkspaceDrawer(options:{trigger:HTMLButtonElement;drawer:HTMLDialogElement;label:string;close?:HTMLButtonElement}):()=>void {
 const {trigger,drawer}=options;if(!drawer.id||!options.label)throw new Error('WORKSPACE_DRAWER: named dialog and trigger required');let opened=false;
 trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls',drawer.id);trigger.setAttribute('aria-expanded',String(drawer.open));if(!drawer.getAttribute('aria-label')&&!drawer.getAttribute('aria-labelledby'))drawer.setAttribute('aria-label',options.label);
 const close=()=>{if(drawer.open)drawer.close();closed();};const toggle=()=>{if(drawer.open){close();return;}drawer.showModal();opened=true;trigger.setAttribute('aria-expanded','true');};const closed=()=>{trigger.setAttribute('aria-expanded','false');if(opened){opened=false;trigger.focus({preventScroll:true});}};
 trigger.addEventListener('click',toggle);drawer.addEventListener('close',closed);options.close?.addEventListener('click',close);
 return ()=>{if(opened)close();trigger.removeEventListener('click',toggle);drawer.removeEventListener('close',closed);options.close?.removeEventListener('click',close);};
}
export const inspectorTabs=['view','rig','playback','feedback'] as const;
export type InspectorTab=typeof inspectorTabs[number];
export interface InspectorScrollOffset {x:number;y:number}
export type InspectorScrollSnapshot=Partial<Record<InspectorTab,InspectorScrollOffset>>;
export interface ScrollScheduler {request(callback:()=>void):number;cancel(handle:number):void}
const validTab=(tab:string):tab is InspectorTab=>inspectorTabs.includes(tab as InspectorTab);
export function parseInspectorScroll(value:unknown):InspectorScrollSnapshot {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INSPECTOR_SCROLL: expected tab object');const result:InspectorScrollSnapshot={};
 for(const [tab,raw]of Object.entries(value)){if(!validTab(tab)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('INSPECTOR_SCROLL: unknown tab or malformed offset');const o=raw as Record<string,unknown>;if(Object.keys(o).some(key=>key!=='x'&&key!=='y')||![o.x,o.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=10000000))throw new Error('INSPECTOR_SCROLL: finite nonnegative x/y <=10000000 required');result[tab]={x:o.x as number,y:o.y as number};}return result;
}
const scrollScheduler:ScrollScheduler={request:callback=>typeof requestAnimationFrame==='function'?requestAnimationFrame(callback):Number(setTimeout(callback,0)),cancel:handle=>typeof cancelAnimationFrame==='function'?cancelAnimationFrame(handle):clearTimeout(handle)};
/** One instance per source draft. Capture BEFORE hiding a tab; restore AFTER activation.
 * Two frame boundaries settle layout, and later content can explicitly restore again.
 * Clamping never overwrites the remembered desired offsets with a temporary empty extent.
 * Programmatic scroll events are ignored through the following frame; explicit user input can capture with true. */
export class InspectorScrollMemory {
 private offsets:InspectorScrollSnapshot;private pending=new Map<InspectorTab,number>();private disposed=false;
 constructor(initial:InspectorScrollSnapshot={},private readonly scheduler:ScrollScheduler=scrollScheduler){this.offsets=parseInspectorScroll(initial);}
 snapshot():InspectorScrollSnapshot{return parseInspectorScroll(this.offsets);}
 replace(value:unknown):void {const next=parseInspectorScroll(value);for(const handle of this.pending.values())this.scheduler.cancel(handle);this.pending.clear();this.offsets=next;}
 restoring(tab:InspectorTab):boolean{return this.pending.has(tab);}
 capture(tab:InspectorTab,panel:Pick<HTMLElement,'scrollLeft'|'scrollTop'>,userInitiated=false):void {if(this.disposed||this.pending.has(tab)&&!userInitiated)return;if(!validTab(tab))throw new Error('INSPECTOR_SCROLL: unknown tab');const handle=this.pending.get(tab);if(handle!==undefined)this.scheduler.cancel(handle);this.pending.delete(tab);const offset={x:Math.max(0,panel.scrollLeft),y:Math.max(0,panel.scrollTop)};this.offsets={...this.offsets,...parseInspectorScroll({[tab]:offset})};}
 restore(tab:InspectorTab,panel:Pick<HTMLElement,'scrollLeft'|'scrollTop'|'scrollWidth'|'scrollHeight'|'clientWidth'|'clientHeight'>):()=>void {
  if(this.disposed)return ()=>{};if(!validTab(tab))throw new Error('INSPECTOR_SCROLL: unknown tab');const previous=this.pending.get(tab);if(previous!==undefined)this.scheduler.cancel(previous);let cancelled=false;
  let handle=0;const apply=()=>{if(cancelled||this.disposed||this.pending.get(tab)!==handle)return;this.pending.delete(tab);if(![panel.scrollWidth,panel.scrollHeight,panel.clientWidth,panel.clientHeight].every(n=>Number.isFinite(n)&&n>=0))throw new Error('INSPECTOR_SCROLL_LAYOUT: finite nonnegative extents required');const offset=this.offsets[tab]??{x:0,y:0};panel.scrollLeft=clamp(offset.x,0,Math.max(0,panel.scrollWidth-panel.clientWidth));panel.scrollTop=clamp(offset.y,0,Math.max(0,panel.scrollHeight-panel.clientHeight));handle=this.scheduler.request(()=>{if(this.pending.get(tab)===handle)this.pending.delete(tab);});this.pending.set(tab,handle);};
  handle=this.scheduler.request(()=>{if(cancelled||this.disposed||this.pending.get(tab)!==handle)return;handle=this.scheduler.request(apply);this.pending.set(tab,handle);});this.pending.set(tab,handle);
  return ()=>{cancelled=true;this.scheduler.cancel(handle);if(this.pending.get(tab)===handle)this.pending.delete(tab);};
 }
 dispose():void {if(this.disposed)return;this.disposed=true;for(const handle of this.pending.values())this.scheduler.cancel(handle);this.pending.clear();}
}
