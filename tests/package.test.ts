import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { cp, mkdtemp, writeFile, readFile, rm, symlink, mkdir, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAMES_DURATION_TOLERANCE, loadReview, packagePath, parseManifest } from '../src/manifest.ts';
import { feedbackLastFrame } from '../src/feedback-validation.ts';
import { freshSession, readSession, saveSession, sessionFile } from '../src/session.ts';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'review-test-'));dirs.push(root);const input={schema:'rig-review/1',id:'test-rig',title:'Test rig',revision:'one',references:[{id:'art',label:'Source',type:'image',path:'source.svg'}],checkpoints:[{id:'shape',title:'Shape',reference:'art'}]};await writeFile(join(root,'review.json'),JSON.stringify(input));await writeFile(join(root,'source.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');return {root,input,path:join(root,'review.json')};}
test('path refusal covers literal and encoded traversal and URL schemes',()=>{
 for(const p of ['../secret','a/../secret','/tmp/secret','C:/secret','a\\secret','%2e%2e/secret','%252e%252e/secret','https:secret','a//b','a?x','a#x','./a'])expect(()=>packagePath(p)).toThrow();
 expect(packagePath('art/a drawing.svg')).toBe('art/a drawing.svg');
});
test('manifest names missing checkpoint reference rather than accepting an orphan',()=>{expect(()=>parseManifest({schema:'rig-review/1',id:'x',title:'X',revision:'1',checkpoints:[{id:'bad',title:'Bad',reference:'missing'}]})).toThrow('declared reference id');});
test('symlink escaping package is refused',async()=>{const f=await fixture();const outside=await mkdtemp(join(tmpdir(),'review-outside-'));dirs.push(outside);await writeFile(join(outside,'art.svg'),'outside');await rm(join(f.root,'source.svg'));await symlink(join(outside,'art.svg'),join(f.root,'source.svg'));await expect(loadReview(f.path)).rejects.toThrow('symlinks may not escape');});
test('declared missing files are refused',async()=>{const f=await fixture();await rm(join(f.root,'source.svg'));await expect(loadReview(f.path)).rejects.toThrow();});

test('#1316 omission preserves the base package hash and file set', async () => {
 const p = await loadReview('tests/fixtures/viewport-387/package/review.json', {handoff: false});
 expect(p.sourceHash).toBe('7e095240763ae30a8a592f2e5ae180b9a0900b1beed89777df89cdb07077f4e4');
 expect([...p.files].sort()).toEqual(['mesh.png', 'report.json', 'review.json', 'rigid.png', 'skeleton.model.json']);
 expect(Object.hasOwn(p.manifest, 'sceneReport')).toBe(false);
});

test('#1316 sceneReport pointer requires a model and a closed literal path/digest pair', async () => {
 const f = await fixture();
 const sceneReport = {path: 'scene.json', sha256: 'a'.repeat(64)};
 expect(() => parseManifest({...f.input, sceneReport})).toThrow('SCENE_CAMERA_MODEL_MISMATCH');
 for (const bad of [null, [], {path: 'scene.json'}, {...sceneReport, spec: '/1'},
   {...sceneReport, path: '../scene.json'}, {...sceneReport, path: 'a/%2e%2e/scene.json'},
   {...sceneReport, sha256: 'A'.repeat(64)}]) {
   expect(() => parseManifest({...f.input, model: 'skeleton.model.json', sceneReport: bad})).toThrow('SCENE_SOURCE_MISMATCH');
 }
});

test.each([
 ['missing', null, '{}', 'SCENE_REQUIRED'],
 ['escaping', null, '{}', 'SCENE_SOURCE_MISMATCH'],
 ['wrong digest before invalid JSON', 'malformed', '{}', 'SCENE_SOURCE_MISMATCH'],
 ['malformed JSON', 'malformed', 'malformed', 'SCENE_CAMERA_REPORT_INVALID'],
 ['unknown spec', '{"spec":"spine-parts-scene-report/3"}', '{"spec":"spine-parts-scene-report/3"}', 'SCENE_CAMERA_REPORT_INVALID'],
 ['keyed /2', '{"spec":"spine-parts-scene-report/2","camera":{}}', '{"spec":"spine-parts-scene-report/2","camera":{}}', 'SCENE_CAMERA_UNAVAILABLE'],
] as const)('#1316 refuses sceneReport with %s', async (kind, bytes, declaredBytes, code) => {
 const f = await fixture();
 const model = 'skeleton.model.json';
 const path = 'scene.json';
 const scene = join(f.root, path);
 await writeFile(join(f.root, model), '{"spec":"rigc-compiled/3","pages":[]}');
 const sha256 = createHash('sha256').update(declaredBytes).digest('hex');
 await writeFile(f.path, JSON.stringify({...f.input, model, sceneReport: {path, sha256}}));
 if (bytes !== null) await writeFile(scene, bytes);
 if (kind === 'escaping') {
   const outside = await fixture();
   await symlink(join(outside.root, 'source.svg'), scene);
 }
 await expect(loadReview(f.path)).rejects.toThrow(code);
});

