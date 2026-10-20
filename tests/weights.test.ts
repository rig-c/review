import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCanvas,Image} from '@napi-rs/canvas';
import {loadModel,type ModelAssets} from '@rig-c/play';
import {loadReview} from '../src/manifest.ts';
import {WEIGHTS_MODEL_UNAVAILABLE,dominantInfluence,meshWeights,rampColor,weightOf} from '../src/weights.ts';
import {RigOverlays} from '../web/rig-overlays.ts';
import {hitVertex,setupPoseMesh,weightsOverlay,type WeightsMode} from '../web/weights-view.ts';

const base=new URL('./fixtures/strip-probe/build/',import.meta.url);
/** Stored weights of the derived fixture: vertex i is `mesh` at W[i] and `root` at 1 − W[i], placed where the unweighted mesh sits. */
const W=[.25,.625,.875,.0625];
async function documents(){
 const plain=JSON.parse(await readFile(new URL('skeleton.model.json',base),'utf8'));
 const weighted=structuredClone(plain),mesh=weighted.skins[0].attachments.mesh.mesh,xy:number[]=mesh.vertices.xy;
 // The mesh bone sits at (18, 0) under root; a root binding at (x + 18, y) has the same setup world position.
 mesh.vertices={weighted:true,bindings:W.map((w,i)=>[{bone:'mesh',x:xy[i*2],y:xy[i*2+1],weight:w},{bone:'root',x:xy[i*2]!+18,y:xy[i*2+1],weight:1-w}])};
 return {plain,weighted};
}
const ramp=['#000000','#808080','#ffffff'],boneColors=['#ff0000','#00ff00'],colors={veil:'rgba(0,0,0,0)',edge:'#123456',ink:'#010101',labelBg:'#202020',hover:'#fefefe'};

