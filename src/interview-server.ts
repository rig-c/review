import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { appRoot, buildWeb } from './build.ts';
import { createLiveLifecycle, LIVE_PATH } from './live-lifecycle.ts';
import { interviewHeaders, interviewRoutes } from './interview-routes.ts';

export async function startInterviewServer(root: string, output: string, port: number, exitOnClose = false) {
  const capability = randomBytes(32).toString('hex');
  const route = interviewRoutes(root, output, capability);
  const bundle = await buildWeb('interview');
  // The single entry web/index.html and styles.css; main.js is the interview bundle, which opens the interview modal (#708).
  const [html, css] = await Promise.all(['index.html','styles.css'].map(path => readFile(appRoot + 'web/' + path)));
  const live = createLiveLifecycle({label:'review interview', exitOnClose, stopServer:() => server.stop(true)});
  const server = Bun.serve({hostname:'127.0.0.1', port, websocket:live.websocket, async fetch(req, srv) {
    const origin = 'http://127.0.0.1:' + srv.port;
    const {pathname} = new URL(req.url);
    if (pathname === LIVE_PATH && req.method === 'GET') {
      if (req.headers.get('origin') !== origin) return new Response(null, {status:403});
      return live.upgrade(req, srv, interviewHeaders);
    }
    live.onRequestStart(pathname);
    try {
      const response = await route(req, origin);
      if (response) return response;
      const files = new Map([
        ['/', [html, 'text/html; charset=utf-8']],
        ['/index.html', [html, 'text/html; charset=utf-8']],
        ['/styles.css', [css, 'text/css']],
        ['/main.js', [bundle, 'text/javascript']],
      ] as const);
      const file = req.method === 'GET' ? files.get(pathname as '/' | '/index.html' | '/styles.css' | '/main.js') : undefined;
      return file ? new Response(file[0] as BodyInit, {headers:{...interviewHeaders,'Content-Type':file[1]}}) :
        new Response(null, {status:404, headers:interviewHeaders});
    } finally {live.onRequestEnd(pathname);}
  }});
  return {url:'http://127.0.0.1:' + server.port + '/#cap=' + capability, stop:() => {live.stop(); server.stop(true);}};
}

export const interviewUsage = 'Usage: rig-review interview <create-root> --picks-dir <project-relative directory> [--port <n>]';
export async function interviewCommand(args: string[]) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {console.log(interviewUsage); return;}
  const root = args.shift()!;
  let output: string | undefined;
  let port: number | undefined;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === '--picks-dir' && value && output === undefined) output = value;
    else if (flag === '--port' && value && /^\d+$/.test(value) && Number(value) <= 65535 && port === undefined) port = Number(value);
    else throw new Error(interviewUsage);
  }
  if (!output) throw new Error(interviewUsage);
  const running = await startInterviewServer(root, output, port ?? 4317, true);
  console.log(running.url);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => running.stop());
}
