/**
 * #331: a plain drag on the rig view pans and carries the rig, as the Family viewer's stage does; a click that does not
 * move stays a click and selects (#330). The real `bindPan` (web/view-controls.ts) and the real `bindStagePick`
 * (web/stage-pick.ts) are bound to one stage, the way the inspection binds them to the rig viewport, and the impulse is
 * the real `dragImpulse`. Only the DOM is substituted.
 */
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import type {PosedFrame} from '@rig-c/play';
import {bindStagePick,CLICK_SLOP_PX} from '../web/stage-pick.ts';
import {dragImpulse} from '../src/environment.ts';

/** The rig viewport: an event target with a client rectangle, pointer capture and the `data-panning` mark the pan sets. */
class Viewport extends EventTarget {
 dataset:Record<string,string>={};captured=new Set<number>();
 getBoundingClientRect(){return {left:100,top:50,width:400,height:400};}
 closest(selector:string){return this.dataset.panning&&selector.split(',').includes('[data-panning]')?this:null;}
 querySelectorAll(){return [];}
 setPointerCapture(id:number){this.captured.add(id);}
 hasPointerCapture(id:number){return this.captured.has(id);}
 releasePointerCapture(id:number){this.captured.delete(id);}
}
class Observer {observe(){}disconnect(){}}
type BindPan=(viewport:Viewport,move:(dx:number,dy:number)=>void,enabled?:()=>boolean,carry?:{threshold:number;move:(dx:number,dy:number)=>void})=>()=>void;

/** `bindPan` as shipped, with `window`, `document`, `Element` and `MutationObserver` supplied; `edit` plants a mutant. */
async function panBinder(edit:(source:string)=>string=source=>source){
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),begin=source.indexOf('const panVideoOverrides='),end=source.indexOf('export function bindInspectorTabs(',begin);
 if(begin<0||end<begin)throw new Error('bindPan boundary missing');
 const script=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(edit(source.slice(begin,end)).replace('export function bindPan','function bindPan'));
 const window=new EventTarget(),document=new EventTarget();
 const bind=new Function('window','document','Element','MutationObserver',script+';return bindPan;')(window,document,Viewport,Observer) as BindPan;
 return {bind,space:(down:boolean)=>(down?document:window).dispatchEvent(Object.assign(new Event(down?'keydown':'keyup',{cancelable:true}),{code:'Space'}))};
}

// World: y up. One region `arm`; the stage projects 2 px per world unit, y flipped, origin at (200,300) in the stage.
const frame={order:[{kind:'region',slot:'arm',corners:[0,0,40,0,40,60,0,60]}]} as unknown as PosedFrame;
const project=(x:number,y:number)=>({x:200+2*x,y:300-2*y});
const ARM={x:100+200+2*20,y:50+300-2*30};
const SCALE=2;

function stage(bind:BindPan){
 const viewport=new Viewport(),moved:{x:number;y:number}[]=[],pans:[number,number][]=[],selected:string[]=[];
 const player={moved:(motion:{x:number;y:number})=>{moved.push(motion);}};
 // Registered in the order the page registers them: the inspection's stage pick, then the viewport pan.
 bindStagePick({stage:viewport as unknown as HTMLElement,project,frame:()=>frame,enabled:()=>true,held:()=>false,selectable:()=>true,select:slot=>selected.push(slot),paint:()=>{}});
 bind(viewport,(dx,dy)=>pans.push([dx,dy]),()=>true,{threshold:CLICK_SLOP_PX,move:(dx,dy)=>{const impulse=dragImpulse(dx,dy,SCALE);if(impulse)player.moved(impulse);}});
 const at=(type:string,x:number,y:number)=>viewport.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),{pointerType:'mouse',pointerId:1,isPrimary:true,button:type==='pointermove'?-1:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
 /** Press at the arm, walk the relative steps, release where the last step ends. */
 const gesture=(steps:readonly (readonly [number,number])[])=>{let x=ARM.x,y=ARM.y;at('pointerdown',x,y);for(const [dx,dy] of steps){x+=dx;y+=dy;at('pointermove',x,y);}at('pointerup',x,y);};
 return {gesture,moved,pans,selected};
}

