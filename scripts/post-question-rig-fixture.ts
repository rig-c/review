/** Loopback-only owner walk for Review #929, with public synthetic inputs. */
import {recordScreenFixture} from '../tests/helpers/job-record-screen-fixture.ts';

const variant = Bun.argv[2] ?? 'bound-rig';
if (variant !== 'bound-rig' && variant !== 'rig-signoff-hash' && variant !== 'rig-handoff')
  throw new Error('Usage: bun scripts/post-question-rig-fixture.ts [bound-rig|rig-signoff-hash|rig-handoff]');

const stopped = new Promise<void>(resolve => {
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());
});
const fixture = await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,variant);
try {
  const ownerUrl = (language: 'en' | 'ko') => {
    const url = new URL(fixture.ownerUrl);
    url.searchParams.set('lang',language);
    return url.href;
  };
  console.log(JSON.stringify({
    fixture:'Synthetic #929 variant B',
    variant,
    en:ownerUrl('en'),
    ko:ownerUrl('ko'),
    review:fixture.origin+fixture.display.routes.apiBase+'review',
    interview:fixture.origin+fixture.display.routes.apiBase+'interview',
  },null,2));
  await stopped;
} finally {
  await fixture.close();
}
