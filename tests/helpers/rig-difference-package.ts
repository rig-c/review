import {mkdir,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PNG} from 'pngjs';

/** Small public compiler inputs; no private painting, old producer bench or binary fixture. */
export async function writeRigDifferencePackages(root:string) {
 const source=join(root,'source');await mkdir(join(source,'images'),{recursive:true});
 const image=new PNG({width:16,height:16});for(let i=0;i<256;i++)image.data.set([220,50,40,255],i*4);
 await writeFile(join(source,'images/body.png'),PNG.sync.write(image));
 const rig={spec:'rigc-rig/1',name:'difference-gate',images:'images',skeleton:{width:64,height:64},bones:[{name:'root'},{name:'body',parent:'root',x:4,y:0}],slots:[{name:'body',bone:'body',attachment:'body'}],skins:{default:{body:{body:{type:'region',path:'body',image:'body.png',width:16,height:16}}}}};
 const motion={spec:'rigc-motion/1',archetype:'difference-gate',cut:'gate',easings:{},animations:{idle:{duration:1,loop:false,tracks:[{bone:'root',property:'translatex',keys:[{t:0,v:[0]},{t:1,v:[0]}]}]}}};
 await writeFile(join(source,'rig.json'),JSON.stringify(rig));await writeFile(join(source,'motion.json'),JSON.stringify(motion));
 const child=Bun.spawn(['bun',resolve('node_modules/@rig-c/core/bin/rigc.cjs'),'build','--rig',join(source,'rig.json'),'--motion',join(source,'motion.json'),'--out',join(source,'build'),'--copy-images','--profile','spine','--report',join(source,'gate.json')],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(exit!==0)throw Error('RIG_DIFFERENCE_FIXTURE_COMPILE '+exit+' '+stdout+stderr);
 const result={reference:'',wind:'',mismatch:''};
 for(const [kind,size] of [['reference',64],['wind',0],['mismatch',32]] as const){
  const dir=join(root,kind);await mkdir(dir,{recursive:true});await cp(join(source,'build'),join(dir,'build'),{recursive:true});
  const references:{id:string;label:string;type:'image';path:string}[]=[];
  if(size){const painting=new PNG({width:size,height:size});for(let i=0;i<size*size;i++)painting.data.set([40,60,210,255],i*4);await writeFile(join(dir,'painting.png'),PNG.sync.write(painting));references.push({id:'painting',label:'Original painting',type:'image',path:'painting.png'});}
  const file=join(dir,'review.json');await writeFile(file,JSON.stringify({schema:'rig-review/1',id:'difference-'+kind,title:'Synthetic difference '+kind,revision:'1',model:'build/skeleton.model.json',references,animations:[{id:'idle'}]}));result[kind]=file;
 }
 return result;
}