test('#331: a drag of N px calls moved with the Family factor and clamps, once it passes the click line, and selects nothing',async()=>{
 const s=stage((await panBinder()).bind);
 // 2 px (a click so far), +2 px (travel 4 > 3: the whole 4 px is delivered), then 40,-20, then 400 right, then 400 left 300 down.
 s.gesture([[2,0],[2,0],[40,-20],[400,0],[-400,300]]);
 expect(CLICK_SLOP_PX).toBe(3);
 expect(s.moved).toEqual([{x:4/SCALE*.25,y:0},{x:40/SCALE*.25,y:20/SCALE*.25},{x:8,y:0},{x:-8,y:-6}]);
 expect(s.pans).toHaveLength(5);expect(s.selected).toEqual([]);
});

test('#331: a click under the threshold calls moved zero times and selects; exactly 3 px is still a click',async()=>{
 const {bind}=await panBinder();
 for(const steps of [[],[[2,2]],[[3,0]],[[1,1],[1,1]]] as const){
  const s=stage(bind);s.gesture(steps);
  expect({steps,moved:s.moved.length,selected:s.selected}).toEqual({steps,moved:0,selected:['arm']});
 }
});

test('#331: one line over the whole gesture: out past it and back is a drag, not a click',async()=>{
 const s=stage((await panBinder()).bind);
 s.gesture([[20,0],[-20,0]]);
 expect(s.moved).toEqual([{x:2.5,y:0},{x:-2.5,y:0}]);expect(s.selected).toEqual([]);
});

test('#331: a press made with Space held pans only',async()=>{
 const pan=await panBinder(),s=stage(pan.bind);
 pan.space(true);s.gesture([[40,0],[40,0]]);pan.space(false);
 expect(s.moved).toEqual([]);expect(s.pans).toEqual([[40,0],[40,0]]);
 s.gesture([[40,0]]);expect(s.moved).toEqual([{x:5,y:0}]);
});

test('#331 planted mutant: a carry that ignores the click line is caught by the click case',async()=>{
 const site='Math.hypot(x-press.x,y-press.y)>carry.threshold';
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8');expect(source.split(site)).toHaveLength(2);
 const s=stage((await panBinder(text=>text.replace(site,'true'))).bind);
 s.gesture([[2,0]]);
 expect(s.moved).toEqual([{x:.25,y:0}]);
});

test('#331: the rig view carries its player, the comparison carries both sides, and no reference pane carries anything',async()=>{
 const main=(await readFile(new URL('../web/viewport-controller.ts',import.meta.url),'utf8'))+(await readFile(new URL('../web/rig-viewport-provider.ts',import.meta.url),'utf8')),compare=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const entry=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),pair=await readFile(new URL('../web/viewport-pair.ts',import.meta.url),'utf8');
 expect(entry).toContain('bindNavigation(rigPanCarry(');
 expect(main).toContain("target==='rig'?carryRig:undefined,");
 expect(main).toContain('const impulse=dragImpulse(dx,dy,rigScale);if(impulse&&player)player.moved(impulse);');
 expect(compare).toContain("target==='reference'?undefined:carryBoth));");
 expect(compare).toContain("for(const side of ['a','b'] as const){const impulse=dragImpulse(dx,dy,rigScales[side]);if(impulse)players[side]?.moved(impulse);}");
 // The retired Drag to trail toggle left no second drag handler behind.
 for(const source of [main,entry,pair,compare,await readFile(new URL('../web/compare-picked-tools.ts',import.meta.url),'utf8'),await readFile(new URL('../web/index.html',import.meta.url),'utf8')])expect(source).not.toContain('drag-trail');
});
