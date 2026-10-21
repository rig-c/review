import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isWriterText,producerHint,reachOf,writerText} from '../src/baseline-reach.ts';
import {assertWholeRigBaseline,baselineLine,compareBaseline,type BaselineResult} from '../src/baseline.ts';
import {refusedText} from '../web/rebuild-client.ts';

/**
 * #148: a hand-repaired build (parts-examples family/roa's shape). The inspected `topwear` carries a repaired image and
 * re-weighted attachment no config states; `neck` is as the config builds it. The baseline (the config's rebuild) does
 * not reproduce it, and the line says what each op the producer runs will still take.
 */
const att=(weights:number[])=>({type:'mesh',uvs:[0,0,1,0,0,1],triangles:[0,1,2],vertices:weights,hull:3});
const rigDoc=(topwear:number[])=>({spec:'rigc-rig/1',images:'images',skeleton:{x:0,y:0,width:10,height:10},bones:[{name:'root'},{name:'chest',parent:'root'}],slots:[{name:'neck',bone:'chest'},{name:'topwear',bone:'chest'}],
 skins:{default:{neck:{neck:att([1,2,3])},topwear:{topwear:att(topwear)},face:{face:{x:0,y:0}}}},constraints:[{type:'physics',name:'c0',bone:'chest'}]});
const motionDoc={spec:'rigc-motion/1',groups:{},animations:{idle:{duration:4,tracks:[]}}};
const reportDoc=(reached:number)=>[{part:'neck',mode:'contour',vertices:3},{part:'topwear',mode:'contour',vertices:3,regions:[{name:'bust_r',reached}]}];
/** Two-space JSON: the shape a hand reformat leaves (the committed family/roa rig.json is not the writer's text either). */
const reformatted=(v:unknown)=>JSON.stringify(v,null,2)+'\n';

async function rigDir(root:string,name:string,docs:{rig:string;motion:string;report:string},topwearPng:string):Promise<string>{
 const dir=join(root,name);await mkdir(join(dir,'images'),{recursive:true});
 await writeFile(join(dir,'rig.json'),docs.rig);await writeFile(join(dir,'motion.json'),docs.motion);await writeFile(join(dir,'mesh_report.json'),docs.report);
 await writeFile(join(dir,'images','topwear.png'),topwearPng);await writeFile(join(dir,'images','neck.png'),'png-neck');await writeFile(join(dir,'images','face.png'),'png-face');
 return dir;
}
const show=(rel:string)=>`out/rig/${rel}`;
const settled=(compared:Awaited<ReturnType<typeof compareBaseline>>):BaselineResult=>({schema:'rig-review-baseline/1',key:'k',producer:{package:'@rig-c/parts',version:'1.49.1'},line:'',exitCode:0,wallMs:1,...compared});

test('#148: the writer\'s text is JSON.stringify(value, null, 1) and a closing newline; anything else is not',()=>{
 expect(writerText({a:[1,{b:2}]})).toBe('{\n "a": [\n  1,\n  {\n   "b": 2\n  }\n ]\n}\n');
 expect(isWriterText(writerText(rigDoc([1])))).toBe(true);
 expect(isWriterText(reformatted(rigDoc([1])))).toBe(false);
 expect(isWriterText(JSON.stringify(rigDoc([1])))).toBe(false);
 expect(isWriterText(writerText(rigDoc([1])).trimEnd())).toBe(false);
 expect(isWriterText('not json')).toBe(false);
});

