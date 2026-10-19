import {readFile} from 'node:fs/promises';
import {ComparePresentation} from '../src/compare-presentation.ts';
import type {InspectionPlayer} from '../src/compare-playhead.ts';
import {expect,test} from 'bun:test';
import type {PosedFrame,SlotIdentitySnapshot} from '@rig-c/play';
import {PartInspection,PartExplorer,copyPartFrame,copyPartIdentity,loadPartCatalog,partCatalog,partGeometry,partBounds,partIdentity,orderedParts,selectedFrame,type PartPlayer,type PartEntry} from '../web/part-selection.ts';
import type {ControlPartIdentity} from '../src/control.ts';
import type {Json} from '../src/manifest.ts';
const clip={polygon:[0,0,5,0,5,5,0,5],inverse:false,convex:true};
const frame:PosedFrame={generation:1,order:[{kind:'mesh',slot:'s',z:0,blend:'Normal',tint:[1,1,1,1],vertices:[0,0,10,0,0,10],uvs:[0,0,1,0,0,1],triangles:[0,1,2],page:'packed.png',pma:false,sequence:0,clip},{kind:'region',slot:'other',z:1,blend:'Normal',tint:[1,1,1,1],corners:[0,0,0,1,1,1,1,0],uvs:[0,0,0,1,1,1,1,0],region:'sprite',page:'packed.png',pma:false}]};
const model={slots:[{name:'s',bone:'root',setup:'first'},{name:'other',bone:'root',setup:'sprite'},{name:'clip',bone:'root'}],skins:[{name:'default',attachments:{s:{first:{kind:'mesh',path:'texture-one'},alternate:{kind:'mesh',path:'texture-two'}},other:{sprite:{kind:'region',path:'sprite'}},clip:{mask:{kind:'clipping'}}}}]};
const entries=partCatalog(model,['s','other','clip']);
function fake(){
 const rendered:PosedFrame[]=[];let sampled:unknown='unset',source=copyPartFrame(frame),override:SlotIdentitySnapshot|null=null;
 const snapshot=():SlotIdentitySnapshot=>override??{generation:source.generation!,set:null,skin:null,slots:entries.map((entry,z)=>{const drawn=source.order.find(row=>row.slot===entry.slot),attachment=entry.slot==='s'?'first':'sprite';return {slot:entry.slot,z,attachment:drawn?attachment:null,skin:drawn?'default':null,reason:drawn?null:entry.slot==='clip'?'no-attachment':'timeline-null'};})};
 const player:PartPlayer={get generation(){return source.generation!;},get skin(){return snapshot().skin??undefined;},get set(){return snapshot().set;},slotIdentity:snapshot,posedFrame:filter=>{sampled=filter;return source;},renderer:{render(value:PosedFrame){rendered.push(value);}}};
 return {player,rendered,sampled:()=>sampled,source:(value:PosedFrame)=>{source={...value,generation:source.generation!+1};},identity:(value:SlotIdentitySnapshot|null)=>{override=value;}};
}
test('full resolved clips survive Solo; opposite side and context keep the entire actual frame',()=>{
 const part={side:'a',slot:'s',mode:'solo'} as const,solo=selectedFrame(frame,part,'a');expect(solo.order).toHaveLength(1);expect(solo.order[0]!.clip).toBe(clip);expect(selectedFrame(frame,part,'b')).toBe(frame);expect(selectedFrame(frame,{...part,mode:'context'},'a')).toBe(frame);expect(frame.order).toHaveLength(2);expect(partGeometry(solo,'s')).toMatchObject({vertices:3,triangles:1,z:0});expect(partGeometry(frame,'clip')).toBeNull();
});
test('held-frame adapter only renders; selection never resamples, seeks, skins, advances or resets pose history',()=>{
 const a=fake(),b=fake(),inspection=new PartInspection();inspection.register('a',entries,a.player);inspection.register('b',entries,b.player);inspection.present('a');inspection.present('b');expect(a.sampled()).toBeUndefined();
 // A subsequent prepared pose must not replace the last actually drawn frame.
 a.source({order:[]});inspection.select({side:'a',slot:'s',mode:'solo'});expect(a.rendered.at(-1)!.order.map(r=>r.slot)).toEqual(['s']);expect(b.rendered.at(-1)!.order).toHaveLength(2);expect(inspection.observation()).toMatchObject({drawn:true,vertices:3,triangles:1,skin:null,set:null,activeAttachment:{skin:'default',attachment:'first'}});expect(inspection.observation()!.declarations).toHaveLength(2);
 const json:Json=inspection.feedback();expect(JSON.parse(JSON.stringify(json))).toMatchObject({slot:'s',side:'a',mode:'solo',drawn:true});
 inspection.select({...inspection.value()!,mode:'context'});expect(a.rendered.at(-1)!.order).toHaveLength(2);inspection.select(null);expect(inspection.value()).toBeNull();expect(a.rendered.at(-1)!.order).toHaveLength(2);
 inspection.present('a');inspection.select({side:'a',slot:'s',mode:'solo'});expect(inspection.observation()!.drawn).toBe(false);expect(a.rendered.at(-1)!.order).toEqual([]);
});
test('invalid identity and malformed geometry refuse; missing declaration is never guessed from texture/page',()=>{
 const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});const before=inspection.value(),draws=a.rendered.length;expect(()=>inspection.select({side:'single',slot:'not-in-model',mode:'solo'})).toThrow('PART_UNAVAILABLE');expect(()=>inspection.select({side:'a',slot:'s',mode:'solo'})).toThrow('PART_UNAVAILABLE');expect(inspection.value()).toEqual(before);expect(a.rendered).toHaveLength(draws);
 expect(()=>partCatalog(model,['s'])).toThrow('PART_SOURCE_CHANGED');expect(()=>partCatalog({...model,slots:[...model.slots,model.slots[0]]},['s','other','clip','s'])).toThrow('PART_SOURCE_CHANGED');expect(entries[0]!.declarations.map(d=>d.attachment)).toEqual(['first','alternate']);expect(entries[2]!.declarations[0]!.kind).toBe('clipping');
 const invalid=copyPartFrame(frame);const row=invalid.order[0]!;if(row.kind!=='mesh')throw new Error('test requires mesh');row.triangles=[3,0,1];expect(()=>partGeometry(invalid,'s')).toThrow('malformed');
});
test('retained geometry, UV and clip coordinates are owned copies',()=>{
 const source=copyPartFrame(frame),copy=copyPartFrame(source),row=source.order[0]!;if(row.kind!=='mesh')throw new Error('test requires mesh');row.vertices[0]=999;row.uvs[0]=.9;row.clip!.polygon[0]=999;expect(copy.order[0]).toEqual(frame.order[0]);
});

