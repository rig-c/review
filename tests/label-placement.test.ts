import {expect,test} from 'bun:test';
import {boxesIntersect,labelCandidates,placeLabels,type LabelInput} from '../web/label-placement.ts';

/** Estimated monospace width: 6.6 px per character + 8 px padding, as the stage font measures roughly. */
const width=(text:string)=>text.length*6.6+8;
const arm:LabelInput[]=[
 {at:{x:400,y:300},width:width('shoulder · upperarm_l')},
 {at:{x:430,y:340},width:width('elbow · upperarm_l')},
 {at:{x:438,y:346},width:width('fore elbow · forearm_l')},
 {at:{x:450,y:352},width:width('wrist · hand_l')},
];

function pairsIntersecting(placed:ReturnType<typeof placeLabels>){
 const shown=placed.filter(p=>p.visible).map(p=>p.box),hits:[number,number][]=[];
 for(let i=0;i<shown.length;i++)for(let j=i+1;j<shown.length;j++)if(boxesIntersect(shown[i]!,shown[j]!))hits.push([i,j]);
 return hits;
}

test('joints closer than one label width: no two shown label boxes intersect',()=>{
 // The fixture is the case of the issue: the home boxes of the clustered joints overlap.
 const homes=arm.map(a=>labelCandidates(a)[0]!);
 expect(boxesIntersect(homes[1]!,homes[2]!)).toBe(true);
 expect(Math.hypot(arm[2]!.at.x-arm[1]!.at.x,arm[2]!.at.y-arm[1]!.at.y)).toBeLessThan(arm[1]!.width);
 const placed=placeLabels(arm,{bounds:{width:1000,height:800}});
 expect(pairsIntersecting(placed)).toEqual([]);
 expect(placed.every(p=>p.visible)).toBe(true);
 // A label that left its home slot is flagged so the overlay draws a leader to the point.
 expect(placed.some(p=>p.moved)).toBe(true);
});

test('labels that can stay at their anchor do',()=>{
 const far:LabelInput[]=[{at:{x:100,y:100},width:80},{at:{x:400,y:100},width:80},{at:{x:100,y:400},width:80}];
 const placed=placeLabels(far);
 placed.forEach((p,i)=>{expect(p.moved).toBe(false);expect(p.visible).toBe(true);expect(p.box).toEqual(labelCandidates(far[i]!)[0]!);});
 // The first label of a cluster keeps its home slot too.
 expect(placeLabels(arm)[0]!.box).toEqual(labelCandidates(arm[0]!)[0]!);
});

test('output is deterministic',()=>{
 const a=placeLabels(arm,{bounds:{width:1000,height:800}}),b=placeLabels(arm.map(x=>({...x,at:{...x.at}})),{bounds:{width:1000,height:800}});
 expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test('a label with no free slot is hidden; a pinned label is always shown and wins its home slot',()=>{
 // Twelve joints on one spot with one ring: there are only 6 slots.
 const pile:LabelInput[]=Array.from({length:12},(_,i)=>({at:{x:300,y:300},width:width(`joint ${i} · part`)}));
 const placed=placeLabels(pile,{rows:1});
 expect(placed.filter(p=>p.visible).length).toBe(6);
 expect(pairsIntersecting(placed)).toEqual([]);
 const pinned=placeLabels(pile.map((p,i)=>i===11?{...p,pinned:true}:p),{rows:1});
 expect(pinned[11]).toEqual({box:labelCandidates(pile[11]!,{rows:1})[0]!,visible:true,moved:false});
 expect(pinned[0]!.moved).toBe(true);
 expect(pairsIntersecting(pinned)).toEqual([]);
});

test('bounds: a box never leaves the canvas when a free slot inside exists',()=>{
 const edge:LabelInput[]=[{at:{x:790,y:300},width:120}];
 const [p]=placeLabels(edge,{bounds:{width:800,height:600}});
 expect(p!.visible).toBe(true);expect(p!.box.x+p!.box.w).toBeLessThanOrEqual(800);expect(p!.box.x).toBeGreaterThanOrEqual(0);
});

test('obstacles: no shown label covers a point glyph',()=>{
 const glyphs=arm.map(a=>({x:a.at.x-6.5,y:a.at.y-6.5,w:13,h:13}));
 const placed=placeLabels(arm,{bounds:{width:1000,height:800},obstacles:glyphs});
 expect(pairsIntersecting(placed)).toEqual([]);
 for(const p of placed.filter(p=>p.visible))for(const g of glyphs)expect(boxesIntersect(p.box,g)).toBe(false);
});
