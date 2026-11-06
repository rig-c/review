import {readFile} from 'node:fs/promises';
import {renderIdlePendingRow} from '../web/idle-panel.ts';
import {afterEach,expect,test} from 'bun:test';
import {bindDomI18n,getLanguagePreference,setLanguagePreference,setSourceAttribute,setSourceText,sourceAttribute,sourceTextContent,tr,unbindDomI18n} from '../web/i18n.ts';
import {renderAppliedHistory,renderHistoryCheck,type AppliedHistoryView} from '../web/rebuild-client.ts';
import {rigPaneLabel} from '../src/frame-clock.ts';

// #347: Animate writes English source text on every played frame; these keep an unchanged write from reaching the DOM.
function textElement(value:string){
 let writes=0;
 const node={nodeType:3,get nodeValue(){return value;},set nodeValue(v:string){writes++;value=v;},parentElement:null};
 const el={childNodes:[node],get textContent(){return node.nodeValue;},set textContent(v:string){node.nodeValue=v;}};
 return {el:el as unknown as Element,writes:()=>writes};
}

test('tr returns the same translation on a repeated call',()=>{
 for(const text of ['Play','1.2500 / 13.0000 s','Generated rig · dance · 1.250 s']){
  const first=tr(text,'ko');expect(tr(text,'ko')).toBe(first);expect(tr(text,'en')).toBe(tr(text,'en'));
 }
});

test('setSourceText writes only a changed source',()=>{
 const {el,writes}=textElement('0.0000 / 2.0000 s');
 expect(setSourceText(el,'0.0000 / 2.0000 s')).toBe(false);expect(writes()).toBe(0);
 expect(setSourceText(el,'0.0167 / 2.0000 s')).toBe(true);expect(writes()).toBe(1);
 expect(el.textContent).toBe('0.0167 / 2.0000 s');
 expect(setSourceText(el,'0.0167 / 2.0000 s')).toBe(false);expect(writes()).toBe(1);
});

test('setSourceAttribute writes only a changed source',()=>{
 const attrs=new Map<string,string>();let writes=0;
 const el={getAttribute:(n:string)=>attrs.get(n)??null,setAttribute:(n:string,v:string)=>{writes++;attrs.set(n,v);}} as unknown as Element;
 expect(sourceAttribute(el,'title')).toBeNull();
 expect(setSourceAttribute(el,'title','Select bone hip')).toBe(true);
 expect(setSourceAttribute(el,'title','Select bone hip')).toBe(false);
 expect(setSourceAttribute(el,'title','Select bone knee')).toBe(true);
 expect(writes).toBe(2);expect(sourceAttribute(el,'title')).toBe('Select bone knee');
});