test('#1316 a declared /1 changes source identity without changing inspection metadata', async () => {
 const f = await fixture();
 const model = 'skeleton.model.json';
 const posePath = 'pose/report.json';
 const manifest = {...f.input, model, authoring: [{label: 'Pose report', path: posePath}]};
 await mkdir(join(f.root, 'pose'));
 await writeFile(join(f.root, posePath), '{"spec":"rig-pose-report/1","animation":"idle"}');
 await writeFile(join(f.root, model), '{"spec":"rigc-compiled/3","pages":[]}');
 await writeFile(f.path, JSON.stringify(manifest));
 const base = await loadReview(f.path);
 expect(base.report?.path).toBe(posePath);
 const path = 'report.json';
 let previousHash = base.sourceHash;
 for (const bytes of ['{"spec":"spine-parts-scene-report/1"}', '{"spec":"spine-parts-scene-report/1"}\n']) {
   const sceneReport = {path, sha256: createHash('sha256').update(bytes).digest('hex')};
   await writeFile(join(f.root, path), bytes);
   await writeFile(f.path, JSON.stringify({...manifest, sceneReport}));
   const p = await loadReview(f.path);
   expect(p.manifest.sceneReport).toEqual(sceneReport);
   expect([...p.files].sort()).toEqual([...base.files, path].sort());
   expect(p.sourceHash).not.toBe(previousHash);
   previousHash = p.sourceHash;
   expect(p.reviewedSource).toEqual(base.reviewedSource);
   expect(p.feedbackCatalog).toEqual(base.feedbackCatalog);
   expect(p.report).toEqual(base.report);
   expect(p.scene).toBeUndefined();
 }
});
test('opening starts pending; explicit state persists separately from source',async()=>{const f=await fixture();const p=await loadReview(f.path);const state=join(f.root,'user-state');const before=await Bun.file(f.path).text();expect((await readSession(p,state)).status).toBe('pending');const session=freshSession(p);session.status='approved';session.checkpoints.shape={outcome:'pass',note:'Contour accepted'};const saved=await saveSession(p,session,state);expect(saved.updatedAt).toBeString();expect((await readSession(p,state)).status).toBe('approved');expect(await Bun.file(f.path).text()).toBe(before);});
test('asset changes invalidate approval even without revision bump',async()=>{const f=await fixture();const original=await loadReview(f.path);const state=join(f.root,'state');const session=freshSession(original);session.status='approved';await saveSession(original,session,state);await writeFile(join(f.root,'source.svg'),'<svg><!-- changed --></svg>');const changed=await loadReview(f.path);expect(changed.sourceHash).not.toBe(original.sourceHash);expect(sessionFile(changed,state)).not.toBe(sessionFile(original,state));expect((await readSession(changed,state)).status).toBe('pending');await expect(saveSession(changed,session,state)).rejects.toThrow('sourceHash');});
test('session rejects foreign binding, unknown checkpoint and invalid feedback target',async()=>{const f=await fixture();const p=await loadReview(f.path);const state=join(f.root,'state');await expect(saveSession(p,{...freshSession(p),id:'other'},state)).rejects.toThrow('session.id');await expect(saveSession(p,{...freshSession(p),checkpoints:{unknown:{outcome:'pass',note:''}}},state)).rejects.toThrow('unknown checkpoint');await expect(saveSession(p,{...freshSession(p),feedback:[{id:'x',frameStart:0,frameEnd:1,target:{kind:'command',name:'x'},category:'defect',summary:'x'}]},state)).rejects.toThrow('feedback.target.kind');});
test('canonical pose sequence preserves observed, missing and off-image coordinates',async()=>{const f=await fixture();f.input.references=[{id:'pose',label:'Pose sequence',type:'pose',path:'pose.json'}];f.input.checkpoints=[];await writeFile(f.path,JSON.stringify(f.input));const pose={spec:'rig-pose-sequence/1',space:{units:'picture-px',origin:'top-left',y:'down'},width:1080,height:1920,source:'producer',frames:[{t:2,people:[{id:'a',joints:{neck:{state:'observed',at:[-10,410],score:2.1},r_wrist:{state:'missing'}}}]},{t:2.5,people:[]}],camera:[{s:2,tx:10,ty:20,inliers:8},{s:2,tx:10,ty:20,inliers:8}]};await writeFile(join(f.root,'pose.json'),JSON.stringify(pose));expect((await loadReview(f.path)).manifest.references[0].type).toBe('pose');pose.frames[1].t=2;await writeFile(join(f.root,'pose.json'),JSON.stringify(pose));await expect(loadReview(f.path)).rejects.toThrow('strictly increasing');});
test('model pages may resolve upwards from build directory but never escape package',async()=>{const f=await fixture();await Bun.write(join(f.root,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'../source.svg'}]}));await writeFile(f.path,JSON.stringify({...f.input,model:'build/skeleton.model.json'}));expect((await loadReview(f.path)).files.has('source.svg')).toBe(true);await Bun.write(join(f.root,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'../../outside.svg'}]}));await expect(loadReview(f.path)).rejects.toThrow('inside package');});

