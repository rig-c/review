import type { Json, ReviewedSource } from './manifest.ts';
import type { Feedback, FeedbackWarning, ReviewSession } from './session.ts';
import type { CompareBinding } from './compare.ts';
import type { CompareSession } from './compare-session.ts';
import type { FeedbackHistory, HistoryRetrieval } from './session-history.ts';
import type { ReferenceBinding } from './reference.ts';
import { environmentSummary, parseEnvironmentContext } from './environment.ts';
type Category = Feedback['category'];
type Side = 'single' | 'a' | 'b';
type ParsedFeedbackSession = FeedbackHistory<ReviewSession | CompareSession>;
interface Counts { defect: number; quality: number; total: number }
interface BuildCount {
  side: Side;
  sourceHash: string;
  reviewedSource: ReviewedSource;
  counts: Counts;
}
interface ExportItem {
  id: string;
  side: Side;
  frameStart: number;
  frameEnd: number;
  target: Feedback['target'];
  category: Category;
  summary: string;
  context?: Json;
  warnings: FeedbackWarning[];
  selectedSource: { sourceHash: string; reviewedSource: ReviewedSource; referenceBinding?: ReferenceBinding };
}
interface TargetGroup {
  target: Feedback['target'];
  items: ExportItem[];
}
interface CategoryGroup {
  category: Category;
  count: number;
  targets: TargetGroup[];
}
export interface FeedbackIssueExport {
  schema: 'rig-review-issue-export/1';
  session: {
    schema: ReviewSession['schema'] | CompareSession['schema'];
    id: string;
    revision: string;
    sourceHash: string;
    status: ReviewSession['status'];
    updatedAt: string | null;
  };
  counts: Counts;
  builds: BuildCount[];
  categories: CategoryGroup[];
  pairedBinding: CompareBinding | null;
  referenceBinding: ReferenceBinding | null;
  feedbackWarnings: FeedbackWarning[];
  retrieval?: HistoryRetrieval;
  historyWarnings: { file: string; error: string }[];
}
const categories: readonly Category[] = ['defect', 'quality'];
const sideOrder: Record<Side, number> = { single: 0, a: 1, b: 2 };
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const emptyCounts = (): Counts => ({ defect: 0, quality: 0, total: 0 });
function cloneSource(source: ReviewedSource): ReviewedSource {
  return { ...source, rig: source.rig ? { ...source.rig } : null, motion: source.motion ? { ...source.motion } : null };
}
function cloneJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  return value;
}
function cloneReference(binding: ReferenceBinding): ReferenceBinding {
  return { packageSourceHash: binding.packageSourceHash, reference: { ...binding.reference } };
}
function cloneBinding(binding: CompareBinding): CompareBinding {
  return {
    a: { sourceHash: binding.a.sourceHash, reviewedSource: cloneSource(binding.a.reviewedSource) },
    b: { sourceHash: binding.b.sourceHash, reviewedSource: cloneSource(binding.b.reviewedSource) },
    reference: { ...binding.reference }, animation: binding.animation,
  };
}

