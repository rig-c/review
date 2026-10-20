import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {
 MESH_EDIT_BASIS,MESH_EDIT_CONSTRAINT_END,MESH_EDIT_HULL_EDGE,MESH_EDIT_INVALID_OP,MESH_EDIT_MODEL_UNAVAILABLE,MESH_EDIT_TRIANGULATION_EDGE,MESH_EDIT_PREVIEW_NOTE,MODELING_TARGET_UNSUPPORTED,MeshEditSession,affineOf,applyMeshOps,draftOps,edgeKey,hitMesh,meshEditBinding,meshEditDocument,
 parseMeshDraft,screenDeltaToCrop,sourceEdges,verticesInBox,writeMeshDraft,type MeshSource,
} from '../src/mesh-edit.ts';
import {meshEditShortcut,meshEditSource,meshEditVisible,meshModeKeys} from '../web/mesh-editor.ts';

const html=()=>readFile(new URL('../web/index.html',import.meta.url),'utf8');
const between=(text:string,start:string,end:string)=>{const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<a)throw new Error(`missing ${start} … ${end}`);return text.slice(a,b+end.length);};
/** A 10 px square with a centre vertex: hull 0-1-2-3, four interior spokes to 4. */
const square=():MeshSource=>({slot:'panel',skin:'default',attachment:'panel',vertices:[[0,0],[10,0],[10,10],[0,10],[5,5]],triangles:[0,1,4,1,2,4,2,3,4,3,0,4],hull:4,hash:'0'.repeat(61)+'abc'});
const kinds=(session:MeshEditSession)=>Object.fromEntries(session.view().edges.map(e=>[edgeKey(e.a,e.b),e.kind]));

test('hit-testing is in screen px: a vertex within 6 px (8 on touch) wins over an edge; an edge within 4 px; one px further is no hit',()=>{
 const points=[{x:0,y:0},{x:100,y:0}],edges=[{a:0,b:1}];
 expect(hitMesh(points,edges,{x:6,y:0})).toEqual({kind:'vertex',v:0});
 expect(hitMesh(points,edges,{x:0,y:6})).toEqual({kind:'vertex',v:0});
 expect(hitMesh(points,edges,{x:0,y:7})).toBeNull();
 expect(hitMesh(points,edges,{x:0,y:8},true)).toEqual({kind:'vertex',v:0});
 expect(hitMesh(points,edges,{x:0,y:9},true)).toBeNull();
 // On the edge line but inside the vertex radius: the vertex wins.
 expect(hitMesh(points,edges,{x:5,y:1})).toEqual({kind:'vertex',v:0});
 expect(hitMesh(points,edges,{x:50,y:4})).toEqual({kind:'edge',a:0,b:1,t:.5,at:{x:50,y:0}});
 expect(hitMesh(points,edges,{x:50,y:5})).toBeNull();
 // The nearer of two vertices.
 expect(hitMesh([{x:0,y:0},{x:4,y:0}],[],{x:3,y:0})).toEqual({kind:'vertex',v:1});
 expect(hitMesh([null,{x:0,y:0}],[{a:0,b:1}],{x:0,y:0})).toEqual({kind:'vertex',v:1});
 expect(verticesInBox([{x:0,y:0},{x:5,y:5},null,{x:20,y:2}],{x:10,y:10},{x:-1,y:-1})).toEqual([0,1]);
});

test('the source edges: consecutive hull vertices are hull edges, the rest of the triangulation is interior',()=>{
 const edges=sourceEdges(square());expect(edges.length).toBe(8);
 expect(edges.filter(e=>e.kind==='hull').map(e=>edgeKey(e.a,e.b)).sort()).toEqual(['0:1','0:3','1:2','2:3']);
});

