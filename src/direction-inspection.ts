import { numberField, object, packagePath } from './manifest.ts';

export const DIRECTION_MAX_BYTES = 256 * 1024;

type Binding = { path: string; sha256: string };
export interface DirectionInspection {
  file: Binding;
  joined?: {
    postVersion: number;
    projectHash: string;
    packageSourceHash: string;
    packageRoot: string;
    projectModel: Binding;
  };
  rigVersion: number;
  camera: { space: 'rig-world-y-up'; keys: { time: number; easing: string; box: { x: number; y: number; width: number; height: number } }[] };
  take: { duration: number; loop: boolean };
  timing: { time: number; source_time: number; easing: string }[];
}

/** Read the inspection subset of Create's direction@1 or direction@2. Create validates scene, project history and citations. */
export function readDirectionInspection(value: unknown, file: Binding, model: Binding | null): DirectionInspection {
  const doc = object(value, 'direction');
  if (doc.schema !== 'rig-create/direction@1' && doc.schema !== 'rig-create/direction@2')
    throw new Error('DIRECTION_SCHEMA: expected rig-create/direction@1 or rig-create/direction@2');
  const rig = object(doc.rig, 'direction.rig');
  const binding = object(rig.model, 'direction.rig.model');
  const path = packagePath(binding.path, 'direction.rig.model.path');
  if (!model || path !== model.path || binding.sha256 !== model.sha256)
    throw new Error('DIRECTION_MODEL_MISMATCH: expected the inspected model path and SHA-256');
  const rigVersion = numberField(rig.version, 'direction.rig.version', 1);
  if (!Number.isSafeInteger(rigVersion)) throw new Error('DIRECTION_SCHEMA: expected integer rig version');
  const take = object(doc.take, 'direction.take');
  const duration = numberField(take.duration, 'direction.take.duration');
  if (duration === 0 || typeof take.loop !== 'boolean') throw new Error('DIRECTION_SCHEMA: expected positive duration and loop boolean');
  const camera = object(doc.camera, 'direction.camera');
  const timing = object(doc.timing, 'direction.timing');
  if (camera.space !== 'rig-world-y-up') throw new Error('DIRECTION_SCHEMA: expected rig-world-y-up camera');
  function keys<T>(value: unknown, section: string, min: number, parse: (key: Record<string, unknown>, field: string) => T) {
    if (!Array.isArray(value) || value.length < min || value.length > 256)
      throw new Error(`DIRECTION_SCHEMA: invalid ${section} key count`);
    let previous = -Infinity;
    return value.map((raw, index) => {
      const field = `direction.${section}.keys[${index}]`;
      const key = object(raw, field);
      const time = numberField(key.time, field + '.time');
      if (time <= previous || time > duration || (index === 0 && time !== 0))
        throw new Error('DIRECTION_SCHEMA: expected increasing keys within the take starting at zero');
      previous = time;
      const easing = key.easing;
      if (easing !== 'linear' && easing !== 'hold' && easing !== 'smoothstep')
        throw new Error('DIRECTION_SCHEMA: unknown easing');
      return { time, easing, ...parse(key, field) };
    });
  }
  const cameraKeys = keys(camera.keys, 'camera', 1, (key, field) => {
    const box = object(key.box, field + '.box');
    const x = numberField(box.x, field + '.box.x', -Infinity);
    const y = numberField(box.y, field + '.box.y', -Infinity);
    const width = numberField(box.width, field + '.box.width');
    const height = numberField(box.height, field + '.box.height');
    if (width === 0 || height === 0) throw new Error('DIRECTION_SCHEMA: expected positive camera box dimensions');
    return { box: { x, y, width, height } };
  });
  let previousSource = 0;
  const timingKeys = keys(timing.keys, 'timing', 2, (key, field) => {
    const source_time = numberField(key.source_time, field + '.source_time', previousSource);
    previousSource = source_time;
    return { source_time };
  });
  if (timingKeys.at(-1)?.time !== duration) throw new Error('DIRECTION_SCHEMA: timing must end at take duration');
  return { file, rigVersion, camera: { space: camera.space, keys: cameraKeys }, take: { duration, loop: take.loop }, timing: timingKeys };
}
