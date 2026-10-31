/** Original synthetic slider control over the existing strip-probe art. No delivered asset is modified. */
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function turnModel(options:{yaw?:[number,number];body?:string;noDials?:boolean}={}){
 const model=JSON.parse(await readFile(new URL('../fixtures/strip-probe/build/skeleton.model.json',import.meta.url),'utf8'));
 model.stage={x:-50,y:-32,width:100,height:64};
 const body=options.body??'body_yaw_dial',yaw=options.yaw??[-20,40];
 model.animations=[{name:'inspect',duration:1,bones:[{name:'root',timelines:[{name:'rotate',keys:[{time:0,value:0},{time:1,value:0}]}]}],slots:[],constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},attachments:[],drawOrder:[],events:[]}];
 if(!options.noDials){
  for(const name of ['yaw_dial','pitch_dial',body])model.bones.push({name,parent:'root'});
  for(const [bone,animation,min,max,target,property,factor] of [['yaw_dial','turn',...yaw,'rigid','translatex',.6],['pitch_dial','tilt',-10,10,'rigid','translatey',.8],[body,'body_turn',-6,12,'mesh','rotate',2.5]] as const){
   model.constraints.push({kind:'slider',name:bone,declaredIn:'rig',animation,bone,property:'rotate',local:true,additive:true,from:min,to:0,scale:1/(max-min),max});
   model.animations.push({name:animation,duration:1,bones:[{name:target,timelines:[{name:property,keys:[{time:0,value:min*factor},{time:1,value:max*factor}]}]}],slots:[],constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},attachments:[],drawOrder:[],events:[]});
  }
 }
 model.editorOrder.animations=model.animations.map((a:{name:string})=>a.name);return model;
}
export async function turnPackage(root:string,options:Parameters<typeof turnModel>[0]={}){
 await mkdir(root,{recursive:true});const model=await turnModel(options);
 await writeFile(join(root,'skeleton.model.json'),JSON.stringify(model));for(const name of ['rigid.png','mesh.png'])await copyFile(new URL('../fixtures/strip-probe/build/'+name,import.meta.url),join(root,name));
 await writeFile(join(root,'motion.json'),JSON.stringify({spec:'synthetic-turn-inspection-source',unchanged:true}));
 await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'turn-control',title:'Turn slider control',revision:'1',model:'skeleton.model.json',motion:'motion.json',animations:[{id:'inspect',label:'Inspect'}]}));return root;
}
