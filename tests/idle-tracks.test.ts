import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {applyConfigPatch,parseConfigPatch,type ConfigPatch,type JsonValue} from '../src/config-patch.ts';
import {rebuildDir,scratchConfigText} from '../src/rebuild.ts';
import {addTrack,idleDraftState,idleDraftText,idleKeying,idleOps,idleSource,initialState,keySamplingBound,linkSine,periodFits,periodOffers,precheck,previewLocal,previewPlan,previewTarget,removeTrack,setBlink,setField,setLinkAmp,sineValue,stateFromOps,IDLE_READOUT_BARS,type IdleKeying,type IdleSource,type IdleState} from '../src/idle-tracks.ts';
import {readoutRows} from '../src/physics-tuning.ts';
import {makePatch,type PatchJobView} from '../web/rebuild-client.ts';

/** The real config's motion shapes (names invented): a 40-frame idle at 12 fps, eight tracks, a blink with brows. */
const D=40/12;
const config={key:'k',
 bones:[{name:'hip',parent:'root',at:[400,600]},{name:'chest',parent:'hip',at:[400,440]},{name:'neck',parent:'chest',at:[400,260]},{name:'head',parent:'neck',at:[400,210]},
  {name:'eye_a',parent:'head',at:[390,176]},{name:'eye_b',parent:'head',at:[430,176]},{name:'brow_a',parent:'head',at:[388,152]},{name:'brow_b',parent:'head',at:[432,152]},
  {name:'knot',parent:'head',at:[410,127],tip:[410,190]},{chain:'arm_a',parent:'chest',points:[[340,284],[305,444]],tip:[270,616]},{chain:'arm_b',parent:'chest',points:[[490,284],[524,444]],tip:[556,616]},
  {name:'soft',parent:'chest',at:[414,342]}],
 motion:{duration:D,tracks:[
  {bone:'chest',prop:'translatey',amp:3.0,period:D,phase:0,base:3.0},
  {bone:'chest',prop:'scalex',amp:0.004,period:D,phase:0,base:1.004},
  {bone:'head',prop:'rotate',amp:0.9,period:D,phase:0.12},
  {bone:'neck',prop:'rotate',amp:0.35,period:D,phase:0.08},
  {bone:'knot',prop:'rotate',amp:1.0,period:D,phase:0.2},
  {chain:'arm_a',amps:[0.2,0.6],period:D,phase:0.22,lag:0.08},
  {chain:'arm_b',amps:[-0.2,-0.6],period:D,phase:0.27,lag:0.08},
  {bone:'soft',prop:'translatey',amp:0.8,period:D,phase:0.14}],
  blink:{t:2.3,eyes:['eye_a','eye_b'],brows:['brow_a','brow_b'],squash:0.12,brow_drop:1.2},animations_from:'more.json'}};
const src=():IdleSource=>{const r=idleSource(config);if(!r.available)throw new Error(r.reason);return r.source;};
const key=(state:IdleState,origin:number)=>state.entries.find(e=>e.origin===origin)!.key;

test('source: the config\'s idle as written — tracks, blink, bones with chain links expanded, link counts',()=>{
 const s=src();
 expect(s.duration).toBe(3.3333333333333335);expect(s.tracks).toEqual(config.motion.tracks as never);
 expect(s.chains).toEqual({arm_a:2,arm_b:2});expect(s.bones).toContain('arm_a1');expect(s.bones).toContain('soft');
 expect(idleSource({motion:{duration:D,tracks:[{bone:'x',prop:'wobble',amp:1,period:D,phase:0}]}})).toEqual({available:false,reason:'IDLE_TRACKS_UNAVAILABLE: config.motion.tracks[0] is not a single track {bone, prop, amp, period, phase, base?}'});
 expect(idleSource({})).toEqual({available:false,reason:'IDLE_TRACKS_UNAVAILABLE: the handoff config states no motion'});
});

