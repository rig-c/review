/**
 * Animate · Retarget (#114), page side: a `rig-pose-map/1` editor — per chain, include it and pick the rig bone that
 * carries each segment (and its bend), the translated bone and its scale points — the clean and retarget flags as typed
 * controls, the declared pose sequence to read, then Apply · Retarget. The server runs the installed `rig-pose clean`,
 * `rig-pose retarget` and the compile into scratch; this draws what came back: the producer's lines (every refusal
 * verbatim) and the run's FEET / STANCE / FLIP / SHORT / END-ON / LEG-SCALE / REACH lines, each a button that seeks to
 * its frame. The map starts from a loaded `rig-pose-map/1` file (read in the page, sent by content) or the body-18
 * chains with no bone picked. Review authors no keys: the motion is the producer's.
 */
import {DEFAULT_CLEAN,DEFAULT_FLAGS,POSE_MAP_SCHEMA,type RetargetFlags,type RetargetLine} from '../src/retarget.ts';
import type {RetargetJobView,RetargetStatusView,RebuildRefusal} from './rebuild-client.ts';

type Chain={name:string;bones:string[];joints:string[];bend?:string;[key:string]:unknown};
export type PoseMap={spec:typeof POSE_MAP_SCHEMA;chains:Chain[];translate?:{bone:string;joint:string;scale?:{pose:[string,string];rig:[string,string]}};[key:string]:unknown};
/** The body-18 chains a front-facing figure maps (README, "The map"), no bone picked: the editor's start without a map file. */
export function templateMap():PoseMap {
 return {spec:POSE_MAP_SCHEMA,chains:[
  {name:'trunk',bones:[''],joints:['mid_hip','neck'],aim:['neck']},
  {name:'arm_r',bones:['',''],joints:['r_shoulder','r_elbow','r_wrist'],bend:'free'},
  {name:'arm_l',bones:['',''],joints:['l_shoulder','l_elbow','l_wrist'],bend:'free'},
  {name:'leg_r',bones:['',''],joints:['r_hip','r_knee','r_ankle'],bend:'free'},
  {name:'leg_l',bones:['',''],joints:['l_hip','l_knee','l_ankle'],bend:'free'},
 ],translate:{bone:'',joint:'mid_hip',scale:{pose:['mid_hip','neck'],rig:['','']}}};
}
/** A bone not yet picked, refused before anything is sent; whether a picked bone is the rig's is the producer's to say. */
export function mapPrecheck(map:PoseMap):string|null {
 if(!map.chains.length)return 'RETARGET_MAP_INCOMPLETE: no chain is included';
 for(const c of map.chains){const i=c.bones.findIndex(b=>!b);if(i>=0)return `RETARGET_MAP_INCOMPLETE: chain "${c.name}" bone ${i+1} (${c.joints[i]} → ${c.joints[i+1]??'?'}) is not picked`;}
 if(map.translate&&!map.translate.bone)return 'RETARGET_MAP_INCOMPLETE: the translated bone is not picked';
 if(map.translate?.scale&&map.translate.scale.rig.some(b=>!b))return 'RETARGET_MAP_INCOMPLETE: the translate scale\'s rig points are not picked';
 return null;
}
/** A document read from a file or the JSON field: a `rig-pose-map/1` with chains, else the line saying why not. */
export function readMap(text:string):{map:PoseMap}|{error:string} {
 let value:unknown;try{value=JSON.parse(text);}catch(error){return {error:`RETARGET_MAP_INVALID: ${error instanceof Error?error.message:String(error)}`};}
 const v=value as PoseMap;
 if(!v||typeof v!=='object'||v.spec!==POSE_MAP_SCHEMA||!Array.isArray(v.chains)||!v.chains.every(c=>c&&typeof c.name==='string'&&Array.isArray(c.bones)&&Array.isArray(c.joints)))return {error:`RETARGET_MAP_INVALID: expected a ${POSE_MAP_SCHEMA} document with chains of {name, bones, joints}`};
 return {map:JSON.parse(JSON.stringify(v)) as PoseMap};
}