test('actual compare draw adapter includes part rendering in paired submission cost and refuses failed Solo',async()=>{
 const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8'),start=source.indexOf('function inspectionPlayer('),end=source.indexOf('const layers=',start);if(start<0||end<0)throw new Error('actual comparison adapter unavailable');
 const adapter=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));let clock=0,fail=false;const order:string[]=[];
 const make=(side:string)=>({time:0,pause(){order.push(side+':pause');},seek(time:number){this.time=time;order.push(side+':seek');},draw(){clock+=2;order.push(side+':draw');}});
 const players={a:make('a'),b:make('b')},parts={present(side:string){order.push(side+':parts');clock+=3;if(fail&&side==='b')throw new Error('part renderer failed');}};
 const get=new Function('players','parts',adapter+';return inspectionPlayer;')(players,parts) as (side:'a'|'b')=>InspectionPlayer;
 const presentation=new ComparePresentation(),state=presentation.inspect({time:.5,source:'current-time'},get('a'),get('b'),{start:0,end:1},()=>clock);
 expect(state.lastDrawMs).toBe(10);expect(state.inspection).toMatchObject({a:.5,b:.5,reference:.5});expect(order).toEqual(['a:pause','b:pause','a:seek','b:seek','a:draw','a:parts','b:draw','b:parts']);
 fail=true;expect(()=>presentation.inspect({time:.75,source:'current-time'},get('a'),get('b'),{start:0,end:1},()=>clock)).toThrow('part renderer failed');expect(presentation.snapshot()).toMatchObject({status:'failed',inspection:null,lastDrawn:null});
});

test('selection cannot call a pose-history operation or write a player property',()=>{
 const a=fake(),forbidden=new Set(['seek','play','frame','pause','resume','setSet','queue','clearTrack']);let writes=0;
 const guarded=new Proxy(a.player,{get(target,key,receiver){if(typeof key==='string'&&forbidden.has(key))throw new Error('history mutation forbidden: '+key);return Reflect.get(target,key,receiver);},set(){writes++;throw new Error('player mutation forbidden');}});
 expect(()=>Reflect.get(guarded,'seek')).toThrow('history mutation forbidden');expect(()=>Reflect.set(guarded,'skin','default')).toThrow('player mutation forbidden');writes=0;
 const inspection=new PartInspection();inspection.register('single',entries,guarded);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'solo'});inspection.select({...inspection.value()!,mode:'context'});inspection.select(null);expect(writes).toBe(0);
});

test('catalog bytes are bound to the reviewed model hash before exposing declarations',async()=>{
 const bytes=new TextEncoder().encode(JSON.stringify(model)),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const fetcher=new Proxy(fetch,{apply:()=>Promise.resolve(new Response(bytes))});expect(await loadPartCatalog('http://local.invalid/model',hash,['s','other','clip'],fetcher)).toEqual(entries);
 await expect(loadPartCatalog('http://local.invalid/model','0'.repeat(64),['s','other','clip'],fetcher)).rejects.toThrow('PART_SOURCE_CHANGED');await expect(loadPartCatalog('http://local.invalid/model',hash,['s','s','clip'],fetcher)).rejects.toThrow('PART_SOURCE_CHANGED');
});


