import {bindInspectorTabs,panelMake,actionButton,type InspectorTabs,type InspectorTabRow} from './view-controls.ts';
import {tr,onLanguageChange,setSourceText,setSourceAttribute} from './i18n.ts';
/** Inspector block row: the sticky row at the top of each Inspector section (index.html `.block-row`) is a WAI-ARIA
 * tablist. Each `role=tab` button owns the `role=tabpanel` block its `aria-controls` names; selecting it shows that
 * block alone and hides the others with `hidden`, so one block is on screen at a time and nothing scrolls between them.
 * A tab may carry blocks that belong to its group (`data-block-includes`, e.g. Transport's Angle block): those keep
 * their own `hidden` for their own reasons and are hidden with the group by `data-block-hidden` instead. Arrow keys,
 * Home and End move between tabs and select as they go (the pattern compare.html's Inspector tabs follow).
 * Hiding writes nothing inside a block, so a hidden block keeps whatever it held. Each block keeps its own scroll
 * offset for the session; the section's saved offset stays with the Inspector scroll memory. The active tab per
 * section is the only thing this adds to the inspection draft (its `ui` record, key `inspectorBlocks`). */
export const inspectorBlocksKey='inspectorBlocks';
export type ActiveBlocks=Record<string,string>;
type DraftUI=Record<string,string|number|null>;
const sectionName=/^[a-z][a-z0-9-]{0,31}$/,blockId=/^[a-z][a-z0-9-]{0,63}$/;
/** Parse a saved value; anything malformed restores as no selection rather than refusing the draft. */
export function parseActiveBlocks(value:unknown):ActiveBlocks {
 if(typeof value!=='string')return {};let raw:unknown;try{raw=JSON.parse(value);}catch{return {};}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};const result:ActiveBlocks={};
 for(const [section,id]of Object.entries(raw as Record<string,unknown>))if(sectionName.test(section)&&typeof id==='string'&&blockId.test(id))result[section]=id;
 return result;
}
/** The draft `ui` entry for the active blocks. */
export function activeBlocksUI(state:ActiveBlocks):DraftUI {return {[inspectorBlocksKey]:JSON.stringify(state)};}
/** The active blocks read back from a draft `ui` record. */
export function restoreActiveBlocksUI(ui:DraftUI):ActiveBlocks {return parseActiveBlocks(ui[inspectorBlocksKey]);}

export interface InspectorBlocksOptions {
 /** Sections carrying `data-inspector-panel`, each with a `.block-row` first child (or a child panel that has one). */
 sections:HTMLElement[];
 /** Subject capabilities hide inapplicable existing tabs before binding keyboard navigation. */
 available?:readonly string[];
 /** Called when a click or a key changes a section's active tab. */
 changed?:()=>void;
 /** The rig reuses its block rows in the heading, with one programmatic Comments selection. */
 bottom?:{strip:HTMLElement;comment:HTMLButtonElement;panel:HTMLElement};
}
export interface InspectorBlocks {state():ActiveBlocks;restore(state:ActiveBlocks):void;select(section:string,id:string):void;activate(section:string):void;register(tab:{id:string;panel:HTMLElement;label:string;position?:'first'|'last'}):()=>void;dispose():void}

interface Tab {button:HTMLButtonElement;id:string;panel:HTMLElement;included:HTMLElement[]}
const isRow=(node:Element)=>node.classList.contains('block-row');
function bindPopupMenu(id:string,items:()=>HTMLButtonElement[],cleanups:(()=>void)[],place?:(menu:HTMLElement)=>void):{button:HTMLButtonElement;menu:HTMLElement;close:(focus?:boolean)=>void} {
 const button=actionButton('⋯',null),menu=panelMake('div',{id,hidden:true}),listen=(node:HTMLElement,type:string,fn:(event:Event)=>void)=>{node.addEventListener(type,fn);cleanups.push(()=>node.removeEventListener(type,fn));};
 button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-controls',id);button.setAttribute('aria-expanded','false');menu.setAttribute('role','menu');
 const close=(focus=true)=>{menu.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();};
 const open=(last=false)=>{const visible=items();if(!visible.length)return;const list=visible.filter(item=>!item.disabled);menu.hidden=false;place?.(menu);button.setAttribute('aria-expanded','true');if(list.length)list[last?list.length-1:0]!.focus();else{menu.tabIndex=-1;menu.focus();}};
 listen(button,'click',()=>menu.hidden?open():close());
 listen(button,'keydown',event=>{const key=(event as KeyboardEvent).key;if(['ArrowDown','ArrowUp','Enter',' '].includes(key)){event.preventDefault();open(key==='ArrowUp');}else if(key==='Escape'){event.preventDefault();close();}});
 listen(menu,'keydown',event=>{const key=(event as KeyboardEvent).key,list=items().filter(item=>!item.disabled);if(key==='Escape'){event.preventDefault();close();}else if(['ArrowDown','ArrowUp','Home','End'].includes(key)&&list.length){event.preventDefault();const index=list.indexOf(event.target as HTMLButtonElement);list[key==='Home'?0:key==='End'?list.length-1:(index+(key==='ArrowDown'?1:list.length-1))%list.length]!.focus();}});
 listen(menu,'focusout',event=>{const target=(event as FocusEvent).relatedTarget;if(target!==button&&!menu.contains(target as Node|null))close(false);});
 return {button,menu,close};
}

