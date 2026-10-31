import {expect,test} from 'bun:test';
import {discoverTurnDials,sharedTurnDials,normalizedDial,pointerPosition,springStep,TurnState,parseTurnSnapshot} from '../src/turn-pad.ts';

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
