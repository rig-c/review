/** Read-only projections of the hash-verified compiled skeleton. Stored numbers never change. */
export type InspectionTarget = {kind:'bone'|'slot';name:string}|null;
export interface StoredKey {time:number;curve?:number[]|'stepped';[field:string]:unknown}
export interface InspectionTrack {kind:'bone'|'slot';target:string;name:string;pointer:string;keys:readonly StoredKey[]}
export interface InspectionBone {name:string;parent?:string;rotation?:number;x?:number;y?:number;scaleX?:number;scaleY?:number;shearX?:number;shearY?:number}
export interface AnimationInspection {name:string;duration:number;bones:readonly InspectionBone[];slots:readonly {name:string;bone:string}[];tracks:readonly InspectionTrack[]}
export type LocalProperty='rotation'|'x'|'y'|'scaleX'|'scaleY'|'shearX'|'shearY';
export const CHANNELS:Readonly<Record<string,readonly {field:string;local:LocalProperty}[]>>={
 rotate:[{field:'value',local:'rotation'}],translate:[{field:'x',local:'x'},{field:'y',local:'y'}],
 translatex:[{field:'value',local:'x'}],translatey:[{field:'value',local:'y'}],
 scale:[{field:'x',local:'scaleX'},{field:'y',local:'scaleY'}],scalex:[{field:'value',local:'scaleX'}],scaley:[{field:'value',local:'scaleY'}],
 shear:[{field:'x',local:'shearX'},{field:'y',local:'shearY'}],shearx:[{field:'value',local:'shearX'}],sheary:[{field:'value',local:'shearY'}],
};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fail=(why:string):never=>{throw new Error('ANIMATION_INSPECTION_UNAVAILABLE: '+why);};
export function readAnimationInspection(document:unknown,name:string):AnimationInspection {
 if(!object(document)||document.spec!=='rigc-compiled/3'||!Array.isArray(document.animations)||!Array.isArray(document.bones)||!Array.isArray(document.slots))return fail('a compiled skeleton is required');
 const bones=document.bones as InspectionBone[],slots=document.slots as {name:string;bone:string}[];
 if(bones.some(b=>!b||typeof b.name!=='string')||slots.some(s=>!s||typeof s.name!=='string'||!bones.some(b=>b.name===s.bone)))return fail('invalid bone/slot catalog');
 const index=document.animations.findIndex(a=>object(a)&&a.name===name),a=document.animations[index];
 if(!object(a)){if(!name)return {name:'',duration:0,bones,slots,tracks:[]};return fail('animation not in the drawn build');}
 const tracks:InspectionTrack[]=[];
 for(const [group,kind,catalog]of [['bones','bone',bones],['slots','slot',slots]] as const){
  if(!Array.isArray(a[group]))return fail('missing '+group);
  for(const [i,target]of a[group].entries()){
   if(!object(target)||typeof target.name!=='string'||!catalog.some(c=>c.name===target.name)||!Array.isArray(target.timelines))return fail('invalid '+group+' target');
   for(const [j,tl]of target.timelines.entries()){
    if(!object(tl)||typeof tl.name!=='string'||!Array.isArray(tl.keys))return fail('invalid timeline');
    const channels=kind==='bone'?CHANNELS[tl.name]:undefined;
    for(const [k,key]of tl.keys.entries()){
     if(!object(key)||typeof key.time!=='number'||!Number.isFinite(key.time)||key.time<0||k>0&&key.time<(tl.keys[k-1] as StoredKey).time)return fail('invalid key time');
     if(channels&&channels.some(c=>typeof key[c.field]!=='number'||!Number.isFinite(key[c.field])))return fail('invalid channel value');
     if(key.curve!==undefined&&key.curve!=='stepped'&&(!Array.isArray(key.curve)||!key.curve.every(n=>typeof n==='number'&&Number.isFinite(n))||channels&&key.curve.length!==4*channels.length))return fail('invalid curve');
    }
    tracks.push({kind,target:target.name,name:tl.name,pointer:`/animations/${index}/${group}/${i}/timelines/${j}`,keys:tl.keys as StoredKey[]});
   }
  }
 }
 return {name,duration:typeof a.duration==='number'?a.duration:0,bones,slots,tracks};
}
export function boneHierarchy(inspection:AnimationInspection){
 const seen=new Set<string>();return inspection.bones.map(b=>{
  if(seen.has(b.name)||b.parent&&!seen.has(b.parent))return fail('bone hierarchy is not parent-first');seen.add(b.name);
  return {name:b.name,parent:b.parent??null,slots:inspection.slots.filter(s=>s.bone===b.name).map(s=>s.name)};
 });
}
export function filterTracks(inspection:AnimationInspection,selected:InspectionTarget){return inspection.tracks.filter(t=>!selected||t.kind===selected.kind&&t.target===selected.name);}
export function channelSegments(track:InspectionTrack,channel:number){
 const field=CHANNELS[track.name]?.[channel]?.field;if(track.kind!=='bone'||!field)return [];
 return track.keys.slice(0,-1).map((key,i)=>({from:[key.time,key[field] as number] as const,to:[track.keys[i+1]!.time,track.keys[i+1]![field] as number] as const,curve:Array.isArray(key.curve)?key.curve.slice(channel*4,channel*4+4):key.curve??'linear'}));
}

