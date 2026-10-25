/** Independent actual-browser probe of a different held slot, outside the Solo slot's primitives. */
export function otherSlotProbe(excluded:string|null,wanted?:string){
 const api=window as any,rows=api.__testFullRows() as any[],box=document.getElementById('rig-viewport')!.getBoundingClientRect();
 const inside=(p:number[],x:number,y:number)=>{let hit=false;for(let i=0,j=p.length-2;i<p.length;j=i,i+=2)if((p[i+1]!>y)!==(p[j+1]!>y)&&x<(p[j]!-p[i]!)*(y-p[i+1]!)/(p[j+1]!-p[i+1]!)+p[i]!)hit=!hit;return hit;};
 const polygons=(r:any):number[][]=>r.kind==='region'?[r.corners]:r.kind==='mesh'?Array.from({length:r.triangles.length/3},(_,i)=>r.triangles.slice(i*3,i*3+3).flatMap((v:number)=>[r.vertices[v*2],r.vertices[v*2+1]])):[];
 const contains=(r:any,x:number,y:number)=>(!r.clip||inside(r.clip.polygon,x,y)!==r.clip.inverse)&&polygons(r).some(p=>inside(p,x,y));
 for(const row of rows.slice().reverse()){
  if(row.slot===excluded||wanted&&row.slot!==wanted)continue;
  for(const polygon of polygons(row)){
   let x=0,y=0;for(let i=0;i<polygon.length;i+=2){x+=polygon[i]!;y+=polygon[i+1]!;}x/=polygon.length/2;y/=polygon.length/2;
   if(rows.some(r=>r.slot===excluded&&contains(r,x,y)))continue;
   if(rows.slice().reverse().find(r=>contains(r,x,y))?.slot!==row.slot)continue;
   const p=api.rigReviewEditor.screen(x,y),target=document.elementFromPoint(p.x,p.y);
   if(p.x>box.left+12&&p.x<box.right-12&&p.y>box.top+12&&p.y<box.bottom-12&&!target?.closest('button,input,select,textarea'))return {...p,slot:row.slot};
  }
 }
 return null;
}
