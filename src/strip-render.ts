/** Browser-free host for the published player. No posing or raster math lives here. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasRenderer, loadModel, RigPlayer, type ModelAssets } from '@rig-c/play';
import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import { frameAtTime } from './frame-clock.ts';
import { packagePath, safeFile } from './manifest.ts';
import { compareSeekStep } from './compare-playhead.ts';
import { stripNoClock, type StripRenderInput, type StripRenderResult, type StripRenderSample, type StripSide } from './strip.ts';
import { toolVersions } from './versions.ts';

export interface StripTools { ffmpeg?:string; ffprobe?:string }
interface VideoFrame {index:number;time:number}
interface VideoInfo {frames:VideoFrame[];duration:number}
type NativeCanvas=typeof import('@napi-rs/canvas');
interface OpenRig {id:StripSide;assets:ModelAssets;player:RigPlayer;renderer:CanvasRenderer;clock:StripRenderInput['rigs'][number]['clock']}
function fail(code:string,text:string):never {throw new Error(`${code}: ${text}`);}
let hostQueue=Promise.resolve();

/** Selection uses decoded timestamps, never a guessed FPS. Equal distance keeps earlier PTS. */
export function nearestReferenceFrame(frames:readonly VideoFrame[],time:number):VideoFrame {
  if(!Number.isFinite(time)||!frames.length)fail('STRIP_REFERENCE_TIME','finite time and decoded frames required');
  let lo=0,hi=frames.length;
  while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(frames[mid]!.time<time)lo=mid+1;else hi=mid;}
  const after=frames[lo],before=frames[lo-1];
  if(!before)return after!;if(!after)return before;
  return time-before.time<=after.time-time?before:after;
}
function command(binary:string,args:string[],kind:string):Promise<Buffer>{
  return new Promise((resolveCommand,reject)=>{
    execFile(binary,args,{encoding:'buffer',timeout:60000,maxBuffer:32*1024*1024,windowsHide:true},(error,stdout,stderr)=>{
      if(error){reject(new Error(`STRIP_${kind}: ${binary}: ${error.message}; ${stderr.toString('utf8').slice(0,1200)}`));return;}
      resolveCommand(stdout);
    });
  });
}
async function probe(referencePath:string,binary:string):Promise<VideoInfo>{
  const bytes=await command(binary,['-v','error','-threads','1','-select_streams','v:0','-show_frames','-show_streams','-show_format','-show_entries','frame=best_effort_timestamp_time:stream=duration:format=duration','-of','json',referencePath],'FFPROBE');
  const value=JSON.parse(bytes.toString('utf8')) as {frames?:{best_effort_timestamp_time?:string}[];streams?:{duration?:string}[];format?:{duration?:string}};
  if(!Array.isArray(value.frames)||!value.frames.length)fail('STRIP_REFERENCE','no decoded video frames');
  const frames=value.frames.map((frame,index)=>({index,time:Number(frame.best_effort_timestamp_time)}));
  for(let i=0;i<frames.length;i++)if(!Number.isFinite(frames[i]!.time)||frames[i]!.time<0||(i>0&&frames[i]!.time<frames[i-1]!.time))fail('STRIP_REFERENCE','expected finite ordered nonnegative decoded PTS');
  const duration=Number(value.streams?.[0]?.duration??value.format?.duration);
  if(!Number.isFinite(duration)||duration<frames.at(-1)!.time)fail('STRIP_REFERENCE','finite video duration covering decoded frames required');
  return {frames,duration};
}
export async function referenceFramePng(path:string,index:number,binary:string,width:number,height:number):Promise<Buffer>{
  // Downsize before native image decode; output cells must not retain hundreds
  // of full-resolution source rasters merely because the video was 4K.
  return command(binary,['-v','error','-threads','1','-filter_threads','1','-i',path,'-map','0:v:0','-vf',`select=eq(n\\,${index}),scale=${width}:${height}:force_original_aspect_ratio=decrease`,'-vsync','0','-frames:v','1','-f','image2pipe','-c:v','png','-threads','1','pipe:1'],'FFMPEG');
}

