/**
 * #187: where review state may live. The state directory (`RIG_REVIEW_STATE_DIR` or the default) is judged by its
 * canonical location — the realpath of its longest existing prefix plus the not-yet-created remainder — so a symlink
 * (the directory itself or any ancestor) that lands inside a supplied folder is refused, not followed. It may not sit
 * inside the rig-parts build root the check package belongs to (opening `out` redirects the package to `out/check`;
 * the build is still the supplied folder), the package root, or the producer handoff's root.
 */
import { isAbsolute, relative, sep } from 'node:path';
import { destinationDirectory } from './destination-directory.ts';

export type StateRootKind = 'build root' | 'package' | 'handoff root';
export interface StateRoot { kind: StateRootKind; path: string }
/** The fields of a loaded package that name supplied folders. */
export interface StateRootsSource { root: string; buildRoot?: string; handoff?: { root: string } | null }

/** Resolve the existing directory prefix and keep any missing suffix. */
export function canonicalStatePath(path: string): string {
  return destinationDirectory(path, 'STATE_DIRECTORY_INVALID: expected a directory path without symlink loops');
}

/** The supplied folders of one package, innermost first (a refusal names the first that holds the state). */
export function stateRoots(p: StateRootsSource): StateRoot[] {
  return [{ kind: 'package', path: p.root }, ...(p.buildRoot ? [{ kind: 'build root' as const, path: p.buildRoot }] : []), ...(p.handoff ? [{ kind: 'handoff root' as const, path: p.handoff.root }] : [])];
}

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

/** The first supplied folder the state directory sits inside (both sides canonical), or null when it is outside all. */
export function stateDirInside(stateDir: string, roots: readonly StateRoot[]): StateRoot | null {
  const state = canonicalStatePath(stateDir);
  for (const root of roots) if (within(canonicalStatePath(root.path), state)) return root;
  return null;
}

/** The refusal text after the code: which supplied folder holds the state directory. */
export const stateInsideMessage = (root: StateRoot) => `the review state directory is inside the inspected ${root.kind}; set RIG_REVIEW_STATE_DIR outside it`;

/** Throws `make(code-less message)` when the state directory sits inside one of the package's supplied folders. */
export function assertStateOutside(stateDir: string, p: StateRootsSource, make: (message: string, root: StateRoot) => Error): void {
  const root = stateDirInside(stateDir, stateRoots(p));
  if (root) throw make(stateInsideMessage(root), root);
}
