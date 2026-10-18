import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { nearestReferenceFrame, referenceFramePng, renderStrip } from '../src/strip-render.ts';
import type { StripRenderInput, StripRenderResult } from '../src/strip.ts';

const fixture=join(import.meta.dir,'fixtures/strip-probe');
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
async function input(animation='inspect',model='build/skeleton.model.json'):Promise<StripRenderInput>{
  const modelSHA=hash(await readFile(join(fixture,model))),motionSHA=hash(await readFile(join(fixture,'motion.json'))),referenceSHA=hash(await readFile(join(fixture,'reference.mov'))),sourceHash=hash(modelSHA+motionSHA+referenceSHA);
  return {referencePath:join(fixture,'reference.mov'),rigs:[{id:'single',root:fixture,modelPath:join(fixture,model),animation,clock:{kind:'samples',frameTimes:[0,.5,1]}}],plan:{schema:'rig-review-strip/1',mode:'single',animation,basis:'single',rows:[{id:'reference',label:'Reference'},{id:'single',label:'Original probe'}],groups:[{id:'three-frame-probe',feedbackId:null,basis:'single',frameStart:0,frameEnd:2,samples:[0,.5,1].map((time,requestedFrame)=>({requestedFrame,time}))}],binding:{sourceHash,packages:[{id:'single',label:'Original probe',sourceHash,reviewedSource:{packageRevision:'synthetic-1',viewerVersion:'0.1.0',runtimeVersion:'1.11.0',rig:{path:model,sha256:modelSHA},motion:{path:'motion.json',sha256:motionSHA}}}],reference:{name:'reference.mov',sha256:referenceSHA},compare:null},layout:{cellWidth:220,cellHeight:260,labelHeight:32,rowLabelWidth:120,groupGap:24,footerHeight:500}}};
}
async function pixels(result:StripRenderResult){const image=await loadImage(result.png),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {data:ctx.getImageData(0,0,image.width,image.height).data,width:image.width,height:image.height};}
function region(p:{data:Uint8ClampedArray;width:number},x:number,y:number,w:number,h:number){const out:number[]=[];for(let iy=y;iy<y+h;iy++)for(let ix=x;ix<x+w;ix++){const i=(iy*p.width+ix)*4;out.push(p.data[i]!,p.data[i+1]!,p.data[i+2]!);}return out;}
function colors(p:{data:Uint8ClampedArray;width:number},column:number){let red=0,green=0,redX=0;const left=120+column*220,top=64+260;for(let y=top+30;y<top+255;y++)for(let x=left+1;x<left+219;x++){const i=(y*p.width+x)*4,r=p.data[i]!,g=p.data[i+1]!,b=p.data[i+2]!;if(r>180&&g<80&&b<80){red++;redX+=x-left;}if(g>140&&r<90&&b<90)green++;}return {red,green,redCenter:redX/red};}
function footerLineBins(p:{data:Uint8ClampedArray;width:number;height:number},top:number){const bins=new Set<number>();let lastInk=top;for(let y=top+8;y<p.height;y++)for(let x=10;x<p.width-10;x++){const i=(y*p.width+x)*4;if(p.data[i]!<100){bins.add(Math.floor((y-top-8)/16));lastInk=y;break;}}return {lines:bins.size,lastInk};}
function labelPixels(text:string){const canvas=createCanvas(210,20),ctx=canvas.getContext('2d');ctx.fillStyle='#f1f1f1';ctx.fillRect(0,0,210,20);ctx.font='14px sans-serif';ctx.textBaseline='top';ctx.fillStyle='#172a22';ctx.fillText(text,0,0);return region({data:ctx.getImageData(0,0,210,20).data,width:210},0,0,210,20);}