test('folder adapter opens existing outputs without writing source and raw Spine playback stays absent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-bundle-'));dirs.push(root);const files={'skeleton.json':'{"skeleton":{"spine":"4.3"}}','motion.json':'{"source":"unchanged motion"}','report.json':'{"ok":true}','source.mp4':'source video bytes','contact-strip.png':'strip bytes'};
 for(const [path,content] of Object.entries(files))await writeFile(join(root,path),content);
 const p=await loadReview(root);expect(p.manifest.model).toBeUndefined();expect(p.manifest.references.map(r=>r.path)).toEqual(['contact-strip.png','source.mp4']);expect(p.manifest.authoring.map(r=>r.path)).toEqual(['motion.json','report.json','skeleton.json']);
 expect(await Bun.file(join(root,'review.json')).exists()).toBe(false);
 for(const [path,content] of Object.entries(files))expect(await Bun.file(join(root,path)).text()).toBe(content);
 const original=p.sourceHash;await writeFile(join(root,'motion.json'),'changed');expect((await loadReview(root)).sourceHash).not.toBe(original);
});
test('feedback interval/target/category/summary survives state round trip, rejects key proposals and malformed intervals',async()=>{
 const f=await fixture();await writeFile(join(f.root,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[{name:'arm'}],slots:[],animations:[]}));await writeFile(f.path,JSON.stringify({...f.input,model:'skeleton.model.json'}));const p=await loadReview(f.path);const state=join(f.root,'state');const item={id:'note-1',frameStart:10,frameEnd:18,target:{kind:'bone' as const,name:'arm'},category:'defect' as const,summary:'Elbow snaps in the turn',context:{checkpoint:'shape',interval:{frameStart:10,frameEnd:18,inclusive:true}}};
 const saved=await saveSession(p,{...freshSession(p),feedback:[item]},state);expect(saved.feedback[0]).toEqual(item);expect((await readSession(p,state)).feedback[0]).toEqual(item);
 for(const bad of [{...item,frameStart:-1},{...item,frameEnd:9},{...item,frameStart:1.5},{...item,summary:'two\nlines'},{...item,category:'edit'}])await expect(saveSession(p,{...freshSession(p),feedback:[bad]},state)).rejects.toThrow();
 await expect(saveSession(p,{...freshSession(p),corrections:[]},state)).rejects.toThrow('authoring proposals are not accepted');
});

