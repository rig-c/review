/**
 * Log redaction for the `#cap=` write capability. The handoff URL is the one place the capability
 * travels, and it belongs on the terminal of the person who ran the command; output meant for a
 * log (the install smoke, which CI publishes) carries the URL with the fragment value replaced.
 */
export const REDACTED_CAPABILITY='#cap=<redacted>';
const capabilityValue=/#cap=[^\s'"<>]+/g;
/** Replace every `#cap=` value in `text` with `<redacted>`. Idempotent: a redacted fragment is left as is. */
export function redactCapability(text:string):string{return text.replace(capabilityValue,REDACTED_CAPABILITY);}
/** True when `text` still carries a `#cap=` value other than the redaction marker. */
export function leaksCapability(text:string):boolean{return new RegExp(capabilityValue.source).test(text);}
