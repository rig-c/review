import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {discoverTurnDials,sharedTurnDials,normalizedDial,pointerPosition,springStep,TurnState,parseTurnSnapshot,turnDialPrecision,turnDialWidthCh,formatTurnValue,type TurnDial} from '../src/turn-pad.ts';
import {bindTurnPad} from '../web/turn-pad.ts';

const slider=(bone:string,animation='turn',more={})=>({kind:'slider',name:bone,bone,animation,property:'rotate',local:true,from:-15,to:0,scale:1/30,...more});
const model=(constraints:unknown[])=>({bones:['yaw_dial','pitch_dial','body_yaw_dial','custom'].map(name=>({name})),constraints,animations:[{name:'turn',duration:1},{name:'body_turn',duration:1}]});
test('discovers actual local sliders, asymmetric ranges, reverse scale and a custom body dial from its compiled body_turn',()=>{
 const d=discoverTurnDials(model([slider('yaw_dial'),slider('pitch_dial','turn',{from:10,scale:-.1}),slider('custom','body_turn')]));
 expect(d.map(x=>[x.axis,x.bone,x.min,x.max])).toEqual([['yaw','yaw_dial',-15,15],['pitch','pitch_dial',0,10],['body','custom',-15,15]]);
 expect(normalizedDial(0,{min:-10,max:30})).toBe(0);expect(normalizedDial(-1,{min:-10,max:30})).toBe(-10);expect(normalizedDial(1,{min:-10,max:30})).toBe(30);
});
test('no declared dial, ambiguous/looping/world/constant slider: no invented controls',()=>{
 expect(discoverTurnDials(model([]))).toEqual([]);
 for(const constraints of [[slider('yaw_dial'),slider('yaw_dial')],[slider('yaw_dial','turn',{loop:true})],[slider('yaw_dial','turn',{local:false})],[slider('yaw_dial','turn',{scale:0})]])expect(discoverTurnDials(model(constraints))).toEqual([]);
});
test('pointer spans five positions and clamps outside the actual stage rectangle',()=>{
 const rect={left:10,top:20,width:200,height:100};
 expect([[10,120],[60,95],[110,70],[160,45],[210,20]].map(([x,y])=>pointerPosition(x!,y!,rect))).toEqual([[-1,-1],[-.5,-.5],[0,0],[.5,.5],[1,1]]);
 expect(pointerPosition(-20,200,rect)).toEqual([-1,-1]);
});
test('demo critically damped spring: analytic literal; subdivision and zero dt',()=>{
 const s={x:0,v:0};springStep(s,1,.05,20);expect(s.x).toBeCloseTo(1-2/Math.E,14);expect(s.v).toBeCloseTo(20/Math.E,14);
 const split={x:0,v:0};for(let i=0;i<5;i++)springStep(split,1,.01,20);expect(split.x).toBeCloseTo(s.x,14);springStep(split,5,0,20);expect(split.x).toBeCloseTo(s.x,14);
});
test('shared values use the common range; absent axes are never applied to another pane',()=>{
 const a=discoverTurnDials(model([slider('yaw_dial'),slider('pitch_dial')])),b=discoverTurnDials(model([slider('yaw_dial','turn',{from:-5,scale:.1})]));
 expect(sharedTurnDials(a,b).map(d=>[d.axis,d.min,d.max])).toEqual([['yaw',-5,5]]);
});
test('exact entry holds, reset is exact zero, snapshot copies, restoration validates the current model',()=>{
 const state=new TurnState(discoverTurnDials(model([slider('yaw_dial')])));state.pointer(-1,0);state.step(.05);expect(state.values.yaw).toBeLessThan(0);state.exact('yaw',7.125);state.pointer(-1,0);state.step(1);expect(state.values.yaw).toBe(7.125);expect(state.held).toBe(true);
 const snapshot=state.snapshot();snapshot.values.yaw=100;expect(state.values.yaw).toBe(7.125);expect(()=>state.restore(snapshot)).toThrow();expect(()=>parseTurnSnapshot({schema:'rig-review-turn/1',values:{yaw:Infinity},held:true,smoothing:20})).toThrow();state.reset();expect(state.values.yaw).toBe(0);
});

