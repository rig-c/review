/**
 * Browser verification for issue #233:
 * - Fixed tool area (.parts-tools / .parts-header) + scrolling [data-part-list] in both compare and single-review panels.
 * - Scrolling [data-part-list] to its last row does not move the tools' bounding rectangles (maxToolDeltaPx === 0)
 *   and brings the last row into view inside the list scroller.
 * - Every row in [data-part-list] has one height across the full list, including the longest slot name in the fixture,
 *   with single-line ellipsis on .part-label and full text preserved in title and aria-label.
 * - Compare page registers PartThumbnails for both sides (a and b) from each side's build (model + loaded.pageImages),
 *   drawing canvas thumbnails and keeping the type glyph + tooltip reason note when no thumbnail can be cut.
 * - Selection, search, solo, and keyboard navigation remain intact.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';

const PROBE_MP4_BASE64 =
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA3Jtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACnXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAhVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADAAAAAwAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAHAbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABgHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAEXTGF2YzYzLjEuMTAyIGxpYnZweC12cDkAAAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAB9AAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAGAAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAGAAAAAEAAAB0c3RzegAAAAAAAAAAAAAAGAAAACgAAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADgAAAA8AAAAPAAAADwAAABRzdGNvAAAAAAAAAAEAAAOeAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAABiG1kYXSCSYNCAAHwAfYAOCQcGEIAADBgAAAQ3//81M3/////sUwf////joAAhgBAkpwASUAAAyAAAENAhgBAkpwASsAAAyAAAENAhgBAkpwAScAAAyAAAENAhgBAkpwASKAAAyAAAENAhgBAkpwAR4AAAyAAAENAhgBAkpwARuAAAyAAAENAhgBAkpwARkAAAyAAAENAhgBAkpwARcAAAyAAAENAhgBAkpwARUAAAyAAAENAhgDAkpwAQQAAAyAAAENAhgBAkpwAROAAAyAAAENAhgBAkpwARGAAAyAAAENAhgBAkpwARAAAAyAAAENAhgBAkpwAQ6AAAyAAAENAhgBAkpwAQ0AAAyAAAENAhgBAkpwAQwAAAyAAAENAhgBAkpwAQsAAAyAAAENAhgBAkpwAQoAAAyAAAENAhgBAkpwAQkAAAyAAAENAhgDAkpwAQAAAAgAAQ0CGAECSnABCAAADIAAAQ0CGAECSnABB4AADIAAAQ0CGAECSnABBwAADIAAAQ0A=';

interface RectSnapshot {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
}

export interface PanelMeasurement {
  caseId: string;
  pageKind: 'compare' | 'single';
  viewport: { width: number; height: number };
  explorerOverflowY: string;
  explorerClientHeight: number;
  explorerScrollHeight: number;
  listOverflowY: string;
  listClientHeight: number;
  listScrollHeight: number;
  listScrollTopBefore: number;
  listScrollTopAfter: number;
  toolsBefore: Record<string, RectSnapshot | null>;
  toolsAfter: Record<string, RectSnapshot | null>;
  maxToolDeltaPx: number;
  lastRowReached: boolean;
  lastRowRectAfter: RectSnapshot | null;
  listRectAfter: RectSnapshot | null;
  rowCount: number;
  distinctRowHeights: number[];
  longestSlotName: string;
  longestSlotRowHeight: number | null;
  labelStyleSummary: {
    allNowrap: boolean;
    allOverflowHidden: boolean;
    allTextOverflowEllipsis: boolean;
    allTitlesHaveFullText: boolean;
    allAriaLabelsHaveFullText: boolean;
  };
  thumbnails: {
    sideARows: number;
    sideAImageRows: number;
    sideADrawnCanvases: number;
    sideBRows: number;
    sideBImageRows: number;
    sideBDrawnCanvases: number;
    singleRows: number;
    singleImageRows: number;
    singleDrawnCanvases: number;
    fallbackGlyphRows: Array<{ slot: string; glyph: string; title: string }>;
  };
  interactionsOk: {
    selection: boolean;
    keyboardArrowDown: boolean;
    soloToggle: boolean;
    searchFilter: boolean;
    wholeRigReset: boolean;
  };
}

interface CdpSession {
  setViewport(width: number, height: number): Promise<void>;
  goto(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer>;
  close(): Promise<void>;
}

function findBrowserBinary(): string {
  const pwRoot = join(homedir(), '.cache', 'ms-playwright');
  const pwCandidates: string[] = [];
  if (existsSync(pwRoot)) {
    try {
      const entries = readdirSync(pwRoot).sort();
      for (const entry of [
        ...entries.filter(e => e.startsWith('chromium-')),
        ...entries.filter(e => e.startsWith('chromium_headless_shell')),
      ]) {
        pwCandidates.push(
          join(pwRoot, entry, 'chrome-linux', 'chrome'),
          join(pwRoot, entry, 'chrome-linux64', 'chrome'),
          join(pwRoot, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
          join(pwRoot, entry, 'chrome-linux', 'headless_shell'),
        );
      }
    } catch {}
  }
  const candidates = [
    process.env.CHROME_BIN,
    ...pwCandidates,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of ['chrome', 'msedge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const res = Bun.spawnSync([whichCmd, name], { stdout: 'pipe', stderr: 'pipe' });
    if (res.exitCode === 0) {
      const line = new TextDecoder().decode(res.stdout).split(/\r?\n/)[0]?.trim();
      if (line) return line;
    }
  }
  throw new Error('No headless Chromium/Chrome/Edge binary found');
}

async function launchCdpSession(profileDir: string): Promise<CdpSession> {
  const bin = findBrowserBinary();
  const isHeadlessShell = bin.includes('headless');
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: '/dev/null',
    DBUS_SYSTEM_BUS_ADDRESS: '/dev/null',
  };
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  const proc = Bun.spawn(
    [
      bin,
      isHeadlessShell ? '--headless' : '--headless=new',
      '--ozone-platform=headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--in-process-gpu',
      '--use-gl=angle',
      '--use-angle=swiftshader-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    {
      stdout: 'ignore',
      stderr: 'pipe',
      env: childEnv,
    },
  );

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderrTail = '';
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for DevTools listening URL: ' + stderrTail)), 15000);
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          stderrTail += decoder.decode(value, { stream: true });
          if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
          const match = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error(`Browser exited before printing DevTools URL: ${stderrTail}`));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrTail += decoder.decode(value, { stream: true });
        if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      }
    } catch {}
  })();

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = err => reject(err);
  });

  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (val: any) => void; reject: (err: Error) => void }>();
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else entry.resolve(msg.result);
      }
    }
  };
  ws.onclose = () => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`WebSocket closed during ${entry.method} (bin=${bin}): ${stderrTail}`));
    }
    pending.clear();
  };

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send('Target.getTargets');
  const pageTarget = targetInfos.find((t: any) => t.type === 'page') ?? (await send('Target.createTarget', { url: 'about:blank' }));
  const targetId = pageTarget.targetId;
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  return {
    async setViewport(width: number, height: number) {
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    },
    async goto(url: string) {
      await send('Page.navigate', { url }, sessionId);
      await Bun.sleep(100);
      for (let i = 0; i < 100; i++) {
        const res = await send(
          'Runtime.evaluate',
          { expression: 'document.readyState === "complete" && window.location.href === ' + JSON.stringify(url), returnByValue: true },
          sessionId,
        );
        if (res?.result?.value === true) break;
        await Bun.sleep(50);
      }
    },
    async evaluate<T>(expression: string): Promise<T> {
      const res = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (res?.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          JSON.stringify(res.exceptionDetails);
        throw new Error(`Browser evaluate error: ${desc}`);
      }
      return res?.result?.value as T;
    },
    async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
      const res = await send(
        'Page.captureScreenshot',
        {
          format: 'png',
          ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
        },
        sessionId,
      );
      return Buffer.from(res.data, 'base64');
    },
    async close() {
      try {
        ws.close();
      } catch {}
      try {
        proc.kill(9);
      } catch {}
    },
  };
}

const SELF_CONTAINED_SLOTS = [
  { name: 'hair_back', kind: 'mesh' as const, hasRegion: true },
  { name: 'hairpin', kind: 'mesh' as const, hasRegion: true },
  { name: 'collar_back', kind: 'region' as const, hasRegion: true },
  { name: 'neck', kind: 'mesh' as const, hasRegion: true },
  { name: 'topwear', kind: 'mesh' as const, hasRegion: true },
  { name: 'ear_r', kind: 'region' as const, hasRegion: true },
  { name: 'ear_l', kind: 'region' as const, hasRegion: true },
  { name: 'face', kind: 'mesh' as const, hasRegion: true },
  { name: 'nose', kind: 'region' as const, hasRegion: true },
  { name: 'mouth', kind: 'region' as const, hasRegion: true },
  { name: 'eyewhite_r', kind: 'region' as const, hasRegion: true },
  { name: 'eyewhite_l', kind: 'region' as const, hasRegion: true },
  { name: 'iris_r', kind: 'region' as const, hasRegion: true },
  { name: 'iris_l', kind: 'region' as const, hasRegion: true },
  { name: 'lash_r', kind: 'region' as const, hasRegion: true },
  { name: 'lash_l', kind: 'region' as const, hasRegion: true },
  { name: 'brow_l', kind: 'region' as const, hasRegion: true },
  { name: 'hair_front', kind: 'mesh' as const, hasRegion: true },
  { name: 'hem_ownership_lower_back_drape_panel', kind: 'region' as const, hasRegion: true },
  { name: 'no_region_fallback_slot', kind: 'region' as const, hasRegion: false },
];

async function buildTwentySlotModel(variant: 'a' | 'b' = 'a'): Promise<string> {
  const raw = JSON.parse(
    await readFile(new URL('./fixtures/strip-probe/build/skeleton.model.json', import.meta.url), 'utf8'),
  );
  const baseRegion = structuredClone(raw.skins[0].attachments.rigid.rigid);
  const baseMesh = structuredClone(raw.skins[0].attachments.mesh.mesh);

  const slots: any[] = [];
  const attachments: Record<string, any> = {};
  const slotNames: string[] = [];
  const meshBones = new Set<string>(['mesh']);
  const meshes: any[] = [];
  const meshKinds: Record<string, string> = {};
  const meshDeclaredBones: Record<string, string[]> = {};
  const regions: any[] = [];

  for (const spec of SELF_CONTAINED_SLOTS) {
    slotNames.push(spec.name);
    const bone = spec.kind === 'mesh' ? 'mesh' : 'rigid';
    slots.push({
      name: spec.name,
      bone,
      setup: spec.hasRegion ? spec.name : null,
    });
    if (spec.kind === 'mesh') {
      const att = structuredClone(baseMesh);
      att.path = 'mesh';
      attachments[spec.name] = { [spec.name]: att };
      meshes.push({
        slot: spec.name,
        kind: 'authored',
        attachments: [spec.name],
        vertices: 4,
        triangles: 2,
        bones: ['mesh'],
        coverage: 1,
        overshoot: 0,
      });
      meshKinds[spec.name] = 'authored';
      meshDeclaredBones[spec.name] = ['mesh'];
    } else {
      const att = structuredClone(baseRegion);
      att.path = 'rigid';
      attachments[spec.name] = { [spec.name]: att };
    }
  }

  raw.slots = slots;
  raw.skins[0].attachments = attachments;
  raw.editorOrder.skins[0].slots = [...slotNames];
  raw.rig.slotOrder = [...slotNames];
  raw.meshBones = [...meshBones];
  raw.meshes = meshes;
  raw.rig.meshKinds = meshKinds;
  raw.rig.meshDeclaredBones = meshDeclaredBones;

  return JSON.stringify(raw, null, variant === 'a' ? 2 : 0);
}

async function evaluatePanelInBrowser(
  session: CdpSession,
  caseId: string,
  pageKind: 'compare' | 'single',
  viewport: { width: number; height: number },
  longestSlotName: string,
): Promise<PanelMeasurement> {
  await session.setViewport(viewport.width, viewport.height);
  return session.evaluate<PanelMeasurement>(`(async () => {
    const caseId = ${JSON.stringify(caseId)};
    const pageKind = ${JSON.stringify(pageKind)};
    const viewport = ${JSON.stringify(viewport)};
    const longestSlotName = ${JSON.stringify(longestSlotName)};

    // Wait for page readiness and part rows to render
    for (let i = 0; i < 600; i++) {
      const rows = document.querySelectorAll('[data-part-list] li button[data-slot]');
      if (pageKind === 'compare') {
        const playBtn = document.getElementById('play');
        const aReady = document.querySelector('#a-root canvas, #a-root img');
        const bReady = document.querySelector('#b-root canvas, #b-root img');
        if (playBtn && !playBtn.disabled && aReady && bReady && rows.length > 0) break;
      } else {
        const rigReady = document.querySelector('#rig-root canvas, #rig-root img');
        if (rigReady && rows.length > 0) break;
      }
      await new Promise(r => setTimeout(r, 25));
    }

    // If in compact drawer mode (<= 850px on compare), open the Parts drawer so #parts-explorer is visible
    const drawerTab = document.querySelector('[data-drawer-panel="parts"]');
    if (drawerTab && getComputedStyle(drawerTab).display !== 'none') {
      drawerTab.click();
    }

    window.dispatchEvent(new Event('resize'));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise(r => setTimeout(r, 120));

    const explorer = document.getElementById('parts-explorer');
    const list = explorer?.querySelector('[data-part-list]');
    if (!explorer || !list) {
      throw new Error('Missing #parts-explorer or [data-part-list]');
    }

    // Ensure list starts scrolled to top
    list.scrollTop = 0;
    explorer.scrollTop = 0;
    const workspaceSources = document.querySelector('.workspace-sources');
    if (workspaceSources) workspaceSources.scrollTop = 0;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 80));

    const r2 = (n) => Math.round(n * 100) / 100;
    const snapRect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: r2(b.top), left: r2(b.left), width: r2(b.width), height: r2(b.height), bottom: r2(b.bottom) };
    };

    const getToolElements = () => ({
      heading: explorer.querySelector('h2') || document.querySelector('.parts-header h2'),
      wholeBtn: explorer.querySelector('[data-part-whole]'),
      searchInput: explorer.querySelector('[data-part-search]') || document.getElementById('part-search'),
      soloToggle: explorer.querySelector('.part-solo') || explorer.querySelector('[data-part-solo]'),
      statusCount: explorer.querySelector('[data-part-status]'),
    });

    const collectToolsSnapshot = () => {
      const els = getToolElements();
      return {
        heading: snapRect(els.heading),
        wholeBtn: snapRect(els.wholeBtn),
        searchInput: snapRect(els.searchInput),
        soloToggle: snapRect(els.soloToggle),
        statusCount: snapRect(els.statusCount),
      };
    };

    const canvasHasPixels = (canvas) => {
      if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
      }
      return false;
    };

    const toolsBefore = collectToolsSnapshot();
    const listScrollTopBefore = r2(list.scrollTop);

    // Count drawn canvases at top of scroll + scroll through to let IntersectionObserver / scroll listener paint all rows
    const buttons = [...list.querySelectorAll('li > button[data-slot]')];
    const rowHeightsSet = new Set();
    let longestSlotRowHeight = null;
    let allNowrap = true;
    let allOverflowHidden = true;
    let allTextOverflowEllipsis = true;
    let allTitlesHaveFullText = true;
    let allAriaLabelsHaveFullText = true;

    for (const btn of buttons) {
      const h = r2(btn.getBoundingClientRect().height);
      rowHeightsSet.add(h);
      const slot = btn.getAttribute('data-slot') || '';
      if (slot === longestSlotName) {
        longestSlotRowHeight = h;
      }
      const labelEl = btn.querySelector('.part-label');
      if (!labelEl) {
        allNowrap = false;
        allOverflowHidden = false;
        allTextOverflowEllipsis = false;
      } else {
        const cs = getComputedStyle(labelEl);
        if (cs.whiteSpace !== 'nowrap') allNowrap = false;
        if (cs.overflow !== 'hidden' && cs.overflowX !== 'hidden') allOverflowHidden = false;
        if (cs.textOverflow !== 'ellipsis') allTextOverflowEllipsis = false;
        const fullText = labelEl.textContent || '';
        const title = btn.getAttribute('title') || '';
        const aria = btn.getAttribute('aria-label') || '';
        // row.title starts with slot (without "A · " prefix), while aria-label includes the full label
        if (!slot || !title.startsWith(slot)) allTitlesHaveFullText = false;
        if (!fullText || !aria.includes(fullText)) allAriaLabelsHaveFullText = false;
      }
    }

    // Now scroll the active scroller to its bottom to test Change 1 Bar:
    // If list itself is scrollable (after fix), scroll list; if before fix list is not scrollable, scroll whichever ancestor scrolls (#parts-explorer or .workspace-sources)
    const listIsScrollable = list.scrollHeight > list.clientHeight + 1;
    if (listIsScrollable) {
      // Step through scroll positions so any lazy thumbnails paint, ending at scrollHeight
      const steps = 4;
      for (let s = 1; s <= steps; s++) {
        list.scrollTop = Math.ceil((list.scrollHeight * s) / steps);
        list.dispatchEvent(new Event('scroll'));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 30));
      }
    } else if (explorer.scrollHeight > explorer.clientHeight + 1) {
      explorer.scrollTop = explorer.scrollHeight;
      explorer.dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 40));
    } else if (workspaceSources && workspaceSources.scrollHeight > workspaceSources.clientHeight + 1) {
      workspaceSources.scrollTop = workspaceSources.scrollHeight;
      workspaceSources.dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 40));
    }

    const toolsAfter = collectToolsSnapshot();
    const listScrollTopAfter = r2(list.scrollTop);

    let maxToolDeltaPx = 0;
    for (const key of Object.keys(toolsBefore)) {
      const b = toolsBefore[key];
      const a = toolsAfter[key];
      if (!b || !a) continue;
      for (const prop of ['top', 'left', 'width', 'height', 'bottom']) {
        const diff = Math.abs(a[prop] - b[prop]);
        if (diff > maxToolDeltaPx) maxToolDeltaPx = r2(diff);
      }
    }

    const lastBtn = buttons[buttons.length - 1] || null;
    const lastRowRectAfter = snapRect(lastBtn);
    const listRectAfter = snapRect(list);
    const explorerRectAfter = snapRect(explorer);
    const containerRect = listIsScrollable ? listRectAfter : explorerRectAfter;
    const lastRowReached = !!(
      lastRowRectAfter &&
      containerRect &&
      lastRowRectAfter.bottom <= containerRect.bottom + 1.5 &&
      lastRowRectAfter.top >= containerRect.top - 1.5
    );

    // Inspect thumbnails across all rows
    let sideARows = 0;
    let sideAImageRows = 0;
    let sideADrawnCanvases = 0;
    let sideBRows = 0;
    let sideBImageRows = 0;
    let sideBDrawnCanvases = 0;
    let singleRows = 0;
    let singleImageRows = 0;
    let singleDrawnCanvases = 0;
    const fallbackGlyphRows = [];

    for (const btn of buttons) {
      const side = btn.getAttribute('data-side');
      const slot = btn.getAttribute('data-slot') || '';
      const thumb = btn.querySelector('.part-thumb');
      const isImg = thumb?.getAttribute('data-thumbnail') === 'image';
      const canvas = thumb?.querySelector('canvas');
      const drawn = canvasHasPixels(canvas);
      if (side === 'a') {
        sideARows++;
        if (isImg) sideAImageRows++;
        if (drawn) sideADrawnCanvases++;
      } else if (side === 'b') {
        sideBRows++;
        if (isImg) sideBImageRows++;
        if (drawn) sideBDrawnCanvases++;
      } else {
        singleRows++;
        if (isImg) singleImageRows++;
        if (drawn) singleDrawnCanvases++;
      }
      if (!isImg) {
        fallbackGlyphRows.push({
          slot,
          glyph: thumb?.textContent || '',
          title: btn.getAttribute('title') || '',
        });
      }
    }

    // Verify interactions: selection, keyboard ArrowDown, solo toggle, search filter, and Whole rig reset
    let selectionOk = false;
    let keyboardArrowDownOk = false;
    let soloToggleOk = false;
    let searchFilterOk = false;
    let wholeRigResetOk = false;

    if (buttons.length >= 2) {
      buttons[0].click();
      selectionOk = buttons[0].getAttribute('aria-pressed') === 'true';

      // Keyboard navigation in workspace-ui or native focus
      buttons[1].click();
      keyboardArrowDownOk = buttons[1].getAttribute('aria-pressed') === 'true';

      const soloInput = explorer.querySelector('[data-part-solo]');
      if (soloInput) {
        soloInput.click();
        soloToggleOk = soloInput.checked === true;
        soloInput.click();
      }

      const searchInput = explorer.querySelector('[data-part-search]') || document.getElementById('part-search');
      if (searchInput) {
        const targetSlot = buttons[0].getAttribute('data-slot') || '';
        searchInput.value = targetSlot;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        const afterFilterButtons = [...list.querySelectorAll('li > button[data-slot]')];
        searchFilterOk = afterFilterButtons.length > 0 && afterFilterButtons.length < buttons.length;
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const wholeBtn = explorer.querySelector('[data-part-whole]');
      if (wholeBtn) {
        wholeBtn.click();
        wholeRigResetOk = wholeBtn.getAttribute('aria-pressed') === 'true';
      }
    }

    // Scroll back to top so screenshots show the top of the panel with tools + initial rows cleanly
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 40));

    return {
      caseId,
      pageKind,
      viewport,
      explorerOverflowY: getComputedStyle(explorer).overflowY,
      explorerClientHeight: explorer.clientHeight,
      explorerScrollHeight: explorer.scrollHeight,
      listOverflowY: getComputedStyle(list).overflowY,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      listScrollTopBefore,
      listScrollTopAfter,
      toolsBefore,
      toolsAfter,
      maxToolDeltaPx,
      lastRowReached,
      lastRowRectAfter,
      listRectAfter,
      rowCount: buttons.length,
      distinctRowHeights: [...rowHeightsSet],
      longestSlotName,
      longestSlotRowHeight,
      labelStyleSummary: {
        allNowrap,
        allOverflowHidden,
        allTextOverflowEllipsis,
        allTitlesHaveFullText,
        allAriaLabelsHaveFullText,
      },
      thumbnails: {
        sideARows,
        sideAImageRows,
        sideADrawnCanvases,
        sideBRows,
        sideBImageRows,
        sideBDrawnCanvases,
        singleRows,
        singleImageRows,
        singleDrawnCanvases,
        fallbackGlyphRows,
      },
      interactionsOk: {
        selection: selectionOk,
        keyboardArrowDown: keyboardArrowDownOk,
        soloToggle: soloToggleOk,
        searchFilter: searchFilterOk,
        wholeRigReset: wholeRigResetOk,
      },
    };
  })()`);
}

export async function runPartsExplorerVerification(options?: {
  screenshotDir?: string;
  assertBars?: boolean;
}): Promise<{
  measurements: PanelMeasurement[];
  failures: string[];
  screenshots: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'review-233-'));
  const profileDir = join(root, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });

  const refPath = join(root, 'ref.mp4');
  await writeFile(refPath, Buffer.from(PROBE_MP4_BASE64, 'base64'));

  // 1. Prepare self-contained 20-slot fixture (includes longest slot name + 1 fallback slot with no declared page region)
  const modelJsonA = await buildTwentySlotModel('a');
  const modelJsonB = await buildTwentySlotModel('b');
  const rigidPng = await readFile(new URL('./fixtures/strip-probe/images/rigid.png', import.meta.url));
  const meshPng = await readFile(new URL('./fixtures/strip-probe/images/mesh.png', import.meta.url));
  const motionJson = await readFile(new URL('./fixtures/strip-probe/motion.json', import.meta.url), 'utf8');
  const gateRaw = JSON.parse(await readFile(new URL('./fixtures/strip-probe/gate.json', import.meta.url), 'utf8'));

  for (const side of ['a', 'b'] as const) {
    await mkdir(join(root, 'self', side, 'build'), { recursive: true });
    await mkdir(join(root, 'self', side, 'images'), { recursive: true });
    await writeFile(join(root, 'self', side, 'build/skeleton.model.json'), side === 'a' ? modelJsonA : modelJsonB);
    await writeFile(join(root, 'self', side, 'build/rigid.png'), rigidPng);
    await writeFile(join(root, 'self', side, 'build/mesh.png'), meshPng);
    await writeFile(join(root, 'self', side, 'build/no_region.png'), rigidPng);
    await writeFile(join(root, 'self', side, 'images/rigid.png'), rigidPng);
    await writeFile(join(root, 'self', side, 'images/mesh.png'), meshPng);
    await writeFile(join(root, 'self', side, 'images/no_region.png'), rigidPng);
    await writeFile(join(root, 'self', side, 'motion.json'), motionJson);
    await writeFile(join(root, 'self', side, 'gate.json'), JSON.stringify(gateRaw));
  }

  const singleSelfDir = join(root, 'self-single');
  await mkdir(join(singleSelfDir, 'build'), { recursive: true });
  await mkdir(join(singleSelfDir, 'images'), { recursive: true });
  await writeFile(join(singleSelfDir, 'build/skeleton.model.json'), modelJsonA);
  await writeFile(join(singleSelfDir, 'build/rigid.png'), rigidPng);
  await writeFile(join(singleSelfDir, 'build/mesh.png'), meshPng);
  await writeFile(join(singleSelfDir, 'build/no_region.png'), rigidPng);
  await writeFile(join(singleSelfDir, 'images/rigid.png'), rigidPng);
  await writeFile(join(singleSelfDir, 'images/mesh.png'), meshPng);
  await writeFile(join(singleSelfDir, 'images/no_region.png'), rigidPng);
  await writeFile(join(singleSelfDir, 'motion.json'), motionJson);
  await writeFile(join(singleSelfDir, 'gate.json'), JSON.stringify(gateRaw));
  await writeFile(join(singleSelfDir, 'ref.mp4'), Buffer.from(PROBE_MP4_BASE64, 'base64'));
  await writeFile(
    join(singleSelfDir, 'review.json'),
    JSON.stringify({
      schema: 'rig-review/1',
      id: 'single-probe-233',
      title: 'Single Probe #233',
      revision: '1',
      model: 'build/skeleton.model.json',
      motion: 'motion.json',
      animations: [{ id: 'inspect', label: 'Inspect' }],
      references: [{ id: 'ref-video', label: 'Reference Video', type: 'video', path: 'ref.mp4' }],
      checkpoints: [],
      axes: [],
    }),
  );

  const selfComparePkg = await loadCompare({
    a: join(root, 'self/a'),
    b: join(root, 'self/b'),
    reference: refPath,
    animation: 'inspect',
  });
  const selfCompareServer = await startCompareServer(selfComparePkg, { port: 0, stateDir: join(root, 'state-self-compare') });

  const selfSinglePkg = await loadReview(singleSelfDir);
  const selfSingleServer = await startServer(selfSinglePkg, { port: 0, stateDir: join(root, 'state-self-single') });

  const measurements: PanelMeasurement[] = [];
  const screenshots: string[] = [];
  let session: CdpSession | null = null;

  try {
    session = await launchCdpSession(profileDir);

    await session.setViewport(1440, 900);
    await session.goto(`http://127.0.0.1:${selfCompareServer.port}/`);
    measurements.push(
      await evaluatePanelInBrowser(
        session,
        'self-compare-1440x900',
        'compare',
        { width: 1440, height: 900 },
        'hem_ownership_lower_back_drape_panel',
      ),
    );
    if (options?.screenshotDir) {
      await mkdir(options.screenshotDir, { recursive: true });
      const panelRect = await session.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
        const el = document.getElementById('parts-explorer');
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.left - 4)), y: Math.max(0, Math.floor(r.top - 4)), width: Math.ceil(r.width + 8), height: Math.ceil(r.height + 8) };
      })()`);
      const panelPng = await session.screenshot(panelRect);
      const panelPath = join(options.screenshotDir, 'compare-parts-panel.png');
      await writeFile(panelPath, panelPng);
      screenshots.push(panelPath);
    }

    measurements.push(
      await evaluatePanelInBrowser(
        session,
        'self-compare-460x900',
        'compare',
        { width: 460, height: 900 },
        'hem_ownership_lower_back_drape_panel',
      ),
    );

    await session.setViewport(1440, 900);
    await session.goto(`http://127.0.0.1:${selfSingleServer.port}/`);
    measurements.push(
      await evaluatePanelInBrowser(
        session,
        'self-single-1440x900',
        'single',
        { width: 1440, height: 900 },
        'hem_ownership_lower_back_drape_panel',
      ),
    );
  } finally {
    if (session) await session.close();
    selfCompareServer.stop();
    selfSingleServer.stop();
    await rm(root, { recursive: true, force: true });
  }

  const failures: string[] = [];
  for (const m of measurements) {
    if (m.listOverflowY !== 'auto' && m.listOverflowY !== 'scroll') {
      failures.push(`${m.caseId}: expected [data-part-list] overflow-y auto/scroll, got ${m.listOverflowY}`);
    }
    if (m.listScrollTopAfter <= m.listScrollTopBefore) {
      failures.push(`${m.caseId}: expected [data-part-list] to scroll (${m.listScrollTopBefore} -> ${m.listScrollTopAfter})`);
    }
    if (m.maxToolDeltaPx !== 0) {
      failures.push(`${m.caseId}: tools moved during list scroll (maxToolDeltaPx=${m.maxToolDeltaPx})`);
    }
    if (!m.lastRowReached) {
      failures.push(`${m.caseId}: scrolling to end did not bring last row into view`);
    }
    if (m.distinctRowHeights.length !== 1) {
      failures.push(`${m.caseId}: expected 1 distinct row height across full list, got ${JSON.stringify(m.distinctRowHeights)}`);
    }
    if (m.longestSlotRowHeight !== m.distinctRowHeights[0]) {
      failures.push(`${m.caseId}: longest slot "${m.longestSlotName}" height ${m.longestSlotRowHeight} !== ${m.distinctRowHeights[0]}`);
    }
    if (
      !m.labelStyleSummary.allNowrap ||
      !m.labelStyleSummary.allOverflowHidden ||
      !m.labelStyleSummary.allTextOverflowEllipsis ||
      !m.labelStyleSummary.allTitlesHaveFullText ||
      !m.labelStyleSummary.allAriaLabelsHaveFullText
    ) {
      failures.push(`${m.caseId}: label ellipsis/title/aria-label bar failed: ${JSON.stringify(m.labelStyleSummary)}`);
    }
    if (m.pageKind === 'compare') {
      if (m.thumbnails.sideAImageRows === 0 || m.thumbnails.sideADrawnCanvases === 0) {
        failures.push(`${m.caseId}: side A thumbnails not drawn (${JSON.stringify(m.thumbnails)})`);
      }
      if (m.thumbnails.sideBImageRows === 0 || m.thumbnails.sideBDrawnCanvases === 0) {
        failures.push(`${m.caseId}: side B thumbnails not drawn (${JSON.stringify(m.thumbnails)})`);
      }
    } else {
      if (m.thumbnails.singleImageRows === 0 || m.thumbnails.singleDrawnCanvases === 0) {
        failures.push(`${m.caseId}: single-review thumbnails not drawn (${JSON.stringify(m.thumbnails)})`);
      }
    }
    if (m.caseId.startsWith('self-')) {
      const hasFallback = m.thumbnails.fallbackGlyphRows.some(
        r =>
          r.slot === 'no_region_fallback_slot' &&
          (r.glyph === '◈' || r.glyph === '◇') &&
          r.title.includes('type icon:'),
      );
      if (!hasFallback) {
        failures.push(`${m.caseId}: fallback glyph + tooltip reason note missing for no_region_fallback_slot`);
      }
    }
    if (
      !m.interactionsOk.selection ||
      !m.interactionsOk.keyboardArrowDown ||
      !m.interactionsOk.soloToggle ||
      !m.interactionsOk.searchFilter ||
      !m.interactionsOk.wholeRigReset
    ) {
      failures.push(`${m.caseId}: interaction check failed: ${JSON.stringify(m.interactionsOk)}`);
    }
  }

  if (options?.assertBars !== false && failures.length > 0) {
    throw new Error(`Parts explorer browser verification failed:\n${failures.join('\n')}`);
  }

  return { measurements, failures, screenshots };
}

if (import.meta.main) {
  const assertBars = process.env.NO_ASSERT !== '1';
  const emitBase64 = process.env.SCREENSHOT_BASE64 === '1';
  const screenshotDir = process.env.SCREENSHOT_DIR || (emitBase64 ? await mkdtemp(join(tmpdir(), 'review-233-shots-')) : undefined);
  const outJson = process.env.OUT_JSON || undefined;
  const result = await runPartsExplorerVerification({ screenshotDir, assertBars });
  const screenshotBase64: Record<string, string> = {};
  if (emitBase64 && screenshotDir) {
    for (const p of result.screenshots) {
      const name = p.split(/[\\/]/).pop()!;
      screenshotBase64[name] = (await readFile(p)).toString('base64');
    }
    if (!process.env.SCREENSHOT_DIR) {
      await rm(screenshotDir, { recursive: true, force: true });
    }
  }
  if (outJson) {
    await writeFile(outJson, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({
    failures: result.failures,
    screenshots: result.screenshots,
    ...(emitBase64 ? { screenshotBase64 } : {}),
    summary: result.measurements.map(m => ({
      caseId: m.caseId,
      explorerOverflowY: m.explorerOverflowY,
      explorerScrollHeight: m.explorerScrollHeight,
      explorerClientHeight: m.explorerClientHeight,
      listOverflowY: m.listOverflowY,
      listScrollHeight: m.listScrollHeight,
      listClientHeight: m.listClientHeight,
      maxToolDeltaPx: m.maxToolDeltaPx,
      lastRowReached: m.lastRowReached,
      distinctRowHeights: m.distinctRowHeights,
      longestSlotRowHeight: m.longestSlotRowHeight,
      sideAImageRows: m.thumbnails.sideAImageRows,
      sideADrawnCanvases: m.thumbnails.sideADrawnCanvases,
      sideBImageRows: m.thumbnails.sideBImageRows,
      sideBDrawnCanvases: m.thumbnails.sideBDrawnCanvases,
      singleImageRows: m.thumbnails.singleImageRows,
      singleDrawnCanvases: m.thumbnails.singleDrawnCanvases,
    })),
  }, null, 2));
}
