import {readFile} from 'node:fs/promises';
import {createCanvas,Image} from '@napi-rs/canvas';
import {loadModel,type ModelAssets} from '@rig-c/play';
const base=new URL('../fixtures/strip-probe/build/',import.meta.url);
/** The published loader and player over an in-memory model document (native canvas; the fixture's own pages). */
export async function loadSetupAssets(doc:unknown):Promise<{assets:ModelAssets;dispose:()=>void}> {
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
export const setupRoot=()=>({style:{clipPath:''},appendChild(node:unknown){return node;}}) as unknown as HTMLElement;
