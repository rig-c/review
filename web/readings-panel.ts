/**
 * Animate · Readings (#108), page side: the pickers (Folds and Overlaps toggles; a cloth:leg pass-through pair and a
 * slot:slot seam pair from the model's slots; a bone and the bone it is read against), Run, the per-pair worst-frame
 * lines and the timeline ticks on the transport scrub — two colours, the inspected build above the scratch build — each
 * tick a button that seeks to its frame's time. The server runs `rigc render`; this draws what came back.
 */
import {readingTicks,ticksOnClip,TICK_EDGE,worstLine,type ReadingBuild,type ReadingRequest,type ReadingResult,type ReadingTick} from '../src/readings.ts';

export interface ReadingsJobView {id:string;status:'running'|'done'|'failed';error:string|null;request:{animation:string;readings:ReadingRequest[];environment:{wind:[number,number];gravity:[number,number]}|null};environment:{requested:boolean;flag:boolean;passed:boolean};compiler:{package:string;version:string};runs:{build:ReadingBuild;id:string;modelHash:string;results:ReadingResult[]}[]}
export interface ReadingsRefusal {status:'refused';error:string}
export interface ReadingsPanel {
 catalog(slots:readonly string[],bones:readonly string[]):void;
 /** The readings the pickers name, or the line saying what is missing. */
 requests():{readings:ReadingRequest[]}|{error:string};
 busy(value:boolean):void;
 status(text:string,error:boolean):void;
 /** Worst-frame lines for a finished job; each line seeks to its worst frame. */
 lines(job:ReadingsJobView|null):void;
 /** The ticks on the scrub for the drawn animation and its duration; hidden when the job's animation is not the one drawn. */
 ticks(job:ReadingsJobView|null,animation:string,duration:number):ReadingTick[];
 shownLines():string[];
}
export interface ReadingsPanelDeps {run:()=>void;seek:(animation:string,frame:number,time:number|null,label:string)=>void}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
/** The range input's thumb travels inside the track by about its own width; ticks sit under the thumb's centre. */
const THUMB=14;
export const EDGE=TICK_EDGE;