// #356: with the DOM observer bound (Korean UI), a source write is translated at the write and its mutation records
// reach the observer already settled. A minimal DOM records mutations the way the browser queues them.
type Rec={type:string;target:any;attributeName?:string;addedNodes:any[]};
function dom(){
 const records:Rec[]=[];let writes=0;
 const text=(value:string,parent:any)=>{const node:any={nodeType:3,parentElement:parent,get nodeValue(){return value;},set nodeValue(v:string){writes++;value=v;records.push({type:'characterData',target:node,addedNodes:[]});}};return node;};
 const doc={
  createElement:(tag:string)=>element('',tag.toUpperCase()),
  createTreeWalker(root:Element){
   function* texts(node:Node):Generator<Node>{
    if(node.nodeType===3)yield node;
    else for(const child of node.childNodes)yield* texts(child);
   }
   const nodes=texts(root);
   return {nextNode:()=>nodes.next().value??null};
  },
 };
 const element=(id:string,tag='SPAN',initial='')=>{
  const attrs=new Map<string,string>(),classes=new Set<string>();
  const el:any={nodeType:1,id,tagName:tag,className:'',dataset:{},ownerDocument:doc,parentElement:null,childNodes:[],classList:{contains:(name:string)=>classes.has(name),toggle:(name:string,on:boolean)=>on?classes.add(name):classes.delete(name)},closest:()=>null,querySelectorAll:()=>[],
   getAttribute:(n:string)=>attrs.get(n)??null,setAttribute:(n:string,v:string)=>{writes++;attrs.set(n,v);records.push({type:'attributes',target:el,attributeName:n,addedNodes:[]});},
   scrollTop:0,scrollLeft:0,
   get firstElementChild(){return el.childNodes.find((n:any)=>n.nodeType===1)??null;},
   get lastElementChild(){return el.childNodes.findLast((n:any)=>n.nodeType===1)??null;},
   getBoundingClientRect(){
    const index=el.parentElement?.childNodes.indexOf(el)??0;
    return {top:index*48,left:index*160};
   },
   replaceChildren(...children:any[]){el.childNodes=[];el.append(...children);el.scrollTop=0;el.scrollLeft=0;},
   append(...children:any[]){
    for(const child of children){
     const node=typeof child==='string'?text(child,el):child;
     node.parentElement=el;
     el.childNodes.push(node);
    }
   },
   get textContent(){return el.childNodes.map((n:any)=>n.nodeType===3?n.nodeValue:n.textContent).join('');},
   set textContent(v:string){writes++;const n=text(v,el);el.childNodes=[n];records.push({type:'childList',target:el,addedNodes:[n]});}};
  if(initial)el.childNodes=[text(initial,el)];
  return el;
 };
 return {element,records,writes:()=>writes};
}
let observerCallback:((records:Rec[])=>void)|null=null;
const realObserver=(globalThis as any).MutationObserver,realPreference=getLanguagePreference();
function bindKorean(root:any){
 (globalThis as any).MutationObserver=class{constructor(cb:(r:Rec[])=>void){observerCallback=cb;}observe(){}disconnect(){observerCallback=null;}};
 setLanguagePreference('ko');bindDomI18n(root);
}
afterEach(()=>{unbindDomI18n();(globalThis as any).MutationObserver=realObserver;setLanguagePreference(realPreference);});
const deliver=(d:ReturnType<typeof dom>)=>{const batch=d.records.splice(0);const before=d.writes();observerCallback!(batch);return d.writes()-before;};

type FrameString={id:string;tag?:string;attr?:string;values:string[]};
// The strings a played frame really changes, each with the English source a few frames write.
const rigLabels=[1.1667,1.2167,1.2667].map(time=>rigPaneLabel({hasPlayer:true,animation:'dance',time,frame:null}));
const FRAME_STRINGS:FrameString[]=[
 {id:'time-label',values:['1.1667 / 13.0000 s','1.2167 / 13.0000 s','1.2667 / 13.0000 s']},
 {id:'rig-label',values:rigLabels},
 {id:'rig-label',attr:'title',values:rigLabels},
 {id:'curve-readout',tag:'OUTPUT',values:['Runtime evaluation · 1.1667 s · rotation track: -4.1 · authored local: -4.1','Runtime evaluation · 1.2167 s · rotation track: -2.52 · authored local: -2.52','Runtime evaluation unavailable: select a numeric stored channel.']},
 {id:'wind-gust',tag:'BUTTON',values:['Gust','Gusting…','Gust']},
];

/** Every write of a changing value shows its translation now, keeps its source, and leaves the observer nothing to do. */
function assertUpdates(spec:FrameString,write:(el:Element,value:string,index:number)=>void){
 const d=dom(),el=d.element(spec.id,spec.tag,spec.attr?'':'—');bindKorean(el);
 let shown:string|null=null;
 for(const [i,value] of spec.values.entries()){
  write(el,value,i);
  const now=spec.attr?el.getAttribute(spec.attr):el.childNodes[0].nodeValue;
  expect(now,`${spec.id} frame ${i}`).toBe(tr(value,'ko'));
  expect(spec.attr?sourceAttribute(el,spec.attr):sourceTextContent(el)).toBe(value);
  if(i>0&&value!==spec.values[i-1])expect(now).not.toBe(shown);
  expect(deliver(d),`${spec.id}: the observer rewrote a settled record`).toBe(0);
  shown=now;
 }
 unbindDomI18n();
}
const sourceWrite=(spec:FrameString)=>(el:Element,value:string)=>{if(spec.attr)setSourceAttribute(el,spec.attr,value);else setSourceText(el,value);};

