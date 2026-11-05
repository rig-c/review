import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {parseBookmark,encodeBookmark,decodeBookmark} from '../web/inspection-persistence.ts';
const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
const serializer=source.slice(source.indexOf('function inspectionBookmark()'),source.indexOf('async function restoreInspection('));
const binding={mode:'single' as const,sourceHash:'a'.repeat(64),rigs:['b'.repeat(64)]};
function snapshot(time:number,runtime:number|null){
 const body=`const {time,player,binding}=deps,animation='idle',appearance=null,layers={images:true,mesh:true,bones:false},turnPad=null,parts=null,view='rig',checkpoint=null,selectedPerson='',axisInspection=false;const inspectionBinding=()=>binding,numericView=()=>({schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:null}}),selectedInspector=()=> 'playback',select=()=>({value:'',disabled:true});${serializer};return inspectionBookmark();`;
 return new Function('deps',new Bun.Transpiler({loader:'ts'}).transformSync(body))({time,player:runtime===null?null:{time:runtime},binding});
}
test('looped bookmark serializes inspected seconds independently of accumulated runtime',()=>{
 // Explicit domain control: the third loop is showing .25s while the runtime is at 3.25s.
 const result=parseBookmark(snapshot(.25,3.25),binding);
 expect(result.time).toBe(.25);expect(decodeBookmark(encodeBookmark(result),binding)).toEqual(result);
});
test('zero, clip endpoint and reference-only inspection preserve exact seconds',()=>{
 for(const [time,runtime] of [[0,4],[1,5],[.375,null]] as const)expect(parseBookmark(snapshot(time,runtime),binding).time).toBe(time);
});
test('supplied invalid and foreign bookmarks are never normalized into valid views',()=>{
 const supplied=snapshot(.25,3.25);
 // Parsing finite positive seconds is intentionally separate from clip-domain preparation.
 expect(parseBookmark({...supplied,time:9},binding).time).toBe(9);
 for(const time of [-1,Infinity,NaN])expect(()=>parseBookmark({...supplied,time},binding)).toThrow();
 expect(()=>parseBookmark(supplied,{...binding,sourceHash:'c'.repeat(64)})).toThrow('VIEW_SOURCE_CHANGED');
 expect(()=>parseBookmark(supplied,{...binding,rigs:['d'.repeat(64)]})).toThrow('VIEW_SOURCE_CHANGED');
});
