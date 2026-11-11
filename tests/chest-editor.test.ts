import {rigWorkspaceMarkup,rigReviewDialogMarkup,rigLayerControlsMarkup,sharedViewToolsMarkup,sharedCommentMarkup} from '../src/compare-html.ts';
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {bindChestEditor,bustInputId,bustLabel,canvasToCrop,chestEditVisible,chestPoseOffset,circleFields,dragBust,editorStatus,hitBustHandle,mirrorBust,posedChestMapping,rowCircle,settleBust,type BustDrag} from '../web/chest-editor.ts';
import {chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';
import {seedFields} from '../web/rebuild-client.ts';

const html=()=>(rigWorkspaceMarkup.replace('<div data-workspace-view-tools></div>',sharedViewToolsMarkup)+rigReviewDialogMarkup);
const between=(text:string,start:string,end:string)=>{const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<a)throw new Error(`missing ${start} … ${end}`);return text.slice(a,b+end.length);};

test('the three drag modes turn pointer deltas into source pixels through the camera scale',()=>{
 const from={cx:296,cy:650,r:26,band:42},base:Omit<BustDrag,'mode'>={side:'r',start:{x:100,y:100},centre:{x:100,y:100},from};
 // Scale 2: two canvas px per source px.
 expect(dragBust({...base,mode:'move'},{x:120,y:90},2)).toEqual({cx:306,cy:645,r:26,band:42});
 expect(dragBust({...base,mode:'r'},{x:160,y:100},2)).toEqual({...from,r:30});
 expect(dragBust({...base,mode:'band'},{x:100,y:0},2)).toEqual({...from,band:24});
 // The example's limits: r 6–120, band 4–120.
 expect(dragBust({...base,mode:'r'},{x:101,y:100},2).r).toBe(6);
 expect(dragBust({...base,mode:'r'},{x:900,y:100},2).r).toBe(120);
 expect(dragBust({...base,mode:'band'},{x:100,y:90},2).band).toBe(4);
 expect(dragBust({...base,mode:'band'},{x:100,y:-900},2).band).toBe(120);
 // No camera scale, no edit.
 expect(dragBust({...base,mode:'move'},{x:500,y:500},0)).toEqual(from);
});

test('hit order follows the example: core handle or edge, band handle or edge, then the centre',()=>{
 const circles=[{side:'r' as const,center:{x:100,y:100},pxR:20,pxBand:50},{side:'l' as const,center:{x:300,y:100},pxR:20,pxBand:50}];
 expect(hitBustHandle(circles,{x:120,y:100})).toEqual({side:'r',mode:'r'});
 expect(hitBustHandle(circles,{x:100,y:50})).toEqual({side:'r',mode:'band'});
 expect(hitBustHandle(circles,{x:150,y:100})).toEqual({side:'r',mode:'band'});
 expect(hitBustHandle(circles,{x:103,y:104})).toEqual({side:'r',mode:'move'});
 // Family parity (#307): grabbing anywhere inside the outer band disc (not only inside the small core r) moves the centre, and the bottom band edge also hits band.
 expect(hitBustHandle(circles,{x:135,y:100})).toEqual({side:'r',mode:'move'});
 expect(hitBustHandle(circles,{x:100,y:150})).toEqual({side:'r',mode:'band'});
 expect(hitBustHandle(circles,{x:300,y:100})).toEqual({side:'l',mode:'move'});
 expect(hitBustHandle(circles,{x:200,y:300})).toBeNull();
});

test('mirror copies R y, r and band to L; settle clamps live and names only the sides the non-overlap rule changed',()=>{
 expect(mirrorBust({cx:296,cy:650,r:26,band:42},{cx:438})).toEqual({cx:438,cy:650,r:26,band:42});
 expect(settleBust({cx:296,cy:650,r:26,band:42},{cx:438,cy:650,r:28,band:44})).toEqual({right:{cx:296,cy:650,r:26,band:42},left:{cx:438,cy:650,r:28,band:44},clamped:[]});
 expect(settleBust({cx:384,cy:724,r:24,band:38},{cx:514,cy:720,r:25,band:60})).toEqual({right:{cx:384,cy:724,r:24,band:30},left:{cx:514,cy:720,r:25,band:49},clamped:['r','l']});
 // A range clamp alone (band 200 → 120) is not a non-overlap clamp.
 expect(settleBust({cx:296,cy:650,r:26,band:200},{cx:900,cy:650,r:28,band:44}).clamped).toEqual([]);
});

