import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {loadModel,RigPlayer} from '@rig-c/play';
import {rendererStatus,RendererBadge,type RendererTelemetry} from '../web/renderer-status.ts';
import {ComparePresentation} from '../src/compare-presentation.ts';
import {compareSeekStep,feedbackTrace,type InspectionPlayer} from '../src/compare-playhead.ts';
const dom=(values:Partial<Extract<RendererTelemetry,{meshCount:number}>>={}):RendererTelemetry=>({meshBackend:'webgl',meshBackendActive:'webgl',meshCount:2,meshReuseCount:0,triangleCount:4,...values});
test('after-draw telemetry distinguishes observed backend from defaults, fallback, cached-only and no meshes',()=>{
 expect(rendererStatus(dom(),'pending')).toMatchObject({kind:'pending',backend:null});expect(rendererStatus(dom(),'failed')).toMatchObject({kind:'failed',backend:null});
 expect(rendererStatus(dom(),'succeeded')).toMatchObject({kind:'fresh',backend:'webgl',label:'Fresh meshes · WebGL'});
 expect(rendererStatus(dom({meshBackendActive:'canvas2d'}),'succeeded').label).toBe('Fresh meshes · Canvas2D fallback');
 expect(rendererStatus(dom({meshBackend:'canvas2d',meshBackendActive:'canvas2d'}),'succeeded').label).toBe('Fresh meshes · Canvas2D');
 expect(rendererStatus(dom({meshCount:0,meshReuseCount:3}),'succeeded')).toMatchObject({kind:'cached',backend:null,reused:3,label:'Cached mesh rasters reused'});
 expect(rendererStatus(dom({meshCount:0}),'succeeded')).toMatchObject({kind:'no-mesh',backend:null,label:'No mesh · DOM images'});
 expect(rendererStatus(dom({meshReuseCount:1}),'succeeded').label).toContain('Cached rasters also reused');
 const canvas={backend:'webgl' as const,backendActive:'canvas2d' as const,framesReused:0,trianglesDrawn:4};
 expect(rendererStatus(canvas,'succeeded').label).toBe('Canvas frame · Canvas2D fallback');expect(rendererStatus({...canvas,framesReused:1},'succeeded')).toMatchObject({kind:'cached',backend:null});expect(rendererStatus({...canvas,trianglesDrawn:0},'succeeded')).toMatchObject({kind:'no-mesh',backend:null});
});
test('late and unknown-timing pairs report their actual draws while feedback waits; partial failure invalidates both and paused inspection recovers',()=>{
 const badges={a:new RendererBadge(),b:new RendererBadge()},state=new ComparePresentation(),domain={start:0 as const,end:2};let now=0;
 const player=(side:'a'|'b'):InspectionPlayer=>({time:0,pause(){},seek(time){(this as {time:number}).time=time;now+=4;},draw(){now+=1;if(side==='b'&&fail)throw new Error('second draw refused');}});let fail=false;const a=player('a'),b=player('b');
 const sample=(time:number)=>({time,source:'video-frame' as const});const initial=state.inspect(sample(0),a,b,domain,()=>now);badges.a.observe(initial.status,dom());badges.b.observe(initial.status,dom({meshBackendActive:'canvas2d'}));
 expect(badges.a.snapshot().raster.backend).toBe('webgl');expect(badges.b.snapshot().raster.backend).toBe('canvas2d');
 const late=state.present(sample(1),now+1,1,a,b,domain,()=>now,.005);
 expect(a.time).toBe(1);expect(b.time).toBe(1);expect(late.status).toBe('drawn');expect(late.lastDrawn?.reference).toBe(1);expect(late.lastLatenessMs).toBeGreaterThan(0);expect(feedbackTrace(true,false,late.inspection)).toBeNull();
 expect(badges.a.observe(late.status,dom({meshBackendActive:'canvas2d'}))).toMatchObject({phase:'drawn',raster:{backend:'canvas2d'}});expect(badges.b.observe(late.status,dom())).toMatchObject({phase:'drawn',raster:{backend:'webgl'}});
 const unknown=state.present(sample(1.25),null,2,a,b,domain,()=>now);
 expect(unknown).toMatchObject({status:'drawn',deadlineKind:'unknown',inspection:null,lastDrawn:{reference:1.25}});expect(badges.a.observe(unknown.status,dom()).raster.backend).toBe('webgl');expect(badges.b.observe(unknown.status,dom({meshCount:0,meshReuseCount:1})).raster.kind).toBe('cached');
 const unreadable:RendererTelemetry={...dom(),get meshCount():number{throw new Error('non-draw transition sampled stale counters');}};
 expect(badges.a.observe('held',unreadable)).toMatchObject({phase:'held',raster:{backend:'webgl'}});expect(badges.b.observe('held',unreadable)).toMatchObject({phase:'held',raster:{kind:'cached',backend:null}});
 fail=true;expect(()=>state.inspect(sample(.5),a,b,domain,()=>now)).toThrow('second draw refused');for(const side of ['a','b'] as const)expect(badges[side].observe(state.snapshot().status,unreadable)).toMatchObject({phase:'failed',raster:{backend:null}});
 expect(state.snapshot().lastDrawn).toBeNull();
 fail=false;const recovered=state.inspect(sample(.25),a,b,domain,()=>now);expect(feedbackTrace(true,false,recovered.inspection)?.reference).toBe(.25);expect(badges.a.observe(recovered.status,dom({meshCount:0,meshReuseCount:1}))).toMatchObject({phase:'drawn',raster:{kind:'cached',backend:null}});expect(badges.b.observe(recovered.status,dom())).toMatchObject({phase:'drawn',raster:{backend:'webgl'}});
 expect(badges.a.pending().phase).toBe('pending');expect(badges.a.snapshot().label).toBe('Previous draw · synchronizing');
});
test('actual public RigPlayer no-mesh draw cannot become a constructor-default WebGL success',async()=>{
 const bytes=await readFile(new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'),assets=await loadModel({modelUrl:'http://fixture.invalid/probe.model.json',setsUrl:null,fetch:new Proxy(fetch,{apply:()=>Promise.resolve(new Response(bytes))})}),player=new RigPlayer({style:{clipPath:''}} as unknown as HTMLElement,assets,{seekStep:compareSeekStep}),badge=new RendererBadge();
 try{expect(rendererStatus(player.renderer,'pending').backend).toBeNull();player.environment(null);player.play('inspect',{loop:false});player.pause();player.seek(.5);player.draw();const time=player.time,bone=player.bone('probe');expect(badge.observe('drawn',player.renderer)).toMatchObject({phase:'drawn',raster:{kind:'no-mesh',backend:null}});expect(player.time).toBe(time);expect(player.bone('probe')).toEqual(bone);expect(badge.failed().raster.backend).toBeNull();}
 finally{player.dispose();assets.dispose();}
});
