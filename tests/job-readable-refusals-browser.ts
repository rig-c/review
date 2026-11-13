/** #815 ordinary Nova: real job authentication and the existing bootstrap notice, EN/KO.
 * Synthetic package fixture; no producer conformance or closed-host availability claim. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const at = Bun.argv.indexOf('--out');
const output = resolve(at < 0 ? 'artifacts/815' : Bun.argv[at + 1]!);
await mkdir(output, {recursive: true});
const fixture = await realJobWindowFixture();
const cases: unknown[] = [];
try {
  await fixture.publish();
  for (const language of ['en', 'ko'] as const) {
    const profile = join(output, 'profile-' + language);
    await mkdir(profile);
    const network: {path: string; status: number}[] = [];
    let send: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
    const page = await launchCdpSession(profile, {onEvent(event, command) {
      send = command;
      if (event.method !== 'Network.responseReceived') return;
      const response = event.params?.response as {url?: string; status: number} | undefined;
      if (response?.url?.includes('/jobs/')) network.push({path: new URL(response.url).pathname, status: response.status});
    }});
    try {
      await send!('Network.enable');
      await page.setViewport(1600, 1000);
      const url = new URL(fixture.host.ownerUrl);
      url.searchParams.set('lang', language);
      const copied = url.origin + url.pathname + url.search;
      await page.goto(copied);
      const expected = (language === 'en' ? enCatalog : koCatalog)['JOB_CAPABILITY_REQUIRED']!;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !await page.evaluate(`document.querySelector('body > [role=status]')?.textContent === ${JSON.stringify(expected)}`)) await Bun.sleep(25);
      const notice = await page.evaluate<any>(`(()=>{const n=document.querySelector('body > [role=status]');if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {text:n.textContent,x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,hit:document.elementFromPoint(r.x+1,r.y+1)===n,language:document.documentElement.lang};})()`);
      await writeFile(join(output, 'fresh-' + language + '.json'), JSON.stringify({notice, network}, null, 2) + '\n');
      await writeFile(join(output, 'fresh-' + language + '.png'), await page.screenshot());
      assert.ok(notice, 'bootstrap notice exists');
      assert.equal(notice.text, expected);
      assert.equal(notice.language, language);
      assert.ok(notice.width > 0 && notice.height > 0 && notice.x >= 0 && notice.y >= 0 && notice.y + notice.height <= 1000, 'notice is inside the viewport');
      assert.notEqual(notice.display, 'none');
      assert.equal(notice.visibility, 'visible');
      assert.equal(notice.hit, true, 'notice is not covered by the empty app');
      assert.equal(network[0]?.status, 200);
      assert.ok(network.some(row => row.path.endsWith('/ui/displayed') && row.status === 403));
      cases.push({language, state: 'fresh-no-storage', notice});
      // Positive control: capability handoff and same-tab reload still display the shared workspace.
      for (const target of [url.href, copied]) {
        await page.goto('about:blank');
        await page.goto(target);
        const until = Date.now() + 20000;
        while (Date.now() < until && !await page.evaluate(`document.body.dataset.ready === 'true'`)) await Bun.sleep(25);
        assert.equal(await page.evaluate(`document.body.dataset.ready`), 'true');
        assert.equal(await page.evaluate(`document.querySelectorAll('body > [role=status]').length`), 0);
      }
      await writeFile(join(output, 'reload-' + language + '.png'), await page.screenshot());
      cases.push({language, state: 'same-tab-reload', ready: true});
    } finally { await page.close(); }
  }
} finally {
  await fixture.close();
  await writeFile(join(output, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
}
