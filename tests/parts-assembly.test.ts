import {test,expect} from 'bun:test';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as renderer from '../web/parts-render.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';

test('#381 exact fractional assembly equals independent source-over draw; placement and order plants are detected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'assembly-'));
 try{
 const f=await writeComparisonPackage(root),layers=await Promise.all([f.body,f.front].map(async(b,index)=>({box:{...b,index,x:b.x+.125,y:b.y+.375},image:await loadImage(await readFile(join(root,'parts',b.name+'.png')))})));
 const expected=createCanvas(32,24),e=expected.getContext('2d');e.imageSmoothingEnabled=false;e.fillStyle='#00ff00';e.fillRect(0,0,32,24);
 // Independent oracle: explicit fixture placement/order, no production placement helper.
 e.drawImage(layers[0]!.image,4.125,4.375);e.drawImage(layers[1]!.image,14.125,8.375);
 const render=(ls:typeof layers)=>{const c=createCanvas(32,24);renderer.paintAssembly(c.getContext('2d') as never,32,24,ls as never,{bg:'green',alpha:false});return Buffer.from(c.getContext('2d').getImageData(0,0,32,24).data);};
 const oracle=Buffer.from(e.getImageData(0,0,32,24).data);
 expect(render(layers)).toEqual(oracle);expect(render(layers)).toEqual(render(layers));
 expect(render(layers.map((l,i)=>i?l:{...l,box:{...l.box,x:5.125}}))).not.toEqual(oracle);
 expect(render([...layers].reverse())).not.toEqual(oracle);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#381 frontmost nonzero alpha picking skips holes and hidden layers, retaining fractional placement',()=>{
 const back={name:'back',index:0,x:.125,y:.375,w:3,h:3},front={...back,name:'front',index:1};
 const layers=[{box:back,alpha:new Uint8ClampedArray(9).fill(255)},{box:front,alpha:Uint8ClampedArray.from([0,1,255,0,0,255,255,255,255])}];
 expect(renderer.pickAssembly(layers,.625,.875)).toBe(back);
 expect(renderer.pickAssembly(layers,1.625,.875)).toBe(front);
 expect(renderer.pickAssembly(layers,1.625,.875,new Set(['front']))).toBe(back);
 expect(renderer.pickAssembly(layers,1.625,.875,new Set(['back','front']))).toBeNull();
 expect(renderer.pickAssembly(layers,.124,.875)).toBeNull();
 expect(renderer.pickAssembly(layers,3.125,.875)).toBeNull();
});

test('#381 actual parts page raster caller keeps outline separate, hides pixels, and never rewrites a per-part verdict',async()=>{
 const root=await mkdtemp(join(tmpdir(),'assembly-caller-'));
 try{
 const f=await writeComparisonPackage(root),items=[f.body,f.front].map((b,index)=>({...b,index})),imgs=await Promise.all(items.map(i=>loadImage(join(root,'parts',i.name+'.png'))));
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('const assemblyAlpha='),end=source.indexOf('async function paintReference(',start);
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));
 const canvas=createCanvas(1,1),children:any[]=[],caption={textContent:''},state={data:{mode:'parts',rigSize:[32,24],items,painting:null},selected:0,view:'assembled',hidden:new Set<string>(),comparison:{mode:'part',opacity:.5},bg:'magenta',alpha:false,verdict:new Map([['body',{outcome:'clean',note:'unchanged'}],['front',{outcome:'flagged',note:'keep'}]])};
 const scope={...renderer,state,paintingHeld:false,hoverName:null,highlightedParts:new Set(),disposed:false,paintToken:1,itemImage:async(i:any)=>imgs[i.index],setCanvas:(c:any,w:number,h:number)=>{c.width=w;c.height=h;return c.getContext('2d');},$:((id:string)=>id==='pv-canvas'?canvas:id==='pv-overlay'?{replaceChildren:(...c:any[])=>{children.splice(0,children.length,...c);},append:(c:any)=>children.push(c)}:caption),doc:{createElement:()=>Object.assign(createCanvas(1,1),{dataset:{}})},t:(s:string)=>s};
 const paint=new Function('scope',`with(scope){${code};return paintRaster;}`)(scope),before=JSON.stringify([...state.verdict]);
 await paint(1);expect([canvas.width,canvas.height]).toEqual([32,24]);expect(children).toHaveLength(1);expect(children[0].dataset.assemblyOutline).toBe('body');expect(children[0].getContext('2d').getImageData(0,0,32,24).data.some((v:number,i:number)=>i%4===3&&v>0)).toBe(true);
 const pixel=()=>[...canvas.getContext('2d').getImageData(15,9,1,1).data];expect(pixel()).toEqual([225,70,40,255]);state.hidden.add('front');await paint(1);expect(pixel()).not.toEqual([225,70,40,255]);
 state.hidden.add('body');await paint(1);expect(pixel()).toEqual([255,0,255,255]);expect(children).toHaveLength(0);state.alpha=true;await paint(1);expect(pixel()).toEqual([0,0,0,255]);expect(JSON.stringify([...state.verdict])).toBe(before);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#614 transparent assembly reuses ordered source-over pixels for Overlay and 100-percent painting hold',async()=>{
 const root=await mkdtemp(join(tmpdir(),'assembly-transparent-'));
 try{
  const f=await writeComparisonPackage(root);
  const layers=await Promise.all([f.body,f.front].map(async(box,index)=>({box:{...box,index},image:await loadImage(join(root,'parts',box.name+'.png'))})));
  const painting=await loadImage(join(root,'painting.png'));
  const actual=createCanvas(32,24),expected=createCanvas(32,24);
  actual.getContext('2d').fillStyle='#ff00ff';actual.getContext('2d').fillRect(0,0,32,24);
  renderer.paintAssembly(actual.getContext('2d') as never,32,24,layers as never,{bg:'green',alpha:false,transparent:true});
  const oracle=expected.getContext('2d');oracle.imageSmoothingEnabled=false;
  oracle.drawImage(layers[0]!.image,4,4);oracle.drawImage(layers[1]!.image,14,8);
  const bytes=(canvas:typeof actual)=>Buffer.from(canvas.getContext('2d').getImageData(0,0,32,24).data);
  expect(bytes(actual)).toEqual(bytes(expected));
  expect([...actual.getContext('2d').getImageData(0,0,1,1).data]).toEqual([0,0,0,0]);
  for(const opacity of [0,.25,1]){
   const composite=createCanvas(32,24),control=createCanvas(32,24);
   for(const canvas of [composite,control]){const ctx=canvas.getContext('2d');ctx.drawImage(painting,0,0);ctx.globalAlpha=opacity;}
   composite.getContext('2d').drawImage(actual,0,0);control.getContext('2d').drawImage(expected,0,0);
   expect(bytes(composite)).toEqual(bytes(control));
   if(opacity===0){const original=createCanvas(32,24);original.getContext('2d').drawImage(painting,0,0);expect(bytes(composite)).toEqual(bytes(original));}
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
