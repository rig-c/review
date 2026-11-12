import type {SceneInspection} from '../src/scene-inspection.ts';
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
  scene?: SceneInspection;
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
    ...(model?.inspected&&view.scene?[{key:'direction.planes',values:[t(view.scene.plates.length===2?'direction.threePlanes':'direction.twoPlanes')]}]:[{ key: 'direction.runtimeCameraUnavailable' }]),
    { key: 'direction.cameraApplyUnavailable' },
  ];
}

/** Summarize only authored fields bound to the model currently on stage. */
export function directionSummary(view: DirectionView, language?: 'en' | 'ko'): string {
  const authored = view.model?.inspected ? view.authored : undefined;
  if (!authored) return t('direction.title', undefined, language);
  const first = authored.camera.keys[0]!.box;
  const fixed = authored.camera.keys.every(({ box }) =>
    box.x === first.x && box.y === first.y && box.width === first.width && box.height === first.height);
  const post=authored.joined?.postVersion??authored.postVersion;
  const version = post ? ` v${post}` : '';
  return t('direction.summary', [version, String(authored.take.duration),
    t(authored.take.loop ? 'direction.loop' : 'direction.once', undefined, language),
    t(fixed ? 'direction.fixedCamera' : 'direction.movingCamera', undefined, language)], language);
}

/** The adjacent viewport, reference picker and Turn Pad keep their normal input and rendering paths. */
export function bindDirectionPanel(before: HTMLElement, read: () => DirectionView, set: (name: string) => void) {
  const host = document.createElement('details');
  host.id = 'direction-panel';
  host.open = false;
  host.hidden = true;
  const title = document.createElement('summary');
  const body = document.createElement('div');
  const metadata = document.createElement('div');
  const details = document.createElement('details');
  details.id = 'direction-authored-keys';
  details.hidden = true;
  const summary = document.createElement('summary');
  const keys = document.createElement('pre');
  keys.id = 'direction-authored-body';
  summary.setAttribute('aria-controls', keys.id);
  details.append(summary);
  body.append(metadata, details);
  host.append(title, body);
  before.before(host, keys);
  function refresh() {
    if (host.hidden) return;
    const view = read();
    title.textContent = directionSummary(view);
    const rows = [...directionRows(view),...(!view.scene&&view.authored?[{key:view.authored.scene?'direction.noScene':'direction.legacyTake'}]:[])].map(({ key, values }) => {
      const row = document.createElement('li');
      row.textContent = t(key, values);
      return row;
    });
    const list = document.createElement('ul');
    list.append(...rows);
    metadata.replaceChildren(list);
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
      metadata.append(label);
    }
    if (view.model?.inspected && view.authored) {
      const { camera, timing, take } = view.authored;
      summary.textContent = t('direction.keys');
      keys.textContent = directionSummary(view);
      details.hidden = true;
    } else {
      details.hidden = true;
      keys.textContent = '';
    }
  }
  const language = onLanguageChange(refresh);
  return {
    refresh,
    show(active: boolean) { host.hidden = !active; refresh(); },
    dispose() { language(); host.remove(); keys.remove(); },
  };
}
