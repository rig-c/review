/**
 * Config patch (#102): the one data form every edit card produces. `rig-review-config-patch/1` names the producer config
 * bytes it was made against (`config_sha256`), a list of RFC 6902-style operations over that config addressed by RFC 6901
 * JSON Pointers, the producer it was made for and the producer op that rebuilds from the patched config. Pure: no IO,
 * no clock. Review applies a patch only to a scratch copy of the config; the package's config is never written.
 */
import { createHash } from 'node:crypto';

export const CONFIG_PATCH_SCHEMA = 'rig-review-config-patch/1';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PatchOpName = 'replace' | 'add' | 'remove';
export const PATCH_OPS: readonly PatchOpName[] = ['replace', 'add', 'remove'];
export interface PatchOp { op: PatchOpName; path: string; value?: JsonValue }
/** `rig` rebuilds the whole rig from the patched config; `remesh` re-fits one part from its patched `meshes.<part>` entry. */
export type PatchCmd = 'rig' | 'remesh';
export const PATCH_CMDS: readonly PatchCmd[] = ['rig', 'remesh'];
export interface ConfigPatch {
  schema: typeof CONFIG_PATCH_SCHEMA;
  config_sha256: string;
  ops: PatchOp[];
  producer: { name: string; version: string };
  op: { cmd: PatchCmd; args: string[] };
}
export const MAX_PATCH_OPS = 256;
/** Flags a patch may pass to the producer op: no path, no command, every value from a closed set. */
export const PATCH_FLAGS: Readonly<Record<string, readonly string[]>> = { '--idle-keys': ['ctl', 'direct'], '--page-edges': ['pot', 'free'], '--pack-shape': ['rect', 'polygon'] };
const PART = /^[A-Za-z0-9_-]{1,64}$/;

