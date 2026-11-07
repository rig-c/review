import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {test,expect} from 'bun:test';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {assertOriginalPaintingSize,paintingRectangle,parsePartsComparison} from '../src/parts-comparison.ts';
import {parsePartsComment} from '../src/parts-comment.ts';
import {paintOverlay} from '../web/parts-render.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {candidate,commentFixture} from './helpers/parts-comments-package.ts';
import {loadPartsView,saveVerdict,readVerdict,exportPartsVerdict,verdictSource} from '../src/parts-view.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {resolvedCropPath} from '../src/comment-crops.ts';
import {PNG} from 'pngjs';

test('#384 overlay opacity endpoints equal original painting crop / ordinary source-over part, without moving the camera',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'overlay-'));try{const f=await writeComparisonPackage(root),part=await loadImage(await readFile(join(root,'parts/body.png'))),painting=await loadImage(await readFile(join(root,'painting.png')));
 const render=(opacity:number)=>{const canvas=createCanvas(20,16),ctx=canvas.getContext('2d');paintOverlay(ctx as never,{...f.body,index:0},part as never,painting as never,paintingRectangle(f.body,[32,24],f.painting),opacity,'green');return ctx.getImageData(0,0,20,16).data;};
 const zero=render(0),one=render(1),half=render(.5),p=(4*20+10)*4;
 console.log('#472 overlay midpoint channels',JSON.stringify({platform:process.platform,zero:[...zero.subarray(p,p+4)],one:[...one.subarray(p,p+4)],half:[...half.subarray(p,p+4)],signedDeviations:[0,1,2].map(c=>half[p+c]!-(zero[p+c]!+one[p+c]!)/2),absoluteDeviations:[0,1,2].map(c=>Math.abs(half[p+c]!-(zero[p+c]!+one[p+c]!)/2))}));
 expect([...zero.subarray(p,p+4)]).toEqual([225,70,40,255]);expect([...one.subarray(p,p+4)]).toEqual([...f.part.data.subarray(p,p+4)]);
 for(let c=0;c<3;c++)expect(Math.abs(half[p+c]!-(zero[p+c]!+one[p+c]!)/2)).toBeLessThanOrEqual(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#384 comparison state is closed and bounded, old parts comment and rig codec remain unchanged',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'comparison-codec-'));try{const pkg=await commentFixture(root),old=candidate(pkg);expect(parsePartsComment(old,false)).toEqual(old);
 for(const mode of ['part','overlay'] as const){const comparison={mode,opacity:.375},comment={...old,view:{...old.view,comparison}};expect(parsePartsComment(comment,false).view.comparison).toEqual(comparison);}
 for(const bad of [{mode:'difference',opacity:.5},{mode:'overlay',opacity:-.1},{mode:'part',opacity:NaN},{mode:'overlay',opacity:1.01},{mode:'part',opacity:0,threshold:0},null])expect(()=>parsePartsComment({...old,view:{...old.view,comparison:bad}},false)).toThrow('PARTS_COMPARISON_INVALID');
 expect(()=>parsePartsComparison({mode:'part',opacity:0})).not.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#384 every comparison mode/opacity survives save, read and both exports; native crop remains original RGBA',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'comparison-persist-'));try{
 await writeComparisonPackage(root);const pkg=await loadPartsView(root,{painting:join(root,'painting.png')}),source=verdictSource(pkg),before=await Promise.all(pkg.files.map(f=>readFile(f.abs)));
 const comments=[];
 for(const mode of ['part','overlay'] as const){const c=candidate(pkg);c.part='body';c.rigRegion={...c.imageRegion,x:6,y:7};c.id=mode;c.view.comparison={mode,opacity:.375};comments.push(await preparePartsComment(pkg,c));}
 const parts=Object.fromEntries(pkg.items.map(i=>[i.name,{outcome:'pending'}]));await saveVerdict(pkg,{status:'pending',parts,comments});const saved=(await readVerdict(pkg)).verdict!;
 expect(saved.comments).toEqual(comments);expect(saved.source).toEqual(source);
 for(const c of saved.comments){const native=PNG.sync.read(await readFile(resolvedCropPath(c.nativeCrop!.path))),original=PNG.sync.read(before[1]!),r=c.imageRegion;
 for(let y=0;y<r.height;y++)expect(native.data.subarray(y*r.width*4,(y+1)*r.width*4)).toEqual(original.data.subarray(((r.y+y)*original.width+r.x)*4,((r.y+y)*original.width+r.x+r.width)*4));}
 const exported=JSON.parse(exportPartsVerdict(saved,'json'));expect(exported.comments.map((c:any)=>c.view.comparison)).toEqual(comments.map(c=>c.view.comparison));
 const issue=exportPartsVerdict(saved,'issue');for(const c of comments)expect(issue).toContain(JSON.stringify(c.view.comparison));
 expect(await Promise.all(pkg.files.map(f=>readFile(f.abs)))).toEqual(before);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#384 painting retains source identity: adding it shows existing stale-files warning, never reuses an earlier approval',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'painting-identity-'));try{await writeComparisonPackage(root);const old=await loadPartsView(root),parts=Object.fromEntries(old.items.map(i=>[i.name,{outcome:'clean'}]));await saveVerdict(old,{status:'approved',parts});const withPainting=await loadPartsView(root,{painting:join(root,'painting.png')});
 expect(verdictSource(withPainting).sha256).not.toBe(verdictSource(old).sha256);expect(await readVerdict(withPainting)).toEqual({verdict:null,stale:'files'});
 }finally{await rm(root,{recursive:true,force:true});}
});


