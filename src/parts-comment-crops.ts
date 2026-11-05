/** Native evidence is cut from the bound original PNG, never from a displayed alpha mask. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {parsePartsComment,assertPartsCommentBinding,type PartsComment} from './parts-comment.ts';
import {validatePngCrop,storePngCrop} from './comment-crops.ts';
import {verdictSource,type PartsViewPackage} from './parts-view.ts';
export async function preparePartsComment(pkg:PartsViewPackage,raw:unknown,requireNative=false):Promise<PartsComment>{
 const c=parsePartsComment(raw,requireNative),item=pkg.items.find(i=>i.name===c.part);
 if(pkg.mode!=='parts'||!item)throw new Error('PARTS_COMMENT_UNAVAILABLE: original part image required');
 const path=pkg.imagePaths[item.index],file=pkg.files.find(f=>f.abs===path);if(!path||!file)throw new Error('PARTS_COMMENT_UNAVAILABLE: bound original PNG required');
 assertPartsCommentBinding(c,item,file.sha256,verdictSource(pkg).sha256);
 const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('PARTS_COMMENT_STALE_SOURCE: original PNG changed');
 validatePngCrop(c.crop);
 const original=PNG.sync.read(bytes),r=c.imageRegion;
 if(original.width!==item.w||original.height!==item.h)throw new Error('PARTS_COMMENT_IMAGE_SIZE: original dimensions differ from placement');
 if(r.width*r.height>16777216)throw new Error('PARTS_COMMENT_CROP_LIMIT: native crop exceeds 16 million pixels');
 const native=new PNG({width:r.width,height:r.height});for(let y=0;y<r.height;y++)original.data.copy(native.data,y*r.width*4,((r.y+y)*original.width+r.x)*4,((r.y+y)*original.width+r.x+r.width)*4);
 const png=PNG.sync.write(native),sha256=createHash('sha256').update(png).digest('hex'),nativeCrop={path:`comment-crops/${sha256}.png`,sha256,width:r.width,height:r.height};
 if(requireNative&&(!c.nativeCrop||Object.entries(nativeCrop).some(([key,value])=>c.nativeCrop![key as keyof typeof nativeCrop]!==value)))throw new Error('PARTS_COMMENT_NATIVE_CROP_TAMPERED: native crop differs from bound original');
 await storePngCrop(c.crop);await storePngCrop({...nativeCrop,png:'data:image/png;base64,'+png.toString('base64')});
 return {...c,nativeCrop};
}
