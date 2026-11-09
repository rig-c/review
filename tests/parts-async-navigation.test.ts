import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {expect,test} from 'bun:test';
import {paintingRectangle} from '../src/parts-comparison.ts';
import {readFile} from 'node:fs/promises';

/** Run the actual reference painter, with only image completion and canvas calls controlled. */
async function referenceDriver(){
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('function partFrame('),end=source.indexOf('\nfunction renderFlags(',start),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));
 const pending:((image:unknown)=>void)[]=[],draws:number[]=[];const ctx={imageSmoothingEnabled:true,drawImage:(_image:unknown,x:number)=>draws.push(x)},canvas={width:0,height:0,getContext:()=>ctx};
 const scope={disposed:false,paintToken:1,state:{data:{rigSize:[200,200],painting:{sha256:'a'.repeat(64),width:200,height:200},items:[{x:10,y:5,w:8,h:9},{x:100,y:50,w:18,h:19}]},selected:0,bg:'green'},paintingImage:()=>new Promise(resolve=>pending.push(resolve)),$:()=>canvas,paintingRectangle,paintPaintingCrop:(_ctx:unknown,img:unknown,r:{x:number})=>ctx.drawImage(img,r.x)};
 const paint=new Function('scope',`with(scope){${code};return paintReference;}`)(scope) as (token?:number)=>Promise<void>;
 return {scope,pending,draws,canvas,paint};
}
test('#389 adopted P2: late A painting image cannot overwrite already completed selected B crop',async()=>{
 const h=await referenceDriver(),a=h.paint(1);h.scope.state.selected=1;h.scope.paintToken=2;const b=h.paint(2);
 h.pending[1]!({name:'B'});await b;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
 h.pending[0]!({name:'A'});await a;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
});

/** Actual parts paint orchestration/raster and comment host; only image delivery and raster calls are controlled. */
async function failedPaintDriver(){
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('let paintToken = 0'),end=source.indexOf('\nfunction renderComparison(',start),setup=source.slice(source.indexOf('function setupPartsComments():void'),source.indexOf('\nfunction renderCorrections():void',source.indexOf('function setupPartsComments():void'))),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end)+'\n'+setup);
 const nodes=new Map<string,any>();const node=(id:string)=>{if(!nodes.has(id)){const ctx={pixels:'',clearRect(){this.pixels='';}};nodes.set(id,{width:1,height:1,textContent:'',dataset:{},setAttribute(){},getContext:()=>ctx,replaceChildren(){}});}return nodes.get(id);};
 let host:any;const scope:any={settleReady:()=>{},disposed:false,mountActive:true,slots:{toolbar:{},stage:{dataset:{},setAttribute(){}}},host:{locked:()=>'open'},painting:0,commentUi:null,viewport:{fitCamera(){}},state:{data:{mode:'parts',rigSize:[100,100],painting:{width:100,height:100},items:[{name:'A',index:0,x:0,y:0,w:10,h:10},{name:'B',index:1,x:10,y:0,w:10,h:10}],flags:[]},selected:0,comparison:{mode:'overlay',opacity:.5},bg:'green',alpha:false,footprints:false,meshShown:new Set()},$:node,t:(s:string)=>s,itemImage:async(i:any)=>i.name,paintingImage:async()=>({}),frontParts:()=>[],setCanvas:(c:any,w:number,h:number)=>{c.width=w;c.height=h;c.getContext().pixels='';return c.getContext();},paintOverlay:(c:any,_i:any,img:any)=>{c.pixels=img;},paintPart:(c:any,_i:any,img:any)=>{c.pixels=img;},paintPaintingCrop:()=>{},paintFootprints:()=>{},paintingRectangle,doc:{createElement:()=>({})},query:()=>({}),stageEmbedded:false,bindStageComments:(h:any)=>{host=h;scope.boundHost=h;return {refresh(){}};}};
 const api=new Function('scope',`with(scope){${code};setupPartsComments();return {paint,host:()=>scope.boundHost};}`)(scope) as {paint:()=>Promise<void>;host:()=>any};
 // Keep the same scope object so controlled image failures can be replaced between generations.
 return {api,scope:scope as any,nodes,node};
}

for(const failed of ['painting','image'])test(`#391 adopted P2: failed ${failed} after A -> B clears old pixels and refuses capture/editing until successful repaint`,async()=>{
 const h=await failedPaintDriver();await h.api.paint();expect(h.node('pv-canvas').getContext().pixels).toBe('A');
 h.scope.state.selected=1;if(failed==='painting')h.scope.paintingImage=async()=>{throw Error('planted painting load');};else h.scope.itemImage=async()=>{throw Error('planted image load');};
 await h.api.paint().catch(()=>{});expect(h.node('pv-canvas').getContext().pixels).toBe('');expect(h.api.host().refusal()).toContain('PARTS_PAINT_FAILED');expect(h.api.host().blocked()).toBe(false);
 h.scope.paintingImage=async()=>({});h.scope.itemImage=async(i:any)=>i.name;await h.api.paint();expect(h.node('pv-canvas').getContext().pixels).toBe('B');expect(h.api.host().refusal()).toBeNull();expect(h.api.host().blocked()).toBe(false);
});

test('#391 adopted P2: an older failed painting generation cannot clear or refuse a newer successful view',async()=>{
 const h=await failedPaintDriver();await h.api.paint();let reject!:(e:Error)=>void;h.scope.state.selected=1;h.scope.paintingImage=()=>new Promise((_r:unknown,r:any)=>{reject=r;});const older=h.api.paint();for(let i=0;i<10&&!reject;i++)await Promise.resolve();expect(reject).toBeDefined();
 h.scope.state.selected=0;h.scope.paintingImage=async()=>({});await h.api.paint();expect(h.api.host().blocked()).toBe(false);reject(Error('late old load failure'));await older.catch(()=>{});
 expect(h.node('pv-canvas').getContext().pixels).toBe('A');expect(h.api.host().refusal()).toBeNull();expect(h.api.host().blocked()).toBe(false);
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