test('the sine is the producer\'s: base + amp·sin(2π(t/period − phase)); a chain link at phase + lag·i about 0',()=>{
 const p={amp:2,period:D,phase:0.3,base:1};
 expect(sineValue(p,0)).toBeCloseTo(1+2*Math.sin(-2*Math.PI*0.3),12);
 expect(sineValue(p,D/4)).toBeCloseTo(1+2*Math.sin(2*Math.PI*(0.25-0.3)),12);
 expect(sineValue({amp:1,period:D,phase:0},D/4)).toBeCloseTo(1,12);
 expect(linkSine({chain:'arm_a',amps:[0.2,0.6],period:D,phase:0.22,lag:0.08},1)).toEqual({amp:0.6,period:D,phase:0.22+0.08,base:0});
});

/**
 * The producer's keys for one sine (rig-parts `sineTrack`, ported line for line: KEYS_PER_PERIOD 8, exact Hermite tangents
 * as bezier handles, times to 6 decimals, values to 4, the last key at the duration as given) and the runtime's value
 * at t (play's `channelAt` over `bezierPolyline`: ten straight pieces, points held as float32).
 */
function producerKeys(p:{amp:number;period:number;phase:number;base:number},duration:number){
 const n=Math.round((duration/p.period)*8),w=(2*Math.PI)/p.period,r=(x:number,d:number)=>Number(x.toFixed(d)),raw:[number,number,number][]=[];
 for(let k=0;k<=n;k++){const t=(duration*k)/n,arg=w*t-2*Math.PI*p.phase;raw.push([t,p.base+p.amp*Math.sin(arg),p.amp*w*Math.cos(arg)]);}
 return raw.map(([t,v,m],i)=>{const key:{t:number;v:number;curve?:number[]}={t:i===raw.length-1?duration:r(t,6),v:r(v,4)};if(i<raw.length-1){const [t1,v1,m1]=raw[i+1]!,dt=t1-t;key.curve=[r(t+dt/3,6),r(v+(m*dt)/3,4),r(t1-dt/3,6),r(v1-(m1*dt)/3,4)];}return key;});
}
function runtimeValue(keys:ReturnType<typeof producerKeys>,t:number):number{
 let i=-1;for(let k=0;k<keys.length;k++){if(keys[k]!.t<=t)i=k;else break;}
 const a=keys[i]!,b=keys[i+1];if(!b)return a.v;
 const walk=(p0:number,p1:number,p2:number,p3:number)=>{const second=(p0-2*p1+p2)*0.03,third=((p1-p2)*3-p0+p3)*6e-3;let first=(p1-p0)*0.3+second+third*0.16666667,d2=second*2+third,at=p0;const out:number[]=[];for(let q=1;q<10;q++){at+=first;first+=d2;d2+=third;out.push(Math.fround(at));}return out;};
 const c=a.curve!,ts=walk(a.t,c[0]!,c[2]!,b.t),vs=walk(a.v,c[1]!,c[3]!,b.v),pts=[a.t,a.v,...ts.flatMap((x,q)=>[x,vs[q]!]),b.t,b.v];
 let j=2;while(j<pts.length-2&&pts[j]!<t)j+=2;const [x0,y0,x1,y1]=[pts[j-2]!,pts[j-1]!,pts[j]!,pts[j+1]!];return y0+(t-x0)/(x1-x0)*(y1-y0);
}

test('bar 1 (unit): the preview\'s sine equals the producer\'s keyed idle within the stated key-sampling bound over one idle',()=>{
 for(const p of [{amp:2,period:D,phase:0.3,base:0},{amp:3,period:D/2,phase:0.12,base:3},{amp:0.9,period:D/4,phase:0.71,base:0}]){
  const keys=producerKeys(p,D),bound=keySamplingBound(p,D);
  let worst=0;for(let k=0;k<=4000;k++){const t=D*k/4000;worst=Math.max(worst,Math.abs(sineValue(p,t)-runtimeValue(keys,t)));}
  expect(worst).toBeGreaterThan(0);expect(worst).toBeLessThanOrEqual(bound);
 }
 // The bound as stated before measuring, for the live track (amp 2): |amp|·((π/4)⁴/384 + (π/40)²/8) + 5e-5 + float terms.
 expect(keySamplingBound({amp:2,period:D,base:0},D)).toBeCloseTo(2*((Math.PI/4)**4/384+(Math.PI/40)**2/8)+5e-5,5);
 // A rotation local adds the setup; a scale local multiplies it.
 const w={bone:'b',channel:'rotation' as const,prop:'rotate' as const,sine:{amp:2,period:D,phase:0.3,base:0}};
 expect(previewLocal(w,-102.5,0)).toBeCloseTo(-102.5+sineValue(w.sine,0),12);
 expect(previewLocal({...w,channel:'scaleX',prop:'scalex',sine:{amp:0.004,period:D,phase:0,base:1.004}},2,D/4)).toBeCloseTo(2*1.008,12);
 expect(previewLocal({...w,sine:null},-102.5,1)).toBe(-102.5);
});

