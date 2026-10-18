import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCanvas,Image,type Canvas} from '@napi-rs/canvas';
import {CanvasRenderer,loadModel,RigPlayer,type PosedFrame} from '@rig-c/play';
import {captureRigGeometry,RigOverlays,type BoneOverlaySpec,type OverlayPlayer,type RigOverlaySettings} from '../web/rig-overlays.ts';

const settings:RigOverlaySettings={images:true,mesh:true,bones:true,meshOpacity:.65};
const specs:BoneOverlaySpec[]=[{name:'root'},{name:'rigid',parent:'root'},{name:'mesh',parent:'root'}];
const project=(x:number,y:number)=>({x:180+x*4,y:150-y*4});
const hash=(bytes:ArrayLike<number>)=>createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
function host(){
 const surface=createCanvas(400,300);Object.assign(surface,{style:{pointerEvents:'auto'},clientWidth:400,clientHeight:300});
 const root={style:{visibility:'visible'}} as unknown as HTMLElement;
 return {surface,root,canvas:surface as unknown as HTMLCanvasElement};
}
function pixels(surface:Canvas){return surface.getContext('2d').getImageData(0,0,surface.width,surface.height).data;}
function inkBounds(surface:Canvas){
 const data=pixels(surface);let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,count=0;
 for(let y=0;y<surface.height;y++)for(let x=0;x<surface.width;x++)if(data[(y*surface.width+x)*4+3]!>0){count++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
 return {left,top,right,bottom,count};
}

/** Native image/canvas ownership only; the published player and poser are unchanged. */
async function realRig(){
 const base=new URL('./fixtures/strip-probe/build/',import.meta.url),bytes=await readFile(new URL('skeleton.model.json',base));
 const pageBytes=new Map<string,Buffer>();for(const name of ['rigid.png','mesh.png'])pageBytes.set('https://overlay.invalid/'+name,await readFile(new URL(name,base)));
 const globals=globalThis as unknown as Record<string,unknown>,saved=new Map(['document','Image'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const restore=()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globals[key];};
 const src=Object.getOwnPropertyDescriptor(Image.prototype,'src')!;
 class LocalImage extends Image {}
 Object.defineProperty(LocalImage.prototype,'src',{get(){return src.get!.call(this);},set(value:unknown){const image=typeof value==='string'?pageBytes.get(value):undefined;if(!image)throw new Error('Undeclared fixture image');src.set!.call(this,image);}});
 globals.Image=LocalImage;
 globals.document={baseURI:'https://overlay.invalid/',createElement(tag:string){if(tag!=='canvas')throw new Error('Unexpected native host element '+tag);return Object.assign(createCanvas(1,1),{style:{},remove(){}});}};
 try{
  const assets=await loadModel({modelUrl:'https://overlay.invalid/skeleton.model.json',setsUrl:null,regions:'none',resolvePage:name=>'https://overlay.invalid/'+name,fetch:new Proxy(fetch,{apply:(_target,_this,args:Parameters<typeof fetch>)=>String(args[0])==='https://overlay.invalid/skeleton.model.json'?Promise.resolve(new Response(new Uint8Array(bytes))):Promise.reject(new Error('Undeclared fixture fetch'))})});
  try{
   const player=new RigPlayer({style:{clipPath:''},appendChild(node:unknown){return node;}} as unknown as HTMLElement,assets,{mode:'canvas',seekStep:1/60});
   if(!(player.renderer instanceof CanvasRenderer))throw new Error('Real native canvas renderer required');player.renderer.backend='canvas2d';player.renderer.pixelRatio=1;
   player.environment(null);player.play('inspect',{loop:false});player.pause();player.seek(0);player.draw();
   return {player,dispose(){try{player.dispose();assets.dispose();}finally{restore();}}};
  }catch(error){assets.dispose();throw error;}
 }catch(error){restore();throw error;}
}

test('real public posed mesh and bone transforms drive inspection geometry, not setup guesses',async()=>{
 const {player,dispose}=await realRig();
 try{
  const initial=captureRigGeometry(player,specs,settings);player.seek(.5);player.draw();const beforeTime=player.time,beforeBone=player.bone('mesh'),frame=player.posedFrame(),actual=captureRigGeometry(player,specs,settings);
  expect(actual.warnings).toEqual([]);expect(actual.mesh).toHaveLength(5);expect(actual.joints.map(b=>b.name)).toEqual(['root','rigid','mesh']);expect(actual.mesh).not.toEqual(initial.mesh);
  const bone=player.bone('mesh'),vertex={x:bone.x+bone.a*-10+bone.b*-10,y:bone.y+bone.c*-10+bone.d*-10};
  expect(actual.mesh[0]!.from.x).toBeCloseTo(vertex.x,10);expect(actual.mesh[0]!.from.y).toBeCloseTo(vertex.y,10);
  expect(actual.joints.find(b=>b.name==='mesh')).toMatchObject({point:{x:bone.x,y:bone.y},xAxis:{x:bone.a,y:bone.c},yAxis:{x:bone.b,y:bone.d}});
  const rigid=player.bone('rigid');expect(actual.bones.find(line=>line.to.x===rigid.x&&line.to.y===rigid.y)?.from).toEqual({x:player.bone('root').x,y:player.bone('root').y});
  expect(player.time).toBe(beforeTime);expect(player.bone('mesh')).toEqual(beforeBone);expect(player.posedFrame()).toEqual(frame);
  const declared=captureRigGeometry(player,[{name:'rigid',length:7}],{mesh:false,bones:true});expect(declared.bones[0]!.to).toEqual({x:rigid.x+rigid.a*7,y:rigid.y+rigid.c*7});
 }finally{dispose();}
});

test('camera redraw retains last drawn geometry through an undrawn seek; native pixels follow pan and DPR',async()=>{
 const rig=await realRig(),h=host(),overlay=new RigOverlays({canvas:h.canvas,rigRoot:h.root});
 try{
  rig.player.seek(.5);rig.player.draw();const result=overlay.refresh({player:rig.player,bones:specs,project,settings,dpr:1});expect(result).toMatchObject({available:true,needsCapture:false,meshEdges:5,boneCount:3});
  const original=hash(pixels(h.surface)),bounds=inkBounds(h.surface);expect(bounds.count).toBeGreaterThan(100);
  rig.player.seek(0);const prepared=rig.player.time;overlay.redraw({project,settings,dpr:1});expect(hash(pixels(h.surface))).toBe(original);expect(rig.player.time).toBe(prepared);
  const moved=(x:number,y:number)=>{const p=project(x,y);return {x:p.x+17,y:p.y-9};};overlay.redraw({project:moved,settings,dpr:1});const shifted=inkBounds(h.surface);expect(shifted.left-bounds.left).toBe(17);expect(shifted.top-bounds.top).toBe(-9);expect(shifted.right-bounds.right).toBe(17);expect(shifted.bottom-bounds.bottom).toBe(-9);
  overlay.redraw({project,settings,dpr:2});expect(h.surface.width).toBe(800);expect(h.surface.height).toBe(600);expect(inkBounds(h.surface).count).toBeGreaterThan(bounds.count);
  // Negative control: sampling the newly prepared pose would move the pixels.
  overlay.refresh({player:rig.player,bones:specs,project,settings,dpr:1});expect(hash(pixels(h.surface))).not.toBe(original);
 }finally{overlay.dispose();rig.dispose();}
});

test('actual image visibility is independent from native overlay pixels; clear/failure/disposal cannot retain old graphics',async()=>{
 const rig=await realRig(),h=host(),overlay=new RigOverlays({canvas:h.canvas,rigRoot:h.root});
 try{
  rig.player.seek(.5);rig.player.draw();const before=rig.player.time;overlay.refresh({player:rig.player,bones:specs,project,settings:{...settings,images:false},dpr:1});expect(h.root.style.visibility).toBe('hidden');expect(h.canvas.style.pointerEvents).toBe('none');expect(inkBounds(h.surface).count).toBeGreaterThan(100);expect(rig.player.time).toBe(before);
  overlay.redraw({project,settings:{...settings,images:true},dpr:1});expect(h.root.style.visibility).toBe('visible');
  overlay.clear();expect(inkBounds(h.surface).count).toBe(0);expect(overlay.redraw({project,settings,dpr:1})).toMatchObject({available:false,meshEdges:0,boneCount:0});expect(inkBounds(h.surface).count).toBe(0);
  overlay.dispose();expect(h.root.style.visibility).toBe('visible');expect(h.canvas.style.pointerEvents).toBe('auto');expect(overlay.refresh({player:rig.player,bones:specs,project,settings})).toMatchObject({available:false,capabilities:{images:false,mesh:false,bones:false}});
 }finally{overlay.dispose();rig.dispose();}
});

test('disabled inspection has no poser reads; enabling a layer waits for actual capture and malformed data is named',async()=>{
 const rig=await realRig(),h=host(),overlay=new RigOverlays({canvas:h.canvas,rigRoot:h.root});
 try{
  const unreadable:OverlayPlayer={posedFrame(){throw new Error('unexpected posedFrame read');},bone(){throw new Error('unexpected bone read');}};
  const off=overlay.refresh({player:unreadable,bones:specs,project,settings:{...settings,mesh:false,bones:false},dpr:1});expect(off.warnings).toEqual([]);expect(off.needsCapture).toBe(false);expect(inkBounds(h.surface).count).toBe(0);
  const pending=overlay.redraw({project,settings,dpr:1});expect(pending.needsCapture).toBe(true);expect(pending.warnings.join(' ')).toContain('successful rig draw');
  const malformed=structuredClone(rig.player.posedFrame()) as PosedFrame,mesh=malformed.order.find(slot=>slot.kind==='mesh')!;if(mesh.kind!=='mesh')throw new Error('Fixture must carry an actual mesh');mesh.triangles[0]=999;
  const bad:OverlayPlayer={posedFrame(){return malformed;},bone(name){return rig.player.bone(name);}};const refused=captureRigGeometry(bad,[{name:'missing'}],settings);expect(refused.warnings.join(' ')).toContain('triangle index outside');expect(refused.warnings.join(' ')).toContain('Bone overlay missing');expect(refused.mesh).toHaveLength(3);
  expect(overlay.refresh({player:null,bones:specs,project,settings,dpr:1}).warnings.join(' ')).toContain('no successfully drawn rig pose');
 }finally{overlay.dispose();rig.dispose();}
});
