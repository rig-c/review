import {bindInspectorTabs,type InspectorTabs} from './view-controls.ts';
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
