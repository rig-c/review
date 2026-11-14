/** Execute the moved production paint boundary with real server canvases and controllable source promises. */
import {expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {readFile} from 'node:fs/promises';
import {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,pickAssembly} from '../web/parts-render.ts';
import {paintingRectangle,defaultPartsComparison} from '../src/parts-comparison.ts';
import {createViewportController,createViewportState,type ViewportController} from '../web/viewport-controller.ts';
import {createPartsViewportProvider} from '../web/parts-viewport-provider.ts';
import {parsePartsIssue,assertPartsIssueBinding,snapImageRegion,type PartsIssue} from '../src/parts-comment.ts';
import {unprojectMark,region} from '../src/stage-comment.ts';
import {EMIT_UNPINNED_CREATE_FIELDS} from '../src/create-pin-gate.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const raster=(color:string)=>{const canvas=createCanvas(8,8),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,8,8);return canvas;};
async function harness(withPainting=false){
 const source=await readFile(new URL('../web/parts-viewport-provider.ts',import.meta.url),'utf8'),start=source.indexOf(' async function paint():Promise<void>{'),end=source.indexOf(' const redraw=',start);
 const body=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end));
 const alphaStart=source.indexOf(' const sourceAlpha='),alphaEnd=source.indexOf('\n const painting=',alphaStart),alphaBody=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(alphaStart,alphaEnd));
 const chipsStart=source.indexOf('  chips:(pose,screen,existing)=>{'),chipsEnd=source.indexOf('  create:async',chipsStart),chipsBody=new Bun.Transpiler({loader:'ts'}).transformSync('const chips='+source.slice(chipsStart+'  chips:'.length,chipsEnd).trim().replace(/,$/,''));
 const frameStart=source.indexOf('  frameSize:(target:CameraTarget):PartsFrame|null=>{'),frameEnd=source.indexOf('  image:',frameStart),frameBody=new Bun.Transpiler({loader:'ts'}).transformSync('const frameSize='+source.slice(frameStart+'  frameSize:'.length,frameEnd).trim().replace(/,$/,''));
 const poseStart=source.indexOf(' const pose=():PartsPose|null=>{'),poseEnd=source.indexOf(' comments=bindStageComments',poseStart),poseBody=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(poseStart,poseEnd));
 const restoreStart=source.indexOf('  restore:async raw=>'),restoreEnd=source.indexOf(',\n  feedback:',restoreStart),restoreBody=new Bun.Transpiler({loader:'ts'}).transformSync('const restore='+source.slice(restoreStart+'  restore:'.length,restoreEnd));
 const canvas=raster('#123456'),referenceCanvas=raster('#123456'),frames:unknown[]=[],messages:string[]=[],closed:number[]=[];
 const original=createCanvas(32,16),originalContext=original.getContext('2d');originalContext.fillStyle='#ff0000';originalContext.fillRect(0,0,16,16);originalContext.fillStyle='#00ff00';originalContext.fillRect(16,0,16,16);
 const paintingImage=Object.assign(original,{naturalWidth:32,naturalHeight:16});
 const data={sourceHash:'1'.repeat(64),mode:'parts',rigSize:[16,8],painting:withPainting?{width:32,height:16}:undefined,items:[{name:'a',imageHash:'2'.repeat(64),index:0,x:0,y:0,w:8,h:8},{name:'b',imageHash:'3'.repeat(64),index:1,x:8,y:0,w:8,h:8}]};
 let loader=(entry:{name:string;w:number;h:number})=>Promise.resolve(raster(entry.name==='a'?'#ff0000':'#00ff00'));
 let paintingLoader=()=>Promise.resolve(paintingImage);
 let request=async()=>new Response('pixels'),mesh=false;
 const nodes=new Map<string,{hidden:boolean;textContent:string;setAttribute():void}>();
 const host={data,canvas,referenceCanvas,restoreMesh:(value:boolean)=>{mesh=value;},selectionChanged(){},images:()=>true,mesh:()=>mesh,el:(id:string)=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',setAttribute(){}});return nodes.get(id)!;},drawn:(state:unknown)=>frames.push(state),viewport:{state:{cameraSync:true},requestFit(){},fitCamera(){}},message:(value:string)=>messages.push(value),request:(path:string)=>request()};
 const api=new Function('host','data','image','painting','makeCanvas','deps',`
 let selected='a',solo=true,token=0,disposed=false,busy=false,failed=false,drawnFrame=null,drawnReferenceFrame=null,drawnRegion=null,drawnSolo=false,comparison={mode:'part',opacity:.5},comments=null;
 const loaded=new Map(),assemblyAlpha=new Map();
 const {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,pickAssembly,paintingRectangle,defaultPartsComparison,t,createImageBitmap,parsePartsIssue,assertPartsIssueBinding,snapImageRegion,unprojectMark,region,EMIT_UNPINNED_CREATE_FIELDS}=deps;
 const sourceItems=()=>new Map(data.items.map(item=>[item.name,item]));
 const hidden=new Set(),item=()=>data.items.find(entry=>entry.name===selected),assembled=()=>!solo,box=()=>assembled()?{x:0,y:0,w:data.rigSize[0],h:data.rigSize[1]}:item();
 ${alphaBody}
 ${body}
 ${chipsBody}
 ${frameBody}
 ${poseBody}
 ${restoreBody}
 return {chips,restore,pose,frameSize,paint,select(name){selected=name},show(name,on){if(on)hidden.delete(name);else hidden.add(name)},assemble(){solo=false},difference(){comparison={mode:'difference',opacity:.5,threshold:0}},dispose(){disposed=true;++token},referenceFrame:()=>drawnReferenceFrame,state:()=>({busy,failed,drawnFrame})};
 `)(host,data,(entry:{name:string;w:number;h:number})=>loader(entry),()=>paintingLoader(),(w:number,h:number)=>createCanvas(w,h),{paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,pickAssembly,paintingRectangle,defaultPartsComparison,parsePartsIssue,assertPartsIssueBinding,snapImageRegion,unprojectMark,region,EMIT_UNPINNED_CREATE_FIELDS,t:(key:string)=>key,createImageBitmap:async()=>{const bitmap=raster('#ff0000') as ReturnType<typeof raster>&{close:()=>void};const id=closed.length;bitmap.close=()=>closed.push(id);return bitmap;}}) as {chips(pose:any,screen:{x:number;y:number;width:number;height:number},existing?:unknown):{selected:string[];candidates:string[]};restore(raw:unknown):Promise<void>;pose():any;frameSize(target:'rig'|'reference'):{w:number;h:number;world?:{box:{x:number;y:number;width:number;height:number};origin:{x:number;y:number};scale:{x:number;y:number}}}|null;paint():Promise<void>;select(name:string|null):void;show(name:string,on:boolean):void;assemble():void;difference():void;dispose():void;referenceFrame():{w:number;h:number}|null;state():{busy:boolean;failed:boolean;drawnFrame:{w:number;h:number}|null}};
 return {api,canvas,referenceCanvas,paintingImage,setViewport(value:ViewportController){host.viewport=value;},frames,messages,closed,data,setLoader(value:typeof loader){loader=value;},setPaintingLoader(value:typeof paintingLoader){paintingLoader=value;},setRequest(value:typeof request){request=value;},mesh(value:boolean){mesh=value;},pixel:()=>[...canvas.getContext('2d').getImageData(3,3,1,1).data],referencePixel:()=>[...referenceCanvas.getContext('2d').getImageData(3,3,1,1).data]};
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
 h.api.select(null);await h.api.paint();expect(h.api.referenceFrame()).toEqual({w:32,h:16});expect(h.api.frameSize('reference')!.world).toEqual({box:{x:0,y:0,width:16,height:8},origin:{x:0,y:0},scale:{x:.5,y:.5}});expect(h.referenceCanvas.toBuffer('image/png')).toEqual(h.paintingImage.toBuffer('image/png'));
});
test('#742 fractional crop uses continuous whole-canvas geometry and actual truncated canvas dimensions',async()=>{
 const h=await harness(true);Object.assign(h.data.items[0]!,{x:7.125,y:.375,w:5.75,h:6.5});await h.api.paint();
 const expected=createCanvas(5,6);paintPaintingCrop(expected.getContext('2d') as never,h.paintingImage as never,{x:14.25,y:.75,width:11.5,height:13},5.75,6.5,'checker');
 expect(h.api.referenceFrame()).toEqual({w:5,h:6});expect(h.api.frameSize('reference')!.world).toEqual({box:{x:7.125,y:.375,width:5.75,height:6.5},origin:{x:7.125,y:.375},scale:{x:1,y:1}});expect(h.referenceCanvas.toBuffer('image/png')).toEqual(expected.toBuffer('image/png'));
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


for(const mode of ['item','assembled']as const)test(`#742 restores ${mode} comment from Reference-active navigation and preserves local/world camera round trip`,async()=>{
 const h=await harness(true),entry=h.data.items[0]!;Object.assign(entry,{name:'topwear',x:788,y:290,w:408,h:563});h.data.rigSize=[1920,1080];
 const nodes=new Map<string,any>(),el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:655,clientHeight:471,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const state=createViewportState(),c=createViewportController(createPartsViewportProvider({el,canvas:h.canvas as never,reference:()=>h.referenceCanvas as never,frameSize:target=>h.api.frameSize(target==='rig'?'rig':'reference'),message(){}},state),state);
 h.setViewport(c);h.api.select(entry.name);if(mode==='assembled')h.api.assemble();await h.api.paint();
 const local={zoom:2,center:mode==='item'?{x:204,y:281.5}:{x:992,y:571.5},viewport:{width:655,height:471}},cropHash='4'.repeat(64);
 const issue:PartsIssue={schema:'rig-review-parts-comment/2',id:'restore-roundtrip',summary:'Saved pointed inspection',parts:[{name:entry.name,imageHash:entry.imageHash}],sourceHash:h.data.sourceHash,imageRegion:mode==='item'?{x:2,y:3,width:8,height:9}:null,rigRegion:{x:790,y:293,width:8,height:9},view:{mode,camera:local,cameraSync:true,referenceCamera:null,background:'checker',alpha:false,footprints:false,mesh:false},crop:{path:`comment-crops/${cropHash}.png`,sha256:cropHash,width:4,height:5},nativeCrop:null};
 c.panCamera('reference',23,17);expect(c.state.activeCamera).toBe('reference');const navigated=structuredClone(c.paneCamera('reference'));
 await h.api.restore(issue);const expected={zoom:2,center:{x:992,y:571.5}};
 expect(c.paneCamera('rig')).toEqual(expected);expect(c.paneCamera('reference')).toEqual(expected);expect(c.paneCamera('reference')).not.toEqual(navigated);expect(c.state.activeCamera).toBe('rig');
 const pose=h.api.pose();expect(pose.view.camera).toEqual(local);expect(pose.camera.center).toEqual(local.center);expect(pose.view.mode).toBe(mode);
 // Round-trip the actual production pose's camera through the actual restore callback while Reference is active again.
 c.panCamera('reference',-11,9);await h.api.restore({...issue,view:{...issue.view,camera:pose.view.camera}});expect(c.paneCamera('rig')).toEqual(expected);expect(h.api.pose().view.camera).toEqual(local);
 // OFF retains the independent peer even when restoring a Solo-local camera into rig-world coordinates.
 c.setCameraSync(false);c.panCamera('reference',7,5);const independent=structuredClone(c.paneCamera('reference'));await h.api.restore(issue);expect(c.paneCamera('rig')).toEqual(expected);expect(c.paneCamera('reference')).toEqual(independent);expect(h.api.pose().view.camera).toEqual(local);
 expect(issue.imageRegion).toEqual(mode==='item'?{x:2,y:3,width:8,height:9}:null);expect(issue.rigRegion).toEqual({x:790,y:293,width:8,height:9});
});

test('#843 assembled comment chips preselect visible intersecting parts in draw order while preserving item and existing paths',async()=>{
 const h=await harness();
 h.data.rigSize=[64,64];
 h.data.items=[
  {name:'back_defect',imageHash:'1'.repeat(64),index:0,x:2,y:10,w:32,h:48},
  {name:'back_control',imageHash:'2'.repeat(64),index:1,x:34,y:10,w:28,h:48},
  {name:'front',imageHash:'3'.repeat(64),index:2,x:14,y:14,w:32,h:32},
 ];
 h.setLoader(entry=>{const c=createCanvas(entry.w,entry.h),ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,entry.w,entry.h);return Promise.resolve(c);});
 const nodes=new Map<string,any>(),el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:64,clientHeight:64,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const state=createViewportState(),c=createViewportController(createPartsViewportProvider({el,canvas:h.canvas as never,reference:()=>null,frameSize:target=>h.api.frameSize(target==='rig'?'rig':'reference'),message(){}},state),state);
 h.setViewport(c);h.api.select('back_defect');await h.api.paint();c.unitScaleCamera('rig');
 expect(h.api.chips(h.api.pose(),{x:12,y:12,width:13,height:12})).toEqual({selected:['back_defect'],candidates:[]});
 h.api.assemble();await h.api.paint();c.unitScaleCamera('rig');
 expect(h.api.chips(h.api.pose(),{x:12,y:12,width:13,height:12})).toEqual({selected:['back_defect','front'],candidates:['back_defect','back_control','front']});
 expect(h.api.chips(h.api.pose(),{x:50,y:20,width:6,height:6})).toEqual({selected:['back_control'],candidates:['back_defect','back_control','front']});
 expect(h.api.chips(h.api.pose(),{x:0,y:0,width:2,height:2})).toEqual({selected:[],candidates:['back_defect','back_control','front']});
 const cropHash='4'.repeat(64),existing:PartsIssue={schema:'rig-review-parts-comment/2',id:'existing-assembled',summary:'Saved seam',parts:[{name:'back_control',imageHash:'2'.repeat(64)},{name:'front',imageHash:'3'.repeat(64)}],sourceHash:h.data.sourceHash,imageRegion:null,rigRegion:{x:12,y:12,width:13,height:12},view:{mode:'assembled',camera:{zoom:1,center:{x:32,y:32},viewport:{width:64,height:64}},cameraSync:false,referenceCamera:null,background:'checker',alpha:false,footprints:false,mesh:false},crop:{path:`comment-crops/${cropHash}.png`,sha256:cropHash,width:13,height:12},nativeCrop:null};
 expect(h.api.chips(h.api.pose(),{x:12,y:12,width:13,height:12},existing)).toEqual({selected:['back_control','front'],candidates:['back_defect','back_control','front']});
 h.api.show('front',false);await h.api.paint();c.unitScaleCamera('rig');
 expect(h.api.chips(h.api.pose(),{x:12,y:12,width:13,height:12})).toEqual({selected:['back_defect'],candidates:['back_defect','back_control']});
 h.data.items.push({name:'fractional_front',imageHash:'5'.repeat(64),index:3,x:40.25,y:20.5,w:5.75,h:6.5});
 await h.api.paint();c.unitScaleCamera('rig');
 expect(h.api.chips(h.api.pose(),{x:41,y:22,width:2,height:2})).toEqual({selected:['fractional_front'],candidates:['back_defect','back_control','fractional_front']});
});
