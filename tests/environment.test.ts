import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {BASE_WIND_LIMIT,MAX_GUST_PEAK,MIN_GUST_DURATION,MAX_GUST_DURATION,GUST_PEAK,GUST_DURATION,breezeAt,gustEnvelope,gustPeriod,createWindModel,environmentFor,windReadout,joltPacket,dueJolts,JOLT_DELAY,dragMoved,physicsConstraints,loadPhysicsConstraints,CONSTRAINT_MIX_READONLY,environmentContext,parseEnvironmentContext,environmentSummary,environmentJson,RUNTIME_START} from '../src/environment.ts';
import {loadReview} from '../src/manifest.ts';
import {validatePackageFeedback,type Feedback} from '../src/session.ts';
import {formatFeedbackIssues} from '../src/feedback-export.ts';
import {freshSession} from '../src/session.ts';

const close=(a:number,b:number)=>expect(Math.abs(a-b)).toBeLessThan(1e-9);

test('breeze is the example formula 2·sin(2.2t)+0.8·sin(5.1t)',()=>{
 for(const t of [0,.3,1,2.5,7])close(breezeAt(t),2*Math.sin(2.2*t)+0.8*Math.sin(5.1*t));
 const wind=createWindModel();wind.setBreeze(true);const r=wind.advance(1.3);close(r.gentle,2*Math.sin(2.86)+0.8*Math.sin(6.63));close(r.wind,r.gentle);
});

test('gust is one peak·sin²(π·age/duration) pulse inside [0, duration)',()=>{
 close(gustEnvelope(0,48,2.4),0);close(gustEnvelope(.6,48,2.4),24);close(gustEnvelope(1.2,48,2.4),48);close(gustEnvelope(1.8,48,2.4),24);
 close(gustEnvelope(.3,48,2.4),48*Math.sin(Math.PI/8)**2);
 expect(gustEnvelope(2.4,48,2.4)).toBe(0);expect(gustEnvelope(-.01,48,2.4)).toBe(0);
 // The pulse never goes negative under a positive peak (a plain sin would at age > duration/2 only beyond the window; sin² is symmetric).
 close(gustEnvelope(.6,48,2.4),gustEnvelope(1.8,48,2.4));
 const wind=createWindModel();wind.advance(.5);wind.triggerGust();expect(wind.read()).toMatchObject({gusting:true,gustAge:0,gust:0});
 const at=(t:number)=>{wind.advance(t-wind.read().time);return wind.read();};
 close(at(1.1).gust,24);close(at(1.7).gust,48);close(at(2.3).gust,24);expect(at(2.9)).toMatchObject({gusting:false,gust:0});
 // A click cannot interrupt a pulse.
 const busy=createWindModel();busy.triggerGust();busy.advance(1);busy.triggerGust();close(busy.read().gustAge!,1);
 // A negative base turns the pulse to its side.
 const left=createWindModel();left.setBase(-10);left.triggerGust();left.advance(1.2);close(left.read().gust,-48);close(left.read().wind,-58);
});

test('repeat period is max(6, duration + 0.6) and restarts the pulse on the stepped clock',()=>{
 expect(gustPeriod(GUST_DURATION)).toBe(6);close(gustPeriod(10),10.6);expect(gustPeriod(5.4)).toBe(6);
 const wind=createWindModel();wind.setRepeat(true);expect(wind.read()).toMatchObject({gusting:true,gustAge:0});
 wind.advance(5.9);expect(wind.read().gusting).toBe(false);wind.advance(.1);expect(wind.read()).toMatchObject({gusting:true});close(wind.read().gustAge!,0);
 // A long step lands on the period grid rather than drifting.
 wind.advance(13.5);close(wind.read().gustAge!,1.5);
 // Turning repeat off finishes the active pulse, then returns to base.
 wind.setRepeat(false);expect(wind.read().gusting).toBe(true);wind.advance(1);expect(wind.read().gusting).toBe(false);wind.advance(10);expect(wind.read().gusting).toBe(false);
 // Pausing is not stepping: the clock and the pulse hold.
 const held=createWindModel();held.triggerGust();held.advance(.6);const before=held.read();held.advance(0);expect(held.read()).toEqual(before);
});

