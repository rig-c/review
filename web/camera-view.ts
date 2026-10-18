/** Fit-relative inspection cameras. Images and world geometry retain their own units. */
export interface CameraPoint {x:number;y:number}
export interface PaneCamera {zoom:number;center:CameraPoint|null}
export interface CameraFrame {space:'image'|'world';center:CameraPoint;baseScale:number;width:number;height:number}
export interface CameraSignature {zoom:number;pan:CameraPoint}
export const clampZoom=(zoom:number):number=>Math.max(.25,Math.min(8,zoom));
export function cameraFrame(space:CameraFrame['space'],box:{x:number;y:number;width:number;height:number},width:number,height:number,marginX=0,marginY=0):CameraFrame|null {
 if(![box.x,box.y,box.width,box.height,width,height].every(Number.isFinite)||box.width<=0||box.height<=0||width<=0||height<=0)return null;
 return {space,center:{x:box.x+box.width/2,y:box.y+box.height/2},baseScale:Math.max(.001,Math.min((width-marginX)/box.width,(height-marginY)/box.height)),width,height};
}
export function cameraSignature(camera:PaneCamera,frame:CameraFrame):CameraSignature {
 const center=camera.center??frame.center,scale=frame.baseScale*camera.zoom;
 return {zoom:camera.zoom,pan:{x:(frame.center.x-center.x)*scale/frame.width,y:(frame.space==='world'?center.y-frame.center.y:frame.center.y-center.y)*scale/frame.height}};
}
/** Match the closed numeric observation before a candidate can replace a live camera. */
export function assertCameraView(camera:PaneCamera,frame:CameraFrame):void {
 const center=camera.center??frame.center,scale=frame.baseScale*camera.zoom,width=frame.width/scale,height=frame.height/scale;
 const coordinate=(value:number)=>Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER;
 if(![center.x,center.y,center.x-width/2,center.y-height/2,(frame.center.x-center.x)*scale,(frame.center.y-center.y)*scale].every(coordinate)||![width,height].every(value=>Number.isFinite(value)&&value>0&&value<=Number.MAX_SAFE_INTEGER)||!Number.isFinite(scale)||scale<=0||!Number.isFinite(camera.zoom)||camera.zoom<.25||camera.zoom>8||![frame.width,frame.height].every(value=>Number.isFinite(value)&&value>0&&value<=65536))throw new Error('VIEW_CAMERA_RANGE: derived camera exceeds numeric source-coordinate limits');
}
export function cameraFromSignature(value:CameraSignature,frame:CameraFrame):PaneCamera {
 if(![value.zoom,value.pan.x,value.pan.y].every(Number.isFinite)||value.zoom<.25||value.zoom>8)throw new Error('Camera signature requires finite pan and zoom 0.25..8');
 const scale=frame.baseScale*value.zoom;
 const camera={zoom:value.zoom,center:{x:frame.center.x-value.pan.x*frame.width/scale,y:frame.center.y+(frame.space==='world'?1:-1)*value.pan.y*frame.height/scale}};
 assertCameraView(camera,frame);return camera;
}
/** Zoom preserves the normalized location already being inspected. */
export function zoomSignature(value:CameraSignature,factor:number):CameraSignature {
 const zoom=clampZoom(value.zoom*factor),ratio=zoom/value.zoom;
 return {zoom,pan:{x:value.pan.x*ratio,y:value.pan.y*ratio}};
}
export function dragSignature(value:CameraSignature,frame:CameraFrame,dx:number,dy:number):CameraSignature {
 return {zoom:value.zoom,pan:{x:value.pan.x+dx/frame.width,y:value.pan.y+dy/frame.height}};
}

/** Fit a selected conservative world box using the existing whole-rig camera
 * reference and normalized sync contract. The established zoom range still applies. */
export function boundsFitSignature(box:{x:number;y:number;width:number;height:number},frame:CameraFrame,marginX=0,marginY=0):CameraSignature {
 if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0)throw new Error('PART_FIT_UNAVAILABLE: positive finite drawn bounds required');
 const scale=Math.min((frame.width-marginX)/box.width,(frame.height-marginY)/box.height);
 if(!Number.isFinite(scale)||scale<=0)throw new Error('PART_FIT_UNAVAILABLE: viewport has no usable extent');
 const camera={zoom:clampZoom(scale/frame.baseScale),center:{x:box.x+box.width/2,y:box.y+box.height/2}};
 assertCameraView(camera,frame);return cameraSignature(camera,frame);
}
