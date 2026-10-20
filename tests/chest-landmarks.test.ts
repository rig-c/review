import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {BUST_DEFAULTS,bustMeshEntry,deriveBust,parseBustSpec,partToRig,PART_PAD,rigToPart,type BustSpec} from '../src/chest-landmarks.ts';
import {bustEntryText,parseRebuildRequest} from '../src/rebuild.ts';
import {canvasToCrop,editorStatus,hitLandmark,landmarkInputId,landmarkReadout,nextLandmark,readLandmarks} from '../web/chest-editor.ts';
import {landmarksRequest,pickBustPart,seedLandmarks} from '../web/rebuild-client.ts';
import {parseAppliedContext,appliedSummary} from '../src/applied-context.ts';
import type {ChestFieldValue} from '../web/chest-regions-tool.ts';

/**
 * The producer's own numbers: `deriveBustRegions` and the contour loader of the installed @rig-c/parts 1.42.0, run on a
 * config whose contour states each `bust` (the derived circles, and the CONFIG_BUST_CLEARANCE detail after its path).
 */
const producer:{bust:BustSpec;derived:[number,number,number,number,number,number,number,number];refusal:string|null}[]=[
 {bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],bone_r:'chest_jiggle',bone_l:'chest_jiggle'},derived:[384,345,6,22,446,345,6,22],refusal:null},
 {bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],bone_r:'chest_jiggle',bone_l:'chest_jiggle',clearance:0.5},derived:[384,345,7,24,446,345,7,24],refusal:'is 0.5 (giving R_r = 31, R_l = 31, R_r + R_l = 62 px against apex distance D = 62 px, r_r = 7, band_r = 24, r_l = 7, band_l = 24); a clearance > 0 with R_r + R_l < D (clearance > 0.4 px) and positive radii is required'},
 {bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],clearance:0},derived:[384,345,7,24,446,345,7,24],refusal:'is 0 (giving R_r = 31, R_l = 31, R_r + R_l = 62 px against apex distance D = 62 px, r_r = 7, band_r = 24, r_l = 7, band_l = 24); a clearance > 0 with R_r + R_l < D (clearance > 0.4 px) and positive radii is required'},
 {bust:{apex_r:[296,650],apex_l:[438,650],cleavage:[366,662],alpha:0.4,clearance:6},derived:[296,650,26,39,438,650,27,40],refusal:null},
 {bust:{apex_r:[300.5,700.25],apex_l:[452,698],cleavage:[377,720.5],alpha:0.3,clearance:2.5},derived:[300.5,700.25,23,54,452,698,23,53],refusal:'is 2.5 (giving R_r = 77, R_l = 76, R_r + R_l = 153 px against apex distance D = 151.52 px, r_r = 23, band_r = 54, r_l = 23, band_l = 53); a clearance > 0 with R_r + R_l < D (clearance > 2.96 px) and positive radii is required'},
 {bust:{apex_r:[380,340],apex_l:[450,344],cleavage:[414,352],alpha:0.35,clearance:5.4},derived:[380,340,11,20,450,344,11,20],refusal:null},
 // R is rounded before alpha: d − clearance = 29.6 gives R 30 and r = round(0.25 × 30) = 8 (not round(0.25 × 29.6) = 7).
 {bust:{apex_r:[300,500],apex_l:[366,500],cleavage:[333,500],alpha:0.25,clearance:3.4,bone_r:'chest_jiggle',bone_l:'chest_jiggle'},derived:[300,500,8,22,366,500,8,22],refusal:null},
];

test('the drawn circles are the producer\'s derived regions: R = round(d − clearance), r = round(alpha·R), band = R − r',()=>{
 for(const {bust,derived,refusal} of producer){
  const d=deriveBust(bust),[r,l]=d.regions;
  expect({bust,circles:[r.cx,r.cy,r.r,r.band,l.cx,l.cy,l.r,l.band]}).toEqual({bust,circles:derived});
  expect([r.name,l.name]).toEqual(['bust_r','bust_l']);
  expect([r.bone,l.bone]).toEqual([bust.bone_r??'boob_r',bust.bone_l??'boob_l']);
  expect(r.spacing).toBe(14);
  // Review's pre-check refuses exactly when the producer does, with the producer's detail after the path.
  expect(d.refusal===null?null:d.refusal.replace(/^CONFIG_BUST_CLEARANCE: contour\.bust\.clearance — /,'')).toBe(refusal);
 }
 expect(BUST_DEFAULTS).toEqual({alpha:0.22,clearance:3.8,spacing:14,bone_r:'boob_r',bone_l:'boob_l'});
});

