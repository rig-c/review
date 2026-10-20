/**
 * Collision-free label placement for point labels on the stage overlay (#147). Pure: text widths are measured by the
 * caller (canvas `measureText`, or an estimate in tests) and passed in, so the same input always gives the same output.
 *
 * Greedy, in a stable order: pinned labels (the hovered / dragged joint) first, then the rest in input order. Each label
 * tries its home box (right of the point, rising from it), then the box left of the point, then both sides shifted up
 * and down by one row at a time; it takes the first box that intersects no box already placed nor an obstacle (the point
 * glyphs) and stays inside the bounds. A label with no free box within `rows` is hidden; a pinned label is never hidden and falls back to its home box.
 */
export interface LabelPoint {x:number;y:number}
export interface LabelInput {at:LabelPoint;width:number;pinned?:boolean}
export interface LabelBox {x:number;y:number;w:number;h:number}
export interface PlacedLabel {box:LabelBox;/** False: drawn only when pinned (hover / selection). */visible:boolean;/** The box left its home slot; draw a leader to the point. */moved:boolean}
export interface LabelPlacementOptions {
 /** Box height in px. */height?:number;
 /** Horizontal gap between the point and the box edge. */gap?:number;
 /** Vertical rise of the home box's bottom above the point. */rise?:number;
 /** Shift per ring when stepping up / down; defaults to height + 2. */step?:number;
 /** Rings of up / down shifts tried after the two home sides. */rows?:number;
 /** Canvas bounds a box must stay inside, when given. */bounds?:{width:number;height:number};
 /** Boxes a label must not cover (the point glyphs themselves), besides the labels already placed. */obstacles?:readonly LabelBox[];
}

export function boxesIntersect(a:LabelBox,b:LabelBox):boolean{return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;}

/** Candidate boxes for one label, in the order they are tried. The first one is the home box. */
export function labelCandidates(input:LabelInput,options:LabelPlacementOptions={}):LabelBox[]{
 const h=options.height??15,gap=options.gap??9,rise=options.rise??2,step=options.step??h+2,rows=options.rows??4,w=input.width;
 const right=input.at.x+gap,left=input.at.x-gap-w,home=input.at.y-rise-h,out:LabelBox[]=[{x:right,y:home,w,h},{x:left,y:home,w,h}];
 for(let k=1;k<=rows;k++){const d=k*step;out.push({x:right,y:home-d,w,h},{x:right,y:home+d,w,h},{x:left,y:home-d,w,h},{x:left,y:home+d,w,h});}
 return out;
}

export function placeLabels(inputs:readonly LabelInput[],options:LabelPlacementOptions={}):PlacedLabel[]{
 const order=inputs.map((_,i)=>i).sort((a,b)=>Number(!!inputs[b]!.pinned)-Number(!!inputs[a]!.pinned)||a-b);
 const inside=(b:LabelBox)=>!options.bounds||(b.x>=0&&b.y>=0&&b.x+b.w<=options.bounds.width&&b.y+b.h<=options.bounds.height);
 const placed:LabelBox[]=[...(options.obstacles??[])],out:PlacedLabel[]=new Array(inputs.length);
 for(const i of order){
  const input=inputs[i]!,candidates=labelCandidates(input,options),home=candidates[0]!;
  const index=candidates.findIndex(b=>inside(b)&&!placed.some(p=>boxesIntersect(b,p)));
  if(index>=0){const box=candidates[index]!;placed.push(box);out[i]={box,visible:true,moved:index>0};}
  else if(input.pinned){placed.push(home);out[i]={box:home,visible:true,moved:false};}
  else out[i]={box:home,visible:false,moved:false};
 }
 return out;
}