/** Counts records once; never validates/migrates a submission or expands frames. */
export function groupFeedbackIssues(input: ParsedFeedbackSession): FeedbackIssueExport {
  const referenceBinding = input.schema === 'rig-review-session/1' && input.referenceBinding ? cloneReference(input.referenceBinding) : null;
  const pairedBinding = input.schema === 'rig-review-compare-session/1' ? cloneBinding(input.binding) : null;
  const builds: BuildCount[] = input.schema === 'rig-review-compare-session/1'
    ? (['a', 'b'] as const).map(side => ({ side, sourceHash: input.binding[side].sourceHash, reviewedSource: cloneSource(input.binding[side].reviewedSource), counts: emptyCounts() }))
    : [{ side: 'single', sourceHash: input.sourceHash, reviewedSource: cloneSource(input.reviewedSource), counts: emptyCounts() }];
  const bySide = new Map(builds.map(build => [build.side, build]));
  const warningMap = new Map<string, FeedbackWarning[]>();
  for (const warning of input.feedbackWarnings) {
    const list = warningMap.get(warning.id) ?? [];
    list.push({ ...warning }); warningMap.set(warning.id, list);
  }
  const grouped = new Map<Category, Map<string, TargetGroup>>(categories.map(category => [category, new Map()]));
  const counts = emptyCounts();
  const seen = new Set<string>();
  for (const feedback of input.feedback) {
    // Parsers already enforce these invariants. Named failures prevent silent
    // omission if a future CLI accidentally bypasses the parsed-input boundary.
    if (seen.has(feedback.id)) throw new Error(`feedback export.id: duplicate ${JSON.stringify(feedback.id)}`);
    seen.add(feedback.id);
    const side: Side = input.schema === 'rig-review-compare-session/1'
      ? (feedback as Feedback & { side: 'a' | 'b' }).side : 'single';
    const build = bySide.get(side);
    if (!build) throw new Error(`feedback export.side: unavailable ${JSON.stringify(side)}`);
    const targetGroups = grouped.get(feedback.category);
    if (!targetGroups) throw new Error(`feedback export.category: unavailable ${JSON.stringify(feedback.category)}`);
    const targetKey = JSON.stringify([feedback.target.kind, feedback.target.name]);
    let target = targetGroups.get(targetKey);
    if (!target) { target = { target: { ...feedback.target }, items: [] }; targetGroups.set(targetKey, target); }
    target.items.push({
      id: feedback.id, side, frameStart: feedback.frameStart, frameEnd: feedback.frameEnd,
      target: { ...feedback.target }, category: feedback.category, summary: feedback.summary,
      ...(feedback.context === undefined ? {} : { context: cloneJson(feedback.context) }),
      warnings: [...(warningMap.get(feedback.id) ?? [])].sort((a, b) => compareText(a.error, b.error)),
      selectedSource: { sourceHash: build.sourceHash, reviewedSource: cloneSource(build.reviewedSource), ...(referenceBinding ? { referenceBinding: cloneReference(referenceBinding) } : {}) },
    });
    counts[feedback.category]++; counts.total++;
    build.counts[feedback.category]++; build.counts.total++;
  }
  const categoryGroups: CategoryGroup[] = categories.map(category => {
    const targets = [...grouped.get(category)!.values()].sort((a, b) => compareText(a.target.kind, b.target.kind) || compareText(a.target.name, b.target.name));
    for (const target of targets) target.items.sort((a, b) => sideOrder[a.side] - sideOrder[b.side] || compareText(a.id, b.id));
    return { category, count: counts[category], targets };
  });
  return {
    schema: 'rig-review-issue-export/1',
    session: { schema: input.schema, id: input.id, revision: input.revision, sourceHash: input.sourceHash, status: input.status, updatedAt: input.updatedAt },
    counts, builds, categories: categoryGroups, pairedBinding, referenceBinding,
    feedbackWarnings: input.feedbackWarnings.map(warning => ({ ...warning })).sort((a, b) => compareText(a.id, b.id) || compareText(a.error, b.error)),
    ...(input.retrieval ? { retrieval: { ...input.retrieval, currentTools: 'a' in input.retrieval.currentTools ? { a: { ...input.retrieval.currentTools.a }, b: { ...input.retrieval.currentTools.b } } : { ...input.retrieval.currentTools } } } : {}),
    historyWarnings: (input.historyWarnings ?? []).map(warning => ({ ...warning })).sort((a, b) => compareText(a.file, b.file) || compareText(a.error, b.error)),
  };
}

