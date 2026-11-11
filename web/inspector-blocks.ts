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
 /** Called when a click or a key changes a section's active tab. */
 changed?:()=>void;
}
export interface InspectorBlocks {state():ActiveBlocks;restore(state:ActiveBlocks):void;select(section:string,id:string):void;dispose():void}

interface Tab {button:HTMLButtonElement;id:string;panel:HTMLElement;included:HTMLElement[]}
const isRow=(node:Element)=>node.classList.contains('block-row');

export function bindInspectorBlocks(options:InspectorBlocksOptions):InspectorBlocks {
 const rows=new Map<string,InspectorTabs>(),ids=new Map<string,Set<string>>();
 let disposedState:ActiveBlocks|undefined;
 const state=()=>disposedState??Object.fromEntries([...rows].map(([name,row])=>[name,row.state()!]));
 // A saved id from before #258 named the Transport block by its old id.
 const resolve=(name:string,id:string)=>id==='transport'&&!ids.get(name)?.has(id)?'motion-tools':id;
 for(const section of options.sections){
  const name=section.dataset.inspectorPanel??'';if(!name)continue;
  // In Animate the row heads the blocks panel beside the timeline; that panel is what scrolls.
  const children=[...section.children],directRow=children.find(isRow) as HTMLElement|undefined;
  const scrollRoot=directRow?section:children.find(node=>[...node.children].some(isRow)) as HTMLElement|undefined;if(!scrollRoot)continue;
  const row=directRow??[...scrollRoot.children].find(isRow) as HTMLElement;
  const doc=section.ownerDocument,inside=(id:string)=>{const node=id?doc.getElementById(id):null;return node&&scrollRoot.contains(node)?node:null;};
  const tabs:Tab[]=[];
  for(const button of row.querySelectorAll<HTMLButtonElement>('button[data-block-target]')){
   const id=button.dataset.blockTarget??'',panel=inside(id);if(!panel)continue;
   const included=(button.dataset.blockIncludes??'').split(' ').map(inside).filter((node):node is HTMLElement=>!!node);
   tabs.push({button,id,panel,included});
  }
  if(!tabs.length)continue;
  ids.set(name,new Set(tabs.map(tab=>tab.id)));
  rows.set(name,bindInspectorTabs(()=>options.changed?.(),()=>{},{
   tabs:tabs.map(tab=>({id:tab.id,button:tab.button,panels:[tab.panel],included:tab.included,attribute:'aria-selected'})),
   panels:tabs.map(tab=>tab.panel),root:row,scrollRoot,initialize:true,
  }));
 }
 return {
  state:()=>({...state()}),
  select:(name,id)=>{rows.get(name)?.select(resolve(name,id));},
  /** Restore saved tabs without touching the workspace's section scroll offset. */
  restore(saved){for(const [name,id]of Object.entries(saved))rows.get(name)?.restore(resolve(name,id));},
  dispose(){disposedState=state();for(const row of rows.values())row.dispose();rows.clear();ids.clear();},
 };
}

