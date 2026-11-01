import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PosedFrame, SlotIdentitySnapshot } from '@rig-c/play';
import {
  PartInspection,
  orderedParts,
  partCatalog,
  partIdentity,
  type PartExplorer,
  type PartPlayer,
} from '../web/part-selection.ts';
import { PartThumbnails, pageRegionTable } from '../web/part-thumbnails.ts';

function cssRuleMap(css: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /([^{}@]+)\{([^{}]+)\}/g;
  for (const match of stripped.matchAll(ruleRe)) {
    const selectors = match[1]!.split(',').map(s => s.trim()).filter(Boolean);
    const body = match[2]!.trim();
    for (const sel of selectors) {
      map.set(sel, [...(map.get(sel) ?? []), body]);
    }
  }
  return map;
}

test('Change 1 & 4: compare and single-review HTML separate fixed tools from the scrolling [data-part-list]', () => {
  const compareHtml = readFileSync(new URL('../web/compare.html', import.meta.url), 'utf8');
  const singleHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

  // Compare panel: heading, Whole rig button, search label + input, Solo toggle, and status count are inside .parts-tools before <ul data-part-list>
  const compareExplorerMatch = compareHtml.match(/<aside id="parts-explorer"[^>]*>([\s\S]*?)<\/aside>/);
  expect(compareExplorerMatch).not.toBeNull();
  const compareInner = compareExplorerMatch![1]!;
  const compareToolsMatch = compareInner.match(/<div class="parts-tools">([\s\S]*?)<\/div><ul data-part-list/);
  expect(compareToolsMatch).not.toBeNull();
  const compareTools = compareToolsMatch![1]!;
  expect(compareTools).toContain('<h2>PARTS</h2>');
  expect(compareTools).toContain('data-part-whole');
  expect(compareTools).toContain('id="part-search"');
  expect(compareTools).toContain('data-part-solo');
  expect(compareTools).toContain('data-part-status');

  // Single-review panel: .left-header.parts-header holds PARTS + #part-search, and #parts-explorer wraps Whole rig, Solo toggle, and status count in .parts-tools before <ul data-part-list>
  expect(singleHtml).toContain('<div class="left-header parts-header"><h2>PARTS</h2><input id="part-search"');
  const singleExplorerMatch = singleHtml.match(/<aside id="parts-explorer"[^>]*>([\s\S]*?)<\/aside>/);
  expect(singleExplorerMatch).not.toBeNull();
  const singleInner = singleExplorerMatch![1]!;
  const singleToolsMatch = singleInner.match(/<div class="parts-tools">([\s\S]*?)<\/div><ul data-part-list/);
  expect(singleToolsMatch).not.toBeNull();
  const singleTools = singleToolsMatch![1]!;
  expect(singleTools).toContain('data-part-whole');
  expect(singleTools).toContain('data-part-solo');
  expect(singleTools).toContain('data-part-status');
});

test('Change 1, 2, 3, 4: compare.css and styles.css enforce fixed tool area, scrolling list, one-line ellipsis labels, and one row height', () => {
  const compareCss = readFileSync(new URL('../web/compare.css', import.meta.url), 'utf8');
  const singleCss = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

  for (const [name, css] of [
    ['compare.css', compareCss],
    ['styles.css', singleCss],
  ] as const) {
    const rules = cssRuleMap(css);
    const joinRules = (sel: string) => (rules.get(sel) ?? []).join(';');

    expect(joinRules('.parts-explorer')).toContain('display:flex');
    expect(joinRules('.parts-explorer')).toContain('flex-direction:column');
    expect(joinRules('.parts-explorer')).toContain('overflow:hidden');
    expect(joinRules('.workspace-layout>.parts-explorer')).toContain('overflow:hidden');
    expect(joinRules('.workspace-drawer>.parts-explorer')).toContain('overflow:hidden');

    expect(joinRules('.parts-tools')).toContain('flex:none');
    expect(joinRules('.parts-explorer ul')).toContain('flex:1 1 0%');
    expect(joinRules('.parts-explorer ul')).toContain('min-height:0');
    expect(joinRules('.parts-explorer ul')).toContain('overflow-y:auto');

    // One-height rows across the full list (including 460px compact media query)
    const buttonRules = rules.get('.parts-explorer li button') ?? [];
    expect(buttonRules.length).toBeGreaterThanOrEqual(2);
    for (const body of buttonRules) {
      expect(`${name}: ${body}`).toContain('height:36px');
      expect(`${name}: ${body}`).toContain('min-height:36px');
      expect(`${name}: ${body}`).toContain('max-height:36px');
    }
    expect(joinRules('.parts-explorer li button')).toContain('white-space:nowrap');
    expect(joinRules('.parts-explorer li button')).toContain('overflow:hidden');

    // Single-line ellipsis on .part-label
    expect(joinRules('.part-label')).toContain('white-space:nowrap');
    expect(joinRules('.part-label')).toContain('overflow:hidden');
    expect(joinRules('.part-label')).toContain('text-overflow:ellipsis');

    // Thumbnail box rules present in both stylesheets
    expect(joinRules('.part-thumb')).toContain('width:24px');
    expect(joinRules('.part-thumb')).toContain('height:24px');
    expect(joinRules('.part-thumb canvas')).toContain('width:24px');
    expect(joinRules('.part-thumb canvas')).toContain('height:24px');
    expect(joinRules('.part-thumb[data-thumbnail=image]')).toContain('background:var(--rv-field)');
  }
});

