/** Layout offers follow actual load events. A declared path, a stored request or a placeholder never establishes an input. */
export type InputState={state:'loaded'}|{state:'pending'}|{state:'absent'}|{state:'failed';reason:string}|{state:'out-of-domain';reason:string};
export const singleLayouts=['compare','reference','rig'] as const;
export const pairLayouts=['compare','a','b','reference'] as const;
export type SingleLayout=typeof singleLayouts[number];
export type PairLayout=typeof pairLayouts[number];
export type ComparisonLayout=SingleLayout|PairLayout;
/** Review has no producer candidate handoff yet; this is stated, not drawn. */
export const candidateUnavailable={state:'unavailable',reason:'no producer handoff'} as const;
export interface Eligibility<L extends ComparisonLayout> {
 mode:'single'|'compare';requested:L;effective:L|null;usable:L[];reasons:Partial<Record<L,string>>;candidate:typeof candidateUnavailable;
}
export interface PairEligibility extends Eligibility<PairLayout> {feedback:boolean;playback:boolean;static:boolean}
export interface SingleInputs {rig:InputState;reference:InputState;requested:SingleLayout}
export type PairDomain={end:number}|{refused:string}|null;
export interface PairInputs {a:InputState;b:InputState;reference:InputState;domain:PairDomain;requested?:PairLayout}

const prose:Record<InputState['state'],string>={loaded:'',pending:'not rendered yet',absent:'not supplied',failed:'',['out-of-domain']:''};
/** Named reason for an input that cannot be drawn. Codes are stable; detail is display text. */
export function inputReason(name:'RIG'|'REFERENCE'|'A'|'B',input:InputState):string|null {
 if(input.state==='loaded')return null;
 if(input.state==='failed')return `${name}_FAILED: ${input.reason}`;
 if(input.state==='out-of-domain')return `${name}_OUT_OF_DOMAIN: ${input.reason}`;
 return `${name}_${input.state.toUpperCase()}: ${name==='REFERENCE'&&input.state==='pending'?'held time not decoded yet':prose[input.state]}`;
}
function settle<L extends ComparisonLayout>(mode:'single'|'compare',requested:L,order:readonly L[],reasons:Partial<Record<L,string>>,fallback:readonly L[]):Eligibility<L> {
 const usable=order.filter(layout=>reasons[layout]===undefined);
 const effective=usable.includes(requested)?requested:fallback.find(layout=>usable.includes(layout))??null;
 return {mode,requested,effective,usable,reasons,candidate:candidateUnavailable};
}
/** Single review: side by side needs an actually drawn rig AND a decoded reference. */
export function singleEligibility(value:SingleInputs):Eligibility<SingleLayout> {
 const rig=inputReason('RIG',value.rig),reference=inputReason('REFERENCE',value.reference),reasons:Partial<Record<SingleLayout,string>>={};
 if(rig)reasons.rig=rig;if(reference)reasons.reference=reference;
 if(rig||reference)reasons.compare=[rig,reference].filter(Boolean).join(' · ');
 return settle('single',value.requested,singleLayouts,reasons,value.requested==='reference'?['reference','rig']:['rig','reference']);
}
/** A held time outside a video's real domain is refused, never clamped. */
export function videoReferenceAt(held:number,duration:number):InputState {
 if(!Number.isFinite(duration)||duration<0)return {state:'failed',reason:'video duration is not finite'};
 if(!Number.isFinite(held)||held<0||held>duration)return {state:'out-of-domain',reason:`held time ${held} s is outside the video domain 0–${duration} s`};
 return {state:'pending'};
}
/** Two builds: the pair needs both sides, the shared video and a valid common domain. A failed side leaves the survivor usable alone. */
export function pairEligibility(value:PairInputs):PairEligibility {
 const a=inputReason('A',value.a),b=inputReason('B',value.b),reference=inputReason('REFERENCE',value.reference),reasons:Partial<Record<PairLayout,string>>={};
 if(a)reasons.a=a;if(b)reasons.b=b;if(reference)reasons.reference=reference;
 const domain=value.domain,end=domain&&'end' in domain&&Number.isFinite(domain.end)&&domain.end>=0?domain.end:null;
 const domainReason=a||b||reference?null:domain===null?'DOMAIN_PENDING: shared domain not established':'refused' in domain?`DOMAIN_REFUSED: ${domain.refused}`:end===null?'DOMAIN_REFUSED: shared end is not finite':null;
 if(a||b||reference||domainReason)reasons.compare=[a,b,reference,domainReason].filter(Boolean).join(' · ');
 const result=settle('compare',value.requested??'compare',pairLayouts,reasons,['a','b','reference']);
 const pair=result.usable.includes('compare');
 return {...result,feedback:pair,playback:pair&&end!==null&&end>0,static:pair&&end===0};
}
