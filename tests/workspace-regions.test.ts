import {expect,test} from 'bun:test';
import {workspaceStatusBarMarkup,rigWorkspaceMarkup} from '../src/compare-html.ts';
import {mountViewportPair,viewportPairMarkup} from '../web/viewport-pair.ts';

test('#678 C11 constructs one live message and preserves ordered readouts and optional source',()=>{
 const message='Loading local review package…',readouts=['<span id="load">Loading inputs…</span>','<span id="stale">No rig supplied</span>'];
 const bar=workspaceStatusBarMarkup({message,readouts});
 expect(bar).toBe('<footer class="status-bar"><span id="message" class="status-message" role="status" aria-live="polite">'+message+'</span><div class="status-readouts" aria-label="Status">'+readouts.join('')+'</div></footer>');
 expect(workspaceStatusBarMarkup({message,readouts,source:'<span id="source-hash"></span>'})).toContain('</div><div class="status-source"><span id="source-hash"></span></div></footer>');
 const footer=rigWorkspaceMarkup.slice(rigWorkspaceMarkup.indexOf('<footer'));
 expect([...footer.matchAll(/id="([^"]+)"/g)].map(match=>match[1])).toEqual(['message','player-state','layout-state','renderer-state','layer-state','idle-state','control-state','draft-state','draft-recovery','view-coordinates','source-hash']);
 expect(footer.match(/class="status-bar"/g)?.length).toBe(1);
});

test('#678 caller caption is mounted immediately below the main view and unused footer leaves rig untouched',()=>{
 const captions:HTMLElement[]=[],host={innerHTML:'',after:(node:HTMLElement)=>captions.push(node)};
 mountViewportPair(host as unknown as HTMLElement);expect(host.innerHTML).toBe(viewportPairMarkup);expect(captions).toEqual([]);
 const footer={textContent:'Generated rig · read only'} as HTMLElement;
 mountViewportPair(host as unknown as HTMLElement,{footer});
 expect(host.innerHTML).toBe(viewportPairMarkup);expect(captions).toEqual([footer]);expect(captions[0]).toBe(footer);
});
