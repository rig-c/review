import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import type {jobFixture} from './job-api-fixture.ts';
import type {JobDisplayReceipt, JobPendingAsk, JobPublication} from '../../src/job-contract.ts';

/** Synthetic UI input for the real job ports. This does not attest browser pixels. */
export async function rigStillInput(
  fixture: Awaited<ReturnType<typeof jobFixture>>,
  frame: 'setup' | number = 'setup',
  animation?: string,
) {
  const publication = await fixture.publish();
  const ask = await fixture.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const page = await fixture.display(publication);
  const {capture, bytes, sha256} = rigStillCapture(publication, ask, page, frame, animation);
  const input = {
    ...page,
    askId: ask.askId,
    expectedGeneration: fixture.session.status().generation,
    submissionId: 'still-' + ask.askId,
    kind: 'review-verdict' as const,
    value: {stage: 'rig-review' as const, verdict: 'approved' as const, words: ' \n원문 그대로\t '},
    capture,
  };
  return {publication, ask, input, bytes, sha256};
}

/** Frozen synthetic PNG and claimed draw state, not a browser-render proof. */
export function rigStillCapture(publication: JobPublication, ask: JobPendingAsk, page: JobDisplayReceipt,
  frame: 'setup' | number = 'setup', animation?: string) {
  const image = new PNG({width: 2, height: 2});
  image.data.set([24, 40, 60, 255, 180, 80, 20, 255, 20, 180, 80, 255, 80, 20, 180, 255]);
  const bytes = PNG.sync.write(image);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const capture = {
    png: 'data:image/png;base64,' + bytes.toString('base64'),
    width: image.width,
    height: image.height,
    camera: 'fixed' as const,
    framing: 'default' as const,
    view: 'whole-rig' as const,
    frame,
    ...(animation === undefined ? {} : {animation}),
    playing: typeof frame === 'number',
    binding: {
      publicationId: publication.publicationId,
      instanceKey: publication.instanceKey,
      sourceHash: publication.source.sourceHash,
      pageId: page.pageId,
      askId: ask.askId,
      drawGeneration: 1,
      playerGeneration: 1,
    },
  };
  return {capture, bytes, sha256};
}