test('a clearance that makes the circles overlap names CONFIG_BUST_CLEARANCE before Apply, and Apply sends nothing',()=>{
 const status={parts:[{name:'topwear',regions:[{name:'bust',bone:'chest_jiggle'}]},{name:'skirt',regions:[]}],contour:{topwear:{contour:{}},skirt:{contour:{}}},inputs:{config:'c',parts:null,rig:null,configHash:'f'.repeat(64)}};
 const values:Record<string,ChestFieldValue>={};const read=(id:string)=>values[id];
 const set=(spec:Record<string,string>)=>{for(const [k,v] of Object.entries(spec))values[k]={value:v};};
 expect(readLandmarks(read)).toEqual({missing:['apex_r','apex_l','cleavage']});
 expect(landmarksRequest(status,readLandmarks(read))).toEqual({error:'LANDMARKS_INCOMPLETE: place apex_r, apex_l, cleavage'});
 set({[landmarkInputId('apex_r','x')]:'384',[landmarkInputId('apex_r','y')]:'345',[landmarkInputId('apex_l','x')]:'446',[landmarkInputId('apex_l','y')]:'345',[landmarkInputId('cleavage','x')]:'415',[landmarkInputId('cleavage','y')]:'350','lm-alpha':'0.22','lm-clearance':'3.8','lm-bone_r':'chest_jiggle','lm-bone_l':'chest_jiggle'});
 const ok=landmarksRequest(status,readLandmarks(read));
 expect(ok).toEqual({part:'topwear',body:{part:'topwear',bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],alpha:0.22,clearance:3.8,bone_r:'chest_jiggle',bone_l:'chest_jiggle'},configHash:'f'.repeat(64)}});
 expect(landmarkReadout(readLandmarks(read)).text).toStartWith('bust_r (384,345) r 6 band 22 → chest_jiggle · bust_l (446,345) r 6 band 22 → chest_jiggle · D 62.00 px');
 set({'lm-clearance':'0.5'});
 const refused=landmarksRequest(status,readLandmarks(read));
 expect('error' in refused&&refused.error).toStartWith('CONFIG_BUST_CLEARANCE: contour.bust.clearance — is 0.5 (giving R_r = 31, R_l = 31, R_r + R_l = 62 px');
 expect(landmarkReadout(readLandmarks(read))).toMatchObject({error:true});
 set({'lm-clearance':'0.9'});expect('error' in landmarksRequest(status,readLandmarks(read))).toBe(true);
 set({'lm-clearance':'1'});expect('body' in landmarksRequest(status,readLandmarks(read))).toBe(true);
 // Empty bone fields are the producer's defaults and are not sent; a part with contour.bust is picked first.
 set({'lm-bone_r':'','lm-bone_l':''});const plain=readLandmarks(read);expect('spec' in plain&&plain.spec).toEqual({apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],alpha:0.22,clearance:1});
 expect(pickBustPart({...status,contour:{topwear:{contour:{}},skirt:{contour:{bust:{}}}}},[])).toBe('skirt');
 expect(landmarksRequest(status,plain)).toEqual({error:'REBUILD_PART_AMBIGUOUS: the config states 2 contour meshes and the landmark bones name none of them alone'});
 set({[landmarkInputId('cleavage','x')]:'415.1'});expect(readLandmarks(read)).toEqual({error:'LANDMARK_VALUE_INVALID: cleavage is off the 1/256 px grid'});
});

