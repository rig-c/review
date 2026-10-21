import {afterEach,expect,test} from 'bun:test';
import {bindRetargetPanel} from '../web/retarget-panel.ts';
import type {RetargetStatusView} from '../web/rebuild-client.ts';
import type {RetargetFlags} from '../src/retarget.ts';

/**
 * #186 item 1: the retarget panel's `clean first` flag follows the selected sequence — on when it is raw, off when it is
 * already cleaned — whenever the selection changes, not only on the first load. The panel runs on a minimal stand-in
 * DOM: elements with properties and children, and a select whose value falls back to its first option the way a
 * browser's does after its options are replaced.
 */
class FakeElement {
 children:FakeElement[]=[];attributes:Record<string,string>={};classList={toggle(){},add(){},remove(){}};style:Record<string,string>={};
 [key:string]:unknown;
 constructor(readonly tagName:string){}
 append(...nodes:unknown[]){for(const n of nodes)if(n instanceof FakeElement)this.children.push(n);}
 replaceChildren(...nodes:unknown[]){this.children=[];this.append(...nodes);}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
}
class FakeSelect extends FakeElement {
 private chosen:string|null=null;
 override replaceChildren(...nodes:unknown[]){this.chosen=null;super.replaceChildren(...nodes);}
 get value():string {const options=this.children.map(o=>String(o.value));return this.chosen!==null&&options.includes(this.chosen)?this.chosen:options[0]??'';}
 set value(v:string){this.chosen=v;}
}
const saved={document:(globalThis as Record<string,unknown>).document,input:(globalThis as Record<string,unknown>).HTMLInputElement};
afterEach(()=>{(globalThis as Record<string,unknown>).document=saved.document;(globalThis as Record<string,unknown>).HTMLInputElement=saved.input;});
function panelOnFakeDom(){
 const body=new FakeElement('div');
 (globalThis as Record<string,unknown>).HTMLInputElement=saved.input??class {};
 (globalThis as Record<string,unknown>).document={createElement:(tag:string)=>tag==='select'?new FakeSelect(tag):new FakeElement(tag),getElementById:(id:string)=>id==='retarget-body'?body:null,activeElement:null};
 const panel=bindRetargetPanel({apply:async()=>null,reset:()=>{},seek:()=>{}});
 const find=(id:string,from:FakeElement=body):FakeElement|null=>{if(from.id===id)return from;for(const c of from.children){const hit=find(id,c);if(hit)return hit;}return null;};
 const choose=(id:string)=>{const s=find('retarget-sequence')!;s.value=id;(s.onchange as ()=>void)();};
 const clean=()=>(panel.flags() as RetargetFlags).clean;
 return {panel,find,choose,clean};
}
const sequence=(id:string,cleaned:boolean)=>({id,label:id,path:`${id}.json`,cleaned,frames:3,people:[]});
const status=(sequences:ReturnType<typeof sequence>[]):RetargetStatusView=>({available:true,reason:null,producer:{package:'@rig-c/pose',version:'1.0.0'},compiler:{package:'@rig-c/compiler',version:'1.0.0'},rig:null,sequences,bones:[],animations:[]});

test('#186 item 1: switching from a cleaned sequence to a raw one turns clean on, and back off',()=>{
 const {panel,choose,clean}=panelOnFakeDom();
 panel.load(status([sequence('cleaned',true),sequence('raw',false)]),null);
 expect(panel.sequence()).toBe('cleaned');
 expect(clean()).toBeNull();
 // A raw sequence sent with clean: null is refused by the producer (POSE_NOT_CLEANED).
 choose('raw');
 expect(clean()).not.toBeNull();
 // An already-cleaned sequence is not cleaned again.
 choose('cleaned');
 expect(clean()).toBeNull();
});

test('#186 item 1: starting raw, a cleaned sequence turns clean off; a reload of the same selection keeps the reviewer\'s choice',()=>{
 const {panel,find,choose,clean}=panelOnFakeDom();
 const both=status([sequence('raw',false),sequence('cleaned',true)]);
 panel.load(both,null);
 expect(clean()).not.toBeNull();
 choose('cleaned');
 expect(clean()).toBeNull();
 // The reviewer ticks clean on the cleaned sequence; a status reload with the same selection does not undo it.
 (find('retarget-clean')!).checked=true;
 panel.load(both,null);
 expect(panel.sequence()).toBe('cleaned');
 expect(clean()).not.toBeNull();
 // A reload where the selected sequence is gone re-derives the flag for the one now selected.
 panel.load(status([sequence('raw',false)]),null);
 expect(panel.sequence()).toBe('raw');
 expect(clean()).not.toBeNull();
 panel.load(status([sequence('other',true)]),null);
 expect(clean()).toBeNull();
});