test('#148: a repaired build in the writer\'s format — the baseline line and EDIT_BASELINE_MISMATCH name the cause and what still Applies',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-reach-')));
 try{
  const baseline=await rigDir(root,'baseline',{rig:writerText(rigDoc([1,2,3])),motion:writerText(motionDoc),report:writerText(reportDoc(187))},'png-topwear-config');
  const inspected=await rigDir(root,'inspected',{rig:writerText(rigDoc([1,2,4])),motion:writerText(motionDoc),report:writerText(reportDoc(143))},'png-topwear-repaired');
  const compared=await compareBaseline(baseline,inspected,show,'1.49.1');
  expect(compared).toMatchObject({status:'not-reproduced',firstDifference:'out/rig/images/topwear.png'});
  expect(compared.reach).toMatchObject({notWriterText:[],images:['out/rig/images/topwear.png'],retuneHeld:'out/rig/images/topwear.png',remeshRefused:['topwear'],meshParts:['neck','topwear'],bonesDiffer:false});
  const reach='whole-rig edits refuse (EDIT_BASELINE_MISMATCH); physics and idle edits (retune) refuse: the config draws out/rig/images/topwear.png differently and retune holds every image (RETUNE_REQUEST_HELD); remesh: topwear is refused (REMESH_BASELINE_MISMATCH: the config does not reproduce its attachment, image or report row); neck can be re-fit; a mesh edit (Edit Mesh) is held to the inspected mesh itself, not to the config, so the baseline does not refuse it';
  expect(baselineLine(settled(compared))).toBe(`baseline: not reproduced — out/rig/images/topwear.png · ${reach}`);
  expect(()=>assertWholeRigBaseline(settled(compared))).toThrow(`EDIT_BASELINE_MISMATCH: out/rig/images/topwear.png — ${reach}`);
  // A mesh-only repair (the image as the config draws it): retune holds it, so physics and idle edits still Apply.
  const meshOnly=await rigDir(root,'mesh-only',{rig:writerText(rigDoc([1,2,4])),motion:writerText(motionDoc),report:writerText(reportDoc(187))},'png-topwear-config');
  const m=await compareBaseline(baseline,meshOnly,show,'1.49.1');
  expect(m.firstDifference).toBe('out/rig/rig.json');
  expect(m.reach!.text).toBe('whole-rig edits refuse (EDIT_BASELINE_MISMATCH); physics and idle edits Apply through retune, which carries every inspected mesh over; remesh: topwear is refused (REMESH_BASELINE_MISMATCH: the config does not reproduce its attachment, image or report row); neck can be re-fit; a mesh edit (Edit Mesh) is held to the inspected mesh itself, not to the config, so the baseline does not refuse it');
  // Below retune's floor (1.44.0) a physics edit is a whole-rig edit.
  expect((await compareBaseline(baseline,meshOnly,show,'1.43.0')).reach!.text).toContain('physics and idle edits rebuild the whole rig on 1.43.0 (retune is 1.44.0+), so they refuse too');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#148: a repaired build whose rig.json and mesh_report.json were reformatted — the line names the format first, then what follows once re-serialised',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-reach-')));
 try{
  const baseline=await rigDir(root,'baseline',{rig:writerText(rigDoc([1,2,3])),motion:writerText(motionDoc),report:writerText(reportDoc(187))},'png-topwear-config');
  const inspected=await rigDir(root,'inspected',{rig:reformatted(rigDoc([1,2,4])),motion:writerText(motionDoc),report:reformatted(reportDoc(143))},'png-topwear-repaired');
  const compared=await compareBaseline(baseline,inspected,show,'1.49.1');
  expect(compared.reach!.notWriterText).toEqual(['out/rig/rig.json','out/rig/mesh_report.json']);
  const reach='out/rig/rig.json, out/rig/mesh_report.json are not the text rig writes for their values (reformatted, or written by another tool), and an op that splices a revision as text refuses such a file — use the files as rig wrote them, or re-serialise them in a copy of the package exactly as rig writes them (JSON with one space of indent and a closing newline) and open the copy; whole-rig edits refuse (EDIT_BASELINE_MISMATCH); physics and idle edits (retune) refuse out/rig/rig.json (RETUNE_INPUT_WRITTEN), and past that the config draws out/rig/images/topwear.png differently and retune holds every image (RETUNE_REQUEST_HELD); remesh and a mesh edit refuse out/rig/rig.json, out/rig/mesh_report.json (REMESH_INPUT_WRITTEN); past that, remesh: topwear is refused (REMESH_BASELINE_MISMATCH: the config does not reproduce its attachment, image or report row); neck can be re-fit';
  expect(baselineLine(settled(compared))).toBe(`baseline: not reproduced — out/rig/images/topwear.png · ${reach}`);
  expect(()=>assertWholeRigBaseline(settled(compared))).toThrow(`EDIT_BASELINE_MISMATCH: out/rig/images/topwear.png — ${reach}`);
 }finally{await rm(root,{recursive:true,force:true});}
});

