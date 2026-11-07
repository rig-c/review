import type {JobImageSetInput, JobImageSourceBinding} from './job-contract.ts';
import {jobHash, jobObject, jobPath, jobSha, jobText} from './job-api.ts';
import {JobError} from './job-store.ts';

/** Check discovery before sending an image ask, including against older hubs. */
export function assertJobImageSetCapability(capabilities: unknown): void {
  if (!capabilities || typeof capabilities !== 'object' ||
      (capabilities as {imageSetVerdict?: unknown}).imageSetVerdict !== true) {
    throw new JobError('JOB_IMAGE_SET_UNSUPPORTED');
  }
}

/** Hash the actual bytes. Array order and exact Unicode strings are significant. */
export function prepareJobImageSet(input: JobImageSetInput,
  readBytes: (path: string) => Uint8Array): Pick<JobImageSourceBinding, 'imageSet' | 'imageSetDigest' | 'duplicateHashes'> {
  try { jobObject(input, ['purpose', 'images']); }
  catch { throw new JobError('JOB_IMAGE_SET_INVALID'); }
  if (input.purpose !== 'plate-adoption' || !Array.isArray(input.images) ||
      input.images.length < 2 || input.images.length > 8) throw new JobError('JOB_IMAGE_SET_INVALID');
  const names = new Set<string>(), paths = new Set<string>();
  const hashes = new Map<string, string[]>();
  const images = input.images.map(raw => {
    let name: string;
    try {
      jobObject(raw, ['role', 'name', 'path', 'sha256']);
      name = jobText(raw.name);
      if (raw.sha256 !== undefined) jobSha(raw.sha256);
    } catch { throw new JobError('JOB_IMAGE_SET_INVALID'); }
    if (!['source', 'candidate', 'reference'].includes(raw.role)) throw new JobError('JOB_IMAGE_SET_ROLE_INVALID');
    let path: string;
    try { path = jobPath(raw.path); }
    catch { throw new JobError('JOB_IMAGE_SET_PATH_REFUSED'); }
    if (names.has(name)) throw new JobError('JOB_IMAGE_SET_DUPLICATE_NAME');
    if (paths.has(path)) throw new JobError('JOB_IMAGE_SET_DUPLICATE_PATH');
    names.add(name); paths.add(path);
    let bytes: Uint8Array;
    try { bytes = readBytes(path); }
    catch { throw new JobError('JOB_IMAGE_SET_PATH_REFUSED'); }
    const sha256 = jobHash(bytes);
    if (raw.sha256 !== undefined && raw.sha256 !== sha256) throw new JobError('JOB_SOURCE_MISMATCH');
    const group = hashes.get(sha256) ?? [];
    group.push(name); hashes.set(sha256, group);
    return {role: raw.role, name, path, sha256};
  });
  if (images.filter(image => image.role === 'source').length !== 1 ||
      !images.some(image => image.role === 'candidate')) throw new JobError('JOB_IMAGE_SET_ROLE_INVALID');
  const canonical = images.map(({role, name, sha256}) => ({role, name, sha256}));
  return {imageSet: {purpose: input.purpose, images}, imageSetDigest: jobHash(JSON.stringify(canonical)),
    duplicateHashes: [...hashes].filter(([, names]) => names.length > 1).map(([sha256, names]) => ({names, sha256}))};
}
