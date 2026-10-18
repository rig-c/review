/** Local inspection controls; these never write source or review state. */
export type ThemePreference = 'system' | 'dark' | 'light';
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

export function bindAppearance(control:HTMLSelectElement,initial:ThemePreference='system'):{get:()=>ThemePreference;set:(value:ThemePreference)=>void;dispose:()=>void} {
 let current=themePreference(initial);
 const system=matchMedia('(prefers-color-scheme: light)');
 const render=()=>{document.documentElement.dataset.theme=current==='system'?(system.matches?'light':'dark'):current;control.value=current;};
 // Actual inspection changes are transient. Workspace Settings owns saved defaults.
 const set=(value:ThemePreference)=>{current=themePreference(value);render();};
 const change=()=>set(themePreference(control.value));control.addEventListener('change',change);system.addEventListener('change',render);render();
 return {get:()=>current,set,dispose:()=>{control.removeEventListener('change',change);system.removeEventListener('change',render);}};
}
export function syncStageLayout(area:Pick<HTMLElement,'clientWidth'|'clientHeight'|'dataset'>):boolean {const next=stageOrientation(area.clientWidth,area.clientHeight);if(area.dataset.orientation===next)return false;area.dataset.orientation=next;return true;}
export function bindStageLayout(area:HTMLElement,changed:()=>void):()=>void {
 const render=()=>{if(syncStageLayout(area))changed();};
 const observer=new ResizeObserver(render);observer.observe(area);render();return ()=>observer.disconnect();
}
// Nested or separately disposed pan binders must not restore another binder's override.
const panVideoOverrides=new WeakMap<HTMLVideoElement,{owners:number;value:string;priority:string}>();
export function bindPan(viewport:HTMLElement,move:(dx:number,dy:number)=>void,enabled:()=>boolean=()=>true):()=>void {
 let pointer:number|null=null,x=0,y=0,space=false;
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
 const releasePointer=()=>{const id=pointer;pointer=null;delete viewport.dataset.panning;if(id!==null&&viewport.hasPointerCapture(id))viewport.releasePointerCapture(id);};
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&enabled()&&!(event.target instanceof Element&&event.target.closest('input,textarea,select,button'))){
  if(!space){space=true;syncVideos();observer.observe(viewport,{childList:true,subtree:true,attributes:true,attributeFilter:['controls']});}event.preventDefault();
 }};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')releaseSpace();};const blur=()=>{releaseSpace();releasePointer();};
 const start=(event:PointerEvent)=>{if(!enabled()||!event.isPrimary||event.button!==0)return;const target=event.target;if(target instanceof Element&&(target.closest('button,input,select,textarea,a')||target.closest('video[controls]')&&!space))return;pointer=event.pointerId;x=event.clientX;y=event.clientY;viewport.setPointerCapture(pointer);viewport.dataset.panning='true';event.preventDefault();};
 const drag=(event:PointerEvent)=>{if(event.pointerId!==pointer)return;const dx=event.clientX-x,dy=event.clientY-y;x=event.clientX;y=event.clientY;move(dx,dy);event.preventDefault();};
 const end=(event:PointerEvent)=>{if(event.pointerId===pointer)releasePointer();};
 const native=(event:DragEvent)=>event.preventDefault();
 window.addEventListener('blur',blur);document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);viewport.addEventListener('pointerdown',start);viewport.addEventListener('pointermove',drag);viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);viewport.addEventListener('lostpointercapture',end);viewport.addEventListener('dragstart',native);
 return ()=>{blur();window.removeEventListener('blur',blur);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);viewport.removeEventListener('pointerdown',start);viewport.removeEventListener('pointermove',drag);viewport.removeEventListener('pointerup',end);viewport.removeEventListener('pointercancel',end);viewport.removeEventListener('lostpointercapture',end);viewport.removeEventListener('dragstart',native);};
}

export function bindInspectorTabs(changed:()=>void,beforeChange:()=>void=()=>{}):void {
 const tabs=[...document.querySelectorAll<HTMLButtonElement>('[data-inspector]')];
 const activate=(tab:HTMLButtonElement)=>{beforeChange();for(const item of tabs){const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;}for(const panel of document.querySelectorAll<HTMLElement>('[data-inspector-panel]'))panel.hidden=panel.dataset.inspectorPanel!==tab.dataset.inspector;changed();};
 for(const [index,tab] of tabs.entries()){tab.onclick=()=>activate(tab);tab.onkeydown=event=>{const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next===null)return;event.preventDefault();const target=tabs[next];if(target){activate(target);target.focus();}};}
}
