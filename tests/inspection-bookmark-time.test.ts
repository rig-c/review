import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {parseBookmark,encodeBookmark,decodeBookmark} from '../web/inspection-persistence.ts';
const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
const serializer=source.slice(source.indexOf('function inspectionBookmark()'),source.indexOf('async function restoreInspection('));
const binding={mode:'single' as const,sourceHash:'a'.repeat(64),rigs:['b'.repeat(64)]};
function snapshot(time:number,runtime:number|null,inspection:{mode:string|null;inspector:string|null}={mode:'playback',inspector:'playback'},rigDifference:{bookmark:unknown}|null=null){
 const document={querySelector:(selector:string)=>{if(selector!=='[data-mode][aria-pressed="true"]')throw new Error('Unexpected inspection mode query: '+selector);return inspection.mode===null?null:{dataset:{mode:inspection.mode}};}};
 const body=`const {time,player,binding,document,inspector,rigDifference}=deps,animation='idle',appearance=null,layers={images:true,mesh:true,bones:false},turnPad=null,parts=null,view='rig',checkpoint=null,selectedPerson='',axisInspection=false;const inspectionBinding=()=>binding,numericView=()=>({schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:null}}),selectedInspector=()=>inspector,select=()=>({value:'',disabled:true});${serializer};return inspectionBookmark();`;
 return new Function('deps',new Bun.Transpiler({loader:'ts'}).transformSync(body))({time,player:runtime===null?null:{time:runtime},binding,document,inspector:inspection.inspector,rigDifference});
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

test('bookmark source mode takes precedence over the act tab, with existing inspector and rig fallbacks',()=>{
 expect(snapshot(.25,3.25,{mode:'rig',inspector:'feedback'}).selection.inspector).toBe('rig');
 expect(snapshot(.25,3.25,{mode:'playback',inspector:'feedback'}).selection.inspector).toBe('playback');
 expect(snapshot(.25,3.25,{mode:null,inspector:'playback'}).selection.inspector).toBe('playback');
 expect(snapshot(.25,3.25,{mode:null,inspector:null}).selection.inspector).toBe('rig');
});


test('#739 diagnostic bookmark returns a detached copy of the regular inspection, not diagnostic time or mode',()=>{
 const saved=parseBookmark(snapshot(.25,3.25),binding);
 const result=snapshot(.75,9.75,{mode:'rig',inspector:'feedback'},{bookmark:saved});
 expect(result).toEqual(saved);expect(result).not.toBe(saved);expect(result.time).toBe(.25);expect(result.selection.inspector).toBe('playback');
 expect(result.layers).not.toBe(saved.layers);expect(result.binding.rigs).not.toBe(saved.binding.rigs);
 result.layers.images=false;result.binding.rigs[0]='d'.repeat(64);result.selection.inspector='rig';
 expect(saved.layers.images).toBe(true);expect(saved.binding.rigs[0]).toBe('b'.repeat(64));expect(saved.selection.inspector).toBe('playback');
 expect(snapshot(1,12,{mode:null,inspector:null},{bookmark:saved})).toEqual(saved);
});