/** Derived from rig-c v2.67.0 src/core/animation.ts::bezierPolyline/channelAt (MIT).
 * Verified against the published Play 1.14.0 source map. These transient Float32 evaluation
 * points are never stored/drawn as curve data. The stored SVG cubic uses the original numbers. */
function interior(p0:number,p1:number,p2:number,p3:number):number[]{
 const second=(p0-2*p1+p2)*0.03,third=((p1-p2)*3-p0+p3)*0.006;
 let first=(p1-p0)*0.3+second+third*0.16666667,d2=second*2+third,at=p0;const points:number[]=[];
 for(let i=1;i<10;i++){at+=first;first+=d2;d2+=third;points.push(Math.fround(at));}return points;
}
const polylineCache=new WeakMap<StoredKey,Map<string,{end:StoredKey;points:number[]}>>();
export function evaluateStoredChannel(track:InspectionTrack,channel:number,t:number):number|null {
 const field=CHANNELS[track.name]?.[channel]?.field;if(track.kind!=='bone'||!field||!Number.isFinite(t))return null;
 let index=-1;for(let i=0;i<track.keys.length;i++){if(Math.fround(track.keys[i]!.time)<=t)index=i;else break;}
 if(index<0)return null;const a=track.keys[index]!,b=track.keys[index+1],av=Math.fround(a[field] as number);
 if(!b||a.curve==='stepped')return av;const bv=Math.fround(b[field] as number),at=Math.fround(a.time),bt=Math.fround(b.time);
 if(!a.curve)return av+((t-at)/(bt-at))*(bv-av);
 let cached=polylineCache.get(a);if(!cached){cached=new Map();polylineCache.set(a,cached);}let kept=cached.get(field);
 if(!kept||kept.end!==b){
  const c=a.curve.slice(channel*4,channel*4+4),xs=interior(a.time,c[0]!,c[2]!,b.time),ys=interior(a[field] as number,c[1]!,c[3]!,b[field] as number);
  kept={end:b,points:[at,av,...xs.flatMap((x,i)=>[x,ys[i]!]),bt,bv]};cached.set(field,kept);
 }
 const points=kept.points;let i=2;while(i<points.length-2&&points[i]!<t)i+=2;
 const [x0,y0,x1,y1]=[points[i-2]!,points[i-1]!,points[i]!,points[i+1]!];return y0+((t-x0)/(x1-x0))*(y1-y0);
}
export function evaluateBoneLocals(inspection:AnimationInspection,name:string,t:number):Record<LocalProperty,number>{
 const setup=inspection.bones.find(b=>b.name===name);if(!setup)return fail('unknown bone '+name);
 const locals={rotation:setup.rotation??0,x:setup.x??0,y:setup.y??0,scaleX:setup.scaleX??1,scaleY:setup.scaleY??1,shearX:setup.shearX??0,shearY:setup.shearY??0};
 for(const track of inspection.tracks){if(track.kind!=='bone'||track.target!==name)continue;
  CHANNELS[track.name]?.forEach((c,i)=>{const v=evaluateStoredChannel(track,i,t),scale=c.local==='scaleX'||c.local==='scaleY',base=setup[c.local]??(scale?1:0);locals[c.local]=scale?base*(v??1):base+(v??0);});
 }return locals;
}
