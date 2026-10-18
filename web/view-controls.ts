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

export function bindAppearance(control:HTMLSelectElement):{get:()=>ThemePreference;set:(value:ThemePreference)=>void;dispose:()=>void} {
 let current:ThemePreference='system';try{current=themePreference(localStorage.getItem('rig-review-appearance/1'));}catch{/* Storage is optional. */}
 const system=matchMedia('(prefers-color-scheme: light)');
 const render=()=>{document.documentElement.dataset.theme=current==='system'?(system.matches?'light':'dark'):current;control.value=current;};
 const set=(value:ThemePreference)=>{current=value;try{localStorage.setItem('rig-review-appearance/1',current);}catch{/* Storage is optional. */}render();};
 const change=()=>set(themePreference(control.value));control.addEventListener('change',change);system.addEventListener('change',render);render();
 return {get:()=>current,set,dispose:()=>{control.removeEventListener('change',change);system.removeEventListener('change',render);}};
}
export function syncStageLayout(area:Pick<HTMLElement,'clientWidth'|'clientHeight'|'dataset'>):boolean {const next=stageOrientation(area.clientWidth,area.clientHeight);if(area.dataset.orientation===next)return false;area.dataset.orientation=next;return true;}
export function bindStageLayout(area:HTMLElement,changed:()=>void):()=>void {
 const render=()=>{if(syncStageLayout(area))changed();};
 const observer=new ResizeObserver(render);observer.observe(area);render();return ()=>observer.disconnect();
}
export function bindPan(viewport:HTMLElement,move:(dx:number,dy:number)=>void,enabled:()=>boolean=()=>true):()=>void {
 let pointer:number|null=null,x=0,y=0,space=false;
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&!(event.target instanceof Element&&event.target.closest('input,textarea,select,button'))){space=true;event.preventDefault();}};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space=false;};const blur=()=>{space=false;pointer=null;delete viewport.dataset.panning;};
 const start=(event:PointerEvent)=>{if(!enabled()||!event.isPrimary||event.button!==0)return;const target=event.target;if(target instanceof Element&&(target.closest('button,input,select,textarea,a')||target.closest('video[controls]')&&!space))return;pointer=event.pointerId;x=event.clientX;y=event.clientY;viewport.setPointerCapture(pointer);viewport.dataset.panning='true';event.preventDefault();};
 const drag=(event:PointerEvent)=>{if(event.pointerId!==pointer)return;const dx=event.clientX-x,dy=event.clientY-y;x=event.clientX;y=event.clientY;move(dx,dy);event.preventDefault();};
 const end=(event:PointerEvent)=>{if(event.pointerId!==pointer)return;pointer=null;delete viewport.dataset.panning;if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);};
 const native=(event:DragEvent)=>event.preventDefault();
 window.addEventListener('blur',blur);document.addEventListener('keydown',keyDown);document.addEventListener('keyup',keyUp);viewport.addEventListener('pointerdown',start);viewport.addEventListener('pointermove',drag);viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);viewport.addEventListener('lostpointercapture',end);viewport.addEventListener('dragstart',native);
 return ()=>{window.removeEventListener('blur',blur);document.removeEventListener('keydown',keyDown);document.removeEventListener('keyup',keyUp);viewport.removeEventListener('pointerdown',start);viewport.removeEventListener('pointermove',drag);viewport.removeEventListener('pointerup',end);viewport.removeEventListener('pointercancel',end);viewport.removeEventListener('lostpointercapture',end);viewport.removeEventListener('dragstart',native);};
}

export function bindInspectorTabs(changed:()=>void):void {
 const tabs=[...document.querySelectorAll<HTMLButtonElement>('[data-inspector]')];
 const activate=(tab:HTMLButtonElement)=>{for(const item of tabs){const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;}for(const panel of document.querySelectorAll<HTMLElement>('[data-inspector-panel]'))panel.hidden=panel.dataset.inspectorPanel!==tab.dataset.inspector;changed();};
 for(const [index,tab] of tabs.entries()){tab.onclick=()=>activate(tab);tab.onkeydown=event=>{const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next===null)return;event.preventDefault();const target=tabs[next];if(target){activate(target);target.focus();}};}
}
