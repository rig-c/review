/**
 * #139: a retune Apply reads the check retune already ran on its revision instead of running `rig-parts check` a second
 * time. `rig-parts retune` gates the revision and checks it (`checkStage` over the staged revision, the same `--parts`
 * and pack flags review passes) before it writes `retune.json`; from `@rig-c/parts` 1.49.0 (parts#541, its CHANGELOG:
 * "remesh,retune: the provenance carries check's final line and every block's status, as check itself reports") each
 * check side also carries `line` — check's own last line, composed by the one function check prints it from — and
 * `status` — every block's status as that tree's `check.json` records it, in the file's order. The writer
 * (`src/retune.ts`): `revision: hashRows(revision)` and `check: { ...sides, scope }` with
 * `sides = { input: checkSide(inCheck), revision: checkSide(revCheck) }`.
 *
 * The carried side is bound to the files by the `revision` hash rows: every row's file in the scratch revision must
 * hash to its row, none missing and none extra (`RETUNE_CHECK_STALE`). A `retune.json` without `line` and `status` (an
 * older producer) is not refused: the caller falls back to running check. Pure but for the binding's reads.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { CHECK_SUMMARY_SCHEMA, type CheckSummary } from './applied-context.ts';

/** The first `@rig-c/parts` release whose `retune.json` check sides carry `line` and `status` (CHANGELOG 1.49.0, parts#541). */
export const RETUNE_CHECK_SINCE = '1.49.0';
/** retune's provenance file, at the revision's root (parts `RETUNE_FILE`). */
export const RETUNE_FILE = 'retune.json';
export const RETUNE_CHECK_STALE = 'RETUNE_CHECK_STALE';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** check.json's bar keys as review's `checkSummary` reads them: an upper-case name. */
const BAR = /^[A-Z][A-Z0-9_]+$/;
const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'WARN', 'CLEAR', 'REPORTED']);

export interface RetuneRevisionRow { path: string; bytes: number; sha256: string }
export interface CarriedCheck { pass: boolean; line: string; status: Record<string, string> }

/**
 * `check.revision`'s carried fields, or null when there is no such side or it carries neither `line` nor `status` (a producer before
 * {@link RETUNE_CHECK_SINCE}). A side with one of them and not the other, or with a malformed one, throws: that is not
 * an older producer and not a check review can record.
 */
export function carriedCheck(retune: unknown): CarriedCheck | null {
  const side = isObject(retune) && isObject(retune.check) ? retune.check.revision : undefined;
  // No side at all carries neither field either: check runs, as for an older producer.
  if (!isObject(side)) return null;
  const hasLine = Object.hasOwn(side, 'line'), hasStatus = Object.hasOwn(side, 'status');
  if (!hasLine && !hasStatus) return null;
  if (typeof side.line !== 'string' || !/^check: (PASS|FAIL)/.test(side.line)) throw new Error(`${RETUNE_FILE}: check.revision.line is not check's last line`);
  if (!isObject(side.status) || !Object.values(side.status).every(s => typeof s === 'string' && STATUSES.has(s))) throw new Error(`${RETUNE_FILE}: check.revision.status is not {block: status}`);
  if (side.status.gate !== 'PASS' && side.status.gate !== 'FAIL') throw new Error(`${RETUNE_FILE}: check.revision.status.gate is not PASS or FAIL`);
  if (typeof side.pass !== 'boolean') throw new Error(`${RETUNE_FILE}: check.revision.pass is not a boolean`);
  return { pass: side.pass, line: side.line, status: side.status as Record<string, string> };
}

/**
 * The carried side in the summary shape review records for a check it ran (`checkSummary`), field by field:
 * `pass` ← `pass` (`figures.PASS === true`, check.json's `PASS`); `exitCode` ← 0 when it passes, else 1 (`rig-parts
 * check` exits `r.figures.PASS ? EXIT_OK : EXIT_REFUSED`); `line` ← `line` (check's last line, byte for byte);
 * `bars` ← every upper-case entry of `status` (check.json's top-level blocks with a `status`, in the file's order; the
 * figure-read `gate`, `loop` and `seam` are lower-case and are not bars in check.json); `gate` ← `status.gate` is
 * `PASS` (`gate_spine_html_green === true`, the one way `barsNotMet` leaves `gate` out). `source` says where it came from.
 */
export function retuneCheckSummary(carried: CarriedCheck): CheckSummary {
  const bars: Record<string, string> = {};
  for (const [name, status] of Object.entries(carried.status)) if (BAR.test(name)) bars[name] = status;
  return { schema: CHECK_SUMMARY_SCHEMA, pass: carried.pass, exitCode: carried.pass ? 0 : 1, line: carried.line, bars, gate: carried.status.gate === 'PASS', source: 'retune' };
}

/** The `revision` hash rows, or a refusal when they are not rows. */
function revisionRows(retune: unknown): RetuneRevisionRow[] | string {
  const rows = isObject(retune) ? retune.revision : undefined;
  if (!Array.isArray(rows) || rows.length === 0) return `${RETUNE_CHECK_STALE}: ${RETUNE_FILE} names no revision hash rows; its check is bound to no files`;
  for (const r of rows) if (!isObject(r) || typeof r.path !== 'string' || !r.path || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) return `${RETUNE_CHECK_STALE}: ${RETUNE_FILE} has a revision row that is not {path, bytes, sha256}`;
  return rows as RetuneRevisionRow[];
}

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true })) { const full = join(dir, e.name); if (e.isDirectory()) await walk(full); else out.push(relative(root, full).split(sep).join('/')); } };
  await walk(root);
  return out.sort();
}

/**
 * The binding: every `revision` row's file under `dir` hashes to its row, none is missing, and `dir` holds no file
 * but those rows and `retune.json`. Null when bound; otherwise the first mismatch as
 * `RETUNE_CHECK_STALE: <file> sha256 <in retune.json> … <on disk>` (`absent` on the side that has no such file).
 */
export async function revisionBinding(dir: string, retune: unknown): Promise<string | null> {
  const rows = revisionRows(retune);
  if (typeof rows === 'string') return rows;
  const onDisk = await files(dir), named = new Set(rows.map(r => r.path));
  for (const row of rows) {
    let actual = 'absent';
    if (onDisk.includes(row.path)) actual = createHash('sha256').update(await readFile(join(dir, ...row.path.split('/')))).digest('hex');
    if (actual !== row.sha256) return `${RETUNE_CHECK_STALE}: ${row.path} sha256 ${row.sha256} in ${RETUNE_FILE} … ${actual} on disk; retune's check is not this revision's, so no build is recorded`;
  }
  for (const path of onDisk) if (path !== RETUNE_FILE && !named.has(path)) {
    const actual = createHash('sha256').update(await readFile(join(dir, ...path.split('/')))).digest('hex');
    return `${RETUNE_CHECK_STALE}: ${path} sha256 absent in ${RETUNE_FILE} … ${actual} on disk; retune's check is not this revision's, so no build is recorded`;
  }
  return null;
}
