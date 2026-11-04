import {expect,test} from 'bun:test';
import {setSourceAttribute,setSourceText,sourceAttribute,tr} from '../web/i18n.ts';

// #347: Animate writes English source text on every played frame; these keep an unchanged write from reaching the DOM.
function textElement(value:string){
 const node={nodeType:3,nodeValue:value,parentElement:null};
 let writes=0;
 const el={childNodes:[node],get textContent(){return node.nodeValue;},set textContent(v:string){writes++;node.nodeValue=v;}};
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