test('rows are circles only with equal semi-axes and no clip; r writes both semi-axes',()=>{
 const values:Record<string,ChestFieldValue>={};const read=(id:string)=>values[id];
 Object.entries(circleFields(0,{cx:296,cy:650,r:26,band:42})).forEach(([id,value])=>{values[id]={value};});
 expect(values[chestRowId(0,'ax')]?.value).toBe('26');expect(values[chestRowId(0,'ay')]?.value).toBe('26');
 expect(rowCircle(read,0)).toEqual({cx:296,cy:650,r:26,band:42});
 values[chestRowId(0,'ay')]={value:'30'};expect(rowCircle(read,0)).toBeNull();
 values[chestRowId(0,'ay')]={value:'26'};values[chestRowId(0,'clip')]={value:'330'};expect(rowCircle(read,0)).toBeNull();
 expect(rowCircle(read,1)).toBeNull();
});

test('Apply · Rebuild is the host\'s: the editor holds the producer\'s line over the drag help and never reaches a process or the server',async()=>{
 const mapped={available:true,crop:{w:10,h:10},toWorld:(x:number,y:number)=>({x,y}),basis:'b'} as const,unmapped={available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: x'} as const;
 expect(editorStatus(null,mapped)).toEqual({text:'Drag a centre to move · the right-edge handle sets r · the dashed top handle sets band · Space-drag pans',error:false});
 expect(editorStatus(null,unmapped)).toEqual({text:'CHEST_REGION_MAPPING_UNAVAILABLE: x — the values still edit and export; nothing is drawn on the stage.',error:true});
 const line='FAIL  REMESH_REQUEST_HELD: rig.json bones — the request changes it';
 expect(editorStatus({text:line,error:true},mapped)).toEqual({text:line,error:true});
 // The editor module has no path to a process, a server mutation or a manifest command; main.ts owns the request.
 const source=await readFile(new URL('../web/chest-editor.ts',import.meta.url),'utf8');
 for(const word of ['fetch(','child_process','Bun.spawn','XMLHttpRequest','/api/'])expect(source).not.toContain(word);
 const page=await html();
 expect(between(page,'<button id="bust-apply"','</button>')).not.toContain('aria-disabled');expect(page).not.toContain('MODELING_INPUT_UNAVAILABLE');
 expect(between(page,'<button id="bust-reset"','</button>')).toContain(' disabled>Reset');
 expect(page).toContain('<textarea id="rebuild-applied" class="sr-only" hidden aria-hidden="true" tabindex="-1"></textarea>');
});

test('the Chest regions toggle opens in one click from both Setup and Animate and stays open across mode switches (#307)',async()=>{
 expect(chestEditVisible('rig')).toBe(true);
 expect(chestEditVisible('playback')).toBe(true);
 for(const other of ['feedback','view',undefined])expect(chestEditVisible(other)).toBe(false);
 const page=await html(),bar=between(page,'<div class="viewbar">','<div id="stage-layout"'),tools=between(bar,'<div class="view-tools">','</div>');
 expect(tools).toMatch(/<button id="chest-edit" type="button"[^>]* aria-pressed="false"[^>]* hidden>Chest regions<\/button>/);
 const editor=between(bar,'<div id="chest-editor-bar"','<span id="chest-editor-status"');expect(editor).toContain(' hidden>');
 expect(editor).toContain("● R · character's right (image left)");
 expect(editor).toContain("● L · character's left (image right)");
 expect(editor).toContain('>Y·size symmetry</button>');
 for(const side of ['r','l'] as const)for(const field of ['x','y','r','band'] as const)expect(editor).toContain(`id="${bustInputId(side,field)}"`);
 for(const id of ['bust-mirror','bust-download','bust-apply'])expect(editor).toContain(`id="${id}"`);
 expect(page.indexOf('id="chest-editor-bar"')).toBeLessThan(page.indexOf('id="stage-layout"'));
});

test('#307: Family parity — Y·size symmetry and live drag/input never shrink overlapping outer bands, contour.bust seeds Circles, and posedChestMapping follows the chest bone',()=>{
 // 1. Posed chest mapping shifts toWorld and inverts cleanly via canvasToCrop.
 const baseMapping={available:true as const,crop:{w:832,h:1216},toWorld:(x:number,y:number)=>({x:x-416,y:1216-y}),basis:'stage'};
 const offset=chestPoseOffset({bone:(name:string)=>name==='chest'?{x:14,y:682}:null},{x:2,y:670});
 expect(offset).toEqual({x:12,y:12});
 const posed=posedChestMapping(baseMapping,offset);
 expect(posed.toWorld(382,732)).toEqual({x:382-416+12,y:1216-732+12});
 const project=(x:number,y:number)=>({x:300+x*2,y:900-y*2});
 const screenPt=project(posed.toWorld(382,732).x,posed.toWorld(382,732).y);
 expect(canvasToCrop(project,posed.toWorld,screenPt)).toEqual([382,732]);

 // 2. seedFields seeds chest-0-* and chest-1-* from contour.bust when contour.regions is absent.
 const bustValues:Record<string,ChestFieldValue>={};
 const bustSeed=seedFields({parts:[{name:'topwear',regions:[]}],contour:{topwear:{contour:{tolerance:2,bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],bone_r:'boob_r',bone_l:'boob_l'}}}}},id=>bustValues[id]);
 expect(bustSeed).toMatchObject({
  [chestRowId(0,'name')]:'bust_r',[chestRowId(0,'bone')]:'boob_r',[chestRowId(0,'cx')]:'384',[chestRowId(0,'cy')]:'345',[chestRowId(0,'ax')]:'6',[chestRowId(0,'ay')]:'6',[chestRowId(0,'band')]:'22',
  [chestRowId(1,'name')]:'bust_l',[chestRowId(1,'bone')]:'boob_l',[chestRowId(1,'cx')]:'446',[chestRowId(1,'cy')]:'345',[chestRowId(1,'ax')]:'6',[chestRowId(1,'ay')]:'6',[chestRowId(1,'band')]:'22',
 });

 // 3. Y·size symmetry (#bust-mirror) on jinni (R: 382,732 r=16 band=73; L: 554,722 r=13 band=66) copies R's cy, r, band to L without clamping R or L down to 69.
 const jinniR={cx:382,cy:732,r:16,band:73},jinniL={cx:554,cy:722,r:13,band:66};
 expect(settleBust(jinniR,mirrorBust(jinniR,{cx:jinniL.cx})).right.band).toBe(69); // old settleBust shrinks 73 -> 69
 const els=new Map<string,any>();
 const makeEl=(id:string)=>{
  const e:any={id,value:'',textContent:'',title:'',hidden:id==='chest-editor-bar',disabled:false,dataset:{},attrs:new Map<string,string>(),listeners:new Map<string,Function[]>(),classList:{toggle:()=>{}},setAttribute(k:string,v:string){this.attrs.set(k,v);},getAttribute(k:string){return this.attrs.get(k)??null;},addEventListener(k:string,fn:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),fn]);},removeEventListener(){},dispatch(k:string,ev:any={}){for(const fn of this.listeners.get(k)??[])fn(ev);},querySelectorAll:()=>[],closest:()=>null,getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture(){},hasPointerCapture:()=>false,releasePointerCapture(){}};
  els.set(id,e);return e;
 };
 const getEl=(id:string)=>els.get(id)??makeEl(id);
 getEl('bust-mode').value='circles';
 for(const [id,val] of Object.entries({...circleFields(0,jinniR),...circleFields(1,jinniL)}))getEl(id).value=val;
 const prevDoc=(globalThis as any).document,prevWin=(globalThis as any).window,prevMut=(globalThis as any).MutationObserver;
 (globalThis as any).document={getElementById:getEl,activeElement:null,addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]};
 (globalThis as any).window={addEventListener(){},removeEventListener(){}};
 (globalThis as any).MutationObserver=class{observe(){}disconnect(){}};
 try{
  let inspector='rig';
  const editor=bindChestEditor({pane:getEl('rig-pane'),canvas:getEl('rig-overlay'),project:()=>(x,y)=>({x,y}),mapping:()=>baseMapping,changed(){},download(){},apply(){},reset(){},message(){},inspector:()=>inspector});
  getEl('chest-edit').dispatch('click');
  expect(editor.active()).toBe(true);
  // Switching to Animate ('playback') keeps the editor open.
  inspector='playback';editor.sync();
  expect(editor.active()).toBe(true);
  expect(getEl('chest-edit').hidden).toBe(false);
  // Clicking Y·size symmetry copies R's cy, r, band to L and leaves R untouched (band stays 73, not 69).
  getEl('bust-mirror').dispatch('click');
  expect(rowCircle(id=>({value:getEl(id).value}),0)).toEqual({cx:382,cy:732,r:16,band:73});
  expect(rowCircle(id=>({value:getEl(id).value}),1)).toEqual({cx:554,cy:732,r:16,band:73});
  expect(getEl(chestRowId(0,'name')).value).toBe('bust_r');
  expect(getEl(chestRowId(1,'name')).value).toBe('bust_l');
  editor.dispose();
 }finally{
  (globalThis as any).document=prevDoc;(globalThis as any).window=prevWin;(globalThis as any).MutationObserver=prevMut;
 }
});