export function bindInspectorBlocks(options:InspectorBlocksOptions):InspectorBlocks {
 const rows=new Map<string,InspectorTabs>(),ids=new Map<string,Set<string>>(),cleanups:(()=>void)[]=[];
 const definitions=new Map<string,{section:HTMLElement;row:HTMLElement;scrollRoot:HTMLElement;tabs:Tab[];syncOverflow:()=>void}>(),saved:ActiveBlocks={};
 const external=new Set<string>();
 let active:string|undefined;
 let disposedState:ActiveBlocks|undefined;
 const state=()=>disposedState??Object.fromEntries([...rows].map(([name,row])=>[name,row.state()!]));
 // A saved id from before #258 named the Transport block by its old id.
 const resolve=(name:string,id:string)=>id==='transport'&&!ids.get(name)?.has(id)?'motion-tools':id;
 for(const section of options.sections){
  const name=section.dataset.inspectorPanel??'';if(!name)continue;
  // In Animate the row heads the section directly and switches the whole panel body.
  const children=[...section.children],directRow=children.find(isRow) as HTMLElement|undefined;
  const scrollRoot=directRow?section:children.find(node=>[...node.children].some(isRow)) as HTMLElement|undefined;if(!scrollRoot)continue;
  const row=directRow??[...scrollRoot.children].find(isRow) as HTMLElement;
  const doc=section.ownerDocument,inside=(id:string)=>{const node=id?doc.getElementById(id):null;return node&&scrollRoot.contains(node)?node:null;};
  const tabs:Tab[]=[];
  for(const button of row.querySelectorAll<HTMLButtonElement>('button[data-block-target]')){
   const id=button.dataset.blockTarget??'',panel=inside(id);if(!panel)continue;
   const included=(button.dataset.blockIncludes??'').split(' ').map(inside).filter((node):node is HTMLElement=>!!node);
   if(options.available&&!options.available.includes(id)){button.hidden=true;button.disabled=true;panel.hidden=true;for(const node of included)node.toggleAttribute('data-block-hidden',true);continue;}
   tabs.push({button,id,panel,included});
  }
  if(!tabs.length&&!options.bottom)continue;
  if(options.bottom){
   let syncOverflow=()=>{};
   if(typeof (doc as Document).createElement==='function'&&tabs.length){
    const placeOverflow=(menu:HTMLElement)=>{
     if(typeof row.getBoundingClientRect!=='function')return;
     const rect=row.getBoundingClientRect(),inspector=row.closest('.inspector'),main=section.closest('main')?.getBoundingClientRect(),bounds=inspector?.getBoundingClientRect();
     // A collapsed inspector retains its heading, not a clipping body.
     const clip=inspector?.getAttribute('data-collapsed')==='true'||!bounds?.height?main:bounds,above=Math.max(0,rect.top-Math.max(clip?.top??0,main?.top??0)-8),below=Math.max(0,Math.min(innerHeight,clip?.bottom??innerHeight,main?.bottom??innerHeight)-rect.bottom-8);
     const up=below<Math.min(menu.scrollHeight,220)&&above>below,height=Math.min(220,up?above:below);menu.dataset.side=up?'above':'below';menu.style.maxHeight=height+'px';
     // Keep the popup in viewport coordinates when native focus scrolls its items.
     menu.style.position='fixed';menu.style.right=Math.max(0,innerWidth-rect.right)+'px';menu.style.top=(up?rect.top-4-Math.min(menu.scrollHeight,height):rect.bottom+4)+'px';menu.style.bottom='auto';
    };
    const items:HTMLButtonElement[]=[],more=bindPopupMenu('workspace-tabs-more-'+name,()=>{syncOverflow();return items.filter(item=>!item.hidden);},cleanups,placeOverflow);
    more.button.className='workspace-tabs-more';more.button.hidden=true;more.menu.className='workspace-tabs-menu';
    const updateItems=()=>{
    for(const item of items.splice(0))item.remove();
    for(const tab of tabs){
     const item=actionButton(tab.button.textContent??'',()=>{more.close(false);rows.get(name)?.select(tab.id);syncOverflow();tab.button.focus();});
     item.setAttribute('role','menuitem');item.dataset.blockMoreTarget=tab.id;item.tabIndex=-1;item.hidden=true;items.push(item);more.menu.append(item);
    }
    };updateItems();
    row.append(more.button,more.menu);
    syncOverflow=()=>{
     if(items.length!==tabs.length)updateItems();
     const label=tr('More tabs');more.button.setAttribute('aria-label',label);more.button.setAttribute('title',label);
     for(const tab of tabs)tab.button.removeAttribute('data-tab-overflow');
     if(row.hidden||!(row.clientWidth>0)){more.button.hidden=true;more.close(false);return;}
     more.button.hidden=false;
     const availableWidth=row.getBoundingClientRect?.().width??row.clientWidth,gap=4,moreWidth=(more.button.getBoundingClientRect?.().width??more.button.offsetWidth??28)+gap,widths=tabs.map(tab=>tab.button.getBoundingClientRect?.().width??tab.button.offsetWidth);
     if(widths.reduce((sum,w,i)=>sum+w+(i>0?gap:0),0)<=availableWidth){more.button.hidden=true;more.close(false);return;}
     const selectedIndex=tabs.findIndex(tab=>tab.button.getAttribute('aria-selected')==='true'),visible=new Set<number>();
     let used=moreWidth+(selectedIndex>=0?widths[selectedIndex]!+gap:0);if(selectedIndex>=0)visible.add(selectedIndex);
     for(let i=0;i<tabs.length;i++)if(i!==selectedIndex){if(used+widths[i]!+gap<=availableWidth){visible.add(i);used+=widths[i]!+gap;}}
     for(const [i,tab]of tabs.entries()){const over=!visible.has(i);if(over)tab.button.setAttribute('data-tab-overflow','true');items[i]!.hidden=!over;items[i]!.disabled=tab.button.disabled;items[i]!.textContent=tab.button.textContent;const title=tab.button.getAttribute('title');if(title)items[i]!.setAttribute('title',title);else items[i]!.removeAttribute('title');}
     if(!more.menu.hidden)placeOverflow(more.menu);
    };
   }
   definitions.set(name,{section,row,scrollRoot,tabs,syncOverflow});saved[name]=tabs.find(tab=>tab.button.getAttribute('aria-selected')==='true')?.id??tabs[0]?.id??'feedback';
   row.hidden=true;options.bottom.strip.append(row);continue;
  }
  ids.set(name,new Set(tabs.map(tab=>tab.id)));
  rows.set(name,bindInspectorTabs(()=>options.changed?.(),()=>{},{
   tabs:tabs.map(tab=>({id:tab.id,button:tab.button,panels:[tab.panel],included:tab.included,attribute:'aria-selected'})),
   panels:tabs.map(tab=>tab.panel),root:row,scrollRoot,initialize:true,
  }));
 }
 const syncActiveOverflow=()=>{if(active)definitions.get(active)?.syncOverflow();};
 if(options.bottom&& [...definitions.values()].some(d=>typeof (d.section.ownerDocument as Document).createElement==='function')){
  cleanups.push(onLanguageChange(syncActiveOverflow));
  if(typeof ResizeObserver==='function'){const ro=new ResizeObserver(syncActiveOverflow);ro.observe(options.bottom.strip);cleanups.push(()=>ro.disconnect());}
 }
 // Rebind the existing tab controller when the header mode changes. The shared Comments
 // button/panel retain identity; each mode retains its own last selected block.
 const activate=(name:string,force=false)=>{
  if(!options.bottom||!definitions.has(name))return;
  if(active===name&&!force)return;
  if(active){saved[active]=rows.get(active)?.state()??saved[active]!;rows.get(active)?.dispose();rows.delete(active);definitions.get(active)!.row.hidden=true;}
  active=name;const {section,row,scrollRoot,tabs,syncOverflow}=definitions.get(name)!,bottom=options.bottom;
  bottom.comment.dataset.blockTarget='feedback';bottom.comment.hidden=true;bottom.comment.remove();row.hidden=false;
  const all=[...tabs,{button:bottom.comment,id:'feedback',panel:bottom.panel,included:[]}];
  ids.set(name,new Set(all.map(tab=>tab.id)));
  const sync=()=>{section.dataset.comments=String(rows.get(name)?.state()==='feedback'||external.has(rows.get(name)?.state()??''));syncOverflow();options.changed?.();};
  for(const tab of all)tab.button.setAttribute('aria-selected',String(tab.id===saved[name]));
  rows.set(name,bindInspectorTabs(sync,()=>{},{tabs:all.map(tab=>({id:tab.id,button:tab.button,panels:[tab.panel],included:tab.included,attribute:'aria-selected'})),panels:all.map(tab=>tab.panel),root:row,scrollRoot,initialize:true}));
  section.dataset.comments=String(saved[name]==='feedback'||external.has(saved[name]!));
  for(const tab of tabs)if(external.has(tab.id))tab.panel.setAttribute('aria-labelledby',tab.button.id);syncOverflow();
 };
 if(options.bottom)activate(options.sections[0]?.dataset.inspectorPanel??'');
 return {
  state:()=>({...saved,...state()}),activate,
  register(tab){
   if(!options.bottom||external.has(tab.id))return ()=>{};
   external.add(tab.id);tab.panel.hidden=true;tab.panel.setAttribute('role','tabpanel');
   const buttons:HTMLButtonElement[]=[];
   for(const [name,definition]of definitions){
    const button=actionButton(tr(tab.label),null);button.id='inspector-tab-'+name+'-'+tab.id;
    button.dataset.blockTarget=tab.id;button.setAttribute('role','tab');button.setAttribute('aria-controls',tab.panel.id);button.setAttribute('aria-selected','false');button.tabIndex=-1;
    definition.row.insertBefore(button,tab.position==='first'?definition.tabs[0]?.button??null:definition.row.querySelector('.workspace-tabs-more'));buttons.push(button);
    const entry={button,id:tab.id,panel:tab.panel,included:[]};
    if(tab.position==='first')definition.tabs.unshift(entry);else definition.tabs.push(entry);
   }
   const localize=onLanguageChange(()=>{for(const button of buttons)setSourceText(button,tab.label);syncActiveOverflow();});
   if(active)activate(active,true);
   let removed=false;
   const remove=()=>{if(removed)return;removed=true;localize();external.delete(tab.id);
    for(const [name,definition]of definitions){definition.tabs.splice(definition.tabs.findIndex(item=>item.id===tab.id),1);if(rows.get(name)?.state()===tab.id)rows.get(name)?.select(definition.tabs[0]?.id??'feedback');if(saved[name]===tab.id)saved[name]=definition.tabs[0]?.id??'feedback';}
    for(const button of buttons)button.remove();tab.panel.hidden=true;if(active)activate(active,true);
   };
   cleanups.push(remove);return remove;
  },
  select:(name,id)=>{rows.get(name)?.select(resolve(name,id));definitions.get(name)?.syncOverflow();},
  /** Restore saved tabs without touching the workspace's section scroll offset. */
  restore(value){for(const [name,id]of Object.entries(value)){if(options.bottom){const definition=definitions.get(name);if(id==='feedback'||definition?.tabs.some(tab=>tab.id===resolve(name,id)))saved[name]=resolve(name,id);}rows.get(name)?.restore(resolve(name,id));definitions.get(name)?.syncOverflow();}},
  dispose(){disposedState=state();for(const cleanup of cleanups)cleanup();for(const row of rows.values())row.dispose();rows.clear();ids.clear();},
 };
}