test('selected bounds use held world geometry and normal clip intersection without inventing hidden pixels',()=>{
 expect(partBounds(frame,'s')).toEqual({x:0,y:0,width:5,height:5});
 expect(partBounds(frame,'other')).toEqual({x:0,y:0,width:1,height:1});
 expect(partBounds(frame,'clip')).toBeNull();
 const inverse=copyPartFrame(frame);inverse.order[0]!.clip!.inverse=true;expect(partBounds(inverse,'s')).toEqual({x:0,y:0,width:10,height:10});
 const outside=copyPartFrame(frame);outside.order[0]!.clip!.polygon=[20,20,25,20,25,25];expect(partBounds(outside,'s')).toBeNull();
 const inspection=new PartInspection(),a=fake();inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});expect(inspection.bounds()).toEqual({x:0,y:0,width:5,height:5});a.source({order:[]});expect(inspection.bounds()).toEqual({x:0,y:0,width:5,height:5});
});

test('identity is authoritative for ambiguous declarations, active sets and non-drawn reasons without guessing',()=>{
 const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});
 expect(inspection.observation()).toMatchObject({activeAttachment:{skin:'default',attachment:'first'},identityUnavailable:null,generation:1});
 const snap:SlotIdentitySnapshot={generation:1,set:'linked-set',skin:'active-skin',slots:[{slot:'clip',z:0,attachment:null,skin:null,reason:'no-attachment'},{slot:'other',z:1,attachment:null,skin:null,reason:'set-hide'},{slot:'s',z:2,attachment:'linked-alias',skin:'owning-skin',reason:null}]};
 const changed=copyPartFrame(frame);changed.order=changed.order.filter(row=>row.slot==='s');changed.order[0]!.z=2;a.source(changed);a.identity({...snap,generation:2});inspection.present('single');expect(inspection.observation()).toMatchObject({set:'linked-set',skin:'active-skin',activeAttachment:{skin:'owning-skin',attachment:'linked-alias'},z:2});
 inspection.select({side:'single',slot:'other',mode:'context'});expect(inspection.observation()).toMatchObject({drawn:false,activeAttachment:null,reason:'set-hide',identityUnavailable:null,z:1});
 expect(orderedParts(entries,changed,{...snap,generation:2}).map(entry=>entry.slot)).toEqual(['clip','other','s']);
 expect(partIdentity({...snap,generation:2},'other')).toMatchObject({attachment:null,skin:null,reason:'set-hide',set:'linked-set'});
});

test('drawn entries follow actual z order; undrawn declarations stay separate in setup order',()=>{
 const swapped=copyPartFrame(frame);swapped.order[0]!.z=6;swapped.order[1]!.z=1;
 expect(orderedParts(entries,swapped).map(entry=>entry.slot)).toEqual(['other','s','clip']);
 expect(orderedParts(entries,null).map(entry=>entry.slot)).toEqual(['s','other','clip']);expect(entries.map(entry=>entry.slot)).toEqual(['s','other','clip']);
});

