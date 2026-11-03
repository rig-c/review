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
interface Row {scrollRoot:HTMLElement;row:HTMLElement;tabs:Tab[];scrolls:Map<string,number>}
const isRow=(node:Element)=>node.classList.contains('block-row');

export function bindInspectorBlocks(options:InspectorBlocksOptions):InspectorBlocks {
 const disposers:(()=>void)[]=[],state:ActiveBlocks={},rows=new Map<string,Row>();
 // A saved id from before #258 named the Transport block by its old id.
 const resolve=(entry:Row,id:string)=>entry.tabs.find(tab=>tab.id===id)??(id==='transport'?entry.tabs.find(tab=>tab.id==='motion-tools'):undefined);
 /** Show one tab's panel and hide the rest. Writes only visibility and tab state, and only what changes. */
 const show=(entry:Row,active:Tab)=>{
  for(const tab of entry.tabs){
   const on=tab===active;
   if(tab.button.getAttribute('aria-selected')!==String(on))tab.button.setAttribute('aria-selected',String(on));
   if(tab.button.tabIndex!==(on?0:-1))tab.button.tabIndex=on?0:-1;
   if(tab.panel.hidden===on)tab.panel.hidden=!on;
   for(const node of tab.included)if(node.hasAttribute('data-block-hidden')===on)node.toggleAttribute('data-block-hidden',!on);
  }
 };
 /** Select a tab. A user's selection also swaps the scroll offset: the panel left keeps where it was, the one shown opens where it was left. */
 const choose=(name:string,rawId:string,user:boolean)=>{
  const entry=rows.get(name);if(!entry)return false;const tab=resolve(entry,rawId);if(!tab)return false;
  const before=state[name];if(before===tab.id)return true;
  if(user&&before!==undefined){entry.scrolls.set(before,entry.scrollRoot.scrollTop);const next=entry.scrolls.get(tab.id)??0;show(entry,tab);if(entry.scrollRoot.scrollTop!==next)entry.scrollRoot.scrollTop=next;}
  else show(entry,tab);
  state[name]=tab.id;if(before!==undefined)options.changed?.();return true;
 };
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
  const entry:Row={scrollRoot,row,tabs,scrolls:new Map()};rows.set(name,entry);
  const tabOf=(event:Event)=>{const button=(event.target as Element|null)?.closest?.('button[data-block-target]');return tabs.find(tab=>tab.button===button);};
  const click=(event:Event)=>{const tab=tabOf(event);if(tab)choose(name,tab.id,true);};
  const key=(event:KeyboardEvent)=>{
   const tab=tabOf(event);if(!tab)return;const index=tabs.indexOf(tab);
   const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
   if(next===null)return;event.preventDefault();const target=tabs[next]!;choose(name,target.id,true);target.button.focus();
  };
  row.addEventListener('click',click);row.addEventListener('keydown',key as EventListener);
  disposers.push(()=>{row.removeEventListener('click',click);row.removeEventListener('keydown',key as EventListener);});
  // The markup ships its first tab selected; binding makes the DOM agree with it whatever the markup said.
  const first=tabs.find(tab=>tab.button.getAttribute('aria-selected')==='true')??tabs[0]!;show(entry,first);state[name]=first.id;
 }
 return {
  state:()=>({...state}),
  select:(name,id)=>{choose(name,id,true);},
  /** Restore saved tabs. The section's scroll offset is the workspace scroll memory's, so this does not touch it. */
  restore(saved){for(const [name,id]of Object.entries(saved))choose(name,id,false);},
  dispose(){for(const dispose of disposers)dispose();disposers.length=0;rows.clear();},
 };
}