test('#384 visual source rectangle follows whole-canvas producer geometry, retaining fractional placement and truncation',()=>{
 expect(()=>assertOriginalPaintingSize(1664,2432,[832,1216],.5)).not.toThrow();
 expect(paintingRectangle({x:122,y:36,w:590,h:457},[832,1216],{width:1664,height:2432})).toEqual({x:244,y:72,width:1180,height:914});
 expect(paintingRectangle({x:.125,y:8.375,w:30,h:32},[832,1216],{width:1664,height:2432})).toEqual({x:.25,y:16.75,width:60,height:64});
 expect(()=>assertOriginalPaintingSize(1665,2433,[832,1216],.5)).not.toThrow();
 expect(paintingRectangle({x:1,y:1,w:2,h:3},[832,1216],{width:1665,height:2433})).toEqual({x:1665/832,y:2433/1216,width:2*1665/832,height:3*2433/1216});
 for(const scale of [undefined,0,-1,Infinity,'0.5'])expect(()=>assertOriginalPaintingSize(1664,2432,[832,1216],scale)).toThrow('PARTS_PAINTING_MAPPING');
 expect(()=>assertOriginalPaintingSize(1662,2432,[832,1216],.5)).toThrow('PARTS_PAINTING_SIZE');
});

test('#384 scaled original is accepted by its declared geometry; wrong size/missing mapping refuse, and overlay without painting cannot be recorded',async()=>{
 const root=await mkdtemp(join(process.env.RIG_REVIEW_STATE_DIR!,'painting-map-'));try{await writeComparisonPackage(root);const metadata=join(root,'parts.json'),doc=JSON.parse(await readFile(metadata,'utf8'));doc.scale_rig_per_source=.5;await import('node:fs/promises').then(fs=>fs.writeFile(metadata,JSON.stringify(doc)));
 const {writeFile}=await import('node:fs/promises');const painting=join(root,'painting.png');await writeFile(painting,PNG.sync.write(new PNG({width:64,height:48})));const pkg=await loadPartsView(root,{painting});expect(pkg.painting!.width).toBe(64);
 const noPainting=await loadPartsView(root),c=candidate(noPainting);c.part='body';c.rigRegion={...c.imageRegion,x:6,y:7};c.view.comparison={mode:'overlay',opacity:.5};await expect(preparePartsComment(noPainting,c)).rejects.toThrow('PARTS_COMPARISON_UNAVAILABLE');
 await writeFile(painting,PNG.sync.write(new PNG({width:62,height:48})));await expect(loadPartsView(root,{painting})).rejects.toThrow('PARTS_PAINTING_SIZE');delete doc.scale_rig_per_source;await writeFile(metadata,JSON.stringify(doc));await expect(loadPartsView(root,{painting})).rejects.toThrow('PARTS_PAINTING_MAPPING');
 }finally{await rm(root,{recursive:true,force:true});}
});
