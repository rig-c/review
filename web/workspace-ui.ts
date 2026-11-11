/** Browser workspace presentation. Source selection, player clocks and review decisions stay with the page. */
import {WorkspacePreferenceStore,panelBounds,type WorkspaceLanguage,type WorkspacePanels,type WorkspacePreferences,type WorkspaceTheme} from './workspace-preferences.ts';
import {allocateWorkspaceLayout,bindWorkspaceSeparator,bindWorkspaceDrawer,defaultWorkspaceColumns,InspectorScrollMemory,inspectorTabs,workspaceMinimums,type InspectorTab,type WorkspaceColumns,type WorkspacePanel,type SeparatorRange} from './workspace-layout.ts';
import {bindDomI18n,getLinkLanguage,setLanguagePreference,setLinkLanguage,tr} from './i18n.ts';
import {panelMake,actionButton,labelledControl} from './view-controls.ts';

export interface WorkspaceStatusBarOptions {
 message:HTMLElement|string;readouts:readonly HTMLElement[];source?:HTMLElement;
}
/** One C11 DOM constructor; screens supply their existing readout and source nodes. */
export function mountStatusBar(options:WorkspaceStatusBarOptions):{footer:HTMLElement;message:HTMLElement} {
 const message=typeof options.message==='string'?panelMake('span',{id:'message',className:'status-message',textContent:options.message}):options.message;
 message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 const readouts=panelMake('div',{className:'status-readouts'},...options.readouts);readouts.setAttribute('aria-label','Status');
 const footer=panelMake('footer',{className:'status-bar'},message,readouts);
 if(options.source)footer.append(options.source);
 return {footer,message};
}

