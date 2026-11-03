import {expect,test} from 'bun:test';
import {readFile,readdir} from 'node:fs/promises';
import type {PosedFrame} from '@rig-c/play';
import * as real from '../web/stage-pick.ts';
import type {HoverPreview,StagePickOptions} from '../web/stage-pick.ts';

type Module=Pick<typeof real,'bindStagePick'>;

/** A stage that is only an event target: it has a fixed client rectangle and, when asked, a stage tool owning the press. */
class Stage extends EventTarget {
 dataset:Record<string,string>={};
 owner=false;
 getBoundingClientRect(){return {left:100,top:50,width:400,height:400};}
 closest(selector:string){return this.owner&&selector.includes('[data-panning]')?this:null;}
}
const region=(slot:string,x0:number,y0:number,x1:number,y1:number)=>({kind:'region',slot,corners:[x0,y0,x1,y0,x1,y1,x0,y1]});
// World: y up. body is under hat where they overlap; arm is a two-triangle mesh beside them.
const frame={order:[
 region('body',0,0,40,60),
 region('hat',10,50,30,80),
 {kind:'mesh',slot:'arm',vertices:[60,10,90,10,90,40,60,40],triangles:[0,1,2,0,2,3]},
]} as unknown as PosedFrame;
// Stage px: 2 px per world unit, y flipped, origin at (200,300) inside the stage.
const project=(x:number,y:number)=>({x:200+2*x,y:300-2*y});
const client=(x:number,y:number)=>{const p=project(x,y);return {clientX:100+p.x,clientY:50+p.y};};
const pointer=(type:string,at:{clientX:number;clientY:number},extra:Record<string,unknown>={})=>Object.assign(new Event(type),{pointerType:'mouse',isPrimary:true,button:0,buttons:0,...at,...extra});

function rig(module:Module,overrides:Partial<StagePickOptions>={}){
 const stage=new Stage(),selected:string[]=[],paints:(HoverPreview|null)[]=[];let space=false;
 const pick=module.bindStagePick({stage:stage as unknown as HTMLElement,project,frame:()=>frame,enabled:()=>true,held:()=>space,selectable:()=>true,select:slot=>selected.push(slot),paint:p=>paints.push(p),...overrides});
 return {stage,pick,selected,paints,hold:(on:boolean)=>{space=on;}};
}

/** At each point: what the hover shows, then what a click there selects. */
function hoverThenClick(module:Module,points:readonly (readonly [number,number])[]){
 const {stage,pick,selected}=rig(module);
 return points.map(([x,y])=>{
  const at=client(x,y);
  stage.dispatchEvent(pointer('pointermove',at));const hovered=pick.hovered(),shown=stage.dataset.hoverName??null;
  const before=selected.length;stage.dispatchEvent(pointer('pointerdown',at,{buttons:1}));stage.dispatchEvent(pointer('pointerup',at));
  stage.dispatchEvent(pointer('pointerleave',at));
  return {at:[x,y],hovered,shown,clicked:selected.length>before?selected.at(-1)!:null};
 });
}
// Over body only, over hat where it covers body, over the arm mesh, and over empty stage.
const POINTS=[[5,20],[20,55],[80,20],[150,150]] as const;
const diverging=(rows:ReturnType<typeof hoverThenClick>)=>rows.filter(r=>r.hovered!==r.clicked||r.shown!==r.clicked);

test('#330: the hovered part is the part a click at that point selects, on two parts, a mesh, an overlap and empty stage',()=>{
 const rows=hoverThenClick(real,POINTS);
 expect(rows.map(r=>r.clicked)).toEqual(['body','hat','arm',null]);
 expect(diverging(rows)).toEqual([]);
});

async function mutant(from:string,to:string):Promise<Module>{
 const source=await readFile(new URL('../web/stage-pick.ts',import.meta.url),'utf8');
 expect(source.split(from).length,`mutation site ${from}`).toBe(2);
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(source.replace(from,to));
 return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64')) as Promise<Module>;
}
const HOVER_SITE='pickAt(point.x,point.y,point.target)';

test('#330 planted divergence: a hover with a second picker that ignores draw order is caught at the overlap',async()=>{
 const second='(()=>{const f=o.frame();if(!f)return null;const a=stageWorld(stage.getBoundingClientRect(),o.project,point.x,point.y);return pickedSlot({order:[...f.order].reverse()},a.x,a.y);})()';
 const rows=hoverThenClick(await mutant(HOVER_SITE,second),POINTS);
 expect(diverging(rows).map(r=>r.at)).toEqual([[20,55]]);
});