/** The actual explorer class over a scoped DOM host; removing a focused subtree clears activeElement as in the browser. */
async function explorerHarness(){
 const counter={writes:0};
 const document:{activeElement:DetailNode|null;body:DetailNode|null;createElement:(tag:string)=>DetailNode}={activeElement:null,body:null,createElement:tag=>new DetailNode(tag.toUpperCase())};
 class DetailNode {
  parentElement:DetailNode|null=null;children:DetailNode[]=[];dataset:Record<string,string>={};attributes=new Map<string,string>();selector='';value='';disabled=false;hidden=false;checked=false;type='';title='';className='';onclick:(()=>void)|null=null;onchange:(()=>void)|null=null;private content='';
  constructor(readonly tagName:string){}
  get textContent():string{return this.content+this.children.map(node=>node.textContent).join('');}
  set textContent(value:string){this.replaceChildren();this.content=value;}
  get isConnected():boolean{return this===document.body||!!this.parentElement?.isConnected;}
  contains(node:DetailNode|null):boolean{return !!node&&(node===this||this.children.some(child=>child.contains(node)));}
  append(...nodes:DetailNode[]){for(const node of nodes){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes:DetailNode[]){if(document.activeElement!==this&&this.contains(document.activeElement))document.activeElement=document.body;for(const child of this.children)child.parentElement=null;this.children=[];this.content='';this.append(...nodes);}
  setAttribute(name:string,value:string){counter.writes++;this.attributes.set(name,value);}
  addEventListener(){}
  focus(){if(this.isConnected&&!this.disabled)document.activeElement=this;}
  querySelector(selector:string):DetailNode|null{return this.querySelectorAll(selector)[0]??null;}
  querySelectorAll(selector:string):DetailNode[]{return this.children.flatMap(child=>[...(selector==='button'?child.tagName==='BUTTON':child.selector===selector)?[child]:[],...child.querySelectorAll(selector)]);}
 }
 document.body=new DetailNode('BODY');document.activeElement=document.body;
 const host=new DetailNode('ASIDE'),detail=new DetailNode('SECTION');document.body.append(host,detail);
 for(const [selector,tag]of [['[data-part-search]','INPUT'],['[data-part-list]','UL'],['[data-part-solo]','INPUT'],['[data-part-whole]','BUTTON'],['[data-part-status]','P']]){const node=new DetailNode(tag!);node.selector=selector!;host.append(node);}
 const source=await readFile(new URL('../web/part-selection.ts',import.meta.url),'utf8'),begin=source.indexOf('export class PartExplorer extends');if(begin<0)throw new Error('Actual explorer class boundary absent');
 const script=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(begin).replace('export class','class'));
 const Explorer=new Function('PartInspection','orderedParts','partIdentity','document','HTMLElement',script+';return PartExplorer;')(PartInspection,orderedParts,partIdentity,document,DetailNode) as typeof PartExplorer;
 return {document,host,detail,Explorer,DetailNode,counter};
}
test('animated Inspector details retain the focused feedback action and use the current selection',async()=>{
 const {document,host,detail,Explorer}=await explorerHarness();
 const targets:unknown[]=[],a=fake(),b=fake(),explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,()=>{},part=>targets.push(part));
 explorer.register('a',entries,a.player);explorer.register('b',entries,b.player);explorer.present('a');explorer.present('b');explorer.select({side:'a',slot:'s',mode:'solo'});
 const action=detail.querySelector('button')!;action.focus();const beforeBounds=detail.textContent;expect(document.activeElement).toBe(action);expect(action.isConnected).toBe(true);
 const moved=copyPartFrame(frame);const row=moved.order.find(value=>value.slot==='s')!;if(row.kind!=='mesh')throw new Error('Moving mesh required');row.vertices=row.vertices.map((value,i)=>value+(i%2===0?2:1));row.clip=undefined;a.source(moved);explorer.present('a');
 expect(detail.querySelector('button')).toBe(action);expect(action.isConnected).toBe(true);expect(document.activeElement).toBe(action);expect(detail.textContent).not.toBe(beforeBounds);expect(detail.textContent).toContain('x 2, y 1, width 10, height 10');
 explorer.select({side:'b',slot:'other',mode:'context'});expect(detail.querySelector('button')).toBe(action);expect(document.activeElement).toBe(action);action.onclick!();expect(targets).toHaveLength(1);expect(targets[0]).toMatchObject({side:'b',slot:'other',mode:'context',identity:{attachment:'sprite',skin:'default'}});
 explorer.select(null);expect(action.hidden).toBe(true);expect(action.disabled).toBe(true);expect(detail.textContent).toContain('Whole rig');action.onclick!();expect(targets).toHaveLength(1);
 explorer.select({side:'a',slot:'s',mode:'solo'});expect(detail.querySelector('button')).toBe(action);expect(action.hidden).toBe(false);expect(action.disabled).toBe(false);action.onclick!();expect(targets.at(-1)).toMatchObject({side:'a',slot:'s',mode:'solo',identity:{attachment:'first',skin:'default'}});
});

test('playback frames rewrite the parts list only when what it shows changes; search is case-sensitive on exact names',async()=>{
 const {host,detail,Explorer,counter}=await explorerHarness(),a=fake(),explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,()=>{},()=>{});
 explorer.register('single',entries,a.player);explorer.present('single');explorer.select({side:'single',slot:'other',mode:'context'});
 const list=host.querySelector('[data-part-list]')!,rows=()=>list.querySelectorAll('button');
 const settled=counter.writes;for(let tick=0;tick<60;tick++){a.source(copyPartFrame(frame));explorer.present('single');}
 expect(counter.writes).toBe(settled);
 const moved=copyPartFrame(frame);moved.order=moved.order.filter(row=>row.slot!=='other');a.source(moved);explorer.present('single');
 expect(counter.writes).toBeGreaterThan(settled);expect(rows().find(row=>row.dataset.slot==='other')!.attributes.get('aria-label')).toContain('not drawn');
 const search=host.querySelector('[data-part-search]')!;search.value='Other';(explorer as unknown as {renderList():void}).renderList();expect(rows()).toHaveLength(0);
 search.value='oth';(explorer as unknown as {renderList():void}).renderList();expect(rows().map(row=>row.dataset.slot)).toEqual(['other']);
});

test('identity capture rejects stale or forged generation/order atomically and retains the actual prior draw',()=>{
 const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'solo'});const before=inspection.observation(),target=inspection.value(),draws=a.rendered.length,snapshot=a.player.slotIdentity();
 for(const invalid of [{...snapshot,generation:2},{...snapshot,slots:snapshot.slots.slice(1)},{...snapshot,slots:snapshot.slots.map((row,i)=>i===0?{...row,slot:'unknown'}:row)},{...snapshot,slots:snapshot.slots.map((row,i)=>i===0?{...row,z:1}:row)},{...snapshot,slots:snapshot.slots.map((row,i)=>i===0?{...row,attachment:null,skin:null,reason:'hidden' as const}:row)}]){
  a.identity(invalid);expect(()=>inspection.present('single')).toThrow('PART_IDENTITY');expect(inspection.observation()).toEqual(before);expect(inspection.value()).toEqual(target);expect(a.rendered).toHaveLength(draws);
 }
 expect(()=>copyPartIdentity(snapshot,{order:frame.order},entries,1,1)).toThrow('PART_IDENTITY_STALE');expect(()=>copyPartIdentity(snapshot,frame,entries,1,2)).toThrow('PART_IDENTITY_STALE');
});