/** Compose the real rig acts into C6; all fields, submit nodes and their listeners retain identity. */
export function mountRigInspector(root:Document=document,actHome?:HTMLElement):BottomPanel&{actBar:ActBar;answersRendered:boolean;syncActRow:()=>void;comments:{button:HTMLButtonElement;panel:HTMLElement}} {
 const inspector=root.querySelector<HTMLElement>('.inspector')!,body=inspector.querySelector<HTMLElement>('.inspector-body')!,heading=inspector.querySelector<HTMLElement>('.inspector-heading')!;
 const feedback=root.getElementById('inspector-feedback')!,dialog=root.getElementById('review-dialog')!;
 const [label,status,actions]=[feedback.querySelector<HTMLLabelElement>('label[for="review-status"]')!,root.getElementById('review-status')!,dialog.querySelector<HTMLElement>('.review-dialog-actions')!];
 const actBar=mountActBar({id:'workspace-review-act',decision:[label,status],actions,submit:root.getElementById('save') as HTMLButtonElement,saveState:root.getElementById('review-draft-state')!,saveStateCopies:[root.getElementById(actHome?'dirty':'draft-state')].flatMap(node=>node?[{node,title:true}]:[])}),act=actBar.element;
 if(actHome)for(const id of ['draft-state','draft-recovery'])root.getElementById(id)!.hidden=true;
 const title=dialog.querySelector<HTMLElement>('.review-dialog-header')!;title.querySelector('#review-dialog-close')?.remove();
 feedback.className='workspace-review-panel';feedback.hidden=true;feedback.prepend(title);body.append(feedback);dialog.remove();
 feedback.removeAttribute('data-inspector-panel');
 root.getElementById('proposal-panel')!.prepend(root.getElementById('comments-list-host')!);
 const bottom=mountBottomPanel({kind:'rig',heading,act,actHome:actHome??heading,tabs:[]}),comment=actionButton(tr('Comments'),null);
 comment.hidden=true;feedback.setAttribute('role','region');feedback.setAttribute('aria-labelledby','stage-comment');
 delete comment.dataset.inspector;bottom.strip.removeAttribute('role');
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-mode][data-inspector]')){button.id||='mode-'+button.dataset.mode;const panel=root.getElementById('inspector-'+button.dataset.mode)!;panel.setAttribute('role','region');panel.setAttribute('aria-labelledby',button.id);}
 bottom.row={tabs:[...root.querySelectorAll<HTMLButtonElement>('[data-mode][data-inspector]')].map(button=>({id:button.dataset.mode!,button,attribute:'aria-pressed',panels:[root.getElementById('inspector-'+button.dataset.mode)!]})),panels:[root.getElementById('inspector-rig')!,root.getElementById('inspector-playback')!],initialize:true};
 bottom.actHome.append(act);
 const syncActRow=()=>{
  if(!actHome)return;
  const headline=root.getElementById('workspace-ask-headline'),error=root.getElementById('review-message');
  const question=!!headline&&!headline.hidden&&!!headline.textContent?.trim();
  const refusal=!!error&&!error.hidden&&error.classList.contains('error')&&!!error.textContent?.trim()&&['save','request-changes','workspace-pending-ask'].every(id=>root.getElementById(id)?.hidden!==false);
  // Loading may render answers before the question; an early read refusal can
  // still use this row once its caller has hidden every answer control.
  actHome.hidden=act.hidden||(!question&&!refusal);root.getElementById('dirty')!.hidden=!actHome.hidden;
 };
 return {...bottom,actBar,answersRendered:false,syncActRow,comments:{button:comment,panel:feedback}};
}

