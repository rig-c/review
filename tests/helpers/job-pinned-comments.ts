import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import type {Feedback} from '../../src/session.ts';
import type {StageComment} from '../../src/stage-comment.ts';
import {markedFeedback} from './verdict-feedback-746.ts';

/** Synthetic high-detail inspection pixels, never private input or a browser claim. */
export function syntheticPinnedFeedback(source: {
  sourceHash: string; package: {id: string}; model: {sha256: string};
}, count: number): Feedback[] {
  const image = new PNG({width: 192, height: 192});
  let seed = 790;
  for (let i = 0; i < image.data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
  }
  const bytes = PNG.sync.write(image), sha256 = createHash('sha256').update(bytes).digest('hex');
  return Array.from({length: count}, (_, i) => {
    const row = structuredClone(markedFeedback.feedback[0]) as unknown as Feedback;
    row.id = 'pin-' + i;
    row.summary = i % 3 === 0 ? 'Synthetic pinned comment ' + 'detail '.repeat(100) : 'Synthetic pinned comment ' + i;
    row.target.name = source.package.id;
    const comment = (row.context as unknown as {comment: StageComment}).comment;
    comment.sourceHash = source.sourceHash;
    const bookmark = comment.bookmark as {binding: {sourceHash: string; rigs: string[]}};
    bookmark.binding.sourceHash = source.sourceHash;
    comment.modelHash = bookmark.binding.rigs[0] = source.model.sha256;
    comment.crop = {path: `comment-crops/${sha256}.png`, sha256,
      png: 'data:image/png;base64,' + bytes.toString('base64'), width: 192, height: 192};
    if (i % 2) {
      comment.viewport = 'reference';
      comment.referenceId = 'synthetic-reference';
      comment.referenceHash = 'a'.repeat(64);
    }
    return row;
  });
}