for(const spec of FRAME_STRINGS)test(`#356 ${spec.id}${spec.attr?` ${spec.attr}`:''} updates on every changed frame under the Korean UI, translated at the write`,()=>{
 expect(new Set(spec.values.map(v=>tr(v,'ko'))).size,'the sample must change what is shown').toBeGreaterThan(1);
 assertUpdates(spec,sourceWrite(spec));
});

test('#356 planted control: a writer that freezes one string after its first frame goes red',()=>{
 const spec=FRAME_STRINGS[0]!,write=sourceWrite(spec);
 expect(()=>assertUpdates(spec,(el,value,i)=>{if(i===0)write(el,value);})).toThrow();
});

test('#356 a write that bypasses the helpers is still translated by the observer',()=>{
 const d=dom(),el=d.element('time-label','SPAN','—');bindKorean(el);
 el.childNodes[0].nodeValue='Play';expect(deliver(d)).toBe(1);expect(el.childNodes[0].nodeValue).toBe(tr('Play','ko'));
 el.setAttribute('title','Play');expect(deliver(d)).toBe(1);expect(el.getAttribute('title')).toBe(tr('Play','ko'));
});

test('#356 a lone text child is updated in place (no childList swap for subtree observers)',()=>{
 const d=dom(),el=d.element('time-label','SPAN','—'),node=el.childNodes[0];bindKorean(el);
 setSourceText(el,'1.1667 / 13.0000 s');
 expect(el.childNodes[0]).toBe(node);expect(d.records.some(r=>r.type==='childList')).toBe(false);
});


// #448: the 0.75 control's producer summary and retained torso readings as projected into history.
test('#448 failed Apply renders its exact Korean verdict and producer readings',()=>{
 const breathLine="BREATH_VISIBLE: FAIL — halves_measured 1 of 2; torso_status FAIL; torso_parts torso; torso_heat_mean 3.62; torso_floor 3.809; feet_status SKIP; feet_reason no part comes from a See-through \"footwear\" layer, so there are no feet to hold still";
 const row:AppliedHistoryView['records'][number]={
  id:'dbe1329f6925ca40d5f8020078c0a1e5990a7fcdb12281b1b699b8766e07656f',
  kind:'patch',op:'rig',what:'replace /motion/tracks/0/amp',modelHash:'577d3175c391ae4ea158213ec05b021bfa8f138757dd2d3ca91777462a43dc78',kept:true,
  check:{
   schema:'rig-review-check-summary/1',pass:false,exitCode:1,
   line:'check: FAIL — 1 bar(s) not met; 7 of 10 bar(s) measured, 3 skipped (BLINK_NO_HOLE, CHAIN_LAG, TIP_OVER_ROOT)',
   bars:{BREATH_VISIBLE:'FAIL',BLINK_NO_HOLE:'SKIP',CHAIN_LAG:'SKIP',TIP_OVER_ROOT:'SKIP',STILL_REGIONS_DARK:'PASS',
    TEXTURE_STRETCH:'PASS',ANIMATIONS_DO_NOT_FOLD:'PASS',RECOMPOSITE_HOLES:'REPORTED',PART_SUPPORT_REPORT:'UNCLASSIFIED'},
   gate:true,source:'check',
  },
  failedBarLines:[breathLine],
 };
 const d=dom(),el=d.element('history-verdict');bindKorean(el);
 renderHistoryCheck(el,row);
 expect(el.dataset.checkVerdict).toBe('failed');
 expect(el.textContent).toBe('프로듀서 검사 실패 · '+breathLine);
 renderHistoryCheck(el,{...row,check:undefined,failedBarLines:undefined});
 expect(el.dataset.checkVerdict).toBe('unavailable');
 expect(el.textContent).toBe('프로듀서 검사 결과 없음');
 renderHistoryCheck(el,{...row,check:{...row.check!,pass:true,exitCode:0,bars:{BREATH_VISIBLE:'PASS'}},failedBarLines:undefined});
 expect(el.dataset.checkVerdict).toBe('passed');
 expect(el.textContent).toBe('프로듀서 검사 통과');
});


