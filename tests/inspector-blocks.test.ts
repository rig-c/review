import {rigWorkspaceMarkup,rigReviewDialogMarkup,rigLayerControlsMarkup,sharedViewToolsMarkup,sharedCommentMarkup} from '../src/compare-html.ts';
import {expect,test} from 'bun:test';
import {readFile,readdir} from 'node:fs/promises';
import {bindInspectorBlocks,activeBlocksUI,restoreActiveBlocksUI,parseActiveBlocks,inspectorBlocksKey} from '../web/inspector-blocks.ts';
import {renderCompareHtml} from '../src/compare-html.ts';

const webFile=(name:string)=>readFile(new URL(`../web/${name}`,import.meta.url),'utf8');
const indexHtml=async()=>rigWorkspaceMarkup+rigReviewDialogMarkup;
const voids=new Set(['input','br','img','meta','link','hr','source','col','area','base','embed','param','track','wbr']);
/** Direct children of the element whose opening tag carries `id="<id>"`, as {tag, attributes}. */
function directChildren(html:string,id:string):{tag:string;attrs:string}[] {
 const start=html.indexOf(` id="${id}"`);if(start<0)throw new Error('missing '+id);const open=html.lastIndexOf('<',start);
 const children:{tag:string;attrs:string}[]=[];let depth=0;
 for(const match of html.slice(open).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)){
  const [,close,raw,attrs]=match,tag=raw!.toLowerCase();if(voids.has(tag))continue;
  if(close){depth--;if(depth===0)break;continue;}
  if(depth===1)children.push({tag,attrs:attrs!});depth++;
 }
 return children;
}
/** An attribute's value, `''` for a bare attribute, null when absent. */
const attr=(attrs:string,name:string)=>{const m=attrs.match(new RegExp(`(?:^|[\\s<])${name}(?:="([^"]*)")?(?=[\\s/>]|$)`));return m?(m[1]??''):null;};
/** The opening tag's attributes of the element with `id="<id>"`. */
const openTag=(html:string,id:string)=>{const at=html.indexOf(` id="${id}"`);if(at<0)throw new Error('missing '+id);const open=html.lastIndexOf('<',at);return html.slice(open,html.indexOf('>',at)+1);};
/** The row's tabs inside a container, in order, with every attribute the tabs pattern reads. */
function rowTabs(html:string,id:string){
 const section=html.slice(html.indexOf(` id="${id}"`)),start=section.indexOf('<nav class="block-row"'),row=section.slice(start,section.indexOf('</nav>',start));
 const nav=row.slice(0,row.indexOf('>')+1);
 const tabs=[...row.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].map(m=>({attrs:m[1]!,label:m[2]!,target:attr(m[1]!,'data-block-target')!,includes:(attr(m[1]!,'data-block-includes')??'').split(' ').filter(Boolean)}));
 return {nav,tabs};
}
const expected={'inspector-rig':['Part','Modeling','Chest','Mesh','Weights','Bones','Fields','Cuts','Cloth'],'animate-blocks':['Transport','Sound','Environment','Physics','Idle tracks','Readings','Requirements','Retarget','Report']};