test('the overlay draws editor circles with handles and a label, only over a drawn rig',async()=>{
 const {createCanvas}=await import('@napi-rs/canvas'),{RigOverlays,projectCircle}=await import('../web/rig-overlays.ts');
 const surface=createCanvas(200,200);Object.assign(surface,{style:{pointerEvents:'auto'},clientWidth:200,clientHeight:200});
 const overlays=new RigOverlays({canvas:surface as unknown as HTMLCanvasElement,rigRoot:{style:{visibility:'visible'}} as unknown as HTMLElement});
 const settings={images:true,mesh:false,bones:false,meshOpacity:.65},project=(x:number,y:number)=>({x:100+x*2,y:100-y*2});
 const colors={stroke:'#00ff00',fill:'rgba(0,255,0,.1)',handle:'#ffffff',ink:'#000000',labelBg:'#202020',flash:'#ffcc00'};
 const circles=[{center:{x:0,y:0},r:10,band:20,label:'R (1,2) r:10 b:20',handles:true,colors}];
 expect(projectCircle(project,circles[0]!)).toEqual({center:{x:100,y:100},pxR:20,pxBand:60});
 const pixel=(x:number,y:number)=>[...surface.getContext('2d').getImageData(x,y,1,1).data];
 const ink=()=>{const d=surface.getContext('2d').getImageData(0,0,200,200).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]!>0)n++;return n;};
 overlays.refresh({player:null,bones:[],project,settings,dpr:1,circles});expect(ink()).toBe(0);
 const player={posedFrame:()=>{throw new Error('unused');},bone:()=>{throw new Error('unused');}} as never;
 overlays.refresh({player,bones:[],project,settings,dpr:1,circles});expect(ink()).toBeGreaterThan(400);
 // Centre handle (white), core handle on the right edge (stroke colour), band handle on the top edge (ink).
 expect(pixel(100,100).slice(0,3)).toEqual([255,255,255]);expect(pixel(120,100).slice(0,3)).toEqual([0,255,0]);expect(pixel(100,40).slice(0,3)).toEqual([0,0,0]);
 const bare=ink();overlays.redraw({project,settings,dpr:1,circles:[{...circles[0]!,handles:false,label:undefined}]});expect(ink()).toBeLessThan(bare);
});