test('Change 2: compare.ts reuses PartThumbnails, pageRegionTable, and loadPartModel without copying, and draws per-side thumbnails', async () => {
  const compareTs = readFileSync(new URL('../web/compare.ts', import.meta.url), 'utf8');
  expect(compareTs).toContain("import {PartExplorer,loadPartModel} from './part-selection.ts';");
  expect(compareTs).toContain("import {PartThumbnails,pageRegionTable} from './part-thumbnails.ts';");
  expect(compareTs).toContain('new PartThumbnails(pageRegionTable(catalog.model),loaded.pageImages)');
  expect(compareTs).toContain('parts?.register(side,catalog.entries,player,thumbnails[side])');

  const draws: Array<{ image: unknown; args: number[] }> = [];
  class DetailNode {
    parentElement: DetailNode | null = null;
    children: DetailNode[] = [];
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    selector = '';
    value = '';
    disabled = false;
    hidden = false;
    checked = false;
    type = '';
    title = '';
    className = '';
    width = 0;
    height = 0;
    onclick: (() => void) | null = null;
    onchange: (() => void) | null = null;
    private content = '';
    constructor(readonly tagName: string) {}
    get textContent(): string {
      return this.content + this.children.map(node => node.textContent).join('');
    }
    set textContent(value: string) {
      this.replaceChildren();
      this.content = value;
    }
    get isConnected(): boolean {
      return this === doc.body || !!this.parentElement?.isConnected;
    }
    contains(node: DetailNode | null): boolean {
      return !!node && (node === this || this.children.some(child => child.contains(node)));
    }
    append(...nodes: DetailNode[]) {
      for (const node of nodes) {
        if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
        node.parentElement = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes: DetailNode[]) {
      if (doc.activeElement !== this && this.contains(doc.activeElement)) doc.activeElement = doc.body;
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.content = '';
      this.append(...nodes);
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    addEventListener() {}
    focus() {
      if (this.isConnected && !this.disabled) doc.activeElement = this;
    }
    getContext() {
      return {
        clearRect() {},
        drawImage: (image: unknown, ...args: number[]) => draws.push({ image, args }),
      };
    }
    querySelector(selector: string): DetailNode | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector: string): DetailNode[] {
      return this.children.flatMap(child => {
        const match =
          selector === 'button'
            ? child.tagName === 'BUTTON'
            : selector === 'canvas'
              ? child.tagName === 'CANVAS'
              : selector === '.part-thumb'
                ? child.className === 'part-thumb'
                : selector === '.part-label'
                  ? child.className === 'part-label'
                  : child.selector === selector;
        return [...(match ? [child] : []), ...child.querySelectorAll(selector)];
      });
    }
  }

  const doc: { activeElement: DetailNode | null; body: DetailNode | null; createElement: (tag: string) => DetailNode } = {
    activeElement: null,
    body: null,
    createElement: tag => new DetailNode(tag.toUpperCase()),
  };
  doc.body = new DetailNode('BODY');
  doc.activeElement = doc.body;

  const host = new DetailNode('ASIDE');
  const detail = new DetailNode('SECTION');
  doc.body.append(host, detail);
  for (const [selector, tag] of [
    ['[data-part-search]', 'INPUT'],
    ['[data-part-list]', 'UL'],
    ['[data-part-solo]', 'INPUT'],
    ['[data-part-whole]', 'BUTTON'],
    ['[data-part-status]', 'P'],
  ]) {
    const node = new DetailNode(tag!);
    node.selector = selector!;
    host.append(node);
  }

  const source = await readFile(new URL('../web/part-selection.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('export class PartExplorer extends');
  const script = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(
    source.slice(begin).replace('export class', 'class'),
  );
  const Explorer = new Function(
    'PartInspection',
    'orderedParts',
    'partIdentity',
    'document',
    'HTMLElement',
    script + ';return PartExplorer;',
  )(PartInspection, orderedParts, partIdentity, doc, DetailNode) as typeof PartExplorer;

  const oldDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldIO = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'IntersectionObserver', { value: undefined, configurable: true, writable: true });

  try {
    const explorer = new Explorer(
      host as unknown as HTMLElement,
      detail as unknown as HTMLElement,
      () => {},
      () => {},
    );

    const makeModel = (pageName: string) => ({
      slots: [
        { name: 'hair_back', bone: 'root', setup: 'hair_back' },
        { name: 'no_region_slot', bone: 'root', setup: null },
      ],
      skins: [
        {
          name: 'default',
          attachments: {
            hair_back: { hair_back: { kind: 'mesh', path: 'hair_back' } },
            no_region_slot: { no_region_slot: { kind: 'region', path: 'missing_region' } },
          },
        },
      ],
      pages: [
        {
          name: pageName,
          width: 64,
          height: 64,
          regions: [{ name: 'hair_back', x: 0, y: 0, width: 32, height: 32, degrees: 0 }],
        },
      ],
    });

    const modelA = makeModel('a-page.png');
    const modelB = makeModel('b-page.png');
    const entriesA = partCatalog(modelA, ['hair_back', 'no_region_slot']);
    const entriesB = partCatalog(modelB, ['hair_back', 'no_region_slot']);

    const fakeImageA = { tag: 'img-a' } as unknown as CanvasImageSource;
    const fakeImageB = { tag: 'img-b' } as unknown as CanvasImageSource;
    const thumbsA = new PartThumbnails(pageRegionTable(modelA), new Map([['a-page.png', fakeImageA]]));
    const thumbsB = new PartThumbnails(pageRegionTable(modelB), new Map([['b-page.png', fakeImageB]]));

    const makePlayer = (pageName: string): PartPlayer => {
      const frame: PosedFrame = {
        generation: 1,
        order: [
          {
            slot: 'hair_back',
            kind: 'mesh',
            page: pageName,
            pma: false,
            blend: 'Normal',
            sequence: 0,
            z: 0,
            tint: [1, 1, 1, 1],
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            vertices: [0, 0, 10, 0, 10, 10, 0, 10],
            triangles: [0, 1, 2, 0, 2, 3],
          },
        ],
      };
      const snap: SlotIdentitySnapshot = {
        generation: 1,
        skin: 'default',
        set: null,
        sets: [],
        slots: [
          { slot: 'hair_back', z: 0, skin: 'default', attachment: 'hair_back', reason: null },
          { slot: 'no_region_slot', z: 1, skin: null, attachment: null, reason: 'timeline-null' },
        ],
      };
      return {
        generation: 1,
        skin: 'default',
        set: null,
        posedFrame: () => frame,
        slotIdentity: () => snap,
        renderer: { render() {} },
      };
    };

    explorer.register('a', entriesA, makePlayer('a-page.png'), thumbsA);
    explorer.register('b', entriesB, makePlayer('b-page.png'), thumbsB);
    explorer.present('a');
    explorer.present('b');

    const list = host.querySelector('[data-part-list]')!;
    const rows = list.querySelectorAll('button');
    expect(rows.length).toBe(4);

    const aHair = rows.find(r => r.dataset.side === 'a' && r.dataset.slot === 'hair_back')!;
    const bHair = rows.find(r => r.dataset.side === 'b' && r.dataset.slot === 'hair_back')!;
    const aFallback = rows.find(r => r.dataset.side === 'a' && r.dataset.slot === 'no_region_slot')!;
    const bFallback = rows.find(r => r.dataset.side === 'b' && r.dataset.slot === 'no_region_slot')!;

    expect(aHair.querySelector('.part-thumb')?.dataset.thumbnail).toBe('image');
    expect(aHair.querySelector('canvas')).not.toBeNull();
    expect(aHair.title).toContain('thumbnail: region hair_back on a-page.png');
    expect(aHair.attributes.get('aria-label')).toBe('◈ A · hair_back · drawn · default / hair_back · drawn');

    expect(bHair.querySelector('.part-thumb')?.dataset.thumbnail).toBe('image');
    expect(bHair.querySelector('canvas')).not.toBeNull();
    expect(bHair.title).toContain('thumbnail: region hair_back on b-page.png');
    expect(bHair.attributes.get('aria-label')).toBe('◈ B · hair_back · drawn · default / hair_back · drawn');

    expect(draws.some(d => d.image === fakeImageA)).toBe(true);
    expect(draws.some(d => d.image === fakeImageB)).toBe(true);

    expect(aFallback.querySelector('.part-thumb')?.dataset.thumbnail).toBe('icon');
    expect(aFallback.querySelector('.part-thumb')?.textContent).toBe('◇');
    expect(aFallback.title).toContain('type icon: no active attachment (timeline-null)');

    expect(bFallback.querySelector('.part-thumb')?.dataset.thumbnail).toBe('icon');
    expect(bFallback.querySelector('.part-thumb')?.textContent).toBe('◇');
    expect(bFallback.title).toContain('type icon: no active attachment (timeline-null)');

    thumbsA.dispose();
    thumbsB.dispose();
  } finally {
    if (oldDoc) Object.defineProperty(globalThis, 'document', oldDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (oldIO) Object.defineProperty(globalThis, 'IntersectionObserver', oldIO);
    else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  }
});
