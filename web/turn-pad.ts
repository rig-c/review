import {TurnState,type TurnDial,type TurnSnapshot,type TurnAxis,pointerPosition} from '../src/turn-pad.ts';
export interface TurnPad {state:TurnState;snapshot():TurnSnapshot;restore(value:unknown):void;dispose():void}
/** One pad owns the shared values. It never touches the model document or writes animation keys. */
export function bindTurnPad(options:{host:HTMLElement;stages:HTMLElement[];dials:readonly TurnDial[];draw:(state:TurnState)=>void;save:()=>void;blocked?:()=>boolean;error:(text:string)=>void}):TurnPad|null {
 const {host,stages,dials}=options;if(!dials.length)return null;
 const state=new TurnState(dials),panel=document.createElement('section');panel.id='turn-pad';panel.className='turn-pad';panel.setAttribute('aria-label','Turn pad');
 const title=document.createElement('strong');title.textContent='Turn pad';panel.append(title);
 const hint=document.createElement('span');hint.textContent='Move over the rig · left/right yaw and body · up/down pitch';panel.append(hint);
 const hold=document.createElement('button');hold.type='button';hold.textContent='Hold';hold.setAttribute('aria-pressed','false');panel.append(hold);
 const reset=document.createElement('button');reset.type='button';reset.textContent='Reset 0';panel.append(reset);
 const smoothLabel=document.createElement('label'),smooth=document.createElement('input');smooth.type='checkbox';smooth.checked=true;smooth.setAttribute('aria-label','Turn smoothing');smoothLabel.append(smooth,' Smoothing ω₀ ');
 const omega=document.createElement('input');omega.type='number';omega.min='1';omega.max='100';omega.step='1';omega.value='20';omega.setAttribute('aria-label','Turn smoothing omega');smoothLabel.append(omega,' s⁻¹');panel.append(smoothLabel);
 const rows=new Map<TurnAxis,{number:HTMLInputElement;output:HTMLOutputElement;target:HTMLOutputElement}>();
 for(const d of dials){const label=document.createElement('label');label.textContent=`${d.axis} · ${d.bone} [${d.min}, ${d.max}] ${d.channel==='rotation'?'°':d.channel}`;const number=document.createElement('input');number.type='number';number.min=String(d.min);number.max=String(d.max);number.step='any';number.value='0';number.setAttribute('aria-label',`Turn ${d.axis} value`);label.title=d.provenance??'';const output=document.createElement('output');output.dataset.turnAxis=d.axis;output.setAttribute('aria-label',`Current ${d.axis}`);const target=document.createElement('output');target.dataset.turnTarget=d.axis;label.append(number,' Applied ',output,' · target ',target);panel.append(label);rows.set(d.axis,{number,output,target});number.onchange=()=>{try{if(!number.value.trim())throw new Error('TURN_VALUE_REQUIRED');state.exact(d.axis,Number(number.value));commit();}catch(error){options.error(String(error));render();}};}
 function render():void {hold.setAttribute('aria-pressed',String(state.held));smooth.checked=state.smoothing!==0;omega.disabled=!smooth.checked;if(state.smoothing)omega.value=String(state.smoothing);for(const [axis,row] of rows){const value=state.values[axis]!;row.output.value=String(Number(value.toFixed(6)));row.output.dataset.value=String(value);row.target.value=String(Number(state.targets[axis]!.toFixed(6)));if(document.activeElement!==row.number)row.number.value=String(state.targets[axis]);}}
 let saveTimer:ReturnType<typeof setTimeout>|undefined;
 function commit():void {options.draw(state);render();if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(options.save,150);}
 hold.onclick=()=>{state.hold(!state.held);commit();};reset.onclick=()=>{state.reset();commit();};
 smooth.onchange=()=>{state.smoothing=smooth.checked?Number(omega.value)||20:0;commit();};omega.onchange=()=>{const v=Number(omega.value);if(!Number.isFinite(v)||v<1||v>100){options.error('TURN_SMOOTHING_RANGE: use 1…100 s⁻¹');omega.value=String(state.smoothing||20);return;}state.smoothing=v;commit();};
 const move=(event:PointerEvent)=>{if(event.buttons||options.blocked?.()||state.held)return;const stage=event.currentTarget as HTMLElement;const rect=stage.getBoundingClientRect();const [x,y]=pointerPosition(event.clientX,event.clientY,{left:rect.left,top:rect.top,width:Math.max(1,rect.width-1),height:Math.max(1,rect.height-1)});state.pointer(x,y);if(state.smoothing===0){if(state.step(0))commit();else render();}else render();};
 for(const stage of stages)stage.addEventListener('pointermove',move);
 let disposed=false,last=0,raf=0;
 const step=(now:number)=>{if(disposed)return;if(!document.hidden&&!options.blocked?.()&&state.step(last?Math.min((now-last)/1000,.1):0))commit();last=now;raf=requestAnimationFrame(step);};
 host.append(panel);commit();raf=requestAnimationFrame(step);
 return {state,snapshot:()=>state.snapshot(),restore(value){state.restore(value);commit();},dispose(){disposed=true;if(saveTimer)clearTimeout(saveTimer);cancelAnimationFrame(raf);for(const stage of stages)stage.removeEventListener('pointermove',move);panel.remove();}};
}