test('#307: R and L circle labels anchor away from each other (R below-left, L below-right), stack vertically if needed, and never intersect across all 5 Family configs at 1:1 and fit zoom',async()=>{
 const {circleLabelRects,projectCircle}=await import('../web/rig-overlays.ts');
 const {boxesIntersect}=await import('../web/label-placement.ts');
 const familyConfigs=[
  {id:'jinni',r:{cx:382,cy:732,r:16,band:73},l:{cx:554,cy:722,r:13,band:66}},
  {id:'naru',r:{cx:333,cy:616,r:22,band:64},l:{cx:489,cy:626,r:24,band:65}},
  {id:'nova',r:{cx:256,cy:749,r:45,band:65},l:{cx:424,cy:747,r:35,band:65}},
  {id:'roa',r:{cx:295,cy:599,r:42,band:60},l:{cx:496,cy:598,r:28,band:62}},
  {id:'luna',r:{cx:319,cy:600,r:29,band:58},l:{cx:477,cy:605,r:21,band:59}},
 ] as const;
 // 1:1 scale (1.0) and fit zoom (~0.25 for an 800×2284 rig in a 900×580 viewport, plus posed overlay ~0.50).
 for(const scale of [1,0.5,0.25,0.18]){
  const project=(x:number,y:number)=>({x:450+(x-400)*scale,y:300+(y-700)*scale});
  for(const cfg of familyConfigs){
   const rProj=projectCircle(project,{center:{x:cfg.r.cx,y:cfg.r.cy},r:cfg.r.r,band:cfg.r.band})!;
   const lProj=projectCircle(project,{center:{x:cfg.l.cx,y:cfg.l.cy},r:cfg.l.r,band:cfg.l.band})!;
   const rText=bustLabel('r',cfg.r),lText=bustLabel('l',cfg.l);
   // 11px monospace is ~6.6px/char + 8px padding
   const rWidth=Math.ceil(rText.length*6.8)+8,lWidth=Math.ceil(lText.length*6.8)+8;
   const rects=circleLabelRects([
    {center:rProj.center,pxBand:rProj.pxBand,width:rWidth,row:0},
    {center:lProj.center,pxBand:lProj.pxBand,width:lWidth,row:1},
   ]);
   expect(rects).toHaveLength(2);
   const [rectR,rectL]=rects as [typeof rects[0],typeof rects[0]];
   // R is anchored below-left of its ring; L is anchored below-right of its ring.
   expect(rectR.x+rectR.w).toBeLessThanOrEqual(rProj.center.x);
   expect(rectL.x).toBeGreaterThanOrEqual(lProj.center.x);
   expect(boxesIntersect(rectR,rectL)).toBe(false);
  }
 }
 // When two circles cross so their horizontal spans overlap, they stack vertically without intersecting.
 const stacked=circleLabelRects([
  {center:{x:200,y:200},pxBand:40,width:140,row:0},
  {center:{x:150,y:200},pxBand:40,width:140,row:1},
 ]);
 expect(boxesIntersect(stacked[0]!,stacked[1]!)).toBe(false);
 expect(stacked[1]!.y).toBeGreaterThanOrEqual(stacked[0]!.y+stacked[0]!.h);
});