export interface RetargetPanelDeps {
 apply:(body:{sequence:string;map:PoseMap;flags:RetargetFlags})=>Promise<RetargetJobView|RebuildRefusal|null>;
 reset:()=>void;
 seek:(animation:string,frame:number,time:number|null,label:string)=>void;
}
export interface RetargetPanel {
 load(status:RetargetStatusView|null,reason:string|null):void;
 map():PoseMap;setMap(map:PoseMap):void;
 /** Include or leave out a chain by name. */
 include(chain:string,on:boolean):void;
 pick(chain:string,index:number,bone:string):void;
 flags():RetargetFlags|{error:string};setFlags(flags:Partial<RetargetFlags>):void;
 sequence():string;
 busy(value:boolean):void;
 status(text:string,error:boolean):void;
 line(text:string):void;
 result(job:RetargetJobView|RebuildRefusal|null):void;
 shownLines():string[];
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
// A checkbox reads after its box; a field after its name.
const labelled=(text:string,control:HTMLElement)=>control instanceof HTMLInputElement&&control.type==='checkbox'?make('label',{},control,text):make('label',{},text,control);
const numberInput=(id:string,value:number,step:string,label:string)=>{const n=make('input',{id,type:'number',step,value:String(value)});n.setAttribute('aria-label',label);return n;};
const checkbox=(id:string,checked=false)=>make('input',{id,type:'checkbox',checked});

export function bindRetargetPanel(deps:RetargetPanelDeps):RetargetPanel {
 const body=node('retarget-body');
 let status:RetargetStatusView|null=null,entries:{chain:Chain;on:boolean}[]=[],rest:Omit<PoseMap,'chains'>={spec:POSE_MAP_SCHEMA},shown:string[]=[],isBusy=false;
 const log:string[]=[];
 // Controls.
 const sequence=make('select',{id:'retarget-sequence'});sequence.setAttribute('aria-label','Pose sequence');
 const person=make('select',{id:'retarget-person'});person.setAttribute('aria-label','Person');
 const template=make('button',{type:'button',textContent:'Body-18 chains'}),file=make('input',{id:'retarget-map-file',type:'file',accept:'.json,application/json'});file.setAttribute('aria-label','Load a rig-pose-map/1 file');
 const chains=make('div',{id:'retarget-chains',className:'retarget-chains'}),translate=make('div',{id:'retarget-translate',className:'row retarget-translate'});
 const json=make('textarea',{id:'retarget-map-json',rows:8,spellcheck:false}),useJson=make('button',{type:'button',textContent:'Use this JSON'});json.setAttribute('aria-label','Map JSON');
 const clean=checkbox('retarget-clean',true),loop=checkbox('retarget-loop'),legs=numberInput('retarget-legs',DEFAULT_CLEAN.legs,'2','clean legs window'),restWin=numberInput('retarget-rest',DEFAULT_CLEAN.rest,'2','clean rest window'),hold=checkbox('retarget-hold',true),hips=checkbox('retarget-hips-inferred');
 const animation=make('input',{id:'retarget-animation',type:'text',value:DEFAULT_FLAGS.animation,autocomplete:'off'});animation.setAttribute('aria-label','New animation name');
 const opt=(id:string,value:number,step:string,label:string)=>({on:checkbox(`${id}-on`),value:numberInput(id,value,step,label)});
 const minScore=opt('retarget-min-score',0.3,'0.05','min score'),flip=opt('retarget-flip',90,'1','flip degrees'),short=opt('retarget-short',0.35,'0.05','short fraction'),tolerance=opt('retarget-bend-tolerance',0,'1','bend tolerance degrees'),stance=opt('retarget-stance',0.07,'0.01','stance leg lengths');
 const bends=make('select',{id:'retarget-bends'},make('option',{value:'refuse',textContent:'refuse'}),make('option',{value:'clamp',textContent:'clamp'}));bends.setAttribute('aria-label','Wrong-way bends');
 const legScale={on:checkbox('retarget-leg-scale-on'),min:numberInput('retarget-leg-scale-min',0.8,'0.01','leg scale min'),max:numberInput('retarget-leg-scale-max',1.05,'0.01','leg scale max')};
 const plant=checkbox('retarget-plant-feet'),raised=checkbox('retarget-raised-by-head'),carry=checkbox('retarget-carry-idle');
 const apply=make('button',{id:'retarget-apply',type:'button',className:'primary',textContent:'Apply · Retarget',disabled:true}),reset=make('button',{id:'retarget-reset',type:'button',textContent:'Reset'});
 const statusLine=make('p',{id:'retarget-status',className:'hint'});statusLine.setAttribute('aria-live','polite');
 const logView=make('pre',{id:'retarget-log',className:'retarget-log',hidden:true}),refusals=make('ul',{id:'retarget-refusals',className:'requirements-refusals'}),readings=make('ul',{id:'retarget-lines',className:'readings-worst'});readings.setAttribute('aria-label','Retarget lines');
 body.append(
  make('div',{className:'row'},labelled('Sequence',sequence),labelled('Person',person)),
  make('div',{className:'row'},make('span',{className:'eyebrow',textContent:'MAP · rig-pose-map/1'}),template,file),
  chains,translate,
  make('details',{className:'retarget-json'},make('summary',{textContent:'Map JSON (aims, ranges, alternates…)'}),json,make('div',{className:'row'},useJson)),
  make('div',{className:'row'},make('span',{className:'eyebrow',textContent:'CLEAN'}),labelled('clean first',clean),labelled('loop',loop),labelled('legs',legs),labelled('rest',restWin),labelled('hold',hold),labelled('hips inferred',hips)),
  make('div',{className:'row'},make('span',{className:'eyebrow',textContent:'RETARGET'}),labelled('as',animation)),
  make('div',{className:'row'},labelled('flip °',flip.on),flip.value,labelled('short',short.on),short.value,labelled('min score',minScore.on),minScore.value),
  make('div',{className:'row'},labelled('bends',bends),labelled('tolerance °',tolerance.on),tolerance.value,labelled('leg scale',legScale.on),legScale.min,legScale.max),
  make('div',{className:'row'},labelled('plant feet',plant),labelled('stance',stance.on),stance.value,labelled('raised by head',raised),labelled('carry idle',carry)),
  make('div',{className:'row'},apply,reset),statusLine,refusals,logView,readings,
 );

 const bonesOf=()=>status?.bones??[];
 const boneSelect=(value:string,label:string,change:(v:string)=>void)=>{
  const s=make('select');s.setAttribute('aria-label',label);
  const names=bonesOf(),options=[make('option',{value:'',textContent:'— pick a bone —'}),...names.map(n=>make('option',{value:n,textContent:n}))];
  // A bone the map names that the rig lacks stays visible: Apply sends it and the producer refuses it by name.
  if(value&&!names.includes(value))options.push(make('option',{value,textContent:`${value} (not in the rig)`}));
  s.append(...options);s.value=value;s.onchange=()=>change(s.value);return s;
 };
 const map=():PoseMap=>({...JSON.parse(JSON.stringify(rest)),chains:entries.filter(e=>e.on).map(e=>JSON.parse(JSON.stringify(e.chain)))}) as PoseMap;
 function render(){
  chains.replaceChildren(...entries.map((e,ci)=>{
   const on=checkbox(`retarget-chain-${ci}`,e.on);on.onchange=()=>{e.on=on.checked;render();};
   const row=make('div',{className:`retarget-chain${e.on?'':' off'}`},labelled(e.chain.name,on));
   e.chain.bones.forEach((bone,bi)=>{row.append(make('code',{textContent:`${e.chain.joints[bi]??'?'}→${e.chain.joints[bi+1]??'?'}`}),boneSelect(bone,`${e.chain.name} bone ${bi+1}`,v=>{e.chain.bones[bi]=v;render();}));});
   const bend=make('select',{},...['','rest','free','ccw','cw'].map(v=>make('option',{value:v,textContent:v||'bend: rest (default)'})));bend.setAttribute('aria-label',`${e.chain.name} bend`);bend.value=typeof e.chain.bend==='string'?e.chain.bend:'';bend.onchange=()=>{if(bend.value)e.chain.bend=bend.value;else delete e.chain.bend;render();};
   row.append(bend);return row;
  }));
  translate.replaceChildren();
  const t=rest.translate as PoseMap['translate'];
  if(t){
   translate.append(make('span',{textContent:`translate ${t.joint} →`}),boneSelect(t.bone,'translated bone',v=>{t.bone=v;render();}));
   if(t.scale){translate.append(make('span',{textContent:`scale ${t.scale.pose.join('→')} =`}));t.scale.rig.forEach((b,i)=>translate.append(boneSelect(b,`scale rig point ${i+1}`,v=>{t.scale!.rig[i]=v;render();})));}
  }
  if(document.activeElement!==json)json.value=JSON.stringify(map(),null,1);
  syncApply();
 }
 function setMap(next:PoseMap){const {chains:list,...others}=JSON.parse(JSON.stringify(next)) as PoseMap;rest=others;entries=list.map(chain=>({chain,on:true}));render();}
 function syncApply(){apply.disabled=isBusy||!status?.available||!sequence.value;}
 function people(){const s=status?.sequences.find(x=>x.id===sequence.value);person.replaceChildren(make('option',{value:'',textContent:s&&s.people.length>1?'— pick —':'(the one person)'}),...(s?.people??[]).map(p=>make('option',{value:p,textContent:p})));}
 const say=(text:string,error:boolean)=>{statusLine.textContent=text;statusLine.title=text;statusLine.classList.toggle('error',error);};

 template.onclick=()=>setMap(templateMap());
 file.onchange=()=>{const f=file.files?.[0];if(!f)return;void f.text().then(text=>{const read=readMap(text);if('error' in read)say(read.error,true);else{setMap(read.map);say(`Map loaded from ${f.name} (by content; nothing is sent until Apply).`,false);}file.value='';});};
 useJson.onclick=()=>{const read=readMap(json.value);if('error' in read)say(read.error,true);else{setMap(read.map);say('Map taken from the JSON field.',false);}};
 // #186: `clean first` follows the selected sequence whenever the selection changes — on for a raw one (the producer
 // refuses an uncleaned sequence, POSE_NOT_CLEANED), off for one already cleaned. A reload that keeps the selection keeps
 // the reviewer's own choice.
 let cleanFor:string|null=null;
 function deriveClean(){const id=sequence.value;if(id===cleanFor)return;cleanFor=id;const s=status?.sequences.find(x=>x.id===id);if(s)clean.checked=!s.cleaned;}
 sequence.onchange=()=>{deriveClean();people();syncApply();};
 reset.onclick=()=>deps.reset();

 function flags():RetargetFlags|{error:string}{
  const n=(input:HTMLInputElement,what:string)=>{const v=Number(input.value);return input.value.trim()&&Number.isFinite(v)?v:null;};
  const optional=(o:{on:HTMLInputElement;value:HTMLInputElement},what:string):number|null|{error:string}=>{if(!o.on.checked)return null;const v=n(o.value,what);return v===null?{error:`RETARGET_FLAG_INCOMPLETE: ${what}`}:v;};
  const name=animation.value.trim();if(!name)return {error:'RETARGET_FLAG_INCOMPLETE: name the new animation'};
  const values:Record<string,number|null>={};
  for(const [key,o,what] of [['minScore',minScore,'min score'],['flip',flip,'flip degrees'],['short',short,'short fraction'],['bendTolerance',tolerance,'bend tolerance'],['stance',stance,'stance']] as const){const v=optional(o,what);if(v&&typeof v==='object')return v;values[key]=v;}
  const lmin=n(legScale.min,'leg scale min'),lmax=n(legScale.max,'leg scale max');
  if(legScale.on.checked&&(lmin===null||lmax===null))return {error:'RETARGET_FLAG_INCOMPLETE: leg scale min and max'};
  const l=n(legs,'legs'),r=n(restWin,'rest');if(clean.checked&&(l===null||r===null))return {error:'RETARGET_FLAG_INCOMPLETE: clean windows'};
  return {animation:name,person:person.value||null,clean:clean.checked?{loop:loop.checked,legs:l!,rest:r!,hold:hold.checked,hipsInferred:hips.checked}:null,
   minScore:values.minScore??null,flip:values.flip??null,short:values.short??null,bends:bends.value as 'refuse'|'clamp',bendTolerance:values.bendTolerance??null,
   legScale:legScale.on.checked?[lmin!,lmax!]:null,plantFeet:plant.checked,stance:values.stance??null,raisedByHead:raised.checked,carryIdle:carry.checked};
 }
 function setFlags(f:Partial<RetargetFlags>){
  if(f.animation!==undefined)animation.value=f.animation;
  if(f.person!==undefined)person.value=f.person??'';
  if(f.clean!==undefined){clean.checked=!!f.clean;if(f.clean){loop.checked=f.clean.loop;legs.value=String(f.clean.legs);restWin.value=String(f.clean.rest);hold.checked=f.clean.hold;hips.checked=f.clean.hipsInferred;}}
  for(const [key,o] of [['minScore',minScore],['flip',flip],['short',short],['bendTolerance',tolerance],['stance',stance]] as const){const v=f[key];if(v===undefined)continue;o.on.checked=v!==null;if(v!==null)o.value.value=String(v);}
  if(f.bends)bends.value=f.bends;
  if(f.legScale!==undefined){legScale.on.checked=!!f.legScale;if(f.legScale){legScale.min.value=String(f.legScale[0]);legScale.max.value=String(f.legScale[1]);}}
  if(f.plantFeet!==undefined)plant.checked=f.plantFeet;if(f.raisedByHead!==undefined)raised.checked=f.raisedByHead;if(f.carryIdle!==undefined)carry.checked=f.carryIdle;
 }

 apply.onclick=()=>{
  const m=map(),problem=mapPrecheck(m);if(problem){say(`${problem} (review pre-check; nothing sent)`,true);return;}
  const f=flags();if('error' in f){say(`${f.error} (review pre-check; nothing sent)`,true);return;}
  log.length=0;logView.textContent='';logView.hidden=true;
  void deps.apply({sequence:sequence.value,map:m,flags:f});
 };

 function lineItem(r:RetargetLine,animationName:string){
  const item=make('li',{className:'readings-line scratch'}),swatch=make('span',{className:'tick-swatch scratch'});swatch.setAttribute('aria-hidden','true');
  if(r.frame!==null){const go=make('button',{type:'button',className:'readings-go',textContent:r.line,title:r.line});go.onclick=()=>deps.seek(animationName,r.frame!,r.time,`${r.code} F${r.frame}`);item.append(swatch,go);}
  else item.append(swatch,make('code',{textContent:r.line,title:r.line}));
  return item;
 }
 return {
  load(next,reason){
   status=next;const prior=sequence.value;
   sequence.replaceChildren(...(next?.sequences??[]).map(s=>make('option',{value:s.id,textContent:`${s.label} · ${s.frames} frame(s) · ${s.cleaned?'cleaned':'raw'}`})));
   if(prior&&next?.sequences.some(s=>s.id===prior))sequence.value=prior;
   deriveClean();
   people();if(!entries.length)setMap(templateMap());else render();
   say(next?.available?`${next.producer?.package} ${next.producer?.version} with ${next.compiler?.package} ${next.compiler?.version} on the handoff rig${next.rig?` (${next.rig})`:''} · ${next.bones.length} bone(s), animations ${next.animations.join(', ')||'none'}`:(next?.reason??reason??'RETARGET_UNAVAILABLE'),!next?.available);
   syncApply();
  },
  map,setMap,
  include(name,on){const e=entries.find(x=>x.chain.name===name);if(e){e.on=on;render();}},
  pick(name,index,bone){const e=entries.find(x=>x.chain.name===name);if(e&&index>=0&&index<e.chain.bones.length){e.chain.bones[index]=bone;render();}},
  flags,setFlags,sequence:()=>sequence.value,
  busy(value){isBusy=value;apply.textContent=value?'Retargeting…':'Apply · Retarget';syncApply();},
  status:say,
  line(text){log.push(text);logView.hidden=false;logView.textContent=log.slice(-12).join('\n');},
  result(job){
   refusals.replaceChildren();readings.replaceChildren();shown=[];
   if(!job)return;
   if(!('id' in job)){refusals.append(make('li',{},make('code',{textContent:job.producerLine??job.error})));return;}
   for(const line of job.refusals??[])refusals.append(make('li',{},make('code',{textContent:line})));
   if(job.status!=='built')return;
   const name=job.request.record.flags.animation;
   for(const r of job.readings){readings.append(lineItem(r,name));shown.push(r.line);}
   if(!job.readings.length)readings.append(make('li',{className:'hint',textContent:'No FEET / STANCE / FLIP / SHORT / END-ON / LEG-SCALE / REACH line in this run (FEET needs both legs mapped; FLIP and SHORT their flags).'}));
  },
  shownLines:()=>[...shown],
 };
}