/** The producer's lines as @rig-c/parts 1.49.1 printed them on family/roa (#148 live run; the input path shortened). */
const REMESH_WRITTEN='FAIL  REMESH_INPUT_WRITTEN: /bench/output/out/rig/rig.json — is not the text this package\'s writer prints for its value; the revision is spliced as text, so an input reformatted by hand cannot be carried over byte for byte (see rig-parts guide REMESH_INPUT_WRITTEN)';
const RETUNE_WRITTEN='FAIL  RETUNE_INPUT_WRITTEN: /bench/output/out/rig/rig.json — is not the text this package\'s writer prints for its value; the revision is spliced as text, so an input reformatted by hand cannot be carried over byte for byte (see rig-parts guide RETUNE_INPUT_WRITTEN)';
const RETUNE_IMAGE='FAIL  RETUNE_REQUEST_HELD: images/topwear.png — the config changes it (input 282067 bytes 4ce0f6b42d75… vs rebuilt 375373 bytes b4e1cf243adf…); a retune replaces constraints and the idle and holds every other byte of the input, so nothing is written — make it a rebuild with rig --config (see rig-parts guide RETUNE_REQUEST_HELD)';

test('#148: review\'s line beside INPUT_WRITTEN and an image RETUNE_REQUEST_HELD; the producer\'s line is shown first, as printed',()=>{
 const advice='use the files as rig wrote them, or re-serialise them in a copy of the package exactly as rig writes them (JSON with one space of indent and a closing newline) and open the copy';
 expect(producerHint(REMESH_WRITTEN)).toBe(`rig.json in the inspected rig is not the text rig writes for its value (reformatted, or written by another tool); remesh splices a revision as text, so it refuses the file — ${advice}`);
 expect(producerHint(RETUNE_WRITTEN)).toBe(`rig.json in the inspected rig is not the text rig writes for its value (reformatted, or written by another tool); retune splices a revision as text, so it refuses the file — ${advice}`);
 expect(producerHint(RETUNE_IMAGE)).toBe('the inspected images/topwear.png is not the image the config draws (a repaired or redrawn image); retune holds every image, so no physics or idle edit Applies on this build — the baseline line says what still does');
 // Anything else keeps the producer's line alone.
 expect(producerHint('FAIL  RETUNE_REQUEST_HELD: rig.json bones — the config changes it (input vs rebuilt: bones[3].x)')).toBeNull();
 expect(producerHint('FAIL  REMESH_BASELINE_MISMATCH: images/topwear.png — the config as written does not reproduce the input here')).toBeNull();
 expect(producerHint(null)).toBeNull();
 // The status line: the producer's line verbatim, then review's.
 expect(refusedText({producerLine:RETUNE_WRITTEN,exitCode:1,hint:producerHint(RETUNE_WRITTEN)!})).toBe(`${RETUNE_WRITTEN} · review: ${producerHint(RETUNE_WRITTEN)}`);
 expect(refusedText({producerLine:REMESH_WRITTEN,exitCode:1})).toBe(REMESH_WRITTEN);
 expect(refusedText({producerLine:null,exitCode:2})).toBe('REBUILD_FAILED: exit 2');
});

test('#185: remesh reach reads a part\'s image off its mesh attachment, not images/<part>.png',()=>{
 const named=(image:string)=>({...att([1,2,3]),image});
 const rig={...rigDoc([1,2,3]),skins:{default:{neck:{neck:att([1,2,3])},topwear:{topwear:named('shirt.png')}}}};
 const docs={rig,motion:motionDoc,report:reportDoc(1),texts:{'rig.json':writerText(rig),'motion.json':writerText(motionDoc),'mesh_report.json':writerText(reportDoc(1))}};
 const tree=(shirt:string,topwear:string)=>({'rig.json':'r','images/neck.png':'n','images/shirt.png':shirt,'images/topwear.png':topwear});
 // The attachment draws images/shirt.png, and that image differs: topwear is held, so it cannot be re-fit.
 const held=reachOf(docs,docs,tree('a','t'),tree('b','t'),show);
 expect(held.images).toEqual(['out/rig/images/shirt.png']);
 expect(held.remeshRefused).toEqual(['topwear']);
 expect(held.text).toContain('topwear is refused (REMESH_BASELINE_MISMATCH');
 // An unrelated images/topwear.png differing does not hold the part whose attachment draws shirt.png.
 expect(reachOf(docs,docs,tree('a','t'),tree('a','u'),show).remeshRefused).toEqual([]);
});
