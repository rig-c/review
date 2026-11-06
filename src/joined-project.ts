import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { boundBytes, checkedPath, digest, literalPath, object, readProject, readRegular } from './interview-project.ts';
import { outputDirectory } from './interview-picks.ts';
import { packagePath, type ReviewPackage } from './manifest.ts';
import { assertReviewUnchanged } from './reference.ts';

export interface ProjectDesignation {root: string; version: number; picksDir: string}
export const interviewUnavailable = 'INTERVIEW_UNAVAILABLE';
export const interviewMismatch = 'INTERVIEW_SOURCE_MISMATCH';
export const interviewStale = 'INTERVIEW_OPTIONS_STALE';

export function joinProject(p: ReviewPackage, designation: ProjectDesignation) {
  const opened = readProject(designation.root);
  const {root, hash, project} = opened;
  const {version} = designation;
  const fail = (): never => {throw new Error(interviewMismatch + ': expected the designated Create version’s recorded review package');};
  if (!Number.isSafeInteger(version) || version < 1) return fail();
  const matches = (Array.isArray(project.versions) ? project.versions : []).map(object)
    .filter(entry => entry.n === version && entry.kind === 'rig');
  const record = object(matches[0]?.review_package);
  const path = 'derived/review/v' + version;
  const files = new Map<string, string>();
  try {
    if (matches.length !== 1 || !Array.isArray(record.files)) return fail();
    const out = checkedPath(root, path + '/out', true);
    if (p.buildRoot !== out || p.handoff?.parts !== out || p.handoff.rig !== join(out, 'rig') ||
        p.handoff.config !== checkedPath(root, path + '/config.json') || !p.manifest.model) return fail();
    const pkg = checkedPath(root, path, true);
    for (const entry of record.files.map(object)) {
      const {path, sha256} = entry;
      packagePath(path, 'recorded package file');
      if (!literalPath(path) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || files.has(path)) return fail();
      files.set(path, sha256);
    }
    const covered = (absolute: string, sha256?: string) => {
      const expected = files.get(relative(pkg, absolute).split(sep).join('/'));
      return expected !== undefined && (sha256 === undefined || sha256 === expected);
    };
    if (![...p.files].every(file => covered(join(p.root, file))) ||
        !p.handoff.record.files.every(file => covered(join(p.root, file.path), file.sha256)) ||
        !covered(join(p.root, p.manifest.model), p.reviewedSource.rig?.sha256) ||
        !files.has('out/parts.json') || ![...files.keys()].some(file => file.startsWith('out/parts/'))) return fail();
  } catch {return fail();}

  const assertInventory = () => {
    const pkg = checkedPath(root, path, true);
    const remaining = new Set(files.keys());
    const visit = (prefix: string) => {
      const directory = prefix ? checkedPath(pkg, prefix.slice(0,-1), true) : pkg;
      for (const entry of readdirSync(directory, {withFileTypes:true})) {
        const name = prefix + entry.name;
        if (!literalPath(name)) return fail();
        if (entry.isDirectory()) visit(name + '/');
        else if (!entry.isFile() || !remaining.delete(name)) return fail();
      }
    };
    visit('');
    if (remaining.size) return fail();
    for (const [path, sha256] of files) boundBytes(pkg, {path, sha256});
  };
  try {assertInventory();} catch {return fail();}
  outputDirectory(root, designation.picksDir, project);

  const assertCurrent = async () => {
    try {
      await assertReviewUnchanged(p);
      assertInventory();
      if (digest(readRegular(checkedPath(root, 'project.json'), 8 * 1024 * 1024)) !== hash) throw new Error('Project changed');
    } catch {throw new Error(interviewStale + ': project or review package changed; reopen the project');}
  };
  return {opened, designation:{...designation, root}, assertCurrent,
    available:opened.questions.length > 0 || opened.historical.length > 0};
}
export type JoinedProject = ReturnType<typeof joinProject>;