test('bar 2: only divisors of the duration are offered; a typed one is refused with the producer\'s own line',()=>{
 const s=src(),offers=periodOffers(s.duration);
 expect(offers.length).toBe(12);
 for(const o of offers){expect(periodFits(s.duration,o.period)).toBe(true);expect(o.period*o.cycles).toBeCloseTo(s.duration,12);}
 expect(offers[1]!.period).toBe(1.6666666666666667);
 // Every period on a fine grid that fits is offered (up to 12 cycles); every one that is offered fits.
 for(let k=1;k<=4000;k++){const period=k/1000;if(periodFits(s.duration,period)&&s.duration/period<=12)expect(offers.some(o=>o.period===period)).toBe(true);}
 const typed=setField(initialState(s),'o0','period',1.5);
 // The real producer's line for this config (rig-parts 1.42.0), less its `FAIL  ` lead and guide tail.
 expect(precheck(s,typed)).toEqual(['CONFIG_PERIOD_DIVIDES_DURATION: config.motion.tracks[0].period — is 1.5 s against a 3.3333333333333335 s idle, 2.2222 cycles; a whole number of cycles is required or the loop\'s last frame is not its first']);
 expect(precheck(s,setField(initialState(s),'o0','period',D/3))).toEqual([]);
});

test('bar 3: a second track on a chain link\'s rotate is refused before Apply, by the producer\'s name and words',()=>{
 const s=src(),state=addTrack(s,initialState(s),{bone:'arm_a0',prop:'rotate'});
 expect(precheck(s,state)).toEqual(['CONFIG_BONE_PROPERTY_KEYED_ONCE: bone property "arm_a0.rotate" — is keyed by 2 tracks: config.motion.tracks[5] (chain "arm_a", link 0) and config.motion.tracks[8]; one track per bone property is required — the idle would hold 2 timelines on arm_a0.rotate, and rigc refuses two tracks on one bone property. Merge them into one track, or key another property or bone']);
 // Another property on the link, or the link once the chain track is removed, is not refused here.
 expect(precheck(s,addTrack(s,initialState(s),{bone:'arm_a0',prop:'translatex'}))).toEqual([]);
 expect(precheck(s,removeTrack(state,key(state,5)))).toEqual([]);
 // A blink member keyed again, and a blink outside the idle, under the producer's names.
 expect(precheck(s,addTrack(s,initialState(s),{bone:'eye_a',prop:'scaley'}))[0]).toStartWith('CONFIG_BONE_PROPERTY_KEYED_ONCE: bone property "eye_a.scaley" — is keyed by 2 tracks: config.motion.tracks[8] and config.motion.blink.eyes[0] (the blink\'s eyes group, which keys scaley on every member);');
 expect(precheck(s,setBlink(initialState(s),'t',3.1))).toEqual(['RIG_BLINK_INSIDE_IDLE: config.motion.blink.t — is 3.1 s; the blink\'s keys run from t to t + 0.364 s between the idle\'s first key at 0 and its last at 3.3333333333333335 s, so 0 < t < 2.969333 is required']);
});

