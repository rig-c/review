import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {bindInspectorBlocks,activeBlocksUI,restoreActiveBlocksUI,parseActiveBlocks,inspectorBlocksKey,blockScrollGap} from '../web/inspector-blocks.ts';

const indexHtml=()=>readFile(new URL('../web/index.html',import.meta.url),'utf8');
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
const attr=(attrs:string,name:string)=>attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]??null;
/** The row's buttons inside a section, in order. */
function rowButtons(html:string,id:string){
 const section=html.slice(html.indexOf(` id="${id}"`)),row=section.slice(section.indexOf('<nav class="block-row"'),section.indexOf('</nav>'));
 return [...row.matchAll(/<button type="button" data-block-target="([^"]+)"(?: data-block-includes="([^"]+)")?>([^<]+)<\/button>/g)].map(m=>({target:m[1]!,includes:(m[2]??'').split(' ').filter(Boolean),label:m[3]!}));
}

test('every block of each Inspector section has a row button, and every row button targets a block of that section',async()=>{
 const html=await indexHtml();
 const expected={'inspector-rig':['Part','Modeling','Chest','Mesh','Weights','Bones','Fields'],'inspector-playback':['Transport','Sound','Environment','Physics','Idle tracks','Readings','Requirements','Report']};
 for(const [section,labels]of Object.entries(expected)){
  const children=directChildren(html,section),buttons=rowButtons(html,section);
  // The row is the section's first child, so it stays above the blocks it scrolls.
  expect(children[0]?.tag).toBe('nav');expect(attr(children[0]!.attrs,'class')).toBe('block-row');
  expect(buttons.map(b=>b.label)).toEqual(labels);
  const blocks=children.slice(1).map(child=>attr(child.attrs,'id'));expect(blocks.every(Boolean)).toBe(true);
  const covered=new Set(buttons.flatMap(b=>[b.target,...b.includes]));
  for(const block of blocks)expect({block,covered:covered.has(block!)}).toEqual({block,covered:true});
  for(const button of buttons){expect(blocks).toContain(button.target);for(const id of button.includes)expect(blocks).toContain(id);}
  // A button's target leads its group: the blocks it includes follow it in the section, before the next button's target.
  const order=blocks as string[];for(const [i,button]of buttons.entries()){const at=order.indexOf(button.target),next=i+1<buttons.length?order.indexOf(buttons[i+1]!.target):order.length;expect(at).toBeLessThan(next);for(const id of button.includes){const k=order.indexOf(id);expect(k>at&&k<next).toBe(true);}}
 }
 // The row ids are new; each kept block id still appears exactly once.
 for(const id of ['transport','environment','physics-panel','idle-tracks','readings','sound-panel','report-panel','selected-part','modeling-tools','chest-regions','mesh-panel','weights','bones-panel','rig-fields'])expect(html.split(` id="${id}"`).length).toBe(2);
});

/** Minimal element: layout comes from explicit `top`/`height`, relative to the section's scroll. */
class Node {
 listeners=new Map<string,Set<(event:{target:Node})=>void>>();
 addEventListener(type:string,fn:(event:{target:Node})=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(fn);}
 removeEventListener(type:string,fn:(event:{target:Node})=>void){this.listeners.get(type)?.delete(fn);}
 id='';hidden=false;children:Node[]=[];parent:Node|null=null;dataset:Record<string,string>={};classes=new Set<string>();attrs=new Map<string,string>();tag:string;
 top=0;height=0;scrollTop=0;clientHeight=300;scrollCalls:{top:number;behavior:string}[]=[];doc:{getElementById(id:string):Node|null}|null=null;
 textContent='';constructor(tag:string){this.tag=tag;}
 get classList(){return {contains:(name:string)=>this.classes.has(name)};}
 get ownerDocument(){return this.root().doc!;}
 root():Node{return this.parent?this.parent.root():this;}
 append(...nodes:Node[]){for(const node of nodes){node.parent=this;this.children.push(node);}}
 all():Node[]{return this.children.flatMap(n=>[n,...n.all()]);}
 contains(node:unknown):boolean{return node===this||this.children.some(n=>n.contains(node));}
 querySelectorAll(selector:string){if(selector!=='button[data-block-target]')throw new Error(selector);return this.all().filter(n=>n.tag==='button'&&'blockTarget'in n.dataset);}
 closest(selector:string){let node:Node|null=this;while(node){if(selector==='button[data-block-target]'&&node.tag==='button'&&'blockTarget'in node.dataset)return node;node=node.parent;}return null;}
 setAttribute(name:string,value:string){this.attrs.set(name,value);}removeAttribute(name:string){this.attrs.delete(name);}getAttribute(name:string){return this.attrs.get(name)??null;}
 /** Viewport rect: a section sits at 100; a block at 100 + top - section scroll. */
 getBoundingClientRect(){const section=this.section();if(this===section)return {top:100,bottom:100+this.clientHeight,height:this.clientHeight};if(this.classes.has('block-row'))return {top:100,bottom:100+this.height,height:this.height};const top=100+this.top-(section?.scrollTop??0);return {top,bottom:top+this.height,height:this.height};}
 section():Node|null{let node:Node|null=this;while(node&&!node.dataset.inspectorPanel)node=node.parent;return node;}
 get scrollHeight(){return Math.max(this.clientHeight,...this.children.map(n=>n.top+n.height));}
 scrollTo(options:{top:number;behavior:string}){this.scrollCalls.push(options);this.scrollTop=options.top;}
 /** A bubbling click whose target is this node. */
 click(){const event={target:this as Node};for(let node:Node|null=this;node;node=node.parent)for(const fn of node.listeners.get('click')??[])fn(event);}
}
function openSection(blocks:{id:string;label:string;top:number;height:number}[]){
 const page=new Node('body'),section=new Node('section'),row=new Node('nav');section.dataset.inspectorPanel='playback';row.classes.add('block-row');row.height=30;section.append(row);page.append(section);
 page.doc={getElementById:id=>page.all().find(n=>n.id===id)??null};
 const buttons:Record<string,Node>={};for(const block of blocks){const node=new Node('section');node.id=block.id;node.top=block.top;node.height=block.height;section.append(node);const button=new Node('button');button.dataset.blockTarget=block.id;button.textContent=block.label;row.append(button);buttons[block.id]=button;}
 let follow=()=>{};const observed:Node[]=[];let clock=0,changed=0;
 const ui=bindInspectorBlocks({sections:[section as unknown as HTMLElement],observer:(_root,changedFn)=>{follow=changedFn;return {observe:t=>observed.push(t as unknown as Node),disconnect(){}};},reducedMotion:()=>false,now:()=>clock,changed:()=>changed++});
 return {ui,section,row,buttons,observed,follow:()=>follow(),advance:(ms:number)=>{clock+=ms;},changed:()=>changed,current:()=>Object.entries(buttons).filter(([,b])=>b.getAttribute('aria-current')==='true').map(([id])=>id)};
}
const animate=[{id:'transport',label:'Transport',top:40,height:200},{id:'environment',label:'Environment',top:240,height:300},{id:'physics-panel',label:'Physics',top:540,height:400},{id:'report-panel',label:'Report',top:940,height:120}];

