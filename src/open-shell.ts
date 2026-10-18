/** POSIX copy/paste command words; execution itself always uses argument arrays. */
export function shellWord(value:string):string{return "'"+value.replace(/'/g,"'\\''")+"'";}