/** Compose the real rig acts into C6; all fields, submit nodes and their listeners retain identity. */
export function mountRigInspector(root:Document=document):BottomPanel&{actBar:ActBar} {
 const inspector=root.querySelector<HTMLElement>('.inspector')!,body=inspector.querySelector<HTMLElement>('.inspector-body')!,heading=inspector.querySelector<HTMLElement>('.inspector-heading')!;
 const feedback=root.getElementById('inspector-feedback')!,dialog=root.getElementById('review-dialog')!;
 const [label,status,actions]=[feedback.querySelector<HTMLLabelElement>('label[for="review-status"]')!,root.getElementById('review-status')!,dialog.querySelector<HTMLElement>('.review-dialog-actions')!];
 const actBar=mountActBar({id:'workspace-review-act',decision:[label,status],actions,submit:root.getElementById('save') as HTMLButtonElement,saveState:root.getElementById('review-draft-state')!,saveStateCopies:[root.getElementById('draft-state')].flatMap(node=>node?[{node,title:true}]:[])}),act=actBar.element;
 const title=dialog.querySelector<HTMLElement>('.review-dialog-header')!;title.querySelector('#review-dialog-close')?.remove();
 feedback.dataset.inspectorPanel='feedback';feedback.className='workspace-review-panel';feedback.hidden=true;feedback.prepend(title);feedback.append(act);body.append(feedback);dialog.remove();
 // Header modes retain inspection mode while Review is revealed; the bottom row alone owns panel selection.
 for(const mode of root.querySelectorAll<HTMLElement>('[data-mode]'))mode.removeAttribute('data-inspector');
 return {...mountBottomPanel({kind:'rig',heading,act,actHome:feedback,tabs:([{id:'rig',label:'Setup'},{id:'playback',label:'Animate'},{id:'feedback',label:'Write review'}]).map(tab=>({...tab,panel:root.getElementById('inspector-'+tab.id)!}))}),actBar};
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
 const collapse=actionButton(tr('Collapse bottom panel'),null);collapse.id='workspace-bottom-collapse';collapse.setAttribute('aria-expanded','true');collapse.setAttribute('aria-controls','workspace-inspector');
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
export interface ActSaveState {kind:ActSaveKind;text:string;retry?:{label:string;run:()=>void}}
export interface ActBar {element:HTMLElement;refresh():void;dispose():void;setSaveState(state:ActSaveState):void;saveState():ActSaveState|null}
/** C10: screen-owned decision, submit and save state, with an optional shared action menu. */
export function mountActBar(options:ActBarOptions):ActBar {
 const actions=options.actions??panelMake('div',{className:'review-dialog-actions'},options.saveState,options.submit);
 const element=panelMake('div',{className:'workspace-act-bar',id:options.id},...(options.decision??[]),actions);
 const cleanups:(()=>void)[]=[],labels:{button:HTMLButtonElement;label:string}[]=[];
 const listen=(node:HTMLElement,type:string,fn:(event:Event)=>void)=>{node.addEventListener(type,fn);cleanups.push(()=>node.removeEventListener(type,fn));};
 if(options.overflow?.length){
  const button=actionButton('⋯',null),menu=panelMake('div',{id:options.id+'-menu',hidden:true});
  button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-controls',menu.id);button.setAttribute('aria-expanded','false');
  menu.setAttribute('role','menu');
  const close=(focus=true)=>{menu.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();};
  const items=options.overflow.map(action=>{
   const item=actionButton(tr(action.label),null);item.setAttribute('role','menuitem');item.tabIndex=-1;
   listen(item,'click',()=>{close();action.handler();});labels.push({button:item,label:action.label});menu.append(item);return item;
  });
  const open=(last=false)=>{menu.hidden=false;button.setAttribute('aria-expanded','true');items[last?items.length-1:0]!.focus();};
  listen(button,'click',()=>menu.hidden?open():close());
  listen(button,'keydown',event=>{const key=(event as KeyboardEvent).key;if(['ArrowDown','ArrowUp','Enter',' '].includes(key)){event.preventDefault();open(key==='ArrowUp');}else if(key==='Escape'){event.preventDefault();close();}});
  listen(menu,'keydown',event=>{
   const key=(event as KeyboardEvent).key;
   if(key==='Escape'){event.preventDefault();close();return;}
   if(['ArrowDown','ArrowUp','Home','End'].includes(key)){event.preventDefault();const index=items.indexOf(event.target as HTMLButtonElement);items[key==='Home'?0:key==='End'?items.length-1:(index+(key==='ArrowDown'?1:items.length-1))%items.length]!.focus();}
  });
  listen(menu,'focusout',event=>{const target=(event as FocusEvent).relatedTarget;if(target!==button&&!menu.contains(target as Node|null))close(false);});
  // Item listeners own activation; events from the sibling popup never trigger submit.
  actions.append(button,menu);labels.push({button,label:'More act actions'});
 }
 const refresh=()=>{
  if(options.submitLabel!==undefined)options.submit.textContent=tr(typeof options.submitLabel==='function'?options.submitLabel():options.submitLabel);
  for(const {button,label}of labels)if(label==='More act actions')button.setAttribute('aria-label',tr(label));else button.textContent=tr(label);
 };
 refresh();const off=options.submitLabel!==undefined||labels.length?onLanguageChange(refresh):()=>{};
 let current:ActSaveState|null=null,retry:HTMLButtonElement|null=null;
 /** The one renderer: kind as data, the same text in the act node and its copies, a retry action only when failed. */
 const setSaveState=(state:ActSaveState)=>{
  current={...state};options.saveState.dataset.saveState=state.kind;setSourceText(options.saveState,state.text);
  for(const copy of options.saveStateCopies??[]){copy.node.dataset.saveState=state.kind;setSourceText(copy.node,state.text);if(copy.title)setSourceAttribute(copy.node,'title',state.text);}
  const action=state.kind==='failed'?state.retry:undefined;
  if(action&&!retry){retry=actionButton('',()=>{const run=current?.kind==='failed'?current.retry?.run:undefined;run?.();});retry.className='act-save-retry';options.saveState.after(retry);}
  if(retry){retry.hidden=!action;if(action)setSourceText(retry,action.label);}
 };
 return {element,refresh,setSaveState,saveState:()=>current&&{...current},dispose(){off();for(const cleanup of cleanups)cleanup();retry?.remove();retry=null;}};
}
