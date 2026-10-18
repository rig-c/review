/** Browser workspace presentation. Source selection, player clocks and review decisions stay with the page. */
import {WorkspacePreferenceStore,panelBounds,type WorkspacePanels,type WorkspacePreferences,type WorkspaceTheme} from './workspace-preferences.ts';
import {allocateWorkspaceLayout,bindWorkspaceSeparator,bindWorkspaceDrawer,InspectorScrollMemory,inspectorTabs,type InspectorTab,type WorkspacePanel,type SeparatorRange} from './workspace-layout.ts';

/** Reachable effective bounds, accounting for the other panel's saved desired size. */
export function workspaceResizeRange(available:{width:number;height:number},desired:WorkspacePanels,panel:WorkspacePanel):SeparatorRange {
 const base=allocateWorkspaceLayout(available,desired),range=base.separators[panel];if(!range.enabled)return range;
 const low=allocateWorkspaceLayout(available,{...desired,[panel]:panelBounds[panel].min})[panel],high=allocateWorkspaceLayout(available,{...desired,[panel]:panelBounds[panel].max})[panel];
 return {min:low,max:high,value:base[panel],enabled:high>low};
}
/** Invert the allocator instead of storing an already-clamped pixel value as a desktop desire. */
export function workspaceResizeTarget(available:{width:number;height:number},desired:WorkspacePanels,panel:WorkspacePanel,target:number):number {
 const range=workspaceResizeRange(available,desired,panel);if(!range.enabled)return desired[panel];
 if(target<=range.min)return panelBounds[panel].min;if(target>=range.max)return panelBounds[panel].max;
 let low:number=panelBounds[panel].min,high:number=panelBounds[panel].max;
 for(let i=0;i<48;i++){const mid=(low+high)/2,value=allocateWorkspaceLayout(available,{...desired,[panel]:mid})[panel];if(value<target)low=mid;else high=mid;}
 return (low+high)/2;
}
export interface WorkspaceUI {
 defaults:()=>WorkspacePreferences;beforeTab:()=>void;afterTab:()=>void;scroll:()=>string;restoreScroll:(value:unknown)=>void;
 revealInspector:()=>void;refresh:()=>void;dispose:()=>void;
}
export function bindWorkspaceUI(options:{changed:()=>void;defaultTheme:(theme:WorkspaceTheme)=>void}):WorkspaceUI {
 const require=<T extends HTMLElement=HTMLElement>(id:string)=>{const node=document.getElementById(id);if(!node)throw new Error('Missing workspace element: '+id);return node as T;};
 const layout=document.querySelector<HTMLElement>('.layout')!,main=layout.querySelector<HTMLElement>('main')!,stage=require('stage-layout'),inspector=document.querySelector<HTMLElement>('.inspector')!,right=require('parts-explorer');
 layout.classList.add('workspace-layout');
 let left=layout.querySelector<HTMLElement>('.left-panel');if(!left){left=document.createElement('aside');left.className='left-panel';left.innerHTML='<h2>INPUTS</h2><p class="hint">A and B retain their fixed source bindings. The reference video and shared animation are named above the stage.</p>';layout.prepend(left);}left.id='workspace-left';inspector.id='workspace-inspector';
 const sourceList=document.createElement('div');sourceList.className='workspace-sources';sourceList.append(...left.childNodes);left.append(sourceList);
 const settings=document.createElement('section');settings.className='workspace-settings';settings.setAttribute('aria-label','Settings');
 settings.innerHTML='<h2>Settings</h2><label>Theme <select id="settings-theme" data-app-preference><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label><input id="settings-sync" data-app-preference type="checkbox">Sync cameras by default</label><label><input id="settings-idle" data-app-preference type="checkbox">Repeat idle by default</label><button id="settings-reset" type="button">Reset layout</button><p class="hint">Defaults apply to new inspections. Links and source drafts retain their explicit view.</p><p id="settings-state" class="hint" role="status"></p>';
 left.append(settings);
 const theme=require<HTMLSelectElement>('settings-theme'),sync=require<HTMLInputElement>('settings-sync'),idle=require<HTMLInputElement>('settings-idle'),status=require('settings-state');
 const store=new WorkspacePreferenceStore({onStatus:value=>{status.textContent=value.detail;}});let desired={...store.get().panels};
 const stack=document.createElement('div');stack.className='workspace-stage-stack';for(const child of [...main.children])if(child!==inspector)stack.append(child);main.prepend(stack);
 const triggers=document.createElement('div');triggers.className='workspace-drawer-triggers';triggers.setAttribute('aria-label','Workspace panels');stack.prepend(triggers);
 const panels:Record<WorkspacePanel,HTMLElement>={leftWidth:left,rightWidth:right,inspectorHeight:inspector};
 const labels:Record<WorkspacePanel,string>={leftWidth:'Sources and settings',rightWidth:'Parts explorer',inspectorHeight:'Inspector'};
 const handles={} as Record<WorkspacePanel,HTMLElement>,dialogs={} as Record<WorkspacePanel,HTMLDialogElement>,buttons={} as Record<WorkspacePanel,HTMLButtonElement>,disposers:(()=>void)[]=[];
 for(const panel of Object.keys(panels) as WorkspacePanel[]){
  const handle=document.createElement('div');handle.className='workspace-separator workspace-'+panel;handles[panel]=handle;
  if(panel==='leftWidth')left.after(handle);else if(panel==='rightWidth')right.before(handle);else inspector.before(handle);
  const trigger=document.createElement('button');trigger.type='button';trigger.textContent=labels[panel];trigger.hidden=true;triggers.append(trigger);buttons[panel]=trigger;
  const dialog=document.createElement('dialog');dialog.className='workspace-drawer';dialog.id='workspace-drawer-'+panel;dialog.dataset.panel=panel;const close=document.createElement('button');close.type='button';close.textContent='Close '+labels[panel];close.className='workspace-drawer-close';dialog.append(close);document.body.append(dialog);dialogs[panel]=dialog;
  disposers.push(bindWorkspaceDrawer({trigger,drawer:dialog,label:labels[panel],close}));
 }
 const memory=new InspectorScrollMemory();const active=():InspectorTab=>(document.querySelector<HTMLElement>('[data-inspector][aria-selected=true]')?.dataset.inspector as InspectorTab)??'view';
 let disposed=false,frame=0,applying=false,available={width:0,height:0},effective=allocateWorkspaceLayout(available,desired);
 const panelFor=(tab:InspectorTab)=>require('inspector-'+tab);
 const capture=()=>{const tab=active(),panel=panelFor(tab),saved=memory.snapshot()[tab];if(!panel.hidden&&(!saved||saved.x<=Math.max(0,panel.scrollWidth-panel.clientWidth)&&saved.y<=Math.max(0,panel.scrollHeight-panel.clientHeight)))memory.capture(tab,panel);};
 const restore=()=>{if(!disposed)memory.restore(active(),panelFor(active()));};
 const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(()=>{frame=0;apply();});};
 const dock=(panel:WorkspacePanel,drawer:boolean)=>{
  const node=panels[panel],dialog=dialogs[panel],trigger=buttons[panel];trigger.hidden=!drawer;handles[panel].hidden=drawer;
  if(drawer&&node.parentElement!==dialog){const focus=node.contains(document.activeElement);dialog.append(node);if(focus)trigger.focus({preventScroll:true});}
  if(!drawer&&node.parentElement===dialog){const focused=node.contains(document.activeElement)||document.activeElement===trigger;if(dialog.open)dialog.close();trigger.setAttribute('aria-expanded','false');if(panel==='leftWidth')layout.prepend(node);else if(panel==='rightWidth')layout.append(node);else main.append(node);if(focused){node.tabIndex=-1;node.focus({preventScroll:true});}}
 };
 const bindings=(Object.keys(panels) as WorkspacePanel[]).map(panel=>bindWorkspaceSeparator({element:handles[panel],panel,controls:panels[panel].id,label:'Resize '+labels[panel],range:()=>workspaceResizeRange(available,desired,panel),resolveDesired:value=>workspaceResizeTarget(available,desired,panel,value),desired:()=>desired[panel],resize:value=>{desired={...desired,[panel]:value};apply();},commit:value=>store.update({panels:{[panel]:value}})}));
 function apply():void {
  if(disposed||applying)return;applying=true;
  try{
   // Chrome shares the center width. It is not charged against the actual stage minimum.
   const chrome=[...stack.children].filter(node=>node!==stage&&!((node as HTMLElement).hidden)).reduce((sum,node)=>sum+(node as HTMLElement).getBoundingClientRect().height,0);
   available={width:Math.max(0,layout.clientWidth),height:Math.max(0,layout.clientHeight-chrome)};effective=allocateWorkspaceLayout(available,desired);
   for(const panel of Object.keys(panels) as WorkspacePanel[])dock(panel,effective[panel==='leftWidth'?'leftMode':panel==='rightWidth'?'rightMode':'inspectorMode']==='drawer');
   layout.style.setProperty('--workspace-columns',`${effective.leftWidth}px ${effective.leftMode==='panel'?8:0}px minmax(0,1fr) ${effective.rightMode==='panel'?8:0}px ${effective.rightWidth}px`);
   main.style.gridTemplateRows=`minmax(0,1fr) ${effective.inspectorMode==='panel'?8:0}px ${effective.inspectorHeight}px`;
   layout.dataset.stageMinimum=String(effective.stageMinimumSatisfied);for(const binding of bindings)binding.refresh();options.changed();restore();
  }finally{applying=false;}
 }
 const renderSettings=()=>{const value=store.get();theme.value=value.theme;sync.checked=value.defaultCameraSync;idle.checked=value.defaultIdleRepeat;status.textContent=store.status().detail;};
 theme.onchange=()=>{store.update({theme:theme.value as WorkspaceTheme});options.defaultTheme(store.get().theme);};sync.onchange=()=>{store.update({defaultCameraSync:sync.checked});};idle.onchange=()=>{store.update({defaultIdleRepeat:idle.checked});};require<HTMLButtonElement>('settings-reset').onclick=()=>store.resetLayout();
 const unsubscribe=store.subscribe(value=>{desired={...value.panels};renderSettings();schedule();});renderSettings();
 for(const tab of inspectorTabs){
  const panel=panelFor(tab);let user=false,timer:ReturnType<typeof setTimeout>|undefined;
  const intent=()=>{user=true;if(timer)clearTimeout(timer);timer=setTimeout(()=>{user=false;},600);};const scrolled=()=>{
   if(!user)return;const saved=memory.snapshot()[tab]??{x:0,y:0};
   const expected={x:Math.min(saved.x,Math.max(0,panel.scrollWidth-panel.clientWidth)),y:Math.min(saved.y,Math.max(0,panel.scrollHeight-panel.clientHeight))};
   // Scroll steps precede animation frames. An actual new user offset may cancel
   // a queued restore; the restore's own expected clamp must retain its desire.
   if(panel.scrollLeft!==expected.x||panel.scrollTop!==expected.y)memory.capture(tab,panel,true);
  };
  for(const type of ['wheel','pointerdown','touchstart','keydown'])panel.addEventListener(type,intent,{passive:true});panel.addEventListener('scroll',scrolled,{passive:true});
  let extent='';const content=new MutationObserver(()=>{const next=`${panel.scrollWidth}:${panel.scrollHeight}:${panel.clientWidth}:${panel.clientHeight}`;if(next!==extent){extent=next;if(tab===active())restore();}});content.observe(panel,{childList:true,subtree:true});
  disposers.push(()=>{if(timer)clearTimeout(timer);for(const type of ['wheel','pointerdown','touchstart','keydown'])panel.removeEventListener(type,intent);panel.removeEventListener('scroll',scrolled);content.disconnect();});
 }
 const observer=new ResizeObserver(schedule);observer.observe(layout);for(const node of [...stack.children])if(node!==stage)observer.observe(node);for(const tab of inspectorTabs)observer.observe(panelFor(tab));
 const resumed=()=>{if(!document.hidden)store.refresh();};document.addEventListener('visibilitychange',resumed);schedule();
 return {defaults:()=>store.get(),beforeTab:capture,afterTab:restore,scroll:()=>{capture();return JSON.stringify(memory.snapshot());},restoreScroll(value){if(typeof value!=='string')return;memory.replace(JSON.parse(value));restore();},revealInspector(){if(effective.inspectorMode==='drawer'&&!dialogs.inspectorHeight.open){for(const dialog of Object.values(dialogs))if(dialog.open)dialog.close();buttons.inspectorHeight.click();}},refresh:schedule,
  dispose(){if(disposed)return;capture();disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('visibilitychange',resumed);unsubscribe();for(const binding of bindings)binding.dispose();for(const dispose of disposers)dispose();memory.dispose();store.dispose();}
 };
}
