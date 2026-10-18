/** Public last-render telemetry only; neither draws, poses nor probes GL. */
import type {DomRenderer,CanvasRenderer} from '@rig-c/play';
export type RendererTelemetry=Pick<DomRenderer,'meshBackend'|'meshBackendActive'|'meshCount'|'meshReuseCount'|'triangleCount'>|Pick<CanvasRenderer,'backend'|'backendActive'|'framesReused'|'trianglesDrawn'>;
export interface RasterStatus {kind:'pending'|'failed'|'fresh'|'cached'|'no-mesh';mode:'dom'|'canvas'|null;backend:'webgl'|'canvas2d'|null;fresh:number;reused:number;triangles:number;label:string}
const empty=(kind:'pending'|'failed'):RasterStatus=>({kind,mode:null,backend:null,fresh:0,reused:0,triangles:0,label:kind==='failed'?'Rendering failed':'Not rendered'});
/** Call only after successful draw. DOM actual-flush reporting requires play>=1.11.1. */
export function rendererStatus(renderer:RendererTelemetry|null,draw:'pending'|'succeeded'|'failed'):RasterStatus {
 if(draw!=='succeeded'||!renderer)return empty(draw==='failed'?'failed':'pending');
 if('meshBackendActive' in renderer){
  const base={mode:'dom' as const,fresh:renderer.meshCount,reused:renderer.meshReuseCount,triangles:renderer.triangleCount};
  if(renderer.meshCount===0)return {...base,kind:renderer.meshReuseCount?'cached':'no-mesh',backend:null,label:renderer.meshReuseCount?'Cached mesh rasters reused':'No mesh · DOM images'};
  const backend=renderer.meshBackendActive,label=backend==='webgl'?'WebGL':renderer.meshBackend==='webgl'?'Canvas2D fallback':'Canvas2D';
  return {...base,kind:'fresh',backend,label:`Fresh meshes · ${label}${renderer.meshReuseCount?' · Cached rasters also reused':''}`};
 }
 const base={mode:'canvas' as const,fresh:renderer.framesReused?0:1,reused:renderer.framesReused,triangles:renderer.trianglesDrawn};
 if(renderer.framesReused)return {...base,kind:'cached',backend:null,label:'Cached canvas frame reused'};
 if(!renderer.trianglesDrawn)return {...base,kind:'no-mesh',backend:null,label:'Canvas frame · No drawable triangles'};
 return {...base,kind:'fresh',backend:renderer.backendActive,label:`Canvas frame · ${renderer.backendActive==='webgl'?'WebGL':renderer.backend==='webgl'?'Canvas2D fallback':'Canvas2D'}`};
}
export interface RendererBadgeState {phase:'pending'|'failed'|'drawn'|'held';raster:RasterStatus;label:string}
/** A skipped preparation cannot resample stale counters as a new visible draw. */
export class RendererBadge {
 private last:RasterStatus|null=null;
 private value:RendererBadgeState={phase:'pending',raster:empty('pending'),label:'Not rendered'};
 observe(phase:'unknown'|'drawn'|'held'|'failed',renderer:RendererTelemetry|null):RendererBadgeState {return phase==='drawn'?this.succeeded(renderer):phase==='held'?this.held():phase==='failed'?this.failed():this.pending();}
 snapshot():RendererBadgeState{return {...this.value,raster:{...this.value.raster}};}
 pending():RendererBadgeState {this.value={phase:'pending',raster:empty('pending'),label:this.last?'Previous draw · synchronizing':'Not rendered'};return this.snapshot();}
 failed():RendererBadgeState {this.last=null;this.value={phase:'failed',raster:empty('failed'),label:'Rendering failed · pair unavailable'};return this.snapshot();}
 succeeded(renderer:RendererTelemetry|null):RendererBadgeState {const raster=rendererStatus(renderer,'succeeded');this.last=raster;this.value={phase:'drawn',raster,label:raster.label};return this.snapshot();}
 held():RendererBadgeState {const raster=this.last??empty('pending');this.value={phase:'held',raster,label:this.last?`Last drawn · ${raster.label} · held`:'Not rendered · held'};return this.snapshot();}
}