test('#448 the real pending row renders passed, failed and unavailable states in Korean',()=>{
 const d=dom();
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');
 try {
  Object.defineProperty(globalThis,'document',{configurable:true,value:{
   createElement:(tag:string)=>d.element('',tag.toUpperCase()),
  }});
  for(const [check,expected,english] of [
   ['passed',' · 적용됨',' · applied'],
   ['failed',' · 검사 실패',' · Check failed'],
   ['unavailable',' · 검사 결과 없음',' · Check unavailable'],
  ] as const){
   const row=renderIdlePendingRow({op:'replace',path:'/motion/tracks/0/amp',value:0.75},check,false,()=>{});
   bindKorean(row);
   const status=Array.from(row.childNodes).find((node):node is HTMLElement=>
    node.nodeType===1 && 'idleOpCheck' in (node as HTMLElement).dataset);
   expect(status?.dataset.idleOpCheck).toBe(check);
   expect(status?.textContent).toBe(expected);
   expect(row.className).toBe(check==='passed'?'applied':'');
   setLanguagePreference('en');
   expect(status?.textContent).toBe(english);
   unbindDomI18n();
  }
 }finally{
  if(original)Object.defineProperty(globalThis,'document',original);
  else Reflect.deleteProperty(globalThis,'document');
 }
});


test('#448 Compare renders every applied check in its actual history list',async()=>{
 const compare=await readFile(new URL('../web/compare-picked-tools.ts',import.meta.url),'utf8');
 expect(compare).toContain('renderAppliedHistory(list, h, state.appliedOnStage?.buildId ?? null)');
 const base={id:'',kind:'patch',op:'rig',what:'replace /motion/tracks/0/amp',modelHash:'0123456789abcdef',kept:true} as const;
 const check={schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS',bars:{},gate:true} as const;
 const records:AppliedHistoryView['records']=[
  {...base,id:'legacy'},
  {...base,id:'refused',check:{...check,pass:null,exitCode:2,line:'CHECK_REFUSED: no check document'}},
  {...base,id:'no-failed-bars',check:{...check,pass:false,exitCode:1,line:'check: FAIL without a bar'}},
  {...base,id:'nonzero-pass',check:{...check,exitCode:1,line:'check: PASS then exited 1'}},
  {...base,id:'failed-bar',check:{...check,pass:false,exitCode:1,line:'check: FAIL'},failedBarLines:['BREATH_VISIBLE: FAIL — torso_floor 3.809']},
  {...base,id:'passed',check},
 ];
 const list=dom().element('applied-list','OL');
 renderAppliedHistory(list,{schema:'rig-review-applied-history/1',depth:records.length,records},'passed');
 expect(list.childNodes.map((row:HTMLElement)=>row.dataset.buildId)).toEqual(records.map(record=>record.id));
 expect(list.childNodes.map((row:HTMLElement)=>row.classList.contains('on-stage'))).toEqual([false,false,false,false,false,true]);
 const verdicts=Array.from(list.childNodes,(row:HTMLElement)=>{
  const verdict=row.childNodes[0] as HTMLElement;
  return [verdict.dataset.checkVerdict,verdict.textContent];
 });
 expect(verdicts).toEqual([
  ['unavailable','Producer check unavailable'],
  ['unavailable','Producer check unavailable · CHECK_REFUSED: no check document'],
  ['failed','Producer check failed · check: FAIL without a bar'],
  ['failed','Producer check failed · check: PASS then exited 1'],
  ['failed','Producer check failed · BREATH_VISIBLE: FAIL — torso_floor 3.809'],
  ['passed','Producer check passed'],
 ]);
});


test('#448 applied history exposes a new last row and preserves manual scrolling on refresh',()=>{
 const list=dom().element('applied-list','OL');
 const first={id:'first',kind:'patch',op:'rig',what:'first op',modelHash:'0123456789abcdef',kept:true} as const;
 const second={...first,id:'second',what:'second op'};
 const history:AppliedHistoryView={schema:'rig-review-applied-history/1',depth:1,records:[first]};
 renderAppliedHistory(list,history,'first');
 expect([list.scrollLeft,list.scrollTop]).toEqual([0,0]);
 const next={...history,depth:2,records:[first,second]};
 renderAppliedHistory(list,next,'second');
 expect([list.scrollLeft,list.scrollTop]).toEqual([160,48]);
 list.scrollLeft=25;
 list.scrollTop=17;
 renderAppliedHistory(list,next,'second');
 expect([list.scrollLeft,list.scrollTop]).toEqual([25,17]);
});