test('#330 planted divergence: a hover reading a point 8 px off the click is caught',async()=>{
 const rows=hoverThenClick(await mutant(HOVER_SITE,'pickAt(point.x+8,point.y,point.target)'),[[39,20],...POINTS]);
 expect(diverging(rows).length).toBeGreaterThan(0);
});

test('#330: holding still never repaints; a new part does; leaving clears',()=>{
 const {stage,pick,paints}=rig(real),hat=client(20,70),body=client(5,20);
 stage.dispatchEvent(pointer('pointermove',hat));stage.dispatchEvent(pointer('pointermove',hat));pick.refresh();pick.refresh();
 expect(paints.map(p=>p?.slot??null)).toEqual(['hat']);
 expect(paints[0]!.tint).toBe(paints[0]!.outline);
 stage.dispatchEvent(pointer('pointermove',body));expect(paints.map(p=>p?.slot??null)).toEqual(['hat','body']);
 stage.dispatchEvent(pointer('pointerleave',body));expect(paints.at(-1)).toBeNull();expect(stage.dataset.hoverName).toBeUndefined();
 pick.refresh();expect(paints).toHaveLength(3);
});

test('#330: a mesh preview outlines only its outer edges, not the shared diagonal',()=>{
 const preview=real.hoverPreview(frame,'arm',project,{x:0,y:0})!;
 expect(preview.outline.match(/M/g)).toHaveLength(4);expect(preview.tint.match(/M/g)).toHaveLength(2);
 expect(real.hoverPreview(frame,'missing',project,{x:0,y:0})).toBeNull();
});

test('#330: touch, a pressed button, Space, a stage tool and a disabled stage show no preview; a touch tap still selects',()=>{
 const arm=client(80,20);
 {const {stage,pick,selected}=rig(real);
  stage.dispatchEvent(pointer('pointermove',arm,{pointerType:'touch'}));expect(pick.hovered()).toBeNull();
  stage.dispatchEvent(pointer('pointerdown',arm,{pointerType:'touch',buttons:1}));stage.dispatchEvent(pointer('pointerup',arm,{pointerType:'touch'}));
  expect(selected).toEqual(['arm']);expect(pick.hovered()).toBeNull();
  stage.dispatchEvent(pointer('pointermove',arm,{buttons:1}));expect(pick.hovered()).toBeNull();
  stage.dispatchEvent(pointer('pointermove',arm));expect(pick.hovered()).toBe('arm');
  stage.dispatchEvent(pointer('pointerdown',arm,{buttons:1}));expect(pick.hovered()).toBeNull();
 }
 {const {stage,pick,hold}=rig(real);
  stage.dispatchEvent(pointer('pointermove',arm));expect(pick.hovered()).toBe('arm');
  hold(true);pick.refresh();expect(pick.hovered()).toBeNull();hold(false);pick.refresh();expect(pick.hovered()).toBe('arm');
  stage.owner=true;pick.refresh();expect(pick.hovered()).toBeNull();
 }
 {let on=true;const {stage,pick,selected}=rig(real,{enabled:()=>on});
  stage.dispatchEvent(pointer('pointermove',arm));expect(pick.hovered()).toBe('arm');on=false;pick.refresh();expect(pick.hovered()).toBeNull();
  stage.dispatchEvent(pointer('pointerdown',arm,{buttons:1}));stage.dispatchEvent(pointer('pointerup',arm));expect(selected).toEqual([]);
 }
});

test('#330: a slot the panel cannot select is neither previewed nor clicked',()=>{
 const {stage,pick,selected}=rig(real,{selectable:slot=>slot!=='hat'}),hat=client(20,70);
 stage.dispatchEvent(pointer('pointermove',hat));expect(pick.hovered()).toBeNull();
 stage.dispatchEvent(pointer('pointerdown',hat,{buttons:1}));stage.dispatchEvent(pointer('pointerup',hat));expect(selected).toEqual([]);
});

test('#330: the stage hit test is called from web/stage-pick.ts only, and the inspection panel binds it',async()=>{
 const dir=new URL('../web/',import.meta.url),callers:string[]=[];
 for(const name of (await readdir(dir)).filter(n=>n.endsWith('.ts')).sort()){
  const source=await readFile(new URL(name,dir),'utf8');
  if(/\bpickedSlot\(/.test(source.replace(/export function pickedSlot\(/,'')))callers.push(name);
 }
 expect(callers).toEqual(['stage-pick.ts']);
 expect(await readFile(new URL('animation-inspection.ts',dir),'utf8')).toContain('bindStagePick(');
});
