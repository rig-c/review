import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview, packagePath, parseManifest } from '../src/manifest.ts';
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
test('opening starts pending; explicit state persists separately from source',async()=>{const f=await fixture();const p=await loadReview(f.path);const state=join(f.root,'user-state');const before=await Bun.file(f.path).text();expect((await readSession(p,state)).status).toBe('pending');const session=freshSession(p);session.status='approved';session.checkpoints.shape={outcome:'pass',note:'Contour accepted'};const saved=await saveSession(p,session,state);expect(saved.updatedAt).toBeString();expect((await readSession(p,state)).status).toBe('approved');expect(await Bun.file(f.path).text()).toBe(before);});
test('asset changes invalidate approval even without revision bump',async()=>{const f=await fixture();const original=await loadReview(f.path);const state=join(f.root,'state');const session=freshSession(original);session.status='approved';await saveSession(original,session,state);await writeFile(join(f.root,'source.svg'),'<svg><!-- changed --></svg>');const changed=await loadReview(f.path);expect(changed.sourceHash).not.toBe(original.sourceHash);expect(sessionFile(changed,state)).not.toBe(sessionFile(original,state));expect((await readSession(changed,state)).status).toBe('pending');await expect(saveSession(changed,session,state)).rejects.toThrow('sourceHash');});
test('session rejects foreign binding, unknown checkpoint and invalid feedback target',async()=>{const f=await fixture();const p=await loadReview(f.path);const state=join(f.root,'state');await expect(saveSession(p,{...freshSession(p),id:'other'},state)).rejects.toThrow('session.id');await expect(saveSession(p,{...freshSession(p),checkpoints:{unknown:{outcome:'pass',note:''}}},state)).rejects.toThrow('unknown checkpoint');await expect(saveSession(p,{...freshSession(p),feedback:[{id:'x',frameStart:0,frameEnd:1,target:{kind:'command',name:'x'},category:'defect',summary:'x'}]},state)).rejects.toThrow('feedback.target.kind');});
test('canonical Nova pose sequence preserves observed, missing and off-image coordinates',async()=>{const f=await fixture();f.input.references=[{id:'pose',label:'Nova pose',type:'pose',path:'pose.json'}];f.input.checkpoints=[];await writeFile(f.path,JSON.stringify(f.input));const pose={spec:'rig-pose-sequence/1',space:{units:'picture-px',origin:'top-left',y:'down'},width:1080,height:1920,source:'producer',frames:[{t:2,people:[{id:'a',joints:{neck:{state:'observed',at:[-10,410],score:2.1},r_wrist:{state:'missing'}}}]},{t:2.5,people:[]}],camera:[{s:2,tx:10,ty:20,inliers:8},{s:2,tx:10,ty:20,inliers:8}]};await writeFile(join(f.root,'pose.json'),JSON.stringify(pose));expect((await loadReview(f.path)).manifest.references[0].type).toBe('pose');pose.frames[1].t=2;await writeFile(join(f.root,'pose.json'),JSON.stringify(pose));await expect(loadReview(f.path)).rejects.toThrow('strictly increasing');});
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
 const f=await fixture();const p=await loadReview(f.path);const state=join(f.root,'state');const item={id:'note-1',frameStart:10,frameEnd:18,target:{kind:'bone' as const,name:'arm'},category:'defect' as const,summary:'Elbow snaps in the turn',context:{checkpoint:'shape'}};
 const saved=await saveSession(p,{...freshSession(p),feedback:[item]},state);expect(saved.feedback[0]).toEqual(item);expect((await readSession(p,state)).feedback[0]).toEqual(item);
 for(const bad of [{...item,frameStart:-1},{...item,frameEnd:9},{...item,frameStart:1.5},{...item,summary:'two\nlines'},{...item,category:'edit'}])await expect(saveSession(p,{...freshSession(p),feedback:[bad]},state)).rejects.toThrow();
 await expect(saveSession(p,{...freshSession(p),corrections:[]},state)).rejects.toThrow('authoring proposals are not accepted');
});

test('reviewed artifact identity records exact separate rig/motion byte hashes and tool versions',async()=>{
 const f=await fixture();const rig='{"skeleton":{"spine":"4.3"}}\n';const motion='{"animation":"walk"}\n';await writeFile(join(f.root,'skeleton.json'),rig);await writeFile(join(f.root,'custom-motion.json'),motion);await writeFile(f.path,JSON.stringify({...f.input,motion:'custom-motion.json'}));const p=await loadReview(f.path);const packageInfo=await Bun.file('package.json').json();
 expect(p.reviewedSource).toEqual({packageRevision:'one',viewerVersion:packageInfo.version,runtimeVersion:packageInfo.dependencies['@rig-c/play'],rig:{path:'skeleton.json',sha256:createHash('sha256').update(rig).digest('hex')},motion:{path:'custom-motion.json',sha256:createHash('sha256').update(motion).digest('hex')}});
 const state=join(f.root,'state');const submitted={...freshSession(p),status:'changes-requested',feedback:[{id:'one',frameStart:2,frameEnd:4,target:{kind:'rig',name:'whole rig'},category:'quality',summary:'Inspect the transition'}]};await saveSession(p,submitted,state);expect((await readSession(p,state)).reviewedSource).toEqual(p.reviewedSource);
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
