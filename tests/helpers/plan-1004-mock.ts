/** #1004 step 0 plan fixture only. A loopback proxy in front of the joined workspace adds a mock
 * single-submit control to the served page. Nothing here is product code or a catalog string:
 * the chip and the rule line are plan text for the owner's layout ruling, and the mock sends nothing. */

export const PLAN_1004_SCRIPT = '/__plan-1004/mock.js';

/** Fixture-only plan copy. The button label reuses the shipped catalog value passed in by the caller. */
export const PLAN_1004_TEXT = {
  en: {chip: '[Plan] submit button placement',
    rule: 'Plan: submit turns on once one question is answered. It sends only the answered sets; unanswered questions stay pending on this page.'},
  ko: {chip: '[계획] 제출 버튼 자리',
    rule: '계획: 질문 하나라도 답하면 제출이 켜져요. 답한 세트만 보내고, 답하지 않은 질문은 이 페이지에 그대로 남아요.'},
} as const;

function mockSource(labels: {en: string; ko: string}): string {
  const text = JSON.stringify(PLAN_1004_TEXT), label = JSON.stringify(labels);
  return `(()=>{
const TEXT=${text},LABEL=${label};
const lang=()=>document.documentElement.lang==='ko'?'ko':'en';
let busy=false;
function place(){
 if(busy)return;busy=true;
 try{
  const nav=document.querySelector('#workspace-interview-answer nav.interview-questions');
  let mock=document.querySelector('[data-plan-1004]');
  if(!nav){mock?.remove();return;}
  const rows=[...nav.querySelectorAll('button.interview-question')],answered=rows.filter(row=>row.hasAttribute('data-answered')).length;
  if(!mock){
   mock=document.createElement('div');mock.setAttribute('data-plan-1004','');mock.setAttribute('translate','no');
   mock.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0 0 6px;padding:6px;border:1px dashed #c47f00;border-radius:6px';
   const chip=document.createElement('span');chip.setAttribute('data-plan-1004-chip','');
   chip.style.cssText='font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:#fff1cc;color:#5c3b00';
   const button=document.createElement('button');button.type='button';button.setAttribute('data-plan-1004-submit','');button.className='primary';
   button.onclick=event=>event.preventDefault();
   const rule=document.createElement('p');rule.setAttribute('data-plan-1004-rule','');rule.style.cssText='flex-basis:100%;margin:0;font-size:11px;line-height:1.3';
   mock.append(chip,button,rule);
  }
  // First in the list column: the form grid places no extra child, and the list is re-drawn on each refresh.
  if(nav.firstElementChild!==mock)nav.prepend(mock);
  const copy=TEXT[lang()],chip=mock.querySelector('[data-plan-1004-chip]'),button=mock.querySelector('[data-plan-1004-submit]'),rule=mock.querySelector('[data-plan-1004-rule]');
  const title=LABEL[lang()]+' ('+answered+'/'+rows.length+')';
  if(chip.textContent!==copy.chip)chip.textContent=copy.chip;
  if(button.textContent!==title)button.textContent=title;
  if(rule.textContent!==copy.rule)rule.textContent=copy.rule;
  if(button.disabled!==(answered===0))button.disabled=answered===0;
  // Own attributes sit outside the observer filter, so writing them cannot re-trigger place().
  if(mock.getAttribute('data-plan-answered')!==String(answered))mock.setAttribute('data-plan-answered',String(answered));
  if(mock.getAttribute('data-plan-total')!==String(rows.length))mock.setAttribute('data-plan-total',String(rows.length));
 }finally{busy=false;}
}
new MutationObserver(place).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-answered','lang','hidden']});
place();
})();`;
}

/** Forward every request to the workspace, keeping it same-origin from the workspace's point of view. */
export function planMockProxy(upstream: string, labels: {en: string; ko: string}) {
  const script = mockSource(labels), target = new URL(upstream);
  type Socket = {path: string; upstream?: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[]};
  const server = Bun.serve<Socket>({hostname: '127.0.0.1', port: 0, idleTimeout: 0,
   // The workspace keeps its window alive over a `/api/live` WebSocket; relay it unchanged.
   websocket: {
    open(ws) {
      const upstream = new WebSocket('ws://' + target.host + ws.data.path, {headers: {Origin: target.origin}} as never);
      upstream.binaryType = 'arraybuffer';ws.data.upstream = upstream;
      upstream.onopen = () => {for (const item of ws.data.queue.splice(0)) upstream.send(item);};
      upstream.onmessage = event => ws.send(event.data as string | ArrayBuffer);
      upstream.onclose = event => ws.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
      upstream.onerror = () => ws.close();
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(message); else ws.data.queue.push(message);
    },
    close(ws) {ws.data.upstream?.close();},
   },
   async fetch(request, self) {
    const url = new URL(request.url);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return self.upgrade(request, {data: {path: url.pathname + url.search, queue: []}}) ? undefined : new Response(null, {status: 400});
    if (url.pathname === PLAN_1004_SCRIPT)
      return new Response(script, {headers: {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'}});
    const headers = new Headers(request.headers);
    headers.delete('host');
    if (headers.has('origin')) headers.set('origin', target.origin);
    if (headers.has('referer')) headers.set('referer', target.origin + new URL(headers.get('referer')!).pathname);
    const response = await fetch(target.origin + url.pathname + url.search, {method: request.method, headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(), redirect: 'manual'});
    const out = new Headers(response.headers);
    out.delete('content-encoding');
    const location = out.get('location');
    if (location?.startsWith(target.origin)) out.set('location', location.slice(target.origin.length));
    if (!(out.get('content-type') ?? '').includes('text/html'))
      return new Response(response.body, {status: response.status, headers: out});
    out.delete('content-length');
    const html = (await response.text()).replace('</head>', `<script src="${PLAN_1004_SCRIPT}" defer></script></head>`);
    return new Response(html, {status: response.status, headers: out});
  }});
  const origin = `http://127.0.0.1:${server.port}`;
  return {origin, rewrite: (href: string) => href.replace(target.origin, origin), stop: () => server.stop(true)};
}