test('part image px → rig px is the part box less the producer\'s pad; one known point pinned',()=>{
 // The inspected topwear: parts.json box x 329, y 229. The chest-jiggle bone the config places at rig (414, 342)
 // sits at part image (89, 117).
 const box={x:329,y:229};
 expect(PART_PAD).toBe(4);
 expect(partToRig([89,117],box)).toEqual([414,342]);
 expect(rigToPart([414,342],box)).toEqual([89,117]);
 expect(rigToPart(partToRig([12.5,3.25],box),box)).toEqual([12.5,3.25]);
});

test('canvas px → crop px inverts the camera and the crop mapping; markers hit within 10 px; the next click',()=>{
 // Camera: 2 canvas px per world px, world y up; crop → world as the model stage maps it (832×1216, root at origin).
 const project=(x:number,y:number)=>({x:300+x*2,y:900-y*2}),toWorld=(x:number,y:number)=>({x:x-416,y:1216-y});
 const at=(cx:number,cy:number)=>{const w=toWorld(cx,cy);return project(w.x,w.y);};
 expect(canvasToCrop(project,toWorld,at(414,342))).toEqual([414,342]);
 expect(canvasToCrop(project,toWorld,at(384.5,345))).toEqual([384.5,345]);
 expect(canvasToCrop(()=>({x:0,y:0}),toWorld,{x:1,y:1})).toBeNull();
 const markers=[{key:'apex_r' as const,at:{x:100,y:100}},{key:'apex_l' as const,at:{x:108,y:100}}];
 expect(hitLandmark(markers,{x:106,y:100})).toBe('apex_l');expect(hitLandmark(markers,{x:101,y:100})).toBe('apex_r');expect(hitLandmark(markers,{x:130,y:100})).toBeNull();
 expect(nextLandmark(null,['apex_l','cleavage'])).toBe('apex_l');expect(nextLandmark('apex_r',[])).toBe('apex_r');expect(nextLandmark(null,[])).toBeNull();
});

test('the remesh entry: contour.bust replaces contour.regions, every other field as written; the request is typed, not judged',()=>{
 const config={meshes:{topwear:{contour:{tolerance:2,margin:2,spacing:28,regions:[{name:'bust',shape:'circle',cx:414,cy:342,r:50,bone:'chest_jiggle',spacing:13,band:30}]},r:15,segments:[['chest',[416,230],[416,600]]]}}};
 const bust:BustSpec={apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],alpha:0.22,clearance:3.8,bone_r:'chest_jiggle',bone_l:'chest_jiggle'};
 const entry=JSON.parse(bustEntryText(JSON.stringify(config),'topwear',bust));
 expect(entry).toEqual({contour:{tolerance:2,margin:2,spacing:28,bust},r:15,segments:[['chest',[416,230],[416,600]]]});
 expect(Object.keys(entry.contour.bust)).toEqual(['apex_r','apex_l','cleavage','alpha','clearance','bone_r','bone_l']);
 expect(bustMeshEntry(config.meshes.topwear,bust)).not.toBe(config.meshes.topwear);expect(config.meshes.topwear.contour.regions.length).toBe(1);
 const hash='f'.repeat(64),request=parseRebuildRequest({part:'topwear',bust,configHash:hash},['root']);
 expect(request.bust).toEqual(bust);
 expect(request.regions.map(r=>[r.name,(r as {r:number}).r,r.band])).toEqual([['bust_r',6,22],['bust_l',6,22]]);
 // The producer judges clearance and bone names: an overlapping clearance and an undeclared bone are sent as typed.
 expect(parseRebuildRequest({part:'topwear',bust:{...bust,clearance:0.5,bone_r:'nope'},configHash:hash},['root']).bust?.clearance).toBe(0.5);
 const refuse=(value:unknown)=>{try{parseRebuildRequest(value,null);return null;}catch(e){return (e as Error).message;}};
 expect(refuse({part:'topwear',bust,regions:[],configHash:hash})).toStartWith('REBUILD_REQUEST_INVALID: expected exactly');
 expect(refuse({part:'topwear',bust:{...bust,apex_r:[384.001,345]},configHash:hash})).toBe('REBUILD_REQUEST_INVALID: bust.apex_r is off the 1/256 px grid');
 expect(refuse({part:'topwear',bust:{...bust,path:'/etc'},configHash:hash})).toBe('REBUILD_REQUEST_INVALID: bust.path is not a contour.bust field');
 expect(refuse({part:'topwear',bust:{...bust,alpha:0},configHash:hash})).toBe('REBUILD_REQUEST_INVALID: bust.alpha must be a finite number > 0');
 expect(()=>parseBustSpec({apex_r:[1,2],apex_l:[3,4]})).toThrow('bust.cleavage must be [x, y]');
});