export interface BottomPanel {
 row:InspectorTabRow;strip:HTMLElement;act:HTMLElement;actHome:HTMLElement;collapse:HTMLButtonElement;kind:string;
}
export interface BottomPanelOptions {
 kind:string;
 tabs:{id:string;label:string;panel:HTMLElement}[];
 /** Only the supplied heading is replaced; sibling columns and panel layout remain screen-owned. */
 heading:HTMLElement;
 act:HTMLElement;
 actHome:HTMLElement;
}
/** Build C6 once from screen-owned tabs and act nodes, independently of the rig dialog. */
export function mountBottomPanel(options:BottomPanelOptions):BottomPanel {
 const strip=panelMake('nav',{className:'workspace-bottom-tabs'});strip.setAttribute('role','tablist');strip.setAttribute('aria-label',tr('Inspection controls'));
 const tabs=options.tabs.map(({id,label,panel},index)=>{
  const button=actionButton(tr(label),null);button.id='workspace-tab-'+id;button.dataset.inspector=id;button.setAttribute('role','tab');button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-selected',String(index===0));button.tabIndex=index===0?0:-1;
  panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
  strip.append(button);return {id,button,panels:[panel],attribute:'aria-selected' as const};
 });
 const collapseLabel=tr('Collapse bottom panel'),collapse=actionButton('⌄',null);collapse.id='workspace-bottom-collapse';collapse.setAttribute('aria-expanded','true');collapse.setAttribute('aria-controls','workspace-inspector');collapse.setAttribute('aria-label',collapseLabel);collapse.setAttribute('title',collapseLabel);
 options.heading.replaceChildren(strip,collapse);
 return {row:{tabs,panels:tabs.flatMap(tab=>tab.panels),initialize:true},strip,act:options.act,actHome:options.actHome,collapse,kind:options.kind};
}


