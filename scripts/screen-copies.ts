import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * #686: a copy ratchet for docs/SCREENS.md §4. Each row counts one known screen-level copy of shared UI.
 * Every ceiling equals its row's current count (#704): a count above the ceiling fails as SCREEN_COPY_ROSE,
 * and a count below it fails as SCREEN_COPY_CEILING_STALE, so the PR that removes copies also lowers the
 * ceiling to the new count and copies cannot grow back into the slack. At 0 this makes "zero hits for the
 * copies it replaces" a machine gate instead of a PR-body claim.
 */

/** Source files keyed by repository-relative path with forward slashes, e.g. `web/compare.ts`. */
export type Sources = ReadonlyMap<string, string>;

export interface PatternMatcher {
  /** Global regular expression; every match is one hit. */
  pattern: RegExp;
  /** Limit to these paths; default is every scanned file. */
  files?: readonly string[];
  /** Skip these paths (the shared module that owns the original). */
  except?: readonly string[];
  /** Count only inside CSS rules whose selector matches this expression. */
  cssSelector?: RegExp;
  /** One planted hit (for the mutant test): text appended to `plantIn`. */
  plant: string;
  plantIn: string;
}

export interface CopyRow {
  name: string;
  /** The SCREENS.md §4 step whose PR removes this copy. */
  step: string;
  ceiling: number;
  /** Count = number of these paths that exist. */
  files?: readonly string[];
  /** Count = number of scanned paths matching this expression that exist (for "any other file" rows). */
  fileGlob?: {pattern: RegExp; except: readonly string[]};
  /** Count = sum of matches. */
  matchers?: readonly PatternMatcher[];
}

const SCAN_DIRS = ['web', 'src'] as const;
const SCAN_EXT = /\.(?:ts|html|css)$/u;

const compareCameraStack = [
  // Functions web/viewport-controller.ts already defines, redefined in compare.ts.
  'activateCamera', 'alignCameras', 'availableCamera', 'cameraAction', 'fitActiveCamera', 'numericView',
  'panCamera', 'paneFrame', 'renderCameraControls', 'renderNumericView', 'setCameraSync', 'updateCamera', 'zoomCamera',
  // Defined in web/rig-viewport-provider.ts for the shared viewport.
  'referenceFit',
] as const;

const layoutRow = (layout: string, step: string, ceiling: number): CopyRow => ({
  name: `createViewControls layout ${layout}`, step, ceiling,
  matchers: [
    {pattern: new RegExp(`'${layout}'`, 'gu'), files: ['web/view-controls.ts'], plant: `\nconst planted='${layout}';\n`, plantIn: 'web/view-controls.ts'},
    {pattern: new RegExp(`createViewControls\\(\\{\\s*layout\\s*:\\s*'${layout}'`, 'gu'), except: ['web/view-controls.ts'], plant: `\ncreateViewControls({layout:'${layout}'});\n`, plantIn: 'web/main.ts'},
  ],
});

const identifierRow = (name: string, step: string, ceiling: number, plantIn: string): CopyRow => ({
  name, step, ceiling,
  matchers: [{pattern: new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'gu'), plant: `\n/* ${name} */\n`, plantIn}],
});