test('ops record in order; undo drops the last action and redo replays it; a new action clears redo',()=>{
 const session=new MeshEditSession(square());
 expect(session.record(session.moveOps([4],1.5,-1))).toEqual({ok:true,changed:true});
 expect(session.view().vertices[4]).toEqual([6.5,4]);expect(session.view().moved.get(4)).toEqual([5,5]);
 // An edge drag is one action of two ops.
 expect(session.record(session.moveOps([0,1],0,2))).toEqual({ok:true,changed:true});
 expect(session.ops().map(op=>op.op)).toEqual(['move','move','move']);
 expect(session.undo()).toBe(true);
 expect(session.ops()).toEqual([{op:'move',v:4,from:[5,5],to:[6.5,4]}]);expect(session.view().vertices[0]).toEqual([0,0]);
 expect(session.canRedo()).toBe(true);expect(session.redo()).toBe(true);expect(session.view().vertices[1]).toEqual([10,2]);expect(session.ops().length).toBe(3);
 expect(session.undo()).toBe(true);expect(session.undo()).toBe(true);expect(session.undo()).toBe(false);
 expect(session.ops()).toEqual([]);expect(session.view().vertices[4]).toEqual([5,5]);expect(session.view().moved.size).toBe(0);
 session.redo();session.addVertex([2,2]);expect(session.canRedo()).toBe(false);expect(session.ops().map(op=>op.op)).toEqual(['move','add']);
 session.reset();expect(session.ops()).toEqual([]);expect(session.canUndo()).toBe(false);
 // A zero offset records nothing.
 expect(session.moveOps([4],0,0)).toEqual([]);
});

test('Create splits an edge into two of the same kind; Delete removes a vertex with its edges, or one non-hull edge',()=>{
 const session=new MeshEditSession(square());
 expect(session.addVertex([5,0],[0,1])).toEqual({ok:true,changed:true});
 expect(kinds(session)).toMatchObject({'0:5':'hull','1:5':'hull'});expect(kinds(session)['0:1']).toBeUndefined();expect(session.view().added).toEqual(new Set([5]));
 expect(session.addVertex([3,7])).toEqual({ok:true,changed:true});expect(session.view().vertices[6]).toEqual([3,7]);
 expect(session.removeVertex(4)).toEqual({ok:true,changed:true});
 expect(session.view().vertices[4]).toBeNull();expect(session.view().edges.some(e=>e.a===4||e.b===4)).toBe(false);expect(session.view().removedEdges.length).toBe(4);
 expect(session.deleteEdge(1,2)).toEqual({ok:false,code:`${MESH_EDIT_HULL_EDGE}: 1-2 is a hull edge and cannot be removed`});
 expect(session.removeVertex(4).ok).toBe(false);
 expect(()=>applyMeshOps(square(),[{op:'move',v:9,from:[0,0],to:[1,1]}])).toThrow(MESH_EDIT_INVALID_OP);
});

test('Edges: a new pair adds a constraint, clicking it again removes it, a hull edge is refused and a duplicate is a no-op',()=>{
 const session=new MeshEditSession(square());
 expect(session.toggleConstraint(0,2)).toEqual({ok:true,changed:true});expect(kinds(session)['0:2']).toBe('constraint');
 expect(session.toggleConstraint(1,0)).toEqual({ok:false,code:`${MESH_EDIT_HULL_EDGE}: 1-0 is a hull edge and cannot be removed`});
 const before=session.ops().length;
 expect(session.toggleConstraint(0,4)).toMatchObject({ok:true,changed:false});expect(session.ops().length).toBe(before);
 expect(session.toggleConstraint(3,3)).toEqual({ok:true,changed:false});
 expect(()=>applyMeshOps(square(),[{op:'edge',a:0,b:2},{op:'edge',a:2,b:0}])).toThrow('duplicates edge');
 expect(()=>applyMeshOps(square(),[{op:'unedge',a:0,b:1}])).toThrow('removes hull edge');
 expect(session.toggleConstraint(2,0)).toEqual({ok:true,changed:true});expect(kinds(session)['0:2']).toBeUndefined();
 expect(session.ops()).toEqual([{op:'edge',a:0,b:2},{op:'unedge',a:2,b:0}]);
});