export interface ActBarOptions {
 id:string;
 decision?:HTMLElement[];
 /** Reuse a screen's action group without replacing any of its nodes. */
 actions?:HTMLElement;
 submit:HTMLButtonElement;
 /** Omit for an existing button whose text is owned by the screen. */
 submitLabel?:string|(()=>string);
 saveState:HTMLElement;
 /** Other nodes that show the same save state (the C11 footer copy); `title` repeats the text as a tooltip. */
 saveStateCopies?:{node:HTMLElement;title?:boolean}[];
 overflow?:{label:string;handler:()=>void}[];
}
/** C10 save state: one model for every screen. `text` and the retry label are English source text the caller owns. */
export type ActSaveKind='saved'|'unsaved'|'saving'|'failed'|'read-only';
export interface ActSaveState {kind:ActSaveKind;text:string;retry?:{label:string;run:()=>void};/** Diagnostic hover (a refusal code and its origin), untranslated. */title?:string}
export interface ActBar {element:HTMLElement;refresh():void;dispose():void;setSaveState(state:ActSaveState):void;saveState():ActSaveState|null}
/** C10: screen-owned decision, submit and save state, with an optional shared action menu. */
export function mountActBar(options:ActBarOptions):ActBar {
 const actions=options.actions??panelMake('div',{className:'review-dialog-actions'},options.saveState,options.submit);
 const element=panelMake('div',{className:'workspace-act-bar',id:options.id},...(options.decision??[]),actions);
 const cleanups:(()=>void)[]=[],labels:{button:HTMLButtonElement;label:string}[]=[];
 const listen=(node:HTMLElement,type:string,fn:(event:Event)=>void)=>{node.addEventListener(type,fn);cleanups.push(()=>node.removeEventListener(type,fn));};
 if(options.overflow?.length){
  const items:HTMLButtonElement[]=[],more=bindPopupMenu(options.id+'-menu',()=>items,cleanups);
  for(const action of options.overflow){
   const item=actionButton(tr(action.label),null);item.setAttribute('role','menuitem');item.tabIndex=-1;
   listen(item,'click',()=>{more.close();action.handler();});labels.push({button:item,label:action.label});more.menu.append(item);items.push(item);
  }
  // Item listeners own activation; events from the sibling popup never trigger submit.
  actions.append(more.button,more.menu);labels.push({button:more.button,label:'More act actions'});
 }
 const refresh=()=>{
  if(options.submitLabel!==undefined)options.submit.textContent=tr(typeof options.submitLabel==='function'?options.submitLabel():options.submitLabel);
  for(const {button,label}of labels)if(label==='More act actions')button.setAttribute('aria-label',tr(label));else button.textContent=tr(label);
 };
 refresh();const off=options.submitLabel!==undefined||labels.length?onLanguageChange(refresh):()=>{};
 let current:ActSaveState|null=null,retry:HTMLButtonElement|null=null;
 /** The one renderer: kind as data, the same text in the act node and its copies, a retry action only when failed. */
 const setSaveState=(state:ActSaveState)=>{
  const titled=current?.title;current={...state};options.saveState.dataset.saveState=state.kind;setSourceText(options.saveState,state.text);
  if(state.title)options.saveState.setAttribute('title',state.title);else if(titled)options.saveState.removeAttribute('title');
  for(const copy of options.saveStateCopies??[]){copy.node.dataset.saveState=state.kind;setSourceText(copy.node,state.text);if(copy.title)setSourceAttribute(copy.node,'title',state.text);}
  const action=state.kind==='failed'?state.retry:undefined;
  if(action&&!retry){retry=actionButton('',()=>{const run=current?.kind==='failed'?current.retry?.run:undefined;run?.();});retry.className='act-save-retry';options.saveState.after(retry);}
  if(retry){retry.hidden=!action;if(action)setSourceText(retry,action.label);}
 };
 return {element,refresh,setSaveState,saveState:()=>current&&{...current},dispose(){off();for(const cleanup of cleanups)cleanup();retry?.remove();retry=null;}};
}
