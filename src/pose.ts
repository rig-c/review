/** The canonical source-pose boundary; no retargeting or invented observations. */
export function validatePoseSequence(input:unknown,label:string):void {
  const fail=(field:string,expectation:string):never=>{throw new Error(`${label} ${field}: expected ${expectation}`);};
  const obj=(v:unknown,f:string):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail(f,'object');return v as Record<string,unknown>;};
  const finite=(v:unknown,f:string):number=>{if(typeof v!=='number'||!Number.isFinite(v))return fail(f,'finite number');return v;};
  const seq=obj(input,'sequence');if(seq.spec!=='rig-pose-sequence/1')fail('spec','rig-pose-sequence/1');
  const space=obj(seq.space,'space');if(space.units!=='picture-px'||space.origin!=='top-left'||space.y!=='down')fail('space','picture-px, top-left, y down');
  if(finite(seq.width,'width')<=0||finite(seq.height,'height')<=0)fail('dimensions','positive width and height');
  if(!Array.isArray(seq.frames)||!seq.frames.length)fail('frames','nonempty frame array');
  let previous=-Infinity;
  for(const [index,raw] of (seq.frames as unknown[]).entries()){
    const frame=obj(raw,`frames[${index}]`);const t=finite(frame.t,`frames[${index}].t`);if(t<=previous)fail(`frames[${index}].t`,'strictly increasing time in seconds');previous=t;
    if(!Array.isArray(frame.people))fail(`frames[${index}].people`,'array');const ids=new Set<string>();
    for(const personRaw of frame.people as unknown[]){const person=obj(personRaw,'person');const personId=typeof person.id==='string'&&person.id?person.id:fail('person.id','nonempty string');if(ids.has(personId))fail('person.id','unique string per frame');ids.add(personId);const joints=obj(person.joints,'joints');
      for(const [name,jointRaw] of Object.entries(joints)){const joint=obj(jointRaw,`joint ${name}`);if(!['observed','occluded','missing','inferred'].includes(String(joint.state)))fail(`joint ${name}.state`,'observed | occluded | missing | inferred');
        if(joint.at!==undefined){const at=Array.isArray(joint.at)?joint.at:fail(`joint ${name}.at`,'[x,y]');if(at.length!==2)fail(`joint ${name}.at`,'[x,y]');finite(at[0],`joint ${name}.at[0]`);finite(at[1],`joint ${name}.at[1]`);}else if(joint.state==='inferred')fail(`joint ${name}.at`,'[x,y] for inferred joint');
        if(joint.score!==undefined)finite(joint.score,`joint ${name}.score`);
      }
    }
  }
  if(seq.camera!==undefined){
    if(!Array.isArray(seq.camera)||seq.camera.length!==(seq.frames as unknown[]).length)fail('camera','one camera entry per frame');
    for(const [index,item] of (seq.camera as unknown[]).entries()){const c=obj(item,`camera[${index}]`);if(finite(c.s,'camera.s')<=0)fail('camera.s','positive scale');finite(c.tx,'camera.tx');finite(c.ty,'camera.ty');const inliers=finite(c.inliers,'camera.inliers');if(!Number.isInteger(inliers)||inliers<0)fail('camera.inliers','integer >= 0');}
  }
  if(seq.travel!==undefined&&seq.travel!=='in-place')fail('travel','in-place');
  if(seq.cameraSource!==undefined&&(typeof seq.cameraSource!=='string'||!seq.cameraSource.trim()||seq.camera===undefined))fail('cameraSource','nonempty string with camera array');
}
