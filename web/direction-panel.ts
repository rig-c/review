import type { DirectionInspection } from '../src/direction-inspection.ts';
import type { TurnDial } from '../src/turn-pad.ts';
import { onLanguageChange, t } from './i18n.ts';

export interface DirectionView {
  model: { path: string; sha256: string; inspected: boolean } | null;
  revision: string;
  sourceHash: string;
  runtime: string;
  dials: readonly TurnDial[];
  sets: readonly string[];
  activeSet?: string;
  authored?: DirectionInspection;
}

export function directionRows(view: DirectionView): { key: string; values?: string[] }[] {
  const model = view.model;
  const joined = model?.inspected ? view.authored?.joined : undefined;
  return [
    model ? { key: model.inspected ? 'direction.inspected' : 'direction.scratch', values: [model.path, model.sha256] }
      : { key: 'direction.modelUnavailable' },
    { key: 'direction.package', values: [view.revision, view.sourceHash, view.runtime] },
    view.dials.length ? { key: 'direction.turn', values: [view.dials.map(d => d.axis).join(', ')] }
      : { key: 'direction.turnUnavailable' },
    { key: 'direction.depthUnavailable' },
    view.sets.length ? { key: 'direction.sets', values: [view.sets.join(', ')] } : { key: 'direction.setsUnavailable' },
    model?.inspected && view.authored
      ? { key: 'direction.authored', values: [String(view.authored.rigVersion), view.authored.file.path, view.authored.file.sha256] }
      : { key: 'direction.authoredUnavailable' },
    ...(joined ? [{ key: 'direction.joined', values: [String(joined.postVersion), joined.projectModel.path,
      joined.packageRoot, joined.projectHash, joined.packageSourceHash] }] : []),
    { key: 'direction.runtimeCameraUnavailable' },
    { key: 'direction.cameraApplyUnavailable' },
  ];
}

/** The adjacent viewport, reference picker and Turn Pad keep their normal input and rendering paths. */
export function bindDirectionPanel(before: HTMLElement, read: () => DirectionView, set: (name: string) => void) {
  const host = document.createElement('details');
  host.id = 'direction-panel';
  host.open = true;
  host.hidden = true;
  const title = document.createElement('summary');
  const body = document.createElement('div');
  host.append(title, body);
  before.before(host);
  function refresh() {
    if (host.hidden) return;
    const view = read();
    title.textContent = t('direction.title');
    const rows = directionRows(view).map(({ key, values }) => {
      const row = document.createElement('li');
      row.textContent = t(key, values);
      return row;
    });
    const list = document.createElement('ul');
    list.append(...rows);
    body.replaceChildren(list);
    if (view.sets.length) {
      const label = document.createElement('label');
      label.textContent = t('direction.chooseSet');
      const picker = document.createElement('select');
      for (const name of ['', ...view.sets]) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name || t('Original set');
        picker.append(option);
      }
      picker.value = view.activeSet ?? '';
      picker.onchange = () => set(picker.value);
      label.append(picker);
      body.append(label);
    }
    if (view.model?.inspected && view.authored) {
      const { camera, timing, take } = view.authored;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t('direction.keys');
      const keys = document.createElement('pre');
      keys.textContent = JSON.stringify({ camera, timing, take }, null, 2);
      details.append(summary, keys);
      body.append(details);
    }
  }
  const language = onLanguageChange(refresh);
  return {
    refresh,
    show(active: boolean) { host.hidden = !active; refresh(); },
    dispose() { language(); host.remove(); },
  };
}