test('hidden, timeline-null, no-attachment and set-hide retain exact public null reasons and full z',()=>{
 for(const reason of ['hidden','timeline-null','no-attachment','set-hide'] as const){
  const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);const empty:PosedFrame={order:[]};a.source(empty);a.identity({generation:2,set:reason==='set-hide'?'wink':null,skin:'active',slots:entries.map((entry,z)=>({slot:entry.slot,z,attachment:null,skin:null,reason}))});inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});
  expect(inspection.observation()).toMatchObject({drawn:false,z:0,reason,activeAttachment:null,identityUnavailable:null,generation:2,identity:{attachment:null,skin:null,reason,activeSkin:'active'}});expect(inspection.bounds()).toBeNull();expect(inspection.value()!.identity?.reason).toBe(reason);inspection.assertIdentity(inspection.value());
 }
});

test('resolved identity is independent of visible geometry; clipping declaration never invents a key',()=>{
 const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);const identities=a.player.slotIdentity();a.source({order:[]});a.identity({...identities,generation:2});inspection.present('single');inspection.select({side:'single',slot:'s',mode:'solo'});
 expect(inspection.observation()).toMatchObject({drawn:false,activeAttachment:{skin:'default',attachment:'first'},reason:null,identityUnavailable:null});expect(inspection.bounds()).toBeNull();inspection.select({side:'single',slot:'clip',mode:'context'});expect(inspection.observation()).toMatchObject({activeAttachment:null,reason:'no-attachment',drawn:false});
});

test('slot-follow refreshes actual timeline identity while a persisted exact target detects mismatch',()=>{
 const a=fake(),inspection=new PartInspection();inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});const saved=inspection.value()!,snap=a.player.slotIdentity();
 const changed={...snap,generation:2,set:'linked',skin:'alt',slots:snap.slots.map(row=>row.slot==='s'?{...row,attachment:'timeline-linked-key',skin:'owning'}:{...row})};
 a.identity(changed);expect(inspection.observation()).toMatchObject({set:null,skin:null,generation:1,activeAttachment:{attachment:'first'}});a.source(copyPartFrame(frame));inspection.present('single');expect(inspection.value()).toMatchObject({slot:'s',identity:{attachment:'timeline-linked-key',skin:'owning',set:'linked',activeSkin:'alt'}});expect(()=>inspection.assertIdentity(saved)).toThrow('PART_IDENTITY_MISMATCH');
 inspection.assertIdentity({side:'single',slot:'s',mode:'context'});const current=inspection.value()!;current.identity!.attachment='caller-mutation';expect(inspection.observation()!.activeAttachment!.attachment).toBe('timeline-linked-key');
});

test('nonenumerable public generation survives owned frame and Solo copies',()=>{
 const source={order:frame.order};Object.defineProperty(source,'generation',{value:17,enumerable:false});const retained=copyPartFrame(source);expect(retained.generation).toBe(17);expect(selectedFrame(retained,{side:'single',slot:'s',mode:'solo'},'single').generation).toBe(17);expect(Object.keys(source)).not.toContain('generation');
});

test('retained public identity owns row copies and never rereads later prepared metadata',()=>{
 const a=fake(),inspection=new PartInspection(),snap=a.player.slotIdentity(),raw={...snap,slots:snap.slots.map(row=>({...row}))};a.identity(raw);inspection.register('single',entries,a.player);inspection.present('single');inspection.select({side:'single',slot:'s',mode:'context'});raw.slots[0]!.attachment='later-raw-key';raw.skin='later-active-skin';raw.set='later-set';expect(inspection.observation()).toMatchObject({skin:null,set:null,generation:1,activeAttachment:{skin:'default',attachment:'first'}});
});