export type WorkspaceHeaderCompatibility = 'rigStep1'|'legacyPartsStep2'|'legacyInterviewStep4'|'legacyJobStep5'|'legacyHubStep6'|'legacyOwnerStep6';
export interface WorkspaceHeaderOptions {
 compatibility:WorkspaceHeaderCompatibility;embedded?:boolean;title?:string;revision?:string;
 /** Optional A/B build picker placed beside the header mode switch when a second build is supplied. */
 buildPicker?:HTMLElement;
}
export interface WorkspaceHeader {
 header:HTMLElement;title:HTMLElement;subtitle:HTMLElement|null;modeSwitch:HTMLElement|null;dirty:HTMLElement|null;
 stages:HTMLElement|null;status:HTMLParagraphElement|null;language:HTMLSelectElement|null;languageLabel:HTMLLabelElement|null;
 dispose:()=>void;
}
/** One C1 construction path; the finite legacy choices expire at their named screen migrations. */
export function mountWorkspaceShell(options:WorkspaceHeaderOptions):WorkspaceHeader {
 const kind=options.compatibility,rig=kind==='rigStep1',parts=kind==='legacyPartsStep2',interview=kind==='legacyInterviewStep4',job=kind==='legacyJobStep5',hub=kind==='legacyHubStep6',owner=kind==='legacyOwnerStep6';
 const branded=rig||parts,settingsLanguage=rig;
 const header=panelMake('header');
 const headerClass=rig?'topbar':parts?'pv-top':job?'job-header':hub?'hub-header':owner?'owner-header':null;
 if(headerClass)header.className=headerClass;
 if(branded){
  const brand=panelMake('div',{className:parts?'pv-brand':'brand'});
  const mark=panelMake('span',{className:parts?'pv-mark':'brand-mark'},'r');
  brand.append(mark,'rig review');
  header.append(brand);
 }
 const title=panelMake(rig||parts?'strong':'h1');
 const titleId=rig?'package-title':parts?'pv-title':null;
 if(titleId)title.id=titleId;
 title.textContent=options.title??(rig?'Review package':parts?'Parts review':'');
 if(job)title.dataset.jobText='job.title';
 let subtitle:HTMLElement|null=null;
 if(branded){
  subtitle=panelMake('span',{id:rig?'revision':'pv-mode',className:rig?'subtle':'pv-subtle',textContent:options.revision??''});
  const identity=panelMake('div',{},title,...(parts?[' ']:[]),subtitle);header.append(identity);
 }else{if(interview)header.append('\n    ');header.append(title);}
 let modeSwitch:HTMLElement|null=null,dirty:HTMLElement|null=null;
 if(rig){
  modeSwitch=panelMake('div',{className:'mode-switch'});
  modeSwitch.setAttribute('role','group');modeSwitch.setAttribute('aria-label','Mode');
  for(const [mode,label] of [['rig','Setup'],['playback','Animate'],['compare','Compare']] as const){
   const button=actionButton(label,null);button.dataset.mode=mode;button.setAttribute('aria-pressed',String(mode==='rig'));
   if(mode==='compare'){button.disabled=true;button.title='No second build supplied: reopen with --compare <built> --reference <video>';}
   else{button.dataset.inspector=mode;button.setAttribute('aria-controls','inspector-'+mode);}
   modeSwitch.append(button);
  }
  header.append(modeSwitch);
  if(options.buildPicker)header.append(options.buildPicker);
  dirty=panelMake('span',{id:'dirty',className:'subtle',textContent:'Loading…'});header.append(panelMake('div',{className:'top-actions'},dirty));
 }
 let stages:HTMLElement|null=null,status:HTMLParagraphElement|null=null;
 if(branded||interview){
  stages=panelMake('nav');stages.dataset.stageNav='';
  if(branded){stages.className='review-stage-nav';stages.setAttribute('aria-label','Inspection stages');}
  if(interview)header.append('\n    ');header.append(stages);
 }
 if(hub||owner){status=panelMake('p',{className:hub?'hub-status':'owner-status'});status.setAttribute('role','status');header.append(status);}
 let language:HTMLSelectElement|null=null,languageLabel:HTMLLabelElement|null=null;
 if(!parts){
  language=panelMake('select');
  if(settingsLanguage){language.id='settings-language';language.dataset.appPreference='';}
  for(const value of settingsLanguage?['system','en','ko']:['en','ko']){
   const text=settingsLanguage?(value==='system'?'System':value==='en'?'English':'한국어'):interview?(value==='en'?'English':'한국어'):job?value:'';
   language.append(panelMake('option',{value,textContent:text}));
  }
  if(settingsLanguage){languageLabel=labelledControl('Language ',language);header.append(languageLabel);}
  else{if(interview)header.append('\n    ');header.append(language);if(interview)header.append('\n  ');}
 }
 if(options.embedded){if(rig||parts)header.hidden=true;else if(interview)language!.hidden=true;}
 return {header,title,subtitle,modeSwitch,dirty,stages,status,language,languageLabel,dispose(){header.remove();languageLabel?.remove();}};
}

