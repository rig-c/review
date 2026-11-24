/** Clean human-readable seconds without Float32 noise (e.g. 1.6 instead of 1.600000023841858). */
export function formatSeconds(value:number):string {
 if(!Number.isFinite(value))return '0';
 const cleaned=Number(value.toFixed(4));
 return Object.is(cleaned,-0)?'0':String(cleaned);
}
