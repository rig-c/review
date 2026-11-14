/** Test-bundle instrumentation stays inside the existing per-publication mount closure. */
export function instrumentRigMount(source:string, probe:string):string {
 const anchor='return {dispose:disposeScreen};';
 if(source.split(anchor).length!==2)throw Error('RIG_MOUNT_PROBE_ANCHOR');
 return source.replace(anchor,probe+'\n'+anchor);
}
