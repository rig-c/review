/** Execute the moved production paint boundary with real server canvases and controllable source promises. */
import {expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {readFile} from 'node:fs/promises';
import {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop} from '../web/parts-render.ts';
import {paintingRectangle,defaultPartsComparison} from '../src/parts-comparison.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const raster=(color:string)=>{const canvas=createCanvas(8,8),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,8,8);return canvas;};
async function harness(withPainting=false){
 const source=await readFile(new URL('../web/parts-viewport-provider.ts',import.meta.url),'utf8'),start=source.indexOf(' async function paint():Promise<void>{'),end=source.indexOf(' const redraw=',start);
 const body=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end));
 const canvas=raster('#123456'),referenceCanvas=raster('#123456'),frames:unknown[]=[],messages:string[]=[],closed:number[]=[];
 const original=createCanvas(32,16),originalContext=original.getContext('2d');originalContext.fillStyle='#ff0000';originalContext.fillRect(0,0,16,16);originalContext.fillStyle='#00ff00';originalContext.fillRect(16,0,16,16);
 const paintingImage=Object.assign(original,{naturalWidth:32,naturalHeight:16});
 const data={mode:'parts',rigSize:[16,8],painting:withPainting?{width:32,height:16}:undefined,items:[{name:'a',index:0,x:0,y:0,w:8,h:8},{name:'b',index:1,x:8,y:0,w:8,h:8}]};
 let loader=(entry:{name:string})=>Promise.resolve(raster(entry.name==='a'?'#ff0000':'#00ff00'));
 let paintingLoader=()=>Promise.resolve(paintingImage);
 let request=async()=>new Response('pixels'),mesh=false;
 const nodes=new Map<string,{hidden:boolean;textContent:string;setAttribute():void}>();
 const host={data,canvas,referenceCanvas,images:()=>true,mesh:()=>mesh,el:(id:string)=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',setAttribute(){}});return nodes.get(id)!;},drawn:(state:unknown)=>frames.push(state),viewport:{fitCamera(){}},message:(value:string)=>messages.push(value),request:(path:string)=>request()};
 const api=new Function('host','data','image','painting','makeCanvas','deps',`
 let selected='a',solo=true,token=0,disposed=false,busy=false,failed=false,drawnFrame=null,drawnReferenceFrame=null,comparison={mode:'part',opacity:.5},comments=null;
 const {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,paintingRectangle,t,createImageBitmap}=deps;
 const hidden=new Set(),item=()=>data.items.find(entry=>entry.name===selected),assembled=()=>!solo,box=()=>assembled()?{x:0,y:0,w:16,h:8}:item();
 ${body}
 return {paint,select(name){selected=name},assemble(){solo=false},difference(){comparison={mode:'difference',opacity:.5,threshold:0}},dispose(){disposed=true;++token},referenceFrame:()=>drawnReferenceFrame,state:()=>({busy,failed,drawnFrame})};
 `)(host,data,(entry:{name:string})=>loader(entry),()=>paintingLoader(),(w:number,h:number)=>createCanvas(w,h),{paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,paintingRectangle,t:(key:string)=>key,createImageBitmap:async()=>{const bitmap=raster('#ff0000') as ReturnType<typeof raster>&{close:()=>void};const id=closed.length;bitmap.close=()=>closed.push(id);return bitmap;}}) as {paint():Promise<void>;select(name:string|null):void;assemble():void;difference():void;dispose():void;referenceFrame():{w:number;h:number}|null;state():{busy:boolean;failed:boolean;drawnFrame:{w:number;h:number}|null}};
 return {api,canvas,referenceCanvas,paintingImage,frames,messages,closed,data,setLoader(value:typeof loader){loader=value;},setPaintingLoader(value:typeof paintingLoader){paintingLoader=value;},setRequest(value:typeof request){request=value;},mesh(value:boolean){mesh=value;},pixel:()=>[...canvas.getContext('2d').getImageData(3,3,1,1).data],referencePixel:()=>[...referenceCanvas.getContext('2d').getImageData(3,3,1,1).data]};
}
test('#737 failed image clears old pixels and geometry; only a later successful draw restores loaded eligibility',async()=>{
 const h=await harness();await h.api.paint();expect(h.pixel()).toEqual([255,0,0,255]);const held=deferred<ReturnType<typeof raster>>();h.setLoader(()=>held.promise);const failed=h.api.paint();expect(h.api.state().busy).toBe(true);held.reject(new Error('source failed'));await expect(failed).rejects.toThrow('source failed');expect(h.pixel()).toEqual([0,0,0,0]);expect(h.api.state()).toEqual({busy:false,failed:true,drawnFrame:null});expect(h.frames.at(-1)).toEqual({state:'failed',reason:'source failed'});
 h.setLoader(()=>Promise.resolve(raster('#00ff00')));await h.api.paint();expect(h.pixel()).toEqual([0,255,0,255]);expect(h.api.state()).toEqual({busy:false,failed:false,drawnFrame:{w:8,h:8}});expect(h.frames.at(-1)).toEqual({state:'loaded'});
});
for(const late of ['resolve','reject']as const)test(`#737 stale ${late} cannot overwrite or refuse a newer selected part`,async()=>{
 const h=await harness(),held=deferred<ReturnType<typeof raster>>();h.setLoader(entry=>entry.name==='a'?held.promise:Promise.resolve(raster('#00ff00')));const old=h.api.paint();h.api.select('b');await h.api.paint();expect(h.pixel()).toEqual([0,255,0,255]);const before=[...h.frames];if(late==='resolve')held.resolve(raster('#ff0000'));else held.reject(new Error('late failure'));await old;expect(h.pixel()).toEqual([0,255,0,255]);expect(h.frames).toEqual(before);expect(h.api.state().failed).toBe(false);
});
test('#737 disposal during source decode never commits or reports a new loaded subject',async()=>{
 const h=await harness(),held=deferred<ReturnType<typeof raster>>();h.setLoader(()=>held.promise);const old=h.api.paint();h.api.dispose();held.resolve(raster('#ff0000'));await old;expect(h.pixel()).toEqual([18,52,86,255]);expect(h.frames).toEqual([]);
});
test('#737 Difference releases every acquired bitmap after a later layer fails',async()=>{
 const h=await harness();h.api.assemble();h.api.difference();let calls=0;h.setRequest(async()=>{if(++calls===2)throw new Error('second difference failed');return new Response('pixels');});await expect(h.api.paint()).rejects.toThrow('second difference failed');expect(h.closed).toHaveLength(1);expect(h.api.state().drawnFrame).toBeNull();expect(h.pixel()).toEqual([0,0,0,0]);
});
test('#737 Mesh edges tint comes from real art alpha and disappears completely when the existing layer is off',async()=>{
 const h=await harness();Object.assign(h.data.items[0]!,{mesh:{vertices:[0,0,1,0,0,1],triangles:[0,1,2]}});await h.api.paint();const off=h.pixel();h.mesh(true);await h.api.paint();const on=h.pixel();expect(on).not.toEqual(off);expect(on[2]).toBeGreaterThan(0);h.mesh(false);await h.api.paint();expect(h.pixel()).toEqual(off);
});

