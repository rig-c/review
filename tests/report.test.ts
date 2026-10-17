import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseReport, reportFields } from '../src/report.ts';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';
import { eventSelection, eventSeekTime, eventTimingLabel, eventCoordinates, reportCounts, reportDraftForMarker } from '../web/report-view.ts';

// Synthetic values deliberately use irregular/offset timing; these are not copied assets.
function allFields(){return {
  spec:'rig-pose-report/1',rig:'synthetic',animation:'inspect',frames:8,duration:9,
  switches:[{set:'alternate',slots:{art_slot:'drawing'},frames:[1,2],from:0.7,to:2.4}],
  raised:[{chain:'arm_chain',frames:[2,3],seconds:0.4}],
  short:[{bone:'upper',joints:['scan_a','scan_b'],frames:[1,2]}],
  endOn:[{bone:'fore',frames:[2,4],seconds:0.8}],
  cleaned:{holds:[{joint:'scan_a',frames:[0,2]}],seams:[{joint:'scan_b',frame:3}]},
  feet:{jumps:[[2,4]],supports:[{side:'l',frames:[0,1]}]},
  landings:[{bone:'hip',frame:4}],shear:[{bone:'shin',frame:5}],
  artRange:[{bone:'sleeve',frames:[3,5],seconds:1.2}],
  uncovered:[{slot:'cloth',attachment:'sheet',chains:['leg_chain'],times:[0.1,0.3,4.8]}],
  flips:[{bone:'arm',frames:[1,3]}],turns:[{line:'hip',joints:['right','left'],frames:[1,2],seconds:0.9}],
  range:[{bone:'leg',frames:[5,6],seconds:0.7}],holds:[{point:'scan_c',from:5,to:7,source:4,why:'missing'}],
};}
test('all sixteen report categories preserve coordinates, source pointers and actual target names',()=>{
 const source=allFields();const before=JSON.stringify(source);const report=parseReport(source)!;
 expect(report.categories.map(c=>c.field)).toEqual([...reportFields]);expect(report.categories.every(c=>c.events.length===1&&c.state==='events')).toBe(true);
 const events=report.categories.flatMap(c=>c.events);expect(events.map(e=>e.id).length).toBe(new Set(events.map(e=>e.id)).size);
 expect(events.find(e=>e.field==='cleaned.holds')).toMatchObject({source:{path:'report.json',pointer:'/cleaned/holds/0'},frames:[0,2],targets:[],provenance:{joint:'scan_a'},timing:'frames-unmapped'});
 expect(events.find(e=>e.field==='switches')).toMatchObject({frames:[1,2],timeInterval:{start:0.7,end:2.4,endKind:'boundary'},seek:{time:0.7,source:'event'},targets:[{kind:'slot',name:'art_slot'}]});
 expect(events.find(e=>e.field==='raised')).toMatchObject({frames:[2,3],durationSeconds:0.4,targets:[],provenance:{chain:'arm_chain'},timing:'frames-unmapped'});
 expect(events.find(e=>e.field==='raised')?.seek).toBeUndefined();expect(events.find(e=>e.field==='endOn')?.seek).toBeUndefined();expect(events.find(e=>e.field==='artRange')?.seek).toBeUndefined();
 expect(events.find(e=>e.field==='feet.jumps')?.frames).toEqual([2,4]);expect(events.find(e=>e.field==='landings')?.frames).toEqual([4,4]);expect(events.find(e=>e.field==='holds')?.frames).toEqual([5,7]);
 expect(events.find(e=>e.field==='short')?.targets).toEqual([{kind:'bone',name:'upper'}]);expect(JSON.stringify(source)).toBe(before);
});
test('uncovered keeps discrete timestamps and no invented frame interval or continuous span',()=>{
 const event=parseReport(allFields())!.categories.find(c=>c.field==='uncovered')!.events[0]!;
 expect(event.times).toEqual([0.1,0.3,4.8]);expect(event.frames).toBeUndefined();expect(event.timeInterval).toBeUndefined();expect(event.seek).toEqual({time:0.1,source:'event'});expect(event.targets).toEqual([{kind:'slot',name:'cloth'}]);
});
test('missing categories remain absent while present empty arrays remain explicitly empty',()=>{
 const p=parseReport({spec:'rig-pose-report/1',flips:[],turns:[],range:[],holds:[]})!;expect(p.categories).toEqual((['flips','turns','range','holds'] as const).map(field=>({field,state:'empty',events:[]})));
 expect(parseReport({spec:'rig-pose-report/1'})!.categories).toEqual([]);expect(parseReport({spec:'rig-pose-report/1',feet:null})!.categories).toEqual([]);expect(parseReport({ok:true})).toBeNull();
});
test('omitting each supported field independently never creates an empty category or marker',()=>{
 for(const field of reportFields){const source:Record<string,unknown>=structuredClone(allFields());const parts=field.split('.');let parent=source;for(const part of parts.slice(0,-1))parent=parent[part] as Record<string,unknown>;delete parent[parts.at(-1)!];expect(parseReport(source)!.categories.map(c=>c.field)).toEqual(reportFields.filter(f=>f!==field));}
});
test('frame count and duration and unrelated bends never imply a frame clock',()=>{
 const p=parseReport({spec:'rig-pose-report/1',frames:313,duration:13,bends:[{frame:12,t:0.5}],landings:[{bone:'hip',frame:12}],raised:[{frames:[1,2],seconds:0.5}]})!;
 for(const event of p.categories.flatMap(c=>c.events)){expect(event.seek).toBeUndefined();expect(event.timing).toBe('frames-unmapped');}
});
test('explicit event seconds, offset fps and irregular exact frameTimes enable seek without interpolation',()=>{
 expect(parseReport({spec:'rig-pose-report/1',landings:[{bone:'hip',frame:3,t:2.7}]})!.categories[0]!.events[0]!.seek).toEqual({time:2.7,source:'event'});
 expect(parseReport({spec:'rig-pose-report/1',fps:10,frame0:2,landings:[{bone:'hip',frame:3}]})!.categories[0]!.events[0]!.seek).toEqual({time:2.3,source:'fps'});
 const event=parseReport({spec:'rig-pose-report/1',frames:4,frameTimes:[1,1.2,2.7,9],raised:[{frames:[1,3],spanSeconds:8}]})!.categories[0]!.events[0]!;
 expect(event.seek).toEqual({time:1.2,source:'frameTimes'});expect(event.timeInterval).toEqual({start:1.2,end:9,endKind:'frame'});expect(event.durationSeconds).toBe(8);
 expect(parseReport({spec:'rig-pose-report/1',short:[{bone:'a',frames:[2,2],times:[1.2,1.2]}]})!.categories[0]!.events[0]!.seek?.time).toBe(1.2);
});
test('malformed provided report coordinates and contradictory clocks fail by field name',()=>{
 const cases:[Record<string,unknown>,string][]=[
  [{switches:{}},'switches'],[{cleaned:[]},'cleaned.holds'],[{landings:[{frame:-1}]},'landings[0].frame'],[{landings:[{frame:1.5}]},'landings[0].frame'],
  [{raised:[{frames:[3,2]}]},'raised[0].frames'],[{frames:2,landings:[{frame:2}]},'landings[0].frames'],[{raised:[{frames:[0,1],seconds:-1}]},'raised[0].seconds'],
  [{uncovered:[{times:[1,0]}]},'uncovered[0].times'],[{landings:[{bone:3,frame:1}]},'landings[0].bone'],[{landings:[{}]},'landings[0]'],
  [{frameTimes:[0,0]},'frameTimes'],[{frames:3,frameTimes:[0,1]},'frameTimes'],[{frameTimes:[0,1],landings:[{frame:2}]},'frameTimes'],
  [{fps:24},'frame0'],[{frame0:1},'fps'],[{fps:0,frame0:0},'fps'],
  [{fps:10,frame0:2,landings:[{frame:3,t:8}]},'landings[0].t'],
  [{frameTimes:[0,0.3],fps:10,frame0:0},'frameTimes'],
  [{frameTimes:[0,0.3],raised:[{frames:[0,1],times:[0,0.5]}]},'raised[0].times'],
  [{holds:[{frames:[0,2],from:0,to:3}]},'holds[0].from/to'],
  [{raised:[{frames:[0,1],seconds:1,spanSeconds:2}]},'raised[0].spanSeconds'],
 ];
 for(const [body,field] of cases)expect(()=>parseReport({spec:'rig-pose-report/1',...body})).toThrow('report.json.'+field);
});
test('matching duplicate hold and duration coordinates are retained',()=>{
 const event=parseReport({spec:'rig-pose-report/1',holds:[{frames:[1,3],from:1,to:3,seconds:0.5,spanSeconds:0.5}]})!.categories[0]!.events[0]!;expect(event.frames).toEqual([1,3]);expect(event.durationSeconds).toBe(0.5);
});
test('marker view model preserves missing coordinates, discrete time gaps and actual target choices',()=>{
 const report=parseReport(allFields())!;const event=(field:string)=>report.categories.find(c=>c.field===field)!.events[0]!;
 const joint=event('cleaned.holds');const selection=eventSelection(joint);expect(selection.frames).toEqual([0,2]);expect(selection.target).toBeNull();expect(selection.seek).toBeNull();expect(selection).not.toHaveProperty('category');expect(eventTimingLabel(joint)).toBe('시간 맵 없음 — seek 불가');expect(eventSeekTime(joint)).toBeNull();
 const uncovered=event('uncovered');expect(eventSelection(uncovered).frames).toBeNull();expect(eventSelection(uncovered).exactTimes).toEqual([0.1,0.3,4.8]);expect(eventSeekTime(uncovered,2)).toBe(4.8);expect(eventSeekTime(uncovered,3)).toBeNull();expect(eventCoordinates(uncovered)).toContain('3개');
 const multi={...event('switches'),targets:[{kind:'slot' as const,name:'first'},{kind:'slot' as const,name:'second'}]};expect(eventSelection(multi).target).toBeNull();expect(eventSelection(multi,1).target).toEqual({kind:'slot',name:'second'});expect(eventSelection(multi,9).target).toBeNull();
 const counts=reportCounts(parseReport({spec:'rig-pose-report/1',flips:[],landings:[{bone:'hip',frame:3}]})!);expect(counts.events).toBe(1);expect(counts.empty).toEqual(['flips']);expect(counts.missing).toContain('raised');expect(counts.missing).not.toContain('flips');
});
test('selecting a different marker clears stale feedback text without overwriting the same marker draft',()=>{
 const draft={category:'quality',summary:'Prior marker note'};expect(reportDraftForMarker('a','b',draft)).toEqual({category:'',summary:''});expect(reportDraftForMarker(null,'a',draft)).toEqual({category:'',summary:''});expect(reportDraftForMarker('a','a',draft)).toEqual(draft);expect(draft).toEqual({category:'quality',summary:'Prior marker note'});expect(reportDraftForMarker('a','a',draft)).not.toBe(draft);
});