/** The published loader and player over an in-memory model document (native canvas; the fixture's own pages). */
async function load(doc:unknown):Promise<{assets:ModelAssets;dispose:()=>void}> {
 const pageBytes=new Map<string,Buffer>();for(const name of ['rigid.png','mesh.png'])pageBytes.set('https://weights.invalid/'+name,await readFile(new URL(name,base)));
 const globals=globalThis as unknown as Record<string,unknown>,saved=new Map(['document','Image'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const restore=()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globals[key];};
 const src=Object.getOwnPropertyDescriptor(Image.prototype,'src')!;
 class LocalImage extends Image {}
 Object.defineProperty(LocalImage.prototype,'src',{get(){return src.get!.call(this);},set(value:unknown){const image=typeof value==='string'?pageBytes.get(value):undefined;if(!image)throw new Error('Undeclared fixture image');src.set!.call(this,image);}});
 globals.Image=LocalImage;
 globals.document={baseURI:'https://weights.invalid/',createElement(tag:string){if(tag!=='canvas')throw new Error('Unexpected native host element '+tag);return Object.assign(createCanvas(1,1),{style:{},remove(){}});}};
 const bytes=new TextEncoder().encode(JSON.stringify(doc));
 try{
  const assets=await loadModel({modelUrl:'https://weights.invalid/skeleton.model.json',setsUrl:null,regions:'none',resolvePage:name=>'https://weights.invalid/'+name,fetch:new Proxy(fetch,{apply:(_t,_s,args:Parameters<typeof fetch>)=>String(args[0])==='https://weights.invalid/skeleton.model.json'?Promise.resolve(new Response(bytes)):Promise.reject(new Error('Undeclared fixture fetch'))})});
  return {assets,dispose(){try{assets.dispose();}finally{restore();}}};
 }catch(error){restore();throw error;}
}
const root=()=>({style:{clipPath:''},appendChild(node:unknown){return node;}}) as unknown as HTMLElement;
function overlayOf(doc:unknown,assets:ModelAssets,mode:WeightsMode,bone:string|null,hover:number|null=null){
 const setup=setupPoseMesh(assets,doc,'mesh',root(),'canvas');if(!setup.ok)throw new Error(setup.code);
 const result=weightsOverlay({weights:setup.weights,mesh:setup.mesh,mode,bone,hover,ramp,boneColors,colors});if(!result.ok)throw new Error(result.code);
 return {overlay:result.overlay,weights:setup.weights,setup:setup.mesh};
}

test('bar 1: every drawn vertex weight is the model document\'s stored weight for the picked bone, and its pixel is that weight on the ramp',async()=>{
 const {weighted}=await documents(),{assets,dispose}=await load(weighted);
 try{
  const {overlay,weights,setup}=overlayOf(weighted,assets,'bone','mesh');
  expect(weights).toMatchObject({slot:'mesh',skin:'default',attachment:'mesh',weighted:true,bones:['mesh','root']});
  expect(setup.identity).toEqual({skin:'default',attachment:'mesh'});
  const stored=weighted.skins[0].attachments.mesh.mesh.vertices.bindings as {bone:string;weight:number}[][];
  expect(overlay.vertices.map(v=>v.value)).toEqual(stored.map(row=>row.find(b=>b.bone==='mesh')!.weight));
  expect(overlay.vertices.map(v=>v.value)).toEqual(W);
  expect(overlayOf(weighted,assets,'bone','root').overlay.vertices.map(v=>v.value)).toEqual(W.map(w=>1-w));
  expect(overlayOf(weighted,assets,'bone','rigid').overlay.vertices.map(v=>v.value)).toEqual([0,0,0,0]);
  // Setup-pose world positions from the published player: the mesh bone at (18, 0), local corners ±10.
  expect(overlay.vertices.map(v=>[Math.round(v.at.x*1e4)/1e4,Math.round(v.at.y*1e4)/1e4])).toEqual([[8,-10],[8,10],[28,10],[28,-10]]);
  expect(overlay.vertices[1]!.label).toBe('#1 mesh 0.625');
  // Drawn: the dot's centre pixel is the ramp colour of the stored weight.
  const surface=createCanvas(400,300);Object.assign(surface,{style:{pointerEvents:'auto'},clientWidth:400,clientHeight:300});
  const host={canvas:surface as unknown as HTMLCanvasElement,rigRoot:{style:{visibility:'visible'}} as unknown as HTMLElement};
  const layers=new RigOverlays(host),project=(x:number,y:number)=>({x:180+x*4,y:150-y*4});
  layers.refresh({player:{posedFrame:()=>({order:[]}),bone:()=>{throw new Error('no bones');}},bones:[],project,settings:{images:true,mesh:false,bones:false,meshOpacity:1},dpr:1,weights:overlay});
  const data=surface.getContext('2d').getImageData(0,0,400,300).data;
  for(const v of overlay.vertices){
   const p=project(v.at.x,v.at.y),at=(Math.round(p.y)*400+Math.round(p.x))*4,expected=rampColor(ramp,weightOf(weights.vertices[v.index]!,'mesh'))!;
   expect(`rgb(${data[at]}, ${data[at+1]}, ${data[at+2]})`).toBe(expected);
  }
  layers.dispose();
 }finally{dispose();}
});

test('an unweighted mesh is its slot\'s bone at 1.0, by name',async()=>{
 const {plain}=await documents(),{assets,dispose}=await load(plain);
 try{
  const {overlay,weights}=overlayOf(plain,assets,'bone','mesh');
  expect(weights).toMatchObject({weighted:false,bones:['mesh']});expect(weights.vertices).toEqual([[-10,-10],[-10,10],[10,10],[10,-10]].map(([x,y])=>[{bone:'mesh',x,y,weight:1}]));
  expect(overlay.vertices.map(v=>v.label)).toEqual(['#0 mesh 1.0','#1 mesh 1.0','#2 mesh 1.0','#3 mesh 1.0']);
 }finally{dispose();}
});

test('max influence colours each vertex by its dominant stored bone; hover finds the vertex under the pointer',async()=>{
 const {weighted}=await documents(),{assets,dispose}=await load(weighted);
 try{
  const {overlay}=overlayOf(weighted,assets,'max',null,2);
  expect(overlay.vertices.map(v=>v.label)).toEqual(['#0 max root 0.75','#1 max mesh 0.625','#2 max mesh 0.875','#3 max root 0.9375']);
  expect(overlay.vertices.map(v=>v.color)).toEqual(['#00ff00','#ff0000','#ff0000','#00ff00']);
  expect(dominantInfluence([{bone:'a',weight:.5},{bone:'b',weight:.5}])).toEqual({bone:'a',weight:.5});
  expect(overlay.hover).toBe(2);
  const project=(x:number,y:number)=>({x:180+x*4,y:150-y*4});
  expect(hitVertex(overlay,project,{x:180+28*4+3,y:150-10*4-2})).toBe(2);
  expect(hitVertex(overlay,project,{x:180+18*4,y:150})).toBeNull();
 }finally{dispose();}
});

test('bar 2: a package without the compiled model document refuses WEIGHTS_MODEL_UNAVAILABLE',async()=>{
 const demo=await loadReview(join(import.meta.dir,'../examples/demo/review.json'));
 expect(demo.manifest.model).toBeUndefined();
 const result=meshWeights(demo.manifest.model?{}:null,'mesh',null);
 expect(result.ok).toBe(false);expect(result.ok?'':result.code.split(':')[0]).toBe(WEIGHTS_MODEL_UNAVAILABLE);
 expect(meshWeights({spec:'other'},'mesh',null)).toMatchObject({ok:false});
 // The view's own path: no rig is posed for a package without the document.
 const assets=null as unknown as ModelAssets;expect(setupPoseMesh(assets,null,'mesh',root())).toMatchObject({ok:false,code:expect.stringMatching(/^WEIGHTS_MODEL_UNAVAILABLE: /)});
});