export class ConfigPatchError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const invalid = (detail: string): never => { throw new ConfigPatchError('EDIT_PATCH_INVALID', detail); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** RFC 6901: "" is the whole document; otherwise "/" then tokens with "~1" = "/" and "~0" = "~"; any other "~" is invalid. */
export function parsePointer(pointer: unknown): string[] {
  if (typeof pointer !== 'string') throw new ConfigPatchError('EDIT_PATCH_POINTER_INVALID', `${JSON.stringify(pointer)} is not a string`);
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigPatchError('EDIT_PATCH_POINTER_INVALID', `${JSON.stringify(pointer)} does not start with "/"`);
  return pointer.slice(1).split('/').map(token => {
    if (/~(?![01])/.test(token)) throw new ConfigPatchError('EDIT_PATCH_POINTER_INVALID', `${JSON.stringify(pointer)} has a "~" that is not "~0" or "~1"`);
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}
export const pointerToken = (token: string | number) => String(token).replace(/~/g, '~0').replace(/\//g, '~1');
export const formatPointer = (tokens: readonly (string | number)[]) => tokens.map(t => '/' + pointerToken(t)).join('');

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => isJson(v, depth + 1));
  return isObject(value) && Object.values(value).every(v => isJson(v, depth + 1));
}

/** The producer op's flags: `--part <name>` for remesh (required, once), plus the closed-set flags, each at most once. */
function parseArgs(cmd: PatchCmd, args: unknown): string[] {
  if (!Array.isArray(args) || args.length > 16 || !args.every(a => typeof a === 'string')) invalid('op.args must be an array of at most 16 strings');
  const list = args as string[], seen = new Set<string>();
  for (let i = 0; i < list.length; i += 2) {
    const flag = list[i]!, value = list[i + 1];
    if (seen.has(flag)) invalid(`op.args: ${flag} given twice`);
    seen.add(flag);
    if (value === undefined) invalid(`op.args: ${flag} has no value`);
    if (flag === '--part' && cmd === 'remesh') { if (!PART.test(value!)) invalid('op.args: --part must name a part'); continue; }
    const allowed = PATCH_FLAGS[flag];
    if (!allowed) throw new ConfigPatchError('EDIT_PATCH_ARG_UNKNOWN', `op.args: ${flag} is not a flag a patch may pass to ${cmd} (allowed: ${[...(cmd === 'remesh' ? ['--part'] : []), ...Object.keys(PATCH_FLAGS)].join(', ')})`);
    if (!allowed.includes(value!)) invalid(`op.args: ${flag} ${value} (allowed: ${allowed.join(' | ')})`);
  }
  if (cmd === 'remesh' && !seen.has('--part')) invalid('op.args: remesh needs --part <name>');
  return [...list];
}

/** The patch document, exactly its keys; an unknown op name and a malformed pointer are refused by name. */
export function parseConfigPatch(input: unknown): ConfigPatch {
  if (!isObject(input)) return invalid('expected an object');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'config_sha256,op,ops,producer,schema') invalid('expected exactly {schema, config_sha256, ops, producer, op}');
  if (input.schema !== CONFIG_PATCH_SCHEMA) invalid(`schema must be ${CONFIG_PATCH_SCHEMA}`);
  if (typeof input.config_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.config_sha256)) invalid('config_sha256 must be a lowercase SHA-256');
  const producer = input.producer;
  if (!isObject(producer) || Object.keys(producer).sort().join(',') !== 'name,version' || typeof producer.name !== 'string' || typeof producer.version !== 'string' || !producer.name || !producer.version || producer.name.length > 128 || producer.version.length > 64) invalid('producer must be exactly {name, version}');
  const op = input.op;
  if (!isObject(op) || Object.keys(op).sort().join(',') !== 'args,cmd') invalid('op must be exactly {cmd, args}');
  const cmd = (op as Record<string, unknown>).cmd;
  if (!PATCH_CMDS.includes(cmd as PatchCmd)) throw new ConfigPatchError('EDIT_PATCH_CMD_UNKNOWN', `op.cmd ${JSON.stringify(cmd)} (supported: ${PATCH_CMDS.join(', ')})`);
  const args = parseArgs(cmd as PatchCmd, (op as Record<string, unknown>).args);
  if (!Array.isArray(input.ops) || input.ops.length < 1 || input.ops.length > MAX_PATCH_OPS) invalid(`ops must hold 1–${MAX_PATCH_OPS} operations`);
  const ops = (input.ops as unknown[]).map((raw, i): PatchOp => {
    if (!isObject(raw)) return invalid(`ops[${i}] must be an object`);
    if (!PATCH_OPS.includes(raw.op as PatchOpName)) throw new ConfigPatchError('EDIT_PATCH_OP_UNKNOWN', `ops[${i}].op ${JSON.stringify(raw.op)} (supported: ${PATCH_OPS.join(', ')})`);
    const name = raw.op as PatchOpName, want = name === 'remove' ? 'op,path' : 'op,path,value';
    if (Object.keys(raw).sort().join(',') !== want) invalid(`ops[${i}]: ${name} holds exactly ${want.split(',').join(', ')}`);
    const tokens = parsePointer(raw.path);
    if (!tokens.length) throw new ConfigPatchError('EDIT_PATCH_POINTER_INVALID', `ops[${i}].path "" would replace the whole config`);
    if (name !== 'remove' && !isJson(raw.value)) invalid(`ops[${i}].value is not JSON`);
    return name === 'remove' ? { op: name, path: raw.path as string } : { op: name, path: raw.path as string, value: raw.value as JsonValue };
  });
  return { schema: CONFIG_PATCH_SCHEMA, config_sha256: input.config_sha256 as string, ops, producer: { name: (producer as Record<string, string>).name!, version: (producer as Record<string, string>).version! }, op: { cmd: cmd as PatchCmd, args } };
}

/** The patch's own bytes as review hashes them: key order fixed by the parser, no whitespace. */
export const patchText = (patch: ConfigPatch) => JSON.stringify(parseConfigPatch(patch));
export const patchSha256 = (patch: ConfigPatch) => sha256(patchText(patch));

/** `EDIT_PATCH_STALE` unless the patch was made against exactly these config bytes. */
export function assertPatchFresh(patch: Pick<ConfigPatch, 'config_sha256'>, configSha256: string): void {
  if (patch.config_sha256 !== configSha256) throw new ConfigPatchError('EDIT_PATCH_STALE', `the patch was made against config ${patch.config_sha256.slice(0, 12)}…, the handoff config is ${configSha256.slice(0, 12)}…; read the config again and remake the patch`);
}