export const ROWS: readonly CopyRow[] = [
  {name: 'entry HTML web/parts.html', step: '2', ceiling: 0, files: ['web/parts.html']},
  {name: 'entry HTML web/compare.html', step: '3', ceiling: 1, files: ['web/compare.html']},
  {name: 'entry HTML web/interview.html', step: '4', ceiling: 1, files: ['web/interview.html']},
  {name: 'entry HTML web/job-hub.html', step: '6', ceiling: 1, files: ['web/job-hub.html']},
  {name: 'entry HTML web/owner-workspace.html', step: '6', ceiling: 1, files: ['web/owner-workspace.html']},
  {name: 'entry HTML files besides web/index.html', step: '2-6', ceiling: 4, fileGlob: {pattern: /^web\/[^/]+\.html$/u, except: ['web/index.html']}},
  {name: 'inline HTML document in src/job-front.ts', step: '5', ceiling: 1, matchers: [
    {pattern: /<!doctype html/giu, files: ['src/job-front.ts'], plant: "\nconst planted = '<!doctype html>';\n", plantIn: 'src/job-front.ts'},
  ]},
  layoutRow('legacyPartsStep2', '2', 0),
  layoutRow('legacyCompareStep3', '3', 3),
  layoutRow('legacyCompiledJobStep5', '5', 4),
  {name: 'compare camera stack definitions in web/compare.ts', step: '3', ceiling: 2, matchers: [
    {pattern: new RegExp(`^[\\t ]*function\\s+(?:${compareCameraStack.join('|')})\\s*\\(`, 'gmu'), files: ['web/compare.ts'], plant: '\nfunction zoomCamera(): void {}\n', plantIn: 'web/compare.ts'},
  ]},
  identifierRow('legacyCompareLayerControlsMarkup', '3', 3, 'web/compare.ts'),
  {name: 'compare static inspector tab strip in web/compare.html', step: '3', ceiling: 1, matchers: [
    {pattern: /role="tablist"/gu, files: ['web/compare.html'], plant: '\n<div role="tablist"></div>\n', plantIn: 'web/compare.html'},
  ]},
  {name: 'compare static status footer in web/compare.html', step: '3', ceiling: 1, matchers: [
    {pattern: /<footer\b/gu, files: ['web/compare.html'], plant: '\n<footer></footer>\n', plantIn: 'web/compare.html'},
  ]},
  {name: 'per-screen CSS web/parts.css', step: '2', ceiling: 0, files: ['web/parts.css']},
  {name: 'per-screen CSS web/compare.css', step: '3', ceiling: 1, files: ['web/compare.css']},
  {name: 'per-screen CSS web/interview.css', step: '4', ceiling: 1, files: ['web/interview.css']},
  {name: 'per-screen CSS web/job-hub.css', step: '6', ceiling: 1, files: ['web/job-hub.css']},
  {name: 'per-screen CSS web/owner-workspace.css', step: '6', ceiling: 1, files: ['web/owner-workspace.css']},
  {name: 'CSS files besides web/styles.css', step: '2-6', ceiling: 4, fileGlob: {pattern: /^web\/[^/]+\.css$/u, except: ['web/styles.css']}},
  {name: 'job fixed row grid-template-rows:250px in .job-inspection', step: '5', ceiling: 1, matchers: [
    {pattern: /grid-template-rows\s*:\s*250px\b/gu, files: ['web/styles.css'], cssSelector: /\.job-inspection\b/u, plant: '\n.job-window .job-inspection{grid-template-rows:250px}\n', plantIn: 'web/styles.css'},
  ]},
  {name: 'job parts and plan fixed columns in web/styles.css', step: '5', ceiling: 2, matchers: [
    {pattern: /grid-template-columns\s*:/gu, files: ['web/styles.css'], cssSelector: /\.job-inspection\[data-job-(?:parts|plan)-workspace\]/u, plant: '\n.job-window .job-inspection[data-job-plan-workspace]{grid-template-columns:1fr 1fr}\n', plantIn: 'web/styles.css'},
  ]},
  {name: 'job inline layer toggles (layerShortcuts loop)', step: '5', ceiling: 0, matchers: [
    {pattern: /for\s*\(\s*const\s+\w+\s+of\s+layerShortcuts\s*\)/gu, except: ['web/view-controls.ts'], plant: '\nfor (const item of layerShortcuts) {}\n', plantIn: 'web/job-session.ts'},
  ]},
  {name: 'background select builders outside web/parts-render.ts', step: '2/5', ceiling: 1, matchers: [
    // job-session.ts builds its select from the SENTINELS keys.
    {pattern: /Object\.keys\(\s*SENTINELS\s*\)/gu, except: ['web/parts-render.ts'], plant: '\nconst planted = Object.keys(SENTINELS);\n', plantIn: 'web/job-session.ts'},
    // parts.ts builds its select from a hand-written value/label list.
    {pattern: /\[\s*'magenta'\s*,\s*'Magenta'\s*\]/gu, except: ['web/parts-render.ts'], plant: "\nconst planted = [['magenta', 'Magenta']];\n", plantIn: 'web/parts.ts'},
  ]},
  identifierRow('mountPartsMarkup', '2', 0, 'web/parts.ts'),
  identifierRow('PartsWorkspaceSlots', '2', 0, 'web/parts.ts'),
  identifierRow('pv-layout', '2', 0, 'web/styles.css'),
];

export function readSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SCAN_EXT.test(entry.name)) sources.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
    }
  };
  for (const dir of SCAN_DIRS) if (existsSync(join(root, dir))) walk(join(root, dir));
  return sources;
}

function countMatches(text: string, matcher: PatternMatcher): number {
  if (!matcher.cssSelector) return [...text.matchAll(matcher.pattern)].length;
  // Innermost rules only: a selector never holds a brace, so `@media(...){` stays outside the capture.
  let hits = 0;
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    if (matcher.cssSelector.test(rule[1]!)) hits += [...rule[2]!.matchAll(matcher.pattern)].length;
  }
  return hits;
}

export function countRow(row: CopyRow, sources: Sources): number {
  let count = 0;
  for (const file of row.files ?? []) if (sources.has(file)) count++;
  if (row.fileGlob) for (const path of sources.keys()) if (row.fileGlob.pattern.test(path) && !row.fileGlob.except.includes(path)) count++;
  for (const matcher of row.matchers ?? []) {
    for (const [path, text] of sources) {
      if (matcher.files && !matcher.files.includes(path)) continue;
      if (matcher.except?.includes(path)) continue;
      count += countMatches(text, matcher);
    }
  }
  return count;
}

export interface RowResult {row: CopyRow; current: number; failure: string | null}

export function checkScreenCopies(sources: Sources, rows: readonly CopyRow[] = ROWS): RowResult[] {
  return rows.map(row => {
    const current = countRow(row, sources);
    const failure = current > row.ceiling
      ? `SCREEN_COPY_ROSE: ${row.name}: ${current} > ceiling ${row.ceiling} (step ${row.step})`
      : current < row.ceiling
        ? `SCREEN_COPY_CEILING_STALE: ${row.name}: ${current} hits, lower its ceiling from ${row.ceiling} to ${current} (step ${row.step})`
        : null;
    return {row, current, failure};
  });
}

export function formatTable(results: readonly RowResult[]): string {
  const lines = ['| Pattern | Step | Ceiling | Current |', '| --- | --- | ---: | ---: |'];
  for (const {row, current} of results) lines.push(`| ${row.name} | ${row.step} | ${row.ceiling} | ${current} |`);
  return lines.join('\n');
}

if (import.meta.main) {
  const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
  const results = checkScreenCopies(readSources(root));
  console.log(formatTable(results));
  const failures = results.flatMap(result => result.failure ? [result.failure] : []);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`SCREEN_COPIES_OK: ${results.length} rows at their ceiling`);
}