/** The draw boundary as main.ts/compare.ts run it: the player draws whole first, then parts present inside the same try. */
function drawBoundary(explorer:PartInspection,side:'single'|'a'|'b',drawn:string[]):void {drawn.push(side);explorer.present(side);}
test('identity mismatch keeps the rig drawn whole, names the refusal, offers nothing stale, and a later valid frame recovers Solo',async()=>{
 const {host,detail,Explorer,counter}=await explorerHarness(),a=fake(),changes:unknown[]=[],explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,previous=>changes.push(previous),()=>{});
 const drawn:string[]=[],list=host.querySelector('[data-part-list]')!,status=host.querySelector('[data-part-status]')!,solo=host.querySelector('[data-part-solo]')!,rows=()=>list.querySelectorAll('button');
 explorer.register('single',entries,a.player);drawBoundary(explorer,'single',drawn);explorer.select({side:'single',slot:'s',mode:'solo'});expect(a.rendered.at(-1)!.order.map(r=>r.slot)).toEqual(['s']);
 const snapshot=a.player.slotIdentity(),soloDraws=a.rendered.length,mismatch=()=>{a.source(copyPartFrame(frame));a.identity({...snapshot,generation:a.player.generation,slots:snapshot.slots.map(row=>row.slot==='other'?{...row,attachment:null,skin:null,reason:'hidden' as const}:row)});};mismatch();
 expect(()=>drawBoundary(explorer,'single',drawn)).not.toThrow();expect(drawn).toHaveLength(2);
 // No Solo render from the refused frame: the player's own whole draw stays on screen.
 expect(a.rendered).toHaveLength(soloDraws);expect(explorer.refusal('single')).toMatchObject({code:'PART_IDENTITY_FRAME_MISMATCH',catalog:false});
 expect(host.dataset.parts).toBe('unavailable');expect(status.textContent).toContain('Parts unavailable · PART_IDENTITY_FRAME_MISMATCH');expect(detail.textContent).toContain('Parts unavailable');
 expect(explorer.value()).toBeNull();expect(explorer.observation()).toBeNull();expect(explorer.feedback()).toBeNull();expect(explorer.bounds()).toBeNull();expect(explorer.frame('single')).toBeUndefined();expect(()=>explorer.assertIdentity({side:'single',slot:'s',mode:'solo'})).toThrow('PART_IDENTITY_UNAVAILABLE');
 expect(solo.disabled).toBe(true);expect(rows().every(row=>row.disabled&&row.attributes.get('aria-pressed')==='false'&&row.textContent.includes('parts unavailable · PART_IDENTITY_FRAME_MISMATCH'))).toBe(true);expect(detail.querySelector('button')!.hidden).toBe(true);
 const changed=changes.length;rows()[0]!.onclick!();expect(changes).toHaveLength(changed);expect(status.textContent).toContain('PARTS_UNAVAILABLE');expect(a.rendered).toHaveLength(soloDraws);
 // A sustained failure rewrites nothing; availability is part of the view key.
 const settled=counter.writes;for(let tick=0;tick<10;tick++){mismatch();drawBoundary(explorer,'single',drawn);}expect(counter.writes).toBe(settled);
 a.identity(null);a.source(copyPartFrame(frame));drawBoundary(explorer,'single',drawn);
 expect(explorer.refusal('single')).toBeNull();expect(host.dataset.parts).toBeUndefined();expect(explorer.value()).toMatchObject({slot:'s',mode:'solo',identity:{attachment:'first'}});expect(a.rendered.at(-1)!.order.map(r=>r.slot)).toEqual(['s']);
 expect(solo.disabled).toBe(false);expect(solo.checked).toBe(true);expect(rows().some(row=>row.disabled)).toBe(false);expect(status.textContent).toContain('declared slots');
});
test('catalog load or hash failure keeps the rig drawn and refuses only that side until it registers a matching catalog',async()=>{
 const {host,detail,Explorer}=await explorerHarness(),a=fake(),b=fake(),explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,()=>{},()=>{});
 const bytes=new TextEncoder().encode(JSON.stringify(model)),fetcher=new Proxy(fetch,{apply:()=>Promise.resolve(new Response(bytes))}),missing=new Proxy(fetch,{apply:()=>Promise.resolve(new Response('',{status:404}))});
 for(const [side,load]of [['a',()=>loadPartCatalog('http://local.invalid/model','0'.repeat(64),['s','other','clip'],fetcher)],['b',()=>loadPartCatalog('http://local.invalid/model','0'.repeat(64),['s','other','clip'],missing)]] as const){try{explorer.register(side,await load(),side==='a'?a.player:b.player);}catch(error){explorer.refuseCatalog(side,error);}}
 const drawn:string[]=[];expect(()=>{drawBoundary(explorer,'a',drawn);drawBoundary(explorer,'b',drawn);}).not.toThrow();expect(drawn).toEqual(['a','b']);expect(a.rendered).toHaveLength(0);
 expect(explorer.refusal('a')).toMatchObject({code:'PART_SOURCE_CHANGED',catalog:true});expect(explorer.refusal('b')).toMatchObject({code:'PART_CATALOG_UNAVAILABLE',catalog:true});
 const status=host.querySelector('[data-part-status]')!;expect(status.textContent).toContain('A PART_SOURCE_CHANGED');expect(status.textContent).toContain('B PART_CATALOG_UNAVAILABLE');expect(status.textContent).toContain('until the package reloads');expect(host.querySelector('[data-part-list]')!.querySelectorAll('button')).toHaveLength(0);
 expect(()=>explorer.select({side:'a',slot:'s',mode:'context'})).toThrow('PART_UNAVAILABLE');expect(explorer.value()).toBeNull();expect(explorer.feedback()).toBeNull();
 // A later valid frame does not resurrect a refused catalog; a reload that registers a matching one does.
 drawBoundary(explorer,'a',drawn);expect(explorer.refusal('a')).not.toBeNull();
 explorer.register('a',entries,a.player);drawBoundary(explorer,'a',drawn);expect(explorer.refusal('a')).toBeNull();explorer.select({side:'a',slot:'s',mode:'context'});expect(explorer.value()).toMatchObject({side:'a',slot:'s',identity:{attachment:'first'}});expect(explorer.refusal('b')).not.toBeNull();
});
test('first row click opens in context; a later click keeps the current mode',async()=>{
 const {host,detail,Explorer}=await explorerHarness(),a=fake(),explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,()=>{},()=>{});
 explorer.register('single',entries,a.player);explorer.present('single');const row=(slot:string)=>host.querySelector('[data-part-list]')!.querySelectorAll('button').find(item=>item.dataset.slot===slot)!,draws=a.rendered.length;
 row('s').onclick!();expect(explorer.value()).toMatchObject({slot:'s',mode:'context'});expect(a.rendered.at(-1)!.order).toHaveLength(2);expect(a.rendered.length).toBeGreaterThan(draws);
 row('other').onclick!();expect(explorer.value()).toMatchObject({slot:'other',mode:'context'});
 explorer.select({...explorer.value()!,mode:'solo'});row('s').onclick!();expect(explorer.value()).toMatchObject({slot:'s',mode:'solo'});expect(a.rendered.at(-1)!.order.map(r=>r.slot)).toEqual(['s']);
});