describe('real public-player Node canvas strip',()=>{
 test('nearest decoded timestamp is explicit and ties keep earlier frames',()=>{
  const frames=[{index:0,time:0},{index:1,time:.5},{index:2,time:1}];
  expect(nearestReferenceFrame(frames,.25)).toEqual(frames[0]);expect(nearestReferenceFrame(frames,.75)).toEqual(frames[1]);expect(nearestReferenceFrame(frames,.500001)).toEqual(frames[1]);
  expect(nearestReferenceFrame([{index:175,time:175/24},{index:176,time:176/24}],7.33333).index).toBe(176);
 });
 test('real three-frame PNG includes region, mesh, source pixels, frame labels and provenance',async()=>{
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),originalImage=Object.getOwnPropertyDescriptor(globalThis,'Image');
  const request=await input(),result=await renderStrip(request),p=await pixels(result);
  if(process.env.RIG_REVIEW_STRIP_ARTIFACT)await writeFile(process.env.RIG_REVIEW_STRIP_ARTIFACT,result.png);
  expect(p.width).toBe(780);expect([result.width,result.height]).toEqual([p.width,p.height]);
  const footer=footerLineBins(p,608);expect(footer.lines).toBeGreaterThanOrEqual(12);
  expect(p.height).toBe(608+footer.lines*16+16);expect(p.height).toBeLessThan(1108);expect(footer.lastInk).toBeGreaterThan(p.height-24);
  expect(result.renderer).toMatchObject({name:'@rig-c/play',version:'1.11.0'});expect(result.renderer.backend).toContain('@napi-rs/canvas 1.0.11');
  expect(result.samples.map(sample=>[sample.requestedFrame,sample.requestedTime,sample.presentedTime,sample.decodedFrame,sample.delta,sample.frames.single])).toEqual([[0,0,0,0,0,0],[1,.5,.5,1,0,1],[2,1,1,2,0,2]]);
  for(const sample of result.samples)expect(sample.playerTimes.single).toBeCloseTo(sample.presentedTime,9);
  const actual=[0,1,2].map(column=>colors(p,column));for(const cell of actual){expect(cell.red).toBeGreaterThan(1000);expect(cell.green).toBeGreaterThan(1000);}
  expect(actual[1]!.redCenter-actual[0]!.redCenter).toBeGreaterThan(20);
  const source=(column:number)=>region(p,120+column*220+100,64+100,5,5);
  expect(source(0)).not.toEqual(source(1));expect(source(1)).not.toEqual(source(2));
  expect(region(p,126,38,180,20).some(channel=>channel<100)).toBe(true);
  expect(region(p,10,620,760,p.height-620).some(channel=>channel<100)).toBe(true);
  const wrongLabel=structuredClone(request);wrongLabel.plan.groups[0]!.samples[0]!.requestedFrame=999;
  const changed=await pixels(await renderStrip(wrongLabel));
  expect(region(changed,126,38,180,20)).not.toEqual(region(p,126,38,180,20));
  expect(region(changed,121,354,218,225)).toEqual(region(p,121,354,218,225));
  expect(Object.getOwnPropertyDescriptor(globalThis,'document')).toEqual(originalDocument);expect(Object.getOwnPropertyDescriptor(globalThis,'Image')).toEqual(originalImage);
 },60000);
 test('real 4K reference is reduced before native decode and preserves decoded frame selection',async()=>{
  const reference=join(fixture,'reference-4k.mov');
  const bytes=await referenceFramePng(reference,1,process.env.RIG_REVIEW_FFMPEG??'ffmpeg',220,260),decoded=await loadImage(bytes);
  expect(decoded.width).toBeLessThanOrEqual(220);expect(decoded.height).toBeLessThanOrEqual(260);
  expect(decoded.width*decoded.height*4*2).toBeLessThanOrEqual(220*260*4*2);
  const request=await input();request.referencePath=reference;request.plan.binding.reference={name:'reference-4k.mov',sha256:hash(await readFile(reference))};
  const result=await renderStrip(request),p=await pixels(result);
  expect(result.samples.map(sample=>[sample.presentedTime,sample.decodedFrame])).toEqual([[0,0],[.5,1],[1,2]]);
  const center=region(p,120+110,64+130,1,1);expect(center[2]).toBeGreaterThan(180);expect(center[0]).toBeLessThan(80);
 },60000);
 test('nine-column provenance uses measured text height and refuses an insufficient budget',async()=>{
  const request=await input(),group=request.plan.groups[0]!;group.frameEnd=8;group.samples=Array.from({length:9},(_,requestedFrame)=>({requestedFrame,time:requestedFrame/8}));
  const result=await renderStrip(request),p=await pixels(result),footer=footerLineBins(p,608);
  expect(p.width).toBe(2100);expect(footer.lines).toBeGreaterThanOrEqual(12);expect(result.height).toBe(608+footer.lines*16+16);expect(result.height).toBeLessThan(1108);expect(footer.lastInk).toBeGreaterThan(p.height-24);
  request.plan.layout.footerHeight=1;await expect(renderStrip(request)).rejects.toThrow('STRIP_LAYOUT_FOOTER');
 },60000);
 test('basis F176–184 labels use requested irregular samples while actual PTS frame metadata stays distinct',async()=>{
  const request=await input(),source=request.rigs[0]!,item=request.plan.binding.packages[0]!;
  const frameTimes=Array.from({length:185},(_,frame)=>frame<176?frame*.500003/176:.500003+(frame-176)**2*.000013);
  request.rigs=[{...source,id:'a',clock:null},{...source,id:'b',clock:{kind:'samples',frameTimes}}];
  request.plan.mode='compare';request.plan.basis='b';request.plan.rows=[{id:'reference',label:'Reference'},{id:'a',label:'A'},{id:'b',label:'B'}];request.plan.layout.footerHeight=820;
  request.plan.binding.packages=[{...item,id:'a',label:'A'},{...item,id:'b',label:'B'}];
  const group=request.plan.groups[0]!;group.basis='b';group.frameStart=176;group.frameEnd=184;group.samples=Array.from({length:9},(_,column)=>({requestedFrame:176+column,time:frameTimes[176+column]!}));
  const result=await renderStrip(request),p=await pixels(result);
  expect(result.samples.map(sample=>sample.requestedFrame)).toEqual([176,177,178,179,180,181,182,183,184]);
  expect(result.samples.map(sample=>sample.frames.b)).toEqual(Array(9).fill(175));
  expect(result.samples.every(sample=>sample.frames.a===null&&sample.presentedTime===.5&&sample.playerTimes.a===.5&&sample.playerTimes.b===.5)).toBe(true);
  expect(result.samples[0]!.delta).toBeCloseTo(-.000003,12);
  for(const [column,sample] of group.samples.entries()){
    expect(region(p,120+column*220+5,64+2*260+5,210,20)).toEqual(labelPixels(`F${sample.requestedFrame} | ${sample.time!.toFixed(6)}s`));
    expect(region(p,120+column*220+5,64+260+5,210,20)).toEqual(labelPixels('F— | 0.500000s'));
  }
 },60000);
 test('wrong motion and omitted rigid region fail the same real-pixel oracle',async()=>{
  const still=await pixels(await renderStrip(await input('still'))),omitted=await pixels(await renderStrip(await input('inspect','mesh-only/skeleton.model.json')));
  expect(Math.abs(colors(still,1).redCenter-colors(still,0).redCenter)).toBeLessThan(1);
  expect(colors(omitted,0).red).toBe(0);expect(colors(omitted,0).green).toBeGreaterThan(1000);
 },60000);
 test('no clock, missing tool and actual decoded PTS outside common domain refuse',async()=>{
  const request=await input();request.plan.groups[0]!.samples[0]!.time=null;
  await expect(renderStrip(request,{ffprobe:'missing-not-executed'})).rejects.toThrow('Report has no frameTimes');
  await expect(renderStrip(await input(),{ffprobe:'rig-review-deliberately-missing-ffprobe'})).rejects.toThrow('STRIP_FFPROBE');
  const short=await input('short');short.plan.groups[0]!.samples=[{requestedFrame:1,time:.76}];
  await expect(renderStrip(short)).rejects.toThrow('STRIP_DOMAIN: decoded PTS 1');
  const outside=await input();outside.plan.groups[0]!.samples=[{requestedFrame:2,time:1.1}];await expect(renderStrip(outside)).rejects.toThrow('STRIP_DOMAIN: requested');
 },60000);
 test('concurrent exports serialize the real canvas host and restore globals after a refusal',async()=>{
  const before=Object.getOwnPropertyDescriptor(globalThis,'document');const request=await input();request.plan.groups[0]!.samples=[{requestedFrame:0,time:0}];
  const outputs=await Promise.all([renderStrip(request),renderStrip(request)]);expect(hash(outputs[0]!.png)).toBe(hash(outputs[1]!.png));
  const one=await pixels(outputs[0]!),footer=footerLineBins(one,608);expect(one.height).toBe(608+footer.lines*16+16);expect(one.height).toBeLessThan(1108);expect(footer.lastInk).toBeGreaterThan(one.height-24);
  const bad=await input();bad.rigs[0]!.modelPath=join(fixture,'../outside.model.json');await expect(renderStrip(bad)).rejects.toThrow();
  expect(Object.getOwnPropertyDescriptor(globalThis,'document')).toEqual(before);
 },60000);
});