test('#289: reserved width derives from each dial range and precision, keeps exact values on number/dataset, and planted unreserved mutant fails',async()=>{
 const ranges=[
  {axis:'yaw' as const,bone:'yaw_dial',slider:'yaw_dial',channel:'rotation' as const,min:-15,max:15},
  {axis:'pitch' as const,bone:'pitch_dial',slider:'pitch_dial',channel:'rotation' as const,min:0,max:10},
  {axis:'body' as const,bone:'body_yaw_dial',slider:'body_yaw_dial',channel:'rotation' as const,min:-120,max:45},
 ];
 expect(ranges.map(d=>turnDialWidthCh(d))).toEqual([6,5,7]);
 expect(turnDialPrecision({min:-0.25,max:0.25})).toBe(3);
 expect(turnDialWidthCh({min:-0.25,max:0.25})).toBe(6);
 expect(()=>turnDialWidthCh({min:10,max:10})).toThrow('TURN_RANGE_INVALID');
 expect(()=>turnDialPrecision({min:-10,max:10},9)).toThrow('TURN_PRECISION_INVALID');

 for(const d of [...ranges,{axis:'yaw' as const,bone:'yaw_dial',slider:'yaw_dial',channel:'x' as const,min:-0.25,max:0.25}]){
  const reserved=turnDialWidthCh(d);
  for(let i=0;i<=40;i++){
   const v=d.min+(d.max-d.min)*(i/40);
   const text=formatTurnValue(v,d);
   expect(text.length).toBeLessThanOrEqual(reserved);
   expect(text).not.toBe('-0');
  }
 }

 for(const file of ['styles.css','compare.css']){
  const css=await readFile(new URL('../web/'+file,import.meta.url),'utf8');
  const rules=[...css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1]!.trim()==='.turn-pad output').map(m=>m[2]!);
  expect(rules).toHaveLength(1);
  expect(rules[0]).toContain('display:inline-block');
  expect(rules[0]).toContain('font-family:var(--font-mono)');
  expect(rules[0]).toContain('font-variant-numeric:tabular-nums');
  expect(rules[0]).toContain('text-align:right');
 }

 const padSource=await readFile(new URL('../web/turn-pad.ts',import.meta.url),'utf8');
 const sweepPad=(binder:(opts:Parameters<typeof bindTurnPad>[0])=>ReturnType<typeof bindTurnPad>,dials:readonly TurnDial[],widthPx:number,lang:'en'|'ko')=>{
  class FakeNode {
   tagName:string;id='';className='';textContent='';value='';type='';min='';max='';step='';title='';checked=false;disabled=false;
   dataset:Record<string,string>={};style:Record<string,string>={};attrs=new Map<string,string>();children:(FakeNode|string)[]=[];listeners=new Map<string,Function[]>();
   onclick:Function|null=null;onchange:Function|null=null;
   constructor(tag:string){this.tagName=tag.toUpperCase();}
   append(...items:(FakeNode|string)[]){this.children.push(...items);}
   remove(){}
   setAttribute(k:string,v:string){this.attrs.set(k,v);}
   getAttribute(k:string){return this.attrs.get(k)??null;}
   addEventListener(k:string,fn:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),fn]);}
   removeEventListener(k:string,fn:Function){this.listeners.set(k,(this.listeners.get(k)??[]).filter(f=>f!==fn));}
   getBoundingClientRect(){return {left:0,top:0,width:201,height:201};}
   querySelectorAll(attr:string):FakeNode[]{
    const out:FakeNode[]=[];
    const walk=(n:FakeNode)=>{for(const c of n.children)if(typeof c!=='string'){if(attr==='output'&&c.tagName==='OUTPUT')out.push(c);if(attr==='input[type=number]'&&c.tagName==='INPUT'&&c.type==='number'&&c.getAttribute('aria-label')?.startsWith('Turn ')&&c.getAttribute('aria-label')?.endsWith(' value'))out.push(c);walk(c);}};
    walk(this);return out;
   }
  }
  const host=new FakeNode('div'),stage=new FakeNode('div'),doc={createElement:(t:string)=>new FakeNode(t),hidden:false,activeElement:null};
  const saved=new Map<string,any>();
  const globals:Record<string,unknown>={document:doc,requestAnimationFrame:():number=>1,cancelAnimationFrame:():void=>{}};
  for(const [k,v] of Object.entries(globals)){saved.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;}
  try{
   const pad=binder({host:host as any,stages:[stage as any],dials,draw:()=>{},save:()=>{},error:()=>{}})!;
   const panel=host.children[0] as FakeNode;
   const outputs=panel.querySelectorAll('output');
   const numbers=panel.querySelectorAll('input[type=number]');
   const measureLayout=()=>{
    // Measure flex row wrapping of .turn-pad children inside the stage column at widthPx.
    const stageWidth=widthPx>1024?widthPx-568:widthPx-488;
    const innerWidth=stageWidth-24,gapX=14,rowH=30,padY=16;
    const itemWidth=(child:FakeNode):number=>{
     if(child.tagName==='STRONG')return (lang==='ko'?4:8)*7;
     if(child.tagName==='SPAN')return (lang==='ko'?34:57)*6.2;
     if(child.tagName==='BUTTON')return (child.textContent.length+(lang==='ko'?2:0))*6.5+20;
     if(child.tagName==='LABEL'){
      let w=0,gaps=0;
      for(const node of child.children){
       if(gaps++>0)w+=5;
       if(typeof node==='string'){
        const len=lang==='ko'?node.replace('Applied','적용됨').replace('target','대상').length:node.length;
        w+=len*6.2;
       }else if(node.tagName==='INPUT'&&node.type==='checkbox')w+=14;
       else if(node.tagName==='INPUT'&&node.type==='number')w+=64;
       else if(node.tagName==='OUTPUT'){
        const minCh=parseFloat(node.style.minWidth||'0')||0;
        const ch=Math.max(minCh,node.value.length);
        w+=ch*6.6;
       }
      }
      return (child.textContent.length*6.2)+(w>0?w+5:0);
     }
     return 40;
    };
    let rows=1,lineW=0;
    for(const c of panel.children){
     if(typeof c==='string')continue;
     const w=itemWidth(c);
     if(lineW>0&&lineW+gapX+w>innerWidth){rows++;lineW=w;}
     else lineW=lineW>0?lineW+gapX+w:w;
    }
    const height=rows*rowH+padY;
    return {rows,height,stageTop:48+height,outputWidths:outputs.map(o=>Math.max(parseFloat(o.style.minWidth||'0')||0,o.value.length))};
   };
   const samples:ReturnType<typeof measureLayout>[]=[];
   const coords=[-1,-0.987654,-0.5,-0.012345,0,0.012345,0.5,0.987654,1];
   samples.push(measureLayout());
   for(const u of coords){
    const move=(stage.listeners.get('pointermove')??[])[0]!;
    move({buttons:0, currentTarget:stage, clientX:(u+1)*100, clientY:(1-u)*100});
    for(let step=0;step<4;step++){pad.state.step(0.016);pad.restore(pad.snapshot(),false);}
    // Actually step without holding:
    pad.state.hold(false);
    move({buttons:0, currentTarget:stage, clientX:(u+1)*100, clientY:(1-u)*100});
    pad.state.step(0.025);
    // Trigger render via pointermove with current spring values:
    move({buttons:0, currentTarget:stage, clientX:(u+1)*100, clientY:(1-u)*100});
    samples.push(measureLayout());
   }
   // Exact entry keeps full precision on number input and dataset.value while rounding output.value:
   pad.state.exact('yaw',-14.839201);
   pad.restore(pad.snapshot());
   const yawOut=outputs.find(o=>o.dataset.turnAxis==='yaw')!;
   const yawTarget=outputs.find(o=>o.dataset.turnTarget==='yaw')!;
   const yawNum=numbers[0]!;
   samples.push(measureLayout());
   const exactPreserved=yawNum.value==='-14.839201'&&yawOut.dataset.value==='-14.839201'&&yawTarget.dataset.value==='-14.839201';
   const minWidths=outputs.map(o=>o.style.minWidth??'');
   pad.dispose();
   return {samples,exactPreserved,yawOutValue:yawOut.value,minWidths};
  }finally{
   for(const [k,v] of saved)(globalThis as any)[k]=v;
  }
 };

 // 1. Actual implementation: minWidths match each dial's range ([6ch, 5ch, 7ch]), exact value is preserved, and row count / height / stageTop are invariant across widths and languages.
 for(const widthPx of [1440,1024,900] as const){
  for(const lang of ['en','ko'] as const){
   const res=sweepPad(bindTurnPad,ranges,widthPx,lang);
   expect(res.minWidths).toEqual(['6ch','6ch','5ch','5ch','7ch','7ch']);
   expect(res.exactPreserved).toBe(true);
   expect(res.yawOutValue).toBe('-14.84');
   expect(new Set(res.samples.map(s=>s.rows)).size).toBe(1);
   expect(new Set(res.samples.map(s=>s.height)).size).toBe(1);
   expect(new Set(res.samples.map(s=>s.stageTop)).size).toBe(1);
   expect(new Set(res.samples.map(s=>s.outputWidths.join(','))).size).toBe(1);
  }
 }

 // 2. Planted mutant: remove reserved minWidth and display rounding -> outputWidths and row wrapping change during sweep, failing the bar.
 const mutantSource=padSource
  .replace(/import \{[^}]+\} from '\.\.\/src\/turn-pad\.ts';\n/,'')
  .replace(/export interface TurnPad[^\n]+\n/,'')
  .replace('export function bindTurnPad','function bindTurnPad')
  .replace('output.style.width=width;output.style.minWidth=width;','')
  .replace('target.style.width=width;target.style.minWidth=width;','')
  .replace('formatTurnValue(value,row.dial)','String(Number(value.toFixed(6)))')
  .replace('formatTurnValue(targetValue,row.dial)','String(Number(targetValue.toFixed(6)))');
 expect(mutantSource).not.toBe(padSource);
 const jsMutant=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(mutantSource);
 const mutantBinder=new Function('scope',`with(scope){${jsMutant};return bindTurnPad;}`)({TurnState,pointerPosition,turnDialWidthCh,formatTurnValue}) as typeof bindTurnPad;
 const mutantRes=sweepPad(mutantBinder,ranges,1440,'en');
 expect(mutantRes.minWidths).toEqual(['','','','','','']);
 expect(new Set(mutantRes.samples.map(s=>s.outputWidths.join(','))).size).toBeGreaterThan(1);
 expect(new Set(mutantRes.samples.map(s=>s.rows)).size).toBeGreaterThan(1);
 expect(new Set(mutantRes.samples.map(s=>s.height)).size).toBeGreaterThan(1);
 expect(new Set(mutantRes.samples.map(s=>s.stageTop)).size).toBeGreaterThan(1);
});