test('clicking the selected slot again returns to Whole rig; the control value is null, not a new part',async()=>{
 const {host,detail,Explorer}=await explorerHarness(),a=fake(),changes:unknown[]=[],explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,previous=>changes.push(previous),()=>{});
 explorer.register('single',entries,a.player);explorer.present('single');const row=(slot:string)=>host.querySelector('[data-part-list]')!.querySelectorAll('button').find(item=>item.dataset.slot===slot)!;
 row('s').onclick!();expect(explorer.value()).toMatchObject({side:'single',slot:'s',mode:'context'});expect(row('s').attributes.get('aria-pressed')).toBe('true');
 row('s').onclick!();expect(explorer.value()).toBeNull();expect(row('s').attributes.get('aria-pressed')).toBe('false');expect(host.querySelector('[data-part-whole]')!.attributes.get('aria-pressed')).toBe('true');expect(changes.at(-1)).toMatchObject({slot:'s'});
 // Solo is cleared with the selection; selecting another slot still switches rather than toggling off.
 row('other').onclick!();explorer.select({...explorer.value()!,mode:'solo'});row('other').onclick!();expect(explorer.value()).toBeNull();expect(a.rendered.at(-1)!.order).toHaveLength(2);
 row('other').onclick!();row('s').onclick!();expect(explorer.value()).toMatchObject({slot:'s'});
});