test('reviewed artifact identity records exact separate rig/motion byte hashes and tool versions',async()=>{
 const f=await fixture();const rig='{"skeleton":{"spine":"4.3"}}\n';const motion='{"animation":"walk"}\n';await writeFile(join(f.root,'skeleton.json'),rig);await writeFile(join(f.root,'custom-motion.json'),motion);await writeFile(f.path,JSON.stringify({...f.input,motion:'custom-motion.json'}));const p=await loadReview(f.path);const packageInfo=await Bun.file('package.json').json();
 expect(p.reviewedSource).toEqual({packageRevision:'one',viewerVersion:packageInfo.version,runtimeVersion:packageInfo.dependencies['@rig-c/play'],rig:{path:'skeleton.json',sha256:createHash('sha256').update(rig).digest('hex')},motion:{path:'custom-motion.json',sha256:createHash('sha256').update(motion).digest('hex')}});
 const state=join(f.root,'state');const submitted={...freshSession(p),status:'changes-requested',feedback:[{id:'one',frameStart:2,frameEnd:4,target:{kind:'rig',name:p.manifest.id},category:'quality',summary:'Inspect the transition'}]};await saveSession(p,submitted,state);expect((await readSession(p,state)).reviewedSource).toEqual(p.reviewedSource);
 for(const reviewedSource of [{...p.reviewedSource,packageRevision:'other'},{...p.reviewedSource,viewerVersion:'other'},{...p.reviewedSource,runtimeVersion:'other'},{...p.reviewedSource,rig:{path:'skeleton.json',sha256:'fake'}},{...p.reviewedSource,motion:null}])await expect(saveSession(p,{...submitted,reviewedSource},state)).rejects.toThrow('session.reviewedSource');
 await writeFile(join(f.root,'custom-motion.json'),motion+' ');const changed=await loadReview(f.path);expect(changed.reviewedSource.rig).toEqual(p.reviewedSource.rig);expect(changed.reviewedSource.motion?.sha256).not.toBe(p.reviewedSource.motion?.sha256);expect((await readSession(changed,state)).status).toBe('pending');expect(await Bun.file(join(f.root,'skeleton.json')).text()).toBe(rig);
});
test('absent rig and motion stay null and compiled model takes identity precedence',async()=>{const f=await fixture();const p=await loadReview(f.path);expect(p.reviewedSource.rig).toBeNull();expect(p.reviewedSource.motion).toBeNull();const model=JSON.stringify({spec:'rigc-compiled/3',pages:[]});await writeFile(join(f.root,'skeleton.model.json'),model);await writeFile(join(f.root,'skeleton.json'),'raw evidence');await writeFile(f.path,JSON.stringify({...f.input,model:'skeleton.model.json'}));expect((await loadReview(f.path)).reviewedSource.rig).toEqual({path:'skeleton.model.json',sha256:createHash('sha256').update(model).digest('hex')});});

test('binary skeleton evidence receives exact rig identity without enabling playback',async()=>{const root=await mkdtemp(join(tmpdir(),'review-skel-'));dirs.push(root);const bytes=new Uint8Array([0,255,83,75,69,76,128,1]);await writeFile(join(root,'skeleton.skel'),bytes);await writeFile(join(root,'motion.json'),'{}');const p=await loadReview(root);expect(p.manifest.model).toBeUndefined();expect(p.reviewedSource.rig).toEqual({path:'skeleton.skel',sha256:createHash('sha256').update(bytes).digest('hex')});expect(p.reviewedSource.motion?.path).toBe('motion.json');expect(await Bun.file(join(root,'skeleton.skel')).bytes()).toEqual(bytes);});

