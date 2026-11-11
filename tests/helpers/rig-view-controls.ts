import {readFileSync} from 'node:fs';
import {createViewControls} from '../../web/view-controls.ts';

/** Run the real rig call with the caller's numeric DOM; modes stay defined only in main.ts. */
export function createRigViewControls(setView:(id:string)=>void=()=>{}) {
 const source=readFileSync(new URL('../../web/main.ts',import.meta.url),'utf8');
 const start=source.indexOf("createViewControls({layout:'rigStep1'"),end=source.indexOf('),cameraControls=',start);
 if(start<0||end<start)throw new Error('Rig control constructor boundary missing');
 const call=new Bun.Transpiler({loader:'ts'}).transformSync('return '+source.slice(start,end+1));
 return new Function('createViewControls','setView',call)(createViewControls,setView) as ReturnType<typeof createViewControls>;
}
