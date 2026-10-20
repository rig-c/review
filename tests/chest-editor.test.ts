import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {bustInputId,chestEditVisible,circleFields,dragBust,editorStatus,hitBustHandle,mirrorBust,rowCircle,settleBust,type BustDrag} from '../web/chest-editor.ts';
import {chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';

const html=()=>readFile(new URL('../web/index.html',import.meta.url),'utf8');
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

test('the Chest regions toggle is Setup only and starts hidden and unpressed in the view bar tool area',async()=>{
 expect(chestEditVisible('rig')).toBe(true);
 for(const other of ['playback','feedback','view',undefined])expect(chestEditVisible(other)).toBe(false);
 const page=await html(),bar=between(page,'<div class="viewbar">','<div id="stage-layout"'),tools=between(bar,'<div class="view-tools">','</div>');
 expect(tools).toMatch(/<button id="chest-edit" type="button"[^>]* aria-pressed="false"[^>]* hidden>Chest regions<\/button>/);
 const editor=between(bar,'<div id="chest-editor-bar"','<span id="chest-editor-status"');expect(editor).toContain(' hidden>');
 for(const side of ['r','l'] as const)for(const field of ['x','y','r','band'] as const)expect(editor).toContain(`id="${bustInputId(side,field)}"`);
 for(const id of ['bust-mirror','bust-download','bust-apply'])expect(editor).toContain(`id="${id}"`);
 expect(page.indexOf('id="chest-editor-bar"')).toBeLessThan(page.indexOf('id="stage-layout"'));
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