/** Only DOM ownership and canvas/image IO are adapted; all drawing remains native/player code. */
function installHost(native:NativeCanvas,images:Map<string,Buffer>):()=>void {
  const globals=globalThis as unknown as Record<string,unknown>;
  const saved=new Map(['document','Image'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  function canvas(){const c=native.createCanvas(1,1);Object.assign(c,{style:{},remove(){}});return c;}
  const imageSrc=Object.getOwnPropertyDescriptor(native.Image.prototype,'src');
  if(!imageSrc?.get||!imageSrc.set)fail('STRIP_CANVAS','native Image src accessor unavailable');
  class LocalImage extends native.Image {}
  Object.defineProperty(LocalImage.prototype,'src',{get(){return imageSrc.get!.call(this);},set(value:unknown){
    if(typeof value!=='string')fail('STRIP_IMAGE','only declared page URLs may be loaded');
    const bytes=images.get(value);if(!bytes)fail('STRIP_IMAGE',`undeclared image ${value}`);
    imageSrc.set!.call(this,bytes);
  }});
  globals.document={baseURI:'https://strip.invalid/',createElement(tag:string){if(tag!=='canvas')fail('STRIP_HOST',`unexpected element ${tag}`);return canvas();}};
  globals.Image=LocalImage;
  return ()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globals[key];};
}
async function openRig(input:StripRenderInput['rigs'][number],images:Map<string,Buffer>):Promise<OpenRig>{
  const model=await safeFile(input.root,packagePath(relative(input.root,input.modelPath).split('\\').join('/')));
  if(!model.endsWith('.model.json'))fail('STRIP_MODEL','compiled .model.json required');
  const bytes=await readFile(model);const metadata=JSON.parse(bytes.toString('utf8')) as {pages?:{name:string}[]};
  if(!Array.isArray(metadata.pages))fail('STRIP_MODEL','declared model pages required');
  const urls=new Map<string,string>();
  for(const [index,page] of metadata.pages.entries()){
    if(typeof page.name!=='string'||/[\\%?#:\x00-\x1f]/.test(page.name))fail('STRIP_MODEL','literal relative page path required');
    const name=packagePath(relative(input.root,resolve(dirname(model),page.name)).split('\\').join('/'));
    const path=await safeFile(input.root,name),url=`https://strip.invalid/${input.id}/page-${index}`;
    urls.set(page.name,url);images.set(url,await readFile(path));
  }
  const modelUrl=`https://strip.invalid/${input.id}/skeleton.model.json`;
  const fileFetch=new Proxy(fetch,{apply:(_target,_this,args:Parameters<typeof fetch>)=>{
    if(String(args[0])!==modelUrl)return Promise.reject(new Error('STRIP_FETCH: undeclared model URL'));
    return Promise.resolve(new Response(new Uint8Array(bytes)));
  }});
  const assets=await loadModel({modelUrl,fetch:fileFetch,setsUrl:null,regions:'none',resolvePage:name=>{const url=urls.get(name);if(!url)fail('STRIP_MODEL',`undeclared page ${name}`);return url;}});
  try {
    if(!assets.animations.some(animation=>animation.name===input.animation))fail('STRIP_ANIMATION',`missing ${input.animation}`);
    const root={style:{clipPath:''},appendChild(node:unknown){return node;}} as unknown as HTMLElement;
    const player=new RigPlayer(root,assets,{mode:'canvas',seekStep:compareSeekStep});
    const renderer=player.renderer;if(!(renderer instanceof CanvasRenderer))fail('STRIP_RENDERER','published canvas renderer required');
    renderer.backend='canvas2d';renderer.pixelRatio=1;player.environment(null);player.play(input.animation,{loop:false});player.pause();
    return {id:input.id,assets,player,renderer,clock:input.clock};
  }catch(error){assets.dispose();throw error;}
}
function seek(rigs:OpenRig[],time:number):void {
  for(const rig of rigs){
    rig.player.seek(time);
    if(!Number.isFinite(rig.player.time)||Math.abs(rig.player.time-time)>1e-9)fail('STRIP_PLAYHEAD',`actual ${rig.id} time ${rig.player.time} differs from ${time}`);
    for(const slot of rig.player.posedFrame().order)if(slot.tint.slice(0,3).some(channel=>channel!==1)||slot.dark?.some(channel=>channel!==0))fail('STRIP_UNSUPPORTED_TINT',`${rig.id} slot ${slot.slot}: canvas2d cannot reproduce RGB/dark tint`);
  }
  if(rigs.some(rig=>rig.player.time!==rigs[0]!.player.time))fail('STRIP_PLAYHEAD','players did not reach the same actual PTS');
}
function contain(ctx:SKRSContext2D,image:Canvas|Image,x:number,y:number,width:number,height:number):void {
  const scale=Math.min(width/image.width,height/image.height);if(!Number.isFinite(scale)||scale<=0)fail('STRIP_IMAGE','decoded image has no extent');
  ctx.drawImage(image,x+(width-image.width*scale)/2,y+(height-image.height*scale)/2,image.width*scale,image.height*scale);
}
function footer(plan:StripRenderInput['plan'],renderer:StripRenderResult['renderer']):string[]{
  const lines=[`${renderer.name} ${renderer.version} | ${renderer.backend}`,`animation ${plan.animation} | nearest decoded PTS; ties earlier | seekStep ${compareSeekStep}`,`source SHA256 ${plan.binding.sourceHash}`,`reference ${plan.binding.reference.name}`,`reference SHA256 ${plan.binding.reference.sha256}`];
  for(const item of plan.binding.packages){const p=item.reviewedSource;lines.push(`${item.id.toUpperCase()} ${item.label} | revision ${p.packageRevision}`,`viewer ${p.viewerVersion} | runtime ${p.runtimeVersion}`,`package SHA256 ${item.sourceHash}`,`rig ${p.rig?.path??'unavailable'}`,`rig SHA256 ${p.rig?.sha256??'unavailable'}`,`motion ${p.motion?.path??'unavailable'}`,`motion SHA256 ${p.motion?.sha256??'unavailable'}`);}
  return lines;
}
function wrapped(ctx:SKRSContext2D,lines:string[],maxWidth:number):string[]{
  return lines.flatMap(line=>{const chunks:string[]=[];let current='';for(const char of line){if(current&&ctx.measureText(current+char).width>maxWidth){chunks.push(current);current='';}current+=char;}chunks.push(current);return chunks;});
}

export async function renderStrip(input:StripRenderInput,tools:StripTools={}):Promise<StripRenderResult>{
  const {plan}=input;
  if(plan.groups.some(group=>group.samples.some(sample=>sample.time===null)))throw new Error(stripNoClock);
  const previous=hostQueue;let release=()=>{};hostQueue=new Promise<void>(done=>{release=done;});await previous;
  const rigs:OpenRig[]=[];let restore=()=>{};
  try {
    let native:NativeCanvas;
    try{native=await import('@napi-rs/canvas');}catch(error){fail('STRIP_CANVAS',`@napi-rs/canvas unavailable: ${error instanceof Error?error.message:String(error)}`);}
    const images=new Map<string,Buffer>();restore=installHost(native,images);
    const ffmpeg=tools.ffmpeg??process.env.RIG_REVIEW_FFMPEG??'ffmpeg',ffprobe=tools.ffprobe??process.env.RIG_REVIEW_FFPROBE??'ffprobe';
    const video=await probe(input.referencePath,ffprobe);
    for(const source of input.rigs)rigs.push(await openRig(source,images));
    if(!rigs.length)fail('STRIP_MODEL','at least one compiled rig required');
    const end=Math.min(video.duration,...rigs.map(rig=>rig.assets.animations.find(a=>a.name===input.plan.animation)!.duration));
    const selected=plan.groups.flatMap(group=>group.samples.map(sample=>{
      const time=sample.time!;if(!Number.isFinite(time)||time<video.frames[0]!.time||time>end)fail('STRIP_DOMAIN',`requested ${time} outside common domain ${video.frames[0]!.time}..${end}`);
      const presented=nearestReferenceFrame(video.frames,time);
      if(presented.time<video.frames[0]!.time||presented.time>end)fail('STRIP_DOMAIN',`decoded PTS ${presented.time} outside common domain; no clamp`);
      return {group,sample,presented};
    }));
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const item of selected){seek(rigs,item.presented.time);for(const rig of rigs){const box=rig.player.bounds();if(box){minX=Math.min(minX,box.x);minY=Math.min(minY,box.y);maxX=Math.max(maxX,box.x+box.width);maxY=Math.max(maxY,box.y+box.height);}}}
    if(!(maxX>minX&&maxY>minY))fail('STRIP_VIEWPORT','selected poses have no drawable extent');
    const padding=Math.max(maxX-minX,maxY-minY)*.04;
    const x=Math.floor(minX-padding),y=Math.floor(minY-padding),worldWidth=Math.ceil(maxX+padding)-x,worldHeight=Math.ceil(maxY+padding)-y;
    const layout=plan.layout,width=layout.rowLabelWidth+Math.max(...plan.groups.map(group=>group.samples.length))*layout.cellWidth;
    const versions=await toolVersions();const packageJson=JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.resolve('@napi-rs/canvas'))),'package.json'),'utf8')) as {version:string};
    const renderer={name:'@rig-c/play',version:versions.runtimeVersion,backend:`canvas2d / @napi-rs/canvas ${packageJson.version}`};
    // The plan reserves a maximum footer budget. Measure the complete wrapped
    // provenance with the drawing font before allocating the final raster.
    const measure=native.createCanvas(1,1).getContext('2d');measure.font='12px monospace';
    const lines=wrapped(measure,footer(plan,renderer),width-20),footerHeight=lines.length*16+16;
    if(footerHeight>layout.footerHeight)fail('STRIP_LAYOUT_FOOTER',`need ${footerHeight}px for complete provenance, have ${layout.footerHeight}`);
    const groupHeight=layout.labelHeight*2+plan.rows.length*layout.cellHeight+layout.groupGap,height=plan.groups.length*groupHeight+footerHeight;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>16384||height>16384||width*height>64000000)fail('STRIP_LAYOUT','invalid or excessive canvas size');
    for(const rig of rigs){rig.renderer.viewport={x,y,width:worldWidth,height:worldHeight};rig.renderer.pixelRatio=Math.min(layout.cellWidth/worldWidth,layout.cellHeight/worldHeight);}
    const out=native.createCanvas(width,height),ctx=out.getContext('2d');ctx.fillStyle='#f1f1f1';ctx.fillRect(0,0,width,height);ctx.font='14px sans-serif';ctx.textBaseline='top';
    const samples:StripRenderSample[]=[];const decoded=new Map<number,Image>();
    for(const [groupIndex,group] of plan.groups.entries()){
      const top=groupIndex*groupHeight;ctx.fillStyle='#202b24';ctx.fillText(`${group.id} | ${group.basis} F${group.frameStart}–${group.frameEnd}`,8,top+8);
      for(const [column,sample] of group.samples.entries()){
        const left=layout.rowLabelWidth+column*layout.cellWidth,item=selected.find(value=>value.group===group&&value.sample===sample)!;
        const actual=item.presented.time;seek(rigs,actual);
        const record:StripRenderSample={groupId:group.id,requestedFrame:sample.requestedFrame,requestedTime:sample.time!,presentedTime:actual,delta:actual-sample.time!,decodedFrame:item.presented.index,sampling:'video-frame',playerTimes:{},frames:{}};
        ctx.fillStyle='#202b24';ctx.fillText(`F${sample.requestedFrame} | ${sample.time!.toFixed(5)}s`,left+6,top+layout.labelHeight+7);
        let reference=decoded.get(item.presented.index);if(!reference){reference=await native.loadImage(await referenceFramePng(input.referencePath,item.presented.index,ffmpeg,layout.cellWidth,layout.cellHeight));decoded.set(item.presented.index,reference);if(decoded.size>2)decoded.delete(decoded.keys().next().value!);}
        for(const [rowIndex,row] of plan.rows.entries()){
          const cellTop=top+layout.labelHeight*2+rowIndex*layout.cellHeight;
          ctx.fillStyle='#202b24';if(column===0)ctx.fillText(row.label.slice(0,100),8,cellTop+10,layout.rowLabelWidth-16);
          if(row.id==='reference'){contain(ctx,reference,left,cellTop,layout.cellWidth,layout.cellHeight);ctx.fillStyle='#172a22';ctx.fillText(`PTS ${actual.toFixed(6)}`,left+5,cellTop+5);}
          else {
            const rig=rigs.find(value=>value.id===row.id);if(!rig)fail('STRIP_MODEL',`missing row ${row.id}`);
            rig.player.draw();if(rig.renderer.backendActive!=='canvas2d')fail('STRIP_RENDERER','unexpected raster backend');
            contain(ctx,rig.renderer.canvas as unknown as Canvas,left,cellTop,layout.cellWidth,layout.cellHeight);
            record.playerTimes[row.id]=rig.player.time;record.frames[row.id]=frameAtTime(rig.clock,actual);
            ctx.fillStyle='#172a22';ctx.fillText(`F${record.frames[row.id]??'—'} | ${rig.player.time.toFixed(6)}s`,left+5,cellTop+5);
          }
          ctx.strokeStyle='#b7c2b9';ctx.strokeRect(left,cellTop,layout.cellWidth,layout.cellHeight);
        }
        samples.push(record);
      }
    }
    ctx.font='12px monospace';
    ctx.fillStyle='#172a22';lines.forEach((line,index)=>ctx.fillText(line,10,height-footerHeight+8+index*16));
    return {png:await out.encode('png'),width,height,renderer,samples};
  } finally {try{for(const rig of rigs){try{rig.player.dispose();}finally{rig.assets.dispose();}}}finally{try{restore();}finally{release();}}}
}
