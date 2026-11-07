import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export class DestinationDirectoryError extends Error {}

/** Resolve directory aliases and keep an ENOENT suffix only when the caller can create it. */
export function destinationDirectory(path: string, refusal: string, allowMissing = true): string {
  const suffix: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    let physical: string;
    try {
      physical = realpathSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && allowMissing && dirname(current) !== current) {
        suffix.unshift(basename(current));
        continue;
      }
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        throw new DestinationDirectoryError(refusal, { cause: error });
      }
      throw error;
    }
    // Some runtimes report ENOENT for a descendant of a regular file.
    if (!statSync(physical).isDirectory()) throw new DestinationDirectoryError(refusal);
    return join(physical, ...suffix);
  }
}
