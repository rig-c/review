/** Test-only CDP transport. Production receives ordinary browser gestures only. */
import {existsSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
export async function viewportBrowser(profile:string){
 const cache=join(homedir(),'.cache/ms-playwright'),candidates=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'];
 if(existsSync(cache))for(const dir of readdirSync(cache).sort())for(const suffix of ['chrome-linux/chrome','chrome-linux64/chrome','chrome-headless-shell-linux64/chrome-headless-shell'])candidates.push(join(cache,dir,suffix));
 const binary=candidates.find((v):v is string=>!!v&&existsSync(v));if(!binary)throw Error('No installed Chromium');
 const flags=['--headless=new','--ozone-platform=headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-gpu-compositing','--disable-gpu-rasterization','--force-color-profile=srgb','--disable-lcd-text','--disable-partial-raster','--force-device-scale-factor=1','--renderer-process-limit=2','--num-raster-threads=2','--remote-debugging-port=0','--enable-automation',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--mute-audio'];
 const proc=Bun.spawn([binary,...flags,'about:blank'],{stdout:'ignore',stderr:'pipe',env:{...process.env,DBUS_SESSION_BUS_ADDRESS:'/dev/null',DBUS_SYSTEM_BUS_ADDRESS:'/dev/null',DISPLAY:undefined,WAYLAND_DISPLAY:undefined}});let stderr='',endpoint='';const reader=proc.stderr.getReader();const pump=(async()=>{for(;;){const r=await reader.read();if(r.done)break;stderr+=new TextDecoder().decode(r.value);endpoint||=/DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1]??'';}})();
 for(let n=0;n<400&&!endpoint;n++){if(proc.exitCode!==null)throw Error(stderr);await Bun.sleep(25);}if(!endpoint){proc.kill();throw Error('CDP startup timeout');}
 const socket=new WebSocket(endpoint);await new Promise<void>((ok,no)=>{socket.onopen=()=>ok();socket.onerror=no;});let serial=0;const pending=new Map<number,{ok:(v:any)=>void;no:(e:Error)=>void}>();socket.onmessage=e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);};
 const send=(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>=>new Promise((ok,no)=>{const id=++serial;pending.set(id,{ok,no});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const version=await send('Browser.getVersion'),commandLine=await send('Browser.getBrowserCommandLine');
 async function page(){const {browserContextId}=await send('Target.createBrowserContext');const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const call=(m:string,p:Record<string,unknown>={})=>send(m,p,sessionId);await call('Page.enable');await call('Runtime.enable');
 return {call,evaluate:async<T>(expression:string):Promise<T>=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value as T;},size:(width:number,height:number)=>call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}),goto:(url:string)=>call('Page.navigate',{url}),close:()=>send('Target.disposeBrowserContext',{browserContextId})};}
 return {page,metadata:{binary,flags,version,commandLine},close:async()=>{socket.close();proc.kill();await proc.exited;await pump;}};
}