test('limits are the example limits: base ±100, peak 0–200, duration 0.1–20 s, inclusive',()=>{
 expect([BASE_WIND_LIMIT,MAX_GUST_PEAK,MIN_GUST_DURATION,MAX_GUST_DURATION,GUST_PEAK,GUST_DURATION]).toEqual([100,200,.1,20,48,2.4]);
 const wind=createWindModel();
 for(const v of [-100,0,100])expect(()=>wind.setBase(v)).not.toThrow();
 for(const v of [100.001,-100.001,NaN,Infinity])expect(()=>wind.setBase(v)).toThrow('base wind');
 for(const v of [0,200])expect(()=>wind.setGustPeak(v)).not.toThrow();
 for(const v of [-.001,200.001])expect(()=>wind.setGustPeak(v)).toThrow('gust peak');
 for(const v of [.1,20])expect(()=>wind.setGustDuration(v)).not.toThrow();
 for(const v of [.099,20.001])expect(()=>wind.setGustDuration(v)).toThrow('gust duration');
 // restore validates the whole snapshot before changing anything.
 wind.setBase(30);expect(()=>wind.restore({version:1,base:10,breeze:true,repeat:false,gustPeak:48,gustDuration:25})).toThrow('gust duration');expect(wind.read().base).toBe(30);
 expect(()=>wind.advance(-1)).toThrow();
 expect(()=>environmentFor(wind.read(),4.01)).toThrow('gravity');expect(environmentFor(wind.read(),4)).toEqual({wind:[30,0],gravity:[0,4]});
});

test('readout states base + breeze + gust = total and the stepped clock',()=>{
 const wind=createWindModel();wind.setBase(30);wind.triggerGust();wind.advance(1.2);
 expect(windReadout(wind.read(),1)).toBe('wind: 30.0 + 0.0 + 48.0 = 78.0 · gravity 1.00 · t 1.200 s · gust 1.20/2.40 s');
 expect(RUNTIME_START).toEqual({wind:[1,0],gravity:[0,1]});
});

test('jolt packet is translate (18, −10) then its inverse 0.09 s later',()=>{
 const packet=joltPacket(2);
 expect(packet).toEqual([{at:2,x:18,y:-10},{at:2+JOLT_DELAY,x:-18,y:10}]);
 // Net zero: the packet returns the rig where it was.
 expect(packet.reduce((sum,s)=>sum+s.x,0)).toBe(0);expect(packet.reduce((sum,s)=>sum+s.y,0)).toBe(0);
 const first=dueJolts(packet,2.05);expect(first.due).toEqual([packet[0]]);expect(first.pending).toEqual([packet[1]]);
 expect(dueJolts(first.pending,2.09).due).toEqual([packet[1]]);
 expect(dueJolts([packet[1]!,packet[0]!],3).due).toEqual(packet);
});

test('drag to trail is the page delta ÷ the root scale with y negated',()=>{
 expect(dragMoved(12,-8,2)).toEqual({x:6,y:4});expect(dragMoved(-30,15,.5)).toEqual({x:-60,y:-30});
 expect(dragMoved(1,1,0)).toBeNull();expect(dragMoved(1,NaN,1)).toBeNull();
});

const doc={spec:'rigc-compiled/3',constraints:[
 {kind:'transform',name:'ignored_transform',bone:'a',mix:1},
 {kind:'physics',name:'hair_physics',declaredIn:'rig',bone:'hair',rotate:1,strength:100,damping:.85,wind:4,gravity:8},
 {kind:'physics',name:'ribbon_physics',declaredIn:'rig',bone:'ribbon',rotate:1,inertia:.5,strength:160,damping:.85,mass:1,wind:2,gravity:3,mix:1},
 {kind:'physics',name:'translate_only',declaredIn:'rig',bone:'hair',x:.1,y:.1,strength:300,damping:.7},
]};
test('physics constraints are read straight from the model: declared values only, absent stays absent',()=>{
 const value=physicsConstraints(doc);if(!value.available)throw new Error(value.reason);
 expect(value.rows).toEqual([
  {name:'hair_physics',bone:'hair',declaredIn:'rig',values:{wind:4,gravity:8,strength:100,damping:.85}},
  {name:'ribbon_physics',bone:'ribbon',declaredIn:'rig',values:{wind:2,gravity:3,inertia:.5,strength:160,damping:.85,mix:1}},
  {name:'translate_only',bone:'hair',declaredIn:'rig',values:{strength:300,damping:.7}},
 ]);
 expect(physicsConstraints({constraints:[{kind:'transform',name:'t'}]})).toEqual({available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model declares no physics constraints'});
 expect(physicsConstraints({spec:'x'})).toMatchObject({available:false});
 expect(CONSTRAINT_MIX_READONLY).toBe('CONSTRAINT_MIX_READONLY: @rig-c/play exposes no per-constraint mix');
});

test('the constraint list is read from the reviewed model bytes and refused on a hash mismatch',async()=>{
 const bytes=JSON.stringify(doc),sha=createHash('sha256').update(bytes).digest('hex');
 const fetcher=(async()=>new Response(bytes)) as unknown as typeof fetch;
 expect(await loadPhysicsConstraints('/m',sha,fetcher)).toMatchObject({available:true});
 expect(await loadPhysicsConstraints('/m','0'.repeat(64),fetcher)).toEqual({available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model bytes differ from reviewed SHA-256'});
});

const dirs:string[]=[];
afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
async function pkg(){
 const root=await mkdtemp(join(tmpdir(),'review-environment-'));dirs.push(root);
 await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'env',title:'env',revision:'one',model:'skeleton.model.json'}));
 await writeFile(join(root,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[{name:'root'}],slots:[{name:'s'}],animations:[{name:'idle',duration:2}]}));
 return loadReview(join(root,'review.json'));
}
const gustContext=()=>{const wind=createWindModel();wind.setBase(30);wind.triggerGust();wind.advance(1.2);return environmentContext(wind.read(),1,true,{wind:[78,0],gravity:[0,1]});};
const record=(context:Record<string,unknown>):Feedback=>({id:'n',frameStart:0,frameEnd:0,target:{kind:'rig',name:'env'},category:'quality',summary:'Cloth under gust',context:{animation:'idle',...context} as Feedback['context']});