const dirs:string[]=[];afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
test('folder report is source-bound read-only HTTP data; changed report invalidates the response',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-report-'));dirs.push(root);const file=join(root,'report.json');const bytes=JSON.stringify(allFields());await writeFile(file,bytes);const before=await readdir(root);const pkg=await loadReview(root);expect(pkg.report?.categories).toHaveLength(16);
 const server=await startServer(pkg,{port:0,stateDir:join(root,'state')});try{const base=`http://127.0.0.1:${server.port}`;const response=await fetch(base+'/api/review');expect(response.status).toBe(200);expect((await response.json()).report).toEqual(pkg.report);expect((await fetch(base+'/assets/report.json')).status).toBe(200);expect(await readFile(file,'utf8')).toBe(bytes);expect(await readdir(root)).toEqual(before);await writeFile(file,bytes+' ');expect((await fetch(base+'/api/review')).status).toBe(409);}finally{await server.stop(true);}
});
test('normalized report and source hash are derived from the same exact report byte stream',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-report-bytes-'));dirs.push(root);const file=join(root,'report.json');const bytes='\n'+JSON.stringify({spec:'rig-pose-report/1',landings:[{bone:'real',frame:7}]},null,2)+'\n';await writeFile(file,bytes);const pkg=await loadReview(root);const hash=createHash('sha256');hash.update(JSON.stringify(pkg.manifest));hash.update('\0');hash.update('report.json');hash.update('\0');hash.update(String(Buffer.byteLength(bytes)));hash.update('\0');hash.update(bytes);expect(pkg.sourceHash).toBe(hash.digest('hex'));expect(pkg.report).toEqual(parseReport(JSON.parse(bytes)));expect(pkg.report?.categories[0]?.events[0]?.frames).toEqual([7,7]);
 await writeFile(file,'{invalid JSON');await expect(loadReview(root)).rejects.toThrow('report.json:');
});
