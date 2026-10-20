/**
 * Which producer op a `rig` config patch runs (#136). `rig-parts retune` (`@rig-c/parts` 1.44.0, parts#530) splices
 * what a config states for the constraints and the idle onto the gated inspected rig and holds every other byte, so a
 * repaired build — whose baseline the whole-rig `rig --config` cannot reproduce — can still take a physics or idle
 * edit. Its help states the scope; the routing below is read off that statement, not off the panels:
 *
 *   "rig.json takes the build's constraints and invariants.detached, motion.json its animations.idle, every other
 *   byte is the input's (RETUNE_PRESERVED)" and the build "must state the input's stops, bones, slots, skeleton,
 *   images, every invariant but detached and every byte of motion.json but animations.idle (RETUNE_REQUEST_HELD): a
 *   moved bone, a redrawn image, a stops change or an animations_from change is no retune."
 *
 * So a patch routes to `retune` only when every op's pointer is one of `RETUNE_PATHS`; anything else — and any patch
 * for a producer older than `RETUNE_SINCE` — keeps the whole-rig `rig` path behind the reproduced baseline. Within
 * `motion.blink`, `eyes` and `brows` name the blink's motion.json groups and `still` adds a `<part>_still` slot (rig-parts
 * `src/motion.ts`, `src/config.ts` BlinkStill), all held, so only the blink's numbers route to retune. What the producer
 * still judges per value (a track that newly keys a mesh-bound bone gets a `<bone>_ctl` under `--idle-keys ctl`, a bone
 * change) comes back as its own `RETUNE_REQUEST_HELD` line, verbatim. Pure: no IO.
 */
import { parsePointer, type PatchOp } from './config-patch.ts';
import { versionAtLeast } from './producer.ts';

/** The first `@rig-c/parts` release with `rig-parts retune` (its CHANGELOG: 1.44.0, "retune: splice constraints and the idle onto a gated rig, every other byte held"). */
export const RETUNE_SINCE = '1.44.0';
export type PatchRoute = 'retune' | 'rig';

/**
 * The config pointers retune carries, as token prefixes: an op routes to retune when its pointer is the prefix or lies
 * under it. `/constraints` → rig.json `constraints` and `invariants.detached`; `/motion/duration`, `/motion/tracks` and the
 * blink's `t`, `squash` and `brow_drop` → motion.json `animations.idle`.
 */
export const RETUNE_PATHS: readonly (readonly string[])[] = [
  ['constraints'],
  ['motion', 'duration'],
  ['motion', 'tracks'],
  ['motion', 'blink', 't'],
  ['motion', 'blink', 'squash'],
  ['motion', 'blink', 'brow_drop'],
];

/** One op's route: `retune` when its pointer lies at or under a `RETUNE_PATHS` prefix, else `rig`. */
export function opRoute(path: string): PatchRoute {
  const tokens = parsePointer(path);
  return RETUNE_PATHS.some(prefix => prefix.length <= tokens.length && prefix.every((t, i) => tokens[i] === t)) ? 'retune' : 'rig';
}
/** A `rig` patch's route from its ops alone: `retune` only when every op routes there (an empty list is `rig`). */
export function routeForPatch(ops: readonly Pick<PatchOp, 'path'>[]): PatchRoute {
  return ops.length > 0 && ops.every(op => opRoute(op.path) === 'retune') ? 'retune' : 'rig';
}
/** The op the runner runs for a `rig` patch with this producer: `retune` when the ops allow it and the producer has it. */
export function patchRoute(ops: readonly Pick<PatchOp, 'path'>[], producerVersion: string): PatchRoute {
  return versionAtLeast(producerVersion, RETUNE_SINCE) ? routeForPatch(ops) : 'rig';
}