/** Every kind of edit at once: a field, a period, a base taken out, a chain amp and lag, two removals, an added track, the blink. */
function edited(s:IdleSource):IdleState {
 let st=initialState(s);
 st=setField(st,key(st,2),'amp',2);st=setField(st,key(st,2),'phase',0.3);
 st=setField(st,key(st,0),'period',D/2);st=setField(st,key(st,1),'base',null);
 st=setLinkAmp(st,key(st,5),1,0.9);st=setField(st,key(st,5),'lag',0.1);
 st=removeTrack(st,key(st,3));st=removeTrack(st,key(st,6));
 st=addTrack(s,st,{bone:'soft',prop:'translatex'});st=setField(st,st.entries.at(-1)!.key,'amp',0.5);
 st=setBlink(st,'t',2.0);st=setBlink(st,'squash',0.2);st=setBlink(st,'brow_drop',0.8);
 return st;
}
/** The same edit made by hand on the config document, independently of the ops. */
function byHand():typeof config {
 const c=structuredClone(config),t=c.motion.tracks as Record<string,unknown>[];
 t[2]!.amp=2;t[2]!.phase=0.3;t[0]!.period=D/2;delete t[1]!.base;(t[5]!.amps as number[])[1]=0.9;t[5]!.lag=0.1;
 t.splice(6,1);t.splice(3,1);t.push({bone:'soft',prop:'translatex',amp:0.5,period:D,phase:0});
 Object.assign(c.motion.blink,{t:2.0,squash:0.2,brow_drop:0.8});
 return c;
}