/** Entity-escape text in Markdown syntax positions; no raw HTML/line injection. */
export function feedbackMarkdownText(value: string): string {
  return value.replace(/[&<>\\`*_{}\[\]()#+.!|~\-\r\n\u0000-\u001f\u007f]/g, char => `&#${char.charCodeAt(0)};`);
}
function stableJson(value: unknown): string {
  const order = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(order);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareText(a, b)).map(([key, child]) => [key, order(child)]));
    return item;
  };
  const serialized = JSON.stringify(order(value), null, 2);
  if (serialized === undefined) throw new Error('feedback export: expected serializable parsed evidence');
  return serialized;
}
/** A data-owned backtick run can never close the generated fenced JSON block. */
function jsonBlock(value: unknown): string {
  const json = stableJson(value);
  let longest = 0;
  for (const run of json.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

/** "Under gust 48 / wind 30": a readable line when the record carries a valid environment; the raw context still follows. */
function environmentLine(context: Json | undefined): string[] {
  if (context === undefined || context === null || typeof context !== 'object' || Array.isArray(context) || !('environment' in context)) return [];
  try { const value = parseEnvironmentContext(context.environment); return [`- Environment: ${value === null ? 'no compiled model drawn' : feedbackMarkdownText(environmentSummary(value))}`]; }
  catch { return []; }
}
/** Local issue-ready text only. No issue creation, clock inference or source IO. */
export function formatFeedbackIssues(input: ParsedFeedbackSession): string {
  const model = groupFeedbackIssues(input), md = feedbackMarkdownText;
  const lines = [
    '# Feedback issue export', '',
    `Session: ${md(model.session.id)} · revision ${md(model.session.revision)}`,
    `Recorded status: ${md(model.session.status)} · saved: ${model.session.updatedAt === null ? 'not submitted' : md(model.session.updatedAt)}`,
    `Source SHA-256: ${md(model.session.sourceHash)}`, '',
    `Items: ${model.counts.total} · defect: ${model.counts.defect} · quality: ${model.counts.quality}`, '',
    '| Build | Revision | Defect | Quality | Total | Source SHA-256 |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const build of model.builds) lines.push(`| ${md(build.side)} | ${md(build.reviewedSource.packageRevision)} | ${build.counts.defect} | ${build.counts.quality} | ${build.counts.total} | ${md(build.sourceHash)} |`);
  lines.push('', '## Recorded provenance', '', jsonBlock({ builds: model.builds.map(({ counts: _counts, ...build }) => build), pairedBinding: model.pairedBinding, referenceBinding: model.referenceBinding }));
  if (model.retrieval) lines.push('', '## Historical retrieval', '', 'This is a prior-tools record; its recorded approval is not a current-tools approval.', '', jsonBlock(model.retrieval));
  if (model.historyWarnings.length) lines.push('', '## History read warnings', '', jsonBlock(model.historyWarnings));
  // Keep the complete warning list, including unmatched ids, without duplicating
  // issue items or quietly hiding evidence supplied by the parsed reader.
  if (model.feedbackWarnings.length) lines.push('', '## Feedback validation warnings', '', jsonBlock(model.feedbackWarnings));
  for (const category of model.categories) {
    lines.push('', `## ${category.category} (${category.count})`);
    if (!category.targets.length) lines.push('', 'No feedback items.');
    for (const group of category.targets) {
      lines.push('', `### ${md(group.target.kind)}: ${md(group.target.name)}`);
      for (const item of group.items) {
        lines.push('', `#### Feedback ${md(item.id)}`, '',
          `- Category: ${item.category}`,
          `- Target: ${md(item.target.kind)}: ${md(item.target.name)}`,
          `- Inclusive frames: ${item.frameStart}–${item.frameEnd}`,
          `- Side: ${item.side}`,
          `- Summary: ${md(item.summary)}`,
          ...environmentLine(item.context), '',
          'Selected build identity:', '', jsonBlock(item.selectedSource));
        if (model.pairedBinding) lines.push('', 'Paired comparison binding:', '', jsonBlock(model.pairedBinding));
        if (item.warnings.length) lines.push('', 'Validation warnings (record retained):', '', jsonBlock(item.warnings));
        if (item.context !== undefined) lines.push('', 'Original inspection context (separate from chosen inclusive frames):', '', jsonBlock(item.context));
      }
    }
  }
  return lines.join('\n') + '\n';
}