async function buildFolder(){const root=await mkdtemp(join(tmpdir(),'review-build-'));dirs.push(root);await mkdir(join(root,'build'));return root;}
test('rigc build folder binds model pages and root motion without changing delivered files',async()=>{
 const root=await buildFolder();const contents={'build/skeleton.model.json':JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'page.png'}]}),'build/page.png':'page bytes','motion.json':'{"animations":[]}','report.json':'{}','source.mp4':'video','contact-strip.png':'strip'};
 for(const [path,bytes] of Object.entries(contents))await writeFile(join(root,path),bytes);
 const before=(await readdir(root,{recursive:true})).sort();const p=await loadReview(root);
 expect(p.manifest.model).toBe('build/skeleton.model.json');expect(p.manifest.motion).toBe('motion.json');expect([...p.files].sort()).toEqual(Object.keys(contents).sort());expect(p.manifest.references).toHaveLength(2);
 for(const [key,path] of [['rig','build/skeleton.model.json'],['motion','motion.json']] as const)expect(p.reviewedSource[key]).toEqual({path,sha256:createHash('sha256').update(contents[path]).digest('hex')});
 expect((await readdir(root,{recursive:true})).sort()).toEqual(before);expect(await Bun.file(join(root,'review.json')).exists()).toBe(false);
 for(const [path,bytes] of Object.entries(contents))expect(await Bun.file(join(root,path)).text()).toBe(bytes);
});
test('build model alone is recognized and root compiled model keeps precedence',async()=>{
 const root=await buildFolder();await writeFile(join(root,'build/skeleton.model.json'),'{"spec":"rigc-compiled/3","pages":[]}');expect((await loadReview(root)).manifest.model).toBe('build/skeleton.model.json');
 await writeFile(join(root,'skeleton.model.json'),'{"spec":"rigc-compiled/3","pages":[]}');await writeFile(join(root,'build/skeleton.model.json'),'invalid unselected build');const p=await loadReview(root);expect(p.manifest.model).toBe('skeleton.model.json');expect(p.files.has('build/skeleton.model.json')).toBe(false);
});
test('folder model discovery does not search arbitrary or deeper directories',async()=>{
 const root=await buildFolder();await Bun.write(join(root,'other/skeleton.model.json'),'{"spec":"rigc-compiled/3","pages":[]}');await Bun.write(join(root,'build/deeper/skeleton.model.json'),'{"spec":"rigc-compiled/3","pages":[]}');await expect(loadReview(root)).rejects.toThrow('no recognized');
 await writeFile(join(root,'motion.json'),'{}');expect((await loadReview(root)).manifest.model).toBeUndefined();
});
test('explicit review manifest remains authoritative over discovered build layout',async()=>{
 const root=await buildFolder();await writeFile(join(root,'build/skeleton.model.json'),'invalid ignored model');await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'curated',title:'Curated',revision:'one'}));const p=await loadReview(root);expect(p.manifest.id).toBe('curated');expect(p.manifest.model).toBeUndefined();expect(p.reviewedSource.rig).toBeNull();
});
test('selected build model refuses invalid format, directory and dangling symlink',async()=>{
 const root=await buildFolder();const model=join(root,'build/skeleton.model.json');await writeFile(model,'{"spec":"wrong","pages":[]}');await expect(loadReview(root)).rejects.toThrow('model.spec');await rm(model);await mkdir(model);await expect(loadReview(root)).rejects.toThrow('regular file');await rm(model,{recursive:true});await symlink(join(root,'missing.model.json'),model);await expect(loadReview(root)).rejects.toThrow();
});
test('build model and build directory symlinks cannot escape the package',async()=>{
 const root=await buildFolder();const outside=await buildFolder();await writeFile(join(outside,'skeleton.model.json'),'{"spec":"rigc-compiled/3","pages":[]}');await symlink(join(outside,'skeleton.model.json'),join(root,'build/skeleton.model.json'));await expect(loadReview(root)).rejects.toThrow('symlinks may not escape');await rm(join(root,'build'),{recursive:true});await symlink(outside,join(root,'build'));await expect(loadReview(root)).rejects.toThrow('symlinks may not escape');
});
test('discovered build pages may resolve inside the package but cannot escape it',async()=>{
 const root=await buildFolder();const model=join(root,'build/skeleton.model.json');await writeFile(join(root,'page.png'),'page');await writeFile(model,JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'../page.png'}]}));expect((await loadReview(root)).files.has('page.png')).toBe(true);await writeFile(model,JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'../../outside.png'}]}));await expect(loadReview(root)).rejects.toThrow('inside package');
});

function syntheticFramesRecord(){
 return {
  spec:'rigc-frames/1',
  background:[0,0,0,0],
  viewport:{x:-80,y:0,width:160,height:240,scale:1,pixelWidth:160,pixelHeight:240},
  sets:[{dir:'idle',animation:'idle',fps:12,sampled:33,written:33,stride:1,duration:2.6667,physics:{stepped:true,fps:60},extraSetField:'kept'}],
  extraTopField:'kept',
 };
}

test('manifest frames field: absent loads as main with frames null and unchanged sourceHash',async()=>{
 const parsed=parseManifest({schema:'rig-review/1',id:'x',title:'X',revision:'1'});
 expect('frames' in parsed).toBe(false);
 const demo=await loadReview('examples/demo/review.json');
 expect(demo.frames).toBeNull();
 expect(demo.sourceHash).toBe('9dfea04aee3349e43ffedd60b4e4393570ffcd829e29d28389daa33372a17b93');
 const f=await fixture();
 const pkg=await loadReview(f.path);
 expect(pkg.frames).toBeNull();
});

