/**
 * One labelled line per producer flag (#348). The producer's own object stays available verbatim beside it (the page
 * puts it behind a collapsed details element); this only names its fields. Field names that rig-parts writes are kept
 * as written. A line whose shape is not the known one falls back to its path, never to a guess.
 */
type Params = Readonly<Record<string, string | number>>;
export type Translate = (key: string, params?: Params) => string;
export type LabelledFlag =
  | { kind: 'faint'; item: string; art: number; maxAlpha: number; box: readonly [number, number, number, number] }
  | { kind: 'check'; item: string; path: string; root: string; status: string | null; entry: Readonly<Record<string, unknown>> };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const box4 = (v: unknown): v is [number, number, number, number] => Array.isArray(v) && v.length === 4 && v.every(num);

export function flagLabel(flag: LabelledFlag, t: Translate): string {
  if (flag.kind === 'faint') return t('Faint island left out of the mesh: {art} px, brightest alpha {alpha}, at {x},{y} {width}×{height} (part-image px).', { art: flag.art, alpha: flag.maxAlpha, x: flag.box[0], y: flag.box[1], width: flag.box[2], height: flag.box[3] });
  // Exact location plus the row's own string fields: pair, front/back, part, status, reason, and unknown fields
  // all survive without assigning meaning to a code or inferring scope. The path distinguishes even sparse rows.
  const identity = Object.entries(flag.entry)
    .filter(([, v]) => str(v) || (Array.isArray(v) && v.length > 0 && v.every(str)))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return [`${flag.root} · ${flag.path}`, ...identity, checkReadings(flag, t)].join(' · ');
}

function checkReadings(flag: Extract<LabelledFlag, { kind: 'check' }>, t: Translate): string {
  const e = flag.entry;
  if (flag.root === 'figure_openings' && str(e.under) && str(e.above) && str(e.animation) && num(e.frame) && num(e.time) && num(e.found_cells) && num(e.allowed_cells))
    return t('{under} opens under {above} · {animation} f{frame} ({time} s) · {found} cells found / {allowed} allowed', { under: e.under, above: e.above, animation: e.animation, frame: e.frame, time: e.time, found: e.found_cells, allowed: e.allowed_cells });
  if (flag.root === 'seam_pairs' && Array.isArray(e.parts) && e.parts.length === 2 && e.parts.every(str) && num(e.px_over_40) && num(e.px_over_80)) {
    const line = t('Seam {a} | {b} · {px40} px over 40 · {px80} px over 80', { a: e.parts[0] as string, b: e.parts[1] as string, px40: e.px_over_40, px80: e.px_over_80 });
    return box4(e.rig_box) ? `${line} · ${t('rig box {x},{y} {width}×{height}', { x: e.rig_box[0], y: e.rig_box[1], width: e.rig_box[2], height: e.rig_box[3] })}` : line;
  }
  if (flag.status !== null) {
    // This is the enclosing block's status, not necessarily this row's status or an acceptance verdict.
    const readings = Object.entries(e).filter(([, v]) => num(v)).map(([k, v]) => `${k} ${v}`);
    return [t('Block {gate}: {status} · {part}', { gate: flag.root, status: flag.status, part: flag.item }), ...readings].join(' · ');
  }
  return t('Check line {path}', { path: flag.path });
}