test('every block of each Inspector section has a row tab, and every row tab targets a block of that section; in Animate the timeline is its own panel beside the blocks panel',async()=>{
 const html=await indexHtml();
 const playbackPanels=directChildren(html,'inspector-playback');
 expect(playbackPanels.map(p=>attr(p.attrs,'id'))).toEqual(['animation-dock','animate-blocks']);
 const dockChildren=directChildren(html,'animation-dock');
 expect(dockChildren.map(c=>attr(c.attrs,'id'))).toEqual(['transport','frame-controls','animation-inspection']);
 for(const [container,labels]of Object.entries(expected)){
  const children=directChildren(html,container),{tabs}=rowTabs(html,container);
  // The row is the container's first child, so it stays above the panel it switches.
  expect(children[0]?.tag).toBe('nav');expect(attr(children[0]!.attrs,'class')).toBe('block-row');
  expect(tabs.map(b=>b.label)).toEqual(labels);
  const blocks=children.slice(1).map(child=>attr(child.attrs,'id'));expect(blocks.every(Boolean)).toBe(true);
  // The timeline is never inside the blocks container.
  expect(blocks).not.toContain('animation-inspection');
  const covered=new Set(tabs.flatMap(b=>[b.target,...b.includes]));
  for(const block of blocks)expect({block,covered:covered.has(block!)}).toEqual({block,covered:true});
  for(const tab of tabs){expect(blocks).toContain(tab.target);for(const id of tab.includes)expect(blocks).toContain(id);}
  // A tab's target leads its group: the blocks it includes follow it in the section, before the next tab's target.
  const order=blocks as string[];for(const [i,tab]of tabs.entries()){const at=order.indexOf(tab.target),next=i+1<tabs.length?order.indexOf(tabs[i+1]!.target):order.length;expect(at).toBeLessThan(next);for(const id of tab.includes){const k=order.indexOf(id);expect(k>at&&k<next).toBe(true);}}
 }
 // The row ids are new; each kept block id still appears exactly once.
 for(const id of ['animation-dock','animate-blocks','animation-inspection','transport','environment','physics-panel','idle-tracks','readings','sound-panel','report-panel','selected-part','modeling-tools','chest-regions','mesh-panel','weights','bones-panel','rig-fields','cuts-panel','cloth-panel'])expect(html.split(` id="${id}"`).length).toBe(2);
});

test('each block row is a WAI-ARIA tablist: role=tab buttons control role=tabpanel blocks, the first is selected, and every other panel ships hidden',async()=>{
 const html=await indexHtml();
 for(const container of Object.keys(expected)){
  const {nav,tabs}=rowTabs(html,container);
  expect(attr(nav,'role')).toBe('tablist');expect(attr(nav,'aria-label')).toBeTruthy();
  for(const [i,tab]of tabs.entries()){
   const selected=i===0,id=`block-tab-${tab.target}`;
   expect({tab:tab.label,role:attr(tab.attrs,'role'),id:attr(tab.attrs,'id'),controls:attr(tab.attrs,'aria-controls'),selected:attr(tab.attrs,'aria-selected'),tabindex:attr(tab.attrs,'tabindex'),current:attr(tab.attrs,'aria-current')})
    .toEqual({tab:tab.label,role:'tab',id,controls:tab.target,selected:String(selected),tabindex:selected?'0':'-1',current:null});
   const panel=openTag(html,tab.target);
   expect({panel:tab.target,role:attr(panel,'role'),labelledby:attr(panel,'aria-labelledby'),hidden:attr(panel,'hidden')!==null})
    .toEqual({panel:tab.target,role:'tabpanel',labelledby:id,hidden:!selected});
  }
 }
 // The included Angle block keeps its own hidden (the axis inspection owns it); the tab hides it by another attribute.
 expect(attr(openTag(html,'angle-panel'),'hidden')).not.toBeNull();expect(attr(openTag(html,'angle-panel'),'role')).toBeNull();
});

test('the comparison page renders the same tablists, and its own Part block is a tabpanel too',async()=>{
 const html=renderCompareHtml(await webFile('compare.html'),await indexHtml());
 for(const container of Object.keys(expected)){const {nav,tabs}=rowTabs(html,container);expect(attr(nav,'role')).toBe('tablist');for(const tab of tabs){const panel=openTag(html,tab.target);expect({panel:tab.target,role:attr(panel,'role'),labelledby:attr(panel,'aria-labelledby')}).toEqual({panel:tab.target,role:'tabpanel',labelledby:`block-tab-${tab.target}`});}}
});