test('manifest frames field: present and valid exposes record with path, sha256 and sets and hashes with source',async()=>{
 const f=await fixture();
 const rel='check/idle_frames/frames.json';
 const abs=join(f.root,rel);
 await mkdir(join(f.root,'check/idle_frames'),{recursive:true});
 const raw=JSON.stringify(syntheticFramesRecord());
 await writeFile(abs,raw);
 await writeFile(f.path,JSON.stringify({...f.input,frames:rel}));
 const pkg=await loadReview(f.path);
 const sha256=createHash('sha256').update(raw).digest('hex');
 expect(pkg.manifest.frames).toBe(rel);
 expect(pkg.files.has(rel)).toBe(true);
 expect(pkg.frames).toEqual({
  path:rel,
  sha256,
  sets:[{animation:'idle',fps:12,written:33,stride:1,duration:2.6667}],
 });
 await writeFile(abs,raw+'\n');
 const changed=await loadReview(f.path);
 expect(changed.sourceHash).not.toBe(pkg.sourceHash);
 expect(changed.frames?.sha256).not.toBe(sha256);
});

test('manifest frames field: refuses missing file, unreadable JSON, bad spec, wrong set field types and duplicate animations by name',async()=>{
 const f=await fixture();
 const rel='check/idle_frames/frames.json';
 const abs=join(f.root,rel);
 await mkdir(join(f.root,'check/idle_frames'),{recursive:true});
 await writeFile(f.path,JSON.stringify({...f.input,frames:rel}));
 await expect(loadReview(f.path)).rejects.toThrow('FRAMES_MISSING');

 await writeFile(abs,'{not valid json');
 await expect(loadReview(f.path)).rejects.toThrow('FRAMES_JSON');

 await writeFile(abs,JSON.stringify({...syntheticFramesRecord(),spec:'rigc-frames/2'}));
 await expect(loadReview(f.path)).rejects.toThrow('FRAMES_SPEC');

 const baseSet=syntheticFramesRecord().sets[0]!;
 const badDocs:unknown[]=[
  'not-an-object',
  {spec:'rigc-frames/1',sets:'not-an-array'},
  {spec:'rigc-frames/1',sets:['not-an-object']},
  {spec:'rigc-frames/1',sets:[{...baseSet,animation:''}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,animation:null}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,fps:0}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,fps:12.5}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,fps:'12'}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,written:-1}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,written:3.5}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,written:'33'}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,stride:0}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,stride:1.5}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,stride:'1'}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,duration:-0.1}]},
  {spec:'rigc-frames/1',sets:[{...baseSet,duration:'2.6667'}]},
 ];
 for(const doc of badDocs){
  await writeFile(abs,JSON.stringify(doc));
  await expect(loadReview(f.path)).rejects.toThrow('FRAMES_FIELD');
 }

 await writeFile(abs,JSON.stringify({...syntheticFramesRecord(),sets:[baseSet,{...baseSet,dir:'idle-2'}]}));
 await expect(loadReview(f.path)).rejects.toThrow('FRAMES_DUPLICATE_ANIMATION');
});

