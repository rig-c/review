/**
 * Single-source Setup and Animate workspace markup for comparison sessions (#234).
 *
 * `web/index.html` owns the Setup and Animate panel markup; `web/compare.html` holds placeholders for those shared
 * sections and `renderCompareHtml` splices them from `web/index.html` at serve time, refusing missing landmarks,
 * duplicate IDs or any byte difference between the two pages' Setup and Animate sections.
 */

export interface SharedWorkspaceMarkup {
  viewTools: string;
  stageBars: string;
  stageHandles: string;
  appliedRecords: string;
  setupBlockRow: string;
  setupPanels: string;
  animateBlockRow: string;
  transportStrips: string;
  animatePanels: string;
}

const REGIONS: readonly {
  key: keyof SharedWorkspaceMarkup;
  placeholder: string;
  start: string;
  end: string;
  compareEnd: string;
}[] = [
  {
    key: 'viewTools',
    placeholder: '<!-- shared:view-tools -->',
    start: '<div class="view-tools">',
    end: '<div class="zoom-controls">',
    compareEnd: '<div class="row"><label class="camera-sync">',
  },
  {
    key: 'stageBars',
    placeholder: '<!-- shared:stage-bars -->',
    start: '<div id="chest-editor-bar"',
    end: '<div id="stage-layout"',
    compareEnd: '<div id="stage-layout"',
  },
  {
    key: 'stageHandles',
    placeholder: '<!-- shared:stage-handles -->',
    start: '<div id="idle-handles"',
    end: '<div id="rig-empty"',
    compareEnd: '<p id="a-empty"',
  },
  {
    key: 'appliedRecords',
    placeholder: '<!-- shared:applied-records -->',
    start: '<section id="applied-records"',
    end: '<section id="inspector-rig"',
    compareEnd: '<section id="inspector-view"',
  },
  {
    key: 'setupBlockRow',
    placeholder: '<!-- shared:setup-block-row -->',
    start: '<nav class="block-row" aria-label="Setup blocks">',
    end: '<section id="selected-part"',
    compareEnd: '<section id="selected-part"',
  },
  {
    key: 'setupPanels',
    placeholder: '<!-- shared:setup-panels -->',
    start: '<section id="modeling-tools">',
    end: '</section><section id="inspector-playback"',
    compareEnd: '</section><section id="inspector-playback"',
  },
  {
    key: 'animateBlockRow',
    placeholder: '<!-- shared:animate-block-row -->',
    start: '<nav class="block-row" aria-label="Animate blocks">',
    end: '<section id="transport"',
    compareEnd: '<section id="transport"',
  },
  {
    key: 'transportStrips',
    placeholder: '<!-- shared:transport-strips -->',
    start: '<div id="reading-ticks"',
    end: '</section><section id="frame-controls"',
    compareEnd: '</section><div class="compare-info">',
  },
  {
    key: 'animatePanels',
    placeholder: '<!-- shared:animate-panels -->',
    start: '<section id="motion-tools">',
    end: '</section></div></section></main>',
    compareEnd: '</section><section id="inspector-feedback"',
  },
];

function sliceRegion(html: string, start: string, end: string, label: string): string {
  const a = html.indexOf(start);
  if (a < 0) throw new Error(`COMPARE_SHARED_MARKUP_MISSING: ${label} start landmark not found (${start})`);
  const b = html.indexOf(end, a);
  if (b < a) throw new Error(`COMPARE_SHARED_MARKUP_MISSING: ${label} end landmark not found (${end})`);
  return html.slice(a, b);
}

export function extractSharedWorkspaceMarkup(indexHtml: string): SharedWorkspaceMarkup {
  const out = {} as Record<keyof SharedWorkspaceMarkup, string>;
  for (const r of REGIONS) out[r.key] = sliceRegion(indexHtml, r.start, r.end, r.key);
  return out;
}

export function assertNoDuplicateIds(html: string, label = 'compare.html'): void {
  const seen = new Set<string>();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    const id = m[1]!;
    if (seen.has(id)) throw new Error(`COMPARE_DUPLICATE_ID: duplicate id="${id}" in ${label}`);
    seen.add(id);
  }
}

export function assertSharedCompareMarkup(compareHtml: string, indexHtml: string): void {
  const shared = extractSharedWorkspaceMarkup(indexHtml);
  for (const r of REGIONS) {
    const piece = shared[r.key].trim();
    let actual: string;
    try {
      actual = sliceRegion(compareHtml, r.start, r.compareEnd, r.key).trim();
    } catch {
      throw new Error(`COMPARE_SHARED_MARKUP_DRIFT: ${r.key} in compare markup differs from web/index.html`);
    }
    if (actual !== piece) {
      throw new Error(`COMPARE_SHARED_MARKUP_DRIFT: ${r.key} in compare markup differs from web/index.html`);
    }
  }
  assertNoDuplicateIds(compareHtml, 'rendered compare HTML');
}

export function renderCompareHtml(compareTemplate: string, indexHtml: string): string {
  const shared = extractSharedWorkspaceMarkup(indexHtml);
  let out = compareTemplate;
  for (const r of REGIONS) {
    if (!out.includes(r.placeholder)) {
      throw new Error(`COMPARE_SHARED_MARKUP_MISSING: placeholder ${r.placeholder} missing in web/compare.html`);
    }
    out = out.replace(r.placeholder, shared[r.key]);
  }
  if (out.includes('<!-- shared:')) {
    throw new Error('COMPARE_SHARED_MARKUP_MISSING: unreplaced shared placeholder in web/compare.html');
  }
  assertSharedCompareMarkup(out, indexHtml);
  return out;
}