/** Minimal element. Every write the tabs code can make is a setter or method here, and each one is logged. */
type Write={node:Node;what:string};
class Node {
 static log:Write[]=[];
 listeners=new Map<string,Set<(event:FakeEvent)=>void>>();
 addEventListener(type:string,fn:(event:FakeEvent)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(fn);}
 removeEventListener(type:string,fn:(event:FakeEvent)=>void){this.listeners.get(type)?.delete(fn);}
 children:Node[]=[];parent:Node|null=null;dataset:Record<string,string>={};classes=new Set<string>();attrs=new Map<string,string>();tag:string;
 doc:{getElementById(id:string):Node|null;activeElement:Node|null}|null=null;textContent='';
 /** Form state the page's modules keep in the DOM: a value, a checked box, an open details. Writes are logged. */
 #value='';#checked=false;#open=false;#hidden=false;#tabIndex=-1;#scrollTop=0;
 get value(){return this.#value;}set value(v:string){Node.log.push({node:this,what:'value'});this.#value=v;}
 get checked(){return this.#checked;}set checked(v:boolean){Node.log.push({node:this,what:'checked'});this.#checked=v;}
 get open(){return this.#open;}set open(v:boolean){Node.log.push({node:this,what:'open'});this.#open=v;}
 get hidden(){return this.#hidden;}set hidden(v:boolean){Node.log.push({node:this,what:'hidden'});this.#hidden=v;if(v)this.attrs.set('hidden','');else this.attrs.delete('hidden');}
 get tabIndex(){return this.#tabIndex;}set tabIndex(v:number){Node.log.push({node:this,what:'tabIndex'});this.#tabIndex=v;}
 get scrollTop(){return this.#scrollTop;}set scrollTop(v:number){Node.log.push({node:this,what:'scrollTop'});this.#scrollTop=v;}
 scrollTo(){Node.log.push({node:this,what:'scrollTo'});}scrollIntoView(){Node.log.push({node:this,what:'scrollIntoView'});}
 constructor(tag:string){this.tag=tag;}
 get id(){return this.attrs.get('id')??'';}
 get classList(){return {contains:(name:string)=>this.classes.has(name)};}
 get ownerDocument(){return this.root().doc!;}
 root():Node{return this.parent?this.parent.root():this;}
 append(...nodes:Node[]){for(const node of nodes){if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);node.parent=this;this.children.push(node);}}
 all():Node[]{return this.children.flatMap(n=>[n,...n.all()]);}
 contains(node:unknown):boolean{return node===this||this.children.some(n=>n.contains(node));}
 querySelectorAll(selector:string){if(selector!=='button[data-block-target]')throw new Error(selector);return this.all().filter(n=>n.tag==='button'&&'blockTarget'in n.dataset);}
 closest(selector:string){if(selector!=='button[data-block-target]')throw new Error(selector);let node:Node|null=this;while(node){if(node.tag==='button'&&'blockTarget'in node.dataset)return node;node=node.parent;}return null;}
 setAttribute(name:string,value:string){Node.log.push({node:this,what:name});this.attrs.set(name,value);if(name==='hidden')this.#hidden=true;}
 removeAttribute(name:string){Node.log.push({node:this,what:name});this.attrs.delete(name);if(name==='hidden')this.#hidden=false;}
 toggleAttribute(name:string,force?:boolean){const on=force??!this.attrs.has(name);if(on)this.setAttribute(name,'');else this.removeAttribute(name);return on;}
 hasAttribute(name:string){return this.attrs.has(name);}
 getAttribute(name:string){return this.attrs.get(name)??null;}
 focus(){Node.log.push({node:this,what:'focus'});this.root().doc!.activeElement=this;}
 /** A bubbling event whose target is this node. */
 fire(type:string,extra:Partial<FakeEvent>={}):FakeEvent{const event:FakeEvent={type,target:this,defaultPrevented:false,key:'',preventDefault(){event.defaultPrevented=true;},...extra};for(let node:Node|null=this;node;node=node.parent)for(const fn of node.listeners.get(type)??[])fn(event);return event;}
 click(){return this.fire('click');}
 key(key:string){return this.fire('keydown',{key});}
}
interface FakeEvent {type:string;target:Node;key:string;defaultPrevented:boolean;preventDefault():void}

/** The fake page built from the real index.html: the two Inspector sections, every element in them, attributes and all. */
async function openPage(changedFn?:()=>void,bottomMode=false){
 const html=await indexHtml(),page=new Node('body'),doc={getElementById:(id:string)=>page.all().find(n=>n.id===id)??null,activeElement:null as Node|null};page.doc=doc;
 for(const id of ['inspector-rig','inspector-playback']){
  const at=html.indexOf(` id="${id}"`),open=html.lastIndexOf('<',at);const stack:Node[]=[page];
  for(const match of html.slice(open).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*)>/g)){
   const [,close,raw,attrs]=match,tag=raw!.toLowerCase();
   if(close){if(!voids.has(tag))stack.pop();if(stack.length===1)break;continue;}
   const node=new Node(tag);
   for(const a of attrs!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)){const name=a[1]!,value=a[2]??'';if(name==='class')for(const c of value.split(/\s+/).filter(Boolean))node.classes.add(c);if(name.startsWith('data-'))node.dataset[name.slice(5).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())]=value;node.attrs.set(name,value);}
   if(node.attrs.has('hidden'))node.hidden=true;if(node.attrs.has('tabindex'))node.tabIndex=Number(node.attrs.get('tabindex'));
   stack.at(-1)!.append(node);if(!voids.has(tag)&&!attrs!.trimEnd().endsWith('/'))stack.push(node);
  }
 }
 const section=(id:string)=>doc.getElementById(id)!;let changed=0;
 const strip=new Node('nav'),comment=new Node('button'),panel=new Node('section');comment.setAttribute('id','workspace-tab-feedback');panel.setAttribute('id','inspector-feedback');page.append(strip,panel);
 Node.log=[];
 const ui=bindInspectorBlocks({sections:[section('inspector-rig') as unknown as HTMLElement,section('inspector-playback') as unknown as HTMLElement],...(bottomMode?{bottom:{strip:strip as unknown as HTMLElement,comment:comment as unknown as HTMLButtonElement,panel:panel as unknown as HTMLElement}}:{}),changed:()=>{changed++;changedFn?.();}});
 const tab=(target:string)=>doc.getElementById(`block-tab-${target}`)!;
 const shown=(container:string)=>section(container).children.filter(n=>n.attrs.get('role')==='tabpanel'&&!n.hidden).map(n=>n.id);
 const selected=(container:string)=>section(container).all().filter(n=>n.attrs.get('role')==='tab'&&n.attrs.get('aria-selected')==='true').map(n=>n.dataset.blockTarget);
 return {page,doc,ui,section,tab,shown,selected,strip,comment,panel,changed:()=>changed};
}

test('selecting a tab shows its panel alone, moves aria-selected and the roving tabindex, and scrolls nothing',async()=>{
 const app=await openPage();
 expect(app.shown('inspector-rig')).toEqual(['selected-part']);expect(app.shown('animate-blocks')).toEqual(['motion-tools']);
 Node.log=[];app.tab('mesh-panel').click();
 expect(app.shown('inspector-rig')).toEqual(['mesh-panel']);expect(app.selected('inspector-rig')).toEqual(['mesh-panel']);
 const rigTabs=app.section('inspector-rig').all().filter(n=>n.attrs.get('role')==='tab');expect(rigTabs.length).toBe(expected['inspector-rig'].length);
 expect(rigTabs.map(n=>[n.dataset.blockTarget,n.tabIndex])).toEqual(rigTabs.map(n=>[n.dataset.blockTarget,n.dataset.blockTarget==='mesh-panel'?0:-1]));
 expect(app.ui.state()).toEqual({rig:'mesh-panel',playback:'motion-tools'});expect(app.changed()).toBe(1);
 // One block on screen, and no scrolling to get there: no smooth scroll, no scrollIntoView.
 expect(Node.log.filter(w=>w.what==='scrollTo'||w.what==='scrollIntoView')).toEqual([]);
 // The other section is untouched.
 expect(app.shown('animate-blocks')).toEqual(['motion-tools']);
 // Clicking the selected tab again changes nothing.
 app.tab('mesh-panel').click();expect(app.changed()).toBe(1);
});

test('the Transport tab carries its included Angle block: hidden with the group by its own attribute, and the axis inspection keeps owning its hidden',async()=>{
 const app=await openPage(),angle=app.doc.getElementById('angle-panel')!;
 expect(angle.hidden).toBe(true);expect(angle.hasAttribute('data-block-hidden')).toBe(false);
 // The axis inspection opens the Angle block while Transport is shown.
 angle.hidden=false;
 app.tab('physics-panel').click();expect(angle.hasAttribute('data-block-hidden')).toBe(true);expect(angle.hidden).toBe(false);
 app.tab('motion-tools').click();expect(angle.hasAttribute('data-block-hidden')).toBe(false);expect(angle.hidden).toBe(false);
 // Closed by the axis inspection, it stays closed whichever tab is shown.
 angle.hidden=true;app.tab('sound-panel').click();app.tab('motion-tools').click();expect(angle.hidden).toBe(true);
});

test('keyboard: Arrow keys move and wrap, Home and End jump, focus follows the selection, and other keys are left alone',async()=>{
 const app=await openPage(),rig=expected['inspector-rig'],targets=app.section('inspector-rig').all().filter(n=>n.attrs.get('role')==='tab').map(n=>n.dataset.blockTarget!);
 expect(targets.length).toBe(rig.length);const first=targets[0]!,second=targets[1]!,last=targets.at(-1)!;
 const press=(key:string)=>{const from=app.doc.activeElement??app.tab(app.selected('inspector-rig')[0]!);return from.key(key);};
 app.tab(first).focus();
 let event=press('ArrowRight');expect(event.defaultPrevented).toBe(true);expect(app.selected('inspector-rig')).toEqual([second]);expect(app.doc.activeElement).toBe(app.tab(second));expect(app.shown('inspector-rig')).toEqual([second]);
 press('ArrowLeft');press('ArrowLeft');expect(app.selected('inspector-rig')).toEqual([last]);expect(app.doc.activeElement).toBe(app.tab(last));
 press('ArrowRight');expect(app.selected('inspector-rig')).toEqual([first]);
 press('End');expect(app.selected('inspector-rig')).toEqual([last]);expect(app.shown('inspector-rig')).toEqual([last]);
 press('Home');expect(app.selected('inspector-rig')).toEqual([first]);expect(app.doc.activeElement).toBe(app.tab(first));
 for(const key of ['ArrowDown','ArrowUp','Enter','a','Tab']){event=press(key);expect({key,prevented:event.defaultPrevented}).toEqual({key,prevented:false});}
 expect(app.selected('inspector-rig')).toEqual([first]);
 // A key pressed inside a panel is not the tablist's.
 app.tab('chest-regions').click();const field=app.doc.getElementById('chest-0-cx')!;expect(field.key('ArrowRight').defaultPrevented).toBe(false);expect(app.selected('inspector-rig')).toEqual(['chest-regions']);
 // The Animate row is its own tablist: keys there never move Setup.
 app.tab('motion-tools').focus();press('End');expect(app.selected('animate-blocks')).toEqual(['report-panel']);expect(app.selected('inspector-rig')).toEqual(['chest-regions']);
});

test('the active tab persists through the draft ui record, restores without moving the scroll, and refuses malformed values',async()=>{
 const saved=activeBlocksUI({rig:'mesh-panel',playback:'physics-panel'});expect(Object.keys(saved)).toEqual([inspectorBlocksKey]);
 const ui={inspectorScroll:'{}',reportCategory:'all',...JSON.parse(JSON.stringify(saved))};
 expect(restoreActiveBlocksUI(ui)).toEqual({rig:'mesh-panel',playback:'physics-panel'});
 for(const bad of [undefined,'nope','[]','{"playback":3}','{"Bad":"x"}'])expect(parseActiveBlocks(bad)).toEqual({});
 const app=await openPage();Node.log=[];
 app.ui.restore({playback:'report-panel',rig:'unknown'});
 expect(app.shown('animate-blocks')).toEqual(['report-panel']);expect(app.shown('inspector-rig')).toEqual(['selected-part']);
 // The section's scroll offset is the workspace scroll memory's to restore; restoring a tab does not touch it.
 expect(Node.log.filter(w=>['scrollTop','scrollTo','scrollIntoView','focus'].includes(w.what))).toEqual([]);
 app.ui.restore({playback:'missing'});expect(app.shown('animate-blocks')).toEqual(['report-panel']);
 // The pre-#258 id of the Transport block still restores to its tab.
 app.ui.restore({playback:'transport'});expect(app.shown('animate-blocks')).toEqual(['motion-tools']);
});

test('each panel keeps its own scroll offset: a tab switch remembers where the panel was and opens a new one at the top',async()=>{
 const app=await openPage(),rig=app.section('inspector-rig'),animate=app.section('animate-blocks');
 app.tab('mesh-panel').click();rig.scrollTop=140;
 app.tab('chest-regions').click();expect(rig.scrollTop).toBe(0);rig.scrollTop=60;
 app.tab('mesh-panel').click();expect(rig.scrollTop).toBe(140);
 app.tab('chest-regions').click();expect(rig.scrollTop).toBe(60);
 // Animate scrolls its blocks panel, not the section that also holds the timeline.
 app.tab('physics-panel').click();animate.scrollTop=90;app.tab('readings').click();expect(animate.scrollTop).toBe(0);app.tab('physics-panel').click();expect(animate.scrollTop).toBe(90);
 expect(app.section('inspector-playback').scrollTop).toBe(0);
});

/** Step 1's inventory: every block that holds state a hidden panel must not lose, with what holds it. `selected-part`
 * is the one stateless block — a read-out of the Parts explorer's selection, which lives outside the Inspector. */
const stateful:Record<string,string>={
 'modeling-tools':'the part-set select',
 'chest-regions':'27 crop, circle and mesher fields, the chest-more details, the pending textarea',
 'mesh-panel':'remesh params, region and segment editors, the pending textarea, the density strip fields',
 'weights':'show weights, mode and bone selects (they drive the stage overlay)',
 'bones-panel':'the anchor editor and its pending ops textarea',
 'rig-fields':'region, still, stops, inherit and turn groups and the pending textarea',
 'cuts-panel':'the cut editor, add form and pending textarea',
 'cloth-panel':'tag, declared and field controls and the pending textarea',
 'motion-tools':'the axis inspection state, with its included Angle block (axis select and slider)',
 'sound-panel':'sync audio and volume',
 'environment':'wind, gust, gravity and use controls',
 'physics-panel':'chain pick, ramp fields, row editor, preview and the pending textarea',
 'idle-tracks':'track list and editor, blink marker, the pending textarea',
 'readings':'eleven reading toggles and names',
 'requirements':'slot, animation, kind and bar picks, rendered into its body',
 'retarget':'the pose-map editor, rendered into its body',
 'report-panel':'category, page and target selects, the selected event, the details disclosure',
};

test('the stateful inventory covers every tab but Part, and names no block the page does not have',async()=>{
 const html=await indexHtml(),targets=Object.keys(expected).flatMap(c=>rowTabs(html,c).tabs.map(t=>t.target));
 expect(targets.filter(t=>!(t in stateful))).toEqual(['selected-part']);expect(Object.keys(stateful).filter(id=>!targets.includes(id))).toEqual([]);
});

for(const [block,holds]of Object.entries(stateful))test(`a hidden panel loses nothing: ${block} (${holds})`,async()=>{
 const app=await openPage(),panel=app.doc.getElementById(block)!,container=app.section('inspector-rig').contains(panel)?'inspector-rig':'animate-blocks';
 const group=[panel,...(app.tab(block).dataset.blockIncludes??'').split(' ').filter(Boolean).map(id=>app.doc.getElementById(id)!)];
 const nodes=group.flatMap(n=>[n,...n.all()]);
 // Put state on every carrier the block has, then show the block: what the user typed, ticked or opened.
 app.tab(block).click();
 for(const [i,node]of nodes.entries()){node.value=`draft-${block}-${i}`;node.checked=i%2===0;node.open=i%3===0;node.dataset.probe=String(i);}
 // A block that renders into a body (requirements, retarget) holds its editor as children it created.
 const created=new Node('div');created.attrs.set('id',`${block}-created-probe`);panel.append(created);
 const snapshot=()=>group.flatMap(n=>[n,...n.all()]).map(n=>({node:n,parent:n.parent,index:n.parent?.children.indexOf(n),value:n.value,checked:n.checked,open:n.open,probe:n.dataset.probe,attrs:[...n.attrs].filter(([k])=>k!=='hidden'&&k!=='data-block-hidden')}));
 const before=snapshot();
 const away=(container==='inspector-rig'?['mesh-panel','selected-part']:['report-panel','motion-tools']).find(t=>t!==block)!;
 Node.log=[];app.tab(away).click();
 expect(panel.hidden).toBe(true);for(const node of group.slice(1))expect(node.hasAttribute('data-block-hidden')).toBe(true);
 // While hidden, nothing in the block was written but the panel's own visibility.
 const inside=new Set(nodes.concat(created));
 expect(Node.log.filter(w=>inside.has(w.node)).map(w=>({id:w.node.id,what:w.what}))).toEqual(group.map(n=>({id:n.id,what:n===panel?'hidden':'data-block-hidden'})));
 app.tab(block).click();
 expect(panel.hidden).toBe(false);for(const node of group.slice(1))expect(node.hasAttribute('data-block-hidden')).toBe(false);
 // Shown again, it is the same nodes, in the same places, holding the same values.
 expect(snapshot()).toEqual(before);
});

test('no page module reads a block\'s visibility, so nothing pauses or re-measures because its tab is hidden',async()=>{
 // A hidden panel loses nothing only if no code depends on it being on screen. The visibility readers in web/ are
 // named here with what they watch; a new one has to say what it watches before this passes.
 const known:Record<string,string>={'part-thumbnails.ts':'the Parts explorer list (outside the Inspector)','live-connection.ts':'the document'};
 const hasUnapprovedVisibilityRead = (_name:string,text:string) => /IntersectionObserver|checkVisibility|offsetParent|visibilityState/.test(text);
 for(const planted of ['IntersectionObserver','checkVisibility','offsetParent','visibilityState'])expect(hasUnapprovedVisibilityRead('main.ts',`const planted = inspector.${planted};`)).toBe(true);
 const readers:string[]=[];
 for(const name of (await readdir(new URL('../web/',import.meta.url))).filter(n=>n.endsWith('.ts')).sort()){
  const text=await webFile(name);if(hasUnapprovedVisibilityRead(name,text))readers.push(name);
 }
 expect(readers).toEqual(Object.keys(known).sort());
 // The tabs module itself no longer observes or scrolls anything.
 const tabs=await webFile('inspector-blocks.ts');for(const word of ['IntersectionObserver','scrollTo(','scrollIntoView','smooth','scrollend','matchMedia'])expect({word,present:tabs.includes(word)}).toEqual({word,present:false});
});

test('the review page and the comparison tools bind both Inspector sections and carry the active tab in their draft adapters',async()=>{
 const main=await webFile('main.ts');
 expect(main).toContain("inspectorBlocks=bindInspectorBlocks({sections:[el('inspector-rig'),el('inspector-playback')]");
 expect(main).toContain("...(inspectorBlocks?activeBlocksUI(inspectorBlocks.state()):{})");
 // The tab is restored before the section's scroll offset, so the offset is clamped against the panel it belongs to.
 expect(main).toMatch(/inspectorBlocks\?\.restore\(restoreActiveBlocksUI\(value\)\);workspace\?\.restoreScroll\(value\.inspectorScroll\);/);
 const compare=await webFile('compare-picked-tools.ts');
 expect(compare).toContain('bindInspectorBlocks({');expect(compare).toContain('inspectorBlocks?.restore(restoreActiveBlocksUI(ui));');expect(compare).not.toContain('inspectorBlocks?.refresh()');
 for(const sheet of ['styles.css','compare.css']){
  const css=await webFile(sheet);
  expect(css).toMatch(/\.block-row\{position:sticky;top:-12px;[^}]*overflow-x:auto/);expect(css).toContain('.block-row button[aria-selected=true]{');expect(css).not.toContain('.block-row button[aria-current=true]');
  expect(css).toContain('[data-block-hidden]{display:none!important}');
 }
});


test('#666 restore leaves remembered user offsets intact and dispose/rebind removes delegated listeners',async()=>{
 const app=await openPage(),rig=app.section('inspector-rig');
 app.tab('mesh-panel').click();rig.scrollTop=140;app.tab('chest-regions').click();rig.scrollTop=60;
 const before=app.changed();Node.log=[];app.ui.restore({rig:'mesh-panel'});
 expect(rig.scrollTop).toBe(60);expect(app.changed()).toBe(before+1);
 expect(Node.log.filter(w=>['scrollTop','focus'].includes(w.what))).toEqual([]);
 app.ui.restore({rig:'chest-regions'});app.tab('mesh-panel').click();expect(rig.scrollTop).toBe(140);
 const frozen=app.ui.state();app.ui.dispose();expect(app.ui.state()).toEqual(frozen);const count=app.changed();app.tab('chest-regions').click();expect(app.changed()).toBe(count);
 app.ui.restore({rig:'chest-regions'});app.ui.select('rig','chest-regions');expect(app.ui.state()).toEqual(frozen);
 expect([...rig.children[0]!.listeners.values()].flatMap(set=>[...set])).toEqual([]);
 const rebound=bindInspectorBlocks({sections:[rig as unknown as HTMLElement]});
 app.tab('chest-regions').click();expect(rebound.state()).toEqual({rig:'chest-regions'});expect(app.changed()).toBe(count);
 rebound.dispose();
});


test('#735 header mode swaps existing block rows and one Comments tab, preserving mode selections and input nodes',async()=>{
 const app=await openPage(undefined,true),meshInput=app.doc.getElementById('mesh-density')??app.section('mesh-panel').all().find(n=>n.tag==='input')!;
 const rows=app.strip.children.slice();expect(rows).toHaveLength(2);expect(rows.map(row=>row.hidden)).toEqual([false,true]);
 app.tab('mesh-panel').click();meshInput.value='preserve draft';app.comment.click();expect(app.ui.state()).toEqual({rig:'feedback',playback:'motion-tools'});expect(app.panel.hidden).toBe(false);expect(app.section('inspector-rig').dataset.comments).toBe('true');
 app.ui.activate('playback');expect(rows.map(row=>row.hidden)).toEqual([true,false]);expect(app.panel.hidden).toBe(true);expect(app.comment.parent).toBe(rows[1]!);expect(rows[0]!.all()).not.toContain(app.comment);
 app.comment.key('End');expect(app.ui.state().playback).toBe('feedback');expect(app.panel.hidden).toBe(false);app.tab('physics-panel').click();
 app.ui.activate('rig');expect(app.panel.hidden).toBe(false);expect(app.comment.parent).toBe(rows[0]!);expect(app.comment.getAttribute('aria-selected')).toBe('true');app.tab('mesh-panel').click();expect(app.panel.hidden).toBe(true);expect(meshInput.value).toBe('preserve draft');
 app.ui.activate('playback');expect(app.ui.state().playback).toBe('physics-panel');
 app.ui.restore({rig:'feedback',playback:'report-panel'});expect(app.ui.state()).toEqual({rig:'feedback',playback:'report-panel'});app.ui.activate('rig');expect(app.panel.hidden).toBe(false);
 expect(app.page.all().filter(n=>n.id==='workspace-tab-feedback')).toHaveLength(1);app.ui.dispose();
});