import {pageRegionTable,thumbnailPlan,thumbnailFit,PartThumbnails} from '../web/part-thumbnails.ts';
const pagedModel={...model,pages:[{name:'packed.png',width:200,height:100,regions:[{name:'texture-one',x:10,y:20,width:30,height:40,degrees:0},{name:'texture-two',x:50,y:0,width:20,height:10,degrees:90}]}]};
const known=(attachment:string|null,reason:ControlPartIdentity['reason']=null):ControlPartIdentity=>({attachment,skin:attachment?'default':null,reason,set:null,activeSkin:null});
test('a thumbnail is the declared page region of the active attachment, cropped by its page UVs; anything else is the icon with a named reason',()=>{
 const table=pageRegionTable(pagedModel),[s,other,clip]=entries as [PartEntry,PartEntry,PartEntry];
 const crop=thumbnailPlan(table,s,known('first'));
 expect(crop).toEqual({kind:'crop',key:JSON.stringify(['default','first']),page:'packed.png',region:'texture-one',u0:.05,v0:.2,u1:.2,v1:.6,sx:10,sy:20,sw:30,sh:40});
 expect(thumbnailFit(30,40)).toEqual({dx:6,dy:0,dw:36,dh:48});
 const reason=(plan:ReturnType<typeof thumbnailPlan>)=>plan.kind==='icon'?plan.reason:'crop';
 expect(reason(thumbnailPlan(table,other,known('sprite')))).toBe('THUMBNAIL_NO_PAGE_REGION: the model declares no page region "sprite"');
 expect(reason(thumbnailPlan(table,s,known('alternate')))).toContain('THUMBNAIL_ROTATED_REGION');
 expect(reason(thumbnailPlan(table,clip,known('mask')))).toBe('clipping attachment draws no page image');
 expect(reason(thumbnailPlan(table,other,known(null,'timeline-null')))).toBe('no active attachment (timeline-null)');
 expect(reason(thumbnailPlan(table,s,null))).toBe('awaiting identity snapshot');
 expect(reason(thumbnailPlan(pageRegionTable(model),s,known('first')))).toBe('THUMBNAIL_REGION_UNAVAILABLE: the model has no pages section');
});
test('thumbnails draw lazily when the row is visible, once per attachment key, and never the whole page',()=>{
 const draws:number[][]=[],observed=new Set<unknown>();let fire:((items:{isIntersecting:boolean;target:unknown}[])=>void)|null=null;
 class Node {children:Node[]=[];dataset:Record<string,string>={};attrs=new Map<string,string>();width=0;height=0;content='';constructor(readonly tagName:string){}
  get textContent(){return this.content;}set textContent(v:string){this.children=[];this.content=v;}replaceChildren(...nodes:Node[]){this.children=nodes;this.content='';}
  setAttribute(n:string,v:string){this.attrs.set(n,v);}querySelectorAll(tag:string){return this.children.filter(c=>c.tagName===tag.toUpperCase());}
  getContext(){return {clearRect(){},drawImage:(_image:unknown,...args:number[])=>draws.push(args)};}}
 const globals={document:{createElement:(tag:string)=>new Node(tag.toUpperCase())},IntersectionObserver:class{constructor(callback:typeof fire){fire=callback;}observe(target:unknown){observed.add(target);}unobserve(target:unknown){observed.delete(target);}disconnect(){observed.clear();}}};
 const old=new Map<string,PropertyDescriptor|undefined>();for(const [key,value]of Object.entries(globals)){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 try{
  const thumbnails=new PartThumbnails(pageRegionTable(pagedModel),new Map([['packed.png',{} as HTMLImageElement]])),one=new Node('SPAN'),two=new Node('SPAN'),none=new Node('SPAN');
  expect(thumbnails.show(one as unknown as HTMLElement,entries[0]!,known('first'),'◈')).toBe('thumbnail: region texture-one on packed.png');
  expect(thumbnails.show(two as unknown as HTMLElement,entries[0]!,known('first'),'◈')).toBe('thumbnail: region texture-one on packed.png');
  expect(thumbnails.show(none as unknown as HTMLElement,entries[1]!,known('sprite'),'◇')).toContain('type icon: THUMBNAIL_NO_PAGE_REGION');expect(none.textContent).toBe('◇');expect(none.dataset.thumbnail).toBe('icon');
  const canvas=one.children[0]!;expect(canvas.width).toBe(48);expect(canvas.height).toBe(48);expect(one.dataset.thumbnail).toBe('image');expect(draws).toEqual([]);expect(observed.size).toBe(2);
  fire!([{isIntersecting:true,target:canvas},{isIntersecting:true,target:two.children[0]}]);
  // One crop from the page (source rect = the region, fitted into the 48px backing store), then cache copies.
  expect(draws.filter(args=>args.length===8)).toEqual([[10,20,30,40,6,0,36,48]]);expect(draws.filter(args=>args.length===2)).toHaveLength(2);expect(observed.size).toBe(0);
  // Unchanged identity redraws nothing; a page that never loaded is named, not substituted.
  thumbnails.show(one as unknown as HTMLElement,entries[0]!,known('first'),'◈');expect(one.children[0]).toBe(canvas);
  const blank=new Node('SPAN');expect(new PartThumbnails(pageRegionTable(pagedModel),new Map()).show(blank as unknown as HTMLElement,entries[0]!,known('first'),'◈')).toContain('THUMBNAIL_PAGE_UNAVAILABLE');expect(blank.textContent).toBe('◈');
 }finally{for(const [key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
});
test('the explorer puts a row thumbnail or the type icon beside unchanged row text and names the reason in the tooltip',async()=>{
 const {host,detail,Explorer}=await explorerHarness(),a=fake(),explorer=new Explorer(host as unknown as HTMLElement,detail as unknown as HTMLElement,()=>{},()=>{});
 const source={show:(icon:HTMLElement,entry:PartEntry,identity:ControlPartIdentity|null,glyph:string)=>{const plan=thumbnailPlan(pageRegionTable(pagedModel),entry,identity);icon.textContent=plan.kind==='crop'?'':glyph;return plan.kind==='crop'?'thumbnail: region '+plan.region:'type icon: '+plan.reason;}};
 explorer.register('single',entries,a.player,source);explorer.present('single');const row=(slot:string)=>host.querySelector('[data-part-list]')!.querySelectorAll('button').find(item=>item.dataset.slot===slot)!;
 expect(row('s').title).toContain('thumbnail: region texture-one');expect(row('s').textContent).toBe('s · drawn · default / first');expect(row('s').attributes.get('aria-label')).toBe('◈ s · drawn · default / first · drawn');
 expect(row('other').title).toContain('type icon: THUMBNAIL_NO_PAGE_REGION');expect(row('other').textContent).toBe('◇other · drawn · default / sprite');
 expect(row('clip').title).toContain('type icon: no active attachment (no-attachment)');expect(host.querySelector('[data-part-status]')!.textContent).toBe('3 declared slots · 3 results');
});