/** Reachable effective bounds, accounting for the other panel's saved desired size. */
export function workspaceResizeRange(available:{width:number;height:number},desired:WorkspacePanels,panel:WorkspacePanel,columns:WorkspaceColumns=defaultWorkspaceColumns):SeparatorRange {
 const base=allocateWorkspaceLayout(available,desired,columns),range=base.separators[panel];if(!range.enabled)return range;
 const low=allocateWorkspaceLayout(available,{...desired,[panel]:panelBounds[panel].min},columns)[panel],high=allocateWorkspaceLayout(available,{...desired,[panel]:panelBounds[panel].max},columns)[panel];
 return {min:low,max:high,value:base[panel],enabled:high>low};
}
/** Invert the allocator instead of storing an already-clamped pixel value as a desktop desire. */
export function workspaceResizeTarget(available:{width:number;height:number},desired:WorkspacePanels,panel:WorkspacePanel,target:number,columns:WorkspaceColumns=defaultWorkspaceColumns):number {
 const range=workspaceResizeRange(available,desired,panel,columns);if(!range.enabled)return desired[panel];
 if(target<=range.min)return panelBounds[panel].min;if(target>=range.max)return panelBounds[panel].max;
 let low:number=panelBounds[panel].min,high:number=panelBounds[panel].max;
 for(let i=0;i<48;i++){const mid=(low+high)/2,value=allocateWorkspaceLayout(available,{...desired,[panel]:mid},columns)[panel];if(value<target)low=mid;else high=mid;}
 return (low+high)/2;
}
/** The selected Inspector section name, from either a selected tab or a pressed header selector. */
export function selectedInspector(root:Pick<Document,'querySelector'>=document):string|undefined {
 return root.querySelector<HTMLElement>('[data-inspector][aria-selected=true],[data-inspector][aria-pressed=true]')?.dataset.inspector;
}
export interface WorkspaceUI {
 defaults:()=>WorkspacePreferences;beforeTab:()=>void;afterTab:()=>void;scroll:()=>string;restoreScroll:(value:unknown)=>void;
 revealInspector:()=>void;refresh:()=>void;dispose:()=>void;
}
/** Caller-owned shell regions. The left preference may retain a migrated screen's saved width. */
export interface WorkspaceRegions {
 layout:HTMLElement;left:HTMLElement;main:HTMLElement;stage:HTMLElement;bottom:HTMLElement;right?:HTMLElement;
 columns?:WorkspaceColumns;
}
/** `currentTheme`, when given, is the appearance the Settings theme select shows; otherwise it shows the saved default. */
export function bindWorkspaceUI(options:{regions?:WorkspaceRegions;changed:()=>void;defaultTheme:(theme:WorkspaceTheme)=>void;currentTheme?:()=>WorkspaceTheme|undefined;language?:HTMLSelectElement;bottomPanel?:{kind:string;strip:HTMLElement;act:HTMLElement;actHome:HTMLElement;collapse:HTMLButtonElement}}):WorkspaceUI {
 const require=<T extends HTMLElement=HTMLElement>(id:string)=>{const node=document.getElementById(id);if(!node)throw new Error('Missing workspace element: '+id);return node as T;};
 const regions=options.regions,layout=regions?.layout??document.querySelector<HTMLElement>('.layout')!,main=regions?.main??layout.querySelector<HTMLElement>('main')!,stage=regions?.stage??require('stage-layout'),inspector=regions?.bottom??document.querySelector<HTMLElement>('.inspector')!,explorer=regions?regions.right:document.getElementById('parts-explorer');
 layout.classList.add('workspace-layout');
 let left=regions?.left??layout.querySelector<HTMLElement>('.left-panel');if(!left){left=document.createElement('aside');left.className='left-panel';left.innerHTML='<h2>INPUTS</h2><p class="hint">A and B retain their fixed source bindings. The reference video and shared animation are named above the stage.</p>';layout.prepend(left);}left.id='workspace-left';inspector.id='workspace-inspector';
 // A parts explorer placed inside the left column makes that column the explorer: it keeps the explorer's
 // saved width and the page has no right column. Otherwise sources stay left and the explorer stays right.
 const explorerLeft=regions?regions.columns?.left==='rightWidth'&&!regions.right:!!explorer&&left.contains(explorer),columns:WorkspaceColumns=regions?.columns??(explorerLeft?{left:'rightWidth',right:null}:explorer?defaultWorkspaceColumns:{left:'leftWidth',right:null});
 // A section is an Inspector panel only while it carries data-inspector-panel; the review page's Feedback
 // section lives in the review dialog instead and keeps its id without being a panel.
 const tabs=inspectorTabs.filter(tab=>document.getElementById('inspector-'+tab)?.dataset.inspectorPanel===tab);if(!tabs.length&&!regions)throw new Error('Missing workspace element: inspector-'+inspectorTabs.join('|inspector-'));
 // The left column is a fixed header row (a leading `.left-header`, when the page has one) and one scrolling
 // body holding everything else, Settings included: the body is the column's only scroll container.
 const header=[...left.children].find(node=>node.className.split(' ').includes('left-header'))??null;
 const sourceList=document.createElement('div');sourceList.className='workspace-sources';sourceList.append(...[...left.childNodes].filter(node=>node!==header));left.append(sourceList);
 const settings=document.createElement('section');settings.className='workspace-settings';settings.setAttribute('aria-label','Settings');
 // The header holds the expand/collapse control; the body is hidden while collapsed (a workspace preference, default collapsed).
 const settingsHeader=document.createElement('h2'),settingsToggle=document.createElement('button'),settingsBody=document.createElement('div');settingsHeader.className='sticky-header settings-header';settingsToggle.type='button';settingsToggle.id='settings-toggle';settingsToggle.className='settings-toggle';settingsToggle.textContent='Settings';settingsToggle.setAttribute('aria-controls','settings-body');settingsBody.id='settings-body';settingsBody.className='settings-body';settingsHeader.append(settingsToggle);settings.append(settingsHeader,settingsBody);
 settingsBody.innerHTML='<label>Theme <select id="settings-theme" data-app-preference><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label><input id="settings-sync" data-app-preference type="checkbox">Sync cameras by default</label><label><input id="settings-idle" data-app-preference type="checkbox">Repeat idle by default</label><button id="settings-reset" type="button">Reset layout</button><p class="hint">Defaults apply to new inspections. Links and source drafts retain their explicit view.</p><p id="settings-state" class="hint" role="status"></p>';
 const sharedLanguage=options.language??require<HTMLSelectElement>('settings-language');
 if(!sharedLanguage.closest('header'))settingsBody.firstElementChild!.after(sharedLanguage.parentElement!);
 sourceList.append(settings);
 const theme=require<HTMLSelectElement>('settings-theme'),language=sharedLanguage,sync=require<HTMLInputElement>('settings-sync'),idle=require<HTMLInputElement>('settings-idle'),status=require('settings-state');
 const store=new WorkspacePreferenceStore({onStatus:value=>{status.textContent=tr(value.detail);}});let desired={...store.get().panels};
 const stack=document.createElement('div');stack.className='workspace-stage-stack';for(const child of [...main.children])if(child!==inspector)stack.append(child);main.prepend(stack);
 const triggers=document.createElement('div');triggers.className='workspace-drawer-triggers';triggers.setAttribute('aria-label','Workspace panels');stack.prepend(triggers);
 const panels:Partial<Record<WorkspacePanel,HTMLElement>>={};if(columns.left)panels[columns.left]=left;if(columns.right&&explorer)panels[columns.right]=explorer;panels.inspectorHeight=inspector;
 const sides:Partial<Record<WorkspacePanel,'left'|'right'>>={};if(columns.left)sides[columns.left]='left';if(columns.right&&explorer)sides[columns.right]='right';
 const labels:Record<WorkspacePanel,string>=explorerLeft?{leftWidth:'Sources and settings',rightWidth:'Parts and settings',inspectorHeight:'Inspector'}:{leftWidth:'Sources and settings',rightWidth:'Parts explorer',inspectorHeight:'Inspector'};
 const handles={} as Record<WorkspacePanel,HTMLElement>,dialogs={} as Record<WorkspacePanel,HTMLDialogElement>,buttons={} as Record<WorkspacePanel,HTMLButtonElement>,disposers:(()=>void)[]=[];
 const present=Object.keys(panels) as WorkspacePanel[],node=(panel:WorkspacePanel)=>panels[panel]!;
 for(const panel of present){
  const handle=document.createElement('div');handle.className='workspace-separator workspace-'+panel+(sides[panel]?' workspace-side-'+sides[panel]:'');handles[panel]=handle;
  if(sides[panel]==='left')node(panel).after(handle);else if(sides[panel]==='right')node(panel).before(handle);else inspector.before(handle);
  const trigger=document.createElement('button');trigger.type='button';trigger.textContent=labels[panel];trigger.hidden=true;triggers.append(trigger);buttons[panel]=trigger;
  const dialog=document.createElement('dialog');dialog.className='workspace-drawer';dialog.id='workspace-drawer-'+panel;dialog.dataset.panel=panel;const close=document.createElement('button');close.type='button';close.textContent='Close '+labels[panel];close.className='workspace-drawer-close';
  // The drawer's header stays above its scrolling panel: title and the close action.
  const header=document.createElement('div');header.className='sticky-header workspace-drawer-header';const title=document.createElement('span');title.textContent=labels[panel];header.append(title,close);dialog.append(header);document.body.append(dialog);dialogs[panel]=dialog;
  disposers.push(bindWorkspaceDrawer({trigger,drawer:dialog,label:labels[panel],close}));
 }
 const bottom=options.bottomPanel,bottomBody=bottom?inspector.querySelector<HTMLElement>('.inspector-body')!:null,bottomHeading=bottom?bottom.strip.parentElement!:null;
 const bottomCollapseKey=bottom?`rig-review-bottom-collapsed/${bottom.kind}`:'';
 let collapsed=false;
 if(bottom){try{collapsed=localStorage.getItem(bottomCollapseKey)==='true';}catch{}}
 const memory=new InspectorScrollMemory();const active=():InspectorTab=>{const tab=selectedInspector() as InspectorTab|undefined;return tab&&tabs.includes(tab)?tab:tabs[0]!;};
 let disposed=false,frame=0,applying=false,available={width:0,height:0},effective=allocateWorkspaceLayout(available,desired,columns);
 const panelFor=(tab:InspectorTab)=>{const section=require('inspector-'+tab);return (typeof section.querySelector==='function'?section.querySelector<HTMLElement>('.animate-blocks-panel'):null)??section;};
 const userByTab=new Map<InspectorTab,boolean>(),extentByTab=new Map<InspectorTab,string>(),extentOf=(panel:HTMLElement)=>`${panel.scrollWidth}:${panel.scrollHeight}:${panel.clientWidth}:${panel.clientHeight}`;
 const capture=()=>{if(!tabs.length)return;const tab=active(),section=require('inspector-'+tab),panel=panelFor(tab),saved=memory.snapshot()[tab];if(!section.hidden&&(!saved||saved.x<=Math.max(0,panel.scrollWidth-panel.clientWidth)&&saved.y<=Math.max(0,panel.scrollHeight-panel.clientHeight)))memory.capture(tab,panel,false);};
 const restore=()=>{if(disposed||!tabs.length)return;const tab=active(),panel=panelFor(tab);if(panel.clientWidth>0||panel.clientHeight>0)extentByTab.set(tab,extentOf(panel));memory.restore(tab,panel);};
 const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(()=>{frame=0;apply();});};
 const dock=(panel:WorkspacePanel,drawer:boolean)=>{
  const element=node(panel),dialog=dialogs[panel],trigger=buttons[panel];trigger.hidden=!drawer;handles[panel].hidden=drawer;
  if(bottom&&panel==='inspectorHeight'){
   trigger.hidden=true;handles[panel].hidden=drawer||collapsed;
   if(!drawer&&dialog.open)dialog.close();
   const target=drawer?dialog:inspector;if(bottomBody!.parentElement!==target)target.append(bottomBody!);return;
  }
  if(drawer&&element.parentElement!==dialog){const focus=element.contains(document.activeElement);dialog.append(element);if(focus)trigger.focus({preventScroll:true});}
  if(!drawer&&element.parentElement===dialog){const focused=element.contains(document.activeElement)||document.activeElement===trigger;if(dialog.open)dialog.close();trigger.setAttribute('aria-expanded','false');if(sides[panel]==='left')layout.prepend(element);else if(sides[panel]==='right')layout.append(element);else main.append(element);if(focused){element.tabIndex=-1;element.focus({preventScroll:true});}}
 };
 const bindings=present.map(panel=>bindWorkspaceSeparator({element:handles[panel],panel,...(sides[panel]?{side:sides[panel]}:{}),controls:node(panel).id,label:'Resize '+labels[panel],range:()=>workspaceResizeRange(available,desired,panel,columns),resolveDesired:value=>workspaceResizeTarget(available,desired,panel,value,columns),desired:()=>desired[panel],resize:value=>{desired={...desired,[panel]:value};apply();},commit:value=>store.update({panels:{[panel]:value}})}));
 function apply():void {
  if(disposed||applying)return;applying=true;
  try{
   // Chrome shares the center width. It is not charged against the actual stage minimum.
   // Authored JSON can fill the same slot as the rig while Direction metadata stays above it.
   const chrome=[...stack.children].filter(node=>node!==stage&&node.id!=='direction-authored-body'&&!((node as HTMLElement).hidden)).reduce((sum,node)=>sum+(node as HTMLElement).getBoundingClientRect().height,0);
   available={width:Math.max(0,layout.clientWidth),height:Math.max(0,layout.clientHeight-chrome)};effective=allocateWorkspaceLayout(available,desired,columns);
   const mode=(panel:WorkspacePanel)=>effective[panel==='leftWidth'?'leftMode':panel==='rightWidth'?'rightMode':'inspectorMode'];
   for(const panel of present)dock(panel,mode(panel)==='drawer');
   const gap=workspaceMinimums.separator,side=(key:WorkspaceColumns['left'])=>key&&mode(key)==='panel'?{width:effective[key],separator:gap}:{width:0,separator:0},l=side(columns.left),r=side(columns.right);
   layout.style.setProperty('--workspace-columns',`${l.width}px ${l.separator}px minmax(0,1fr) ${r.separator}px ${r.width}px`);
   let bottomHeight=effective.inspectorHeight;
   if(bottom){
    const compact=collapsed||effective.inspectorMode==='drawer';bottomBody!.hidden=collapsed;
    const actTarget=compact&&!dialogs.inspectorHeight.open?bottomHeading!:bottom.actHome;if(bottom.act.parentElement!==actTarget)actTarget.append(bottom.act);
    inspector.dataset.collapsed=String(compact);bottom.collapse.setAttribute('aria-expanded',String(!collapsed));bottom.collapse.textContent=tr(collapsed?'Expand bottom panel':'Collapse bottom panel');
    if(compact)bottomHeight=bottomHeading!.getBoundingClientRect().height;
   }
   main.style.gridTemplateRows=`minmax(0,1fr) ${effective.inspectorMode==='panel'&&!collapsed?gap:0}px ${bottomHeight}px`;
   layout.dataset.stageMinimum=String(effective.stageMinimumSatisfied);for(const binding of bindings)binding.refresh();options.changed();restore();
  }finally{applying=false;}
 }
 const renderSettings=()=>{const value=store.get();setLanguagePreference(value.language);settingsToggle.setAttribute('aria-expanded',String(!value.settingsCollapsed));settingsBody.hidden=value.settingsCollapsed;settings.dataset.collapsed=String(value.settingsCollapsed);theme.value=options.currentTheme?.()??value.theme;language.value=getLinkLanguage()??value.language;sync.checked=value.defaultCameraSync;idle.checked=value.defaultIdleRepeat;status.textContent=tr(store.status().detail);};
 const revealInspector=()=>{
  if(bottom&&collapsed){collapsed=false;try{localStorage.setItem(bottomCollapseKey,'false');}catch{}apply();}
  if(effective.inspectorMode==='drawer'&&!dialogs.inspectorHeight.open){for(const dialog of Object.values(dialogs))if(dialog.open)dialog.close();buttons.inspectorHeight.click();if(bottom)apply();}
 };
 if(bottom){
  const closed=()=>{if(disposed)return;apply();bottom.strip.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus({preventScroll:true});};
  dialogs.inspectorHeight.addEventListener('close',closed);
  bottom.collapse.onclick=()=>{capture();collapsed=!collapsed;try{localStorage.setItem(bottomCollapseKey,String(collapsed));}catch{}if(dialogs.inspectorHeight.open)dialogs.inspectorHeight.close();apply();if(!collapsed)revealInspector();};
  disposers.push(()=>{bottom.collapse.onclick=null;dialogs.inspectorHeight.removeEventListener('close',closed);});
 }
 theme.onchange=()=>{store.update({theme:theme.value as WorkspaceTheme});options.defaultTheme(store.get().theme);};language.onchange=()=>{setLinkLanguage(null);store.update({language:language.value as WorkspaceLanguage});setLanguagePreference(store.get().language);};sync.onchange=()=>{store.update({defaultCameraSync:sync.checked});};idle.onchange=()=>{store.update({defaultIdleRepeat:idle.checked});};require<HTMLButtonElement>('settings-reset').onclick=()=>store.resetLayout();settingsToggle.onclick=()=>{store.update({settingsCollapsed:!store.get().settingsCollapsed});};
 bindDomI18n(document);const unsubscribe=store.subscribe(value=>{desired={...value.panels};renderSettings();schedule();});renderSettings();
 for(const tab of tabs){
  const panel=panelFor(tab);let timer:ReturnType<typeof setTimeout>|undefined;
  const intent=()=>{userByTab.set(tab,true);if(timer)clearTimeout(timer);timer=setTimeout(()=>{userByTab.set(tab,false);},600);};const scrolled=()=>{
   if(!userByTab.get(tab))return;const saved=memory.snapshot()[tab]??{x:0,y:0};
   const expected={x:Math.min(saved.x,Math.max(0,panel.scrollWidth-panel.clientWidth)),y:Math.min(saved.y,Math.max(0,panel.scrollHeight-panel.clientHeight))};
   // Scroll steps precede animation frames. An actual new user offset may cancel
   // a queued restore; the restore's own expected clamp must retain its desire.
   if(panel.scrollLeft!==expected.x||panel.scrollTop!==expected.y)memory.capture(tab,panel,true);
  };
  for(const type of ['wheel','pointerdown','touchstart','keydown','click'])panel.addEventListener(type,intent,{passive:true,capture:true});panel.addEventListener('scroll',scrolled,{passive:true});
  const content=new MutationObserver(()=>{if(panel.clientWidth<=0&&panel.clientHeight<=0)return;const next=extentOf(panel);if(next!==extentByTab.get(tab)){extentByTab.set(tab,next);if(tab===active())restore();}});content.observe(panel,{childList:true,subtree:true});
  disposers.push(()=>{if(timer)clearTimeout(timer);for(const type of ['wheel','pointerdown','touchstart','keydown','click'])panel.removeEventListener(type,intent,{capture:true});panel.removeEventListener('scroll',scrolled);content.disconnect();});
 }
 const observer=new ResizeObserver(schedule);observer.observe(layout);for(const node of [...stack.children])if(node!==stage)observer.observe(node);for(const tab of tabs)observer.observe(panelFor(tab));
 const resumed=()=>{if(!document.hidden)store.refresh();};document.addEventListener('visibilitychange',resumed);schedule();
 return {defaults:()=>store.get(),beforeTab:capture,afterTab:restore,scroll:()=>{capture();return JSON.stringify(memory.snapshot());},restoreScroll(value){if(typeof value!=='string')return;memory.replace(JSON.parse(value));restore();},revealInspector,refresh:schedule,
  dispose(){if(disposed)return;capture();disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('visibilitychange',resumed);unsubscribe();for(const binding of bindings)binding.dispose();for(const dispose of disposers)dispose();memory.dispose();store.dispose();}
 };
}