test('bar 4: the patch round-trips — applied to the source config it gives byte-identical scratch output',()=>{
 const s=src(),st=edited(s),ops=idleOps(s,st);
 expect(ops).toEqual([
  {op:'replace',path:'/motion/tracks/0/period',value:D/2},{op:'remove',path:'/motion/tracks/1/base'},
  {op:'replace',path:'/motion/tracks/2/amp',value:2},{op:'replace',path:'/motion/tracks/2/phase',value:0.3},
  {op:'replace',path:'/motion/tracks/5/amps/1',value:0.9},{op:'replace',path:'/motion/tracks/5/lag',value:0.1},
  {op:'remove',path:'/motion/tracks/6'},{op:'remove',path:'/motion/tracks/3'},
  {op:'add',path:'/motion/tracks/-',value:{bone:'soft',prop:'translatex',amp:0.5,period:D,phase:0}},
  {op:'replace',path:'/motion/blink/t',value:2},{op:'replace',path:'/motion/blink/squash',value:0.2},{op:'replace',path:'/motion/blink/brow_drop',value:0.8},
 ]);
 const patched=applyConfigPatch(config as unknown as JsonValue,ops),configPath='/nowhere/rig/config.json';
 expect(scratchConfigText(configPath,patched)).toBe(scratchConfigText(configPath,byHand() as unknown as JsonValue));
 // Read back, the patched config is the edited idle; the ops read back give the same state and the same ops.
 const again=idleSource(patched);if(!again.available)throw new Error(again.reason);
 expect(again.source.tracks).toEqual(st.entries.map(e=>e.track).sort(()=>0) as never);
 expect(idleOps(s,stateFromOps(s,ops))).toEqual(ops);
 expect(idleOps(s,idleDraftState(idleDraftText(ops),s))).toEqual(ops);
 // A patch carrying them parses, with the idle-keys flag the inspected rig was built under.
 const patch=makePatch({inputs:{config:'rig/config.json',parts:null,rig:null,configHash:'a'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'}},ops,{cmd:'rig',args:['--idle-keys','ctl']}) as ConfigPatch;
 expect(parseConfigPatch(patch).op).toEqual({cmd:'rig',args:['--idle-keys','ctl']});
 // An op the panel would not write is not half-read from a draft.
 expect(()=>stateFromOps(s,[...ops,{op:'replace',path:'/motion/duration',value:2}])).toThrow('IDLE_DRAFT_UNREADABLE');
 // An op that changes nothing (the config's own amp) is not one the panel writes either.
 expect(()=>stateFromOps(s,[{op:'replace',path:'/motion/tracks/2/amp',value:0.9}])).toThrow('IDLE_DRAFT_UNREADABLE: the ops are not the ones the panel writes');
 expect(idleDraftState('{"schema":"rig-review-idle-draft/1","ops":[{"op":"replace","path":"/motion/tracks/99/amp","value":1}]}',s)).toEqual(initialState(s));
});

test('the draft keeps the pending ops and nothing of the preview; the panel\'s preview toggle carries no id',async()=>{
 const s=src(),ops=idleOps(s,edited(s)),text=idleDraftText(ops);
 expect(Object.keys(JSON.parse(text))).toEqual(['schema','ops']);expect(text).not.toContain('preview');
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),panel=html.slice(html.indexOf('<section id="idle-tracks"'),html.indexOf('</section>',html.indexOf('<section id="idle-tracks"')));
 expect(panel).toContain('<input data-idle-preview type="checkbox" checked>');
 // The only form fields with ids in the panel are the hidden pending-ops record: the source draft captures nothing else.
 expect([...panel.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m=>m[2])).toEqual(['idle-pending']);
 expect(panel).toContain('preview — Apply decides');
});

test('keying: ctl controls read off the inspected rig and motion; the preview drives the bone the idle keys, else refuses by name',()=>{
 const rig={bones:[{name:'root'},{name:'chest_ctl',parent:'hip'},{name:'chest',parent:'chest_ctl'},{name:'head_ctl',parent:'neck'},{name:'head',parent:'head_ctl'},{name:'neck',parent:'chest'},{name:'arm_a0',parent:'chest'},{name:'arm_a1',parent:'arm_a0'},{name:'eye_a',parent:'head'}],invariants:{detached:[]}};
 const motion={groups:{eyes:['eye_a']},animations:{idle:{tracks:[{bone:'chest_ctl',property:'translatey'},{bone:'head_ctl',property:'rotate'},{bone:'neck',property:'rotate'},{bone:'arm_a0',property:'rotate'},{group:'eyes',property:'scaley'}]}}};
 const k=idleKeying(rig,motion) as IdleKeying;
 expect(k.keys).toBe('ctl');expect(k.controls).toEqual(['chest_ctl','head_ctl']);
 expect(k.keyed).toEqual({'chest.translatey':'chest_ctl','head.rotate':'head_ctl','neck.rotate':'neck','arm_a0.rotate':'arm_a0','eye_a.scaley':'eye_a'});
 expect(k.source).toStartWith('rig.json declares no invariants.idleDrivesMeshes, so the rig was built under --idle-keys ctl');
 expect((idleKeying({...rig,invariants:{idleDrivesMeshes:{why:'x'}}},motion) as IdleKeying).keys).toBe('direct');
 expect(idleKeying({},motion)).toEqual({error:'IDLE_KEYS_UNKNOWN: the handoff rig.json has no bones list'});
 const bones=new Set(rig.bones.map(b=>b.name));
 expect(previewTarget('head','rotate',k,bones)).toEqual({bone:'head_ctl'});
 expect(previewTarget('chest','scalex',k,bones)).toEqual({bone:'chest_ctl'});
 expect(previewTarget('neck','translatex',k,bones)).toEqual({bone:'neck'});
 expect(previewTarget('eye_a','rotate',k,bones)).toEqual({bone:'eye_a'});
 expect(previewTarget('arm_a1','rotate',k,bones)).toEqual({refusal:'IDLE_PREVIEW_TARGET_UNKNOWN: arm_a1.rotate is not keyed by the inspected idle; under --idle-keys ctl the producer keys arm_a1_ctl instead when a mesh is weighted to arm_a1, which review does not decide — Apply decides'});
 expect(previewTarget('arm_a1','rotate',{...k,keys:'direct'},bones)).toEqual({bone:'arm_a1'});
 // What the inspected idle keys wins over the mode's rule.
 expect(previewTarget('chest','translatey',{...k,keys:'direct'},bones)).toEqual({bone:'chest_ctl'});
 // The plan: only changed tracks (each chain link), a removed track held still, on the keyed bones.
 const s=src();let st=initialState(s);st=setField(st,key(st,2),'amp',2);st=removeTrack(st,key(st,3));st=setLinkAmp(st,key(st,5),0,0.4);
 const plan=previewPlan(s,st,k,bones);
 expect(plan.writes.map(w=>[w.bone,w.channel,w.sine?.amp??null])).toEqual([['neck','rotation',null],['head_ctl','rotation',2],['arm_a0','rotation',0.4]]);
 expect(plan.refusals).toEqual(['IDLE_PREVIEW_TARGET_UNKNOWN: arm_a1.rotate is not keyed by the inspected idle; under --idle-keys ctl the producer keys arm_a1_ctl instead when a mesh is weighted to arm_a1, which review does not decide — Apply decides']);
 expect(previewPlan(s,initialState(s),k,bones)).toEqual({writes:[],refusals:[],tracks:0});
});

test('readout: CHAIN_LAG, TIP_OVER_ROOT, BREATH_VISIBLE and the loop line, before and after; an absent one by name',()=>{
 const before={lines:['  loop: idle 41 frame(s) at 12 fps, f0000 vs f0040','  CHAIN_LAG: PASS — chains a','  BREATH_VISIBLE: PASS — b'],check:{schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS',bars:{CHAIN_LAG:'PASS',TIP_OVER_ROOT:'PASS',BREATH_VISIBLE:'PASS'},gate:true} as never};
 const after={lines:['  CHAIN_LAG: FAIL — chains c'],check:null};
 expect(readoutRows(before,null,after,IDLE_READOUT_BARS)).toEqual([
  {name:'CHAIN_LAG',before:'CHAIN_LAG: PASS — chains a',after:'CHAIN_LAG: FAIL — chains c'},
  {name:'TIP_OVER_ROOT',before:'TIP_OVER_ROOT: PASS (status from check.json; check printed no line for it)',after:'TIP_OVER_ROOT: not in check summary'},
  {name:'BREATH_VISIBLE',before:'BREATH_VISIBLE: PASS — b',after:'BREATH_VISIBLE: not in check summary'},
  {name:'loop',before:'loop: idle 41 frame(s) at 12 fps, f0000 vs f0040',after:'loop: not in check summary'},
 ]);
});

// ---- through the server, with a fake producer that records what it was given ----
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='rig'){const out=f('--out'),srcDir=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});
 for(const n of fs.readdirSync(srcDir))if(fs.statSync(path.join(srcDir,n)).isFile())fs.copyFileSync(path.join(srcDir,n),path.join(out,n));
 if(a.includes('--idle-keys')){const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.args=a.slice(a.indexOf('--idle-keys'));fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));}
 console.log('rig-parts rig: wrote rig.json');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:true,gate_spine_html_green:true,CHAIN_LAG:{status:'PASS'}}));console.log('  loop: idle 41 frame(s)');console.log('  CHAIN_LAG: PASS — chains');console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}]}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
