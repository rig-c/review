import {readFile} from 'node:fs/promises';
import type {LocalProperty} from '../../src/animation-inspection.ts';
export async function inspectionControl(){
 const doc=JSON.parse(await readFile(new URL('../fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'));
 doc.constraints=[];Object.assign(doc.bones[1],{rotation:23.4,x:3.3,y:-2.7,scaleX:2.2,scaleY:-.5});
 doc.animations=[{...doc.animations[0],name:'control',duration:2,bones:[{name:'probe',timelines:[
  {name:'rotate',keys:[{time:.125,value:0,curve:[.325,8,.925,1]},{time:1.125,value:10}]},
  {name:'translate',keys:[{time:.125,x:0,y:5,curve:[.325,8,.925,1,.325,-2,.925,3]},{time:1.125,x:10,y:-4}]},
  {name:'scale',keys:[{time:.125,x:1,y:-1,curve:[.325,2,.925,.5,.325,-2,.925,1]},{time:1.125,x:2,y:0}]},
 ]}],slots:[]}];doc.editorOrder.animations=['control'];return doc;
}
export const properties:LocalProperty[]=['rotation','x','y','scaleX','scaleY','shearX','shearY'];
export const bytes=(v:readonly number[])=>Buffer.from(new Float64Array(v).buffer);
export function adjacent(t:number,up:boolean){if(t===0)return up?Number.MIN_VALUE:0;const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,t);d.setBigUint64(0,d.getBigUint64(0)+(up?1n:-1n));return d.getFloat64(0);}
export function fixedTimes(keys:{time:number}[],duration:number){
 const times=new Set([0,duration]);for(const [i,k]of keys.entries()){
  for(const t of [k.time,Math.fround(k.time)])for(const x of [adjacent(t,false),t,adjacent(t,true)])if(x>=0&&x<=duration)times.add(x);
  if(keys[i+1])for(const f of [0,.1,.25,.5,.75,.9,1])times.add(k.time+(keys[i+1]!.time-k.time)*f);
 }return [...times].sort((a,b)=>a-b);
}
/** Independently declared matrix: fixture shapes, not the implementation's channel table. */
export const recognizedCases=[['rotate',['value']],['translate',['x','y']],['translatex',['value']],['translatey',['value']],['scale',['x','y']],['scalex',['value']],['scaley',['value']],['shear',['x','y']],['shearx',['value']],['sheary',['value']]] as const;
export function matrixAnimations(bone:string){return recognizedCases.flatMap(([name,fields])=>['linear','stepped','bezier'].map(form=>{
 const first:Record<string,unknown>={time:.1234567},last:Record<string,unknown>={time:1.1234567};fields.forEach((field,i)=>{first[field]=i?5.1234567:.1234567;last[field]=i?-4.234567:10.234567;});
 if(form==='stepped')first.curve='stepped';if(form==='bezier')first.curve=fields.flatMap((_f,i)=>i?[.325,-2,.925,3]:[.325,8,.925,1]);
 return {name:`${name}-${form}`,duration:2,bones:[{name:bone,timelines:[{name,keys:[first,last]}]},{name:'root',timelines:[{name:'rotate',keys:[{time:0,value:0},{time:2,value:0}]}]}],slots:[],constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},attachments:[],drawOrder:[],events:[]};
}));}