export function bindReadingsPanel(deps:ReadingsPanelDeps):ReadingsPanel {
 const folds=node<HTMLInputElement>('readings-folds'),overlaps=node<HTMLInputElement>('readings-overlaps');
 const pairs={
  pass:{on:node<HTMLInputElement>('readings-pass-on'),a:node<HTMLInputElement>('readings-pass-cloth'),b:node<HTMLInputElement>('readings-pass-leg')},
  seam:{on:node<HTMLInputElement>('readings-seam-on'),a:node<HTMLInputElement>('readings-seam-a'),b:node<HTMLInputElement>('readings-seam-b')},
  angle:{on:node<HTMLInputElement>('readings-angle-on'),a:node<HTMLInputElement>('readings-angle-bone'),b:node<HTMLInputElement>('readings-angle-relative')},
 };
 const run=node<HTMLButtonElement>('readings-run'),status=node('readings-status'),list=node('readings-worst'),strip=node('reading-ticks'),transport=node('transport'),scrub=node<HTMLInputElement>('scrub');
 let shown:string[]=[],enabled=false,isBusy=false;
 // Typing both names of a pair turns its picker on; clearing one turns it off.
 for(const pair of Object.values(pairs)){const sync=()=>{pair.on.checked=!!pair.a.value.trim()&&!!pair.b.value.trim();};pair.a.addEventListener('input',sync);pair.b.addEventListener('input',sync);}
 run.onclick=()=>deps.run();
 const setRun=()=>{run.disabled=!enabled||isBusy;};

 function requests(){
  const readings:ReadingRequest[]=[];
  if(folds.checked)readings.push({kind:'folds'});
  const pair=(p:typeof pairs.pass,what:string)=>{const a=p.a.value.trim(),b=p.b.value.trim();if(!p.on.checked)return null;if(!a||!b)return `READINGS_PAIR_INCOMPLETE: ${what} needs both names`;return [a,b] as const;};
  const pass=pair(pairs.pass,'pass-through');if(typeof pass==='string')return {error:pass};if(pass)readings.push({kind:'pass-through',cloth:pass[0],leg:pass[1]});
  const seam=pair(pairs.seam,'seam');if(typeof seam==='string')return {error:seam};if(seam)readings.push({kind:'seam',a:seam[0],b:seam[1]});
  if(overlaps.checked)readings.push({kind:'overlaps'});
  const angle=pair(pairs.angle,'angle range');if(typeof angle==='string')return {error:angle};if(angle)readings.push({kind:'angle-range',bone:angle[0],relative:angle[1]});
  return readings.length?{readings}:{error:'READINGS_NONE_CHOSEN: pick at least one reading'};
 }

 function lines(job:ReadingsJobView|null){
  list.replaceChildren();shown=[];
  if(!job)return;
  for(const run of job.runs)for(const result of run.results){
   const many=result.status==='read'&&result.items.length>1;
   const line=worstLine(run.build,result),frame=result.worst?.frame??null;
   const item=make('li',{className:`readings-line ${run.build}${result.status==='read'?'':' error'}`});
   const swatch=make('span',{className:`tick-swatch ${run.build}`});swatch.setAttribute('aria-hidden','true');
   if(frame!==null){const go=make('button',{type:'button',className:'readings-go',textContent:line,title:line});go.onclick=()=>deps.seek(job.request.animation,frame,result.fps?frame/result.fps:null,`${run.build} · ${result.label} worst`);item.append(swatch,go);}
   else item.append(swatch,make('code',{textContent:line,title:line}));
   shown.push(line);
   if(many){
    // Folds and overlaps read many meshes or pairs: each one's own worst line, folded away under the reading's.
    const details=make('details',{className:'readings-items'}),summary=make('summary',{textContent:`${result.items.length} ${result.reading.kind==='folds'?'folding meshes':'moving pairs'}`});details.append(summary);
    const inner=make('ul');for(const sub of result.items){const text=worstLine(run.build,result,sub),f=sub.worst?.frame??null;const li=make('li');if(f!==null){const go=make('button',{type:'button',className:'readings-go',textContent:text,title:text});go.onclick=()=>deps.seek(job.request.animation,f,result.fps?f/result.fps:null,`${run.build} · ${result.reading.kind} ${sub.pair} worst`);li.append(go);}else li.append(make('code',{textContent:text}));inner.append(li);}
    details.append(inner);item.append(details);
   }
   list.append(item);
  }
 }

 function ticks(job:ReadingsJobView|null,animation:string,duration:number):ReadingTick[]{
  strip.replaceChildren();
  const all=job?readingTicks(job.runs):[],visible=job?ticksOnClip(all,job.request.animation,animation,duration):[];
  strip.hidden=!visible.length;transport.classList.toggle('has-reading-ticks',!!visible.length);
  if(!visible.length)return visible;
  // Under the scrub's track: its own box inside the transport row.
  strip.style.left=`${scrub.offsetLeft+THUMB/2}px`;strip.style.width=`${Math.max(0,scrub.offsetWidth-THUMB)}px`;strip.style.top=`${scrub.offsetTop+scrub.offsetHeight}px`;
  // One button per (build, frame): the labels of every reading that lists the frame, so overlapping ticks stay one target.
  const byFrame=new Map<string,ReadingTick[]>();for(const t of visible){const key=`${t.build}:${t.frame}`;byFrame.set(key,[...(byFrame.get(key)??[]),t]);}
  for(const group of byFrame.values()){
   const first=group[0]!,label=`${first.build} · F${first.frame} · ${first.time!.toFixed(4)} s · ${group.map(t=>t.label).join(', ')}`;
   const tick=make('button',{type:'button',className:`reading-tick ${first.build}`,title:label});tick.setAttribute('aria-label',label);tick.dataset.frame=String(first.frame);tick.dataset.build=first.build;
   const at=Math.min(first.time!,duration);tick.style.left=`${(at/duration)*100}%`;tick.onclick=()=>deps.seek(job!.request.animation,first.frame,first.time,label);
   strip.append(tick);
  }
  return visible;
 }

 return {
  catalog(slots,bones){
   node('readings-slots').replaceChildren(...slots.map(s=>make('option',{value:s})));node('readings-bones').replaceChildren(...bones.map(b=>make('option',{value:b})));
   enabled=true;setRun();
  },
  requests,
  busy(value){isBusy=value;setRun();run.textContent=value?'Running…':'Run readings';},
  status(text,error){status.textContent=text;status.title=text;status.classList.toggle('error',error);},
  lines,ticks,shownLines:()=>[...shown],
 };
}
