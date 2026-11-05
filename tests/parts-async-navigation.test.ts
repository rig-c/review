import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';

/** Run the actual reference painter, with only image completion and canvas calls controlled. */
async function referenceDriver(){
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('async function paintReference('),end=source.indexOf('\nfunction renderFlags(',start),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));
 const pending:((image:unknown)=>void)[]=[],draws:number[]=[];const ctx={imageSmoothingEnabled:true,drawImage:(_image:unknown,x:number)=>draws.push(x)},canvas={width:0,height:0,getContext:()=>ctx};
 const scope={paintToken:1,state:{data:{painting:{sha256:'a'.repeat(64)},items:[{x:10,y:5,w:8,h:9},{x:100,y:50,w:18,h:19}]},selected:0,bg:'green'},load:()=>new Promise(resolve=>pending.push(resolve)),$:()=>canvas,paintBackground:()=>{}};
 const paint=new Function('scope',`with(scope){${code};return paintReference;}`)(scope) as (token?:number)=>Promise<void>;
 return {scope,pending,draws,canvas,paint};
}
test('#389 adopted P2: late A painting image cannot overwrite already completed selected B crop',async()=>{
 const h=await referenceDriver(),a=h.paint(1);h.scope.state.selected=1;h.scope.paintToken=2;const b=h.paint(2);
 h.pending[1]!({name:'B'});await b;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
 h.pending[0]!({name:'A'});await a;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
});

/** Actual pan binder with event/capture surfaces substituted; independent background control stays pannable. */
test('#389 adopted P2: explicitly marked atlas action retains its click target; background still captures and pans',async()=>{
 const source=await readFile('web/view-controls.ts','utf8'),start=source.indexOf('const panVideoOverrides='),end=source.indexOf('export function bindInspectorTabs(',start),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end).replace('export function','function'));
 class Node{
  style={};dataset:Record<string,string>={};handlers=new Map<string,Function[]>();captured=new Set<number>();
  constructor(readonly action=false){}closest(selector:string){return this.action&&selector.includes('[data-viewport-action]')?this:null;}querySelectorAll(){return [];}addEventListener(k:string,f:Function){this.handlers.set(k,[...this.handlers.get(k)??[],f]);}removeEventListener(){}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
  emit(k:string,values:object){for(const f of this.handlers.get(k)??[])f({button:0,isPrimary:true,pointerId:7,clientX:20,clientY:30,preventDefault(){},...values});}
 }
 class Observer{observe(){}disconnect(){}}
 const doc=new Node(),win=new Node(),pane=new Node(),moves:number[][]=[];const bind=new Function('window','document','Element','MutationObserver',code+';return bindPan;')(win,doc,Node,Observer),dispose=bind(pane,(x:number,y:number)=>moves.push([x,y]));
 try{pane.emit('pointerdown',{target:new Node(true)});expect(pane.captured.size).toBe(0);pane.emit('pointermove',{target:new Node(true),clientX:50,clientY:70});expect(moves).toEqual([]);
 pane.emit('pointerdown',{target:pane});expect(pane.captured.has(7)).toBe(true);pane.emit('pointermove',{target:pane,clientX:50,clientY:70});expect(moves).toEqual([[30,40]]);
 const parts=await readFile('web/parts.ts','utf8');expect(parts).toContain("box.dataset.viewportAction = 'select-region'");
 }finally{dispose();}
});