const arrayIndex = (token: string, length: number, allowEnd: boolean, path: string): number => {
  if (allowEnd && token === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new ConfigPatchError('EDIT_PATCH_POINTER_INVALID', `${path}: "${token}" is not an array index`);
  const index = Number(token);
  if (index > length || (!allowEnd && index === length)) throw new ConfigPatchError('EDIT_PATCH_PATH_MISSING', `${path}: index ${index} is past the array's ${length} item(s)`);
  return index;
};

/** Apply every op in order to a copy of `doc` (RFC 6902 semantics for replace/add/remove); the input is not touched. */
export function applyConfigPatch(doc: JsonValue, ops: readonly PatchOp[]): JsonValue {
  const root: { v: JsonValue } = { v: structuredClone(doc) };
  for (const [i, op] of ops.entries()) {
    const tokens = parsePointer(op.path), at = `ops[${i}] ${op.path}`;
    let parent: JsonValue = root.v;
    for (const [depth, token] of tokens.slice(0, -1).entries()) {
      const where = formatPointer(tokens.slice(0, depth + 1));
      if (Array.isArray(parent)) parent = parent[arrayIndex(token, parent.length, false, `${at} (at ${where})`)]!;
      else if (isObject(parent) && Object.hasOwn(parent, token)) parent = (parent as Record<string, JsonValue>)[token]!;
      else throw new ConfigPatchError('EDIT_PATCH_PATH_MISSING', `${at}: ${where} is not in the config`);
    }
    const last = tokens.at(-1)!;
    if (Array.isArray(parent)) {
      const index = arrayIndex(last, parent.length, op.op === 'add', at);
      if (op.op === 'add') parent.splice(index, 0, structuredClone(op.value!));
      else if (op.op === 'replace') parent[index] = structuredClone(op.value!);
      else parent.splice(index, 1);
    } else if (isObject(parent)) {
      const target = parent as Record<string, JsonValue>;
      if (op.op !== 'add' && !Object.hasOwn(target, last)) throw new ConfigPatchError('EDIT_PATCH_PATH_MISSING', `${at}: ${op.path} is not in the config`);
      if (op.op === 'remove') delete target[last]; else target[last] = structuredClone(op.value!);
    } else throw new ConfigPatchError('EDIT_PATCH_PATH_MISSING', `${at}: the parent of ${op.path} is not an object or array`);
  }
  return root.v;
}

/** Every JSON Pointer at which two documents differ: a changed leaf, a changed type, a key or index only one side has. Sorted. */
export function jsonDiff(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: (string | number)[]) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) { if (i >= x.length || i >= y.length) out.push(formatPointer([...path, i])); else walk(x[i], y[i], [...path, i]); }
    } else if (isObject(x) && isObject(y)) {
      for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        if (!Object.hasOwn(x, key) || !Object.hasOwn(y, key)) out.push(formatPointer([...path, key])); else walk(x[key], y[key], [...path, key]);
      }
    } else if (x !== y) out.push(formatPointer(path));
  };
  walk(a, b, []);
  return out;
}

/**
 * For `remesh`: every op must stay inside `meshes.<part>` (the entry remesh takes); the config remesh reads is the
 * handoff's own, unchanged. Returns the part.
 */
export function remeshPart(patch: ConfigPatch): string {
  const index = patch.op.args.indexOf('--part'), part = patch.op.args[index + 1]!;
  for (const [i, op] of patch.ops.entries()) {
    const tokens = parsePointer(op.path);
    if (tokens[0] !== 'meshes' || tokens[1] !== part || (tokens.length === 2 && op.op === 'remove')) throw new ConfigPatchError('EDIT_PATCH_OUT_OF_SCOPE', `ops[${i}] ${op.path}: a remesh patch edits /meshes/${pointerToken(part)} and below only (the rest of the config is what the rig was built from)`);
  }
  return part;
}