test('the export has the spec shape against a fixture, and the binding names the attachment hash',async()=>{
 const session=new MeshEditSession(square());
 session.record(session.moveOps([4],1.5,-1));session.toggleConstraint(0,2);session.addVertex([5,0],[0,1]);session.removeVertex(3);
 const expected=JSON.parse(await readFile(new URL('./fixtures/mesh-edit/expected.json',import.meta.url),'utf8'));
 expect(JSON.parse(JSON.stringify(meshEditDocument(session)))).toEqual(expected);
 expect(meshEditDocument(session).basis).toBe('setup');expect(MESH_EDIT_BASIS).toBe('setup');
 expect(meshEditDocument(session).preview.startsWith(MESH_EDIT_PREVIEW_NOTE)).toBe(true);
 const binding=meshEditBinding({fileSha256:'f'.repeat(64),sourceHash:'p'.repeat(64),reviewedSource:{viewerVersion:'1',runtimeVersion:'2',rig:{sha256:'r'.repeat(64)},motion:null},exportedAt:'2026-10-20T00:00:00.000Z',mapping:'m',attachment:{slot:'panel',skin:'default',name:'panel',sha256:square().hash}});
 expect(binding).toMatchObject({schema:'rig-review-mesh-edit-binding/1',file:{name:'mesh-edit.json',sha256:'f'.repeat(64)},package:'p'.repeat(64),model:'r'.repeat(64),motion:null,attachment:{slot:'panel',skin:'default',name:'panel',sha256:square().hash}});
});

test('the draft is bound to the attachment hash and never restores ops for another hash',()=>{
 const session=new MeshEditSession(square());session.toggleConstraint(0,2);
 const text=writeMeshDraft(parseMeshDraft(''),square(),session.ops());
 expect(draftOps(parseMeshDraft(text),square())).toEqual([{op:'edge',a:0,b:2}]);
 expect(draftOps(parseMeshDraft(text),{...square(),hash:'1'.repeat(64)})).toBeNull();
 expect(writeMeshDraft(parseMeshDraft(text),square(),[])).toBe('');
 expect(parseMeshDraft('{not json').entries).toEqual({});
 // A pre-#100 draft (posed basis) is not restored over the setup-space source.
 expect(draftOps(parseMeshDraft(text.replace('rig-review-mesh-edit-draft/2','rig-review-mesh-edit-draft/1')),square())).toBeNull();
});

test('screen offsets become crop offsets through the camera and the crop mapping',()=>{
 // crop → world: (x − 416, 1216 − y); world → screen: 2 px per unit, y flipped.
 const m=affineOf((x,y)=>({x:100+(x-416)*2,y:100-(1216-y)*2}));
 expect(screenDeltaToCrop(m,10,-6)).toEqual([5,-3]);
 expect(screenDeltaToCrop(affineOf(()=>({x:0,y:0})),1,1)).toBeNull();
});