test('the applied record carries the landmarks beside the derived circles; a config bust seeds an untouched Landmarks mode',()=>{
 const bust={apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],alpha:0.22,clearance:3.8};
 const record={schema:'rig-review-applied/1',buildId:'d'.repeat(64),part:'topwear',regions:deriveBust(bust as BustSpec).regions,bust,configHash:'f'.repeat(64),entrySha256:'0'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:null,modelHash:'e'.repeat(64)};
 expect(()=>parseAppliedContext(record)).not.toThrow();
 expect(appliedSummary(record)).toBe(`contour.bust landmarks on topwear with @rig-c/parts 1.42.0 · model ${'e'.repeat(12)}…`);
 expect(()=>parseAppliedContext({...record,bust:{...bust,cleavage:'x'}})).toThrow('feedback.context.applied.bust.cleavage');
 const values:Record<string,ChestFieldValue>={};const read=(id:string)=>values[id];
 const status={parts:[{name:'topwear',regions:[]}],contour:{topwear:{contour:{bust:{apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],clearance:5,bone_r:'chest_jiggle'}}}}};
 expect(seedLandmarks(status,read)).toEqual({'lm-apex_r-x':'384','lm-apex_r-y':'345','lm-apex_l-x':'446','lm-apex_l-y':'345','lm-cleavage-x':'415','lm-cleavage-y':'350','lm-clearance':'5','lm-bone_r':'chest_jiggle'});
 values['lm-apex_r-x']={value:'1'};expect(seedLandmarks(status,read)).toBeNull();
});

test('the Landmarks mode sits beside Circles in the editor bar: three picks, two sliders at the producer\'s defaults, optional bones',async()=>{
 const page=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 const a=page.indexOf('<div id="chest-editor-bar"'),bar=page.slice(a,page.indexOf('id="stage-layout"',a));
 expect(bar).toContain('<input id="bust-mode" type="hidden" value="circles">');
 for(const mode of ['circles','landmarks'])expect(bar).toContain(`data-bust-mode="${mode}"`);
 for(const key of ['apex_r','apex_l','cleavage'] as const)for(const id of [`lm-pick-${key}`,landmarkInputId(key,'x'),landmarkInputId(key,'y')])expect(bar).toContain(`id="${id}"`);
 expect(bar).toContain('id="lm-alpha" type="range" min="0.05" max="0.95" step="0.01" value="0.22"');
 expect(bar).toContain('id="lm-clearance" type="range" min="0" max="40" step="0.1" value="3.8"');
 expect(bar).toMatch(/id="lm-bone_r"[^>]*placeholder="boob_r"/);expect(bar).toMatch(/id="lm-bone_l"[^>]*placeholder="boob_l"/);
 expect(bar).toMatch(/<div id="bust-landmarks" class="bust-group" data-chest-mode="landmarks"[^>]* hidden>/);
 const mapped={available:true,crop:{w:10,h:10},toWorld:(x:number,y:number)=>({x,y}),basis:'b'} as const;
 expect(editorStatus(null,mapped,'landmarks')).toEqual({text:'Click the part to place the armed landmark · drag a marker to move it · Space-drag pans',error:false});
 expect(editorStatus(null,mapped).text).toStartWith('Drag a centre to move');
 const source=await readFile(new URL('../web/chest-editor.ts',import.meta.url),'utf8');
 for(const word of ['fetch(','child_process','Bun.spawn','XMLHttpRequest','/api/'])expect(source).not.toContain(word);
});
