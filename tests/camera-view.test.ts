import {test,expect} from 'bun:test';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature} from '../web/camera-view.ts';

test('normalized camera motion uses each viewport and image/world Y sign, never common pixels or centers',()=>{
 const world=cameraFrame('world',{x:-300,y:80,width:200,height:600},600,400,28,58)!;
 const image=cameraFrame('image',{x:0,y:0,width:1920,height:1080},300,800,24,56)!;
 const moved=dragSignature({zoom:2,pan:{x:0,y:0}},world,120,60);
 const a=cameraFromSignature(moved,world),b=cameraFromSignature(moved,image);
 expect(cameraSignature(a,world).zoom).toBe(moved.zoom);expect(cameraSignature(a,world).pan.x).toBeCloseTo(moved.pan.x,12);expect(cameraSignature(a,world).pan.y).toBeCloseTo(moved.pan.y,12);expect(cameraSignature(b,image).pan.x).toBeCloseTo(.2,12);expect(cameraSignature(b,image).pan.y).toBeCloseTo(.15,12);
 expect(a.center!.y).toBeGreaterThan(world.center.y);expect(b.center!.y).toBeLessThan(image.center.y);
 expect((image.center.x-b.center!.x)*image.baseScale*b.zoom).toBeCloseTo(60,12); // half-width panel receives half the pixels
 expect(a.center).not.toEqual(b.center);expect(a.zoom).toBe(b.zoom);
 const zoomed=cameraFromSignature(zoomSignature(moved,1.5),world);expect(zoomed.center!.x).toBeCloseTo(a.center!.x,12);expect(zoomed.center!.y).toBeCloseTo(a.center!.y,12);
 expect(zoomSignature({zoom:8,pan:{x:.2,y:.1}},2)).toEqual({zoom:8,pan:{x:.2,y:.1}});
 expect(cameraFrame('world',{x:0,y:0,width:0,height:10},100,100)).toBe(null);expect(cameraFrame('image',{x:0,y:0,width:10,height:10},0,100)).toBe(null);
 expect(()=>cameraFromSignature({zoom:Infinity,pan:{x:0,y:0}},world)).toThrow('finite');
});

test('camera candidates refuse unsafe source centers or visible origins before a live assignment',()=>{
 const frame=cameraFrame('image',{x:0,y:0,width:2*Number.MAX_SAFE_INTEGER-1000,height:1080},300,800)!;
 expect(()=>assertCameraView({zoom:1,center:null},frame)).not.toThrow();
 expect(()=>cameraFromSignature({zoom:1,pan:{x:-100,y:0}},frame)).toThrow('VIEW_CAMERA_RANGE');
 expect(()=>assertCameraView({zoom:.25,center:{x:-Number.MAX_SAFE_INTEGER+10,y:0}},frame)).toThrow('VIEW_CAMERA_RANGE');
 const tiny=cameraFrame('world',{x:0,y:0,width:1e-18,height:1e-18},600,400)!;expect(()=>assertCameraView({zoom:1,center:{x:1,y:0}},tiny)).toThrow('VIEW_CAMERA_RANGE');
});
