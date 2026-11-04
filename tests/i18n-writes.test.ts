import {afterEach,expect,test} from 'bun:test';
import {bindDomI18n,getLanguagePreference,setLanguagePreference,setSourceAttribute,setSourceText,sourceAttribute,sourceTextContent,tr,unbindDomI18n} from '../web/i18n.ts';
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
 const element=(id:string,tag='SPAN',initial='')=>{
  const attrs=new Map<string,string>();
  const el:any={nodeType:1,id,tagName:tag,className:'',parentElement:null,childNodes:[],classList:{contains:()=>false},closest:()=>null,querySelectorAll:()=>[],
   getAttribute:(n:string)=>attrs.get(n)??null,setAttribute:(n:string,v:string)=>{writes++;attrs.set(n,v);records.push({type:'attributes',target:el,attributeName:n,addedNodes:[]});},
   get textContent(){return el.childNodes.map((n:any)=>n.nodeValue).join('');},
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
