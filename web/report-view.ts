import { reportFields, type ReportEvent, type ReportSeeds, type ReportTarget } from '../src/report.ts';

/** Presentation values only. This never derives seconds from frame count or duration. */
export function eventSelection(event: ReportEvent, targetIndex?: number) {
  const target = targetIndex === undefined
    ? event.targets.length === 1 ? event.targets[0]! : null
    : Number.isInteger(targetIndex) ? event.targets[targetIndex] ?? null : null;
  return {
    frames: event.frames ? [...event.frames] as [number, number] : null,
    target: target ? { ...target } : null,
    targets: event.targets.map(value => ({ ...value })),
    exactTimes: event.times ? [...event.times] : [],
    seek: event.seek ? { ...event.seek } : null,
  };
}

/** A chosen sample is one exact supplied timestamp, never the span between samples. */
export function eventSeekTime(event: ReportEvent, timeIndex?: number): number | null {
  if (timeIndex === undefined) return event.seek?.time ?? null;
  return Number.isInteger(timeIndex) && timeIndex >= 0 ? event.times?.[timeIndex] ?? null : null;
}

export function eventTimingLabel(event: ReportEvent): string {
  if (!event.seek) return event.frames ? '시간 맵 없음 — seek 불가' : '시간 정보 없음 — seek 불가';
  const source = { event: '명시 시각', frameTimes: 'frameTimes 매핑', fps: '명시 fps + frame0 매핑' }[event.seek.source];
  return `${source} · ${event.seek.time} s`;
}

export function eventCoordinates(event: ReportEvent): string {
  const labels: string[] = [];
  if (event.frames) labels.push(`F${event.frames[0]}–${event.frames[1]}`);
  if (event.field === 'uncovered' && event.times) labels.push(`개별 시각 ${event.times.length}개`);
  else if (event.timeInterval) labels.push(`${event.timeInterval.start}–${event.timeInterval.end} s (${event.timeInterval.endKind === 'boundary' ? '끝 경계' : '프레임 시각'})`);
  else if (event.seek) labels.push(`${event.seek.time} s`);
  return labels.join(' · ');
}

export function reportCounts(report: ReportSeeds) {
  return {
    events: report.categories.reduce((sum, category) => sum + category.events.length, 0),
    empty: report.categories.filter(category => category.state === 'empty').map(category => category.field),
    missing: reportFields.filter(field => !report.categories.some(category => category.field === field)),
  };
}

export function targetLabel(target: ReportTarget): string { return `${target.kind}:${target.name}`; }

/** A new finding needs its own human judgment; sub-selections keep that draft. */
export function reportDraftForMarker(previousId: string | null, nextId: string, draft: { category: string; summary: string }) {
  return previousId === nextId ? { ...draft } : { category: '', summary: '' };
}