test('a row button scrolls its block under the sticky row inside the section and marks it aria-current',()=>{
 const app=openSection(animate);
 expect(app.current()).toEqual(['transport']);expect(app.observed.map(n=>n.id)).toEqual(animate.map(b=>b.id));
 app.buttons['physics-panel']!.click();
 expect(app.current()).toEqual(['physics-panel']);expect(app.ui.state()).toEqual({playback:'physics-panel'});expect(app.changed()).toBe(1);
 // The section, not the page, scrolls: block top 540 lands just under the 30px row.
 expect(app.section.scrollCalls).toEqual([{top:540-30-blockScrollGap,behavior:'smooth'}]);
 expect(app.section.children.find(n=>n.id==='physics-panel')!.getBoundingClientRect().top).toBe(100+30+blockScrollGap);
});

test('the active block follows scrolling, but not while a clicked block is still being scrolled to',()=>{
 const app=openSection(animate);
 app.section.scrollTop=260;app.follow();expect(app.current()).toEqual(['environment']);
 app.section.scrollTop=520;app.follow();expect(app.current()).toEqual(['physics-panel']);
 // At the end of the section the short closing block becomes active although it never reaches the row.
 app.section.scrollTop=app.section.scrollHeight-app.section.clientHeight;app.follow();expect(app.current()).toEqual(['report-panel']);
 app.buttons['transport']!.click();app.section.scrollTop=300;app.follow();expect(app.current()).toEqual(['transport']);
 app.advance(5000);app.follow();expect(app.current()).toEqual(['environment']);
});

test('the active block persists through the draft ui record and restores without scrolling',()=>{
 const saved=activeBlocksUI({rig:'mesh-panel',playback:'physics-panel'});expect(Object.keys(saved)).toEqual([inspectorBlocksKey]);
 const ui={inspectorScroll:'{}',reportCategory:'all',...JSON.parse(JSON.stringify(saved))};
 expect(restoreActiveBlocksUI(ui)).toEqual({rig:'mesh-panel',playback:'physics-panel'});
 for(const bad of [undefined,'nope','[]','{"playback":3}','{"Bad":"x"}'])expect(parseActiveBlocks(bad)).toEqual({});
 const app=openSection(animate);app.ui.restore({playback:'report-panel',rig:'unknown'});expect(app.current()).toEqual(['report-panel']);expect(app.section.scrollCalls).toEqual([]);
 app.ui.restore({playback:'missing'});expect(app.current()).toEqual(['report-panel']);
});

test('the review page binds the row on both Inspector sections and carries the active block in its draft adapter',async()=>{
 const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 expect(main).toContain("inspectorBlocks=bindInspectorBlocks({sections:[el('inspector-rig'),el('inspector-playback')]");
 expect(main).toContain("...(inspectorBlocks?activeBlocksUI(inspectorBlocks.state()):{})");
 expect(main).toContain("inspectorBlocks?.restore(restoreActiveBlocksUI(value));");
 const css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 expect(css).toMatch(/\.block-row\{position:sticky;top:-12px;[^}]*overflow-x:auto/);expect(css).toContain('.block-row button[aria-current=true]{');
});