test('keys: V/C/X/E pick a sub-mode, Escape, Cmd/Ctrl-Z and Shift-Cmd-Z, arrows nudge in Modify; text entry and I/M/B are left alone',()=>{
 const element=(selector:string|null)=>({closest:(s:string)=>selector&&s.split(',').some(part=>part.trim()===selector)?{}:null});
 const key=(k:string,extra:Partial<{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean;altKey:boolean;repeat:boolean;target:unknown}>={})=>({key:k,shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,target:element(null),...extra});
 const on={active:true,mode:'modify' as const,selected:2};
 expect(Object.entries(meshModeKeys)).toEqual([['v','modify'],['c','create'],['x','delete'],['e','edges']]);
 for(const [k,mode] of Object.entries(meshModeKeys))expect(meshEditShortcut(key(k.toUpperCase()),on)).toEqual({type:'mode',mode});
 for(const k of ['i','m','b',' ','Enter'])expect(meshEditShortcut(key(k),on)).toBeNull();
 expect(meshEditShortcut(key('Escape'),on)).toEqual({type:'escape'});
 expect(meshEditShortcut(key('z',{metaKey:true}),on)).toEqual({type:'undo'});
 expect(meshEditShortcut(key('z',{ctrlKey:true}),on)).toEqual({type:'undo'});
 expect(meshEditShortcut(key('Z',{metaKey:true,shiftKey:true}),on)).toEqual({type:'redo'});
 expect(meshEditShortcut(key('ArrowLeft'),on)).toEqual({type:'nudge',dx:-1,dy:0});
 expect(meshEditShortcut(key('ArrowDown',{shiftKey:true}),on)).toEqual({type:'nudge',dx:0,dy:10});
 expect(meshEditShortcut(key('ArrowLeft'),{...on,selected:0})).toBeNull();
 expect(meshEditShortcut(key('ArrowLeft'),{...on,mode:'create'} as never)).toBeNull();
 expect(meshEditShortcut(key('ArrowLeft',{target:element('[role=separator]')}),on)).toBeNull();
 // Text entry keeps every key, undo included; off means nothing is taken.
 for(const tag of ['textarea','select'])for(const k of ['v','e','Escape','ArrowLeft'])expect(meshEditShortcut(key(k,{target:element(tag)}),on)).toBeNull();
 expect(meshEditShortcut(key('z',{metaKey:true,target:element('textarea')}),on)).toBeNull();
 expect(meshEditShortcut(key('v'),{...on,active:false})).toBeNull();
 expect(meshEditShortcut(key('v',{repeat:true}),on)).toBeNull();
 expect(meshEditShortcut(key('Escape',{target:element('dialog[open]')}),on)).toBeNull();
});

/** A rigc-compiled/3 document: `panel` an unweighted mesh on `arm` (setup at (3, 4)), `badge` a region, `tag` a linked mesh of panel. */
const setupModel=()=>({spec:'rigc-compiled/3',bones:[{name:'root'},{name:'arm'}],slots:[{name:'panel',bone:'arm'},{name:'badge',bone:'root'},{name:'tag',bone:'arm'}],
 skins:[{name:'default',attachments:{panel:{panel:{kind:'mesh',uvs:[0,0,1,0,1,1,0,1,.5,.5],triangles:[0,1,4,1,2,4,2,3,4,3,0,4],hull:4,vertices:{weighted:false,xy:[-5,5,5,5,5,-5,-5,-5,.123456,-.654321]},width:10,height:10}},badge:{badge:{kind:'region'}},tag:{tag:{kind:'linkedmesh',skin:'default',slot:'panel',source:'panel'}}}}]});
/** The setup pose: `arm` at world (3, 4), unrotated. */
const armPose=(identity:{skin:string;attachment:string}|null)=>({identity,world:(bone:string)=>{if(bone!=='arm')throw new Error('unread bone '+bone);return {x:3,y:4,a:1,b:0,c:0,d:1};}});
const cropMapping={available:true as const,crop:{w:20,h:20},toWorld:(x:number,y:number)=>({x:x-10,y:20-y}),basis:'b'};

test('#100 bar 1 (unit): the source is the slot\'s mesh in the model document at the setup pose, mapped to crop px unrounded',()=>{
 const model=setupModel(),entry=model.skins[0]!.attachments.panel.panel;
 const ok=meshEditSource({slot:'panel',model,pose:()=>armPose({skin:'default',attachment:'panel'}),mapping:cropMapping});
 if(!ok.ok)throw new Error(ok.code);
 // Stored xy + the arm's setup world (3, 4) = world; crop = (wx + 10, 20 − wy). Exactly, not rounded to 0.01.
 const xy=entry.vertices.xy,world=xy.map((v,i)=>i%2?Math.fround(v)+4:Math.fround(v)+3);
 expect(ok.world).toEqual(world);
 expect(ok.source.vertices).toEqual([[8,11],[18,11],[18,21],[8,21],[Math.fround(.123456)+3+10,20-(Math.fround(-.654321)+4)]]);
 expect(ok.source.vertices[4]![0]).not.toBe(Math.round(ok.source.vertices[4]![0]*100)/100);
 expect(ok).toMatchObject({source:{slot:'panel',skin:'default',attachment:'panel',hull:4,triangles:entry.triangles},entry});
 // Without a setup identity the slot's mesh named like the slot is read.
 expect(meshEditSource({slot:'panel',model,pose:()=>armPose(null),mapping:cropMapping})).toMatchObject({ok:true,source:{attachment:'panel'}});
});

