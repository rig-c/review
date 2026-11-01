/** Inspector block row: the sticky row of buttons at the top of each Inspector section (index.html
 * `.block-row`). A button scrolls its block into view inside the section (the section is the Inspector's
 * scroll container) and marks it `aria-current`; the active block then follows scrolling. The active block
 * per section is the only thing this adds to the inspection draft (its `ui` record, key `inspectorBlocks`);
 * the scroll offset itself stays with the Inspector scroll memory. */
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

export interface BlockObserver {observe(target:Element):void;disconnect():void}
export interface InspectorBlocksOptions {
 /** Sections carrying `data-inspector-panel`, each with a `.block-row` first child. */
 sections:HTMLElement[];
 /** Creates the scroll-follow observer for one section; defaults to IntersectionObserver rooted at the section. */
 observer?:(root:HTMLElement,changed:()=>void)=>BlockObserver|null;
 /** Called when a click or scrolling changes a section's active block. */
 changed?:()=>void;
 reducedMotion?:()=>boolean;now?:()=>number;
}
export interface InspectorBlocks {state():ActiveBlocks;restore(state:ActiveBlocks):void;select(section:string,id:string):void;refresh():void;dispose():void}
/** Gap kept between the sticky row and a block scrolled under it, in CSS pixels. */
export const blockScrollGap=6;
/** How long a programmatic scroll (click or restore) holds the chosen block against scroll-follow, unless the user scrolls first. */
const holdMs=1200;

export function bindInspectorBlocks(options:InspectorBlocksOptions):InspectorBlocks {
 const now=options.now??(()=>Date.now()),reduced=options.reducedMotion??(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
 const makeObserver=options.observer??((root,changed)=>typeof IntersectionObserver==='function'?new IntersectionObserver(changed,{root,threshold:[0,.25,.5,.75,1]}):null);
 let ready=false;const disposers:(()=>void)[]=[],state:ActiveBlocks={},rows=new Map<string,{section:HTMLElement;scrollRoot:HTMLElement;row:HTMLElement;buttons:HTMLButtonElement[];hold:number;follow:()=>void}>();
 const targetOf=(scrollRoot:HTMLElement,button:HTMLButtonElement)=>{const id=button.dataset.blockTarget??'';const node=id?scrollRoot.ownerDocument.getElementById(id):null;return node&&scrollRoot.contains(node)?node:null;};
 const resolveId=(entry:{buttons:HTMLButtonElement[]},id:string)=>entry.buttons.some(b=>b.dataset.blockTarget===id)?id:(id==='transport'&&entry.buttons.some(b=>b.dataset.blockTarget==='motion-tools')?'motion-tools':id);
 const mark=(name:string,rawId:string)=>{const entry=rows.get(name);if(!entry)return false;const id=resolveId(entry,rawId);if(!entry.buttons.some(button=>button.dataset.blockTarget===id))return false;for(const button of entry.buttons){if(button.dataset.blockTarget===id)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}const before=state[name];state[name]=id;if(before!==id&&ready)options.changed?.();return true;};
 for(const section of options.sections){
  const name=section.dataset.inspectorPanel??'';if(!name)continue;
  const directRow=[...section.children].find(node=>(node as HTMLElement).classList.contains('block-row')) as HTMLElement|undefined;
  const nestedRoot=directRow?undefined:[...section.children].find(node=>[...((node as HTMLElement).children??[])].some(c=>(c as HTMLElement).classList.contains('block-row'))) as HTMLElement|undefined;
  const scrollRoot=nestedRoot??section;
  const row=directRow??([...(nestedRoot?.children??[])].find(node=>(node as HTMLElement).classList.contains('block-row')) as HTMLElement|undefined);
  if(!row)continue;
  const buttons=[...row.querySelectorAll<HTMLButtonElement>('button[data-block-target]')].filter(button=>targetOf(scrollRoot,button));if(!buttons.length)continue;
  const entry={section,scrollRoot,row,buttons,hold:0,follow:()=>{}};rows.set(name,entry);
  // Scroll-follow: the active block is the last one whose top has reached the row; at the end of the
  // section it is the last visible one, so a short closing block can still become active.
  entry.follow=()=>{
   if(entry.hold>now()||section.hidden)return;const top=scrollRoot.getBoundingClientRect().top+row.getBoundingClientRect().height+blockScrollGap*4;
   const visible=buttons.map(button=>({button,node:targetOf(scrollRoot,button)})).filter((item):item is {button:HTMLButtonElement;node:HTMLElement}=>!!item.node&&!item.node.hidden);if(!visible.length)return;
   let current=visible[0]!;for(const item of visible)if(item.node.getBoundingClientRect().top<=top)current=item;
   if(scrollRoot.scrollHeight-scrollRoot.clientHeight>0&&scrollRoot.scrollTop>=scrollRoot.scrollHeight-scrollRoot.clientHeight-2){const bottom=scrollRoot.getBoundingClientRect().bottom;for(const item of visible)if(item.node.getBoundingClientRect().top<bottom)current=item;}
   mark(name,current.button.dataset.blockTarget!);
  };
  const click=(event:Event)=>{const button=(event.target as Element|null)?.closest?.('button[data-block-target]') as HTMLButtonElement|null;if(!button||!buttons.includes(button))return;select(name,button.dataset.blockTarget!);};
  const release=()=>{entry.hold=0;};const intent=(event:Event)=>{if(!row.contains(event.target as Node))release();};
  row.addEventListener('click',click);for(const type of ['wheel','touchstart','keydown','pointerdown'])scrollRoot.addEventListener(type,intent,{passive:true});scrollRoot.addEventListener('scrollend',release);
  const observer=makeObserver(scrollRoot,()=>entry.follow());if(observer)for(const button of buttons)observer.observe(targetOf(scrollRoot,button)!);
  disposers.push(()=>{row.removeEventListener('click',click);for(const type of ['wheel','touchstart','keydown','pointerdown'])scrollRoot.removeEventListener(type,intent);scrollRoot.removeEventListener('scrollend',release);observer?.disconnect();});
  mark(name,buttons[0]!.dataset.blockTarget!);
 }
 ready=true;
 /** Scroll the block so its top sits just under the sticky row, then mark it. */
 function select(name:string,rawId:string):void {
  const entry=rows.get(name);if(!entry)return;const id=resolveId(entry,rawId);const button=entry.buttons.find(b=>b.dataset.blockTarget===id);const node=button&&targetOf(entry.scrollRoot,button);if(!node)return;
  const {scrollRoot,row}=entry,offset=node.getBoundingClientRect().top-scrollRoot.getBoundingClientRect().top-row.getBoundingClientRect().height-blockScrollGap,top=Math.max(0,scrollRoot.scrollTop+offset);
  entry.hold=now()+holdMs;scrollRoot.scrollTop=top;scrollRoot.scrollTo({top,behavior:reduced()?'auto':'smooth'});if(typeof scrollRoot.dispatchEvent==='function')scrollRoot.dispatchEvent(new Event('scroll'));mark(name,id);
 }
 return {
  state:()=>({...state}),select,
  restore(saved){for(const [name,id]of Object.entries(saved)){const entry=rows.get(name);if(entry&&mark(name,id))entry.hold=now()+holdMs;}},
  refresh(){for(const entry of rows.values())entry.follow();},
  dispose(){for(const dispose of disposers)dispose();disposers.length=0;rows.clear();},
 };
}