const rigJson={bones:[{name:'root'},{name:'chest_ctl',parent:'hip'},{name:'chest',parent:'chest_ctl'}]};
const motionJson={groups:{},animations:{idle:{tracks:[{bone:'chest_ctl',property:'translatey'}]}}};
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-idle-'))),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/more.json'),'{}');await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(pkg,'rig/out/rig/rig.json'),JSON.stringify(rigJson));await writeFile(join(pkg,'rig/out/rig/motion.json'),JSON.stringify(motionJson));await writeFile(join(pkg,'rig/out/rig/mesh_report.json'),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state')};
}
async function settle(base:string,job:PatchJobView):Promise<PatchJobView>{while(job.status==='running'){await Bun.sleep(20);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json();}return job;}

test('bar 4 (server): GET /api/rebuild carries the idle and its keying; the Apply\'s scratch config is byte-identical to the hand edit',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json();
  expect(status.idle.source).toEqual({available:true,source:src()});
  expect(status.idle.keying).toMatchObject({keys:'ctl',keyed:{'chest.translatey':'chest_ctl'},controls:['chest_ctl']});
  const ops=idleOps(src(),edited(src())),patch=makePatch(status,ops,{cmd:'rig',args:['--idle-keys',status.idle.keying.keys]});
  const job=await settle(base,await (await fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({patch})})).json());
  expect(job.status).toBe('built');
  const dir=rebuildDir(state,p.sourceHash,job.id),written=await readFile(join(dir,'config.json'),'utf8');
  expect(written).toBe(scratchConfigText(join(pkg,'rig/config.json'),byHand() as unknown as JsonValue));
  expect(JSON.parse(written).motion.animations_from).toBe(join(pkg,'rig/more.json'));
  // The producer was given the inspected rig's idle-keys flag.
  expect(JSON.parse(await readFile(join(dir,'rig/rig.json'),'utf8')).args).toEqual(['--idle-keys','ctl']);
  expect(readoutRows(null,null,{lines:job.lines,check:job.check},IDLE_READOUT_BARS).map(r=>r.after)).toEqual(['CHAIN_LAG: PASS — chains','TIP_OVER_ROOT: not in check summary','BREATH_VISIBLE: not in check summary','loop: idle 41 frame(s)']);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});