test('manifest frames field: path rules (.., absolute, not in files, symlink escape) refuse with the same messages model gets',async()=>{
 for(const badPath of ['../frames.json','a/../frames.json','/tmp/frames.json','C:/frames.json']){
  let modelErr='',framesErr='';
  try{parseManifest({schema:'rig-review/1',id:'x',title:'X',revision:'1',model:badPath});}catch(e){modelErr=(e as Error).message;}
  try{parseManifest({schema:'rig-review/1',id:'x',title:'X',revision:'1',frames:badPath});}catch(e){framesErr=(e as Error).message;}
  expect(framesErr).toBe(modelErr.replace(/^model:/,'frames:'));
 }

 const f=await fixture();
 const outside=await mkdtemp(join(tmpdir(),'review-frames-outside-'));dirs.push(outside);
 await writeFile(join(outside,'frames.json'),JSON.stringify(syntheticFramesRecord()));
 await writeFile(join(outside,'out.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));
 await symlink(join(outside,'frames.json'),join(f.root,'frames.json'));
 await symlink(join(outside,'out.model.json'),join(f.root,'out.model.json'));
 await writeFile(f.path,JSON.stringify({...f.input,model:'out.model.json'}));
 let modelSymErr='';
 try{await loadReview(f.path);}catch(e){modelSymErr=(e as Error).message;}
 await writeFile(f.path,JSON.stringify({...f.input,frames:'frames.json'}));
 let framesSymErr='';
 try{await loadReview(f.path);}catch(e){framesSymErr=(e as Error).message;}
 expect(framesSymErr).toBe(modelSymErr.replace(/^out\.model\.json:/,'frames.json:'));

 await rm(join(f.root,'frames.json'));
 await rm(join(f.root,'out.model.json'));
 await writeFile(f.path,JSON.stringify(f.input));
 const plain=await loadReview(f.path);
 expect(plain.files.has('frames.json')).toBe(false);

 const sealedRoot=await realpath(await buildFolder());
 await writeFile(join(sealedRoot,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));
 await expect(loadReview(sealedRoot,{handoff:false,sealedPlayback:new Map()})).rejects.toThrow('build/skeleton.model.json: expected sealed playback file');
});

// #1018: the comment clock from the declared record. Records are `rigc render --candidate tests/fixtures/strip-probe/build
// --animation <a> --fps <f>` output (@rig-c/core 3.8.0), whose model states inspect 1 s, still 1 s and short 0.8 s, the
// same three animations and durations as the viewport-387 package used here.
async function clockPackage(frames:unknown,path='check/idle_frames/frames.json',report=true){
 const root=await mkdtemp(join(tmpdir(),'review-frames-clock-'));dirs.push(root);
 await cp(new URL('./fixtures/viewport-387/package',import.meta.url),root,{recursive:true});
 const manifest=JSON.parse(await readFile(join(root,'review.json'),'utf8'));if(!report)manifest.authoring=[];manifest.frames=path;
 await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),typeof frames==='string'?frames:JSON.stringify(frames));
 await writeFile(join(root,'review.json'),JSON.stringify(manifest));return join(root,'review.json');
}
const producerRecord=async(name:string)=>readFile(new URL(`./fixtures/frames-1018/${name}.frames.json`,import.meta.url),'utf8');
const record=(...sets:Record<string,unknown>[])=>({spec:'rigc-frames/1',background:[232,232,232,255],viewport:null,sets:sets.map(set=>({dir:set.animation,sampled:set.written,...set}))});

test('#1018 frames clock: the producer\'s own records give one clock per set, frame i at i * stride / fps',async()=>{
 for(const [name,clip,written] of [['still-12fps','still',13],['short-12fps','short',11]] as const){
  const pkg=await loadReview(await clockPackage(await producerRecord(name),'check/idle_frames/frames.json',false));
  expect(pkg.feedbackCatalog.frameClocks).toEqual([{animation:clip,clock:{kind:'uniform',fps:12,frame0:0,frameCount:written}}]);
  // The clip end bounds the samples: short's last sample (10/12 s) lies past its 0.8 s end, so F9 is the last reachable.
  expect(feedbackLastFrame(pkg.feedbackCatalog,clip)).toBe(clip==='short'?9:12);
  expect(feedbackLastFrame(pkg.feedbackCatalog,'inspect')).toBeNull();
 }
 // The same producer schedule at 7 fps (measured): still 8 frames ending at 1 s, short 7 frames ending at 6/7 s.
 const seven=await loadReview(await clockPackage(record({animation:'still',fps:7,written:8,stride:1,duration:1},{animation:'short',fps:7,written:7,stride:1,duration:0.8571428571428571}),'check/idle_frames/frames.json',false));
 expect(seven.feedbackCatalog.frameClocks?.map(value=>[value.animation,value.clock])).toEqual([['still',{kind:'uniform',fps:7,frame0:0,frameCount:8}],['short',{kind:'uniform',fps:7,frame0:0,frameCount:7}]]);
 // A stride writes every stride-th sample from 0: still at 24 fps samples 25 frames, stride 2 writes 13.
 const strided=await loadReview(await clockPackage(record({animation:'still',fps:24,written:13,stride:2,duration:1}),'check/idle_frames/frames.json',false));
 expect(strided.feedbackCatalog.frameClocks).toEqual([{animation:'still',clock:{kind:'uniform',fps:12,frame0:0,frameCount:13}}]);
});