test('feedback context.environment records wind base/breeze/gust and gravity; older records without it stay valid',async()=>{
 const context=gustContext();
 expect(context).toEqual({applied:true,wind:{base:30,breeze:false,gust:{peak:48,duration:2.4,repeat:false,active:true,value:48},total:78},gravity:1,standing:{wind:[78,0],gravity:[0,1]}});
 expect(parseEnvironmentContext(environmentJson(context))).toEqual(context);expect(parseEnvironmentContext(null)).toBeNull();
 for(const bad of [{...context,extra:1},{...context,gravity:5},{...context,wind:{...context.wind,base:101}},{...context,standing:{wind:[1],gravity:[0,1]}},{...context,applied:'yes'}])expect(()=>parseEnvironmentContext(bad)).toThrow('feedback.context.environment');
 const p=await pkg();
 expect(validatePackageFeedback(record({}),p).context).not.toHaveProperty('environment');
 expect((validatePackageFeedback(record({environment:environmentJson(context)}),p).context as Record<string,unknown>).environment).toEqual(environmentJson(context));
 expect(()=>validatePackageFeedback(record({environment:{applied:true}}),p)).toThrow('feedback.context.environment');
 expect(environmentSummary(context)).toBe('wind 30 · gust 48 over 2.4 s (now 48.0) · total 78.0 · gravity 1 · standing wind [78, 0] · gravity [0, 1]');
});

test('issue export names the environment of a note; a note without one has no environment line',async()=>{
 const p=await pkg(),session={...freshSession(p),feedback:[record({environment:environmentJson(gustContext())}),{...record({}),id:'old'}]};
 const text=formatFeedbackIssues(session);
 const decode=(value:string)=>value.replace(/&#(\d+);/g,(_,n:string)=>String.fromCharCode(Number(n)));
 const lines=decode(text).split('\n').filter(line=>line.startsWith('- Environment:'));
 expect(lines).toEqual(['- Environment: wind 30 · gust 48 over 2.4 s (now 48.0) · total 78.0 · gravity 1 · standing wind [78, 0] · gravity [0, 1]']);
});

test('the page applies the environment in the drawing tick, records it in feedback and edits physics only as patch ops',async()=>{
 const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 expect(main).toContain('stepEnvironment(dt); drawRig(()=>player!.frame(dt));');
 expect(main).toContain('environment: feedbackEnvironment(),');
 expect(main).toContain('player.environment(null);if(player.current){player.seek(time);');
 const animate=html.slice(html.indexOf('<section id="inspector-playback"'),html.indexOf('</main>'));
 for(const id of ['environment','wind-base','wind-breeze','wind-gust','wind-gust-peak','wind-gust-duration','wind-repeat','wind-readout','gravity','jolt','drag-trail','physics-reset','physics-panel','physics-rows','physics-row-editor','physics-locked','physics-pending-list','physics-apply','physics-reset-build','physics-readout','physics-pending'])expect(animate).toContain(`id="${id}"`);
 const block=animate.slice(animate.indexOf('<section id="environment"'),animate.indexOf('</section>',animate.indexOf('<section id="environment"')));
 expect(block).toContain('min="-100" max="100"');expect(block).toContain('min="0" max="4"');expect(block).toContain('min="0" max="200"');expect(block).toContain('min="0.1" max="20"');
 // #103: the read-only list became the tuning panel, outside the inspection-only environment block; it says that
 // preview before Apply waits on play#147 and the environment block itself still edits nothing in the model.
 expect(block).not.toContain('physics-constraints');
 const panel=animate.slice(animate.indexOf('<section id="physics-panel"'),animate.indexOf('</section>',animate.indexOf('<section id="physics-panel"')));
 expect(panel).toContain('play#147');expect(panel).toContain('/constraints/&lt;i&gt;/&lt;field&gt;');
});
