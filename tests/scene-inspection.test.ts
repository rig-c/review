import {retainedPublicationRoutes} from '../src/job-front.ts';
import {expect,test} from 'bun:test';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {loadReview,parseManifest} from '../src/manifest.ts';
import {readSceneInspection,scenePlateBytes} from '../src/scene-inspection.ts';
import {assertReviewUnchanged} from '../src/reference.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {installSceneFixture,sceneHash} from './helpers/scene-inspection-fixture.ts';
import {takeSample} from '../web/scene-plates.ts';

test('#797 plate tamper changes the verdict publication source identity without adding an act field',async()=>{
 const f=await jobFixture();try{
  const root=join(f.root,'out'),{scene}=await installSceneFixture(root);
  f.setContext({...f.getContext(),selector:{kind:'post',version:2,rigVersion:1},subjects:[{kind:'review-verdict',stage:'direction-review'}]});
  const original=await loadReview(root),publication=await f.publish();
  expect(publication.source.direction?.path).toBe('out/direction.json');
  expect('scene' in publication.source).toBe(false);
  const plate=join(root,scene.plates[0]!.path),bytes=await readFile(plate);
  const routes=retainedPublicationRoutes(f.session),metadata=()=>routes(f.session.jobId,publication.publicationId,publication.instanceKey,'api/review',new Request(f.origin+'/api/review'));
  expect((await metadata()).status).toBe(200);
  const retained=f.session.retainedSource(publication.publicationId),sealedPlate=join(retained.snapshotRoot,'out',scene.plates[0]!.path);
  await writeFile(sealedPlate,Buffer.concat([bytes,Buffer.from('tampered retained plate')]));
  expect((await metadata()).status).toBe(409);
  await writeFile(sealedPlate,bytes);
  await writeFile(plate,Buffer.concat([bytes,Buffer.from('tamper')]));
  await expect(loadReview(root)).rejects.toThrow('SCENE_PLATE_CHANGED');
  await expect(assertReviewUnchanged(original)).rejects.toThrow('Package inputs changed');
  const refused=await(await f.call(await f.publishRequest())).json();expect(refused.ok).toBe(false);
  // A new, consistently sealed scene may publish, but cannot inherit the old act source identity.
  scene.plates[0]!.sha256=sceneHash(await readFile(plate));
  const sceneBytes=JSON.stringify(scene);await writeFile(join(root,'scene.json'),sceneBytes);
  const direction=JSON.parse(await readFile(join(root,'direction.json'),'utf8'));direction.scene.sha256=sceneHash(sceneBytes);
  await writeFile(join(root,'direction.json'),JSON.stringify(direction));
  const next=await f.publish();expect(next.source.sourceHash).not.toBe(publication.source.sourceHash);
  expect(next.source.model).toEqual(publication.source.model);expect('scene' in next.source).toBe(false);
 }finally{await f.close();}
});

test('#797 closed scene parser refuses shape, source, model, animation, dimensions, missing plate and layer mutations by name',async()=>{
 const f=await jobFixture();try{
  const root=join(f.root,'out'),{scene,model}=await installSceneFixture(root),pkg=await loadReview(root);
  expect(pkg.files.has('scene.json')).toBe(true);for(const p of scene.plates)expect(pkg.files.has(p.path)).toBe(true);
  const parse=(v:unknown)=>readSceneInspection(v,pkg.scene!.file,pkg.direction!,model);
  expect(parse({...scene,plates:[...scene.plates].reverse()}).plates.length).toBe(2);
  const cases:[(s:any)=>void,string][]=[
   [s=>{s.extra=true;},'SCENE_SOURCE_MISMATCH'],[s=>{s.rig.extra=true;},'SCENE_SOURCE_MISMATCH'],
   [s=>{s.plates[0].registered.extra=true;},'SCENE_SOURCE_MISMATCH'],[s=>{s.rig.acceptance.signoff.stage='other';},'SCENE_SOURCE_MISMATCH'],
   [s=>{s.n=2;},'SCENE_SOURCE_MISMATCH'],[s=>{s.plates[0].path='../escape.png';},'SCENE_SOURCE_MISMATCH'],[s=>{s.rig.version=2;},'SCENE_MODEL_MISMATCH'],
   [s=>{s.rig.model.sha256='0'.repeat(64);},'SCENE_MODEL_MISMATCH'],[s=>{s.frame.stage.width=20;},'SCENE_MODEL_MISMATCH'],
   [s=>{s.rig.animation.name='absent';},'SCENE_ANIMATION_MISSING'],[s=>{s.layers.reverse();},'SCENE_LAYER_ORDER'],
   [s=>{s.plates[1].role='background';},'SCENE_LAYER_ORDER'],[s=>{s.plates[0].width=0;},'SCENE_PLATE_DIMENSIONS'],
   [s=>{s.plates[0].rect.width*=2;},'SCENE_PLATE_DIMENSIONS'],
  ];for(const [mutate,code] of cases){const changed=structuredClone(scene);mutate(changed);expect(()=>parse(changed)).toThrow(code);}
  expect(()=>parseManifest({...pkg.manifest,direction:undefined})).toThrow('SCENE_REQUIRED');
  await expect(scenePlateBytes(root,{...pkg.scene!,plates:[{...pkg.scene!.plates[0]!,width:9}]})).rejects.toThrow('SCENE_PLATE_DIMENSIONS');
  await writeFile(join(root,'scene.json'),JSON.stringify(scene)+'\n');await expect(loadReview(root)).rejects.toThrow('SCENE_SOURCE_MISMATCH');
  await writeFile(join(root,'scene.json'),JSON.stringify(scene));
  await unlink(join(root,'background.png'));await expect(loadReview(root)).rejects.toThrow('SCENE_REQUIRED: background.png');
 }finally{await f.close();}
});

test('#797 camera and timing use authored intervals, easing and take seconds independently of the rig clip',async()=>{
 const f=await jobFixture();try{await installSceneFixture(join(f.root,'out'));const pkg=await loadReview(join(f.root,'out')),d=pkg.direction!;
  expect(takeSample(d,0)).toEqual({box:{x:-32,y:-16,width:64,height:64},sourceTime:0});
  expect(takeSample(d,4)).toEqual({box:{x:-24,y:-8,width:48,height:48},sourceTime:1});
  expect(takeSample(d,8)).toEqual({box:{x:-16,y:0,width:32,height:32},sourceTime:2});
  d.camera.keys[0]!.easing='hold';expect(takeSample(d,7).box).toEqual(d.camera.keys[0]!.box);
 }finally{await f.close();}
});