test('#100 bar 2 (unit): no model document refuses MESH_EDIT_MODEL_UNAVAILABLE before anything else, and no setup pose is read',()=>{
 let posed=0;const pose=()=>{posed++;return armPose(null);};
 for(const slot of [null,'panel'])for(const model of [null,undefined]){
  const result=meshEditSource({slot,model,pose,mapping:cropMapping}),code=result.ok?'':result.code;
  expect(result.ok).toBe(false);expect(code.split(':')[0]).toBe(MESH_EDIT_MODEL_UNAVAILABLE);
  expect(code).toMatch(/^MESH_EDIT_MODEL_UNAVAILABLE: the package supplies no compiled model document \(skeleton\.model\.json\); the setup mesh is read from it$/);
 }
 expect(meshEditSource({slot:'panel',model:{spec:'spine'},pose,mapping:cropMapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_MODEL_UNAVAILABLE: /)});
 expect(posed).toBe(0);
});

test('the source refuses by name: whole rig, a non-mesh slot, a linked mesh, no rig, no mapping',()=>{
 const model=setupModel(),pose=(slot:string)=>armPose({skin:'default',attachment:slot});
 expect(meshEditSource({slot:null,model,pose,mapping:cropMapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_SELECT_SLOT: /)});
 expect(meshEditSource({slot:'badge',model,pose,mapping:cropMapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_NO_MESH badge: /)});
 expect(meshEditSource({slot:'tag',model,pose,mapping:cropMapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_NO_MESH tag: .*linked mesh/)});
 expect(meshEditSource({slot:'panel',model,pose:()=>null,mapping:cropMapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_RIG_UNAVAILABLE: /)});
 expect(meshEditSource({slot:'panel',model,pose,mapping:{available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: x'}})).toMatchObject({ok:false,code:expect.stringMatching(/^CHEST_REGION_MAPPING_UNAVAILABLE: x: /)});
 expect(meshEditVisible('rig')).toBe(true);for(const other of ['playback','feedback',undefined])expect(meshEditVisible(other)).toBe(false);
});

test('the producer owns the triangulation: Delete removes only an added constraint edge, and a constraint end only after its edge',()=>{
 const session=new MeshEditSession(square());
 expect(session.deleteEdge(0,4)).toEqual({ok:false,code:expect.stringMatching(new RegExp(`^${MESH_EDIT_TRIANGULATION_EDGE}: 0-4 `))});
 expect(session.ops()).toEqual([]);
 expect(()=>applyMeshOps(square(),[{op:'unedge',a:0,b:4}])).toThrow('removes triangulation edge 0-4');
 expect(session.toggleConstraint(0,2)).toEqual({ok:true,changed:true});
 expect(session.removeVertex(2)).toEqual({ok:false,code:expect.stringMatching(new RegExp(`^${MESH_EDIT_CONSTRAINT_END}: vertex 2 ends constraint edge 0-2`))});
 expect(()=>applyMeshOps(square(),[{op:'edge',a:0,b:2},{op:'remove',v:0}])).toThrow('an end of constraint edge 0-2');
 expect(session.deleteEdge(2,0)).toEqual({ok:true,changed:true});expect(session.removeVertex(2)).toEqual({ok:true,changed:true});
 expect(session.ops()).toEqual([{op:'edge',a:0,b:2},{op:'unedge',a:2,b:0},{op:'remove',v:2}]);
});

test('the Edit mesh toggle and bar sit in the view-bar tool area; Apply · Rebuild refuses by name; the editor has no path to a process or the server',async()=>{
 const page=await html(),bar=between(page,'<div class="viewbar">','<div id="stage-layout"'),tools=between(bar,'<div class="view-tools">','</div>');
 expect(tools).toMatch(/<button id="mesh-edit" type="button"[^>]* aria-pressed="false"[^>]* hidden>Edit mesh<\/button>/);
 const editor=between(bar,'<div id="mesh-editor-bar"','<span id="mesh-editor-status"');expect(editor).toContain(' hidden>');
 expect([...editor.matchAll(/data-mesh-mode="([a-z]+)"[^>]*aria-keyshortcuts="([A-Z])"/g)].map(m=>[m[1],m[2]])).toEqual([['modify','V'],['create','C'],['delete','X'],['edges','E']]);
 for(const id of ['mesh-undo','mesh-redo','mesh-reset','mesh-download','mesh-edit-draft'])expect(editor).toContain(`id="${id}"`);
 expect(between(editor,'<button id="mesh-apply"','</button>')).toContain(`title="${MODELING_TARGET_UNSUPPORTED}"`);
 expect(MODELING_TARGET_UNSUPPORTED).toBe('MODELING_TARGET_UNSUPPORTED: the producer has no delta operation (parts); export the delta');
 for(const file of ['../web/mesh-editor.ts','../src/mesh-edit.ts']){const source=await readFile(new URL(file,import.meta.url),'utf8');for(const word of ['fetch(','child_process','Bun.spawn','XMLHttpRequest','/api/','writeFile'])expect(source).not.toContain(word);}
});

test('the overlay dims the rig, keeps the edited triangles clear and draws hull, constraint and removed edges distinctly',async()=>{
 const {createCanvas}=await import('@napi-rs/canvas'),{RigOverlays}=await import('../web/rig-overlays.ts');
 const surface=createCanvas(200,200);Object.assign(surface,{style:{pointerEvents:'auto'},clientWidth:200,clientHeight:200});
 const overlays=new RigOverlays({canvas:surface as unknown as HTMLCanvasElement,rigRoot:{style:{visibility:'visible'}} as unknown as HTMLElement});
 const settings={images:true,mesh:false,bones:false,meshOpacity:.65},project=(x:number,y:number)=>({x,y});
 const colors={veil:'rgba(0,0,0,0.5)',edge:'#0000ff',hull:'#ff0000',constraint:'#00ff00',removed:'#ffff00',vertex:'#ffffff',ink:'#000000',selected:'#ff00ff',added:'#00ffff',hover:'#ffffff',box:'#808080',boxFill:'rgba(128,128,128,0.1)'};
 const p=(x:number,y:number)=>({x,y});
 const meshEdit={triangles:[[p(20,20),p(120,20),p(120,120)]],edges:[{from:p(20,20),to:p(120,20),kind:'hull' as const},{from:p(20,20),to:p(120,120),kind:'constraint' as const},{from:p(20,150.5),to:p(120,150.5),kind:'removed' as const},{from:p(120.5,20),to:p(120.5,120),kind:'interior' as const}],ghosts:[],vertices:[],colors};
 const pixel=(x:number,y:number)=>[...surface.getContext('2d').getImageData(x,y,1,1).data];
 const player={posedFrame:()=>{throw new Error('unused');},bone:()=>{throw new Error('unused');}} as never;
 overlays.refresh({player,bones:[],project,settings,dpr:1,meshEdit});
 expect(pixel(180,180)[3]).toBeGreaterThan(100);expect(pixel(100,40)[3]).toBe(0);
 expect(pixel(70,20).slice(0,3)).toEqual([255,0,0]);expect(pixel(70,70).slice(0,3)).toEqual([0,255,0]);expect(pixel(120,70).slice(0,3)).toEqual([0,0,255]);expect(pixel(22,150).slice(0,3)).toEqual([255,255,0]);
 overlays.redraw({project,settings,dpr:1});expect(pixel(180,180)[3]).toBe(0);
});