test('#1018 frames clock: a set that is not the producer schedule for the model animation refuses by name',async()=>{
 const good={animation:'short',fps:12,written:11,stride:1,duration:0.8333333333333333};
 const cases:[Record<string,unknown>,string][]=[
  [{...good,animation:'walk'},'FRAMES_ANIMATION_UNKNOWN'],
  [{...good,written:10},'FRAMES_COUNT_MISMATCH'],[{...good,written:12},'FRAMES_COUNT_MISMATCH'],[{...good,written:0},'FRAMES_COUNT_MISMATCH'],
  [{...good,fps:24},'FRAMES_COUNT_MISMATCH'],[{...good,stride:2},'FRAMES_COUNT_MISMATCH'],
  // The clip's own end is not the producer's last sample when the clip is not a whole number of frames.
  [{...good,duration:0.8},'FRAMES_DURATION_MISMATCH'],[{...good,duration:good.duration+2*FRAMES_DURATION_TOLERANCE},'FRAMES_DURATION_MISMATCH'],
 ];
 for(const [set,code] of cases)await expect(loadReview(await clockPackage(record(set),'check/idle_frames/frames.json',false))).rejects.toThrow(code+':');
 // HQ ruling: the refusal names the animation and both figures (the record's and the model's schedule).
 const refusal=async(set:Record<string,unknown>)=>{try{await loadReview(await clockPackage(record(set),'check/idle_frames/frames.json',false));}catch(e){return (e as Error).message;}throw new Error('expected a refusal');};
 expect(await refusal({...good,animation:'walk'})).toBe('FRAMES_ANIMATION_UNKNOWN: check/idle_frames/frames.json: set "walk" names no animation of the compiled model');
 expect(await refusal({...good,written:10})).toBe('FRAMES_COUNT_MISMATCH: check/idle_frames/frames.json: set "short" writes 10 frame(s) at 12 fps stride 1; the model\'s 0.8 s animation samples to 11');
 expect(await refusal({...good,duration:0.8})).toBe('FRAMES_DURATION_MISMATCH: check/idle_frames/frames.json: set "short" lasts 0.8 s; the model\'s 0.8 s animation at 12 fps ends its last sample at 0.8333333333333334 s');
 // Inside the tolerance (float rounding of i * (1 / fps) against i / fps) still loads.
 expect((await loadReview(await clockPackage(record({...good,duration:good.duration+FRAMES_DURATION_TOLERANCE/2}),'check/idle_frames/frames.json',false))).feedbackCatalog.frameClocks).toHaveLength(1);
 // One bad set refuses the record; it never indexes the others.
 await expect(loadReview(await clockPackage(record({animation:'still',fps:12,written:13,stride:1,duration:1},{...good,written:10}),'check/idle_frames/frames.json',false))).rejects.toThrow('FRAMES_COUNT_MISMATCH:');
});

test('#1018 frames clock: the report keeps its animation, other sets add clocks, and both publication paths read alike',async()=>{
 const still={animation:'still',fps:12,written:13,stride:1,duration:1},inspect={animation:'inspect',fps:12,written:13,stride:1,duration:1};
 const pkg=await loadReview(await clockPackage(record(inspect,still)));
 expect(pkg.feedbackCatalog.clockAnimation).toBe('inspect');expect(pkg.feedbackCatalog.clock).toEqual({kind:'samples',frameTimes:expect.any(Array)});
 expect(pkg.feedbackCatalog.frameClocks?.map(value=>value.animation)).toEqual(['still']);
 expect(feedbackLastFrame(pkg.feedbackCatalog,'inspect')).toBe(24);expect(feedbackLastFrame(pkg.feedbackCatalog,'still')).toBe(12);expect(feedbackLastFrame(pkg.feedbackCatalog,'short')).toBeNull();
 // Version-bound (the path the registration names) and draft-bound (check/idle_frames) publications: one rule, any declared path.
 for(const path of ['versions/v1/registration/idle/frames.json','check/idle_frames/frames.json']){
  const loaded=await loadReview(await clockPackage(await producerRecord('still-12fps'),path,false));
  expect(loaded.frames?.path).toBe(path);expect(loaded.feedbackCatalog.frameClocks).toEqual([{animation:'still',clock:{kind:'uniform',fps:12,frame0:0,frameCount:13}}]);
 }
 // No compiled model: no player and nothing to index, so the record adds no clock (it is still hashed and checked as part A).
 const f=await fixture();await mkdir(join(f.root,'check/idle_frames'),{recursive:true});await writeFile(join(f.root,'check/idle_frames/frames.json'),await producerRecord('still-12fps'));
 await writeFile(f.path,JSON.stringify({...f.input,frames:'check/idle_frames/frames.json'}));
 expect((await loadReview(f.path)).feedbackCatalog.frameClocks).toBeUndefined();
 // Without a record the catalog carries no new key at all.
 expect('frameClocks' in (await loadReview(new URL('./fixtures/viewport-387/package/review.json',import.meta.url).pathname)).feedbackCatalog).toBe(false);
});