test('#742 selected reference follows the producer box even in assembled mode; Whole restores original dimensions and pixels',async()=>{
 const h=await harness(true);h.api.assemble();await h.api.paint();expect(h.api.state().drawnFrame).toEqual({w:16,h:8});expect(h.api.referenceFrame()).toEqual({w:8,h:8});expect(h.referencePixel()).toEqual([255,0,0,255]);
 h.api.select('b');await h.api.paint();expect(h.referencePixel()).toEqual([0,255,0,255]);expect(h.api.state().drawnFrame).toEqual({w:16,h:8});
 h.api.select(null);await h.api.paint();expect(h.api.referenceFrame()).toEqual({w:32,h:16});expect(h.referenceCanvas.toBuffer('image/png')).toEqual(h.paintingImage.toBuffer('image/png'));
});
test('#742 fractional crop uses continuous whole-canvas geometry and actual truncated canvas dimensions',async()=>{
 const h=await harness(true);Object.assign(h.data.items[0]!,{x:7.125,y:.375,w:5.75,h:6.5});await h.api.paint();
 const expected=createCanvas(5,6);paintPaintingCrop(expected.getContext('2d') as never,h.paintingImage as never,{x:14.25,y:.75,width:11.5,height:13},5.75,6.5,'checker');
 expect(h.api.referenceFrame()).toEqual({w:5,h:6});expect(h.referenceCanvas.toBuffer('image/png')).toEqual(expected.toBuffer('image/png'));
});
for(const late of ['resolve','reject','dispose']as const)test(`#742 delayed original ${late} never publishes stale reference pixels or geometry`,async()=>{
 const h=await harness(true),held=deferred<typeof h.paintingImage>(),entered=deferred<void>();h.setPaintingLoader(()=>{entered.resolve();return held.promise;});const old=h.api.paint();await entered.promise;
 h.setPaintingLoader(()=>Promise.resolve(h.paintingImage));h.api.select('b');await h.api.paint();const frame=h.api.referenceFrame(),pixels=h.referenceCanvas.toBuffer('image/png');
 if(late==='dispose')h.api.dispose();if(late==='reject')held.reject(new Error('old original failed'));else held.resolve(h.paintingImage);await old;
 expect(h.api.referenceFrame()).toEqual(frame);expect(h.referenceCanvas.toBuffer('image/png')).toEqual(pixels);expect(h.referencePixel()).toEqual([0,255,0,255]);
});
test('#742 original failure clears both old panes and their frames',async()=>{
 const h=await harness(true);await h.api.paint();h.setPaintingLoader(()=>Promise.reject(new Error('original failed')));await expect(h.api.paint()).rejects.toThrow('original failed');
 expect(h.pixel()).toEqual([0,0,0,0]);expect(h.referencePixel()).toEqual([0,0,0,0]);expect(h.api.referenceFrame()).toBeNull();expect(h.api.state().drawnFrame).toBeNull();
});
